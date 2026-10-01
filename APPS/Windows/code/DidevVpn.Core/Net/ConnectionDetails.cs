using System.Globalization;
using System.Text;

namespace DidevVpn.Core.Net;

public sealed record CertificateDetails(string CommonName, DateTimeOffset NotAfter, string Issuer, string KeyProvider, bool IsTpm);

/// <summary>
/// Foto de una conexion activa para el panel de detalles. Todo lo que hay
/// aqui es informacion de red/estado publica: nunca claves privadas, tokens
/// ni contrasenas (el texto de "Copiar detalles" se pega en soporte).
/// </summary>
public sealed record ConnectionDetails(
    string ConnectionName,
    string State,
    DateTimeOffset? ConnectedSince,
    TimeSpan? ConnectedFor,
    string Server,
    string? ServerIp,
    string? Ipv4Address,
    string? SubnetMask,
    bool PointToPoint,
    string? GatewayAddress,
    IReadOnlyList<string> DnsServers,
    bool FullTunnel,
    IReadOnlyList<string> RoutedNetworks,
    int? Mtu,
    long BytesSent,
    long BytesReceived,
    double UploadBytesPerSecond,
    double DownloadBytesPerSecond,
    CertificateDetails? Certificate);

public static class ConnectionDetailsText
{
    public const string PointToPointLabel = "Punto a punto (sin puerta de enlace)";

    public const string PointToPointHelp =
        "IKEv2 en Windows siempre asigna la puerta de enlace 0.0.0.0: el tunel es una conexion punto a punto " +
        "y todo el trafico enrutado por la VPN sale directamente por la interfaz del tunel, sin un router intermedio.";

    public static string TunnelDescription(ConnectionDetails d) =>
        d.FullTunnel
            ? "Completo (ruta 0.0.0.0/0 por la VPN)"
            : d.RoutedNetworks.Count == 0
                ? "Dividido (sin redes enrutadas detectadas)"
                : "Dividido: " + string.Join(", ", d.RoutedNetworks);

    public static string Gateway(ConnectionDetails d) => d.PointToPoint ? PointToPointLabel : d.GatewayAddress ?? "(no disponible)";

    /// <summary>Texto plano para pegar en soporte.</summary>
    public static string Build(ConnectionDetails d)
    {
        var text = new StringBuilder();
        void Line(string label, string? value) =>
            text.Append(label).Append(": ").AppendLine(string.IsNullOrWhiteSpace(value) ? "-" : value);

        Line("Conexion", d.ConnectionName);
        Line("Estado", d.ConnectedFor is { } span
            ? $"{d.State} ({TrafficFormatter.FormatDuration(span)})"
            : d.State);
        Line("Conectado desde", d.ConnectedSince?.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss", CultureInfo.InvariantCulture));
        Line("Servidor", d.ServerIp is null ? d.Server : $"{d.Server} ({d.ServerIp})");
        Line("IPv4 asignada", d.Ipv4Address is null ? null : d.SubnetMask is null ? d.Ipv4Address : $"{d.Ipv4Address} / {d.SubnetMask}");
        Line("Puerta de enlace", Gateway(d));
        Line("DNS", d.DnsServers.Count == 0 ? null : string.Join(", ", d.DnsServers));
        Line("Modo de tunel", TunnelDescription(d));
        Line("MTU", d.Mtu?.ToString(CultureInfo.InvariantCulture));
        Line("Enviado", TrafficFormatter.FormatBytes(d.BytesSent));
        Line("Recibido", TrafficFormatter.FormatBytes(d.BytesReceived));
        Line("Velocidad de subida", TrafficFormatter.FormatSpeed(d.UploadBytesPerSecond));
        Line("Velocidad de bajada", TrafficFormatter.FormatSpeed(d.DownloadBytesPerSecond));
        if (d.Certificate is { } cert)
        {
            Line("Certificado", cert.CommonName);
            Line("Caduca", cert.NotAfter.ToLocalTime().ToString("dd/MM/yyyy HH:mm", CultureInfo.InvariantCulture));
            Line("Emisor", cert.Issuer);
            Line("Proveedor de la clave", cert.IsTpm ? $"{cert.KeyProvider} (TPM)" : cert.KeyProvider);
        }
        else
        {
            Line("Certificado", null);
        }
        return text.ToString();
    }
}
