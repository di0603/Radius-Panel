using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services;

internal sealed record EstStatus(string Username, DateTimeOffset NotAfter, bool RenewDue, string MinAppVersion);

/// <summary>
/// Certificado recien emitido por EST, junto con el cuerpo PKCS7 "certs-only"
/// tal cual lo devolvio el servidor (base64, sin cabecera PEM): hace falta el
/// cuerpo crudo, no solo el certificado ya parseado, porque
/// CertificateEnrollmentService lo pasa sin tocar a
/// CX509Enrollment.InstallResponse (ver esa clase para el porque).
/// </summary>
internal sealed record EstEnrollResult(X509Certificate2 Certificate, string Pkcs7Base64);

/// <summary>
/// Cliente EST (RFC 7030) minimo: solo los tres pasos que necesita esta app
/// (simpleenroll/simplereenroll/status). No usa GET cacerts -a diferencia de
/// la app de Android con la variante "qr" del perfil, esta app SIEMPRE recibe
/// la variante "full" con la cadena de CA ya dentro y firmada, asi que no
/// hace falta ese bootstrap sin TLS-.
/// </summary>
internal interface IEstClient
{
    /// <summary>
    /// POST simpleenroll: HTTP Basic (usuario = CN del dispositivo, contrasena
    /// = token de alta de un solo uso). <paramref name="trustedChain"/> es la
    /// cadena del propio perfil (root+intermedia): el TLS de EST se valida
    /// contra ELLA, no contra el almacen de confianza general de Windows.
    /// </summary>
    Task<EstEnrollResult> SimpleEnrollAsync(
        Uri estBaseUrl, string username, string enrollToken, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct);

    /// <summary>POST simplereenroll: TLS mutuo con el certificado vigente (sin contrasena).</summary>
    Task<EstEnrollResult> SimpleReenrollAsync(
        Uri estBaseUrl, X509Certificate2 clientCertificate, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct);

    /// <summary>GET status: mismo TLS mutuo; dias que le quedan al certificado presentado y si toca renovar.</summary>
    Task<EstStatus> GetStatusAsync(
        Uri estBaseUrl, X509Certificate2 clientCertificate, X509Certificate2Collection trustedChain, CancellationToken ct);
}
