namespace DidevVpn.App.Tests;

/// <summary>
/// Las clases de test que leen o escriben ConnectionStore (el directorio de
/// conexiones del usuario, redirigido a una carpeta temporal) NO corren en
/// paralelo entre si: un test que deja un fichero corrupto a proposito (ListOrNull)
/// o que borra conexiones podia romper a otro que las listaba a la vez.
/// </summary>
[CollectionDefinition(Name)]
public sealed class ConnectionStoreCollection
{
    public const string Name = "ConnectionStore";
}
