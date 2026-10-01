using DidevVpn.Core.Net;

namespace DidevVpn.Tests.Net;

public class DebouncerTests
{
    // Ventanas pequenas de verdad (no un scheduler simulado): mas simple y
    // suficientemente fiable a esta escala (decenas de ms), con margen
    // generoso al comprobar.
    private static readonly TimeSpan Window = TimeSpan.FromMilliseconds(60);

    [Fact]
    public async Task Trigger_UnaVez_DisparaLaAccionUnaVezTrasLaVentana()
    {
        var count = 0;
        using var debouncer = new Debouncer(Window, () => Interlocked.Increment(ref count));

        debouncer.Trigger();
        await Task.Delay(Window * 3);

        Assert.Equal(1, count);
    }

    [Fact]
    public async Task Trigger_VariasVecesSeguidasDentroDeLaVentana_SoloDisparaUnaVez()
    {
        var count = 0;
        using var debouncer = new Debouncer(Window, () => Interlocked.Increment(ref count));

        for (var i = 0; i < 5; i++)
        {
            debouncer.Trigger();
            await Task.Delay(Window / 4); // mucho menos que la ventana: sigue siendo la misma "racha"
        }
        await Task.Delay(Window * 3);

        Assert.Equal(1, count);
    }

    [Fact]
    public async Task Trigger_DosVecesSeparadasPorMasDeLaVentana_DisparaDosVeces()
    {
        var count = 0;
        using var debouncer = new Debouncer(Window, () => Interlocked.Increment(ref count));

        debouncer.Trigger();
        await Task.Delay(Window * 3);
        debouncer.Trigger();
        await Task.Delay(Window * 3);

        Assert.Equal(2, count);
    }

    [Fact]
    public void Constructor_VentanaNoPositiva_LanzaArgumentOutOfRange()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new Debouncer(TimeSpan.Zero, () => { }));
        Assert.Throws<ArgumentOutOfRangeException>(() => new Debouncer(TimeSpan.FromMilliseconds(-1), () => { }));
    }

    [Fact]
    public async Task Dispose_CancelaElDisparoPendiente()
    {
        var count = 0;
        var debouncer = new Debouncer(Window, () => Interlocked.Increment(ref count));

        debouncer.Trigger();
        debouncer.Dispose();
        await Task.Delay(Window * 3);

        Assert.Equal(0, count);
    }
}
