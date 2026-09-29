using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services;

/// <summary>Clave CNG recien creada, todavia sin certificado. Se guarda con nombre (persistida) para poder enlazarla al certificado emitido mas tarde.</summary>
internal sealed class EnrolledKey : IDisposable
{
    public CngKey CngKey { get; }
    public byte[] CsrDer { get; }
    public bool IsTpmBacked { get; }

    public EnrolledKey(CngKey cngKey, byte[] csrDer, bool isTpmBacked)
    {
        CngKey = cngKey;
        CsrDer = csrDer;
        IsTpmBacked = isTpmBacked;
    }

    public void Dispose() => CngKey.Dispose();
}

/// <summary>
/// Genera la clave del dispositivo (ECDSA P-256, no exportable, en
/// CurrentUser\My via CNG) y el CSR, y enlaza el certificado emitido por EST
/// a esa misma clave. Ver APPS/Windows/NOTAS-prompt-12-en-pausa.md punto 5:
/// SIEMPRE claves de usuario (nunca "MachineKeySet"), por el bug conocido de
/// dotnet/runtime con claves PCP de maquina, y porque ademas es justo lo
/// correcto para un certificado de tunel de usuario en CurrentUser\My.
/// </summary>
internal interface ICertificateEnrollmentService
{
    /// <summary>
    /// Intenta crear la clave en el TPM ("Microsoft Platform Crypto
    /// Provider"). Si no hay TPM disponible (o esta ocupado/no soporta
    /// ECDSA P-256), devuelve false y NO crea ninguna clave -el llamador debe
    /// pedir confirmacion explicita antes de usar
    /// <see cref="CreateSoftwareBackedKey"/>, nunca hacerlo en silencio-.
    /// </summary>
    bool TryCreateTpmBackedKey(string cn, out EnrolledKey? key, out Exception? failure);

    /// <summary>Clave por software (Microsoft Software Key Storage Provider): sigue sin ser exportable, pero no vive en un chip separado.</summary>
    EnrolledKey CreateSoftwareBackedKey(string cn);

    /// <summary>Enlaza el certificado que acaba de emitir EST a la clave ya creada e instala en CurrentUser\My.</summary>
    X509Certificate2 InstallIssuedCertificate(X509Certificate2 issuedCertificateWithoutKey, EnrolledKey key);

    /// <summary>Asocia un certificado temporalmente a la clave CNG persistente sin exportar la clave privada.</summary>
    X509Certificate2 AssociatePrivateKey(X509Certificate2 certificateWithoutKey, EnrolledKey key);

    /// <summary>Borra un certificado (y su clave privada asociada) de CurrentUser\My, p.ej. tras una renovacion o al desinstalar.</summary>
    void RemoveCertificate(X509Certificate2 certificate);
}

internal sealed class CertificateEnrollmentService : ICertificateEnrollmentService
{
    private const uint CertKeyProvInfoPropId = 2;
    private const uint CertNcryptKeySpec = 0xFFFFFFFF;

    public bool TryCreateTpmBackedKey(string cn, out EnrolledKey? key, out Exception? failure)
    {
        try
        {
            key = CreateKeyWithProvider(cn, CngProvider.MicrosoftPlatformCryptoProvider, isTpmBacked: true);
            failure = null;
            return true;
        }
        catch (CryptographicException ex)
        {
            key = null;
            failure = ex;
            return false;
        }
    }

    public EnrolledKey CreateSoftwareBackedKey(string cn) =>
        CreateKeyWithProvider(cn, CngProvider.MicrosoftSoftwareKeyStorageProvider, isTpmBacked: false);

    private static EnrolledKey CreateKeyWithProvider(string cn, CngProvider provider, bool isTpmBacked)
    {
        var keyName = $"didev-vpn-{Guid.NewGuid():N}";
        var creationParameters = new CngKeyCreationParameters
        {
            Provider = provider,
            KeyCreationOptions = CngKeyCreationOptions.None, // clave de USUARIO, nunca MachineKeySet (ver comentario de la clase)
            // ExportPolicy por defecto ya es "ninguno": no exportable sin pedirlo explicitamente.
        };

        var cngKey = CngKey.Create(CngAlgorithm.ECDsaP256, keyName, creationParameters);
        try
        {
            using var ecdsa = new ECDsaCng(cngKey);
            var subject = new X500DistinguishedName($"CN={cn}");
            var request = new CertificateRequest(subject, ecdsa, HashAlgorithmName.SHA256);

            var sanBuilder = new SubjectAlternativeNameBuilder();
            sanBuilder.AddDnsName(cn); // strongSwan busca el certificado del cliente por el SAN dNSName = CN, ver CLAUDE.md del panel
            request.CertificateExtensions.Add(sanBuilder.Build());

            var csrDer = request.CreateSigningRequest();
            return new EnrolledKey(cngKey, csrDer, isTpmBacked);
        }
        catch
        {
            cngKey.Dispose();
            throw;
        }
    }

    public X509Certificate2 AssociatePrivateKey(X509Certificate2 certificateWithoutKey, EnrolledKey key)
    {
        ArgumentNullException.ThrowIfNull(certificateWithoutKey);
        ArgumentNullException.ThrowIfNull(key);

        var associated = new X509Certificate2(certificateWithoutKey.RawData);
        try
        {
            EnsurePublicKeyMatches(associated, key);
            var provider = key.CngKey.Provider
                ?? throw new CryptographicException("La clave CNG no informa de su proveedor.");

            var keyProviderInfo = new CryptKeyProvInfo
            {
                ContainerName = key.CngKey.KeyName
                    ?? throw new CryptographicException("La clave CNG no tiene un nombre persistente."),
                ProviderName = provider.Provider,
                ProviderType = 0,
                Flags = 0,
                ProviderParameterCount = 0,
                ProviderParameters = IntPtr.Zero,
                KeySpec = CertNcryptKeySpec,
            };

            if (!CertSetCertificateContextProperty(
                    associated.Handle,
                    CertKeyProvInfoPropId,
                    0,
                    ref keyProviderInfo))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "Windows no pudo asociar el certificado a la clave CNG del dispositivo.");
            }

            if (!associated.HasPrivateKey)
            {
                throw new CryptographicException("Windows no reconocio la clave privada asociada al certificado.");
            }

            return associated;
        }
        catch
        {
            associated.Dispose();
            throw;
        }
    }

    public X509Certificate2 InstallIssuedCertificate(X509Certificate2 issuedCertificateWithoutKey, EnrolledKey key)
    {
        using var associated = AssociatePrivateKey(issuedCertificateWithoutKey, key);
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        store.Add(associated);

        var matches = store.Certificates.Find(
            X509FindType.FindByThumbprint,
            associated.Thumbprint,
            validOnly: false);
        try
        {
            var stored = matches.Cast<X509Certificate2>().FirstOrDefault()
                ?? throw new CryptographicException("Windows no encontro el certificado recien instalado.");
            using var privateKey = stored.GetECDsaPrivateKey()
                ?? throw new CryptographicException("El certificado instalado no tiene una clave ECDSA asociada.");
            using var publicKey = stored.GetECDsaPublicKey()
                ?? throw new CryptographicException("El certificado instalado no contiene una clave publica ECDSA.");

            var challenge = RandomNumberGenerator.GetBytes(32);
            var signature = privateKey.SignData(challenge, HashAlgorithmName.SHA256);
            if (!publicKey.VerifyData(challenge, signature, HashAlgorithmName.SHA256))
            {
                throw new CryptographicException("La clave privada instalada no corresponde al certificado emitido.");
            }

            return new X509Certificate2(stored);
        }
        catch
        {
            store.Remove(associated);
            throw;
        }
        finally
        {
            foreach (X509Certificate2 match in matches)
            {
                match.Dispose();
            }
        }
    }

    private static void EnsurePublicKeyMatches(X509Certificate2 certificate, EnrolledKey key)
    {
        using var deviceKey = new ECDsaCng(key.CngKey);
        using var certificateKey = certificate.GetECDsaPublicKey()
            ?? throw new CryptographicException("El certificado emitido no contiene una clave publica ECDSA.");

        var deviceParameters = deviceKey.ExportParameters(includePrivateParameters: false).Q;
        var certificateParameters = certificateKey.ExportParameters(includePrivateParameters: false).Q;
        if (deviceParameters.X is null || deviceParameters.Y is null ||
            certificateParameters.X is null || certificateParameters.Y is null ||
            !CryptographicOperations.FixedTimeEquals(deviceParameters.X, certificateParameters.X) ||
            !CryptographicOperations.FixedTimeEquals(deviceParameters.Y, certificateParameters.Y))
        {
            throw new CryptographicException("La clave CNG no corresponde al certificado emitido por EST.");
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CryptKeyProvInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string ContainerName;
        [MarshalAs(UnmanagedType.LPWStr)] public string ProviderName;
        public uint ProviderType;
        public uint Flags;
        public uint ProviderParameterCount;
        public IntPtr ProviderParameters;
        public uint KeySpec;
    }

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CertSetCertificateContextProperty(
        IntPtr certificateContext,
        uint propertyId,
        uint flags,
        ref CryptKeyProvInfo data);

    public void RemoveCertificate(X509Certificate2 certificate)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        store.Remove(certificate);
    }
}
