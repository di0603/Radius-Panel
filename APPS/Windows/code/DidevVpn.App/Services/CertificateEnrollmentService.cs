using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services;

/// <summary>Certificado instalado tras el alta/renovacion, con su clave privada ya asociada por Windows.</summary>
internal sealed record InstalledCertificateResult(X509Certificate2 Certificate, bool IsTpmBacked);

/// <summary>
/// Genera la clave del dispositivo (ECDSA P-256, no exportable, en
/// CurrentUser\My) y el CSR, envia el CSR a EST y deja el certificado
/// instalado, enlazado a esa clave. SIEMPRE por CertEnroll (COM,
/// X509Enrollment.*), nunca por CngKey.Create + asociacion manual: esa via
/// (probada en el prompt 12.6) deja firmar/verificar bien pero Schannel la
/// rechaza en EAP-TLS con 0x8009030D SEC_E_UNKNOWN_CREDENTIALS -verificado en
/// esta maquina con un handshake TLS mutuo real: el certificado instalado por
/// CertEnroll.InstallResponse SI lo acepta Schannel (AcquireCredentialsHandle),
/// el asociado a mano no-. SIEMPRE claves de usuario (nunca "MachineKeySet"),
/// ver APPS/Windows/NOTAS-prompt-12-en-pausa.md punto 5.
///
/// CertEnroll es COM de apartamento unico (STA): la clave, el CSR y luego
/// instalar la respuesta se hacen todos con el MISMO objeto CX509Enrollment,
/// y por tanto desde el mismo hilo. Por eso todo el tramo (clave+CSR, la
/// llamada HTTP a EST intercalada, e instalar la respuesta) corre en un hilo
/// STA dedicado y de usar-y-tirar (ver <see cref="EnrollAsync"/>), nunca en
/// el hilo de interfaz ni en un hilo de threadpool cualquiera.
/// </summary>
internal interface ICertificateEnrollmentService
{
    /// <summary>
    /// Alta/renovacion completa: intenta el TPM primero ("Microsoft Platform
    /// Crypto Provider"); si no esta disponible, pide confirmacion explicita
    /// con <paramref name="confirmSoftwareKeyFallback"/> antes de caer a una
    /// clave por software (sigue sin ser exportable). Genera el CSR, llama a
    /// <paramref name="requestCertificate"/> (el simpleenroll/simplereenroll
    /// de EST) y, en el mismo hilo STA, instala la respuesta PKCS7 con
    /// CertEnroll -no hay paso intermedio "asociar sin instalar": con
    /// CertEnroll instalar y asociar es un unico paso, ver el resumen de la
    /// clase-. Si <paramref name="requestCertificate"/> lanza, no se instala
    /// nada (la clave generada queda huerfana en el proveedor, igual que ya
    /// pasaba con el enfoque anterior si el enroll fallaba).
    /// </summary>
    Task<InstalledCertificateResult> EnrollAsync(
        string cn,
        Func<string, bool> confirmSoftwareKeyFallback,
        Func<byte[], CancellationToken, Task<EstEnrollResult>> requestCertificate,
        CancellationToken ct);

    /// <summary>Borra un certificado (y su clave privada asociada) de CurrentUser\My, p.ej. tras una renovacion o al desinstalar.</summary>
    void RemoveCertificate(X509Certificate2 certificate);
}

internal sealed class CertificateEnrollmentService : ICertificateEnrollmentService
{
    private const string TpmProviderName = "Microsoft Platform Crypto Provider";
    private const string SoftwareProviderName = "Microsoft Software Key Storage Provider";

    // OIDs fijos de CertEnroll (no hay enumeracion tipada sin referencia COM):
    // curva ECDSA P-256 y SHA-256, los mismos valores que exige CLAUDE.md del
    // panel para certificados de dispositivo.
    private const string EcdsaP256CurveOid = "1.2.840.10045.3.1.7";
    private const string Sha256Oid = "2.16.840.1.101.3.4.2.1";

    // X509CertificateEnrollmentContext.ContextUser
    private const int ContextUser = 1;
    // X509PrivateKeyExportFlags.XCN_NCRYPT_ALLOW_EXPORT_NONE
    private const int ExportPolicyNone = 0;
    // Legacy KeySpec: AT_SIGNATURE. AT_KEYEXCHANGE (1) da "Acceso denegado"
    // (NTE_PERM) al firmar el CSR con una clave puramente CNG -verificado en
    // esta maquina-; AT_SIGNATURE (2) es el correcto para una clave de firma.
    private const int KeySpecSignature = 2;
    // AlternativeNameType.XCN_CERT_ALT_NAME_DNS_NAME
    private const int AltNameDnsName = 3;
    // EncodingType.XCN_CRYPT_STRING_BASE64 (sin cabecera PEM): el mismo
    // formato que ya usa EstClient para el CSR de salida y la respuesta de
    // entrada -verificado en esta maquina que InstallResponse lo acepta asi,
    // sin hacer falta envolverlo en "-----BEGIN ...-----"-.
    private const int EncodingBase64NoHeader = 1;
    // InstallResponseRestrictionFlags: AllowUntrustedCertificate (0x2) |
    // AllowUntrustedRoot (0x4). Hace falta porque, en el momento de instalar,
    // la intermedia del panel puede no estar todavia en LocalMachine\CA (eso
    // lo hace un paso posterior del alta) y la raiz puede ser la primera vez
    // que se ve en este equipo.
    private const int InstallResponseAllowUntrusted = 0x2 | 0x4;

    public Task<InstalledCertificateResult> EnrollAsync(
        string cn,
        Func<string, bool> confirmSoftwareKeyFallback,
        Func<byte[], CancellationToken, Task<EstEnrollResult>> requestCertificate,
        CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(cn);
        ArgumentNullException.ThrowIfNull(confirmSoftwareKeyFallback);
        ArgumentNullException.ThrowIfNull(requestCertificate);

        return RunOnStaThread(() => CreateKeyAndRequest(cn, confirmSoftwareKeyFallback), requestCertificate, ct);
    }

    /// <summary>
    /// Solo para tests: fuerza el proveedor (TPM o software) sin pasar por la
    /// logica de fallback de <see cref="EnrollAsync"/>, para poder probar
    /// cada via por separado sin depender de si esta maquina tiene TPM.
    /// </summary>
    internal Task<InstalledCertificateResult> EnrollWithProviderForTestingAsync(
        string cn, string providerName, Func<byte[], CancellationToken, Task<EstEnrollResult>> requestCertificate, CancellationToken ct)
    {
        return RunOnStaThread(
            () =>
            {
                var (privateKey, enrollment, csrDer) = CreateKeyAndCsr(cn, providerName);
                return new KeyAndRequest(privateKey, enrollment, csrDer, IsTpmBacked: providerName == TpmProviderName);
            },
            requestCertificate,
            ct);
    }

    internal static string TpmProviderNameForTesting => TpmProviderName;
    internal static string SoftwareProviderNameForTesting => SoftwareProviderName;

    /// <summary>Una unica clave+CSR+enrollment COM, lista para InstallResponse.</summary>
    private sealed record KeyAndRequest(object PrivateKey, object Enrollment, byte[] CsrDer, bool IsTpmBacked);

    private static Task<InstalledCertificateResult> RunOnStaThread(
        Func<KeyAndRequest> createKeyAndRequest,
        Func<byte[], CancellationToken, Task<EstEnrollResult>> requestCertificate,
        CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<InstalledCertificateResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                var result = EnrollOnStaThread(createKeyAndRequest, requestCertificate, ct);
                tcs.SetResult(result);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                tcs.SetCanceled(ct);
            }
            catch (Exception ex)
            {
                tcs.SetException(ex);
            }
        })
        {
            IsBackground = true,
            Name = "didev-vpn-certenroll",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return tcs.Task;
    }

    private static InstalledCertificateResult EnrollOnStaThread(
        Func<KeyAndRequest> createKeyAndRequest,
        Func<byte[], CancellationToken, Task<EstEnrollResult>> requestCertificate,
        CancellationToken ct)
    {
        var keyAndRequest = createKeyAndRequest();
        try
        {
            ct.ThrowIfCancellationRequested();
            var estResult = requestCertificate(keyAndRequest.CsrDer, ct).GetAwaiter().GetResult();

            InvokeCom(keyAndRequest.Enrollment, "InstallResponse",
                InstallResponseAllowUntrusted, estResult.Pkcs7Base64, EncodingBase64NoHeader, "");
            // "Certificate" es una propiedad indexada (Certificate[EncodingType]),
            // no un metodo: hay que pedirla con GetProperty, InvokeMethod da
            // DISP_E_MEMBERNOTFOUND -verificado en esta maquina-.
            var installedCertBase64 = (string)GetComIndexed(keyAndRequest.Enrollment, "Certificate", EncodingBase64NoHeader)!;
            var installedCertBytes = Convert.FromBase64String(installedCertBase64);
            var thumbprint = new X509Certificate2(installedCertBytes).Thumbprint;

            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadOnly);
            var matches = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false);
            if (matches.Count == 0)
            {
                throw new InvalidOperationException(
                    "CertEnroll dice que instalo el certificado, pero no aparece en CurrentUser\\My.");
            }

            var installed = new X509Certificate2(matches[0]);
            if (!installed.HasPrivateKey)
            {
                installed.Dispose();
                throw new InvalidOperationException(
                    "El certificado instalado no tiene clave privada asociada (CertEnroll.InstallResponse no la enlazo).");
            }

            return new InstalledCertificateResult(installed, keyAndRequest.IsTpmBacked);
        }
        finally
        {
            ReleaseCom(keyAndRequest.Enrollment);
            ReleaseCom(keyAndRequest.PrivateKey);
        }
    }

    /// <summary>TPM primero; si falla, pide confirmacion y cae a clave por software.</summary>
    private static KeyAndRequest CreateKeyAndRequest(string cn, Func<string, bool> confirmSoftwareKeyFallback)
    {
        try
        {
            var (privateKey, enrollment, csrDer) = CreateKeyAndCsr(cn, TpmProviderName);
            return new KeyAndRequest(privateKey, enrollment, csrDer, IsTpmBacked: true);
        }
        catch (Exception ex) when (ex is COMException or UnauthorizedAccessException)
        {
            if (!confirmSoftwareKeyFallback(ex.Message))
            {
                throw new OperationCanceledException(
                    "Alta cancelada: no hay TPM disponible y no se confirmo continuar con una clave por software.");
            }

            var (privateKey, enrollment, csrDer) = CreateKeyAndCsr(cn, SoftwareProviderName);
            return new KeyAndRequest(privateKey, enrollment, csrDer, IsTpmBacked: false);
        }
    }

    private static (object PrivateKey, object Enrollment, byte[] CsrDer) CreateKeyAndCsr(string cn, string providerName)
    {
        var privateKey = CreateComObject("X509Enrollment.CX509PrivateKey");
        object? pkcs10 = null;
        object? enrollment = null;
        try
        {
            SetCom(privateKey, "ProviderName", providerName);
            SetCom(privateKey, "MachineContext", false); // clave de USUARIO, nunca de maquina: ver el resumen de la clase
            SetCom(privateKey, "ExportPolicy", ExportPolicyNone);
            SetCom(privateKey, "KeySpec", KeySpecSignature);
            SetCom(privateKey, "Length", 256);

            using (var algorithm = ComScope.Create("X509Enrollment.CObjectId"))
            {
                InvokeCom(algorithm.Value, "InitializeFromValue", EcdsaP256CurveOid);
                SetCom(privateKey, "Algorithm", algorithm.Value);
            }

            InvokeCom(privateKey, "Create");

            pkcs10 = CreateComObject("X509Enrollment.CX509CertificateRequestPkcs10");
            InvokeCom(pkcs10, "InitializeFromPrivateKey", ContextUser, privateKey, "");

            using (var subject = ComScope.Create("X509Enrollment.CX500DistinguishedName"))
            {
                InvokeCom(subject.Value, "Encode", $"CN={cn}", 0);
                SetCom(pkcs10, "Subject", subject.Value);
            }

            // strongSwan busca el certificado del cliente por el SAN
            // dNSName = CN (ver CLAUDE.md del panel): sin esto el dispositivo
            // no conecta aunque el certificado sea valido.
            using (var altName = ComScope.Create("X509Enrollment.CAlternativeName"))
            using (var altNames = ComScope.Create("X509Enrollment.CAlternativeNames"))
            using (var sanExtension = ComScope.Create("X509Enrollment.CX509ExtensionAlternativeNames"))
            {
                InvokeCom(altName.Value, "InitializeFromString", AltNameDnsName, cn);
                InvokeCom(altNames.Value, "Add", altName.Value);
                InvokeCom(sanExtension.Value, "InitializeEncode", altNames.Value);
                using var extensions = ComScope.Wrap(GetCom(pkcs10, "X509Extensions")!);
                InvokeCom(extensions.Value, "Add", sanExtension.Value);
            }

            using (var hashAlgorithm = ComScope.Create("X509Enrollment.CObjectId"))
            {
                InvokeCom(hashAlgorithm.Value, "InitializeFromValue", Sha256Oid);
                SetCom(pkcs10, "HashAlgorithm", hashAlgorithm.Value);
            }

            InvokeCom(pkcs10, "Encode");

            enrollment = CreateComObject("X509Enrollment.CX509Enrollment");
            InvokeCom(enrollment, "InitializeFromRequest", pkcs10);
            var csrBase64 = (string)InvokeCom(enrollment, "CreateRequest", EncodingBase64NoHeader)!;
            var csrDer = Convert.FromBase64String(csrBase64);

            return (privateKey, enrollment, csrDer);
        }
        catch
        {
            ReleaseCom(enrollment);
            ReleaseCom(privateKey);
            throw;
        }
        finally
        {
            ReleaseCom(pkcs10);
        }
    }

    private static object CreateComObject(string progId)
    {
        var type = Type.GetTypeFromProgID(progId)
            ?? throw new InvalidOperationException($"No se encuentra el componente COM '{progId}' (CertEnroll no esta disponible en este equipo).");
        return Activator.CreateInstance(type)
            ?? throw new InvalidOperationException($"No se pudo crear el componente COM '{progId}'.");
    }

    private static void SetCom(object comObject, string propertyName, object? value)
    {
        comObject.GetType().InvokeMember(
            propertyName, System.Reflection.BindingFlags.SetProperty, null, comObject, new[] { value });
    }

    private static object? GetCom(object comObject, string propertyName) =>
        comObject.GetType().InvokeMember(
            propertyName, System.Reflection.BindingFlags.GetProperty, null, comObject, Array.Empty<object>());

    private static object? GetComIndexed(object comObject, string propertyName, params object?[] args) =>
        comObject.GetType().InvokeMember(
            propertyName, System.Reflection.BindingFlags.GetProperty, null, comObject, args);

    private static object? InvokeCom(object comObject, string methodName, params object?[] args) =>
        comObject.GetType().InvokeMember(
            methodName, System.Reflection.BindingFlags.InvokeMethod, null, comObject, args);

    private static void ReleaseCom(object? comObject)
    {
        if (comObject is not null && Marshal.IsComObject(comObject))
        {
            Marshal.ReleaseComObject(comObject);
        }
    }

    /// <summary>Libera un objeto COM auxiliar de corta vida (subject, SAN, OID...) al salir del using.</summary>
    private readonly struct ComScope : IDisposable
    {
        public object Value { get; }

        private ComScope(object value) => Value = value;

        public static ComScope Create(string progId) => new(CreateComObject(progId));

        public static ComScope Wrap(object value) => new(value);

        public void Dispose() => ReleaseCom(Value);
    }

    public void RemoveCertificate(X509Certificate2 certificate)
    {
        // Certificado Y clave (TPM o software): quitar solo el certificado del
        // almacen dejaba la clave huerfana en el proveedor.
        new CertificateLifecycle().RemoveWithKey(certificate.Thumbprint);
    }
}
