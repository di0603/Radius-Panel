using System.Linq;
using System.Xml.Linq;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>
/// El XML EAP (items 7 del prompt 12.7 y 1 del 12.8): misma estructura, orden
/// y namespaces que el XML que genero Windows para una conexion EAP-TLS que
/// funciono, mas ServerNames/TrustedRootCA y el filtro por emisor
/// (TLSExtensions > FilteringInfo > CAHashList).
/// </summary>
public class VpnConnectionServiceTests
{
    private const string RootSha1 = "5C0DEDF66D5F6B169CA733F99D68899D50CF0136";
    private const string IssuerSha1 = "AABBCCDDEEFF00112233445566778899AABBCCDD";

    private const string NsEapHostConfig = "http://www.microsoft.com/provisioning/EapHostConfig";
    private const string NsTlsV1 = "http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV1";
    private const string NsTlsV2 = "http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2";
    private const string NsTlsV3 = "http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV3";

    [Fact]
    public void BuildEapConfigXml_IncludesIssuerHashFilter_SeparateFromTrustedRootCA()
    {
        var xml = XDocument.Parse(VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", RootSha1, IssuerSha1));

        Assert.Equal("radius.vpn.example.org", xml.Descendants().Single(e => e.Name.LocalName == "ServerNames").Value);
        Assert.Equal(
            "5c 0d ed f6 6d 5f 6b 16 9c a7 33 f9 9d 68 89 9d 50 cf 01 36 ",
            xml.Descendants().Single(e => e.Name.LocalName == "TrustedRootCA").Value);
        Assert.Equal(
            "aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ",
            xml.Descendants().Single(e => e.Name.LocalName == "IssuerHash").Value);

        var caHashList = xml.Descendants().Single(e => e.Name.LocalName == "CAHashList");
        Assert.Equal("true", caHashList.Attribute("Enabled")?.Value);
        Assert.Equal("true", xml.Descendants().Single(e => e.Name.LocalName == "SimpleCertSelection").Value);
        Assert.Equal("true", xml.Descendants().Single(e => e.Name.LocalName == "PerformServerValidation").Value);
        Assert.Equal("true", xml.Descendants().Single(e => e.Name.LocalName == "AcceptServerName").Value);
    }

    [Fact]
    public void BuildEapConfigXml_KeepsStructureOrderAndNamespacesOfWindowsGeneratedXml()
    {
        var xml = XDocument.Parse(VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", RootSha1, IssuerSha1));
        var eapType = xml.Descendants(XName.Get("EapType", NsTlsV1)).Single();

        // Orden exacto de los hijos de EapType (el esquema de EapHost es estricto).
        Assert.Equal(
            new[]
            {
                XName.Get("CredentialsSource", NsTlsV1),
                XName.Get("ServerValidation", NsTlsV1),
                XName.Get("DifferentUsername", NsTlsV1),
                XName.Get("PerformServerValidation", NsTlsV2),
                XName.Get("AcceptServerName", NsTlsV2),
                XName.Get("TLSExtensions", NsTlsV2),
            },
            eapType.Elements().Select(e => e.Name).ToArray());

        Assert.Equal(
            new[] { "DisableUserPromptForServerValidation", "ServerNames", "TrustedRootCA" },
            eapType.Element(XName.Get("ServerValidation", NsTlsV1))!.Elements().Select(e => e.Name.LocalName).ToArray());

        var filtering = eapType.Element(XName.Get("TLSExtensions", NsTlsV2))!.Elements().Single();
        Assert.Equal(XName.Get("FilteringInfo", NsTlsV3), filtering.Name);
        Assert.Equal(XName.Get("CAHashList", NsTlsV3), filtering.Elements().Single().Name);

        Assert.Equal(XName.Get("EapHostConfig", NsEapHostConfig), xml.Root!.Name);
    }

    [Fact]
    public void BuildEapConfigXml_IsASingleLineWithoutIndentation()
    {
        var text = VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", RootSha1, IssuerSha1);
        Assert.DoesNotContain('\n', text);
        Assert.DoesNotContain("> <", text);
    }

    [Fact]
    public void BuildEapConfigXml_FallsBackToRootThumbprint_WhenDeviceCertWasIssuedDirectlyByRoot()
    {
        // Dispositivo "vps" de prueba (CLAUDE.md): sin intermedia todavia,
        // la raiz firma directamente y ambas huellas coinciden.
        var xml = XDocument.Parse(VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", RootSha1, RootSha1));
        Assert.Equal(
            xml.Descendants().Single(e => e.Name.LocalName == "TrustedRootCA").Value,
            xml.Descendants().Single(e => e.Name.LocalName == "IssuerHash").Value);
    }

    [Theory]
    [InlineData("5C0DED", "5c 0d ed ")]
    [InlineData("5c 0d ed ", "5c 0d ed ")]
    [InlineData("", "")]
    public void FormatThumbprint_UsesWindowsFormat(string input, string expected) =>
        Assert.Equal(expected, VpnConnectionService.FormatThumbprint(input));

    /// <summary>
    /// Integracion real en Windows, SIN alta EST (no gasta tokens): crea una
    /// conexion de prueba con el XML generado y la borra despues. Si
    /// Add-VpnConnection rechaza el XML ("Failed to generate the EAP
    /// Configuration") el test falla con el mensaje de PowerShell.
    /// </summary>
    [Fact]
    public void BuildEapConfigXml_IsAcceptedByAddVpnConnection()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        const string name = "didev-vpn-xmltest";
        var xmlPath = Path.Combine(Path.GetTempPath(), $"didev-vpn-xmltest-{Guid.NewGuid():N}.xml");
        File.WriteAllText(xmlPath, VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", RootSha1, IssuerSha1));
        try
        {
            var script =
                "$ErrorActionPreference = 'Stop'\n" +
                $"$name = '{name}'\n" +
                "if (Get-VpnConnection -Name $name -ErrorAction SilentlyContinue) { Remove-VpnConnection -Name $name -Force }\n" +
                "try {\n" +
                $"  $eapXml = [xml](Get-Content -Raw -Path '{xmlPath}')\n" +
                "  Add-VpnConnection -Name $name -ServerAddress 'vpn.example.org' -TunnelType Ikev2 -AuthenticationMethod Eap -EapConfigXmlStream $eapXml -Force | Out-Null\n" +
                "  if (-not (Get-VpnConnection -Name $name -ErrorAction SilentlyContinue)) { throw 'la conexion no se ha creado' }\n" +
                "  'OK'\n" +
                "} finally {\n" +
                "  if (Get-VpnConnection -Name $name -ErrorAction SilentlyContinue) { Remove-VpnConnection -Name $name -Force }\n" +
                "}\n";
            Assert.Equal("OK", PowerShellRunner.RunScript(script).Trim());
        }
        finally
        {
            try { File.Delete(xmlPath); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void BuildEapConfigXml_NeverAsksTheUserToAcceptAServer_ButPinsRootAndServerName()
    {
        var xml = System.Xml.Linq.XDocument.Parse(
            VpnConnectionService.BuildEapConfigXml("radius.vpn.example.org", "AABBCC", "DDEEFF"));

        string Value(string name) => xml.Descendants().Single(e => e.Name.LocalName == name).Value;

        Assert.Equal("true", Value("DisableUserPromptForServerValidation"));
        Assert.Equal("radius.vpn.example.org", Value("ServerNames"));
        Assert.Equal("aa bb cc ", Value("TrustedRootCA"));
        Assert.Equal("true", Value("PerformServerValidation"));
    }
}
