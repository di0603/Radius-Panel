namespace DidevVpn.App.Services.Ras;

/// <summary>Avisa de que alguna conexion RAS se ha establecido o caido, vengan de donde vengan (esta app, rasphone, el panel de Windows, perdida de red).</summary>
internal interface IConnectionChangeNotifier : IDisposable
{
    /// <summary>Se dispara en un hilo de fondo.</summary>
    event Action? Changed;
}

/// <summary>
/// RasConnectionNotification (rasapi32) sobre TODAS las conexiones
/// (INVALID_HANDLE_VALUE) con RASCN_Connection | RASCN_Disconnection y un
/// evento; un hilo de fondo espera ese evento (o el de parada) y dispara
/// <see cref="Changed"/>. La notificacion es de un solo disparo por llamada,
/// asi que se vuelve a registrar tras cada senal.
/// </summary>
internal sealed class RasConnectionMonitor : IConnectionChangeNotifier
{
    private readonly ManualResetEvent _rasEvent = new(false);
    private readonly ManualResetEvent _stopEvent = new(false);
    private readonly Thread _thread;
    private readonly FileLogger? _logger;

    public event Action? Changed;

    public RasConnectionMonitor(FileLogger? logger = null)
    {
        _logger = logger;
        _thread = new Thread(Run) { IsBackground = true, Name = "didev-vpn-rasnotify" };
        _thread.Start();
    }

    private void Run()
    {
        try
        {
            while (true)
            {
                _rasEvent.Reset();
                var result = RasInterop.RasConnectionNotificationW(
                    RasInterop.AllConnections, _rasEvent.SafeWaitHandle.DangerousGetHandle(),
                    RasInterop.RasCnConnection | RasInterop.RasCnDisconnection);
                if (result != RasInterop.ErrorSuccess)
                {
                    _logger?.Warn($"RasConnectionNotification ha fallado ({result}): el estado se actualizara solo por eventos de red y el temporizador de respaldo.");
                    return;
                }

                var signaled = WaitHandle.WaitAny(new WaitHandle[] { _stopEvent, _rasEvent });
                if (signaled == 0)
                {
                    return;
                }
                try { Changed?.Invoke(); }
                catch (Exception ex) { _logger?.Warn($"Fallo en un suscriptor de la notificacion RAS: {ex.Message}"); }
            }
        }
        catch (Exception ex)
        {
            _logger?.Warn($"Monitor de notificaciones RAS detenido: {ex.Message}");
        }
    }

    public void Dispose()
    {
        _stopEvent.Set();
        _thread.Join(TimeSpan.FromSeconds(2));
        _rasEvent.Dispose();
        _stopEvent.Dispose();
    }
}
