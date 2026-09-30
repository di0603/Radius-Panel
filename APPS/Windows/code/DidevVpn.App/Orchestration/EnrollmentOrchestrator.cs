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
/// Confianza en el primer uso (TOFU, prompt 12.5): esta conexion YA tenia un
/// ancla guardada (signerKeySha256/rootCaSha256 de una importacion anterior)
/// y el perfil que se acaba de importar trae una identidad distinta. Se
/// rechaza SIEMPRE, sin ofrecer "aceptar de todas formas" desde este punto
/// del flujo -cambiar de ancla es una decision aparte y deliberada: quitar
/// la conexion y volver a anadirla-.
/// </summary>
internal sealed class TrustAnchorMismatchException : Exception
{
    public TrustAnchorMismatchException(string message) : base(message)
    {
    }
}

/// <summary>
/// Alta de un dispositivo a partir de un perfil ya verificado por
/// ProfileVerifier (firma autoconsistente, variante "full", no caducado) -
/// pero ProfileVerifier NO sabe nada de confianza: eso lo decide esta clase,
/// comparando con el ancla guardada de la conexion (o pidiendo confirmacion
/// si es la primera vez, ver IUserConfirmations.ConfirmTrustAnchor). Orden
/// fijo, parando en el primer fallo -nunca deja una conexion VPN configurada
/// con un certificado a medio instalar, ni un certificado instalado sin la
/// conexion que lo usa-:
///   1. La huella de la raiz que trae el perfil coincide con la cadena que
///      trae el propio perfil (deberian ser consistentes por construccion,
///      ya que los dos van dentro del mismo payload firmado; si no
///      coincidieran seria un perfil corrupto o un bug del panel, no un
///      ataque -la firma ya cubre el payload entero-).
///   2. Confianza en el primer uso: si esta conexion (por "cn") ya tiene un
///      ancla guardada, el signerKeySha256/rootCaSha256 de este perfil deben
///      coincidir EXACTAMENTE (si no, TrustAnchorMismatchException, sin
///      opcion de aceptar). Si es la primera vez (sin ancla), se pide
///      confirmacion explicita mostrando las huellas; sin confirmar, no se
///      continua.
///   3. La raiz esta en LocalMachine\Root (el certificado del propio gateway
///      IKE lo exige ahi, no solo el de RADIUS -ver
///      APPS/Windows/NOTAS-prompt-12-en-pausa.md, riesgo 1-); si no, pide
///      la elevacion de un solo uso.
///   4. Clave del dispositivo + simpleenroll + instalacion, TODO junto en
///      ICertificateEnrollmentService.EnrollAsync (TPM primero, con
///      confirmacion explicita si hay que caer a software): con CertEnroll
///      (COM) instalar y enlazar la clave es un unico paso indivisible -no
///      hay forma de "asociar sin persistir" para comprobar algo antes de
///      instalar de verdad, a diferencia del enfoque anterior-.
///   5. Version minima de la app (ver MinAppVersionRequiredException),
///      comprobada YA CON el certificado instalado: si el panel exige una
///      version superior a esta, se desinstala el certificado que se acaba
///      de poner (ver el catch en EnrollAsync) y se aborta, sin tocar la
///      conexion VPN.
///   6. Configura la conexion IKEv2/EAP-TLS, nombrada "cn" (cada conexion de
///      este cliente generico tiene su propio nombre RAS/VpnClient).
///   7. Guarda el ancla y el resto del estado de la conexion para poder
///      renovar despues.
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

    public async Task<ConnectionRecord> EnrollAsync(ProvisioningProfile profile, CancellationToken ct)
    {
        _logger.Info($"Alta: empezando para \"{profile.Cn}\" (servidor {profile.Server}, modo {profile.TunnelMode}).");

        var chain = EstTrustValidator.ParseChain(profile.CaChainPem!);
        var root = chain.FirstOrDefault(c => c.SubjectName.RawData.AsSpan().SequenceEqual(c.IssuerName.RawData))
                   ?? throw new InvalidOperationException("El perfil no incluye ninguna raiz autofirmada en su cadena de CA.");
        var actualRootSha256 = RootCertificateStoreService.ComputeSha256Thumbprint(root);
        if (!string.Equals(actualRootSha256, profile.RootCaSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "El perfil es inconsistente: la huella de la raiz no coincide con la cadena que trae. Pide uno nuevo desde el panel.");
        }

        EnsureTrustAnchor(profile);
        EnsureRootTrusted(root, actualRootSha256);

        _logger.Info($"Alta: generando clave y pidiendo certificado por simpleenroll para \"{profile.Cn}\".");
        var estBaseUri = EstBaseUrl.Normalize(profile.EstBaseUrl);
        InstalledCertificateResult enrolled;
        try
        {
            enrolled = await _certificateService.EnrollAsync(
                profile.Cn,
                _confirmations.ConfirmSoftwareKeyFallback,
                (csrDer, enrollCt) => _estClient.SimpleEnrollAsync(estBaseUri, profile.Cn, profile.EnrollToken, csrDer, chain, enrollCt),
                ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.Error("Alta: simpleenroll/instalacion del certificado ha fallado", ex);
            throw;
        }

        using var installedCertificate = enrolled.Certificate;
        _logger.Info($"Alta: certificado instalado (huella {installedCertificate.Thumbprint}, TPM={enrolled.IsTpmBacked}).");

        try
        {
            await EnsureMinAppVersionAsync(installedCertificate, estBaseUri, chain, ct).ConfigureAwait(false);
        }
        catch
        {
            _logger.Warn("Alta: bloqueada tras instalar el certificado, desinstalandolo para no dejar nada a medias.");
            _certificateService.RemoveCertificate(installedCertificate);
            throw;
        }

        ConfigureVpnConnection(profile, root, chain, installedCertificate);

        var record = new ConnectionRecord
        {
            Cn = profile.Cn,
            Server = profile.Server,
            EstBaseUrl = profile.EstBaseUrl,
            CaChainPem = profile.CaChainPem!,
            RootCaSha256 = profile.RootCaSha256,
            SignerKeySha256 = profile.SignerKeySha256,
            CertificateThumbprint = installedCertificate.Thumbprint,
            IsTpmBacked = enrolled.IsTpmBacked,
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
        ConnectionStore.Save(record);
        _logger.Info($"Alta: completada para \"{profile.Cn}\".");
        return record;
    }

    /// <summary>
    /// Confianza en el primer uso: ver el resumen de la clase. Nunca deja
    /// pasar un perfil cuya identidad no se ha confirmado (primera vez) o no
    /// coincide con lo ya confirmado (veces siguientes).
    /// </summary>
    private void EnsureTrustAnchor(ProvisioningProfile profile)
    {
        // El ancla pertenece al servidor, no al nombre de una conexion. Asi,
        // otro perfil del mismo servidor no puede abrir una segunda decision
        // de confianza usando un cn distinto.
        var existing = ConnectionStore.List().FirstOrDefault(connection =>
            string.Equals(connection.Server, profile.Server, StringComparison.OrdinalIgnoreCase));
        if (existing is null)
        {
            _logger.Info($"Alta: \"{profile.Cn}\" es un servidor nuevo (sin ancla de confianza todavia), pidiendo confirmacion.");
            var confirmed = _confirmations.ConfirmTrustAnchor(
                profile.Server,
                profile.Cn,
                FingerprintFormatter.Format(profile.SignerKeySha256),
                FingerprintFormatter.Format(profile.RootCaSha256));
            if (!confirmed)
            {
                throw new OperationCanceledException(
                    "Alta cancelada: no se ha confirmado la identidad de este servidor (las huellas no coincidian, o se ha cancelado).");
            }
            _logger.Info($"Alta: confianza confirmada por el usuario para \"{profile.Cn}\".");
            return;
        }

        if (!string.Equals(existing.SignerKeySha256, profile.SignerKeySha256, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(existing.RootCaSha256, profile.RootCaSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new TrustAnchorMismatchException(
                $"La identidad del servidor \"{profile.Server}\" (\"{profile.Cn}\") ha cambiado respecto a la que se " +
                "confirmo la primera vez. Por seguridad no se acepta automaticamente: si esperabas este cambio, quita " +
                "la conexion y vuelve a anadirla desde cero.");
        }
    }

    /// <summary>
    /// Comprueba GET /status (TLS mutuo) con el certificado YA INSTALADO -con
    /// CertEnroll no hay forma de enlazarlo a la clave sin instalarlo, ver el
    /// resumen de la clase-. Si el panel exige una version de app superior a
    /// esta, el llamador desinstala el certificado que se acaba de poner:
    /// mejor eso que dejar un dispositivo funcionando con una app que el
    /// panel ya considera obsoleta. Un fallo de red al comprobarlo NO bloquea
    /// el alta (best-effort: la version minima es una salvaguarda adicional,
    /// no la unica forma de controlar quien puede darse de alta -eso ya lo
    /// hace el admin al generar el token-).
    /// </summary>
    private async Task EnsureMinAppVersionAsync(
        X509Certificate2 installedCertificate, Uri estBaseUri, X509Certificate2Collection chain, CancellationToken ct)
    {
        EstStatus status;
        try
        {
            status = await _estClient.GetStatusAsync(estBaseUri, installedCertificate, chain, ct).ConfigureAwait(false);
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

        _logger.Info("Alta: la raiz de este servidor no esta en LocalMachine\\Root todavia, pidiendo elevacion.");
        if (!_confirmations.ConfirmRootCertificateElevation())
        {
            throw new OperationCanceledException(
                "Alta cancelada: hace falta confiar en la raiz de este servidor (una elevacion de administrador, una unica vez) para poder conectar.");
        }

        if (!RootCertificateElevatedInstaller.InstallWithUacPrompt(root))
        {
            throw new InvalidOperationException(
                "No se ha podido instalar la raiz de confianza (se rechazo el permiso de administrador, o la instalacion fallo).");
        }

        _logger.Info("Alta: raiz instalada en LocalMachine\\Root.");
    }

    private void ConfigureVpnConnection(
        ProvisioningProfile profile, X509Certificate2 root, X509Certificate2Collection chain, X509Certificate2 installedCertificate)
    {
        var eapServerName = profile.AaaId.StartsWith("CN=", StringComparison.OrdinalIgnoreCase)
            ? profile.AaaId[3..]
            : profile.AaaId;

        // El nombre de la conexion RAS/VpnClient es "cn": cada conexion de
        // este cliente generico tiene el suyo (ya es unico por construccion,
        // es el username RADIUS del dispositivo).
        var spec = new VpnConnectionSpec(
            ConnectionName: profile.Cn,
            ServerAddress: profile.Server,
            EapServerName: eapServerName,
            RootCertificateThumbprintSha1: root.Thumbprint,
            ClientCertificateIssuerThumbprintSha1: FindIssuerThumbprint(installedCertificate, chain, root),
            SplitTunneling: profile.TunnelMode == Core.Profile.TunnelMode.Split,
            SplitRoutes: profile.SplitRoutes,
            IkeEncryption: WindowsIpsecProposalMapper.MapEncryption(profile.Ike.Encryption),
            IkeIntegrity: WindowsIpsecProposalMapper.MapIntegrityOrPrf(profile.Ike.Prf),
            IkeDhGroup: WindowsIpsecProposalMapper.MapDhOrPfsGroup(profile.Ike.DhGroup),
            EspEncryption: WindowsIpsecProposalMapper.MapEncryption(profile.Esp.Encryption),
            EspPfsGroup: WindowsIpsecProposalMapper.MapDhOrPfsGroup(profile.Esp.DhGroup));

        _vpnConnectionService.CreateOrUpdateConnection(spec);
        _logger.Info($"Alta: conexion \"{profile.Cn}\" configurada (servidor {profile.Server}).");
    }

    /// <summary>
    /// Huella SHA-1 de quien firmo DIRECTAMENTE el certificado del
    /// dispositivo (la intermedia del panel, o la raiz si todavia no hay
    /// intermedia -dispositivo "vps" de prueba, CLAUDE.md-): con ella el
    /// perfil EAP filtra por emisor (FilteringInfo/CAHashList, item 7 del
    /// prompt 12.7) para que solo haya UN certificado candidato en
    /// CurrentUser\My y Windows no necesite preguntar cual usar. Si por lo
    /// que sea no aparece en la cadena del perfil (no deberia pasar: el
    /// perfil ya se valido contra ella), se usa la raiz -mejor un filtro mas
    /// amplio que ninguno-.
    /// </summary>
    private static string FindIssuerThumbprint(X509Certificate2 installedCertificate, X509Certificate2Collection chain, X509Certificate2 root)
    {
        foreach (var candidate in chain)
        {
            if (candidate.SubjectName.RawData.AsSpan().SequenceEqual(installedCertificate.IssuerName.RawData))
            {
                return candidate.Thumbprint;
            }
        }
        return root.Thumbprint;
    }
}
