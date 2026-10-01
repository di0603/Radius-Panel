namespace DidevVpn.App.Services;

/// <summary>
/// Paso de seguridad entre "certificado nuevo instalado y conexion apuntando a
/// el" y "borrar el certificado viejo" (alta y renovacion): el viejo SOLO se
/// borra si la entrada de la agenda existe Y sus credenciales EAP guardadas
/// corresponden al certificado NUEVO (su huella). Si no, se lanza y el
/// certificado anterior se conserva.
/// </summary>
internal static class ConnectionConfigurationCheck
{
    public static void EnsureConfigured(IVpnConnectionService vpn, string connectionName, string expectedCertificateThumbprint)
    {
        if (!vpn.ConnectionExists(connectionName))
        {
            throw new InvalidOperationException(
                $"La conexion \"{connectionName}\" no existe en Windows despues de configurarla: no se continua y se conserva el certificado anterior.");
        }

        var saved = vpn.GetSavedEapCertificateThumbprint(connectionName);
        if (saved is null)
        {
            throw new InvalidOperationException(
                $"La conexion \"{connectionName}\" no tiene guardadas las credenciales EAP (o ya no son las que se guardaron): no se continua y se conserva el certificado anterior.");
        }
        if (!string.Equals(saved, expectedCertificateThumbprint, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Las credenciales EAP guardadas de \"{connectionName}\" corresponden a OTRO certificado (huella {saved}), no al nuevo ({expectedCertificateThumbprint}): no se continua y se conserva el certificado anterior.");
        }
    }
}
