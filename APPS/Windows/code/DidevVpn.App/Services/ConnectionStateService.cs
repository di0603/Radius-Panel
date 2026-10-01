using System.Net.NetworkInformation;
using DidevVpn.App.Services.Ras;
using DidevVpn.Core.Net;

namespace DidevVpn.App.Services;

internal readonly record struct ConnectionRuntimeState(bool Connected, string? Ipv4Address, bool Connecting = false);

/// <summary>
/// Cache compartida del estado de todas las conexiones (existe/conectada/IP),
/// UNA sola fuente de verdad para la bandeja y la ventana (prompt 12.7): sin
/// esto, cada una sondeaba por su cuenta (2 llamadas por conexion cada 15s en
/// la bandeja, otras tantas cada 5s en la ventana). Se refresca por EVENTOS
/// de red (NetworkChange, con un debounce de ~500ms: varios eventos seguidos
/// al reconectar un adaptador solo deberian disparar un refresco) mas un
/// temporizador de respaldo cada 30s (por si algo cambia sin que Windows
/// dispare NetworkChange, p.ej. un fallo de negociacion IKE ya resuelto por
/// su cuenta). El refresco en si corre en un hilo de fondo (Task.Run); el
/// evento StateChanged se entrega en el hilo de interfaz (via
/// SynchronizationContext.Post, capturado al construir esto DESDE ese hilo).
/// </summary>
internal sealed class ConnectionStateService : IDisposable
{
    private static readonly TimeSpan DebounceWindow = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan FallbackInterval = TimeSpan.FromSeconds(30);

    private readonly IVpnConnectionService _vpnService;
    private readonly Func<IReadOnlyList<ConnectionRecord>> _loadConnections;
    private readonly FileLogger _logger;
    private readonly Debouncer _debouncer;
    private readonly System.Windows.Forms.Timer _fallbackTimer;
    private readonly SynchronizationContext? _uiContext;
    private readonly object _cacheLock = new();
    private Dictionary<string, ConnectionRuntimeState> _cache = new(StringComparer.OrdinalIgnoreCase);
    private readonly IConnectionChangeNotifier? _notifier;
    private int _refreshing;
    private int _refreshPending;
    private bool _disposed;

    /// <summary>Se entrega en el hilo de interfaz (ver comentario de la clase). Los suscriptores NO necesitan BeginInvoke propio.</summary>
    public event Action? StateChanged;

    public ConnectionStateService(
        IVpnConnectionService vpnService, Func<IReadOnlyList<ConnectionRecord>> loadConnections, FileLogger logger,
        IConnectionChangeNotifier? notifier = null)
    {
        _vpnService = vpnService;
        _loadConnections = loadConnections;
        _logger = logger;
        // Si se construye antes de que WinForms haya instalado su propio
        // SynchronizationContext (orden de inicializacion no garantizado:
        // depende de si ya se creo el handle de algun control), se crea uno
        // aqui mismo: nunca debe quedarse sin forma de volver al hilo de
        // interfaz para entregar StateChanged.
        _uiContext = SynchronizationContext.Current ?? new System.Windows.Forms.WindowsFormsSynchronizationContext();
        _debouncer = new Debouncer(DebounceWindow, () => _ = RefreshAsync());

        // Notificaciones de RAS (prompt 12.8, punto 2): conexion establecida o
        // caida desde cualquier sitio (esta app, rasphone, panel de Windows,
        // perdida de red) -> refresco inmediato, sin el debounce de red.
        _notifier = notifier;
        if (_notifier is not null)
        {
            _notifier.Changed += OnRasChanged;
        }

        NetworkChange.NetworkAddressChanged += OnNetworkChanged;
        NetworkChange.NetworkAvailabilityChanged += OnNetworkAvailabilityChanged;

        _fallbackTimer = new System.Windows.Forms.Timer { Interval = (int)FallbackInterval.TotalMilliseconds };
        _fallbackTimer.Tick += (_, _) => RequestRefresh();
        _fallbackTimer.Start();
    }

    private void OnRasChanged() => _ = RefreshAsync();

    private void OnNetworkChanged(object? sender, EventArgs e) => RequestRefresh();

    private void OnNetworkAvailabilityChanged(object? sender, NetworkAvailabilityEventArgs e) => RequestRefresh();

    public void RequestRefresh() => _debouncer.Trigger();

    public ConnectionRuntimeState GetState(string connectionName)
    {
        lock (_cacheLock)
        {
            return _cache.TryGetValue(connectionName, out var state) ? state : default;
        }
    }

    /// <summary>
    /// Recalcula el estado de todas las conexiones en un hilo de fondo. Si ya
    /// hay un refresco en marcha, este se ignora (el que esta en marcha ya va
    /// a dejar el cache al dia; encolar otro no aporta nada, solo trabajo
    /// duplicado).
    /// </summary>
    public async Task RefreshAsync()
    {
        if (Interlocked.Exchange(ref _refreshing, 1) == 1)
        {
            // Ya hay uno en marcha, pero pudo leer el estado ANTES de este
            // cambio: se anota para repetir una vez al terminar (sin esto, una
            // notificacion de RAS que llega en mitad de un refresco se perderia).
            Interlocked.Exchange(ref _refreshPending, 1);
            return;
        }

        try
        {
          do
          {
            Interlocked.Exchange(ref _refreshPending, 0);
            var connections = _loadConnections();
            var newCache = await Task.Run(() =>
            {
                var result = new Dictionary<string, ConnectionRuntimeState>(StringComparer.OrdinalIgnoreCase);
                foreach (var connection in connections)
                {
                    result[connection.Cn] = ReadState(connection.Cn);
                }
                return result;
            }).ConfigureAwait(false);

            lock (_cacheLock)
            {
                _cache = newCache;
            }

            RaiseStateChanged();
          } while (Volatile.Read(ref _refreshPending) == 1 && !_disposed);
        }
        finally
        {
            Interlocked.Exchange(ref _refreshing, 0);
        }
    }

    private ConnectionRuntimeState ReadState(string cn)
    {
        try
        {
            var exists = _vpnService.ConnectionExists(cn);
            if (!exists)
            {
                return default;
            }
            var phase = _vpnService.GetConnectionPhase(cn).Phase;
            var connected = phase == RasPhase.Connected;
            var ip = connected ? _vpnService.GetAssignedIPv4Address(cn) : null;
            return new ConnectionRuntimeState(connected, ip, Connecting: phase == RasPhase.Connecting);
        }
        catch (Exception ex)
        {
            _logger.Warn($"No se ha podido leer el estado de \"{cn}\": {ex.Message}");
            return default;
        }
    }

    private void RaiseStateChanged()
    {
        if (_disposed)
        {
            return;
        }
        if (_uiContext is not null)
        {
            _uiContext.Post(_ => StateChanged?.Invoke(), null);
        }
        else
        {
            StateChanged?.Invoke();
        }
    }

    public void Dispose()
    {
        _disposed = true;
        if (_notifier is not null)
        {
            _notifier.Changed -= OnRasChanged;
            _notifier.Dispose();
        }
        NetworkChange.NetworkAddressChanged -= OnNetworkChanged;
        NetworkChange.NetworkAvailabilityChanged -= OnNetworkAvailabilityChanged;
        _fallbackTimer.Stop();
        _fallbackTimer.Dispose();
        _debouncer.Dispose();
    }
}
