namespace DidevVpn.Core.Ipsec;

/// <summary>
/// Traduce las propuestas IKE/ESP del perfil (sintaxis strongSwan, ver
/// ProvisioningProfile.Ike/Esp) a las constantes que entiende
/// Set-VpnConnectionIPsecConfiguration en Windows. Falla alto y claro ante
/// cualquier valor que no reconozca -nunca elige una alternativa "parecida"
/// en silencio, eso podria acabar negociando una suite mas debil de lo que
/// el panel pidio-.
/// </summary>
public static class WindowsIpsecProposalMapper
{
    public static string MapEncryption(string strongswanValue) => strongswanValue switch
    {
        "aes256gcm16" => "GCMAES256",
        _ => throw Unsupported("cifrado", strongswanValue),
    };

    /// <summary>Sirve tanto para el PRF de IKE como para IntegrityCheckMethod: en las propuestas de didev son el mismo valor (sha384).</summary>
    public static string MapIntegrityOrPrf(string strongswanValue) => strongswanValue switch
    {
        "sha384" => "SHA384",
        _ => throw Unsupported("integridad/PRF", strongswanValue),
    };

    /// <summary>Sirve tanto para DHGroup como para PfsGroup: en las propuestas de didev son el mismo valor (ecp384).</summary>
    public static string MapDhOrPfsGroup(string strongswanValue) => strongswanValue switch
    {
        "ecp384" => "ECP384",
        _ => throw Unsupported("grupo DH/PFS", strongswanValue),
    };

    private static NotSupportedException Unsupported(string kind, string value) =>
        new($"Propuesta de {kind} \"{value}\" del perfil no soportada todavia por didev-vpn-windows. " +
            "Actualiza la app o revisa panel_vpn_settings del lado del panel.");
}
