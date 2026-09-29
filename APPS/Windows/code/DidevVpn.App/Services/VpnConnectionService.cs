using System.Text;

namespace DidevVpn.App.Services;

/// <summary>
/// Crea/actualiza la conexion IKEv2/EAP-TLS "didev VPN" con los cmdlets
/// VpnClient (Add-VpnConnection, Set-VpnConnectionIPsecConfiguration,
/// Add-VpnConnectionRoute) via PowerShellRunner. SIEMPRE por usuario (nunca
/// -AllUserConnection): no hace falta elevar para nada de esto (ver
/// APPS/Windows/NOTAS-prompt-12-en-pausa.md, punto 2), y es lo que
/// corresponde a un certificado de cliente que vive en CurrentUser\My.
///
/// La plantilla del XML EAP es la misma, campo a campo, que ya usa
/// WINDOWS_INSTALL_PS1 en server/src/services/vpnClientPackages.ts del panel
/// (EAP tipo 13 = EAP-TLS, PerformServerValidation/AcceptServerName de la V2,
/// TrustedRootCA = huella SHA-1 tal cual la da $cert.Thumbprint en
/// PowerShell): ese script ya se probo de extremo a extremo con un
/// dispositivo real, asi que se reutiliza la misma forma exacta en vez de
/// inventar una nueva a partir solo de la documentacion.
/// </summary>
internal sealed class VpnConnectionService : IVpnConnectionService
{
    public void CreateOrUpdateConnection(VpnConnectionSpec spec)
    {
        var eapXml = BuildEapConfigXml(spec.EapServerName, spec.RootCertificateThumbprintSha1);
        var eapXmlPath = Path.Combine(Path.GetTempPath(), $"didev-vpn-eap-{Guid.NewGuid():N}.xml");
        File.WriteAllText(eapXmlPath, eapXml, Encoding.UTF8);

        try
        {
            var script = new StringBuilder();
            script.AppendLine("$ErrorActionPreference = 'Stop'");
            script.AppendLine($"$name = {PsString(spec.ConnectionName)}");
            script.AppendLine("if (Get-VpnConnection -Name $name -ErrorAction SilentlyContinue) {");
            script.AppendLine("  Remove-VpnConnection -Name $name -Force -ErrorAction Stop");
            script.AppendLine("}");
            script.AppendLine($"$eapXml = [xml](Get-Content -Raw -Path {PsString(eapXmlPath)})");
            script.AppendLine("$vpnParams = @{");
            script.AppendLine("  Name = $name");
            script.AppendLine($"  ServerAddress = {PsString(spec.ServerAddress)}");
            script.AppendLine("  TunnelType = 'Ikev2'");
            script.AppendLine("  AuthenticationMethod = 'Eap'");
            script.AppendLine("  EapConfigXmlStream = $eapXml");
            script.AppendLine($"  SplitTunneling = {(spec.SplitTunneling ? "$true" : "$false")}");
            script.AppendLine("  Force = $true");
            script.AppendLine("}");
            script.AppendLine("Add-VpnConnection @vpnParams | Out-Null");

            script.AppendLine("$ipsecParams = @{");
            script.AppendLine("  ConnectionName = $name");
            script.AppendLine($"  AuthenticationTransformConstants = {PsString(spec.IkeEncryption)}");
            script.AppendLine($"  CipherTransformConstants = {PsString(spec.IkeEncryption)}");
            script.AppendLine($"  EncryptionMethod = {PsString(spec.IkeEncryption)}");
            script.AppendLine($"  IntegrityCheckMethod = {PsString(spec.IkeIntegrity)}");
            script.AppendLine($"  DHGroup = {PsString(spec.IkeDhGroup)}");
            script.AppendLine($"  PfsGroup = {PsString(spec.EspPfsGroup)}");
            script.AppendLine("  Force = $true");
            script.AppendLine("}");
            script.AppendLine("Set-VpnConnectionIPsecConfiguration @ipsecParams | Out-Null");

            foreach (var route in spec.SplitRoutes)
            {
                script.AppendLine($"Add-VpnConnectionRoute -ConnectionName $name -DestinationPrefix {PsString(route)} -Force | Out-Null");
            }

            PowerShellRunner.RunScript(script.ToString());
        }
        finally
        {
            try { File.Delete(eapXmlPath); } catch { /* best effort */ }
        }
    }

    public void RemoveConnection(string connectionName)
    {
        var script =
            $"$ErrorActionPreference = 'Stop'\n" +
            $"if (Get-VpnConnection -Name {PsString(connectionName)} -ErrorAction SilentlyContinue) {{\n" +
            $"  Remove-VpnConnection -Name {PsString(connectionName)} -Force\n" +
            $"}}\n";
        PowerShellRunner.RunScript(script);
    }

    public bool ConnectionExists(string connectionName)
    {
        var script =
            $"if (Get-VpnConnection -Name {PsString(connectionName)} -ErrorAction SilentlyContinue) {{ 'yes' }} else {{ 'no' }}";
        return PowerShellRunner.RunScript(script).Trim() == "yes";
    }

    public bool IsConnected(string connectionName)
    {
        var script =
            $"(Get-VpnConnection -Name {PsString(connectionName)} -ErrorAction SilentlyContinue).ConnectionStatus";
        return PowerShellRunner.RunScript(script).Trim() == "Connected";
    }

    public void Connect(string connectionName)
    {
        // No existe Connect-VpnConnection: el mecanismo real es rasdial (ver
        // APPS/Windows/NOTAS-prompt-12-en-pausa.md, punto 1).
        PowerShellRunner.RunScript($"$ErrorActionPreference='Stop'; & rasdial.exe {PsQuoteForRasdial(connectionName)}");
    }

    public void Disconnect(string connectionName)
    {
        PowerShellRunner.RunScript($"$ErrorActionPreference='Stop'; & rasdial.exe {PsQuoteForRasdial(connectionName)} /disconnect");
    }

    public string? GetAssignedIPv4Address(string connectionName)
    {
        try
        {
            var script =
                $"(Get-NetIPAddress -InterfaceAlias {PsString(connectionName)} -AddressFamily IPv4 -ErrorAction SilentlyContinue | " +
                "Select-Object -First 1 -ExpandProperty IPAddress)";
            var result = PowerShellRunner.RunScript(script).Trim();
            return string.IsNullOrEmpty(result) ? null : result;
        }
        catch (PowerShellExecutionException)
        {
            return null;
        }
    }

    private static string BuildEapConfigXml(string serverName, string rootThumbprintSha1) =>
        $"""
        <EapHostConfig xmlns="http://www.microsoft.com/provisioning/EapHostConfig">
          <EapMethod>
            <Type xmlns="http://www.microsoft.com/provisioning/EapCommon">13</Type>
            <VendorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorId>
            <VendorType xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorType>
            <AuthorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</AuthorId>
          </EapMethod>
          <Config xmlns="http://www.microsoft.com/provisioning/EapHostConfig">
            <Eap xmlns="http://www.microsoft.com/provisioning/BaseEapConnectionPropertiesV1">
              <Type>13</Type>
              <EapType xmlns="http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV1">
                <CredentialsSource>
                  <CertificateStore>
                    <SimpleCertSelection>true</SimpleCertSelection>
                  </CertificateStore>
                </CredentialsSource>
                <ServerValidation>
                  <DisableUserPromptForServerValidation>true</DisableUserPromptForServerValidation>
                  <ServerNames>{serverName}</ServerNames>
                  <TrustedRootCA>{rootThumbprintSha1}</TrustedRootCA>
                </ServerValidation>
                <DifferentUsername>false</DifferentUsername>
                <PerformServerValidation xmlns="http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2">true</PerformServerValidation>
                <AcceptServerName xmlns="http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2">true</AcceptServerName>
              </EapType>
            </Eap>
          </Config>
        </EapHostConfig>
        """;

    /// <summary>Cadena literal de PowerShell entre comillas simples, con las comillas simples internas dobladas (escape estandar de PS).</summary>
    private static string PsString(string value) => "'" + value.Replace("'", "''") + "'";

    private static string PsQuoteForRasdial(string value) => "\"" + value.Replace("\"", "`\"") + "\"";
}
