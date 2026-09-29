using System.Security.Cryptography;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace DidevVpn.Core.Profile;

/// <summary>
/// Verifica un sobre firmado del panel (fichero .didevvpn, o el texto de un
/// QR) y devuelve el perfil ya comprobado -pero, a diferencia de antes del
/// prompt 12.5, esto NO es "confiar en el panel": esta app es un cliente
/// GENERICO sin ninguna clave de didev incrustada, asi que solo comprueba
/// que el sobre es AUTOCONSISTENTE (la firma verifica con la clave publica
/// que el propio sobre trae, y esa clave coincide con la huella que lleva el
/// payload). Que esa clave sea realmente la del panel esperado es una
/// decision de confianza en el primer uso (TOFU) que toma el llamador
/// (EnrollmentOrchestrator, comparando contra el ancla guardada de la
/// conexion, o pidiendole confirmacion al usuario si es la primera vez) -
/// esta clase, a proposito, no sabe nada de conexiones ni anclas.
/// Solo acepta la variante "full" con la cadena de CA completa (la variante
/// "qr", sin ella, es para la app de Android).
/// </summary>
public static class ProfileVerifier
{
    /// <summary>Version de esquema que entiende esta version de la app (server/src/services/vpnProvisioning.ts: PROFILE_SCHEMA_VERSION).</summary>
    public const int SupportedSchemaVersion = 1;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false };

    /// <summary>
    /// EN ESTE ORDEN, parando en el primer fallo: (1) el sobre es JSON valido
    /// con payload+signature+signerPublicKey; (2) esos tres campos son
    /// base64url/SPKI validos; (3) la firma Ed25519 verifica contra la
    /// signerPublicKey del PROPIO sobre -esto va ANTES de leer nada del
    /// contenido: nada de lo que venga despues es de fiar hasta aqui-; (4)
    /// el payload decodificado es el JSON de perfil esperado; (5)
    /// signerKeySha256 (DENTRO del payload firmado) es el SHA-256 exacto de
    /// signerPublicKey (FUERA del payload): si no coincide, el sobre es
    /// incoherente -no es una decision del usuario, se rechaza directamente,
    /// nunca se ofrece "aceptar de todas formas"-; (6) la version de esquema
    /// esta soportada; (7) la variante es "full" (nunca "qr"); (8) trae la
    /// cadena de CA; (9) no ha caducado.
    /// </summary>
    public static ProfileImportResult Verify(string envelopeJson, DateTimeOffset now)
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
                $"El perfil no tiene un formato reconocible (no es un sobre payload/signature/signerPublicKey valido): {ex.Message}");
        }

        if (string.IsNullOrEmpty(envelope.Payload) || string.IsNullOrEmpty(envelope.Signature) ||
            string.IsNullOrEmpty(envelope.SignerPublicKey))
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidEnvelope, "El perfil no trae payload, firma o la clave publica del panel.");
        }

        byte[] payloadBytes;
        byte[] signatureBytes;
        byte[] signerPublicKeyDer;
        try
        {
            payloadBytes = Base64Url.Decode(envelope.Payload);
            signatureBytes = Base64Url.Decode(envelope.Signature);
            signerPublicKeyDer = Base64Url.Decode(envelope.SignerPublicKey);
        }
        catch (FormatException ex)
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidEnvelope,
                $"El payload, la firma o la clave publica del perfil no estan en base64url valido: {ex.Message}");
        }

        Ed25519PublicKeyParameters signerPublicKey;
        try
        {
            signerPublicKey = Ed25519PublicKeySpki.Parse(signerPublicKeyDer);
        }
        catch (FormatException ex)
        {
            return ProfileImportResult.Fail(ProfileRejectionReason.InvalidEnvelope, ex.Message);
        }

        if (!VerifySignature(signerPublicKey, payloadBytes, signatureBytes))
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.InvalidSignature,
                "La firma del perfil no verifica con la clave publica que trae el propio sobre: el contenido se ha manipulado.");
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

        var actualSignerKeySha256 = Convert.ToHexString(SHA256.HashData(signerPublicKeyDer)).ToLowerInvariant();
        if (!string.Equals(profile.SignerKeySha256, actualSignerKeySha256, StringComparison.OrdinalIgnoreCase))
        {
            return ProfileImportResult.Fail(
                ProfileRejectionReason.SignerKeyMismatch,
                "El perfil es incoherente: la huella de la clave de firma (signerKeySha256) no coincide con la " +
                "clave publica que realmente trae el sobre. Pide un perfil nuevo desde el panel.");
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

    private static bool VerifySignature(Ed25519PublicKeyParameters publicKey, byte[] payload, byte[] signature)
    {
        try
        {
            var signer = new Ed25519Signer();
            signer.Init(forSigning: false, publicKey);
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
