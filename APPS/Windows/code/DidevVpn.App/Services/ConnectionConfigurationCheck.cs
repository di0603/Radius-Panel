namespace DidevVpn.App.Services;

/// <summary>
/// Paso de seguridad entre "certificado nuevo instalado y conexion apuntando a
/// el" y "borrar el certificado viejo" (alta y renovacion): el viejo SOLO se
/// borra si la entrada de la agenda existe y tiene las credenciales EAP
/// guardadas. Si no, se lanza y el certificado anterior se conserva.
/// </summary>
internal static class ConnectionConfigurationCheck
{
    public static void EnsureConfigured(IVpnConnectionService vpn, string connectionName)
    {
        if (!vpn.ConnectionExists(connectionName))
        {
            throw new InvalidOperationException(
                $"La conexion \"{connectionName}\" no existe en Windows despues de configurarla: no se continua y se conserva el certificado anterior.");
        }
        if (!vpn.HasEapCredentials(connectionName))
        {
            throw new InvalidOperationException(
                $"La conexion \"{connectionName}\" no tiene guardadas las credenciales EAP del certificado nuevo: no se continua y se conserva el certificado anterior.");
        }
    }
}
