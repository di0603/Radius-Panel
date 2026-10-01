using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Orchestration;
using DidevVpn.App.Services;
using DidevVpn.App.Services.Ras;
using DidevVpn.Core.Profile;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App.Tests;

/// <summary>
/// Renovacion de extremo a extremo (prompt 12.9, punto 8) con un EST simulado
/// (una CA de prueba firma el CSR real) y TODO lo demas real: CertEnroll con la
/// clave en el TPM si lo hay, el almacen CurrentUser\My, el registro de
/// certificados, las credenciales EAP de una entrada RAS de prueba. El panel
/// real solo permite una renovacion cada 12 h por dispositivo (control de
/// abuso del servidor), por eso la renovacion real contra el panel no se puede
/// repetir a voluntad. Todo lo que crea lo borra.
/// </summary>
public sealed class RenewalEndToEndTests : IDisposable
{
    private readonly List<string> _thumbprints = new();
    private string? _entry;
    private string? _cn;

    private sealed class FakeEst : IEstClient
    {
        public required X509Certificate2 Ca { get; init; }
        public required ECDsa CaKey { get; init; }
        public int ReenrollCalls;

        public Task<EstEnrollResult> SimpleEnrollAsync(Uri estBaseUrl, string username, string enrollToken, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<EstEnrollResult> SimpleReenrollAsync(Uri estBaseUrl, X509Certificate2 clientCertificate, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct)
        {
            Interlocked.Increment(ref ReenrollCalls);
            var request = CertificateRequest.LoadSigningRequest(csrDer, HashAlgorithmName.SHA256, CertificateRequestLoadOptions.UnsafeLoadCertificateExtensions);
            var now = DateTimeOffset.UtcNow;
            using var signed = request.Create(Ca.SubjectName, X509SignatureGenerator.CreateForECDsa(CaKey), now.AddMinutes(-1), now.AddDays(30), RandomNumberGenerator.GetBytes(12));
            var pkcs7 = new X509Certificate2Collection(signed).Export(X509ContentType.Pkcs7)!;
            return Task.FromResult(new EstEnrollResult(new X509Certificate2(signed.RawData), Convert.ToBase64String(pkcs7)));
        }

        public Task<EstStatus> GetStatusAsync(Uri estBaseUrl, X509Certificate2 clientCertificate, X509Certificate2Collection trustedChain, CancellationToken ct) =>
            Task.FromResult(new EstStatus("x", DateTimeOffset.UtcNow.AddDays(29), RenewDue: true, MinAppVersion: "0.0.0"));
    }

    private sealed class YesToAll : DidevVpn.App.Orchestration.IUserConfirmations
    {
        public bool ConfirmSoftwareKeyFallback(string reason) => true;
        public bool ConfirmRootCertificateElevation() => true;
        public bool ConfirmTrustAnchor(string server, string cn, FormattedFingerprint panelFingerprint, FormattedFingerprint rootFingerprint) => true;
    }

    private static string? ProviderOf(string thumbprint)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        var cert = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false).Cast<X509Certificate2>().FirstOrDefault();
        return (cert?.GetECDsaPrivateKey() as ECDsaCng)?.Key.Provider?.Provider;
    }

    private static bool InStore(string thumbprint)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        return store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false).Count > 0;
    }

    [Fact]
    public async Task Renewal_InstallsNewCertificateOnTheSameKindOfKey_UpdatesEapCredentials_AndDeletesTheOldOne()
    {
        using var caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var caRequest = new CertificateRequest($"CN=didev-test-ca-{Guid.NewGuid():N}", caKey, HashAlgorithmName.SHA256);
        caRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        var now = DateTimeOffset.UtcNow;
        using var ca = caRequest.CreateSelfSigned(now.AddMinutes(-10), now.AddDays(2));

        var suffix = Guid.NewGuid().ToString("N")[..6];
        _cn = $"vpn-renew-test-{suffix}";
        _entry = _cn;

        // Certificado "viejo", como el que dejo un alta anterior: clave persistida, registrado, con su conexion.
        X509Certificate2 old;
        using (var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            var request = new CertificateRequest($"CN={_cn}", leafKey, HashAlgorithmName.SHA256);
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.2") }, true));
            using var signed = request.Create(ca.SubjectName, X509SignatureGenerator.CreateForECDsa(caKey), now.AddDays(-25), now.AddDays(5), RandomNumberGenerator.GetBytes(12));
            using var withKey = signed.CopyWithPrivateKey(leafKey);
            using var imported = new X509Certificate2(withKey.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.PersistKeySet);
            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadWrite);
            store.Add(imported);
            old = new X509Certificate2(imported.RawData);
            _thumbprints.Add(old.Thumbprint);
        }

        var logger = new FileLogger();
        var lifecycle = new CertificateLifecycle(logger);
        lifecycle.Register(old, _cn, "vpn.example.org", _cn);

        var vpn = new VpnConnectionService(logger);
        vpn.CreateOrUpdateConnection(new VpnConnectionSpec(
            _cn, "192.0.2.1", "radius.test.invalid", ca.Thumbprint, ca.Thumbprint, false, Array.Empty<string>(),
            "GCMAES256", "SHA384", "ECP384", "GCMAES256", "ECP384"));
        vpn.SaveEapCredentials(_entry, old);
        var credentials = new EapUserCredentialStore();
        var blobBefore = Convert.ToHexString(credentials.GetStoredBlob(_entry)!);

        var record = new ConnectionRecord
        {
            Cn = _cn,
            Server = "vpn.example.org",
            EstBaseUrl = "https://pki.example.invalid:8443/.well-known/est",
            CaChainPem = ca.ExportCertificatePem(),
            CertificateThumbprint = old.Thumbprint,
            IsTpmBacked = false,
            LastEnrolledAtUtc = DateTimeOffset.UtcNow.AddDays(-25),
        };
        ConnectionStore.Save(record);
        var oldKey = (old.Thumbprint, ProviderOf(old.Thumbprint));
        Assert.NotNull(oldKey.Item2);

        var est = new FakeEst { Ca = ca, CaKey = caKey };
        var orchestrator = new RenewalOrchestrator(
            new CertificateEnrollmentService(), est, vpn, new YesToAll(), logger, new AppVersion(0, 1, 9), lifecycle);

        var result = await orchestrator.RenewIfDueAsync(record, CancellationToken.None);

        Assert.Equal(RenewalOutcome.Renewed, result.Outcome);
        Assert.Equal(1, est.ReenrollCalls);

        var saved = ConnectionStore.Load(_cn)!;
        _thumbprints.Add(saved.CertificateThumbprint);
        Assert.False(string.Equals(old.Thumbprint, saved.CertificateThumbprint, StringComparison.OrdinalIgnoreCase));

        // Certificado nuevo instalado, con su clave en el proveedor esperado (TPM si lo hay; la app lo registra en IsTpmBacked).
        Assert.True(InStore(saved.CertificateThumbprint));
        var provider = ProviderOf(saved.CertificateThumbprint)!;
        Assert.Equal(saved.IsTpmBacked, provider.Contains("Platform Crypto", StringComparison.OrdinalIgnoreCase));

        // El viejo se ha borrado (certificado, clave y registro).
        Assert.False(InStore(old.Thumbprint));
        var registry = new InstalledCertificateRegistry().List();
        Assert.DoesNotContain(registry, e => e.Thumbprint.Equals(old.Thumbprint, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(registry, e => e.Thumbprint.Equals(saved.CertificateThumbprint, StringComparison.OrdinalIgnoreCase));

        // Las credenciales EAP de la entrada apuntan ahora al certificado nuevo.
        var blobAfter = Convert.ToHexString(credentials.GetStoredBlob(_entry)!);
        Assert.NotEqual(blobBefore, blobAfter);
    }

    public void Dispose()
    {
        if (_entry is not null)
        {
            try { PowerShellRunner.RunScript($"if (Get-VpnConnection -Name '{_entry}' -ErrorAction SilentlyContinue) {{ Remove-VpnConnection -Name '{_entry}' -Force }}"); } catch { }
        }
        if (_cn is not null)
        {
            ConnectionStore.Delete(_cn);
        }
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        foreach (var thumbprint in _thumbprints)
        {
            foreach (var cert in store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false))
            {
                try { (cert.GetECDsaPrivateKey() as ECDsaCng)?.Key.Delete(); } catch { }
                store.Remove(cert);
            }
        }
    }
}
