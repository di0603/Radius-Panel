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

    public RenewalOrchestrator(
        ICertificateEnrollmentService certificateService,
        IEstClient estClient,
        IVpnConnectionService vpnConnectionService,
        IUserConfirmations confirmations,
        FileLogger logger,
        AppVersion currentAppVersion)
    {
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

        if (!status.RenewDue)
        {
            _logger.Info($"Renovacion: \"{state.Cn}\" todavia vigente (caduca {status.NotAfter:u}).");
            return new RenewalResult(RenewalOutcome.NotDue);
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
        _logger.Info($"Renovacion: certificado nuevo instalado (huella {installedCertificate.Thumbprint}). Borrando el anterior.");

        // El certificado nuevo es OTRO (otra huella): hay que apuntar a el las
        // credenciales EAP guardadas, o la conexion seguiria pidiendo/usando el viejo.
        _vpnConnectionService.SaveEapCredentials(state.Cn, installedCertificate);

        _certificateService.RemoveCertificate(currentCertificate);

        state.CertificateThumbprint = installedCertificate.Thumbprint;
        state.IsTpmBacked = enrolled.IsTpmBacked;
        state.LastEnrolledAtUtc = DateTimeOffset.UtcNow;
        ConnectionStore.Save(state);

        _logger.Info($"Renovacion: completada para \"{state.Cn}\".");
        return new RenewalResult(RenewalOutcome.Renewed);
    }

    private static X509Certificate2? FindCurrentCertificate(ConnectionRecord state)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        var matches = store.Certificates.Find(X509FindType.FindByThumbprint, state.CertificateThumbprint, validOnly: false);
        return matches.Count > 0 ? new X509Certificate2(matches[0]) : null;
    }
}
