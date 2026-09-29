namespace DidevVpn.Core.Profile;

/// <summary>
/// Por que se rechazo un perfil. Se usa para mostrar un mensaje claro en la
/// UI y para el log (nunca el contenido del perfil ni el token, ver
/// Logging/FileLogger en el proyecto de la app) sin tener que analizar texto
/// de excepciones.
/// </summary>
public enum ProfileRejectionReason
{
    /// <summary>El texto/fichero no es un sobre { payload, signature, keyId, signerPublicKey } valido (JSON roto, campos vacios, signerPublicKey con un formato SPKI irreconocible...).</summary>
    InvalidEnvelope,

    /// <summary>La firma Ed25519 no verifica contra la signerPublicKey del propio sobre: el contenido se ha manipulado, o la firma no corresponde a esa clave.</summary>
    InvalidSignature,

    /// <summary>
    /// <see cref="ProvisioningProfile.SignerKeySha256"/> (DENTRO del payload
    /// firmado) no es el SHA-256 exacto de <see cref="ProfileEnvelope.SignerPublicKey"/>
    /// (FUERA del payload): el sobre es incoherente -no es una decision del
    /// usuario, se rechaza sin preguntar nada-. Ver el comentario de
    /// ProfileVerifier sobre por que esto es distinto de InvalidSignature.
    /// </summary>
    SignerKeyMismatch,

    /// <summary>El payload decodificado no es el JSON esperado del perfil.</summary>
    InvalidPayload,

    /// <summary><see cref="ProvisioningProfile.Version"/> no es una version de esquema soportada por esta app.</summary>
    UnsupportedVersion,

    /// <summary>El fichero .didevvpn debe ser variante "full"; cualquier otra cosa (p.ej. "qr") se rechaza.</summary>
    WrongVariant,

    /// <summary><see cref="ProvisioningProfile.ExpiresAt"/> ya paso.</summary>
    Expired,
}

/// <summary>Resultado de intentar importar un perfil: exito con el perfil ya verificado, o el motivo exacto del rechazo.</summary>
public sealed class ProfileImportResult
{
    public bool Success { get; }
    public ProvisioningProfile? Profile { get; }
    public ProfileRejectionReason? RejectionReason { get; }
    public string? ErrorMessage { get; }

    private ProfileImportResult(bool success, ProvisioningProfile? profile, ProfileRejectionReason? reason, string? message)
    {
        Success = success;
        Profile = profile;
        RejectionReason = reason;
        ErrorMessage = message;
    }

    public static ProfileImportResult Ok(ProvisioningProfile profile) => new(true, profile, null, null);

    public static ProfileImportResult Fail(ProfileRejectionReason reason, string message) =>
        new(false, null, reason, message);
}
