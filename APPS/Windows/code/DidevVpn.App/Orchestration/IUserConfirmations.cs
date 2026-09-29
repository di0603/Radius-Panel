namespace DidevVpn.App.Orchestration;

/// <summary>
/// Confirmaciones explicitas que solo puede dar la persona delante del
/// equipo. Separado de la UI concreta (MessageBox en la app real) para poder
/// probar el resto de la orquestacion con respuestas fijas.
/// </summary>
internal interface IUserConfirmations
{
    /// <summary>No hay TPM disponible: ?continuar con una clave por software (sigue sin ser exportable, pero no vive en el chip)?</summary>
    bool ConfirmSoftwareKeyFallback(string reason);

    /// <summary>Hace falta una elevacion UAC de un solo uso para confiar en la raiz de didev en este equipo.</summary>
    bool ConfirmRootCertificateElevation();
}
