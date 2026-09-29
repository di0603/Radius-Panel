namespace DidevVpn.App.Services;

/// <summary>
/// Log en fichero de texto plano (%LOCALAPPDATA%\didev-vpn\logs), rotado a
/// diario. NUNCA debe pasar por aqui: el token de alta, la clave privada, el
/// contenido de un certificado, ni el perfil completo -solo el nombre del
/// dispositivo (CN, ya publico como username RADIUS) y mensajes de estado.
/// Cada llamador es responsable de no pasar nada de eso; ver los comentarios
/// en los orquestadores.
/// </summary>
internal sealed class FileLogger
{
    private readonly object _lock = new();

    public void Info(string message) => Write("INFO", message);

    public void Warn(string message) => Write("WARN", message);

    public void Error(string message, Exception? exception = null) =>
        Write("ERROR", exception is null ? message : $"{message}: {exception.GetType().Name}: {exception.Message}");

    private void Write(string level, string message)
    {
        try
        {
            AppPaths.EnsureDataDirectoryExists();
            var file = Path.Combine(AppPaths.LogsDirectory, $"{DateTime.UtcNow:yyyy-MM-dd}.log");
            var line = $"{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ} [{level}] {message}{Environment.NewLine}";
            lock (_lock)
            {
                File.AppendAllText(file, line, System.Text.Encoding.UTF8);
            }
        }
        catch
        {
            // El log nunca debe tumbar la app: si no se puede escribir (disco
            // lleno, permisos...), se pierde esa linea y ya esta.
        }
    }
}
