using DidevVpn.App.Services;
using DidevVpn.App.Services.Ras;

namespace DidevVpn.App.Tests;

/// <summary>Maquina de estados de conexion (prompt 12.8, punto 2) con RAS simulado: sin Windows, sin red, sin esperas largas.</summary>
public class ConnectionPhaseTests
{
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(5);

    private static Func<RasPhaseInfo> Script(params RasPhaseInfo[] phases)
    {
        var index = 0;
        return () => phases[Math.Min(index++, phases.Length - 1)];
    }

    [Fact]
    public async Task Waiter_DisconnectedThenConnectingThenConnected_ReturnsConnected()
    {
        var read = Script(
            new RasPhaseInfo(RasPhase.Disconnected),
            new RasPhaseInfo(RasPhase.Connecting),
            new RasPhaseInfo(RasPhase.Connecting),
            new RasPhaseInfo(RasPhase.Connected));

        var result = await ConnectionWaiter.WaitUntilSettledAsync(read, TimeSpan.FromSeconds(5), Poll);

        Assert.Equal(WaitOutcome.Connected, result.Outcome);
    }

    [Fact]
    public async Task Waiter_ErrorCode_ReturnsFailedWithThatCode()
    {
        var read = Script(new RasPhaseInfo(RasPhase.Connecting), new RasPhaseInfo(RasPhase.Failed, 809));

        var result = await ConnectionWaiter.WaitUntilSettledAsync(read, TimeSpan.FromSeconds(5), Poll);

        Assert.Equal(WaitOutcome.Failed, result.Outcome);
        Assert.Equal(809, result.Error);
    }

    [Fact]
    public async Task Waiter_ConnectingThenDisconnectedWithoutError_IsFailed_NotTimeout()
    {
        // Cancelar el dialogo nativo: marcaba y ya no esta.
        var read = Script(new RasPhaseInfo(RasPhase.Connecting), new RasPhaseInfo(RasPhase.Disconnected));

        var result = await ConnectionWaiter.WaitUntilSettledAsync(read, TimeSpan.FromSeconds(5), Poll);

        Assert.Equal(WaitOutcome.Failed, result.Outcome);
        Assert.Equal(0, result.Error);
    }

    [Fact]
    public async Task Waiter_NeverStarts_TimesOutAtTheLimit()
    {
        // rasphone abierto pero la persona no pulsa nada: sigue Disconnected hasta el limite.
        var result = await ConnectionWaiter.WaitUntilSettledAsync(
            () => new RasPhaseInfo(RasPhase.Disconnected), TimeSpan.FromMilliseconds(80), Poll);

        Assert.Equal(WaitOutcome.TimedOut, result.Outcome);
    }

    [Fact]
    public async Task Waiter_Cancellation_Throws()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            ConnectionWaiter.WaitUntilSettledAsync(
                () => new RasPhaseInfo(RasPhase.Connecting), TimeSpan.FromSeconds(5), Poll, cts.Token));
    }

    [Fact]
    public async Task Waiter_DialogOpen_DoesNotCountTowardsTheLimit_UntilItCloses()
    {
        var started = DateTime.UtcNow;
        var dialogOpenFor = TimeSpan.FromMilliseconds(250);
        var connectedAfter = TimeSpan.FromMilliseconds(300);

        var result = await ConnectionWaiter.WaitUntilSettledAsync(
            () => DateTime.UtcNow - started >= connectedAfter
                ? new RasPhaseInfo(RasPhase.Connected)
                : new RasPhaseInfo(RasPhase.Disconnected),
            timeout: TimeSpan.FromMilliseconds(80),
            pollInterval: Poll,
            interactiveDialogOpen: () => DateTime.UtcNow - started < dialogOpenFor,
            maxDialogWait: TimeSpan.FromSeconds(5));

        Assert.Equal(WaitOutcome.Connected, result.Outcome);
    }

    [Fact]
    public async Task Waiter_DialogNeverCloses_StopsAtTheAbsoluteCap()
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();

        var result = await ConnectionWaiter.WaitUntilSettledAsync(
            () => new RasPhaseInfo(RasPhase.Disconnected),
            timeout: TimeSpan.FromMilliseconds(60),
            pollInterval: Poll,
            interactiveDialogOpen: () => true,
            maxDialogWait: TimeSpan.FromMilliseconds(200));

        Assert.Equal(WaitOutcome.TimedOut, result.Outcome);
        Assert.InRange(watch.ElapsedMilliseconds, 200, 2000);
    }

    [Theory]
    [InlineData((int)RasInterop.RasConnState.Connected, 0, (int)RasPhase.Connected, 0)]
    [InlineData((int)RasInterop.RasConnState.Disconnected, 0, (int)RasPhase.Disconnected, 0)]
    [InlineData((int)RasInterop.RasConnState.Authenticate, 0, (int)RasPhase.Connecting, 0)]
    [InlineData((int)RasInterop.RasConnState.ConnectDevice, 0, (int)RasPhase.Connecting, 0)]
    [InlineData((int)RasInterop.RasConnState.InvokeEapUI, 0, (int)RasPhase.Connecting, 0)]
    [InlineData((int)RasInterop.RasConnState.Authenticate, 691, (int)RasPhase.Failed, 691)]
    [InlineData((int)RasInterop.RasConnState.Disconnected, 809, (int)RasPhase.Failed, 809)]
    public void ClassifyStatus_MapsRasStateAndError(int state, int error, int phase, int expectedError)
    {
        var info = RasStateReader.ClassifyStatus((RasInterop.RasConnState)state, error);

        Assert.Equal((RasPhase)phase, info.Phase);
        Assert.Equal(expectedError, info.Error);
    }

    private sealed class FakeNotifier : IConnectionChangeNotifier
    {
        public event Action? Changed;
        public bool Disposed;
        public void Raise() => Changed?.Invoke();
        public void Dispose() => Disposed = true;
    }

    private sealed class FakeVpn : IVpnConnectionService
    {
        public volatile RasPhase Phase = RasPhase.Disconnected;
        public void CreateOrUpdateConnection(VpnConnectionSpec spec) => throw new NotSupportedException();
        public void RemoveConnection(string connectionName) => throw new NotSupportedException();
        public bool ConnectionExists(string connectionName) => true;
        public bool IsConnected(string connectionName) => Phase == RasPhase.Connected;
        public void SaveEapCredentials(string connectionName, System.Security.Cryptography.X509Certificates.X509Certificate2 certificate) => throw new NotSupportedException();
        public void Connect(string connectionName) => throw new NotSupportedException();
        public void Disconnect(string connectionName) => throw new NotSupportedException();
        public RasPhaseInfo GetConnectionPhase(string connectionName) => new(Phase);
        public string? GetAssignedIPv4Address(string connectionName) => Phase == RasPhase.Connected ? "10.0.0.5" : null;
    }

    private static async Task<bool> WaitFor(Func<bool> condition)
    {
        for (var i = 0; i < 100; i++)
        {
            if (condition()) return true;
            await Task.Delay(20);
        }
        return false;
    }

    [Fact]
    public async Task StateService_RasNotification_RefreshesWithoutWaitingForNetworkEventsOrTimer()
    {
        var vpn = new FakeVpn();
        var notifier = new FakeNotifier();
        using var service = new ConnectionStateService(
            vpn, () => new[] { new ConnectionRecord { Cn = "vpn-x", Server = "s" } }, new FileLogger(), notifier);
        await service.RefreshAsync();
        Assert.False(service.GetState("vpn-x").Connected);

        // Alguien conecta desde fuera de la app (rasphone, panel de Windows).
        vpn.Phase = RasPhase.Connected;
        notifier.Raise();

        Assert.True(await WaitFor(() => service.GetState("vpn-x").Connected));
        Assert.Equal("10.0.0.5", service.GetState("vpn-x").Ipv4Address);

        vpn.Phase = RasPhase.Disconnected;
        notifier.Raise();
        Assert.True(await WaitFor(() => !service.GetState("vpn-x").Connected));
    }

    [Fact]
    public async Task StateService_ConnectingPhase_IsExposedAsConnecting()
    {
        var vpn = new FakeVpn { Phase = RasPhase.Connecting };
        using var service = new ConnectionStateService(
            vpn, () => new[] { new ConnectionRecord { Cn = "vpn-x", Server = "s" } }, new FileLogger());

        await service.RefreshAsync();

        var state = service.GetState("vpn-x");
        Assert.True(state.Connecting);
        Assert.False(state.Connected);
    }

    [Fact]
    public void StateService_Dispose_DisposesTheNotifier()
    {
        var notifier = new FakeNotifier();
        var service = new ConnectionStateService(
            new FakeVpn(), () => Array.Empty<ConnectionRecord>(), new FileLogger(), notifier);

        service.Dispose();

        Assert.True(notifier.Disposed);
    }

    /// <summary>Integracion real: RasConnectionNotification acepta el registro sobre todas las conexiones y el monitor se detiene limpio.</summary>
    [Fact]
    public void RasConnectionMonitor_RegistersWithWindowsAndDisposesCleanly()
    {
        var monitor = new RasConnectionMonitor();
        Thread.Sleep(200); // da tiempo a que el hilo registre la notificacion
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        monitor.Dispose();

        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(2), "el monitor deberia pararse casi al instante");
    }
}
