namespace DidevVpn.App.Services.Ras;

/// <summary>Resultado de esperar a que una conexion se asiente tras lanzarla.</summary>
internal enum WaitOutcome
{
    Connected,
    Failed,
    TimedOut,
}

internal readonly record struct WaitResult(WaitOutcome Outcome, int Error = 0);

/// <summary>
/// Maquina de estados de "lanzar conexion y esperar" (prompt 12.8, punto 2):
/// el resultado NO se deduce del codigo de salida de rasdial/rasphone (rasphone
/// sale al instante y es la persona quien marca; rasdial puede salir 0 antes de
/// que el tunel este arriba), sino de la fase real de RAS, sondeada hasta
/// Connected, error o el limite de tiempo. Separado de RAS (recibe una funcion
/// que lee la fase) para probarlo sin Windows.
/// </summary>
internal static class ConnectionWaiter
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan DefaultPollInterval = TimeSpan.FromMilliseconds(500);

    /// <summary>Tope absoluto con un dialogo de Windows abierto (rasphone): la persona puede tardar en elegir.</summary>
    public static readonly TimeSpan DefaultMaxDialogWait = TimeSpan.FromSeconds(120);

    public static async Task<WaitResult> WaitUntilSettledAsync(
        Func<RasPhaseInfo> readPhase,
        TimeSpan timeout,
        TimeSpan pollInterval,
        CancellationToken ct = default,
        Func<bool>? interactiveDialogOpen = null,
        TimeSpan? maxDialogWait = null)
    {
        var overall = DateTime.UtcNow;
        var started = overall;
        var dialogLimit = maxDialogWait ?? DefaultMaxDialogWait;
        var sawConnecting = false;

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var info = readPhase();
            switch (info.Phase)
            {
                case RasPhase.Connected:
                    return new WaitResult(WaitOutcome.Connected);
                case RasPhase.Failed:
                    return new WaitResult(WaitOutcome.Failed, info.Error);
                case RasPhase.Connecting:
                    sawConnecting = true;
                    break;
                case RasPhase.Disconnected:
                    // Marcando y de pronto ya no esta, sin error: se cayo (p.ej.
                    // la persona cancelo el dialogo nativo). Antes de haber
                    // visto "marcando" es normal: rasphone aun no ha empezado.
                    if (sawConnecting)
                    {
                        return new WaitResult(WaitOutcome.Failed);
                    }
                    break;
            }

            // Con un dialogo de Windows abierto el limite no corre (el reloj se
            // reinicia mientras siga abierto) hasta un tope de dialogLimit; el
            // limite normal empieza cuando el dialogo se cierra.
            if (interactiveDialogOpen is not null && interactiveDialogOpen() && DateTime.UtcNow - overall < dialogLimit)
            {
                started = DateTime.UtcNow;
            }

            if (DateTime.UtcNow - started >= timeout)
            {
                return new WaitResult(WaitOutcome.TimedOut);
            }
            await Task.Delay(pollInterval, ct).ConfigureAwait(false);
        }
    }
}
