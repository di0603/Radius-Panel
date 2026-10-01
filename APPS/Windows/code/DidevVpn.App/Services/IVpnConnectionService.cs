namespace DidevVpn.App.Services;

internal sealed record VpnConnectionSpec(
    string ConnectionName,
    string ServerAddress,
    string EapServerName,
    string RootCertificateThumbprintSha1,
    string ClientCertificateIssuerThumbprintSha1,
    bool SplitTunneling,
    IReadOnlyList<string> SplitRoutes,
    string IkeEncryption,
    string IkeIntegrity,
    string IkeDhGroup,
    string EspEncryption,
    string EspPfsGroup);

/// <summary>Gestion de la conexion IKEv2/EAP-TLS nativa de Windows (RAS), por usuario -nunca -AllUserConnection, ver el comentario de VpnConnectionService-.</summary>
internal interface IVpnConnectionService
{
    void CreateOrUpdateConnection(VpnConnectionSpec spec);
    void RemoveConnection(string connectionName);
    bool ConnectionExists(string connectionName);
    bool IsConnected(string connectionName);
    /// <summary>Guarda que la entrada use SIEMPRE este certificado de CurrentUser\My al conectar (credenciales EAP de usuario): sin esto Windows abre el selector de certificado. La entrada ya tiene que existir.</summary>
    void SaveEapCredentials(string connectionName, System.Security.Cryptography.X509Certificates.X509Certificate2 certificate);

    /// <summary>Lanza la conexion y espera a que RAS la dé por establecida (error o 60 s de limite lanzan excepcion).</summary>
    void Connect(string connectionName);

    /// <summary>Fase real en RAS (desconectada / marcando / conectada / fallo), no deducida de ningun codigo de salida.</summary>
    DidevVpn.App.Services.Ras.RasPhaseInfo GetConnectionPhase(string connectionName);
    void Disconnect(string connectionName);

    /// <summary>IP asignada por el servidor mientras la conexion esta activa. Best-effort: null si no se puede determinar (no conectado, adaptador todavia sin IP, etc.).</summary>
    string? GetAssignedIPv4Address(string connectionName);
}
