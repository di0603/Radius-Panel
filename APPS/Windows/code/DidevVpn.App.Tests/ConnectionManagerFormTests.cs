using DidevVpn.App.Services;
using DidevVpn.App.UI;
using DidevVpn.Core.Net;

namespace DidevVpn.App.Tests;

public class ConnectionManagerFormTests
{
    private sealed class FakeCollector : IConnectionDetailsCollector
    {
        public int Calls;

        public ConnectionDetails Collect(ConnectionRecord record, ConnectionRuntimeState state)
        {
            Interlocked.Increment(ref Calls);
            return new ConnectionDetails(
                record.Cn, "Conectado", DateTimeOffset.Now.AddMinutes(-3), TimeSpan.FromMinutes(3), record.Server, "203.0.113.7",
                "192.168.10.80", "255.255.255.255", true, null, new[] { "8.8.8.8" }, true, Array.Empty<string>(), 1400,
                2048, 4096, 100, 200, null);
        }

        public void Forget(string connectionName)
        {
        }
    }

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception ex) { failure = ex; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null)
        {
            throw new Xunit.Sdk.XunitException($"El formulario lanzo: {failure}");
        }
    }

    /// <summary>
    /// El formulario se construye y refresca con una conexion conectada (el
    /// panel de detalles con sus filas AutoSize, el boton "Copiar detalles" y
    /// el temporizador) sin lanzar. Sin mostrarse: el sondeo no arranca con la
    /// ventana oculta, y ese es justo el comportamiento pedido.
    /// </summary>
    [Fact]
    public void Form_BuildsAndRefreshes_AndDoesNotPollWhileHidden()
    {
        var collector = new FakeCollector();
        RunOnSta(() =>
        {
            var record = new ConnectionRecord { Cn = "vpn-test", Server = "vpn.example.org", TunnelMode = "full" };
            using var form = new ConnectionManagerForm(
                () => new[] { record },
                _ => new ConnectionRuntimeState(true, "192.168.10.80"),
                () => { },
                (_, _) => { },
                _ => { },
                _ => { },
                _ => false,
                collector);

            form.RefreshConnections();
            Thread.Sleep(300);

            Assert.Equal(0, collector.Calls); // oculta: nadie pide detalles
        });
    }
}
