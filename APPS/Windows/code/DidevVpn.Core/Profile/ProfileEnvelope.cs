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

    /// <summary>
    /// Clave publica Ed25519 del panel (SPKI DER, base64url) que verifica
    /// "signature". Desde el prompt 12.5 esta app es un cliente GENERICO sin
    /// ninguna clave incrustada: la aprende de aqui la primera vez que ve un
    /// servidor (confianza en el primer uso), ver ProfileVerifier. Va fuera
    /// del payload firmado a proposito -es informacion publica sobre quien
    /// firmo, no parte de lo firmado-, pero el payload lleva su huella
    /// (signerKeySha256) para ligarla a la firma.
    /// </summary>
    [JsonPropertyName("signerPublicKey")]
    public string SignerPublicKey { get; set; } = string.Empty;
}
