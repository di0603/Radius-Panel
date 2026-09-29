using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services;

/// <summary>
/// Comprueba/instala una raiz por su huella SHA-256 (no por nombre: dos
/// raices distintas podrian coincidir en el CN, y desde el prompt 12.5 esta
/// app es un cliente generico que puede confiar en raices de varios
/// servidores). Instalar en LocalMachine\Root exige admin (ver
/// RootCertificateElevatedInstaller para el paso de auto-elevacion de un
/// solo uso en la variante portable) -y, segun la investigacion del prompt
/// 12 (NOTAS-prompt-12-en-pausa.md, riesgo 1), es imprescindible ahi de
/// todas formas: el certificado del propio gateway IKE (no solo el del
/// servidor RADIUS/EAP-TLS) lo valida RasMan en el almacen POR EQUIPO, asi
/// que instalar solo en CurrentUser\Root no bastaria para conectar aunque
/// EapHost si aceptara esa raiz para el lado EAP-TLS-.
///
/// A proposito NO hay un metodo para retirar una raiz: con varios servidores
/// posibles (cada conexion con su propia raiz), decidir con seguridad cual
/// retirar al desinstalar una conexion concreta -sin arriesgarse a romper
/// otra que comparta la misma raiz- es mas dificil que instalar, y no se ha
/// implementado (ver el README, "Limitaciones conocidas": se recomienda
/// certlm.msc a mano si hace falta limpiarla).
/// </summary>
internal interface IRootCertificateStoreService
{
    bool IsInstalled(StoreLocation location, string sha256ThumbprintHex);
    void Install(StoreLocation location, X509Certificate2 rootCertificate);
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

    public static string ComputeSha256Thumbprint(X509Certificate2 cert) =>
        Convert.ToHexString(cert.GetCertHash(HashAlgorithmName.SHA256)).ToLowerInvariant();
}
