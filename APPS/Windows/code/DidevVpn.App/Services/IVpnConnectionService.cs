namespace DidevVpn.App.Services;

internal sealed record VpnConnectionSpec(
    string ConnectionName,
    string ServerAddress,
    string EapServerName,
    string RootCertificateThumbprintSha1,
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
    void Connect(string connectionName);
    void Disconnect(string connectionName);

    /// <summary>IP asignada por el servidor mientras la conexion esta activa. Best-effort: null si no se puede determinar (no conectado, adaptador todavia sin IP, etc.).</summary>
    string? GetAssignedIPv4Address(string connectionName);
}
