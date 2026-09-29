using System.Reflection;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App.Services;

internal static class AppVersionHelper
{
    /// <summary>
    /// build.ps1 fija esta version con -p:Version=X.Y.Z en cada compilacion
    /// real (ver README de didev-vpn-windows); en un `dotnet build` suelto se
    /// usa el <c>&lt;Version&gt;</c> por defecto del .csproj.
    /// </summary>
    public static AppVersion GetAppVersion()
    {
        var informationalVersion = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        var assemblyVersion = Assembly.GetExecutingAssembly().GetName().Version;
        var candidate = informationalVersion
            ?? (assemblyVersion is null ? "0.0.0" : $"{assemblyVersion.Major}.{assemblyVersion.Minor}.{assemblyVersion.Build}");
        return AppVersion.TryParse(candidate, out var parsed) ? parsed : new AppVersion(0, 0, 0);
    }
}
