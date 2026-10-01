using System.Runtime.CompilerServices;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>Arranque del registro de certificados (prompt 12.12, punto 3): se llama al arrancar la app, protegido, y adopta las conexiones existentes.</summary>
[Collection(ConnectionStoreCollection.Name)]
public class CertificateRegistryStartupTests
{
    private sealed class RecordingLifecycle : ICertificateLifecycle
    {
        public List<ConnectionRecord>? Adopted;
        public int AdoptCalls;
        public Exception? ThrowOnAdopt;

        public void AdoptConnectionCertificates(IEnumerable<ConnectionRecord> connections)
        {
            AdoptCalls++;
            if (ThrowOnAdopt is not null) throw ThrowOnAdopt;
            Adopted = connections.ToList();
        }

        public void Register(X509Certificate2 certificate, string device, string server, string connection) => throw new NotSupportedException();
        public bool RemoveWithKey(string thumbprint) => throw new NotSupportedException();
        public IReadOnlyList<string> CleanupStale(string device, string server, X509Certificate2 keep, IReadOnlyCollection<string>? existingConnections) => throw new NotSupportedException();
    }

    private static string TodayLog()
    {
        var file = Path.Combine(AppPaths.LogsDirectory, $"{DateTime.UtcNow:yyyy-MM-dd}.log");
        return File.Exists(file) ? File.ReadAllText(file) : string.Empty;
    }

    [Fact]
    public void AdoptsTheExistingConnectionsOnce()
    {
        var lifecycle = new RecordingLifecycle();
        var connections = new[] { new ConnectionRecord { Cn = "vpn-a" }, new ConnectionRecord { Cn = "vpn-b" } };

        var ok = CertificateRegistryStartup.AdoptExistingConnections(lifecycle, () => connections, new FileLogger());

        Assert.True(ok);
        Assert.Equal(1, lifecycle.AdoptCalls);
        Assert.Equal(new[] { "vpn-a", "vpn-b" }, lifecycle.Adopted!.Select(c => c.Cn));
    }

    [Fact]
    public void IfAdoptingThrows_TheAppStillStarts_AndAWarningIsLogged()
    {
        var lifecycle = new RecordingLifecycle { ThrowOnAdopt = new IOException("fallo simulado del registro") };

        var ok = CertificateRegistryStartup.AdoptExistingConnections(lifecycle, () => Array.Empty<ConnectionRecord>(), new FileLogger());

        Assert.False(ok);                                           // no lanza
        Assert.Contains("fallo simulado del registro", TodayLog());
        Assert.Contains("la app arranca igualmente", TodayLog());
    }

    [Fact]
    public void IfReadingTheConnectionsThrows_TheAppStillStarts()
    {
        var lifecycle = new RecordingLifecycle();

        var ok = CertificateRegistryStartup.AdoptExistingConnections(
            lifecycle, () => throw new UnauthorizedAccessException("sin acceso a las conexiones"), new FileLogger());

        Assert.False(ok);
        Assert.Equal(0, lifecycle.AdoptCalls);
    }

    /// <summary>
    /// Guarda de cableado: TrayApplicationContext (WinForms, no se puede construir en un
    /// test sin lanzar la ventana y las renovaciones) tiene que seguir llamando al
    /// arranque del registro. Si alguien quita la llamada, este test falla.
    /// </summary>
    [Fact]
    public void TheTrayContextCallsTheStartupAdoptionWhenTheAppStarts()
    {
        var testFile = ThisFile();
        var tray = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(testFile)!, "..", "DidevVpn.App", "TrayApplicationContext.cs"));
        var source = File.ReadAllText(tray);

        var constructorStart = source.IndexOf("public TrayApplicationContext()", StringComparison.Ordinal);
        Assert.True(constructorStart > 0, "no se encuentra el constructor de TrayApplicationContext");
        var constructorBody = source[constructorStart..];
        // La llamada esta en el constructor, antes de crear el icono de bandeja.
        var callIndex = constructorBody.IndexOf("CertificateRegistryStartup.AdoptExistingConnections(_lifecycle", StringComparison.Ordinal);
        var notifyIconIndex = constructorBody.IndexOf("new NotifyIcon", StringComparison.Ordinal);
        Assert.True(callIndex > 0, "el constructor de TrayApplicationContext ya no llama a CertificateRegistryStartup.AdoptExistingConnections");
        Assert.True(callIndex < notifyIconIndex, "la adopcion debe hacerse al principio del arranque");
    }

    private static string ThisFile([CallerFilePath] string path = "") => path;
}
