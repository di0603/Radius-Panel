using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Orchestration;
using DidevVpn.App.Services;
using DidevVpn.App.Services.Ras;
using DidevVpn.Core.Profile;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App.Tests;

/// <summary>
/// Orden del alta y de la renovacion (prompt 12.10, punto 3): certificado nuevo
/// instalado -> credenciales EAP / conexion con el nuevo -> comprobar que la
/// entrada existe y queda configurada -> guardar el estado -> SOLO ENTONCES
/// borrar el certificado viejo. Si falla cualquier paso intermedio, el viejo NO
/// se borra. Todo con fakes que registran las llamadas en orden.
/// </summary>
[Collection(ConnectionStoreCollection.Name)]
public sealed class ConfigurationOrderTests : IDisposable
{
    private readonly List<string> _log = new();
    private readonly List<string> _thumbprintsToClean = new();
    private readonly List<string> _connectionsToClean = new();

    // ---------------- fakes ----------------

    private sealed class FakeVpn : IVpnConnectionService
    {
        private readonly List<string> _log;
        public bool ThrowOnConfigure, ThrowOnSaveEap, EntryExists = true, NoSavedCredentials;
        /// <summary>Si no es null, simula credenciales guardadas para OTRO certificado.</summary>
        public string? SavedThumbprintOverride;
        private string? _lastSavedThumbprint;
        public readonly List<string> SavedThumbprints = new();
        public FakeVpn(List<string> log) => _log = log;

        public void CreateOrUpdateConnection(VpnConnectionSpec spec)
        {
            _log.Add("Configure");
            if (ThrowOnConfigure) throw new InvalidOperationException("fallo simulado al configurar");
        }
        public void SaveEapCredentials(string connectionName, X509Certificate2 certificate)
        {
            _log.Add("SaveEap");
            if (ThrowOnSaveEap) throw new InvalidOperationException("fallo simulado al guardar credenciales");
            _lastSavedThumbprint = certificate.Thumbprint;
            SavedThumbprints.Add(certificate.Thumbprint);
        }
        public bool ConnectionExists(string connectionName) { _log.Add("Exists"); return EntryExists; }
        public string? GetSavedEapCertificateThumbprint(string connectionName)
        {
            _log.Add("SavedThumbprint");
            return NoSavedCredentials ? null : SavedThumbprintOverride ?? _lastSavedThumbprint;
        }

        public void RemoveConnection(string connectionName) => throw new NotSupportedException();
        public bool IsConnected(string connectionName) => throw new NotSupportedException();
        public void Connect(string connectionName) => throw new NotSupportedException();
        public void Disconnect(string connectionName) => throw new NotSupportedException();
        public RasPhaseInfo GetConnectionPhase(string connectionName) => throw new NotSupportedException();
        public string? GetAssignedIPv4Address(string connectionName) => throw new NotSupportedException();
    }

    private sealed class FakeLifecycle : ICertificateLifecycle
    {
        private readonly List<string> _log;
        public string? StateThumbprintAtRemoval, StateThumbprintAtRegister;
        public bool RecordSavedAtRegister;
        public bool ThrowOnRegister, ThrowOnRemoveWithKey;
        public string CnToWatch = "";
        public FakeLifecycle(List<string> log) => _log = log;

        public void Register(X509Certificate2 certificate, string device, string server, string connection)
        {
            _log.Add("Register");
            if (ThrowOnRegister) throw new IOException("fallo simulado al registrar el certificado");
            var state = ConnectionStore.Load(CnToWatch);
            RecordSavedAtRegister = state is not null;
            StateThumbprintAtRegister = state?.CertificateThumbprint;
        }
        public bool RemoveWithKey(string thumbprint)
        {
            _log.Add($"RemoveWithKey:{thumbprint}");
            if (ThrowOnRemoveWithKey) throw new IOException("fallo simulado al borrar el certificado");
            StateThumbprintAtRemoval = ConnectionStore.Load(CnToWatch)?.CertificateThumbprint;
            return true;
        }
        public IReadOnlyList<string> CleanupStale(string device, string server, X509Certificate2 keep, IReadOnlyCollection<string>? existingConnections)
        {
            _log.Add("CleanupStale");
            return Array.Empty<string>();
        }
        public void AdoptConnectionCertificates(IEnumerable<ConnectionRecord> connections) { }
    }

    private sealed class FakeCertService : ICertificateEnrollmentService
    {
        private readonly List<string> _log;
        public required X509Certificate2 NewCertificate { get; init; }
        public FakeCertService(List<string> log) => _log = log;

        public Task<InstalledCertificateResult> EnrollAsync(string cn, Func<string, bool> confirmSoftwareKeyFallback,
            Func<byte[], CancellationToken, Task<EstEnrollResult>> requestCertificate, CancellationToken ct)
        {
            _log.Add("InstallNewCertificate");
            return Task.FromResult(new InstalledCertificateResult(NewCertificate, IsTpmBacked: false));
        }
        public void RemoveCertificate(X509Certificate2 certificate) => _log.Add("RemoveInstalledCertificate");
    }

    private sealed class FakeEst : IEstClient
    {
        public Task<EstEnrollResult> SimpleEnrollAsync(Uri estBaseUrl, string username, string enrollToken, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct) => throw new NotSupportedException();
        public Task<EstEnrollResult> SimpleReenrollAsync(Uri estBaseUrl, X509Certificate2 clientCertificate, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct) => throw new NotSupportedException();
        public Task<EstStatus> GetStatusAsync(Uri estBaseUrl, X509Certificate2 clientCertificate, X509Certificate2Collection trustedChain, CancellationToken ct) =>
            Task.FromResult(new EstStatus("x", DateTimeOffset.UtcNow.AddDays(10), RenewDue: true, MinAppVersion: "0.0.0"));
    }

    private sealed class YesToAll : IUserConfirmations
    {
        public bool ConfirmSoftwareKeyFallback(string reason) => true;
        public bool ConfirmRootCertificateElevation() => true;
        public bool ConfirmTrustAnchor(string server, string cn, FormattedFingerprint panelFingerprint, FormattedFingerprint rootFingerprint) => true;
    }

    private sealed class RootAlreadyTrusted : IRootCertificateStoreService
    {
        public bool IsInstalled(StoreLocation location, string sha256ThumbprintHex) => true;
        public void Install(StoreLocation location, X509Certificate2 rootCertificate) => throw new NotSupportedException();
    }

    // ---------------- ayudas ----------------

    private static X509Certificate2 SelfSigned(string cn, bool ca = false)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={cn}", key, HashAlgorithmName.SHA256);
        if (ca) request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        var now = DateTimeOffset.UtcNow;
        using var created = request.CreateSelfSigned(now.AddDays(-1), now.AddDays(30));
        return new X509Certificate2(created.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.Exportable);
    }

    /// <summary>Instala en el almacen real un certificado "viejo" con clave persistida (RenewalOrchestrator lo busca ahi por huella).</summary>
    private X509Certificate2 InstallOldCertificate(string cn)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={cn}", key, HashAlgorithmName.SHA256);
        var now = DateTimeOffset.UtcNow;
        using var created = request.CreateSelfSigned(now.AddDays(-25), now.AddDays(5));
        using var imported = new X509Certificate2(created.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.PersistKeySet);
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        store.Add(imported);
        _thumbprintsToClean.Add(imported.Thumbprint);
        return new X509Certificate2(imported.RawData);
    }

    // ---------------- renovacion ----------------

    private (RenewalOrchestrator Orchestrator, ConnectionRecord State, FakeVpn Vpn, FakeLifecycle Lifecycle, X509Certificate2 Old, X509Certificate2 New) SetUpRenewal()
    {
        var cn = $"vpn-order-r-{Guid.NewGuid().ToString("N")[..6]}";
        _connectionsToClean.Add(cn);
        var old = InstallOldCertificate(cn);
        using var ca = SelfSigned("ca-order", ca: true);
        var state = new ConnectionRecord
        {
            Cn = cn, Server = "srv-renew.example.org", EstBaseUrl = "https://pki.example.invalid:8443/.well-known/est",
            CaChainPem = ca.ExportCertificatePem(), CertificateThumbprint = old.Thumbprint, LastEnrolledAtUtc = DateTimeOffset.UtcNow.AddDays(-25),
        };
        ConnectionStore.Save(state);
        var newCert = SelfSigned(cn);
        var vpn = new FakeVpn(_log);
        var lifecycle = new FakeLifecycle(_log) { CnToWatch = cn };
        var orchestrator = new RenewalOrchestrator(
            new FakeCertService(_log) { NewCertificate = newCert }, new FakeEst(), vpn, new YesToAll(), new FileLogger(),
            new AppVersion(0, 1, 11), lifecycle);
        return (orchestrator, state, vpn, lifecycle, old, newCert);
    }

    [Fact]
    public async Task Renewal_Order_InstallNew_ThenEap_ThenCheckEntry_ThenSaveState_AndOnlyThenDeleteTheOldOne()
    {
        var (orchestrator, state, _, lifecycle, old, newCert) = SetUpRenewal();
        var newThumbprint = newCert.Thumbprint; // el orquestador libera el certificado al terminar

        var result = await orchestrator.RenewIfDueAsync(state, CancellationToken.None);

        Assert.Equal(RenewalOutcome.Renewed, result.Outcome);
        Assert.Equal(
            new[] { "InstallNewCertificate", "SaveEap", "Exists", "SavedThumbprint", "Register", $"RemoveWithKey:{old.Thumbprint}", "CleanupStale" },
            _log);
        // Cuando se borra el viejo, el estado de la conexion YA apunta al nuevo.
        Assert.Equal(newThumbprint, lifecycle.StateThumbprintAtRemoval);
    }

    [Theory]
    [InlineData("SaveEap")]
    [InlineData("EntryMissing")]
    [InlineData("EapCredentialsMissing")]
    [InlineData("EapCredentialsOfAnotherCertificate")]
    public async Task Renewal_AnyIntermediateStepFails_TheOldCertificateIsNotDeleted_AndTheStateIsNotChanged(string failure)
    {
        var (orchestrator, state, vpn, _, old, _) = SetUpRenewal();
        vpn.ThrowOnSaveEap = failure == "SaveEap";
        vpn.EntryExists = failure != "EntryMissing";
        vpn.NoSavedCredentials = failure == "EapCredentialsMissing";
        vpn.SavedThumbprintOverride = failure == "EapCredentialsOfAnotherCertificate" ? "ABCDEF0123456789ABCDEF0123456789ABCDEF01" : null;

        await Assert.ThrowsAsync<InvalidOperationException>(() => orchestrator.RenewIfDueAsync(state, CancellationToken.None));

        // El rollback borra el certificado NUEVO (ver mas abajo); nunca el viejo ni la limpieza.
        Assert.DoesNotContain(_log, e => e == $"RemoveWithKey:{old.Thumbprint}" || e == "CleanupStale" || e == "Register");
        Assert.Equal(old.Thumbprint, ConnectionStore.Load(state.Cn)!.CertificateThumbprint, ignoreCase: true);
    }

    // ---------------- alta ----------------

    private (EnrollmentOrchestrator Orchestrator, ProvisioningProfile Profile, FakeVpn Vpn, FakeLifecycle Lifecycle, X509Certificate2 NewCertificate) SetUpEnrollment(bool withReusableCertificate = false)
    {
        var cn = $"vpn-order-e-{Guid.NewGuid().ToString("N")[..6]}";
        _connectionsToClean.Add(cn);
        using var root = SelfSigned("root-order", ca: true);
        if (withReusableCertificate)
        {
            // Un certificado valido de ESTE dispositivo, firmado por la raiz del perfil y con su clave en el almacen:
            // el alta lo REUTILIZA (no pide otro a EST ni instala nada).
            using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var request = new CertificateRequest($"CN={cn}", leafKey, HashAlgorithmName.SHA256);
            var now = DateTimeOffset.UtcNow;
            using var signed = request.Create(root, now.AddDays(-1), now.AddDays(10), RandomNumberGenerator.GetBytes(8).Select((b, i) => i == 0 ? (byte)(b & 0x7F) : b).ToArray());
            using var withKey = signed.CopyWithPrivateKey(leafKey);
            using var imported = new X509Certificate2(withKey.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.PersistKeySet);
            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadWrite);
            store.Add(imported);
            _thumbprintsToClean.Add(imported.Thumbprint);
        }
        var profile = new ProvisioningProfile
        {
            Version = 1, Variant = ProfileVariant.Full, Cn = cn, Server = $"srv-{cn}.example.org", AaaId = "CN=radius.test.invalid",
            RootCaSha256 = RootCertificateStoreService.ComputeSha256Thumbprint(root),
            SignerKeySha256 = new string('a', 64), CaChainPem = root.ExportCertificatePem(),
            Ike = new IkeProposal { Encryption = "aes256gcm16", Prf = "sha384", DhGroup = "ecp384" },
            Esp = new EspProposal { Encryption = "aes256gcm16", DhGroup = "ecp384" },
            TunnelMode = DidevVpn.Core.Profile.TunnelMode.Full, SplitRoutes = new List<string>(),
            EstBaseUrl = "https://pki.example.invalid:8443/.well-known/est", EnrollToken = "no-es-un-token-real",
            IssuedAt = DateTimeOffset.UtcNow, ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        };
        var vpn = new FakeVpn(_log);
        var lifecycle = new FakeLifecycle(_log) { CnToWatch = cn };
        var newCertificate = SelfSigned(cn);
        var orchestrator = new EnrollmentOrchestrator(
            new FakeCertService(_log) { NewCertificate = newCertificate }, new FakeEst(), vpn, new RootAlreadyTrusted(), new YesToAll(),
            new FileLogger(), new AppVersion(0, 1, 11), lifecycle);
        return (orchestrator, profile, vpn, lifecycle, newCertificate);
    }

    [Fact]
    public async Task Enrollment_Order_InstallNew_ThenConfigure_ThenEap_ThenCheckEntry_ThenSaveState_AndOnlyThenCleanUpTheOldOnes()
    {
        var (orchestrator, profile, _, lifecycle, _) = SetUpEnrollment();

        var record = await orchestrator.EnrollAsync(profile, CancellationToken.None);

        Assert.Equal(profile.Cn, record.Cn);
        Assert.Equal(
            new[] { "InstallNewCertificate", "Configure", "SaveEap", "Exists", "SavedThumbprint", "Register", "CleanupStale" },
            _log);
        // Al registrar y limpiar, el estado de la conexion YA esta guardado con el certificado nuevo.
        Assert.True(lifecycle.RecordSavedAtRegister);
        Assert.Equal(record.CertificateThumbprint, lifecycle.StateThumbprintAtRegister);
    }

    [Theory]
    [InlineData("Configure")]
    [InlineData("SaveEap")]
    [InlineData("EntryMissing")]
    [InlineData("EapCredentialsMissing")]
    [InlineData("EapCredentialsOfAnotherCertificate")]
    public async Task Enrollment_AnyIntermediateStepFails_NothingIsCleanedUp_AndTheConnectionStateIsNotSaved(string failure)
    {
        var (orchestrator, profile, vpn, _, _) = SetUpEnrollment();
        vpn.ThrowOnConfigure = failure == "Configure";
        vpn.ThrowOnSaveEap = failure == "SaveEap";
        vpn.EntryExists = failure != "EntryMissing";
        vpn.NoSavedCredentials = failure == "EapCredentialsMissing";
        vpn.SavedThumbprintOverride = failure == "EapCredentialsOfAnotherCertificate" ? "ABCDEF0123456789ABCDEF0123456789ABCDEF01" : null;

        await Assert.ThrowsAsync<InvalidOperationException>(() => orchestrator.EnrollAsync(profile, CancellationToken.None));

        Assert.DoesNotContain(_log, e => e == "Register" || e == "CleanupStale");
        Assert.Null(ConnectionStore.Load(profile.Cn));
    }

    // ---------------- rollback del certificado NUEVO (prompt 12.12, punto 1) ----------------

    private static string StateFile(string cn) => Path.Combine(AppPaths.ConnectionsDirectory, $"{cn}.json");

    private static string TodayLog()
    {
        var file = Path.Combine(AppPaths.LogsDirectory, $"{DateTime.UtcNow:yyyy-MM-dd}.log");
        return File.Exists(file) ? File.ReadAllText(file) : string.Empty;
    }

    /// <summary>Provoca el fallo pedido. "StateSaveFails" deja el fichero de estado de solo lectura para que ConnectionStore.Save lance.</summary>
    private static void ApplyFailure(string failure, FakeVpn vpn, FakeLifecycle lifecycle, string cn)
    {
        vpn.ThrowOnConfigure = failure == "Configure";
        vpn.ThrowOnSaveEap = failure == "SaveEap";
        vpn.EntryExists = failure != "EntryMissing";
        vpn.NoSavedCredentials = failure == "EapCredentialsMissing";
        vpn.SavedThumbprintOverride = failure == "EapCredentialsOfAnotherCertificate" ? "ABCDEF0123456789ABCDEF0123456789ABCDEF01" : null;
        lifecycle.ThrowOnRegister = failure == "RegisterFails";
        if (failure == "StateSaveFails")
        {
            Directory.CreateDirectory(AppPaths.ConnectionsDirectory);
            if (!File.Exists(StateFile(cn))) File.WriteAllText(StateFile(cn), "{}");
            File.SetAttributes(StateFile(cn), FileAttributes.ReadOnly);
        }
    }

    [Theory]
    [InlineData("SaveEap")]
    [InlineData("EntryMissing")]
    [InlineData("EapCredentialsMissing")]
    [InlineData("EapCredentialsOfAnotherCertificate")]
    [InlineData("RegisterFails")]
    [InlineData("StateSaveFails")]
    public async Task Renewal_AnyStepAfterInstallingFails_TheNewCertificateIsRemovedWithItsKey_AndTheOldOneAndTheStateAreIntact(string failure)
    {
        var (orchestrator, state, vpn, lifecycle, old, newCert) = SetUpRenewal();
        var newThumbprint = newCert.Thumbprint;
        ApplyFailure(failure, vpn, lifecycle, state.Cn);

        await Assert.ThrowsAnyAsync<Exception>(() => orchestrator.RenewIfDueAsync(state, CancellationToken.None));

        Assert.Single(_log, e => e == $"RemoveWithKey:{newThumbprint}");   // el NUEVO se borra (certificado + clave)
        Assert.DoesNotContain(_log, e => e == $"RemoveWithKey:{old.Thumbprint}");
        Assert.DoesNotContain("CleanupStale", _log);
        Assert.Equal(old.Thumbprint, state.CertificateThumbprint, ignoreCase: true);   // el objeto en memoria vuelve al viejo
        File.SetAttributes(StateFile(state.Cn), FileAttributes.Normal);
        Assert.Equal(old.Thumbprint, ConnectionStore.Load(state.Cn)!.CertificateThumbprint, ignoreCase: true);   // y el fichero sigue con el viejo
        Assert.Contains("Se deshace", TodayLog());
    }

    [Fact]
    public async Task Renewal_RollbackGivesTheEapCredentialsBackToTheOldCertificate()
    {
        var (orchestrator, state, vpn, lifecycle, old, newCert) = SetUpRenewal();
        var newThumbprint = newCert.Thumbprint;
        ApplyFailure("StateSaveFails", vpn, lifecycle, state.Cn);

        await Assert.ThrowsAnyAsync<Exception>(() => orchestrator.RenewIfDueAsync(state, CancellationToken.None));

        // Primero se apunto al nuevo; el rollback las devuelve al viejo ANTES de borrar el nuevo.
        Assert.Equal(new[] { newThumbprint, old.Thumbprint }, vpn.SavedThumbprints);
        var restoreIndex = _log.LastIndexOf("SaveEap");
        Assert.True(restoreIndex < _log.IndexOf($"RemoveWithKey:{newThumbprint}"));
        File.SetAttributes(StateFile(state.Cn), FileAttributes.Normal);
    }

    [Fact]
    public async Task Renewal_IfTheRollbackItselfFails_ItIsLogged_AndTheOriginalExceptionIsNotHidden()
    {
        var (orchestrator, state, vpn, lifecycle, _, _) = SetUpRenewal();
        vpn.ThrowOnSaveEap = true;                 // fallo original
        lifecycle.ThrowOnRemoveWithKey = true;     // y el rollback tambien falla

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => orchestrator.RenewIfDueAsync(state, CancellationToken.None));

        Assert.Equal("fallo simulado al guardar credenciales", ex.Message);   // la ORIGINAL, no la del rollback
        Assert.Contains("el rollback ha fallado", TodayLog());
    }

    [Theory]
    [InlineData("Configure")]
    [InlineData("SaveEap")]
    [InlineData("EntryMissing")]
    [InlineData("EapCredentialsMissing")]
    [InlineData("EapCredentialsOfAnotherCertificate")]
    [InlineData("StateSaveFails")]
    public async Task Enrollment_AnyStepAfterInstallingFails_TheNewCertificateIsRemovedWithItsKey_AndNothingIsCleanedUp(string failure)
    {
        var (orchestrator, profile, vpn, lifecycle, newCert) = SetUpEnrollment();
        var newThumbprint = newCert.Thumbprint;
        ApplyFailure(failure, vpn, lifecycle, profile.Cn);

        await Assert.ThrowsAnyAsync<Exception>(() => orchestrator.EnrollAsync(profile, CancellationToken.None));

        Assert.Single(_log, e => e == $"RemoveWithKey:{newThumbprint}");
        Assert.DoesNotContain(_log, e => e == "Register" || e == "CleanupStale");
        if (failure == "StateSaveFails") File.SetAttributes(StateFile(profile.Cn), FileAttributes.Normal);
        Assert.True(string.IsNullOrEmpty(ConnectionStore.Load(profile.Cn)?.CertificateThumbprint));   // el estado no se guardo con el nuevo
        Assert.Contains("Se deshace", TodayLog());
    }

    [Fact]
    public async Task Enrollment_IfTheRollbackItselfFails_ItIsLogged_AndTheOriginalExceptionIsNotHidden()
    {
        var (orchestrator, profile, vpn, lifecycle, _) = SetUpEnrollment();
        vpn.ThrowOnSaveEap = true;
        lifecycle.ThrowOnRemoveWithKey = true;

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => orchestrator.EnrollAsync(profile, CancellationToken.None));

        Assert.Equal("fallo simulado al guardar credenciales", ex.Message);
        Assert.Contains("el rollback ha fallado", TodayLog());
    }

    [Fact]
    public async Task Enrollment_AReusedCertificateIsNeverRolledBack_ItWasThereBeforeThisRun()
    {
        var (orchestrator, profile, vpn, _, _) = SetUpEnrollment(withReusableCertificate: true);
        vpn.ThrowOnSaveEap = true;

        await Assert.ThrowsAsync<InvalidOperationException>(() => orchestrator.EnrollAsync(profile, CancellationToken.None));

        Assert.DoesNotContain("InstallNewCertificate", _log);                   // se reutilizo: no se instalo nada
        Assert.DoesNotContain(_log, e => e.StartsWith("RemoveWithKey"));         // y por tanto no se deshace
        Assert.Contains("se reutiliza el certificado ya instalado", TodayLog());
    }

    public void Dispose()
    {
        foreach (var cn in _connectionsToClean)
        {
            try { if (File.Exists(StateFile(cn))) File.SetAttributes(StateFile(cn), FileAttributes.Normal); } catch { }
        }
        foreach (var cn in _connectionsToClean) ConnectionStore.Delete(cn);
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        foreach (var thumbprint in _thumbprintsToClean)
        {
            foreach (var cert in store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false))
            {
                try { (cert.GetECDsaPrivateKey() as ECDsaCng)?.Key.Delete(); } catch { }
                store.Remove(cert);
            }
        }
    }
}
