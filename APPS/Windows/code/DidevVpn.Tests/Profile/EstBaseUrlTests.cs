using DidevVpn.Core.Profile;

namespace DidevVpn.Tests.Profile;

public class EstBaseUrlTests
{
    [Fact]
    public void Normalize_SinBarraFinal_CombinaComoSegmentoNuevo()
    {
        var baseUri = EstBaseUrl.Normalize("https://pki.vlc.didev.es:8443/.well-known/est");

        var combined = new Uri(baseUri, "simpleenroll");

        Assert.Equal("https://pki.vlc.didev.es:8443/.well-known/est/simpleenroll", combined.ToString());
    }

    [Fact]
    public void Normalize_ConBarraFinal_NoLaDuplica()
    {
        var baseUri = EstBaseUrl.Normalize("https://pki.vlc.didev.es:8443/.well-known/est/");

        var combined = new Uri(baseUri, "status");

        Assert.Equal("https://pki.vlc.didev.es:8443/.well-known/est/status", combined.ToString());
    }

    [Fact]
    public void Normalize_CadenaVacia_Lanza()
    {
        Assert.Throws<ArgumentException>(() => EstBaseUrl.Normalize(""));
    }
}
