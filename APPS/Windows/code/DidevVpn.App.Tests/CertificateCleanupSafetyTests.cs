using System.Formats.Asn1;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>
/// Seguridad de la limpieza de certificados (prompt 12.10, punto 2) con el
/// registro y el almacen SIMULADOS: nada de lo que se borra aqui existe de
/// verdad. Lo que se comprueba es la decision de borrar o no.
/// </summary>
[Collection(ConnectionStoreCollection.Name)]
public class CertificateCleanupSafetyTests
{
    private sealed class InMemoryRegistry : IInstalledCertificateRegistry
    {
        public readonly List<InstalledCertificateEntry> Entries = new();
        public IReadOnlyList<InstalledCertificateEntry> List() => Entries.ToList();
        public void Add(InstalledCertificateEntry entry)
        {
            Entries.RemoveAll(e => e.Thumbprint.Equals(entry.Thumbprint, StringComparison.OrdinalIgnoreCase));
            Entries.Add(entry);
        }
        public bool Remove(string thumbprint) =>
            Entries.RemoveAll(e => e.Thumbprint.Equals(thumbprint, StringComparison.OrdinalIgnoreCase)) > 0;
    }

    private sealed class FakeStore : IUserCertificateStore
    {
        public readonly List<string> Removed = new();
        public X509Certificate2? Find(string thumbprint) => null;
        public bool RemoveWithKey(string thumbprint)
        {
            Removed.Add(thumbprint);
            return true;
        }
    }

    private const string IssuerName = "CN=VPN Intermediate CA";

    /// <summary>Certificado "que se conserva" con el emisor y el identificador de clave de CA que se pidan.</summary>
    private static X509Certificate2 Keep(string issuerCn, string? authorityKeyIdHex)
    {
        using var caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=vpn-dev1", leafKey, HashAlgorithmName.SHA256);
        if (authorityKeyIdHex is not null)
        {
            var writer = new AsnWriter(AsnEncodingRules.DER);
            using (writer.PushSequence())
            {
                writer.WriteOctetString(Convert.FromHexString(authorityKeyIdHex), new Asn1Tag(TagClass.ContextSpecific, 0));
            }
            request.CertificateExtensions.Add(new X509Extension("2.5.29.35", writer.Encode(), false));
        }
        var now = DateTimeOffset.UtcNow;
        using var signed = request.Create(new X500DistinguishedName(issuerCn), X509SignatureGenerator.CreateForECDsa(caKey),
            now.AddDays(-1), now.AddDays(20), RandomNumberGenerator.GetBytes(12));
        return new X509Certificate2(signed.RawData);
    }

    private static InstalledCertificateEntry Entry(string thumbprint, string device, string server, string connection,
        string issuer = IssuerName, string? keyId = null) =>
        new(thumbprint, device, server, connection, issuer, DateTimeOffset.UtcNow, keyId);

    private static (CertificateLifecycle Lifecycle, InMemoryRegistry Registry, FakeStore Store) Make(params InstalledCertificateEntry[] entries)
    {
        var registry = new InMemoryRegistry();
        registry.Entries.AddRange(entries);
        var store = new FakeStore();
        return (new CertificateLifecycle(new FileLogger(), registry, store), registry, store);
    }

    private static string TodayLog()
    {
        var file = Path.Combine(AppPaths.LogsDirectory, $"{DateTime.UtcNow:yyyy-MM-dd}.log");
        return File.Exists(file) ? File.ReadAllText(file) : string.Empty;
    }

    [Fact]
    public void ConnectionListUnreadable_NoOrphanIsDeleted_AndAWarningIsLogged_ButTheSupersededOneStillIs()
    {
        using var keep = Keep(IssuerName, null);
        var (lifecycle, registry, store) = Make(
            Entry("AA01", "vpn-dev1", "srv", "vpn-dev1"),     // sustituido: mismo dispositivo -> se borra
            Entry("BB02", "vpn-dev2", "srv", "vpn-dev2"),     // conexion legitima de otro dispositivo (la lista no se leyo) -> NO
            Entry("CC03", "vpn-dev3", "srv", "vpn-dev3"));

        var removed = lifecycle.CleanupStale("vpn-dev1", "srv", keep, existingConnections: null);

        Assert.Equal(new[] { "AA01" }, removed);
        Assert.Equal(new[] { "AA01" }, store.Removed);
        Assert.Equal(new[] { "BB02", "CC03" }, registry.Entries.Select(e => e.Thumbprint).OrderBy(x => x));
        Assert.Contains("No se ha podido leer la lista de conexiones existentes", TodayLog());
    }

    [Fact]
    public void ConnectionListReadOk_OrphansOfTheSameServerAndIssuerAreDeleted()
    {
        using var keep = Keep(IssuerName, null);
        var (lifecycle, _, store) = Make(
            Entry("AA01", "vpn-gone", "srv", "vpn-gone"),     // su conexion ya no existe -> se borra
            Entry("BB02", "vpn-dev2", "srv", "vpn-dev2"));    // su conexion existe -> se queda

        var removed = lifecycle.CleanupStale("vpn-dev1", "srv", keep, new[] { "vpn-dev1", "vpn-dev2" });

        Assert.Equal(new[] { "AA01" }, removed);
        Assert.Equal(new[] { "AA01" }, store.Removed);
    }

    [Fact]
    public void SameDeviceNameOnAnotherServer_IsNeverDeleted_NeitherSupersededNorOrphan()
    {
        using var keep = Keep(IssuerName, null);
        var (lifecycle, registry, store) = Make(
            Entry("AA01", "vpn-dev1", "otro-servidor", "vpn-dev1"),   // mismo dispositivo, OTRO servidor
            Entry("BB02", "vpn-gone", "otro-servidor", "vpn-gone"));  // huerfano de otro servidor

        var removed = lifecycle.CleanupStale("vpn-dev1", "srv", keep, new[] { "vpn-dev1" });

        Assert.Empty(removed);
        Assert.Empty(store.Removed);
        Assert.Equal(2, registry.Entries.Count);
    }

    [Fact]
    public void ServerComparisonIgnoresCase()
    {
        using var keep = Keep(IssuerName, null);
        var (lifecycle, _, store) = Make(Entry("AA01", "vpn-dev1", "SRV.Example.ORG", "vpn-dev1"));

        lifecycle.CleanupStale("vpn-dev1", "srv.example.org", keep, new[] { "vpn-dev1" });

        Assert.Equal(new[] { "AA01" }, store.Removed);
    }

    [Fact]
    public void DifferentIssuerName_IsNeverDeleted()
    {
        using var keep = Keep(IssuerName, null);
        var (lifecycle, _, store) = Make(
            Entry("AA01", "vpn-dev1", "srv", "vpn-dev1", issuer: "CN=Otra CA"),
            Entry("BB02", "vpn-gone", "srv", "vpn-gone", issuer: "CN=Otra CA"));

        var removed = lifecycle.CleanupStale("vpn-dev1", "srv", keep, new[] { "vpn-dev1" });

        Assert.Empty(removed);
        Assert.Empty(store.Removed);
    }

    [Fact]
    public void TwoDifferentCAsWithTheSameName_AreToldApartByTheirKeyIdentifier()
    {
        // El nombre en texto es identico ("CN=VPN Intermediate CA"), pero son dos CA distintas.
        using var keep = Keep(IssuerName, "11223344556677889900AABBCCDDEEFF00112233");
        var (lifecycle, _, store) = Make(
            Entry("AA01", "vpn-dev1", "srv", "vpn-dev1", keyId: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"), // otra CA
            Entry("BB02", "vpn-dev1", "srv", "vpn-dev1", keyId: "11223344556677889900aabbccddeeff00112233")); // la misma CA

        var removed = lifecycle.CleanupStale("vpn-dev1", "srv", keep, new[] { "vpn-dev1" });

        Assert.Equal(new[] { "BB02" }, removed);
    }

    [Fact]
    public void IssuerKeyIdKnownByOnlyOneSide_CannotProveTheSameCA_SoNothingIsDeleted()
    {
        using var keepWithId = Keep(IssuerName, "11223344556677889900AABBCCDDEEFF00112233");
        using var keepWithoutId = Keep(IssuerName, null);
        var (lifecycle, _, store) = Make(
            Entry("AA01", "vpn-dev1", "srv", "vpn-dev1", keyId: null));   // entrada antigua sin identificador

        Assert.Empty(lifecycle.CleanupStale("vpn-dev1", "srv", keepWithId, new[] { "vpn-dev1" }));

        var (lifecycle2, _, store2) = Make(
            Entry("BB02", "vpn-dev1", "srv", "vpn-dev1", keyId: "11223344556677889900AABBCCDDEEFF00112233"));
        Assert.Empty(lifecycle2.CleanupStale("vpn-dev1", "srv", keepWithoutId, new[] { "vpn-dev1" }));

        Assert.Empty(store.Removed);
        Assert.Empty(store2.Removed);
    }

    [Fact]
    public void TheKeptCertificateItselfIsNeverDeleted()
    {
        using var keep = Keep(IssuerName, null);
        var (lifecycle, registry, store) = Make(Entry(keep.Thumbprint, "vpn-dev1", "srv", "vpn-dev1"));

        var removed = lifecycle.CleanupStale("vpn-dev1", "srv", keep, new[] { "vpn-dev1" });

        Assert.Empty(removed);
        Assert.Empty(store.Removed);
        Assert.Single(registry.Entries);
    }

    [Fact]
    public void IssuerKeyId_IsReadFromTheAuthorityKeyIdentifierExtension()
    {
        using var withId = Keep(IssuerName, "AABBCCDD");
        using var without = Keep(IssuerName, null);

        Assert.Equal("AABBCCDD", CertificateLifecycle.IssuerKeyId(withId));
        Assert.Null(CertificateLifecycle.IssuerKeyId(without));
    }

    [Fact]
    public void ConnectionStore_ListOrNull_ReturnsNullWhenAFileIsUnreadable_WhileListSkipsIt()
    {
        AppPaths.EnsureDataDirectoryExists();
        Directory.CreateDirectory(AppPaths.ConnectionsDirectory);
        var good = new ConnectionRecord { Cn = "vpn-listornull-ok", Server = "srv" };
        var corrupt = Path.Combine(AppPaths.ConnectionsDirectory, "vpn-listornull-corrupt.json");
        try
        {
            ConnectionStore.Save(good);
            Assert.NotNull(ConnectionStore.ListOrNull());

            File.WriteAllText(corrupt, "{esto no es json");

            Assert.Null(ConnectionStore.ListOrNull());                                   // estricto: no se puede dar por completa
            Assert.Contains(ConnectionStore.List(), c => c.Cn == "vpn-listornull-ok");    // tolerante: se salta el ilegible
        }
        finally
        {
            File.Delete(corrupt);
            ConnectionStore.Delete(good.Cn);
        }
    }
}
