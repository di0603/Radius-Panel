using System.Diagnostics;

namespace DidevVpn.App.Services;

/// <summary>
/// Ejecuta un script de PowerShell y lanza si falla. Se usa en vez de
/// invocar los cmdlets de VpnClient via CIM/WMI directamente: las firmas
/// exactas de los metodos CIM subyacentes
/// (root\Microsoft\Windows\RemoteAccess\Client) no estan verificadas contra
/// una maquina real (ver APPS/Windows/NOTAS-prompt-12-en-pausa.md, punto 1),
/// mientras que los propios cmdlets de PowerShell SI estan documentados por
/// Microsoft y son el mismo mecanismo que ya usa con exito el paquete de
/// conexion existente del panel (server/src/services/vpnClientPackages.ts,
/// WINDOWS_INSTALL_PS1) -misma plantilla de XML EAP, ver
/// VpnConnectionService-.
/// </summary>
internal static class PowerShellRunner
{
    public static string RunScript(string scriptContent)
    {
        var scriptPath = Path.Combine(Path.GetTempPath(), $"didev-vpn-{Guid.NewGuid():N}.ps1");
        File.WriteAllText(scriptPath, scriptContent, System.Text.Encoding.UTF8);
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                ArgumentList = { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("No se ha podido iniciar powershell.exe.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                throw new PowerShellExecutionException(process.ExitCode, stdout, stderr);
            }

            return stdout;
        }
        finally
        {
            try { File.Delete(scriptPath); } catch { /* best effort: no dejar el script (sin secretos, pero tampoco hace falta) */ }
        }
    }
}

/// <summary>El "ultimo error legible" que pide el icono de bandeja sale de aqui: Message ya resume stderr, nunca hace falta re-parsear la excepcion.</summary>
internal sealed class PowerShellExecutionException : Exception
{
    public int ExitCode { get; }
    public string StandardOutput { get; }
    public string StandardError { get; }

    public PowerShellExecutionException(int exitCode, string stdout, string stderr)
        : base(string.IsNullOrWhiteSpace(stderr) ? $"powershell.exe termino con codigo {exitCode}." : stderr.Trim())
    {
        ExitCode = exitCode;
        StandardOutput = stdout;
        StandardError = stderr;
    }
}
