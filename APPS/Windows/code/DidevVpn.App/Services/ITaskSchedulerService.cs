namespace DidevVpn.App.Services;

/// <summary>
/// Tarea programada de renovacion SOLO para el usuario actual, sin elevar
/// (variante portable: "Renovar aunque la app este cerrada"). El instalador
/// MSI registra por separado su propia tarea para todos los usuarios durante
/// la instalacion elevada (ver DidevVpn.Installer): esta interfaz es solo
/// para la tarea por-usuario que puede crear la propia app en caliente.
/// </summary>
internal interface ITaskSchedulerService
{
    void RegisterPerUserRenewalTask(string taskName, string executablePath);
    void RemovePerUserRenewalTask(string taskName);
    bool PerUserRenewalTaskExists(string taskName);

    /// <summary>Ruta del ejecutable que tiene registrada la tarea ahora mismo, o null si no existe la tarea.</summary>
    string? GetRegisteredExecutablePath(string taskName);
}
