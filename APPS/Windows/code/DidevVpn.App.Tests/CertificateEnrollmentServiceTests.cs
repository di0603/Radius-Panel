using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

public class CertificateEnrollmentServiceTests
{
    [Fact]
    public void InstallIssuedCertificate_AssociatesNonExportableSoftwareKey()
    {
        VerifyInstalledCertificate(CngProvider.MicrosoftSoftwareKeyStorageProvider, isTpmBacked: false);
    }

    [Fact]
    public void InstallIssuedCertificate_AssociatesTpmKeyWhenAvailable()
    {
        VerifyInstalledCertificate(
            CngProvider.MicrosoftPlatformCryptoProvider,
            isTpmBacked: true,
            tolerateUnavailableProvider: true);
    }

    private static void VerifyInstalledCertificate(
        CngProvider provider,
        bool isTpmBacked,
        bool tolerateUnavailableProvider = false)
    {
        var keyName = $"didev-vpn-test-{Guid.NewGuid():N}";
        CngKey key;
        try
        {
            key = CngKey.Create(
                CngAlgorithm.ECDsaP256,
                keyName,
                new CngKeyCreationParameters { Provider = provider });
        }
        catch (CryptographicException) when (tolerateUnavailableProvider)
        {
            return;
        }

        var enrollmentKey = new EnrolledKey(key, Array.Empty<byte>(), isTpmBacked);
        var enrollmentService = new CertificateEnrollmentService();
        X509Certificate2? installed = null;

        try
        {
            using var issued = IssueDeviceCertificate(enrollmentKey);
            installed = enrollmentService.InstallIssuedCertificate(issued, enrollmentKey);

            Assert.True(installed.HasPrivateKey);
            using var privateKey = installed.GetECDsaPrivateKey();
            using var publicKey = installed.GetECDsaPublicKey();
            Assert.NotNull(privateKey);
            Assert.NotNull(publicKey);

            var data = RandomNumberGenerator.GetBytes(32);
            var signature = privateKey!.SignData(data, HashAlgorithmName.SHA256);
            Assert.True(publicKey!.VerifyData(data, signature, HashAlgorithmName.SHA256));
        }
        finally
        {
            if (installed is not null)
            {
                enrollmentService.RemoveCertificate(installed);
                installed.Dispose();
            }

            try { key.Delete(); } catch (CryptographicException) { }
            enrollmentKey.Dispose();
        }
    }

    private static X509Certificate2 IssueDeviceCertificate(EnrolledKey enrollmentKey)
    {
        using var deviceKey = new ECDsaCng(enrollmentKey.CngKey);
        var devicePublicParameters = deviceKey.ExportParameters(includePrivateParameters: false);
        devicePublicParameters.Curve = ECCurve.NamedCurves.nistP256;
        using var devicePublicKey = ECDsa.Create(devicePublicParameters);

        using var issuerKey = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        var now = DateTimeOffset.UtcNow;
        var issuerRequest = new CertificateRequest("CN=didev-test-issuer", issuerKey, HashAlgorithmName.SHA384);
        issuerRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        using var issuer = issuerRequest.CreateSelfSigned(now.AddMinutes(-1), now.AddDays(1));

        var deviceRequest = new CertificateRequest("CN=didev-test-device", devicePublicKey, HashAlgorithmName.SHA384);
        return deviceRequest.Create(
            issuer,
            now.AddMinutes(-1),
            now.AddDays(1),
            RandomNumberGenerator.GetBytes(16));
    }
}
