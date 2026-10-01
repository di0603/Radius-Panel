namespace DidevVpn.App.Services;

/// <summary>Variante de distribucion: cambia que puede hacerse sin elevar (ver README).</summary>
internal enum AppVariant
{
    /// <summary>Instalada por el MSI: en Program Files, raiz en LocalMachine\Root, tarea para todos los usuarios.</summary>
    Installed,

    /// <summary>Un unico .exe portable: sin admin salvo, la primera vez, instalar la raiz.</summary>
    Portable,
}

/// <summary>
/// Rutas de datos de usuario (%LOCALAPPDATA%\didev-vpn) y deteccion de la
/// variante de distribucion. Nunca junto al .exe -el portable no debe
/// mezclar datos de usuario con el binario, ver el enunciado original-.
/// </summary>
internal static class AppPaths
{
    public const string DisplayName = "didev VPN";

    /// <summary>Variable de entorno SOLO PARA PRUEBAS: redirige todos los datos (log, conexiones, registro de certificados) a otra carpeta, para que los tests no escriban en los datos reales del usuario.</summary>
    public const string DataDirectoryOverrideVariable = "DIDEVVPN_DATA_DIR";

    public static string DataDirectory { get; } =
        Environment.GetEnvironmentVariable(DataDirectoryOverrideVariable) is { Length: > 0 } overridden
            ? overridden
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "didev-vpn");

    public static string LogsDirectory => Path.Combine(DataDirectory, "logs");

    /// <summary>
    /// Un fichero JSON por conexion (nombrado por su "cn", ver ConnectionStore):
    /// esta app es un cliente GENERICO desde el prompt 12.5, puede tener varias
    /// conexiones/servidores a la vez -ya no hay un unico "device.json"-.
    /// </summary>
    public static string ConnectionsDirectory => Path.Combine(DataDirectory, "connections");

    /// <summary>
    /// Instalada = el .exe vive bajo Program Files (lo pone ahi el MSI).
    /// No es infalible al 100% si alguien copia el .exe a mano, pero es la
    /// misma senal que usa el propio Windows para "instalado vs portable" en
    /// la practica, y es la unica que no depende de un fichero marcador que
    /// el MSI tendria que mantener aparte.
    /// </summary>
    public static AppVariant DetectVariant()
    {
        // Nunca Assembly.Location: en single-file siempre devuelve "" (IL3000), y
        // Environment.ProcessPath no falta nunca en la practica en Windows.
        var exePath = Environment.ProcessPath ?? string.Empty;
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        return exePath.StartsWith(programFiles, StringComparison.OrdinalIgnoreCase)
               || exePath.StartsWith(programFilesX86, StringComparison.OrdinalIgnoreCase)
            ? AppVariant.Installed
            : AppVariant.Portable;
    }

    /// <summary>Ruta actual del propio ejecutable (para registrar la tarea programada apuntando aqui).</summary>
    public static string CurrentExecutablePath =>
        Environment.ProcessPath ?? throw new InvalidOperationException("No se ha podido determinar la ruta del ejecutable actual.");

    public static void EnsureDataDirectoryExists()
    {
        Directory.CreateDirectory(DataDirectory);
        Directory.CreateDirectory(LogsDirectory);
        Directory.CreateDirectory(ConnectionsDirectory);
    }
}
