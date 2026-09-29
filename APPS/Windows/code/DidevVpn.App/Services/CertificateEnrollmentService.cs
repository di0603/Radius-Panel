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

    /// <summary>Borra un certificado (y su clave privada asociada) de CurrentUser\My, p.ej. tras una renovacion o al desinstalar.</summary>
    void RemoveCertificate(X509Certificate2 certificate);
}

internal sealed class CertificateEnrollmentService : ICertificateEnrollmentService
{
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

    public X509Certificate2 InstallIssuedCertificate(X509Certificate2 issuedCertificateWithoutKey, EnrolledKey key)
    {
        using var ecdsa = new ECDsaCng(key.CngKey);
        // La CngKey tiene nombre (persistida): esto enlaza el certificado a
        // ella via CERT_KEY_PROV_INFO_PROP_ID, sin necesitar "certreq -accept"
        // (eso solo hace falta si la clave se creo con certreq.exe).
        using var withKey = issuedCertificateWithoutKey.CopyWithPrivateKey(ecdsa);

        // X509Certificate2.CopyWithPrivateKey devuelve una instancia efimera:
        // hay que volver a importarla (Exportable pero solo en memoria, con
        // PersistKeySet) para que quede enlazada de verdad en el almacen.
        var exported = withKey.Export(X509ContentType.Pkcs12);
        try
        {
            // X509CertificateLoader (mas moderna, sin el aviso SYSLIB0057) no
            // existe todavia en net8.0: es de .NET 9. El constructor sigue sin
            // marcarse obsoleto en esta TFM.
            var persisted = new X509Certificate2(
                exported, (string?)null,
                X509KeyStorageFlags.PersistKeySet | X509KeyStorageFlags.UserKeySet);

            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadWrite);
            store.Add(persisted);
            return persisted;
        }
        finally
        {
            Array.Clear(exported, 0, exported.Length);
        }
    }

    public void RemoveCertificate(X509Certificate2 certificate)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        store.Remove(certificate);
    }
}
