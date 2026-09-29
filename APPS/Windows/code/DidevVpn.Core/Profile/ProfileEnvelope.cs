using System.Text.Json.Serialization;

namespace DidevVpn.Core.Profile;

/// <summary>
/// Sobre firmado tal como lo entrega el panel (fichero .didevvpn o el JSON
/// codificado en el QR): <c>payload</c> es el base64url de los bytes UTF-8
/// EXACTOS del perfil (nunca hay que re-serializarlo para verificar la
/// firma), y <c>signature</c> es la firma Ed25519 sobre esos mismos bytes.
/// Ver README del panel, seccion "Aprovisionamiento de apps".
/// </summary>
public sealed class ProfileEnvelope
{
    [JsonPropertyName("payload")]
    public string Payload { get; set; } = string.Empty;

    [JsonPropertyName("signature")]
    public string Signature { get; set; } = string.Empty;

    [JsonPropertyName("keyId")]
    public string KeyId { get; set; } = string.Empty;
}
