using DidevVpn.Core.Net;

namespace DidevVpn.Tests.Net;

public class ConnectionDetailsTests
{
    [Theory]
    [InlineData(0, "0 B")]
    [InlineData(1, "1 B")]
    [InlineData(1023, "1023 B")]
    [InlineData(1024, "1 KB")]
    [InlineData(1536, "1,5 KB")]
    [InlineData(1048576, "1 MB")]
    [InlineData(1572864, "1,5 MB")]
    [InlineData(5L * 1024 * 1024 * 1024, "5 GB")]
    [InlineData(-5, "0 B")]
    public void FormatBytes_UsesBinaryUnitsWithSpanishDecimalComma(long bytes, string expected)
    {
        Assert.Equal(expected, TrafficFormatter.FormatBytes(bytes));
    }

    [Theory]
    [InlineData(0, "0 B/s")]
    [InlineData(512, "512 B/s")]
    [InlineData(1280, "1,3 KB/s")]
    [InlineData(2.5 * 1024 * 1024, "2,5 MB/s")]
    [InlineData(-1, "0 B/s")]
    [InlineData(double.NaN, "0 B/s")]
    public void FormatSpeed_AppendsPerSecond(double bytesPerSecond, string expected)
    {
        Assert.Equal(expected, TrafficFormatter.FormatSpeed(bytesPerSecond));
    }

    [Theory]
    [InlineData(0, "0:00:00")]
    [InlineData(65, "0:01:05")]
    [InlineData(3661, "1:01:01")]
    [InlineData(90061, "1 d 01:01:01")]
    [InlineData(-10, "0:00:00")]
    public void FormatDuration_HoursMinutesSecondsOrDays(int seconds, string expected)
    {
        Assert.Equal(expected, TrafficFormatter.FormatDuration(TimeSpan.FromSeconds(seconds)));
    }

    [Fact]
    public void ThroughputMeter_ComputesRatesBetweenSamples()
    {
        var meter = new ThroughputMeter();
        var t0 = new DateTime(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

        meter.Add(t0, 1000, 5000);
        Assert.Equal(0, meter.UploadBytesPerSecond); // primera muestra: nada con que comparar

        meter.Add(t0.AddSeconds(2), 5000, 9000);
        Assert.Equal(2000, meter.UploadBytesPerSecond);
        Assert.Equal(2000, meter.DownloadBytesPerSecond);

        meter.Add(t0.AddSeconds(3), 5000, 10000);
        Assert.Equal(0, meter.UploadBytesPerSecond);
        Assert.Equal(1000, meter.DownloadBytesPerSecond);
    }

    [Fact]
    public void ThroughputMeter_CounterGoingBackwards_IsTreatedAsResetNotNegativeSpeed()
    {
        var meter = new ThroughputMeter();
        var t0 = new DateTime(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
        meter.Add(t0, 10_000, 10_000);

        meter.Add(t0.AddSeconds(1), 100, 100);

        Assert.Equal(0, meter.UploadBytesPerSecond);
        Assert.Equal(0, meter.DownloadBytesPerSecond);
    }

    [Fact]
    public void ThroughputMeter_Reset_DoesNotCompareAgainstTheOldSample()
    {
        var meter = new ThroughputMeter();
        var t0 = new DateTime(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
        meter.Add(t0, 0, 0);
        meter.Add(t0.AddSeconds(1), 1000, 1000);
        meter.Reset();

        meter.Add(t0.AddSeconds(2), 5_000_000, 5_000_000);

        Assert.Equal(0, meter.DownloadBytesPerSecond);
    }

    private static ConnectionDetails Sample(bool fullTunnel = true, bool pointToPoint = true, CertificateDetails? cert = null) => new(
        ConnectionName: "vpn-diego-portatil",
        State: "Conectado",
        ConnectedSince: new DateTimeOffset(2026, 10, 1, 9, 0, 0, TimeSpan.Zero),
        ConnectedFor: TimeSpan.FromSeconds(3725),
        Server: "vpn.vlc.didev.es",
        ServerIp: "203.0.113.7",
        Ipv4Address: "192.168.10.80",
        SubnetMask: "255.255.255.255",
        PointToPoint: pointToPoint,
        GatewayAddress: pointToPoint ? null : "192.168.10.1",
        DnsServers: new[] { "8.8.8.8", "8.8.4.4" },
        FullTunnel: fullTunnel,
        RoutedNetworks: fullTunnel ? Array.Empty<string>() : new[] { "192.168.10.0/24", "10.0.0.0/8" },
        Mtu: 1400,
        BytesSent: 1536,
        BytesReceived: 3L * 1024 * 1024,
        UploadBytesPerSecond: 512,
        DownloadBytesPerSecond: 2.5 * 1024 * 1024,
        Certificate: cert);

    [Fact]
    public void Text_ContainsTheKeyFacts_AndTheP2PExplanationLabel()
    {
        var text = ConnectionDetailsText.Build(Sample(cert: new CertificateDetails(
            "vpn-diego-portatil", new DateTimeOffset(2026, 10, 31, 0, 0, 0, TimeSpan.Zero),
            "CN=VPN Intermediate CA", "Microsoft Platform Crypto Provider", IsTpm: true)));

        Assert.Contains("Conexion: vpn-diego-portatil", text);
        Assert.Contains("Estado: Conectado (1:02:05)", text);
        Assert.Contains("Servidor: vpn.vlc.didev.es (203.0.113.7)", text);
        Assert.Contains("IPv4 asignada: 192.168.10.80 / 255.255.255.255", text);
        Assert.Contains("Puerta de enlace: Punto a punto (sin puerta de enlace)", text);
        Assert.Contains("DNS: 8.8.8.8, 8.8.4.4", text);
        Assert.Contains("Modo de tunel: Completo (ruta 0.0.0.0/0 por la VPN)", text);
        Assert.Contains("MTU: 1400", text);
        Assert.Contains("Enviado: 1,5 KB", text);
        Assert.Contains("Recibido: 3 MB", text);
        Assert.Contains("Velocidad de bajada: 2,5 MB/s", text);
        Assert.Contains("Proveedor de la clave: Microsoft Platform Crypto Provider (TPM)", text);
        Assert.Contains("Emisor: CN=VPN Intermediate CA", text);
    }

    [Fact]
    public void Text_SplitTunnel_ListsRoutedNetworks()
    {
        var text = ConnectionDetailsText.Build(Sample(fullTunnel: false));

        Assert.Contains("Modo de tunel: Dividido: 192.168.10.0/24, 10.0.0.0/8", text);
    }

    [Fact]
    public void Text_MissingValues_AreShownAsDash_NotBlankOrNull()
    {
        var details = Sample() with { ServerIp = null, Ipv4Address = null, DnsServers = Array.Empty<string>(), Mtu = null };

        var text = ConnectionDetailsText.Build(details);

        Assert.Contains("Servidor: vpn.vlc.didev.es", text);
        Assert.Contains("IPv4 asignada: -", text);
        Assert.Contains("DNS: -", text);
        Assert.Contains("MTU: -", text);
        Assert.Contains("Certificado: -", text);
    }

    [Fact]
    public void Text_NeverContainsSecretsLikeKeysTokensOrPasswords()
    {
        var text = ConnectionDetailsText.Build(Sample(cert: new CertificateDetails(
            "vpn-x", DateTimeOffset.UtcNow, "CN=CA", "Microsoft Software Key Storage Provider", IsTpm: false)));

        Assert.DoesNotContain("PRIVATE", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("password", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("contrasena", text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Text_RealGateway_IsShownWhenNotPointToPoint()
    {
        var text = ConnectionDetailsText.Build(Sample(pointToPoint: false));

        Assert.Contains("Puerta de enlace: 192.168.10.1", text);
    }

    private static uint Ip(string dotted) => RouteSummary.FromBytes(System.Net.IPAddress.Parse(dotted).GetAddressBytes());

    [Fact]
    public void RouteSummary_DefaultRoute_IsFullTunnel_AndIgnoresInterfaceNoise()
    {
        var own = Ip("192.168.10.80");
        var routes = new (uint, uint)[]
        {
            (0, 0),
            (own, 0xFFFFFFFF),                 // host propio
            (Ip("224.0.0.0"), 0xF0000000),     // multicast
            (Ip("255.255.255.255"), 0xFFFFFFFF),
            (Ip("127.0.0.0"), 0xFF000000),
        };

        var summary = RouteSummary.Summarize(routes, own);

        Assert.True(summary.FullTunnel);
        Assert.Empty(summary.Networks);
    }

    [Fact]
    public void RouteSummary_TwoHalves_CountAsFullTunnel_AndAreNotListed()
    {
        var routes = new (uint, uint)[] { (0, 0x80000000), (0x80000000, 0x80000000) };

        var summary = RouteSummary.Summarize(routes, Ip("10.0.0.2"));

        Assert.True(summary.FullTunnel);
        Assert.Empty(summary.Networks);
    }

    [Fact]
    public void RouteSummary_SplitTunnel_ListsTheRoutedNetworksSorted()
    {
        var routes = new (uint, uint)[]
        {
            (Ip("192.168.10.0"), Ip("255.255.255.0")),
            (Ip("10.0.0.0"), Ip("255.0.0.0")),
            (Ip("192.168.10.0"), Ip("255.255.255.0")), // duplicada
        };

        var summary = RouteSummary.Summarize(routes, Ip("192.168.10.80"));

        Assert.False(summary.FullTunnel);
        Assert.Equal(new[] { "10.0.0.0/8", "192.168.10.0/24" }, summary.Networks);
    }

    [Fact]
    public void RouteSummary_NoRoutes_IsNotFullTunnel()
    {
        var summary = RouteSummary.Summarize(Array.Empty<(uint, uint)>(), null);

        Assert.False(summary.FullTunnel);
        Assert.Empty(summary.Networks);
    }

    /// <summary>
    /// La app se publica con InvariantGlobalization=true: pedir una cultura
    /// concreta lanza CultureNotFoundException (fallo real de la 0.1.9 al pulsar
    /// Conectar). Si este test falla, los tests ya no corren en el mismo modo que
    /// la app y ese tipo de fallo volveria a pasar desapercibido.
    /// </summary>
    [Fact]
    public void Tests_RunInInvariantGlobalizationMode_LikeTheShippedApp()
    {
        Assert.Throws<System.Globalization.CultureNotFoundException>(() => System.Globalization.CultureInfo.GetCultureInfo("es-ES"));
    }

    [Fact]
    public void Formatter_DoesNotNeedAnySpecificCulture()
    {
        Assert.Equal("1,5 MB", TrafficFormatter.FormatBytes(1_572_864));
        Assert.Equal("2,5 MB/s", TrafficFormatter.FormatSpeed(2.5 * 1024 * 1024));
    }
}
