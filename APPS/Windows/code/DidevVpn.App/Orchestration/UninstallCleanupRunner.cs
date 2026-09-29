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
///   2. Si este usuario tiene un dispositivo dado de alta (device.json),
///      pregunta (Si/No/Cancelar, igual que "Quitar de este equipo" del menu
///      de la bandeja) si borrar tambien su certificado; Cancelar aborta todo
///      este proceso sin tocar nada, ni siquiera la conexion.
///   3. Solo si, tras eso, NINGUN otro perfil de usuario de este equipo tiene
///      ya un dispositivo dado de alta (se comprueba enumerando
///      C:\Users\*\AppData\Local\didev-vpn\device.json: esto SI es fiable
///      desde una custom action elevada, a diferencia de manipular la
///      conexion VPN o el certificado de otro usuario, que exigiria cargar
///      su perfil/hive -ver la limitacion documentada en el README-), se
///      pregunta si retirar tambien la raiz "didev Root CA" de
///      LocalMachine\Root.
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
        IRootCertificateStoreService rootStore,
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

            var state = DeviceStateStore.Load();
            string? rootSha256ToConsider = null;

            if (state is not null)
            {
                rootSha256ToConsider = state.RootCaSha256;

                var confirm = MessageBox.Show(
                    $"Se va a desinstalar didev VPN. Se borrara la conexion \"{AppPaths.ConnectionName}\" y la " +
                    "configuracion guardada de ESTE usuario.\n\n?Borrar tambien el certificado del dispositivo de este equipo?",
                    "Desinstalando didev VPN",
                    MessageBoxButtons.YesNoCancel,
                    MessageBoxIcon.Warning);

                if (confirm == DialogResult.Cancel)
                {
                    logger.Info("--uninstall-cleanup: cancelado por el usuario, no se toca ni la conexion ni la raiz.");
                    return 0;
                }

                TryRemoveConnection(vpnService, logger);

                if (confirm == DialogResult.Yes)
                {
                    TryRemoveCertificate(state.CertificateThumbprint, logger);
                }

                DeviceStateStore.Delete();
            }

            if (!string.IsNullOrEmpty(rootSha256ToConsider))
            {
                OfferToRetireRoot(rootSha256ToConsider!, rootStore, logger);
            }

            return 0;
        }
        catch (Exception ex)
        {
            logger.Error("--uninstall-cleanup: fallo inesperado (no se bloquea la desinstalacion)", ex);
            return 0;
        }
    }

    private static void OfferToRetireRoot(string rootSha256, IRootCertificateStoreService rootStore, FileLogger logger)
    {
        var others = CountOtherUserProfilesWithDeviceState();
        if (others > 0)
        {
            logger.Info(
                $"--uninstall-cleanup: {others} otro(s) perfil(es) de usuario en este equipo siguen teniendo un " +
                "dispositivo didev VPN dado de alta; la raiz de confianza NO se retira.");
            return;
        }

        var confirmRoot = MessageBox.Show(
            "Ningun otro usuario de este equipo parece tener un dispositivo didev VPN dado de alta.\n\n" +
            "?Retirar tambien la raiz de confianza \"didev Root CA\" de este equipo (LocalMachine\\Root)? " +
            "Hazlo solo si estas seguro de que nada mas en esta maquina depende de ella; si tienes dudas, elige No " +
            "(podras retirarla luego a mano con certlm.msc).",
            "Retirar raiz de confianza",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);

        if (confirmRoot != DialogResult.Yes)
        {
            return;
        }

        try
        {
            rootStore.Remove(StoreLocation.LocalMachine, rootSha256);
            logger.Info("--uninstall-cleanup: raiz \"didev Root CA\" retirada de LocalMachine\\Root.");
        }
        catch (Exception ex)
        {
            logger.Warn($"--uninstall-cleanup: no se ha podido retirar la raiz de confianza: {ex.Message}");
        }
    }

    private static void TryRemoveConnection(IVpnConnectionService vpnService, FileLogger logger)
    {
        try
        {
            vpnService.RemoveConnection(AppPaths.ConnectionName);
        }
        catch (Exception ex)
        {
            logger.Warn($"--uninstall-cleanup: no se ha podido quitar la conexion VPN: {ex.Message}");
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
            logger.Warn($"--uninstall-cleanup: no se ha podido borrar el certificado del dispositivo: {ex.Message}");
        }
    }

    /// <summary>
    /// Cuenta cuantos perfiles de usuario de este equipo, DISTINTOS del que se
    /// esta procesando (que ya ha borrado su propio device.json antes de
    /// llegar aqui), siguen teniendo un dispositivo dado de alta. Best-effort:
    /// un perfil sin permiso de lectura (poco frecuente para una custom
    /// action elevada, pero no imposible) se ignora en vez de fallar.
    /// </summary>
    private static int CountOtherUserProfilesWithDeviceState()
    {
        var usersRoot = Path.GetDirectoryName(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        if (string.IsNullOrEmpty(usersRoot) || !Directory.Exists(usersRoot))
        {
            return 0;
        }

        var count = 0;
        foreach (var profileDir in SafeEnumerateDirectories(usersRoot))
        {
            var deviceJsonPath = Path.Combine(profileDir, "AppData", "Local", "didev-vpn", "device.json");
            try
            {
                if (File.Exists(deviceJsonPath))
                {
                    count++;
                }
            }
            catch
            {
                // Sin permiso para comprobar este perfil: se ignora, no se cuenta ni se falla.
            }
        }
        return count;
    }

    private static IEnumerable<string> SafeEnumerateDirectories(string path)
    {
        IEnumerator<string>? enumerator = null;
        try
        {
            enumerator = Directory.EnumerateDirectories(path).GetEnumerator();
        }
        catch
        {
            yield break;
        }

        using (enumerator)
        {
            while (true)
            {
                bool moved;
                try
                {
                    moved = enumerator.MoveNext();
                }
                catch
                {
                    yield break;
                }
                if (!moved) yield break;
                yield return enumerator.Current;
            }
        }
    }
}
