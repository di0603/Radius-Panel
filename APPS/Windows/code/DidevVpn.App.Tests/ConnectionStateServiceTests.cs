using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

public class ConnectionStateServiceTests
{
    private sealed class FakeVpnConnectionService : IVpnConnectionService
    {
        public readonly Dictionary<string, (bool Exists, bool Connected, string? Ip)> States =
            new(StringComparer.OrdinalIgnoreCase);
        public readonly HashSet<string> ThrowingConnections = new(StringComparer.OrdinalIgnoreCase);
        public int ConnectionExistsCalls;

        public void CreateOrUpdateConnection(VpnConnectionSpec spec) => throw new NotSupportedException();
        public void RemoveConnection(string connectionName) => throw new NotSupportedException();
        public void SaveEapCredentials(string connectionName, System.Security.Cryptography.X509Certificates.X509Certificate2 certificate) => throw new NotSupportedException();
        public void Connect(string connectionName) => throw new NotSupportedException();
        public void Disconnect(string connectionName) => throw new NotSupportedException();

        public bool ConnectionExists(string connectionName)
        {
            Interlocked.Increment(ref ConnectionExistsCalls);
            if (ThrowingConnections.Contains(connectionName))
            {
                throw new InvalidOperationException("fallo simulado");
            }
            return States.TryGetValue(connectionName, out var s) && s.Exists;
        }

        public Services.Ras.RasPhaseInfo GetConnectionPhase(string connectionName) =>
            States.TryGetValue(connectionName, out var s) && s.Connected
                ? new Services.Ras.RasPhaseInfo(Services.Ras.RasPhase.Connected)
                : new Services.Ras.RasPhaseInfo(Services.Ras.RasPhase.Disconnected);

        public bool IsConnected(string connectionName) =>
            States.TryGetValue(connectionName, out var s) && s.Connected;

        public string? GetAssignedIPv4Address(string connectionName) =>
            States.TryGetValue(connectionName, out var s) ? s.Ip : null;
    }

    private static ConnectionRecord MakeConnection(string cn) => new() { Cn = cn, Server = "vpn.example.com" };

    [Fact]
    public async Task RefreshAsync_ActualizaElCacheParaCadaConexion()
    {
        var vpn = new FakeVpnConnectionService();
        vpn.States["vpn-a"] = (Exists: true, Connected: true, Ip: "192.168.10.80");
        vpn.States["vpn-b"] = (Exists: true, Connected: false, Ip: null);

        using var service = new ConnectionStateService(
            vpn, () => new[] { MakeConnection("vpn-a"), MakeConnection("vpn-b") }, new FileLogger());

        await service.RefreshAsync();

        var a = service.GetState("vpn-a");
        Assert.True(a.Connected);
        Assert.Equal("192.168.10.80", a.Ipv4Address);

        var b = service.GetState("vpn-b");
        Assert.False(b.Connected);
        Assert.Null(b.Ipv4Address);
    }

    [Fact]
    public void GetState_ConexionSinRefrescarTodavia_DevuelveElValorPorDefecto()
    {
        var vpn = new FakeVpnConnectionService();
        using var service = new ConnectionStateService(vpn, () => Array.Empty<ConnectionRecord>(), new FileLogger());

        var state = service.GetState("nunca-refrescada");

        Assert.False(state.Connected);
        Assert.Null(state.Ipv4Address);
    }

    [Fact]
    public async Task RefreshAsync_UnaConexionQueLanza_NoImpideActualizarLasDemas()
    {
        var vpn = new FakeVpnConnectionService();
        vpn.States["vpn-ok"] = (Exists: true, Connected: true, Ip: "192.168.10.81");
        vpn.ThrowingConnections.Add("vpn-rota");

        using var service = new ConnectionStateService(
            vpn, () => new[] { MakeConnection("vpn-ok"), MakeConnection("vpn-rota") }, new FileLogger());

        await service.RefreshAsync();

        Assert.True(service.GetState("vpn-ok").Connected);
        Assert.False(service.GetState("vpn-rota").Connected); // se degrada a "desconectado", no lanza
    }

    [Fact]
    public async Task RequestRefresh_VariasVecesSeguidas_SoloRefrescaUnaVez()
    {
        var vpn = new FakeVpnConnectionService();
        vpn.States["vpn-a"] = (Exists: true, Connected: true, Ip: "192.168.10.82");

        using var service = new ConnectionStateService(vpn, () => new[] { MakeConnection("vpn-a") }, new FileLogger());

        for (var i = 0; i < 5; i++)
        {
            service.RequestRefresh();
            await Task.Delay(20); // mucho menos que la ventana de debounce (500ms): misma racha
        }

        // Espera a que la racha termine y el refresco debounced se ejecute.
        await Task.Delay(1200);

        Assert.True(service.GetState("vpn-a").Connected);
        // Un solo refresco de verdad para la racha completa: 1 llamada a
        // ConnectionExists (no 5), mas como mucho la del RefreshAsync inicial si
        // se hubiera llamado a mano (aqui no se ha llamado).
        Assert.Equal(1, vpn.ConnectionExistsCalls);
    }
}
