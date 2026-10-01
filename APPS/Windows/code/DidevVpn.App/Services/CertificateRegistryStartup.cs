namespace DidevVpn.App.Services;

/// <summary>
/// Paso de arranque de la app (TrayApplicationContext): anota en el registro
/// propio los certificados de las conexiones que ya existian antes de que
/// hubiera registro (los instalo la app) y completa el identificador del emisor
/// de las entradas antiguas. Protegido: un fallo aqui nunca debe impedir que la
/// app arranque, solo queda en el log.
/// </summary>
internal static class CertificateRegistryStartup
{
    /// <returns>True si se pudo completar; false si fallo (ya registrado en el log).</returns>
    public static bool AdoptExistingConnections(
        ICertificateLifecycle lifecycle, Func<IEnumerable<ConnectionRecord>> loadConnections, FileLogger logger)
    {
        try
        {
            lifecycle.AdoptConnectionCertificates(loadConnections());
            return true;
        }
        catch (Exception ex)
        {
            logger.Warn($"No se ha podido actualizar el registro de certificados (la app arranca igualmente): {ex.Message}");
            return false;
        }
    }
}
