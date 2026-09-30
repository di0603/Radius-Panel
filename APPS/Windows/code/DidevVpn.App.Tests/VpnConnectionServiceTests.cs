using System.Linq;
using System.Xml.Linq;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>
/// El XML EAP (item 7 del prompt 12.7): FilteringInfo/CAHashList con el
/// emisor del certificado del dispositivo, para que SimpleCertSelection no
/// tenga que elegir entre varios candidatos en CurrentUser\My -sin esto,
/// rasdial.exe fallaba con "Error de Acceso remoto 703" porque no hay
/// consola con la que preguntar cual usar-.
/// </summary>
public class VpnConnectionServiceTests
{
    [Fact]
    public void BuildEapConfigXml_IncludesIssuerHashFilter_SeparateFromTrustedRootCA()
    {
        var xml = XDocument.Parse(
            VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", "ROOTTHUMBPRINT1234", "ISSUERTHUMBPRINT5678"));

        var trustedRootCa = xml.Descendants().Single(e => e.Name.LocalName == "TrustedRootCA").Value;
        Assert.Equal("ROOTTHUMBPRINT1234", trustedRootCa);

        var issuerHash = xml.Descendants().Single(e => e.Name.LocalName == "IssuerHash").Value;
        Assert.Equal("ISSUERTHUMBPRINT5678", issuerHash);

        var caHashList = xml.Descendants().Single(e => e.Name.LocalName == "CAHashList");
        Assert.Equal("true", caHashList.Attribute("Enabled")?.Value);

        var simpleCertSelection = xml.Descendants().Single(e => e.Name.LocalName == "SimpleCertSelection").Value;
        Assert.Equal("true", simpleCertSelection);
    }

    [Fact]
    public void BuildEapConfigXml_FallsBackToRootThumbprint_WhenDeviceCertWasIssuedDirectlyByRoot()
    {
        // Dispositivo "vps" de prueba (CLAUDE.md): sin intermedia todavia,
        // la raiz firma directamente. FindIssuerThumbprint (EnrollmentOrchestrator)
        // ya resuelve esto a la huella de la raiz; aqui solo se comprueba que
        // el XML acepta perfectamente que ambas huellas coincidan.
        var xml = XDocument.Parse(
            VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", "ROOTTHUMBPRINT1234", "ROOTTHUMBPRINT1234"));

        var issuerHash = xml.Descendants().Single(e => e.Name.LocalName == "IssuerHash").Value;
        Assert.Equal("ROOTTHUMBPRINT1234", issuerHash);
    }
}
