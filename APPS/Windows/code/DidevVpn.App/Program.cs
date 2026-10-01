using DidevVpn.App.Orchestration;
using DidevVpn.App.Services;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App;

internal static class Program
{
    /// <summary>Lo usa la tarea programada de renovacion (ver TaskSchedulerService): renueva si toca y termina, sin bandeja.</summary>
    public const string RenewSilentArgument = "--renew-silent";

    /// <summary>Lo usa el instalador MSI (Package.wxs, custom action UninstallCleanupCmd, INMEDIATA) al desinstalar.</summary>
    public const string UninstallCleanupArgument = "--uninstall-cleanup";

    [STAThread]
    private static int Main(string[] args)
    {
        // Modo oculto: un proceso YA elevado (runas), lanzado por
        // RootCertificateElevatedInstaller, que solo instala un certificado
        // en LocalMachine\Root y termina. No arranca la bandeja ni nada mas.
        if (args.Length == 2 && args[0] == RootCertificateElevatedInstaller.ElevatedInstallArgument)
        {
            return RootCertificateElevatedInstaller.RunElevatedInstall(args[1]);
        }

        if (args.Length == 1 && args[0] == RenewSilentArgument)
        {
            return RunRenewSilent();
        }

        if (args.Length >= 1 && args[0] == UninstallCleanupArgument)
        {
            return RunUninstallCleanup(args);
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext());
        return 0;
    }

    /// <summary>
    /// Renueva TODAS las conexiones de este usuario (cliente generico desde
    /// el prompt 12.5: puede haber varias). Cada una se procesa por separado
    /// -un fallo en una no debe impedir renovar las demas-; el codigo de
    /// salida refleja el peor resultado (2 si alguna quedo bloqueada por
    /// version minima, 1 si alguna fallo de verdad, 0 si todas fueron bien o
    /// no habia ninguna).
    /// </summary>
    private static int RunRenewSilent()
    {
        var logger = new FileLogger();
        var connections = ConnectionStore.List();
        if (connections.Count == 0)
        {
            logger.Info("--renew-silent: no hay ninguna conexion configurada todavia, nada que hacer.");
            return 0;
        }

        var worstExitCode = 0;
        foreach (var connection in connections)
        {
            try
            {
                var orchestrator = new RenewalOrchestrator(
                    new CertificateEnrollmentService(),
                    new EstClient(),
                    new VpnConnectionService(logger),
                    new MessageBoxUserConfirmations(),
                    logger,
                    AppVersionHelper.GetAppVersion());
                var result = orchestrator.RenewIfDueAsync(connection, CancellationToken.None).GetAwaiter().GetResult();
                logger.Info($"--renew-silent: \"{connection.Cn}\" -> {result.Outcome}.");
                if (result.Outcome == RenewalOutcome.BlockedByMinAppVersion)
                {
                    worstExitCode = Math.Max(worstExitCode, 2);
                }
            }
            catch (Exception ex)
            {
                logger.Error($"--renew-silent: fallo renovando \"{connection.Cn}\"", ex);
                worstExitCode = Math.Max(worstExitCode, 1);
            }
        }
        return worstExitCode;
    }

    /// <summary>
    /// "--uninstall-cleanup [--uilevel=N]": N es la propiedad MSI UILevel tal
    /// cual la pasa Package.wxs ("[UILevel]"), para saber si es una
    /// desinstalacion silenciosa (msiexec /qn) en la que no se puede
    /// preguntar nada -ver DidevVpn.Core.Versioning.MsiUiLevel-.
    /// </summary>
    private static int RunUninstallCleanup(string[] args)
    {
        var uiLevel = MsiUiLevel.DefaultWhenUnspecified;
        foreach (var arg in args)
        {
            const string prefix = "--uilevel=";
            if (arg.StartsWith(prefix, StringComparison.Ordinal) && int.TryParse(arg[prefix.Length..], out var parsed))
            {
                uiLevel = parsed;
            }
        }

        var logger = new FileLogger();
        return UninstallCleanupRunner.Run(
            uiLevel,
            new CertificateEnrollmentService(),
            new VpnConnectionService(logger),
            logger);
    }
}
