using System.Runtime.CompilerServices;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>
/// Los tests NUNCA tocan los datos reales del usuario (%LOCALAPPDATA%\didev-vpn:
/// log, conexiones, registro de certificados): antes de que nada use
/// AppPaths, se redirige todo a una carpeta temporal propia de esta ejecucion.
/// </summary>
internal static class TestDataDirectory
{
    public static string Path { get; } =
        System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"didev-vpn-tests-{Guid.NewGuid():N}");

    [ModuleInitializer]
    internal static void Redirect()
    {
        Environment.SetEnvironmentVariable(AppPaths.DataDirectoryOverrideVariable, Path);
    }
}

public class TestDataDirectoryTests
{
    [Fact]
    public void AppPaths_InTests_PointsToATemporaryDirectory_NotTheRealUserData()
    {
        var real = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "didev-vpn");

        Assert.False(string.Equals(real, AppPaths.DataDirectory, StringComparison.OrdinalIgnoreCase));
        Assert.StartsWith(System.IO.Path.GetTempPath(), AppPaths.DataDirectory, StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith(System.IO.Path.GetTempPath(), AppPaths.LogsDirectory, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void FileLogger_InTests_WritesUnderTheTemporaryDirectory()
    {
        new FileLogger().Warn("vpn-rota: fallo simulado de prueba");

        var logs = Directory.GetFiles(AppPaths.LogsDirectory, "*.log");
        Assert.NotEmpty(logs);
        Assert.All(logs, f => Assert.StartsWith(System.IO.Path.GetTempPath(), f, StringComparison.OrdinalIgnoreCase));
    }
}
