using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services.Ras;
using DidevVpn.Core.Net;

namespace DidevVpn.App.Services;

internal interface IConnectionDetailsCollector
{
    /// <summary>Foto actual de una conexion CONECTADA. Bloquea un poco (DNS la primera vez, lectura de tablas): llamar desde un hilo de fondo.</summary>
    ConnectionDetails Collect(ConnectionRecord record, ConnectionRuntimeState state);

    /// <summary>La conexion ya no esta activa: la siguiente muestra de velocidad no se compara con la vieja.</summary>
    void Forget(string connectionName);
}

/// <summary>
/// Detalles de una conexion activa SIN PowerShell (prompt 12.8, punto 3):
/// RasGetConnectionStatistics (duracion), NetworkInterface (IPv4/mascara,
/// puerta de enlace, DNS, MTU, bytes de 64 bits), GetIpForwardTable (rutas de
/// la interfaz de la VPN) y el almacen de certificados del usuario. No se
/// incluyen los algoritmos IKE/ESP negociados: leerlos exige admin
/// (Get-VpnConnectionIPsecConfiguration / ETW), y se prefiere omitirlo a pedir
/// elevacion.
/// </summary>
internal sealed class ConnectionDetailsCollector : IConnectionDetailsCollector
{
    private static readonly TimeSpan DnsRetryAfterFailure = TimeSpan.FromSeconds(30);

    private readonly IRasStateReader _ras;
    private readonly object _lock = new();
    private readonly Dictionary<string, ThroughputMeter> _meters = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (string? Ip, DateTime At)> _serverIps = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, CertificateDetails?> _certificates = new(StringComparer.OrdinalIgnoreCase);

    public ConnectionDetailsCollector(IRasStateReader? ras = null)
    {
        _ras = ras ?? new RasStateReader();
    }

    public ConnectionDetails Collect(ConnectionRecord record, ConnectionRuntimeState state)
    {
        var nic = FindInterface(record.Cn, state.Ipv4Address);

        string? ipv4 = null, mask = null, gateway = null;
        var dns = new List<string>();
        int? mtu = null;
        long sent = 0, received = 0;
        var routes = new RouteSummaryResult(false, Array.Empty<string>());

        if (nic is not null)
        {
            var props = nic.GetIPProperties();
            var unicast = props.UnicastAddresses.FirstOrDefault(a => a.Address.AddressFamily == AddressFamily.InterNetwork);
            ipv4 = unicast?.Address.ToString() ?? state.Ipv4Address;
            mask = unicast?.IPv4Mask?.ToString();
            gateway = props.GatewayAddresses
                .Select(g => g.Address)
                .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !a.Equals(IPAddress.Any))
                ?.ToString();
            dns.AddRange(props.DnsAddresses.OrderBy(a => a.AddressFamily == AddressFamily.InterNetwork ? 0 : 1).Select(a => a.ToString()));
            var v4 = props.GetIPv4Properties();
            mtu = v4.Mtu;
            var stats = nic.GetIPv4Statistics();
            sent = stats.BytesSent;
            received = stats.BytesReceived;
            routes = SummarizeRoutes(v4.Index, ipv4);
        }
        else
        {
            ipv4 = state.Ipv4Address;
        }

        var duration = TryGetDuration(record.Cn);
        var (upload, download) = Sample(record.Cn, sent, received);

        return new ConnectionDetails(
            ConnectionName: record.Cn,
            State: "Conectado",
            ConnectedSince: duration is { } d ? DateTimeOffset.Now - d : null,
            ConnectedFor: duration,
            Server: record.Server,
            ServerIp: ResolveServer(record.Server),
            Ipv4Address: ipv4,
            SubnetMask: mask,
            // IKEv2 en Windows da siempre 0.0.0.0 de puerta de enlace: punto a punto.
            PointToPoint: gateway is null,
            GatewayAddress: gateway,
            DnsServers: dns,
            FullTunnel: routes.FullTunnel,
            RoutedNetworks: routes.Networks,
            Mtu: mtu,
            BytesSent: sent,
            BytesReceived: received,
            UploadBytesPerSecond: upload,
            DownloadBytesPerSecond: download,
            Certificate: GetCertificate(record));
    }

    public void Forget(string connectionName)
    {
        lock (_lock)
        {
            _meters.Remove(connectionName);
        }
    }

    private (double Upload, double Download) Sample(string cn, long sent, long received)
    {
        lock (_lock)
        {
            if (!_meters.TryGetValue(cn, out var meter))
            {
                meter = new ThroughputMeter();
                _meters[cn] = meter;
            }
            meter.Add(DateTime.UtcNow, sent, received);
            return (meter.UploadBytesPerSecond, meter.DownloadBytesPerSecond);
        }
    }

    private TimeSpan? TryGetDuration(string cn)
    {
        try
        {
            return _ras.GetConnectedDuration(cn);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>El adaptador de una conexion RAS se llama como la entrada de la agenda; si no, se busca por la IP asignada.</summary>
    private static NetworkInterface? FindInterface(string cn, string? assignedIpv4)
    {
        var all = NetworkInterface.GetAllNetworkInterfaces();
        var byName = all.FirstOrDefault(n => string.Equals(n.Name, cn, StringComparison.OrdinalIgnoreCase));
        if (byName is not null || string.IsNullOrEmpty(assignedIpv4))
        {
            return byName;
        }
        return all.FirstOrDefault(n => n.GetIPProperties().UnicastAddresses.Any(a => a.Address.ToString() == assignedIpv4));
    }

    private string? ResolveServer(string server)
    {
        lock (_lock)
        {
            if (_serverIps.TryGetValue(server, out var cached) &&
                (cached.Ip is not null || DateTime.UtcNow - cached.At < DnsRetryAfterFailure))
            {
                return cached.Ip;
            }
        }

        string? ip = null;
        try
        {
            if (IPAddress.TryParse(server, out var literal))
            {
                ip = literal.ToString();
            }
            else
            {
                ip = Dns.GetHostAddresses(server)
                    .OrderBy(a => a.AddressFamily == AddressFamily.InterNetwork ? 0 : 1)
                    .FirstOrDefault()?.ToString();
            }
        }
        catch (SocketException)
        {
            // sin resolver: se reintenta pasados DnsRetryAfterFailure
        }

        lock (_lock)
        {
            _serverIps[server] = (ip, DateTime.UtcNow);
        }
        return ip;
    }

    private CertificateDetails? GetCertificate(ConnectionRecord record)
    {
        lock (_lock)
        {
            if (_certificates.TryGetValue(record.CertificateThumbprint, out var cached))
            {
                return cached;
            }
        }

        CertificateDetails? details = null;
        try
        {
            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadOnly);
            var matches = store.Certificates.Find(X509FindType.FindByThumbprint, record.CertificateThumbprint, validOnly: false);
            if (matches.Count > 0)
            {
                var cert = matches[0];
                var provider = KeyProviderName(cert) ??
                    (record.IsTpmBacked ? "Microsoft Platform Crypto Provider" : "Microsoft Software Key Storage Provider");
                details = new CertificateDetails(
                    CommonName: cert.GetNameInfo(X509NameType.SimpleName, false),
                    NotAfter: new DateTimeOffset(cert.NotAfter),
                    Issuer: cert.GetNameInfo(X509NameType.SimpleName, true),
                    KeyProvider: provider,
                    IsTpm: provider.Contains("Platform Crypto", StringComparison.OrdinalIgnoreCase));
            }
        }
        catch
        {
            // sin datos del certificado: el panel muestra "-"
        }

        lock (_lock)
        {
            _certificates[record.CertificateThumbprint] = details;
        }
        return details;
    }

    private static string? KeyProviderName(X509Certificate2 cert)
    {
        try
        {
            using var key = cert.GetECDsaPrivateKey();
            return (key as ECDsaCng)?.Key.Provider?.Provider;
        }
        catch
        {
            return null;
        }
    }

    // ---- Rutas: GetIpForwardTable (IPv4, MIB_IPFORWARDROW = 14 DWORD; verificado contra ipmib.h) ----

    private static RouteSummaryResult SummarizeRoutes(int interfaceIndex, string? ownIpv4)
    {
        try
        {
            var rows = ReadIpv4Routes(interfaceIndex);
            uint? own = IPAddress.TryParse(ownIpv4, out var ip) ? RouteSummary.FromBytes(ip.GetAddressBytes()) : null;
            return RouteSummary.Summarize(rows, own);
        }
        catch
        {
            return new RouteSummaryResult(false, Array.Empty<string>());
        }
    }

    private static List<(uint Dest, uint Mask)> ReadIpv4Routes(int interfaceIndex)
    {
        const int rowSize = 56; // 14 DWORD
        uint size = 0;
        _ = GetIpForwardTable(IntPtr.Zero, ref size, false);
        if (size == 0)
        {
            return new List<(uint, uint)>();
        }

        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetIpForwardTable(buffer, ref size, false) != 0)
            {
                return new List<(uint, uint)>();
            }

            var count = Marshal.ReadInt32(buffer);
            var result = new List<(uint, uint)>();
            for (var i = 0; i < count; i++)
            {
                var row = buffer + 4 + i * rowSize;
                if (Marshal.ReadInt32(row, 16) != interfaceIndex) // dwForwardIfIndex
                {
                    continue;
                }
                // Los DWORD vienen en orden de red: se pasan a orden de host (a.b.c.d = a<<24|...).
                result.Add((NetworkToHost(Marshal.ReadInt32(row, 0)), NetworkToHost(Marshal.ReadInt32(row, 4))));
            }
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static uint NetworkToHost(int value) =>
        System.Buffers.Binary.BinaryPrimitives.ReverseEndianness((uint)value);

    [DllImport("iphlpapi.dll")]
    private static extern int GetIpForwardTable(IntPtr pIpForwardTable, ref uint pdwSize, [MarshalAs(UnmanagedType.Bool)] bool bOrder);
}
