using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>
/// Integracion REAL con el almacen CurrentUser\My (y claves CNG persistidas):
/// cada test crea su propia CA de prueba y sus certificados, y los borra todos
/// al terminar. El registro va a un fichero temporal.
/// </summary>
public sealed class CertificateLifecycleTests : IDisposable
{
    private readonly string _registryPath = Path.Combine(Path.GetTempPath(), $"didev-registry-{Guid.NewGuid():N}.json");
    private readonly List<string> _installedThumbprints = new();

    private sealed class TestCa
    {
        public required X509Certificate2 Certificate { get; init; }
        public required ECDsa Key { get; init; }
    }

    private static TestCa NewCa(string name)
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={name}-{Guid.NewGuid():N}", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        var now = DateTimeOffset.UtcNow;
        return new TestCa { Certificate = request.CreateSelfSigned(now.AddMinutes(-10), now.AddDays(2)), Key = key };
    }

    /// <summary>Instala en CurrentUser\My un certificado firmado por la CA con su clave PERSISTIDA (como hace CertEnroll).</summary>
    private X509Certificate2 Install(TestCa ca, string cn)
    {
        using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={cn}", leafKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new Oid("1.3.6.1.5.5.7.3.2") }, true));
        var now = DateTimeOffset.UtcNow;
        using var signed = request.Create(ca.Certificate.SubjectName, X509SignatureGenerator.CreateForECDsa(ca.Key),
            now.AddMinutes(-5), now.AddDays(1), RandomNumberGenerator.GetBytes(12));
        using var withKey = signed.CopyWithPrivateKey(leafKey);
        using var imported = new X509Certificate2(withKey.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.PersistKeySet);

        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        store.Add(imported);
        _installedThumbprints.Add(imported.Thumbprint);
        return new X509Certificate2(imported.RawData);
    }

    private static bool InStore(string thumbprint)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        return store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false).Count > 0;
    }

    private static (string Name, CngProvider Provider)? KeyOf(string thumbprint)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        var cert = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false).Cast<X509Certificate2>().FirstOrDefault();
        if (cert is null) return null;
        using var key = cert.GetECDsaPrivateKey() as ECDsaCng;
        return key is null ? null : (key.Key.KeyName!, key.Key.Provider!);
    }

    private CertificateLifecycle NewLifecycle() => new(null, new InstalledCertificateRegistry(_registryPath));

    public void Dispose()
    {
        // Red de seguridad: nada de lo que crea un test se queda en el almacen del usuario.
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        foreach (var thumbprint in _installedThumbprints)
        {
            foreach (var cert in store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false))
            {
                try { (cert.GetECDsaPrivateKey() as ECDsaCng)?.Key.Delete(); } catch { }
                store.Remove(cert);
            }
        }
        File.Delete(_registryPath);
    }

    [Fact]
    public void Registry_AddListRemove_RoundTripsAndNeverHoldsSecrets()
    {
        var registry = new InstalledCertificateRegistry(_registryPath);
        registry.Add(new InstalledCertificateEntry("AA11", "vpn-a", "srv", "vpn-a", "CN=CA", DateTimeOffset.UtcNow));
        registry.Add(new InstalledCertificateEntry("BB22", "vpn-b", "srv", "vpn-b", "CN=CA", DateTimeOffset.UtcNow));
        registry.Add(new InstalledCertificateEntry("aa11", "vpn-a", "srv", "vpn-a", "CN=CA", DateTimeOffset.UtcNow)); // misma huella: sustituye

        Assert.Equal(2, registry.List().Count);
        Assert.True(registry.Remove("bb22"));
        Assert.False(registry.Remove("ZZ99"));
        Assert.Single(registry.List());

        var text = File.ReadAllText(_registryPath);
        Assert.DoesNotContain("PRIVATE", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Registry_CorruptFile_IsTreatedAsEmpty_SoNothingGetsDeleted()
    {
        File.WriteAllText(_registryPath, "{esto no es json");

        Assert.Empty(new InstalledCertificateRegistry(_registryPath).List());
    }

    [Fact]
    public void RemoveWithKey_DeletesCertificateKeyAndRegistryEntry()
    {
        var ca = NewCa("ca-remove");
        var cert = Install(ca, "vpn-remove-test");
        var lifecycle = NewLifecycle();
        lifecycle.Register(cert, "vpn-remove-test", "srv", "vpn-remove-test");
        var key = KeyOf(cert.Thumbprint)!.Value;
        Assert.True(CngKey.Exists(key.Name, key.Provider, CngKeyOpenOptions.UserKey));

        var removed = lifecycle.RemoveWithKey(cert.Thumbprint);

        Assert.True(removed);
        Assert.False(InStore(cert.Thumbprint));
        Assert.False(CngKey.Exists(key.Name, key.Provider, CngKeyOpenOptions.UserKey), "la clave no deberia quedar huerfana");
        Assert.Empty(new InstalledCertificateRegistry(_registryPath).List());
    }

    [Fact]
    public void CleanupStale_RemovesOnlyOldOnesOfTheDeviceAndOrphans_NeverOtherIssuersNorUnregistered()
    {
        var caA = NewCa("ca-a");
        var caB = NewCa("ca-b");
        var lifecycle = NewLifecycle();

        var old = Install(caA, "vpn-dev1-old");             // mismo dispositivo, anterior -> se borra
        var current = Install(caA, "vpn-dev1-new");          // el que se queda
        var orphan = Install(caA, "vpn-gone");               // de una conexion que ya no existe -> se borra
        var otherConnection = Install(caA, "vpn-dev2");      // de otra conexion que SI existe -> se queda
        var otherIssuer = Install(caB, "vpn-dev1-otherca");  // mismo dispositivo pero OTRO emisor -> se queda
        var unregistered = Install(caA, "vpn-dev1-foreign"); // no esta en el registro -> NUNCA se toca

        lifecycle.Register(old, "vpn-dev1", "srv", "vpn-dev1");
        lifecycle.Register(current, "vpn-dev1", "srv", "vpn-dev1");
        lifecycle.Register(orphan, "vpn-gone", "srv", "vpn-gone");
        lifecycle.Register(otherConnection, "vpn-dev2", "srv", "vpn-dev2");
        lifecycle.Register(otherIssuer, "vpn-dev1", "srv", "vpn-dev1");

        var removed = lifecycle.CleanupStale("vpn-dev1", "srv", current, new[] { "vpn-dev1", "vpn-dev2" });

        Assert.Equal(new[] { old.Thumbprint, orphan.Thumbprint }.OrderBy(x => x), removed.OrderBy(x => x));
        Assert.False(InStore(old.Thumbprint));
        Assert.False(InStore(orphan.Thumbprint));
        Assert.True(InStore(current.Thumbprint));
        Assert.True(InStore(otherConnection.Thumbprint));
        Assert.True(InStore(otherIssuer.Thumbprint));
        Assert.True(InStore(unregistered.Thumbprint));
    }

    [Fact]
    public void AdoptConnectionCertificates_RegistersTheCertificatesOfExistingConnections()
    {
        var ca = NewCa("ca-adopt");
        var cert = Install(ca, "vpn-adopt-test");
        var lifecycle = NewLifecycle();
        var record = new ConnectionRecord { Cn = "vpn-adopt-test", Server = "srv", CertificateThumbprint = cert.Thumbprint };

        lifecycle.AdoptConnectionCertificates(new[] { record, new ConnectionRecord { Cn = "x", CertificateThumbprint = "0000" } });

        var entries = new InstalledCertificateRegistry(_registryPath).List();
        Assert.Single(entries);
        Assert.Equal(cert.Thumbprint, entries[0].Thumbprint, ignoreCase: true);
        Assert.Equal("vpn-adopt-test", entries[0].Device);
    }
}
