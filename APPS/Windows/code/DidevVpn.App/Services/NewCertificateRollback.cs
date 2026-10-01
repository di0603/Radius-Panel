namespace DidevVpn.App.Services;

/// <summary>
/// Deshace la instalacion del certificado NUEVO cuando falla un paso posterior
/// (credenciales EAP, comprobacion, registro, estado de la conexion): dos
/// certificados del mismo emisor en CurrentUser\My hacen que Windows abra su
/// selector de certificado (error 703) aunque haya credenciales guardadas, asi
/// que un fallo a medias no puede dejar el nuevo instalado junto al viejo.
/// Nunca oculta la excepcion original: si el propio rollback falla, solo lo
/// registra (y dice que el certificado nuevo puede haber quedado instalado).
/// </summary>
internal static class NewCertificateRollback
{
    /// <param name="restorePreviousConfiguration">Opcional: devolver la configuracion al certificado anterior (p.ej. sus credenciales EAP). Se intenta antes de borrar el nuevo y nunca lanza.</param>
    public static void Run(
        ICertificateLifecycle lifecycle,
        FileLogger logger,
        string operation,
        string newThumbprint,
        Exception cause,
        Action? restorePreviousConfiguration = null)
    {
        logger.Warn(
            $"{operation}: ha fallado un paso despues de instalar el certificado nuevo ({cause.GetType().Name}: {cause.Message}). " +
            $"Se deshace: se borra el nuevo (huella {newThumbprint}) con su clave y se conserva el anterior.");

        if (restorePreviousConfiguration is not null)
        {
            try
            {
                restorePreviousConfiguration();
            }
            catch (Exception ex)
            {
                logger.Warn($"{operation}: no se ha podido devolver la configuracion al certificado anterior: {ex.Message}");
            }
        }

        try
        {
            lifecycle.RemoveWithKey(newThumbprint);
        }
        catch (Exception ex)
        {
            logger.Error(
                $"{operation}: el rollback ha fallado: el certificado nuevo {newThumbprint} puede haber quedado instalado junto al anterior " +
                "(Windows podria abrir el selector de certificado: borralo a mano en certmgr.msc)", ex);
        }
    }
}
