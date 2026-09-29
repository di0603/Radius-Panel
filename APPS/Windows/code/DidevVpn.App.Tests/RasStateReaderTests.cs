using DidevVpn.App.Services.Ras;

namespace DidevVpn.App.Tests;

/// <summary>
/// Solo lo que se puede probar de verdad SIN una conexion RAS activa en esta
/// maquina (no hay ninguna VPN conectada en este entorno de desarrollo):
/// que el P/Invoke no lanza para los casos "no existe"/"sin conexiones", que
/// es justo el contrato que necesita ConnectionStateService. Queda SIN
/// validar contra una conexion realmente activa -ver el comentario de
/// RasInterop y el README, "Riesgos e incognitas"-.
/// </summary>
public class RasStateReaderTests
{
    private static readonly string NonExistentName = $"didev-test-no-existe-{Guid.NewGuid():N}";

    [Fact]
    public void EntryExists_NombreQueNoEstaEnLaAgenda_DevuelveFalseSinLanzar()
    {
        var reader = new RasStateReader();
        Assert.False(reader.EntryExists(NonExistentName));
    }

    [Fact]
    public void GetState_NombreQueNoEstaConectado_DevuelveDesconectadoSinLanzar()
    {
        var reader = new RasStateReader();
        var state = reader.GetState(NonExistentName);
        Assert.False(state.Connected);
        Assert.Null(state.Ipv4Address);
    }
}
