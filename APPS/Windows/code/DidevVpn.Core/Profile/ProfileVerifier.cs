using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace DidevVpn.Core.Profile;

/// <summary>
/// Verifica un sobre firmado del panel (fichero .didevvpn, o el texto de un
/// QR) y devuelve el perfil ya comprobado. Nunca confia en nada del sobre
/// hasta que la firma Ed25519 valida contra la clave publica incrustada en
/// la app -y aun asi, solo acepta la variante "full" con la cadena de CA
/// completa (la variante "qr", sin ella, es para la app de Android)-.
/// </summary>
public sealed class ProfileVerifier
{
    /// <summary>Version de esquema que entiende esta version de la app (server/src/services/vpnProvisioning.ts: PROFILE_SCHEMA_VERSION).</summary>
    public const int SupportedSchemaVersion = 1;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false };

    private readonly Ed25519PublicKeyParameters _publicKey;

    public ProfileVerifier(Ed25519PublicKeyParameters publicKey)
    {
        _publicKey = publicKey ?? throw new ArgumentNullException(nameof(publicKey));
    }

    public static ProfileVerifier FromPublicKeyPem(string publicKeyPem) => new(Ed25519PublicKeyPem.Parse(publicKeyPem));

    /// <summary>
    /// EN ESTE ORDEN, parando en el primer fallo: (1) el sobre es JSON valido
    /// con payload+signature; (2) el payload/firma son base64url validos;
    /// (3) la firma Ed25519 verifica contra la clave publica incrustada -esto
    /// va ANTES de leer nada del contenido: nada de lo que venga despues es
    /// de fiar hasta aqui-; (4) el payload decodificado es el JSON de perfil
    /// esperado; (5) la version de esquema esta soportada; (6) la variante es
    /// "full" (nunca "qr"); (7) trae la cadena de CA; (8) no ha caducado.
    /// </summary>
    public ProfileImportResult Verify(string envelopeJson, DateTimeOffset now)
    {
        ProfileEnvelope envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<ProfileEnvelope>(envelopeJson, JsonOptions)
                       ?? throw new JsonException("El JSON del sobre es \"null\".");
        }
        catch (JsonException ex)
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidEnvelope,
                $"El perfil no tiene un formato reconocible (no es un sobre payload/signature/keyId valido): {ex.Message}");
        }

        if (string.IsNullOrEmpty(envelope.Payload) || string.IsNullOrEmpty(envelope.Signature))
        {
            return ProfileImportResult.Fail(ProfileRejectionReason.InvalidEnvelope, "El perfil no trae payload o firma.");
        }

        byte[] payloadBytes;
        byte[] signatureBytes;
        try
        {
            payloadBytes = Base64Url.Decode(envelope.Payload);
            signatureBytes = Base64Url.Decode(envelope.Signature);
        }
        catch (FormatException ex)
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidEnvelope,
                $"El payload o la firma del perfil no estan en base64url valido: {ex.Message}");
        }

        if (!VerifySignature(payloadBytes, signatureBytes))
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidSignature,
                "La firma del perfil no es valida: no viene de este panel, o el contenido se ha manipulado.");
        }

        ProvisioningProfile profile;
        try
        {
            profile = JsonSerializer.Deserialize<ProvisioningProfile>(payloadBytes, JsonOptions)
                      ?? throw new JsonException("El payload firmado es \"null\".");
        }
        catch (JsonException ex)
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidPayload,
                $"El contenido firmado no es el JSON de perfil esperado: {ex.Message}");
        }

        if (profile.Version != SupportedSchemaVersion)
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.UnsupportedVersion,
                $"Este perfil usa la version de formato {profile.Version}, pero esta app solo entiende la version " +
                $"{SupportedSchemaVersion}. Actualiza didev-vpn-windows.");
        }

        if (!string.Equals(profile.Variant, ProfileVariant.Full, StringComparison.Ordinal))
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.WrongVariant,
                $"Este fichero es la variante \"{profile.Variant}\" del perfil (pensada para el codigo QR de la app de " +
                "Android). Para Windows hace falta la variante \"full\": descarga el fichero .didevvpn desde el panel, " +
                "no uses el texto del QR.");
        }

        if (string.IsNullOrEmpty(profile.CaChainPem))
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidPayload,
                "El perfil dice ser la variante \"full\" pero no trae la cadena de CA (caChainPem): pide uno nuevo desde el panel.");
        }

        if (profile.ExpiresAt <= now)
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.Expired,
                $"Este perfil caduco el {profile.ExpiresAt:u}. Pide uno nuevo desde el panel (\"Generar token de alta\").");
        }

        return ProfileImportResult.Ok(profile);
    }

    private bool VerifySignature(byte[] payload, byte[] signature)
    {
        try
        {
            var signer = new Ed25519Signer();
            signer.Init(forSigning: false, _publicKey);
            signer.BlockUpdate(payload, 0, payload.Length);
            return signer.VerifySignature(signature);
        }
        catch (Exception)
        {
            // Firma con una longitud/formato imposible: se trata igual que
            // "no valida", nunca se propaga como fallo inesperado.
            return false;
        }
    }
}
