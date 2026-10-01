using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Xml.Linq;
using DidevVpn.App.Services;
using DidevVpn.App.Services.Ras;

namespace DidevVpn.App.Tests;

public class EapUserCredentialStoreTests
{
    [Fact]
    public void BuildCredentialsXml_UsesEapTlsAndCarriesOnlyThePublicCertificate()
    {
        var der = new byte[] { 0x30, 0x82, 0x01, 0x0A, 0xFF };
        var doc = XDocument.Parse(EapUserCredentialStore.BuildCredentialsXml(der));

        Assert.Equal("EapHostUserCredentials", doc.Root!.Name.LocalName);
        Assert.Equal("http://www.microsoft.com/provisioning/EapHostUserCredentials", doc.Root.Name.NamespaceName);

        var types = doc.Descendants().Where(e => e.Name.LocalName == "Type").Select(e => e.Value).ToList();
        Assert.All(types, t => Assert.Equal("13", t)); // EAP-TLS, tanto en EapMethod como en Eap

        var userCert = doc.Descendants().Single(e => e.Name.LocalName == "UserCert");
        Assert.Equal("http://www.microsoft.com/provisioning/EapTlsUserPropertiesV1", userCert.Name.NamespaceName);
        Assert.Equal("3082010AFF", userCert.Value);

        // Nunca nada que parezca una clave privada ni una contrasena.
        Assert.DoesNotContain(doc.Descendants(), e =>
            e.Name.LocalName.Contains("Password", StringComparison.OrdinalIgnoreCase) ||
            e.Name.LocalName.Contains("PrivateKey", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void BuildMinimalTlsConfigXml_IsWellFormedEapTls()
    {
        var doc = XDocument.Parse(EapUserCredentialStore.BuildMinimalTlsConfigXml());
        Assert.Equal("EapHostConfig", doc.Root!.Name.LocalName);
        Assert.Equal("13", doc.Descendants().First(e => e.Name.LocalName == "Type").Value);
    }

    /// <summary>
    /// Integracion REAL con Windows: entrada RAS de prueba + certificado
    /// autofirmado en CurrentUser\My; guarda las credenciales, comprueba con
    /// RasGetEapUserData que Windows las guardo y lo borra todo.
    /// </summary>
    [Fact]
    public void SaveCertificate_StoresBlobReadableWithRasGetEapUserData_AndCleansUp()
    {
        var entryName = $"didev-test-eap-{Guid.NewGuid():N}"[..28];
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={entryName}", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new Oid("1.3.6.1.5.5.7.3.2") }, true));
        var now = DateTimeOffset.UtcNow;
        using var ephemeral = request.CreateSelfSigned(now.AddMinutes(-5), now.AddDays(1));
        using var cert = new X509Certificate2(ephemeral.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.PersistKeySet);

        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        store.Add(cert);

        var credentials = new EapUserCredentialStore();
        try
        {
            PowerShellRunner.RunScript(
                $"Add-VpnConnection -Name '{entryName}' -ServerAddress '203.0.113.1' -TunnelType Ikev2 -AuthenticationMethod MachineCertificate -Force | Out-Null");

            Assert.Null(credentials.GetStoredBlob(entryName));

            credentials.SaveCertificate(entryName, cert);

            var blob = credentials.GetStoredBlob(entryName);
            Assert.NotNull(blob);
            Assert.NotEmpty(blob!);
        }
        finally
        {
            try
            {
                PowerShellRunner.RunScript(
                    $"if (Get-VpnConnection -Name '{entryName}' -ErrorAction SilentlyContinue) {{ Remove-VpnConnection -Name '{entryName}' -Force }}");
            }
            catch
            {
                // best effort
            }
            store.Remove(cert);
        }
    }
}
