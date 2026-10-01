using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;
using DidevVpn.Core.Profile;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App.Orchestration;

internal enum RenewalOutcome
{
    NotDue,
    Renewed,
    BlockedByMinAppVersion,
}

internal sealed record RenewalResult(RenewalOutcome Outcome, string? Message = null);

/// <summary>
/// Comprueba GET /status con TLS mutuo usando el certificado vigente y
/// renueva por simplereenroll si toca, para UNA conexion (el llamador itera
/// todas las de ConnectionStore.List()). La app NO necesita reconfigurar la
/// conexion VPN tras renovar: la conexion selecciona el certificado de
/// CurrentUser\My por el filtro EAP (SimpleCertSelection), no por huella fija,
/// asi que un certificado nuevo con el mismo CN ya vale sin tocar nada mas.
/// </summary>
internal sealed class RenewalOrchestrator
{
    private readonly ICertificateEnrollmentService _certificateService;
    private readonly IEstClient _estClient;
    private readonly IVpnConnectionService _vpnConnectionService;
    private readonly IUserConfirmations _confirmations;
    private readonly FileLogger _logger;
    private readonly AppVersion _currentAppVersion;
    private readonly ICertificateLifecycle _lifecycle;

    public RenewalOrchestrator(
        ICertificateEnrollmentService certificateService,
        IEstClient estClient,
        IVpnConnectionService vpnConnectionService,
        IUserConfirmations confirmations,
        FileLogger logger,
        AppVersion currentAppVersion,
        ICertificateLifecycle lifecycle)
    {
        _lifecycle = lifecycle;
        _certificateService = certificateService;
        _estClient = estClient;
        _vpnConnectionService = vpnConnectionService;
        _confirmations = confirmations;
        _logger = logger;
        _currentAppVersion = currentAppVersion;
    }

    public async Task<RenewalResult> RenewIfDueAsync(ConnectionRecord state, CancellationToken ct)
    {
        using var currentCertificate = FindCurrentCertificate(state)
            ?? throw new InvalidOperationException(
                $"No se encuentra en CurrentUser\\My el certificado de \"{state.Cn}\" (huella {state.CertificateThumbprint}). " +
                "Hay que repetir el alta desde el panel.");

        var chain = EstTrustValidator.ParseChain(state.CaChainPem);
        var estBaseUri = EstBaseUrl.Normalize(state.EstBaseUrl);

        var status = await _estClient.GetStatusAsync(estBaseUri, currentCertificate, chain, ct).ConfigureAwait(false);

        if (AppVersion.TryParse(status.MinAppVersion, out var minVersion) && _currentAppVersion.IsBelow(minVersion))
        {
            var message =
                $"El panel exige la version {minVersion} o superior de didev VPN (esta instalada la {_currentAppVersion}). " +
                "Actualiza la app antes de poder renovar el certificado.";
            _logger.Warn($"Renovacion bloqueada por version minima: {message}");
            return new RenewalResult(RenewalOutcome.BlockedByMinAppVersion, message);
        }

        if (!IsRenewalDue(status, DateTimeOffset.UtcNow, Environment.GetEnvironmentVariable(RenewThresholdVariable), out var forcedByThreshold))
        {
            _logger.Info($"Renovacion: \"{state.Cn}\" todavia vigente (caduca {status.NotAfter:u}).");
            return new RenewalResult(RenewalOutcome.NotDue);
        }

        if (forcedByThreshold)
        {
            _logger.Warn($"Renovacion FORZADA por {RenewThresholdVariable} (solo pruebas): el panel decia que aun no tocaba.");
        }
        _logger.Info($"Renovacion: toca renovar \"{state.Cn}\" (caduca {status.NotAfter:u}). Generando clave nueva.");

        InstalledCertificateResult enrolled;
        try
        {
            enrolled = await _certificateService.EnrollAsync(
                state.Cn,
                _confirmations.ConfirmSoftwareKeyFallback,
                (csrDer, enrollCt) => _estClient.SimpleReenrollAsync(estBaseUri, currentCertificate, csrDer, chain, enrollCt),
                ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.Error("Renovacion: simplereenroll/instalacion ha fallado, se conserva el certificado anterior", ex);
            throw;
        }

        using var installedCertificate = enrolled.Certificate;
        _logger.Info($"Renovacion: certificado nuevo instalado (huella {installedCertificate.Thumbprint}).");

        // ORDEN ESTRICTO (el certificado viejo se borra el ULTIMO y solo si todo lo anterior salio bien):
        //  1. credenciales EAP de la entrada apuntando al certificado NUEVO (otra huella: si no, la
        //     conexion seguiria usando el viejo);
        //  2. comprobar que la entrada existe y esas credenciales quedaron guardadas;
        //  3. registrar el nuevo y guardar el estado de la conexion con la huella nueva;
        //  4. SOLO ENTONCES borrar el viejo y limpiar.
        // Si 1, 2 o 3 fallan, se lanza y el certificado anterior se conserva.
        _vpnConnectionService.SaveEapCredentials(state.Cn, installedCertificate);
        ConnectionConfigurationCheck.EnsureConfigured(_vpnConnectionService, state.Cn, installedCertificate.Thumbprint);

        var previousThumbprint = currentCertificate.Thumbprint;
        _lifecycle.Register(installedCertificate, state.Cn, state.Server, state.Cn);
        state.CertificateThumbprint = installedCertificate.Thumbprint;
        state.IsTpmBacked = enrolled.IsTpmBacked;
        state.LastEnrolledAtUtc = DateTimeOffset.UtcNow;
        ConnectionStore.Save(state);

        try
        {
            _lifecycle.RemoveWithKey(previousThumbprint);
        }
        catch (Exception ex)
        {
            _logger.Warn($"Renovacion: no se ha podido borrar el certificado anterior (no es grave, la proxima limpieza lo intentara): {ex.Message}");
        }

        try
        {
            _lifecycle.CleanupStale(state.Cn, state.Server, installedCertificate, ConnectionStore.ListOrNull()?.Select(c => c.Cn).ToList());
        }
        catch (Exception ex)
        {
            _logger.Warn($"Renovacion: no se ha podido limpiar certificados antiguos (no es grave): {ex.Message}");
        }

        _logger.Info($"Renovacion: completada para \"{state.Cn}\".");
        return new RenewalResult(RenewalOutcome.Renewed);
    }

    /// <summary>SOLO PARA PRUEBAS: si el certificado caduca en menos de estos dias, se renueva aunque el panel diga que aun no toca (p.ej. 40 con certificados de 30 dias).</summary>
    internal const string RenewThresholdVariable = "DIDEVVPN_RENEW_THRESHOLD_DAYS";

    internal static bool IsRenewalDue(EstStatus status, DateTimeOffset now, string? thresholdDays, out bool forcedByThreshold)
    {
        forcedByThreshold = false;
        if (status.RenewDue)
        {
            return true;
        }
        if (int.TryParse(thresholdDays, out var days) && days > 0 && status.NotAfter - now <= TimeSpan.FromDays(days))
        {
            forcedByThreshold = true;
            return true;
        }
        return false;
    }

    private static X509Certificate2? FindCurrentCertificate(ConnectionRecord state)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        var matches = store.Certificates.Find(X509FindType.FindByThumbprint, state.CertificateThumbprint, validOnly: false);
        return matches.Count > 0 ? new X509Certificate2(matches[0]) : null;
    }
}
