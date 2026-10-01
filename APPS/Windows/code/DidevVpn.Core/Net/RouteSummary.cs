using System.Numerics;

namespace DidevVpn.Core.Net;

public sealed record RouteSummaryResult(bool FullTunnel, IReadOnlyList<string> Networks);

/// <summary>
/// De la tabla de rutas IPv4 de la interfaz de la VPN (destino/mascara en
/// orden de host, a.b.c.d = a&lt;&lt;24|b&lt;&lt;16|c&lt;&lt;8|d) saca si es tunel completo (ruta
/// por defecto 0.0.0.0/0, o la pareja 0.0.0.0/1 + 128.0.0.0/1 que usan algunos
/// servidores para no pisar la ruta por defecto) y la lista de redes
/// enrutadas por la VPN, sin el ruido que Windows anade siempre a una
/// interfaz (host propio, multicast, broadcast, loopback).
/// </summary>
public static class RouteSummary
{
    public static RouteSummaryResult Summarize(IEnumerable<(uint Dest, uint Mask)> routes, uint? ownAddress)
    {
        var all = routes.Distinct().ToList();
        var hasDefault = all.Contains((0u, 0u));
        var hasHalves = all.Contains((0u, 0x80000000u)) && all.Contains((0x80000000u, 0x80000000u));
        var full = hasDefault || hasHalves;

        var networks = all
            .Where(r => !(r.Dest == 0 && r.Mask == 0))
            .Where(r => !(full && r.Mask == 0x80000000u && (r.Dest == 0 || r.Dest == 0x80000000u)))
            .Where(r => (r.Dest >> 28) != 0xE)                 // multicast 224.0.0.0/4
            .Where(r => r.Dest != 0xFFFFFFFFu)                  // broadcast
            .Where(r => (r.Dest >> 24) != 127)                  // loopback
            .Where(r => !(r.Mask == 0xFFFFFFFFu && ownAddress.HasValue && r.Dest == ownAddress.Value)) // host propio
            .OrderBy(r => r.Dest).ThenBy(r => r.Mask)
            .Select(r => $"{Dotted(r.Dest)}/{BitOperations.PopCount(r.Mask)}")
            .ToList();

        return new RouteSummaryResult(full, networks);
    }

    public static string Dotted(uint address) =>
        $"{(address >> 24) & 0xFF}.{(address >> 16) & 0xFF}.{(address >> 8) & 0xFF}.{address & 0xFF}";

    public static uint FromBytes(byte[] ipv4) =>
        (uint)(ipv4[0] << 24 | ipv4[1] << 16 | ipv4[2] << 8 | ipv4[3]);
}
