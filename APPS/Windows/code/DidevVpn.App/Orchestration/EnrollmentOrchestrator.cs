using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;
using DidevVpn.Core.Ipsec;
using DidevVpn.Core.Profile;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App.Orchestration;

/// <summary>
/// El panel exige actualizar la app (GET /status, minAppVersion) antes de
/// completar el alta: se lanza DESPUES de simpleenroll (el unico momento en
/// que ya hay un certificado con el que hacer esa llamada -/status exige TLS
/// mutuo, y antes de simpleenroll el dispositivo no tiene ningun certificado
/// todavia-) pero ANTES de instalar el certificado o tocar la conexion VPN:
/// no queda nada a medio configurar. El token de alta del perfil YA se ha
/// gastado en ese simpleenroll (es de un solo uso): quien vea este error
/// tiene que actualizar la app Y pedir un token nuevo desde el panel, no solo
/// reintentar. Ver la seccion "Version minima" del README para el porque de
/// este orden (el perfil no trae minAppVersion: solo /status lo sabe).
/// </summary>
internal sealed class MinAppVersionRequiredException : Exception
{
    public MinAppVersionRequiredException(string message) : base(message)
    {
    }
}

/// <summary>
/// Alta de un dispositivo a partir de un perfil ya verificado (ver
/// ProfileVerifier: firma valida, variante "full", no caducado). Orden fijo,
/// parando en el primer fallo -nunca deja una conexion VPN configurada con un
/// certificado a medio instalar, ni un certificado instalado sin la conexion
/// que lo usa-:
///   1. La huella de la raiz que trae el perfil coincide con la cadena que
///      trae el propio perfil (deberian ser consistentes por construccion,
///      ya que los dos van dentro del mismo payload firmado; si no
///      coincidieran seria un perfil corrupto o un bug del panel, no un
///      ataque -la firma ya cubre el payload entero-).
///   2. La raiz esta en LocalMachine\Root (root a los dos: el certificado del
///      propio gateway IKE lo exige ahi, no solo el de RADIUS -ver
///      APPS/Windows/NOTAS-prompt-12-en-pausa.md, riesgo 1-); si no, pide
///      la elevacion de un solo uso.
///   3. Clave del dispositivo: TPM primero, con confirmacion explicita si
///      hay que caer a software.
///   4. simpleenroll con el token del perfil.
///   5. Version minima de la app (ver MinAppVersionRequiredException): si el
///      panel exige una version superior a esta, se aborta AQUI, sin instalar
///      el certificado ni tocar la conexion VPN.
///   6. Instala el certificado emitido, enlazado a esa misma clave.
///   7. Configura la conexion IKEv2/EAP-TLS "didev VPN".
///   8. Guarda el estado del dispositivo para poder renovar despues.
/// </summary>
internal sealed class EnrollmentOrchestrator
{
    private readonly ICertificateEnrollmentService _certificateService;
    private readonly IEstClient _estClient;
    private readonly IVpnConnectionService _vpnConnectionService;
    private readonly IRootCertificateStoreService _rootCertificateStore;
    private readonly IUserConfirmations _confirmations;
    private readonly FileLogger _logger;
    private readonly AppVersion _currentAppVersion;

    public EnrollmentOrchestrator(
        ICertificateEnrollmentService certificateService,
        IEstClient estClient,
        IVpnConnectionService vpnConnectionService,
        IRootCertificateStoreService rootCertificateStore,
        IUserConfirmations confirmations,
        FileLogger logger,
        AppVersion currentAppVersion)
    {
        _certificateService = certificateService;
        _estClient = estClient;
        _vpnConnectionService = vpnConnectionService;
        _rootCertificateStore = rootCertificateStore;
        _confirmations = confirmations;
        _logger = logger;
        _currentAppVersion = currentAppVersion;
    }

    public async Task<DeviceState> EnrollAsync(ProvisioningProfile profile, CancellationToken ct)
    {
        _logger.Info($"Alta: empezando para \"{profile.Cn}\" (modo {profile.TunnelMode}).");

        var chain = EstTrustValidator.ParseChain(profile.CaChainPem!);
        var root = chain.FirstOrDefault(c => c.SubjectName.RawData.AsSpan().SequenceEqual(c.IssuerName.RawData))
                   ?? throw new InvalidOperationException("El perfil no incluye ninguna raiz autofirmada en su cadena de CA.");
        var actualRootSha256 = RootCertificateStoreService.ComputeSha256Thumbprint(root);
        if (!string.Equals(actualRootSha256, profile.RootCaSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "El perfil es inconsistente: la huella de la raiz no coincide con la cadena que trae. Pide uno nuevo desde el panel.");
        }

        EnsureRootTrusted(root, actualRootSha256);

        using var key = CreateDeviceKey(profile.Cn);

        _logger.Info($"Alta: pidiendo certificado por simpleenroll para \"{profile.Cn}\".");
        var estBaseUri = EstBaseUrl.Normalize(profile.EstBaseUrl);
        X509Certificate2 issuedCertificate;
        try
        {
            issuedCertificate = await _estClient
                .SimpleEnrollAsync(estBaseUri, profile.Cn, profile.EnrollToken, key.CsrDer, chain, ct)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.Error("Alta: simpleenroll ha fallado", ex);
            throw;
        }

        await EnsureMinAppVersionAsync(issuedCertificate, key, estBaseUri, chain, ct).ConfigureAwait(false);

        var installedCertificate = _certificateService.InstallIssuedCertificate(issuedCertificate, key);
        _logger.Info($"Alta: certificado instalado (huella {installedCertificate.Thumbprint}).");

        ConfigureVpnConnection(profile, root);

        var state = new DeviceState
        {
            Cn = profile.Cn,
            Server = profile.Server,
            EstBaseUrl = profile.EstBaseUrl,
            CaChainPem = profile.CaChainPem!,
            RootCaSha256 = profile.RootCaSha256,
            CertificateThumbprint = installedCertificate.Thumbprint,
            IsTpmBacked = key.IsTpmBacked,
            TunnelMode = profile.TunnelMode,
            SplitRoutes = new List<string>(profile.SplitRoutes),
            Dns = profile.Dns,
            IkeEncryption = profile.Ike.Encryption,
            IkeIntegrity = profile.Ike.Prf,
            IkeDhGroup = profile.Ike.DhGroup,
            EspEncryption = profile.Esp.Encryption,
            EspPfsGroup = profile.Esp.DhGroup,
            LastEnrolledAtUtc = DateTimeOffset.UtcNow,
        };
        DeviceStateStore.Save(state);
        _logger.Info($"Alta: completada para \"{profile.Cn}\".");
        return state;
    }

    /// <summary>
    /// Comprueba GET /status (TLS mutuo, con el certificado RECIEN EMITIDO
    /// por simpleenroll pero AUN SIN INSTALAR: se enlaza a la clave en
    /// memoria con CopyWithPrivateKey, sin tocar el almacen de certificados
    /// todavia). Si el panel exige una version de app superior a esta,
    /// aborta el alta sin instalar nada: mejor eso que dejar un dispositivo
    /// funcionando con una app que el panel ya considera obsoleta. Un fallo
    /// de red al comprobarlo NO bloquea el alta (best-effort: la version
    /// minima es una salvaguarda adicional, no la unica forma de controlar
    /// que puede darse de alta -eso ya lo hace el admin al generar el token-).
    /// </summary>
    private async Task EnsureMinAppVersionAsync(
        X509Certificate2 issuedCertificate, EnrolledKey key, Uri estBaseUri, X509Certificate2Collection chain, CancellationToken ct)
    {
        EstStatus status;
        try
        {
            using var ecdsa = new ECDsaCng(key.CngKey);
            using var certificateWithKeyForStatusCheck = issuedCertificate.CopyWithPrivateKey(ecdsa);
            status = await _estClient.GetStatusAsync(estBaseUri, certificateWithKeyForStatusCheck, chain, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.Warn($"Alta: no se ha podido comprobar la version minima de app tras simpleenroll (se continua sin bloquear): {ex.Message}");
            return;
        }

        if (AppVersion.TryParse(status.MinAppVersion, out var minVersion) && _currentAppVersion.IsBelow(minVersion))
        {
            throw new MinAppVersionRequiredException(
                $"El panel exige la version {minVersion} o superior de didev VPN (esta instalada la {_currentAppVersion}). " +
                "El certificado recien emitido NO se ha instalado. Actualiza la app y pide un token de alta nuevo desde " +
                "el panel: el que acabas de usar ya se ha consumido.");
        }
    }

    private void EnsureRootTrusted(X509Certificate2 root, string rootSha256)
    {
        if (_rootCertificateStore.IsInstalled(StoreLocation.LocalMachine, rootSha256))
        {
            return;
        }

        _logger.Info("Alta: la raiz de didev no esta en LocalMachine\\Root todavia, pidiendo elevacion.");
        if (!_confirmations.ConfirmRootCertificateElevation())
        {
            throw new OperationCanceledException(
                "Alta cancelada: hace falta confiar en la raiz de didev (una elevacion de administrador, una unica vez) para poder conectar.");
        }

        if (!RootCertificateElevatedInstaller.InstallWithUacPrompt(root))
        {
            throw new InvalidOperationException(
                "No se ha podido instalar la raiz de confianza (se rechazo el permiso de administrador, o la instalacion fallo).");
        }

        _logger.Info("Alta: raiz instalada en LocalMachine\\Root.");
    }

    private EnrolledKey CreateDeviceKey(string cn)
    {
        if (_certificateService.TryCreateTpmBackedKey(cn, out var tpmKey, out var failure))
        {
            _logger.Info("Alta: clave generada en el TPM.");
            return tpmKey!;
        }

        _logger.Warn($"Alta: no se pudo usar el TPM ({failure?.Message}). Pidiendo confirmacion para clave por software.");
        if (!_confirmations.ConfirmSoftwareKeyFallback(failure?.Message ?? "TPM no disponible"))
        {
            throw new OperationCanceledException(
                "Alta cancelada: no hay TPM disponible y no se confirmo continuar con una clave por software.");
        }

        return _certificateService.CreateSoftwareBackedKey(cn);
    }

    private void ConfigureVpnConnection(ProvisioningProfile profile, X509Certificate2 root)
    {
        var eapServerName = profile.AaaId.StartsWith("CN=", StringComparison.OrdinalIgnoreCase)
            ? profile.AaaId[3..]
            : profile.AaaId;

        var spec = new VpnConnectionSpec(
            ConnectionName: AppPaths.ConnectionName,
            ServerAddress: profile.Server,
            EapServerName: eapServerName,
            RootCertificateThumbprintSha1: root.Thumbprint,
            SplitTunneling: profile.TunnelMode == Core.Profile.TunnelMode.Split,
            SplitRoutes: profile.SplitRoutes,
            IkeEncryption: WindowsIpsecProposalMapper.MapEncryption(profile.Ike.Encryption),
            IkeIntegrity: WindowsIpsecProposalMapper.MapIntegrityOrPrf(profile.Ike.Prf),
            IkeDhGroup: WindowsIpsecProposalMapper.MapDhOrPfsGroup(profile.Ike.DhGroup),
            EspEncryption: WindowsIpsecProposalMapper.MapEncryption(profile.Esp.Encryption),
            EspPfsGroup: WindowsIpsecProposalMapper.MapDhOrPfsGroup(profile.Esp.DhGroup));

        _vpnConnectionService.CreateOrUpdateConnection(spec);
        _logger.Info($"Alta: conexion \"{AppPaths.ConnectionName}\" configurada (servidor {profile.Server}).");
    }
}
