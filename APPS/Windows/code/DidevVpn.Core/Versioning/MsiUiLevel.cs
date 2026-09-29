namespace DidevVpn.Core.Versioning;

/// <summary>
/// Interpreta la propiedad MSI <c>UILevel</c> que el instalador pasa a
/// <c>didev-vpn.exe --uninstall-cleanup</c> (ver Package.wxs, custom action
/// UninstallCleanupCmd): en una desinstalacion silenciosa
/// (<c>msiexec /x ... /qn</c>), UILevel vale 2 (INSTALLUILEVEL_NONE) y no hay
/// nadie que pueda contestar a un MessageBox, asi que hay que dejarlo todo
/// tal cual en vez de "preguntar" (ver la seccion "Desinstalacion" del
/// README: sin poder preguntar, el valor por defecto es el mas seguro, no
/// borrar nada). Referencia: msi.h, INSTALLUILEVEL_NONE=2, _BASIC=3,
/// _REDUCED=4, _FULL=5 (mas flags que no importan aqui).
/// </summary>
public static class MsiUiLevel
{
    /// <summary>
    /// Sin argumento "--uilevel" (p.ej. si alguien ejecuta el .exe a mano) se
    /// asume UI completa: solo el propio instalador tiene motivos para pedir
    /// silencio explicitamente.
    /// </summary>
    public const int DefaultWhenUnspecified = 5;

    public static bool IsSilent(int uiLevel) => uiLevel <= 2;
}
