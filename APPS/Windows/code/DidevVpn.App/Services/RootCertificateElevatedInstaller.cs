using System.Diagnostics;
using System.Security.Cryptography.X509Certificates;

namespace DidevVpn.App.Services;

/// <summary>
/// Instala la raiz en LocalMachine\Root con UNA sola elevacion UAC, sin
/// elevar el resto de la app: relanza este mismo .exe con un argumento
/// oculto y <c>Verb = "runas"</c>; el proceso hijo (ver Program.cs) entra en
/// modo "solo instalar la raiz y salir" en vez de arrancar la bandeja. Es el
/// patron estandar de Windows para pedir admin para un unico paso puntual
/// sin relanzar toda la aplicacion como administrador.
/// </summary>
internal static class RootCertificateElevatedInstaller
{
    public const string ElevatedInstallArgument = "--elevated-install-root";

    /// <summary>
    /// Llamado desde la app SIN elevar. Escribe el certificado a un fichero
    /// temporal (contenido publico, no hace falta protegerlo) y lanza una
    /// copia elevada de si misma para importarlo. Devuelve true si el
    /// proceso elevado confirmo la instalacion (exit code 0).
    /// </summary>
    public static bool InstallWithUacPrompt(X509Certificate2 rootCertificate)
    {
        var certPath = Path.Combine(Path.GetTempPath(), $"didev-root-{Guid.NewGuid():N}.cer");
        File.WriteAllBytes(certPath, rootCertificate.Export(X509ContentType.Cert));
        try
        {
            var exePath = Environment.ProcessPath
                ?? throw new InvalidOperationException("No se ha podido determinar la ruta del ejecutable actual.");
            var startInfo = new ProcessStartInfo
            {
                FileName = exePath,
                Arguments = $"{ElevatedInstallArgument} \"{certPath}\"",
                UseShellExecute = true,
                Verb = "runas",
            };

            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return false;
            }

            process.WaitForExit();
            return process.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // ERROR_CANCELLED: el usuario rechazo el UAC. No es un fallo
            // inesperado, es una decision legitima del usuario.
            return false;
        }
        finally
        {
            try { File.Delete(certPath); } catch { /* best effort */ }
        }
    }

    /// <summary>
    /// Punto de entrada del proceso YA elevado (ver Program.cs): importa el
    /// certificado indicado en LocalMachine\Root y devuelve el codigo de
    /// salida del proceso (0 = ok). No toca nada mas de la app -sin bandeja,
    /// sin logs de usuario, nada que necesite el contexto del usuario normal-.
    /// </summary>
    public static int RunElevatedInstall(string certPath)
    {
        try
        {
            using var cert = X509CertificateLoaderCompat.LoadCertificateFile(certPath);
            new RootCertificateStoreService().Install(StoreLocation.LocalMachine, cert);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}

/// <summary>net8.0 no tiene X509CertificateLoader (llegara en .NET 9): envoltorio minimo para no repetir el constructor en varios sitios.</summary>
internal static class X509CertificateLoaderCompat
{
    public static X509Certificate2 LoadCertificateFile(string path) => new(path);
}
