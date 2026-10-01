namespace DidevVpn.Core.Net;

/// <summary>
/// Ejecuta una accion como mucho una vez por cada racha de disparos que
/// lleguen mas seguidos que <c>window</c> (p.ej. varios
/// NetworkAddressChanged seguidos al reconectar un adaptador): cada
/// <see cref="Trigger"/> reinicia la espera, y la accion solo se ejecuta
/// cuando pasa "window" sin que llegue un disparo nuevo. El reloj es
/// inyectable (<see cref="IDelayScheduler"/>) para poder probarlo sin
/// esperas de verdad.
/// </summary>
public interface IDelayScheduler
{
    Task Delay(TimeSpan delay, CancellationToken ct);
}

/// <summary>Implementacion real: <see cref="Task.Delay(TimeSpan, CancellationToken)"/>.</summary>
public sealed class TaskDelayScheduler : IDelayScheduler
{
    public Task Delay(TimeSpan delay, CancellationToken ct) => Task.Delay(delay, ct);
}

public sealed class Debouncer : IDisposable
{
    private readonly TimeSpan _window;
    private readonly Action _action;
    private readonly IDelayScheduler _scheduler;
    private readonly object _lock = new();
    private CancellationTokenSource? _pending;

    public Debouncer(TimeSpan window, Action action, IDelayScheduler? scheduler = null)
    {
        if (window <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(window), "La ventana de debounce debe ser positiva.");
        }
        _window = window;
        _action = action ?? throw new ArgumentNullException(nameof(action));
        _scheduler = scheduler ?? new TaskDelayScheduler();
    }

    /// <summary>Cuantas veces se ha ejecutado la accion de verdad (para tests).</summary>
    public int FireCount { get; private set; }

    public void Trigger()
    {
        CancellationTokenSource cts;
        lock (_lock)
        {
            _pending?.Cancel();
            _pending?.Dispose();
            cts = new CancellationTokenSource();
            _pending = cts;
        }

        _ = RunAfterDelayAsync(cts);
    }

    private async Task RunAfterDelayAsync(CancellationTokenSource cts)
    {
        try
        {
            await _scheduler.Delay(_window, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return; // superado por un Trigger() mas reciente
        }

        lock (_lock)
        {
            // Solo dispara si este sigue siendo el ultimo Trigger() pendiente
            // (evita una carrera rarisima donde el delay termina justo cuando
            // otro Trigger() ya ha reemplazado _pending).
            if (!ReferenceEquals(_pending, cts))
            {
                return;
            }
            FireCount++;
        }
        _action();
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _pending?.Cancel();
            _pending?.Dispose();
            _pending = null;
        }
    }
}
