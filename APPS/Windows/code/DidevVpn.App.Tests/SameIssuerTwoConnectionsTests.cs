using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;
using Xunit.Abstractions;

namespace DidevVpn.App.Tests;

/// <summary>
/// Experimento REAL (prompt 12.9, punto 6): dos entradas de la agenda RAS con
/// el MISMO emisor y dos certificados de cliente clientAuth de ese emisor en
/// CurrentUser\My. ?Las credenciales EAP guardadas (RasSetEapUserData con el
/// certificado) bastan para que rasdial NO abra el selector (error 703)?
/// rasdial resuelve la identidad EAP ANTES de contactar con el servidor, asi
/// que un servidor inalcanzable (192.0.2.1, TEST-NET) basta para distinguir:
/// 703 en segundos = necesita dialogo; cualquier otra cosa (o seguir
/// intentando) = la identidad ya estaba resuelta. Todo lo que crea lo borra.
///
/// REQUIERE ADMINISTRADOR: Windows solo ofrece como candidatos a EAP-TLS los
/// certificados cuya cadena llega a una raiz de confianza (sin ella, rasdial
/// devuelve 798 "no se encuentra un certificado que se pueda usar"), asi que
/// el test instala su CA de prueba en LocalMachine\Root y la quita al
/// terminar. Sin elevar no puede hacerlo (y no se salta el aviso de seguridad
/// de Windows con trucos de registro): en ese caso no hace nada. Ejecutalo
/// desde una consola de administrador:
///   dotnet test DidevVpn.App.Tests --filter SameIssuerTwoConnectionsTests
/// </summary>
public sealed class SameIssuerTwoConnectionsTests : IDisposable
{
    private readonly ITestOutputHelper _output;
    private readonly List<string> _thumbprints = new();
    private readonly List<string> _entries = new();
    private string? _rootThumbprint;

    private static bool TryOpenRootStoreForWrite(out X509Store store)
    {
        store = new X509Store(StoreName.Root, StoreLocation.LocalMachine);
        try
        {
            store.Open(OpenFlags.ReadWrite);
            return true;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    public SameIssuerTwoConnectionsTests(ITestOutputHelper output) => _output = output;

    private (string Output, int ExitCode, bool KilledByTimeout, TimeSpan Elapsed) RasDial(string entry, TimeSpan timeout)
    {
        var info = new ProcessStartInfo("rasdial.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(entry);
        var watch = Stopwatch.StartNew();
        using var process = Process.Start(info)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var killed = false;
        if (!process.WaitForExit(timeout))
        {
            killed = true;
            process.Kill(true);
            process.WaitForExit();
        }
        return (stdout.GetAwaiter().GetResult(), killed ? -1 : process.ExitCode, killed, watch.Elapsed);
    }

    private X509Certificate2 InstallClientCert(X509Certificate2 ca, ECDsa caKey, string cn)
    {
        using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={cn}", leafKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.2") }, true));
        var now = DateTimeOffset.UtcNow;
        using var signed = request.Create(ca.SubjectName, X509SignatureGenerator.CreateForECDsa(caKey), now.AddMinutes(-5), now.AddDays(1), RandomNumberGenerator.GetBytes(12));
        using var withKey = signed.CopyWithPrivateKey(leafKey);
        using var imported = new X509Certificate2(withKey.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.PersistKeySet);
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        store.Add(imported);
        _thumbprints.Add(imported.Thumbprint);
        return new X509Certificate2(imported.RawData);
    }

    private VpnConnectionSpec Spec(string entry, string caThumbprint) => new(
        ConnectionName: entry,
        ServerAddress: "192.0.2.1",
        EapServerName: "radius.test.invalid",
        RootCertificateThumbprintSha1: caThumbprint,
        ClientCertificateIssuerThumbprintSha1: caThumbprint,
        SplitTunneling: false,
        SplitRoutes: Array.Empty<string>(),
        IkeEncryption: "GCMAES256",
        IkeIntegrity: "SHA384",
        IkeDhGroup: "ECP384",
        EspEncryption: "GCMAES256",
        EspPfsGroup: "ECP384");

    [Fact]
    public void SavedEapCredentials_PickTheRightCertificate_WithoutTheSelectionDialog_EvenWithTwoSameIssuerCandidates()
    {
        using var caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var caRequest = new CertificateRequest($"CN=didev-test-ca-{Guid.NewGuid():N}", caKey, HashAlgorithmName.SHA256);
        caRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        var now = DateTimeOffset.UtcNow;
        using var ca = caRequest.CreateSelfSigned(now.AddMinutes(-10), now.AddDays(2));

        if (!TryOpenRootStoreForWrite(out var rootStore))
        {
            _output.WriteLine("OMITIDO: hace falta una consola de administrador (instala la CA de prueba en LocalMachine\\Root).");
            return;
        }
        using (rootStore)
        {
            rootStore.Add(new X509Certificate2(ca.RawData));
            _rootThumbprint = ca.Thumbprint;
        }

        var certA = InstallClientCert(ca, caKey, "didev-tt-a");
        var certB = InstallClientCert(ca, caKey, "didev-tt-b");
        Assert.Equal(certA.Issuer, certB.Issuer);

        var suffix = Guid.NewGuid().ToString("N")[..6];
        var entryA = $"didev-tt-a-{suffix}";
        var entryB = $"didev-tt-b-{suffix}";
        var vpn = new VpnConnectionService();
        _entries.Add(entryA);
        _entries.Add(entryB);
        vpn.CreateOrUpdateConnection(Spec(entryA, ca.Thumbprint));
        vpn.CreateOrUpdateConnection(Spec(entryB, ca.Thumbprint));

        // CONTROL: sin credenciales guardadas y con DOS candidatos, Windows necesita el selector.
        var control = RasDial(entryA, TimeSpan.FromSeconds(25));
        _output.WriteLine($"CONTROL sin credenciales: exit={control.ExitCode} killed={control.KilledByTimeout} t={control.Elapsed.TotalSeconds:0.0}s :: {control.Output.Trim().Replace("\r\n", " | ")}");
        Assert.Equal(703, control.ExitCode);

        // Con credenciales guardadas (cada entrada -> su certificado).
        vpn.SaveEapCredentials(entryA, certA);
        vpn.SaveEapCredentials(entryB, certB);
        var store = new Services.Ras.EapUserCredentialStore();
        Assert.NotEqual(Convert.ToHexString(store.GetStoredBlob(entryA)!), Convert.ToHexString(store.GetStoredBlob(entryB)!));

        var withCredsA = RasDial(entryA, TimeSpan.FromSeconds(25));
        _output.WriteLine($"A con credenciales: exit={withCredsA.ExitCode} killed={withCredsA.KilledByTimeout} t={withCredsA.Elapsed.TotalSeconds:0.0}s :: {withCredsA.Output.Trim().Replace("\r\n", " | ")}");
        var withCredsB = RasDial(entryB, TimeSpan.FromSeconds(25));
        _output.WriteLine($"B con credenciales: exit={withCredsB.ExitCode} killed={withCredsB.KilledByTimeout} t={withCredsB.Elapsed.TotalSeconds:0.0}s :: {withCredsB.Output.Trim().Replace("\r\n", " | ")}");

        Assert.NotEqual(703, withCredsA.ExitCode);
        Assert.NotEqual(703, withCredsB.ExitCode);
    }

    public void Dispose()
    {
        if (_rootThumbprint is not null && TryOpenRootStoreForWrite(out var rootStore))
        {
            using (rootStore)
            {
                foreach (var cert in rootStore.Certificates.Find(X509FindType.FindByThumbprint, _rootThumbprint, validOnly: false))
                {
                    rootStore.Remove(cert);
                }
            }
        }
        foreach (var entry in _entries)
        {
            try { Process.Start(new ProcessStartInfo("rasdial.exe", $"\"{entry}\" /disconnect") { CreateNoWindow = true, UseShellExecute = false })?.WaitForExit(5000); } catch { }
            try { PowerShellRunner.RunScript($"if (Get-VpnConnection -Name '{entry}' -ErrorAction SilentlyContinue) {{ Remove-VpnConnection -Name '{entry}' -Force }}"); } catch { }
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
