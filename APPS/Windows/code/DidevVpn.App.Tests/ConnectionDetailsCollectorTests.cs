using System.Net.NetworkInformation;
using System.Net.Sockets;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

public class ConnectionDetailsCollectorTests
{
    /// <summary>
    /// Integracion real con Windows sin necesitar una VPN activa: la entrada
    /// de la agenda y el adaptador se llaman igual, asi que se usa un
    /// adaptador de red real y levantado del equipo como si fuera el de la
    /// VPN. Comprueba que las APIs nativas (NetworkInterface, tabla de rutas,
    /// DNS) devuelven datos coherentes sin lanzar y sin PowerShell.
    /// </summary>
    [Fact]
    public void Collect_OnARealAdapter_ReturnsCoherentNativeData()
    {
        var nic = NetworkInterface.GetAllNetworkInterfaces().FirstOrDefault(n =>
            n.OperationalStatus == OperationalStatus.Up &&
            n.NetworkInterfaceType != NetworkInterfaceType.Loopback &&
            n.GetIPProperties().UnicastAddresses.Any(a => a.Address.AddressFamily == AddressFamily.InterNetwork));
        if (nic is null)
        {
            return; // equipo sin ninguna red IPv4 levantada: nada que comprobar
        }
        var ip = nic.GetIPProperties().UnicastAddresses
            .First(a => a.Address.AddressFamily == AddressFamily.InterNetwork).Address.ToString();

        var collector = new ConnectionDetailsCollector();
        var record = new ConnectionRecord
        {
            Cn = nic.Name,
            Server = "127.0.0.1",
            CertificateThumbprint = "0000000000000000000000000000000000000000",
        };

        var details = collector.Collect(record, new ConnectionRuntimeState(Connected: true, Ipv4Address: ip));

        Assert.Equal(nic.Name, details.ConnectionName);
        Assert.Equal(ip, details.Ipv4Address);
        Assert.NotNull(details.SubnetMask);
        Assert.Equal("127.0.0.1", details.ServerIp);
        Assert.True(details.Mtu is > 0);
        Assert.True(details.BytesSent >= 0 && details.BytesReceived >= 0);
        Assert.Null(details.Certificate); // huella inexistente: sin datos, sin lanzar
        Assert.Null(details.ConnectedFor);  // no es una conexion RAS activa

        // Segunda muestra: la velocidad se calcula entre muestras y nunca es negativa.
        var second = collector.Collect(record, new ConnectionRuntimeState(true, ip));
        Assert.True(second.UploadBytesPerSecond >= 0);
        Assert.True(second.DownloadBytesPerSecond >= 0);

        collector.Forget(nic.Name);
    }

    [Fact]
    public void Collect_AdapterNotFound_StillReturnsWhatTheRecordKnows()
    {
        var collector = new ConnectionDetailsCollector();
        var record = new ConnectionRecord
        {
            Cn = "vpn-adaptador-que-no-existe",
            Server = "192.0.2.10",
            CertificateThumbprint = "1111111111111111111111111111111111111111",
        };

        var details = collector.Collect(record, new ConnectionRuntimeState(true, "10.9.8.7"));

        Assert.Equal("10.9.8.7", details.Ipv4Address);
        Assert.Equal("192.0.2.10", details.ServerIp);
        Assert.Empty(details.DnsServers);
        Assert.Null(details.Mtu);
    }
}
