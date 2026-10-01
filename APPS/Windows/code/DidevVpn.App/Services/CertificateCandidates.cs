using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace DidevVpn.App.Services;

internal sealed record CandidateCertificate(string CommonName, DateTimeOffset NotAfter, string Thumbprint, bool IsConnectionCertificate);

/// <summary>Certificados de cliente candidatos de una conexion: los que Windows puede ofrecer en su selector (mismo emisor que el filtro CAHashList del perfil EAP).</summary>
internal sealed record CertificateCandidateReport(string IssuerName, IReadOnlyList<CandidateCertificate> Candidates)
{
    public bool IsAmbiguous => Candidates.Count > 1;

    /// <summary>Aviso para la ventana y el log: que pasa, la lista y como quitarlos. Sin huellas completas ni nada secreto.</summary>
    public string BuildWarning(string connectionName)
    {
        var text = new StringBuilder();
        text.Append($"Hay {Candidates.Count} certificados de cliente del mismo emisor ({IssuerName}) en tu almacen personal. ");
        text.AppendLine("Si Windows no sabe cual usar, abre su ventana \"Seleccione un certificado\" (o falla con el error 703) al conectar.");
        foreach (var c in Candidates.OrderByDescending(c => c.IsConnectionCertificate).ThenBy(c => c.NotAfter))
        {
            text.AppendLine($"  • {c.CommonName} - caduca {c.NotAfter.ToLocalTime():dd/MM/yyyy}{(c.IsConnectionCertificate ? "  (el de esta conexion)" : "")}");
        }
        text.Append($"Para quitar los que sobran: Win+R > certmgr.msc > Personal > Certificados, y borra los que no sean el de \"{connectionName}\". ");
        text.Append("Los de conexiones que ya no uses se borran solos al pulsar \"Quitar\" en esa conexion.");
        return text.ToString();
    }
}

internal static class CertificateCandidates
{
    private const string ClientAuthOid = "1.3.6.1.5.5.7.3.2";

    /// <summary>Candidatos de <paramref name="record"/> en CurrentUser\My, o null si no se puede comprobar (su certificado ya no esta).</summary>
    public static CertificateCandidateReport? Check(ConnectionRecord record)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        return Check(record.CertificateThumbprint, store.Certificates.Cast<X509Certificate2>().ToList(), DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// Separado del almacen para probarlo. Candidato = tiene clave privada,
    /// EKU clientAuth (o sin EKU), vigente y con el MISMO emisor que el
    /// certificado de la conexion: es exactamente lo que filtra el XML EAP
    /// (CAHashList por emisor), no mas ni menos.
    /// </summary>
    internal static CertificateCandidateReport? Check(string connectionThumbprint, IReadOnlyList<X509Certificate2> store, DateTimeOffset now)
    {
        var own = store.FirstOrDefault(c => string.Equals(c.Thumbprint, connectionThumbprint, StringComparison.OrdinalIgnoreCase));
        if (own is null)
        {
            return null;
        }

        var candidates = store
            .Where(c => string.Equals(c.Issuer, own.Issuer, StringComparison.Ordinal))
            .Where(c => c.HasPrivateKey && IsClientAuth(c) && c.NotBefore <= now && now <= c.NotAfter)
            .Select(c => new CandidateCertificate(
                c.GetNameInfo(X509NameType.SimpleName, false),
                new DateTimeOffset(c.NotAfter),
                c.Thumbprint,
                string.Equals(c.Thumbprint, own.Thumbprint, StringComparison.OrdinalIgnoreCase)))
            .ToList();

        return new CertificateCandidateReport(own.GetNameInfo(X509NameType.SimpleName, true), candidates);
    }

    private static bool IsClientAuth(X509Certificate2 certificate)
    {
        var eku = certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().FirstOrDefault();
        return eku is null || eku.EnhancedKeyUsages.Cast<System.Security.Cryptography.Oid>().Any(o => o.Value == ClientAuthOid);
    }
}
