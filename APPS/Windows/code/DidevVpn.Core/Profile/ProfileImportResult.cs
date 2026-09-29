namespace DidevVpn.Core.Profile;

/// <summary>
/// Por que se rechazo un perfil. Se usa para mostrar un mensaje claro en la
/// UI y para el log (nunca el contenido del perfil ni el token, ver
/// Logging/FileLogger en el proyecto de la app) sin tener que analizar texto
/// de excepciones.
/// </summary>
public enum ProfileRejectionReason
{
    /// <summary>El texto/fichero no es un sobre { payload, signature, keyId } valido (JSON roto, campos vacios...).</summary>
    InvalidEnvelope,

    /// <summary>La firma Ed25519 no verifica contra la clave publica incrustada: el perfil no viene de este panel, o esta corrupto/manipulado.</summary>
    InvalidSignature,

    /// <summary>
    /// El sobre trae un <c>keyId</c> distinto del que espera esta version de la app
    /// (<see cref="ProfileVerifier.ExpectedKeyId"/>). No es un problema de firma -la firma
    /// ni se comprueba todavia en este punto-, sino de rotacion de claves: el panel firma
    /// ahora con una clave que esta version de la app no conoce.
    /// </summary>
    UnknownKeyId,

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
