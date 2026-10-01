using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services.Ras;

/// <summary>Guarda/lee las credenciales EAP-TLS (certificado elegido) de una entrada de la agenda RAS del usuario.</summary>
internal interface IEapUserCredentialStore
{
    /// <summary>Guarda que la entrada use SIEMPRE este certificado (sin dialogo de seleccion al conectar).</summary>
    void SaveCertificate(string connectionName, X509Certificate2 certificate);

    /// <summary>Blob EAP guardado para la entrada, o null si no hay ninguno. Para tests y diagnostico.</summary>
    byte[]? GetStoredBlob(string connectionName);

    /// <summary>
    /// Huella SHA-1 del certificado para el que ESTA app guardo las credenciales de la entrada, o null si no hay credenciales,
    /// o si lo que Windows tiene guardado ya no es lo que la app guardo (alguien las sobrescribio). Ver la clase: el blob de
    /// Windows no contiene la huella, asi que la app la anota al guardar y la valida contra el blob real.
    /// </summary>
    string? GetSavedCertificateThumbprint(string connectionName);
}

/// <summary>
/// Credenciales EAP de usuario de una entrada RAS (prompt 12.8): guardan que
/// la entrada use un certificado concreto de CurrentUser\My al conectar.
///
/// QUE ESTA MEDIDO Y QUE NO (corregido en el prompt 12.10: este comentario
/// afirmaba antes que sin credenciales EAP-TLS "siempre abre el selector aunque
/// solo haya un candidato", y eso NO estaba medido):
///   - UN candidato (el unico certificado del emisor del filtro) y SIN
///     credenciales guardadas: rasdial conecta sin ningun dialogo (medido el
///     2026-10-01 en el equipo de desarrollo, con una entrada de prueba clonada
///     de la real: mismo XML EAP, mismos parametros IPsec, sin
///     RasSetEapUserData).
///   - DOS candidatos del mismo emisor y credenciales YA guardadas: rasdial
///     seguia dando el error 703 (selector de Windows); al borrar el segundo
///     certificado conecto. Es decir, guardarlas NO evito el selector con dos
///     candidatos (el filtro CAHashList es por emisor).
///   - NO medido: dos candidatos SIN credenciales (se espera el mismo 703) y,
///     en general, si guardarlas aporta algo que el XML EAP no de ya. El test
///     SameIssuerTwoConnectionsTests lo mide con dos entradas, pero exige
///     administrador (necesita una raiz de confianza de prueba).
/// Por eso este almacen NO se ha demostrado necesario; se mantiene porque
/// funciona y es inocuo (la conexion usa el certificado que la app guardo, no
/// "el que Windows elija"), pero la limpieza de certificados sobrantes y el
/// aviso de candidatos son lo que de verdad evita el selector.
///
/// EXPERIMENTO REPETIBLE para decidir si hace falta:
/// APPS/Windows/code/experimentos/exp-sin-credenciales.ps1 (clona una conexion
/// existente SIN credenciales EAP guardadas y lanza rasdial; exit 0 = no hace
/// falta guardarlas para ese caso). Camino de guardado:
///   1. EapHostPeerConfigXml2Blob (eappcfg.dll): XML de configuracion EAP-TLS
///      de la conexion -> blob de configuracion.
///   2. EapHostPeerCredentialsXml2Blob: XML EapHostUserCredentials con el
///      certificado (UserCert = DER en hex, segun
///      C:\Windows\schemas\EAPMethods\eaptlsuserpropertiesv1.xsd) + ese blob
///      de configuracion -> blob de credenciales. NO lleva la clave privada:
///      solo identifica el certificado; la clave sigue en el TPM.
///   3. RasSetEapUserDataW: guarda el blob para la entrada del usuario.
/// Las firmas salen de las cabeceras reales del SDK (eaphostpeerconfigapis.h,
/// Ras.h), no de memoria: una firma inventada de la primera iteracion
/// reventaba con AccessViolation. Los nodos XML se pasan como IXMLDOMNode*
/// (MSXML 6), en un hilo STA dedicado como el resto de COM de esta app.
/// </summary>
internal sealed class EapUserCredentialStore : IEapUserCredentialStore
{
    private const string DomProgId = "Msxml2.DOMDocument.6.0";
    private static readonly Guid IidXmlDomNode = new("2933BF80-7B36-11D2-B20E-00C04F983E60");

    private const int ErrorBufferTooSmall = 603;

    public void SaveCertificate(string connectionName, X509Certificate2 certificate)
    {
        ArgumentException.ThrowIfNullOrEmpty(connectionName);
        ArgumentNullException.ThrowIfNull(certificate);
        RunOnSta(() => SaveCertificateCore(connectionName, certificate));
    }

    public string? GetSavedCertificateThumbprint(string connectionName)
    {
        var record = SavedCredentialRegistry.Find(connectionName);
        var current = ReadStoredBlob(connectionName);
        if (record is null || current is null || current.Length == 0)
        {
            return null;
        }
        // Solo vale si Windows sigue teniendo EXACTAMENTE lo que la app guardo con esa huella.
        var currentDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(current));
        return string.Equals(currentDigest, record.BlobSha256, StringComparison.OrdinalIgnoreCase) ? record.Thumbprint : null;
    }

    public byte[]? GetStoredBlob(string connectionName) => ReadStoredBlob(connectionName);

    private static byte[]? ReadStoredBlob(string connectionName)
    {
        uint size = 0;
        var first = EapNative.RasGetEapUserDataW(IntPtr.Zero, null, connectionName, IntPtr.Zero, ref size);
        if (first != ErrorBufferTooSmall || size == 0)
        {
            return null;
        }

        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            var second = EapNative.RasGetEapUserDataW(IntPtr.Zero, null, connectionName, buffer, ref size);
            if (second != 0)
            {
                return null;
            }
            var bytes = new byte[size];
            Marshal.Copy(buffer, bytes, 0, (int)size);
            return bytes;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void SaveCertificateCore(string connectionName, X509Certificate2 certificate)
    {
        var configXml = BuildMinimalTlsConfigXml();
        var credentialsXml = BuildCredentialsXml(certificate.RawData);

        IntPtr configBlob = IntPtr.Zero;
        IntPtr credentialsBlob = IntPtr.Zero;
        try
        {
            using var configNode = XmlNode.FromXml(configXml);
            var configResult = EapNative.EapHostPeerConfigXml2Blob(
                0, configNode.Pointer, out var configSize, out configBlob, out _, out var configError);
            ThrowIfFailed(configResult, configError, "EapHostPeerConfigXml2Blob");

            using var credentialsNode = XmlNode.FromXml(credentialsXml);
            var credentialsResult = EapNative.EapHostPeerCredentialsXml2Blob(
                0, credentialsNode.Pointer, configSize, configBlob, out var credentialsSize, out credentialsBlob, out _, out var credentialsError);
            ThrowIfFailed(credentialsResult, credentialsError, "EapHostPeerCredentialsXml2Blob");
            if (credentialsBlob == IntPtr.Zero || credentialsSize == 0)
            {
                throw new InvalidOperationException("Windows devolvio un blob de credenciales EAP vacio.");
            }

            var setResult = EapNative.RasSetEapUserDataW(IntPtr.Zero, null, connectionName, credentialsBlob, credentialsSize);
            if (setResult != 0)
            {
                throw new InvalidOperationException($"RasSetEapUserDataW devolvio el codigo {setResult} para \"{connectionName}\".");
            }

            // El blob que guarda Windows (74 bytes, con punteros) NO contiene la huella del certificado ni es
            // determinista: no se puede leer de vuelta de ahi (medido en el prompt 12.12). Se lee lo que Windows
            // guardo de verdad y se anota, junto con la huella, en un registro propio (sin secretos).
            var stored = ReadStoredBlob(connectionName);
            if (stored is null || stored.Length == 0)
            {
                throw new InvalidOperationException($"Windows no devolvio las credenciales EAP recien guardadas de \"{connectionName}\".");
            }
            SavedCredentialRegistry.Record(connectionName, certificate.Thumbprint, stored);
        }
        finally
        {
            if (configBlob != IntPtr.Zero) EapNative.EapHostPeerFreeMemory(configBlob);
            if (credentialsBlob != IntPtr.Zero) EapNative.EapHostPeerFreeMemory(credentialsBlob);
        }
    }

    private static void ThrowIfFailed(int result, IntPtr eapError, string api)
    {
        try
        {
            if (result != 0)
            {
                throw new InvalidOperationException($"{api} devolvio 0x{result:X8}.");
            }
        }
        finally
        {
            if (eapError != IntPtr.Zero) EapNative.EapHostPeerFreeErrorMemory(eapError);
        }
    }

    /// <summary>Configuracion EAP-TLS minima: el blob de credenciales solo necesita que el metodo (13) y su forma sean los de EAP-TLS.</summary>
    internal static string BuildMinimalTlsConfigXml() => """
        <EapHostConfig xmlns="http://www.microsoft.com/provisioning/EapHostConfig">
          <EapMethod>
            <Type xmlns="http://www.microsoft.com/provisioning/EapCommon">13</Type>
            <VendorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorId>
            <VendorType xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorType>
            <AuthorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</AuthorId>
          </EapMethod>
          <Config xmlns="http://www.microsoft.com/provisioning/EapHostConfig">
            <Eap xmlns="http://www.microsoft.com/provisioning/BaseEapConnectionPropertiesV1">
              <Type>13</Type>
              <EapType xmlns="http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV1">
                <CredentialsSource>
                  <CertificateStore>
                    <SimpleCertSelection>true</SimpleCertSelection>
                  </CertificateStore>
                </CredentialsSource>
                <ServerValidation>
                  <DisableUserPromptForServerValidation>true</DisableUserPromptForServerValidation>
                  <ServerNames></ServerNames>
                </ServerValidation>
                <DifferentUsername>false</DifferentUsername>
              </EapType>
            </Eap>
          </Config>
        </EapHostConfig>
        """;

    /// <summary>EapHostUserCredentials de EAP-TLS: el certificado entero (DER en hex), segun eaptlsuserpropertiesv1.xsd. Nunca clave privada.</summary>
    internal static string BuildCredentialsXml(byte[] certificateDer) => $"""
        <EapHostUserCredentials xmlns="http://www.microsoft.com/provisioning/EapHostUserCredentials" xmlns:eapCommon="http://www.microsoft.com/provisioning/EapCommon" xmlns:baseEapCred="http://www.microsoft.com/provisioning/BaseEapMethodUserCredentials">
          <EapMethod>
            <eapCommon:Type>13</eapCommon:Type>
            <eapCommon:AuthorId>0</eapCommon:AuthorId>
          </EapMethod>
          <Credentials xmlns:eapUser="http://www.microsoft.com/provisioning/EapUserPropertiesV1" xmlns:baseEap="http://www.microsoft.com/provisioning/BaseEapUserPropertiesV1" xmlns:eapTls="http://www.microsoft.com/provisioning/EapTlsUserPropertiesV1">
            <baseEap:Eap>
              <baseEap:Type>13</baseEap:Type>
              <eapTls:EapType>
                <eapTls:UserCert>{Convert.ToHexString(certificateDer)}</eapTls:UserCert>
              </eapTls:EapType>
            </baseEap:Eap>
          </Credentials>
        </EapHostUserCredentials>
        """;

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception ex) { failure = ex; }
        })
        { IsBackground = true, Name = "didev-vpn-eapcred" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }

    /// <summary>Documento MSXML cargado + puntero IXMLDOMNode* de su elemento raiz, liberados al salir del using.</summary>
    private sealed class XmlNode : IDisposable
    {
        private object _document;
        private object _element;
        private readonly IntPtr _unknown;
        public IntPtr Pointer { get; }

        private XmlNode(object document, object element, IntPtr unknown, IntPtr pointer)
        {
            _document = document;
            _element = element;
            _unknown = unknown;
            Pointer = pointer;
        }

        public static XmlNode FromXml(string xml)
        {
            var type = Type.GetTypeFromProgID(DomProgId)
                ?? throw new InvalidOperationException($"No se encuentra {DomProgId} (MSXML 6).");
            dynamic document = Activator.CreateInstance(type)!;
            document.async = false;
            if (!(bool)document.loadXML(xml))
            {
                throw new InvalidOperationException($"XML EAP invalido: {(string)document.parseError.reason}");
            }

            object element = document.documentElement;
            var unknown = Marshal.GetIUnknownForObject(element);
            var iid = IidXmlDomNode;
            var hr = Marshal.QueryInterface(unknown, in iid, out var node);
            if (hr != 0)
            {
                Marshal.Release(unknown);
                throw new InvalidOperationException($"El nodo XML no expone IXMLDOMNode (0x{hr:X8}).");
            }
            return new XmlNode((object)document, element, unknown, node);
        }

        public void Dispose()
        {
            if (Pointer != IntPtr.Zero) Marshal.Release(Pointer);
            if (_unknown != IntPtr.Zero) Marshal.Release(_unknown);
            if (Marshal.IsComObject(_element)) Marshal.ReleaseComObject(_element);
            if (Marshal.IsComObject(_document)) Marshal.ReleaseComObject(_document);
        }
    }

    internal sealed record SavedCredentialRecord(string Thumbprint, string BlobSha256);

    /// <summary>eap-credentials.json en %LOCALAPPDATA%\didev-vpn: entrada -> huella del certificado y SHA-256 del blob guardado. Sin secretos.</summary>
    internal static class SavedCredentialRegistry
    {
        private static readonly object FileLock = new();
        private static readonly System.Text.Json.JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

        private static string PathFile => System.IO.Path.Combine(AppPaths.DataDirectory, "eap-credentials.json");

        public static void Record(string connectionName, string thumbprint, byte[] blob)
        {
            lock (FileLock)
            {
                var all = Load();
                all[connectionName] = new SavedCredentialRecord(
                    thumbprint, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(blob)));
                Directory.CreateDirectory(AppPaths.DataDirectory);
                var temp = PathFile + ".tmp";
                File.WriteAllText(temp, System.Text.Json.JsonSerializer.Serialize(all, JsonOptions));
                File.Move(temp, PathFile, overwrite: true);
            }
        }

        public static SavedCredentialRecord? Find(string connectionName)
        {
            lock (FileLock)
            {
                return Load().TryGetValue(connectionName, out var record) ? record : null;
            }
        }

        private static Dictionary<string, SavedCredentialRecord> Load()
        {
            var empty = new Dictionary<string, SavedCredentialRecord>(StringComparer.OrdinalIgnoreCase);
            if (!File.Exists(PathFile))
            {
                return empty;
            }
            try
            {
                var loaded = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, SavedCredentialRecord>>(File.ReadAllText(PathFile), JsonOptions);
                return loaded is null ? empty : new Dictionary<string, SavedCredentialRecord>(loaded, StringComparer.OrdinalIgnoreCase);
            }
            catch (System.Text.Json.JsonException)
            {
                return empty;
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EapType
    {
        public byte type;
        public uint dwVendorId;
        public uint dwVendorType;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EapMethodType
    {
        public EapType eapType;
        public uint dwAuthorId;
    }

    private static class EapNative
    {
        [DllImport("eappcfg.dll", CharSet = CharSet.Unicode)]
        public static extern int EapHostPeerConfigXml2Blob(
            uint dwFlags, IntPtr pConfigDoc, out uint pdwSizeOfConfigOut, out IntPtr ppConfigOut,
            out EapMethodType pEapMethodType, out IntPtr ppEapError);

        [DllImport("eappcfg.dll", CharSet = CharSet.Unicode)]
        public static extern int EapHostPeerCredentialsXml2Blob(
            uint dwFlags, IntPtr pCredentialsDoc, uint dwSizeOfConfigIn, IntPtr pConfigIn,
            out uint pdwSizeOfCredentialsOut, out IntPtr ppCredentialsOut,
            out EapMethodType pEapMethodType, out IntPtr ppEapError);

        [DllImport("eappcfg.dll")]
        public static extern void EapHostPeerFreeMemory(IntPtr pData);

        [DllImport("eappcfg.dll")]
        public static extern void EapHostPeerFreeErrorMemory(IntPtr pEapError);

        [DllImport("rasapi32.dll", CharSet = CharSet.Unicode)]
        public static extern int RasSetEapUserDataW(
            IntPtr hToken, string? pszPhonebook, string pszEntry, IntPtr pbEapData, uint dwSizeofEapData);

        [DllImport("rasapi32.dll", CharSet = CharSet.Unicode)]
        public static extern int RasGetEapUserDataW(
            IntPtr hToken, string? pszPhonebook, string pszEntry, IntPtr pbEapData, ref uint pdwSizeofEapData);
    }
}
