using System.Text.Json.Serialization;

namespace DidevVpn.Core.Profile;

/// <summary>
/// Propuesta IKE, en la sintaxis strongSwan que usa el panel (fuente de
/// verdad: el servidor real es strongSwan). Cada plataforma la traduce a su
/// propia convencion -en Windows, <see cref="WindowsIpsecProposal"/>-.
/// </summary>
public sealed class IkeProposal
{
    [JsonPropertyName("encryption")]
    public string Encryption { get; set; } = string.Empty;

    [JsonPropertyName("prf")]
    public string Prf { get; set; } = string.Empty;

    [JsonPropertyName("dhGroup")]
    public string DhGroup { get; set; } = string.Empty;
}

public sealed class EspProposal
{
    [JsonPropertyName("encryption")]
    public string Encryption { get; set; } = string.Empty;

    [JsonPropertyName("dhGroup")]
    public string DhGroup { get; set; } = string.Empty;
}

/// <summary>
/// Valores permitidos de <see cref="ProvisioningProfile.Variant"/>. El
/// fichero .didevvpn que importa esta app SIEMPRE debe ser "full" (el
/// panel reserva "qr" para el codigo QR de la app de Android, que no lleva
/// <see cref="ProvisioningProfile.CaChainPem"/>): ver
/// <see cref="ProfileVerifier"/>, que rechaza cualquier otra cosa.
/// </summary>
public static class ProfileVariant
{
    public const string Full = "full";
    public const string Qr = "qr";
}

public static class TunnelMode
{
    public const string Full = "full";
    public const string Split = "split";
}

/// <summary>
/// El JSON firmado dentro de <see cref="ProfileEnvelope.Payload"/>. Nombres
/// de propiedad y significado exactamente como los define el panel (ver su
/// README, seccion "Aprovisionamiento de apps" -
/// server/src/services/vpnProvisioning.ts es la fuente de verdad-).
/// </summary>
public sealed class ProvisioningProfile
{
    [JsonPropertyName("version")]
    public int Version { get; set; }

    [JsonPropertyName("variant")]
    public string Variant { get; set; } = string.Empty;

    /// <summary>CN del dispositivo: tambien el username RADIUS y el nombre de la conexion VPN.</summary>
    [JsonPropertyName("cn")]
    public string Cn { get; set; } = string.Empty;

    /// <summary>FQDN del servidor strongSwan (panel_vpn_settings.vpn_fqdn).</summary>
    [JsonPropertyName("server")]
    public string Server { get; set; } = string.Empty;

    /// <summary>Identidad AAA esperada del servidor RADIUS, p.ej. "CN=radius.vpn.vlc.didev.es".</summary>
    [JsonPropertyName("aaaId")]
    public string AaaId { get; set; } = string.Empty;

    /// <summary>SHA-256 (hex, minusculas) del DER de la raiz offline. Presente en las dos variantes.</summary>
    [JsonPropertyName("rootCaSha256")]
    public string RootCaSha256 { get; set; } = string.Empty;

    /// <summary>
    /// Cadena de CA completa (intermedia + raiz, PEM concatenado). Solo en la
    /// variante "full" -el JSON de origen simplemente omite esta clave en la
    /// variante "qr", por eso es nullable aqui-.
    /// </summary>
    [JsonPropertyName("caChainPem")]
    public string? CaChainPem { get; set; }

    [JsonPropertyName("ike")]
    public IkeProposal Ike { get; set; } = new();

    [JsonPropertyName("esp")]
    public EspProposal Esp { get; set; } = new();

    [JsonPropertyName("tunnelMode")]
    public string TunnelMode { get; set; } = string.Empty;

    /// <summary>Vacio en modo "full" (todo el trafico va por el tunel).</summary>
    [JsonPropertyName("splitRoutes")]
    public List<string> SplitRoutes { get; set; } = new();

    [JsonPropertyName("dns")]
    public string? Dns { get; set; }

    /// <summary>Base de las rutas EST, p.ej. "https://pki.vlc.didev.es:8443/.well-known/est".</summary>
    [JsonPropertyName("estBaseUrl")]
    public string EstBaseUrl { get; set; } = string.Empty;

    /// <summary>Token de alta de un solo uso: el UNICO campo realmente secreto de todo el perfil.</summary>
    [JsonPropertyName("enrollToken")]
    public string EnrollToken { get; set; } = string.Empty;

    [JsonPropertyName("issuedAt")]
    public DateTimeOffset IssuedAt { get; set; }

    [JsonPropertyName("expiresAt")]
    public DateTimeOffset ExpiresAt { get; set; }
}
