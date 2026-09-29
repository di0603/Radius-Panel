using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services;

/// <summary>
/// Comprueba/instala la raiz "didev Root CA" por su huella SHA-256 (no por
/// nombre: dos raices distintas podrian coincidir en el CN). Instalar en
/// LocalMachine\Root exige admin (ver RootCertificateElevatedInstaller para
/// el paso de auto-elevacion de un solo uso en la variante portable) -y,
/// segun la investigacion del prompt 12 (NOTAS-prompt-12-en-pausa.md, riesgo
/// 1), es imprescindible ahi de todas formas: el certificado del propio
/// gateway IKE (no solo el de RADIUS) lo valida RasMan en el almacen POR
/// EQUIPO, asi que instalar solo en CurrentUser\Root no bastaria para
/// conectar aunque EapHost si aceptara esa raiz para el lado EAP-TLS-.
/// </summary>
internal interface IRootCertificateStoreService
{
    bool IsInstalled(StoreLocation location, string sha256ThumbprintHex);
    void Install(StoreLocation location, X509Certificate2 rootCertificate);

    /// <summary>
    /// Retira la raiz por huella SHA-256 (no falla si ya no esta). Solo la usa
    /// el flujo de desinstalacion (--uninstall-cleanup), y solo tras
    /// comprobar que ningun otro perfil de usuario de este equipo sigue
    /// teniendo un dispositivo dado de alta -ver UninstallCleanupRunner-.
    /// </summary>
    void Remove(StoreLocation location, string sha256ThumbprintHex);
}

internal sealed class RootCertificateStoreService : IRootCertificateStoreService
{
    public bool IsInstalled(StoreLocation location, string sha256ThumbprintHex)
    {
        using var store = new X509Store(StoreName.Root, location);
        store.Open(OpenFlags.ReadOnly);
        var target = sha256ThumbprintHex.Trim().ToLowerInvariant();
        foreach (var cert in store.Certificates)
        {
            if (ComputeSha256Thumbprint(cert) == target)
            {
                return true;
            }
        }
        return false;
    }

    public void Install(StoreLocation location, X509Certificate2 rootCertificate)
    {
        using var store = new X509Store(StoreName.Root, location);
        store.Open(OpenFlags.ReadWrite);
        store.Add(rootCertificate);
    }

    public void Remove(StoreLocation location, string sha256ThumbprintHex)
    {
        using var store = new X509Store(StoreName.Root, location);
        store.Open(OpenFlags.ReadWrite);
        var target = sha256ThumbprintHex.Trim().ToLowerInvariant();
        foreach (var cert in store.Certificates)
        {
            if (ComputeSha256Thumbprint(cert) == target)
            {
                store.Remove(cert);
            }
        }
    }

    public static string ComputeSha256Thumbprint(X509Certificate2 cert) =>
        Convert.ToHexString(cert.GetCertHash(HashAlgorithmName.SHA256)).ToLowerInvariant();
}
