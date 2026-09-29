using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App.Orchestration;

/// <summary>
/// Punto de entrada de "didev-vpn.exe --uninstall-cleanup --uilevel=N", que
/// invoca el instalador MSI como custom action INMEDIATA (no "deferred": ver
/// Package.wxs, UninstallCleanupCmd) justo antes de borrar los ficheros de la
/// app, para el usuario que esta ejecutando la desinstalacion:
///
///   1. Si UILevel indica una desinstalacion silenciosa (msiexec /qn: nadie
///      puede contestar a nada), no se pregunta nada y no se borra nada -es
///      el valor por defecto mas seguro, ver MsiUiLevel-.
///   2. Si este usuario tiene alguna conexion configurada (ConnectionStore.List,
///      esta app es un cliente generico desde el prompt 12.5: puede haber
///      varias), pregunta UNA vez (Si/No/Cancelar) si borrar tambien sus
///      certificados; Cancelar aborta todo este proceso sin tocar nada.
///
/// A diferencia del prompt 12 original, esta version YA NO ofrece retirar
/// ninguna raiz de confianza durante la desinstalacion: con varias conexiones
/// posibles, cada una a un servidor (y por tanto una raiz) distintos, decidir
/// con seguridad cual raiz retirar sin arriesgarse a romper otra conexion que
/// comparta la misma raiz es mas dificil que instalar, y no se ha
/// implementado (ver IRootCertificateStoreService y el README). Se recomienda
/// certlm.msc a mano si hace falta limpiarla.
///
/// Nunca lanza: un fallo aqui no debe bloquear la desinstalacion (por eso
/// Package.wxs marca esta custom action con Return="ignore" de todas formas,
/// pero el propio codigo ya intenta no hacer fallar nada).
/// </summary>
internal static class UninstallCleanupRunner
{
    public static int Run(
        int uiLevel,
        ICertificateEnrollmentService certificateService,
        IVpnConnectionService vpnService,
        FileLogger logger)
    {
        try
        {
            if (MsiUiLevel.IsSilent(uiLevel))
            {
                logger.Info($"--uninstall-cleanup: desinstalacion silenciosa (UILevel={uiLevel}), no se pregunta nada ni se borra nada.");
                return 0;
            }

            // Segunda comprobacion, ademas de UILevel: si esta custom action
            // se ejecutara alguna vez sin escritorio real (p.ej. un
            // despliegue automatizado que invoca msiexec de forma no
            // silenciosa pero sin sesion interactiva de verdad), un
            // MessageBox nunca visible se quedaria esperando una respuesta
            // que jamas llega -colgando la desinstalacion, no solo "sin
            // preguntar nada"-. Sin escritorio, es mas seguro no arriesgarse.
            if (!Environment.UserInteractive)
            {
                logger.Warn("--uninstall-cleanup: no hay sesion interactiva (Environment.UserInteractive=false), no se pregunta nada por seguridad.");
                return 0;
            }

            var connections = ConnectionStore.List();
            if (connections.Count == 0)
            {
                logger.Info("--uninstall-cleanup: este usuario no tiene ninguna conexion configurada, nada que preguntar.");
                return 0;
            }

            var names = string.Join(", ", connections.Select(c => c.Cn));
            var confirm = MessageBox.Show(
                $"Se va a desinstalar didev VPN. Este usuario tiene {connections.Count} conexion(es) configurada(s): {names}.\n\n" +
                "Se borraran todas ellas (conexion y configuracion guardada).\n\n?Borrar tambien sus certificados de este equipo?",
                "Desinstalando didev VPN",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Warning);

            if (confirm == DialogResult.Cancel)
            {
                logger.Info("--uninstall-cleanup: cancelado por el usuario, no se toca ninguna conexion.");
                return 0;
            }

            foreach (var connection in connections)
            {
                TryRemoveConnection(vpnService, connection.Cn, logger);
                if (confirm == DialogResult.Yes)
                {
                    TryRemoveCertificate(connection.CertificateThumbprint, logger);
                }
                ConnectionStore.Delete(connection.Cn);
            }

            return 0;
        }
        catch (Exception ex)
        {
            logger.Error("--uninstall-cleanup: fallo inesperado (no se bloquea la desinstalacion)", ex);
            return 0;
        }
    }

    private static void TryRemoveConnection(IVpnConnectionService vpnService, string connectionName, FileLogger logger)
    {
        try
        {
            vpnService.RemoveConnection(connectionName);
        }
        catch (Exception ex)
        {
            logger.Warn($"--uninstall-cleanup: no se ha podido quitar la conexion \"{connectionName}\": {ex.Message}");
        }
    }

    private static void TryRemoveCertificate(string thumbprint, FileLogger logger)
    {
        try
        {
            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadWrite);
            var matches = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false);
            foreach (var cert in matches)
            {
                store.Remove(cert);
            }
        }
        catch (Exception ex)
        {
            logger.Warn($"--uninstall-cleanup: no se ha podido borrar un certificado: {ex.Message}");
        }
    }
}
