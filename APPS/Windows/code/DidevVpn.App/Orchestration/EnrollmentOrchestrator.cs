using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;
using DidevVpn.Core.Ipsec;
using DidevVpn.Core.Profile;

namespace DidevVpn.App.Orchestration;

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
///   5. Instala el certificado emitido, enlazado a esa misma clave.
///   6. Configura la conexion IKEv2/EAP-TLS "didev VPN".
///   7. Guarda el estado del dispositivo para poder renovar despues.
/// </summary>
internal sealed class EnrollmentOrchestrator
{
    private readonly ICertificateEnrollmentService _certificateService;
    private readonly IEstClient _estClient;
    private readonly IVpnConnectionService _vpnConnectionService;
    private readonly IRootCertificateStoreService _rootCertificateStore;
    private readonly IUserConfirmations _confirmations;
    private readonly FileLogger _logger;

    public EnrollmentOrchestrator(
        ICertificateEnrollmentService certificateService,
        IEstClient estClient,
        IVpnConnectionService vpnConnectionService,
        IRootCertificateStoreService rootCertificateStore,
        IUserConfirmations confirmations,
        FileLogger logger)
    {
        _certificateService = certificateService;
        _estClient = estClient;
        _vpnConnectionService = vpnConnectionService;
        _rootCertificateStore = rootCertificateStore;
        _confirmations = confirmations;
        _logger = logger;
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
