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

    private static int RunRenewSilent()
    {
        var logger = new FileLogger();
        var state = DeviceStateStore.Load();
        if (state is null)
        {
            logger.Info("--renew-silent: no hay ningun dispositivo dado de alta todavia, nada que hacer.");
            return 0;
        }

        try
        {
            var orchestrator = new RenewalOrchestrator(
                new CertificateEnrollmentService(),
                new EstClient(),
                new MessageBoxUserConfirmations(),
                logger,
                AppVersionHelper.GetAppVersion());
            var result = orchestrator.RenewIfDueAsync(state, CancellationToken.None).GetAwaiter().GetResult();
            logger.Info($"--renew-silent: resultado {result.Outcome}.");
            return result.Outcome == RenewalOutcome.BlockedByMinAppVersion ? 2 : 0;
        }
        catch (Exception ex)
        {
            logger.Error("--renew-silent: fallo al renovar", ex);
            return 1;
        }
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
            new VpnConnectionService(),
            new RootCertificateStoreService(),
            logger);
    }
}
