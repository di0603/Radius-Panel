namespace DidevVpn.App.Services.Ras;

internal readonly record struct RasConnectionState(bool Connected, string? Ipv4Address);

/// <summary>Fase de una conexion RAS: no aparece en la lista de activas / marcando (IKE, EAP...) / establecida / fallo con codigo RAS.</summary>
internal enum RasPhase
{
    Disconnected,
    Connecting,
    Connected,
    Failed,
}

internal readonly record struct RasPhaseInfo(RasPhase Phase, int Error = 0);

/// <summary>Separado de la implementacion nativa para poder probar ConnectionStateService con un lector falso (ver DidevVpn.App.Tests).</summary>
internal interface IRasStateReader
{
    /// <summary>La conexion existe en la agenda telefonica del usuario (independientemente de si esta activa ahora mismo).</summary>
    bool EntryExists(string connectionName);

    /// <summary>Estado de una conexion ACTIVA (RasEnumConnections); Connected=false si no aparece ahi -ni conectando ni conectada-.</summary>
    RasConnectionState GetState(string connectionName);

    /// <summary>Fase actual (RasEnumConnections + RasGetConnectStatus), con el codigo de error RAS si ha fallado.</summary>
    RasPhaseInfo GetPhase(string connectionName);

    /// <summary>Tiempo que lleva conectada (RasGetConnectionStatistics), o null si no esta activa.</summary>
    TimeSpan? GetConnectedDuration(string connectionName);
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
    private static readonly TimeSpan NotFoundLogInterval = TimeSpan.FromSeconds(20);

    private readonly FileLogger? _logger;
    private readonly Dictionary<string, DateTime> _lastNotFoundLog = new(StringComparer.OrdinalIgnoreCase);

    public RasStateReader(FileLogger? logger = null)
    {
        _logger = logger;
    }

    /// <summary>
    /// Respaldo (prompt 12.9): adaptador PPP operativo con IPv4 y el mismo
    /// nombre que la entrada. Verificado: una conexion IKEv2 activa aparece
    /// como NetworkInterface tipo Ppp, Up, con el nombre de la entrada.
    /// </summary>
    internal static string? FindActiveAdapterIpv4(string connectionName)
    {
        try
        {
            foreach (var nic in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Ppp ||
                    nic.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up ||
                    !string.Equals(nic.Name, connectionName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                var address = nic.GetIPProperties().UnicastAddresses
                    .FirstOrDefault(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork);
                if (address is not null)
                {
                    return address.Address.ToString();
                }
            }
        }
        catch (System.Net.NetworkInformation.NetworkInformationException)
        {
            // sin respaldo disponible
        }
        return null;
    }

    private void LogNotFound(string connectionName, IReadOnlyList<RasInterop.RasConn> seen)
    {
        if (_logger is null)
        {
            return;
        }
        var now = DateTime.UtcNow;
        lock (_lastNotFoundLog)
        {
            if (_lastNotFoundLog.TryGetValue(connectionName, out var last) && now - last < NotFoundLogInterval)
            {
                return;
            }
            _lastNotFoundLog[connectionName] = now;
        }
        var names = seen.Count == 0 ? "(ninguna)" : string.Join(", ", seen.Select(c => $"\"{c.szEntryName}\""));
        _logger.Info($"RasEnumConnections no ve \"{connectionName}\" entre las conexiones activas: {names}.");
    }

    private void LogStatusFailure(string connectionName, int code)
    {
        _logger?.Warn($"RasGetConnectStatus para \"{connectionName}\" devolvio el codigo {code} (632 = tamano de RASCONNSTATUSW invalido, 6 = handle invalido).");
    }

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
        var phase = GetPhase(connectionName);
        if (phase.Phase != RasPhase.Connected)
        {
            return new RasConnectionState(false, null);
        }
        return new RasConnectionState(true, GetIpv4(connectionName));
    }

    private string? GetIpv4(string connectionName)
    {
        foreach (var conn in EnumConnections())
        {
            if (string.Equals(conn.szEntryName, connectionName, StringComparison.OrdinalIgnoreCase))
            {
                var ip = TryGetIpv4(conn.hrasconn);
                if (ip is not null)
                {
                    return ip;
                }
            }
        }
        // IKEv2 no tiene proyeccion PPP (RasGetProjectionInfo da 87): se lee del adaptador.
        return FindActiveAdapterIpv4(connectionName);
    }

    public TimeSpan? GetConnectedDuration(string connectionName)
    {
        foreach (var conn in EnumConnections())
        {
            if (!string.Equals(conn.szEntryName, connectionName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var stats = new RasInterop.RasStats { dwSize = RasInterop.RasStats.Size };
            return RasInterop.RasGetConnectionStatistics(conn.hrasconn, ref stats) == RasInterop.ErrorSuccess
                ? TimeSpan.FromMilliseconds(stats.dwConnectDuration)
                : null;
        }
        return null;
    }

    public RasPhaseInfo GetPhase(string connectionName)
    {
        var connections = EnumConnections().ToList();
        foreach (var conn in connections)
        {
            if (!string.Equals(conn.szEntryName, connectionName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var status = new RasInterop.RasConnStatus { dwSize = RasInterop.RasConnStatus.Size };
            var code = RasInterop.RasGetConnectStatusW(conn.hrasconn, ref status);
            if (code != RasInterop.ErrorSuccess)
            {
                LogStatusFailure(connectionName, code);
                // La API no da respuesta fiable: se mira el adaptador antes de dar nada por desconectado.
                return FindActiveAdapterIpv4(connectionName) is not null
                    ? new RasPhaseInfo(RasPhase.Connected)
                    : new RasPhaseInfo(RasPhase.Disconnected);
            }
            return ClassifyStatus(status.rasconnstate, status.dwError);
        }

        // No esta entre las activas de RAS: si hay un adaptador PPP operativo con ese nombre y IPv4, esta conectada.
        if (FindActiveAdapterIpv4(connectionName) is not null)
        {
            _logger?.Warn($"RAS no lista \"{connectionName}\" pero hay un adaptador PPP activo con ese nombre: se da por conectada.");
            return new RasPhaseInfo(RasPhase.Connected);
        }
        LogNotFound(connectionName, connections);
        return new RasPhaseInfo(RasPhase.Disconnected);
    }

    /// <summary>Separado para poder probar la clasificacion sin Windows: error distinto de 0 = fallo; Connected = conectada; Disconnected = ya no; el resto = marcando.</summary>
    internal static RasPhaseInfo ClassifyStatus(RasInterop.RasConnState state, int error)
    {
        if (error != 0)
        {
            return new RasPhaseInfo(RasPhase.Failed, error);
        }
        return state switch
        {
            RasInterop.RasConnState.Connected => new RasPhaseInfo(RasPhase.Connected),
            RasInterop.RasConnState.Disconnected => new RasPhaseInfo(RasPhase.Disconnected),
            _ => new RasPhaseInfo(RasPhase.Connecting),
        };
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
