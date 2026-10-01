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

    /// <summary>
    /// Tamanos verificados contra Windows con una conexion activa (prompt
    /// 12.9): RASCONNSTATUSW con 562 daba 632 (tamano invalido) y la app
    /// tomaba eso por "desconectada" aunque el tunel estuviera arriba.
    /// </summary>
    [Fact]
    public void StructSizes_MatchTheOnesWindowsAccepts()
    {
        Assert.Equal(1360, RasInterop.RasConn.Size);
        Assert.Equal(564, RasInterop.RasConnStatus.Size);
        Assert.Equal(80, RasInterop.RasPppIp.Size);
        Assert.Equal(60, RasInterop.RasStats.Size);
    }

    /// <summary>
    /// Integracion REAL: si hay alguna conexion PPP/VPN activa en el equipo
    /// que ejecuta el test (adaptador Ppp, Up, con IPv4), el lector tiene que
    /// verla Connected con su IP. Sin ninguna activa no hay nada que comprobar.
    /// </summary>
    [Fact]
    public void GetPhase_ConAUnaConexionActivaReal_LaVeConectadaConSuIp()
    {
        var active = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
            .FirstOrDefault(n => n.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Ppp
                && n.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up
                && n.GetIPProperties().UnicastAddresses.Any(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork));
        if (active is null)
        {
            return;
        }

        var reader = new RasStateReader();

        Assert.Equal(RasPhase.Connected, reader.GetPhase(active.Name).Phase);
        var state = reader.GetState(active.Name);
        Assert.True(state.Connected);
        Assert.False(string.IsNullOrEmpty(state.Ipv4Address));
        Assert.NotNull(reader.GetConnectedDuration(active.Name));
    }
}
