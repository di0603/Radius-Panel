namespace DidevVpn.App.Tests;

/// <summary>
/// Las clases de test que leen o escriben ConnectionStore (el directorio de
/// conexiones del usuario, redirigido a una carpeta temporal) NO corren en
/// paralelo entre si: un test que deja un fichero corrupto a proposito (ListOrNull)
/// o que borra conexiones podia romper a otro que las listaba a la vez. Tambien
/// serializa los tests que crean y borran entradas de la agenda de RAS (rasphone.pbk
/// es un unico fichero del usuario: Add/Remove-VpnConnection concurrentes no deberian
/// pisarse; medido con 6 procesos a la vez y no se perdio nada, pero no hay motivo
/// para arriesgar la agenda real).
/// </summary>
[CollectionDefinition(Name)]
public sealed class ConnectionStoreCollection
{
    public const string Name = "ConnectionStore";
}
