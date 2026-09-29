using DidevVpn.App.Orchestration;
using DidevVpn.App.Services;

namespace DidevVpn.App;

internal static class Program
{
    /// <summary>Lo usa la tarea programada de renovacion (ver TaskSchedulerService): renueva si toca y termina, sin bandeja.</summary>
    public const string RenewSilentArgument = "--renew-silent";

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
}
