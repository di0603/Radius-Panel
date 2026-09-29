namespace DidevVpn.App.Services.Ras;

internal readonly record struct RasConnectionState(bool Connected, string? Ipv4Address);

/// <summary>Separado de la implementacion nativa para poder probar ConnectionStateService con un lector falso (ver DidevVpn.App.Tests).</summary>
internal interface IRasStateReader
{
    /// <summary>La conexion existe en la agenda telefonica del usuario (independientemente de si esta activa ahora mismo).</summary>
    bool EntryExists(string connectionName);

    /// <summary>Estado de una conexion ACTIVA (RasEnumConnections); Connected=false si no aparece ahi -ni conectando ni conectada-.</summary>
    RasConnectionState GetState(string connectionName);
}

/// <summary>
/// Implementacion real con RAS nativo (ver RasInterop). Nunca lanza hacia
/// fuera por un fallo "esperable" de la propia API (sin conexiones activas,
/// entrada no encontrada): eso se traduce en "no existe"/"desconectado". Si
/// falla el propio P/Invoke (marshaling, DLL no encontrada...), SI lanza -es
/// responsabilidad del llamador (VpnConnectionService) decidir si cae de
/// vuelta al camino por PowerShell-.
/// </summary>
internal sealed class RasStateReader : IRasStateReader
{
    public bool EntryExists(string connectionName)
    {
        foreach (var entry in EnumEntries())
        {
            if (string.Equals(entry.szEntryName, connectionName, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    public RasConnectionState GetState(string connectionName)
    {
        foreach (var conn in EnumConnections())
        {
            if (!string.Equals(conn.szEntryName, connectionName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var status = new RasInterop.RasConnStatus { dwSize = RasInterop.RasConnStatus.Size };
            var statusResult = RasInterop.RasGetConnectStatusW(conn.hrasconn, ref status);
            if (statusResult != RasInterop.ErrorSuccess)
            {
                // La conexion desaparecio entre RasEnumConnections y aqui
                // (se desconecto justo ahora): tratar como desconectada, no
                // como un fallo del P/Invoke.
                return new RasConnectionState(false, null);
            }

            if (status.rasconnstate != RasInterop.RasConnState.Connected)
            {
                return new RasConnectionState(false, null);
            }

            var ip = TryGetIpv4(conn.hrasconn);
            return new RasConnectionState(true, ip);
        }

        return new RasConnectionState(false, null);
    }

    private static string? TryGetIpv4(IntPtr hrasconn)
    {
        var projection = new RasInterop.RasPppIp { dwSize = RasInterop.RasPppIp.Size };
        var cb = RasInterop.RasPppIp.Size;
        var result = RasInterop.RasGetProjectionInfoW(hrasconn, RasInterop.RasProjection.PppIp, ref projection, ref cb);
        if (result != RasInterop.ErrorSuccess)
        {
            return null;
        }
        return string.IsNullOrEmpty(projection.szIpAddress) ? null : projection.szIpAddress;
    }

    private static IEnumerable<RasInterop.RasConn> EnumConnections()
    {
        var probe = new RasInterop.RasConn[1];
        probe[0].dwSize = RasInterop.RasConn.Size;
        var cb = RasInterop.RasConn.Size;
        var result = RasInterop.RasEnumConnectionsW(probe, ref cb, out var count);

        if (result == RasInterop.ErrorSuccess)
        {
            return count > 0 ? probe[..count] : Array.Empty<RasInterop.RasConn>();
        }

        if (result != RasInterop.ErrorBufferTooSmall)
        {
            throw new InvalidOperationException($"RasEnumConnectionsW devolvio el codigo {result}.");
        }

        var entrySize = RasInterop.RasConn.Size;
        var arrayLength = Math.Max(1, cb / entrySize);
        var buffer = new RasInterop.RasConn[arrayLength];
        for (var i = 0; i < buffer.Length; i++)
        {
            buffer[i].dwSize = entrySize;
        }

        var cb2 = cb;
        result = RasInterop.RasEnumConnectionsW(buffer, ref cb2, out count);
        if (result != RasInterop.ErrorSuccess)
        {
            throw new InvalidOperationException($"RasEnumConnectionsW (segunda llamada) devolvio el codigo {result}.");
        }
        return count > 0 ? buffer[..count] : Array.Empty<RasInterop.RasConn>();
    }

    private static IEnumerable<RasInterop.RasEntryName> EnumEntries()
    {
        var probe = new RasInterop.RasEntryName[1];
        probe[0].dwSize = RasInterop.RasEntryName.Size;
        var cb = RasInterop.RasEntryName.Size;
        var result = RasInterop.RasEnumEntriesW(null, null, probe, ref cb, out var count);

        if (result == RasInterop.ErrorSuccess)
        {
            return count > 0 ? probe[..count] : Array.Empty<RasInterop.RasEntryName>();
        }

        if (result != RasInterop.ErrorBufferTooSmall)
        {
            throw new InvalidOperationException($"RasEnumEntriesW devolvio el codigo {result}.");
        }

        var entrySize = RasInterop.RasEntryName.Size;
        var arrayLength = Math.Max(1, cb / entrySize);
        var buffer = new RasInterop.RasEntryName[arrayLength];
        for (var i = 0; i < buffer.Length; i++)
        {
            buffer[i].dwSize = entrySize;
        }

        var cb2 = cb;
        result = RasInterop.RasEnumEntriesW(null, null, buffer, ref cb2, out count);
        if (result != RasInterop.ErrorSuccess)
        {
            throw new InvalidOperationException($"RasEnumEntriesW (segunda llamada) devolvio el codigo {result}.");
        }
        return count > 0 ? buffer[..count] : Array.Empty<RasInterop.RasEntryName>();
    }
}
