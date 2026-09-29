using DidevVpn.Core.Profile;

namespace DidevVpn.App.Orchestration;

/// <summary>
/// Confirmaciones explicitas que solo puede dar la persona delante del
/// equipo. Separado de la UI concreta (MessageBox/formulario en la app real)
/// para poder probar el resto de la orquestacion con respuestas fijas.
/// </summary>
internal interface IUserConfirmations
{
    /// <summary>No hay TPM disponible: ?continuar con una clave por software (sigue sin ser exportable, pero no vive en el chip)?</summary>
    bool ConfirmSoftwareKeyFallback(string reason);

    /// <summary>Hace falta una elevacion UAC de un solo uso para confiar en la raiz de este servidor en este equipo.</summary>
    bool ConfirmRootCertificateElevation();

    /// <summary>
    /// Confianza en el primer uso (TOFU, prompt 12.5): primera vez que se
    /// importa un perfil para esta conexion (todavia sin ancla guardada).
    /// Muestra el servidor y las dos huellas para que el usuario las compare
    /// con lo que ensena el panel; solo si confirma se guarda el ancla y se
    /// continua con el alta. Nunca se llama para una conexion que ya tiene
    /// ancla (eso se compara automaticamente, sin preguntar, ver
    /// EnrollmentOrchestrator).
    /// </summary>
    bool ConfirmTrustAnchor(string server, string cn, FormattedFingerprint panelFingerprint, FormattedFingerprint rootFingerprint);
}
