using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services;

/// <summary>
/// Valida el certificado TLS del listener EST contra la cadena que trae el
/// propio perfil (root + intermedia), NUNCA contra el almacen de confianza
/// general de Windows: aunque el sistema confiara en otra CA por el motivo
/// que fuera, esta app solo debe hablar con el EST de didev si presenta
/// exactamente esta cadena.
/// </summary>
internal static class EstTrustValidator
{
    /// <summary>
    /// <paramref name="chainPem"/> es <c>caChainPem</c> del perfil ya
    /// verificado: intermedia + raiz concatenadas en PEM. Separa cual es la
    /// raiz (autofirmada: subject == issuer) de la/s intermedia/s.
    /// </summary>
    public static X509Certificate2Collection ParseChain(string chainPem)
    {
        var certs = new X509Certificate2Collection();
        certs.ImportFromPem(chainPem);
        if (certs.Count == 0)
        {
            throw new InvalidOperationException("La cadena de CA del perfil esta vacia.");
        }
        return certs;
    }

    public static RemoteCertificateValidationCallback CreateCallback(X509Certificate2Collection trustedChain)
    {
        var root = trustedChain.FirstOrDefault(c => c.SubjectName.RawData.AsSpan().SequenceEqual(c.IssuerName.RawData))
                   ?? throw new InvalidOperationException("La cadena de CA del perfil no incluye ninguna raiz autofirmada.");
        var intermediates = new X509Certificate2Collection(trustedChain.Where(c => !ReferenceEquals(c, root)).ToArray());

        return (_, certificate, _, sslPolicyErrors) =>
        {
            if (certificate is null)
            {
                return false;
            }

            using var serverCert = new X509Certificate2(certificate);
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(root);
            chain.ChainPolicy.ExtraStore.AddRange(intermediates);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck; // la CRL de la intermedia la valida FreeRADIUS, no esta app
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;

            var chainOk = chain.Build(serverCert);
            if (!chainOk)
            {
                return false;
            }

            // SslPolicyErrors.RemoteCertificateChainErrors se ignora a
            // proposito: ya hemos construido y comprobado la cadena nosotros
            // mismos contra la raiz del perfil. Cualquier otro error (nombre,
            // no disponible) si debe seguir rechazando.
            return sslPolicyErrors is SslPolicyErrors.None or SslPolicyErrors.RemoteCertificateChainErrors;
        };
    }
}
