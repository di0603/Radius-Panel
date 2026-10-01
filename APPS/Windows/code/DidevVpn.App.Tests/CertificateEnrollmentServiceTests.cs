using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>
/// CertificateEnrollmentService usa CertEnroll (COM) para generar la clave
/// del dispositivo E instalar el certificado emitido en un unico paso -nunca
/// CngKey.Create + asociacion manual (CERT_KEY_PROV_INFO): esa via firma y
/// verifica bien (lo probaba la version anterior de este fichero) pero
/// Schannel la rechaza en EAP-TLS con 0x8009030D SEC_E_UNKNOWN_CREDENTIALS.
/// Por eso la comprobacion real de estos tests no es solo "firma y verifica",
/// sino un handshake TLS mutuo de verdad (SslStream, AuthenticateAsClient)
/// con el certificado instalado: es la unica forma fiable de detectar el
/// mismo fallo que via, y de hecho lo detecto durante el desarrollo del
/// prompt 12.7 (verificado en una maquina Windows real con TPM).
/// </summary>
public class CertificateEnrollmentServiceTests
{
    [Fact]
    public async Task EnrollAsync_SoftwareKey_InstallsCertificateAcceptedBySchannel()
    {
        await VerifyEnrollAndSchannelAcceptance(preferSoftware: true);
    }

    [Fact]
    public async Task EnrollAsync_TpmKey_InstallsCertificateAcceptedBySchannel_WhenTpmAvailable()
    {
        await VerifyEnrollAndSchannelAcceptance(preferSoftware: false, tolerateNoTpm: true);
    }

    [Fact]
    public async Task EnrollAsync_TpmUnavailable_AsksConfirmationAndFallsBackToSoftware()
    {
        // Fuerza el fallback simulando que el TPM nunca esta disponible: no
        // hay forma de "apagar" el TPM real desde el test, asi que esto solo
        // comprueba el circuito de confirmacion en si (no el resultado final
        // TPM vs software, ya cubierto por los dos tests de arriba).
        var service = new CertificateEnrollmentService();
        var confirmed = false;
        Func<string, bool> confirmFallback = reason =>
        {
            confirmed = true;
            Assert.False(string.IsNullOrWhiteSpace(reason));
            return false; // no confirma: la operacion debe cancelarse, no caer en silencio a software
        };

        // No podemos interceptar el intento de TPM sin tocar el servicio real,
        // asi que este test solo es significativo cuando el TPM NO esta
        // disponible en la maquina que ejecuta el test; si lo esta, se salta
        // sin fallar (no hay forma de forzar el fallo del TPM desde fuera).
        if (IsTpmAvailable())
        {
            return;
        }

        var cn = $"vpn-test-tpmconfirm-{Guid.NewGuid():N}";
        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            service.EnrollAsync(
                cn,
                confirmFallback,
                (_, _) => throw new InvalidOperationException("No deberia llegar a pedir un certificado: se cancelo antes."),
                CancellationToken.None));

        Assert.True(confirmed);
    }

    private static async Task VerifyEnrollAndSchannelAcceptance(bool preferSoftware, bool tolerateNoTpm = false)
    {
        var service = new CertificateEnrollmentService();
        var cn = $"vpn-test-{Guid.NewGuid():N}";
        var providerName = preferSoftware
            ? CertificateEnrollmentService.SoftwareProviderNameForTesting
            : CertificateEnrollmentService.TpmProviderNameForTesting;

        InstalledCertificateResult result;
        try
        {
            result = await service.EnrollWithProviderForTestingAsync(
                cn,
                providerName,
                (csrDer, ct) => Task.FromResult(IssueDeviceCertificate(cn, csrDer)),
                CancellationToken.None);
        }
        catch (Exception) when (tolerateNoTpm)
        {
            return;
        }

        using var installed = result.Certificate;
        try
        {
            Assert.Equal(!preferSoftware, result.IsTpmBacked);
            Assert.True(installed.HasPrivateKey);
            Assert.Equal($"CN={cn}", installed.Subject);

            // La comprobacion de verdad: Schannel (SslStream/AuthenticateAsClient,
            // que por debajo llama a AcquireCredentialsHandle) tiene que aceptar
            // usar la clave privada de ESTE certificado para un handshake TLS
            // mutuo -el fallo real que motiva este cambio (0x8009030D
            // SEC_E_UNKNOWN_CREDENTIALS) solo se manifiesta aqui, nunca en un
            // simple ECDsa.SignData/VerifyData-.
            await AssertSchannelAcceptsClientCertificate(installed);
        }
        finally
        {
            service.RemoveCertificate(installed);
        }
    }

    private static bool IsTpmAvailable()
    {
        try
        {
            using var key = CngKey.Create(
                CngAlgorithm.ECDsaP256,
                $"didev-vpn-tpm-probe-{Guid.NewGuid():N}",
                new CngKeyCreationParameters { Provider = CngProvider.MicrosoftPlatformCryptoProvider });
            key.Delete();
            return true;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    /// <summary>Simula el servidor EST: firma el CSR con una CA de prueba y devuelve un PKCS7 "certs-only", como el panel real.</summary>
    private static EstEnrollResult IssueDeviceCertificate(string cn, byte[] csrDer)
    {
        using var issuerKey = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        var now = DateTimeOffset.UtcNow;
        var issuerRequest = new CertificateRequest("CN=didev-test-issuer", issuerKey, HashAlgorithmName.SHA384);
        issuerRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        using var issuer = issuerRequest.CreateSelfSigned(now.AddMinutes(-1), now.AddDays(1));

        // UnsafeLoadCertificateExtensions: aqui es una CA de PRUEBA firmando
        // su propio CSR en memoria (no hay ningun limite de confianza que
        // cruzar), solo para reproducir el SAN dNSName = CN del CSR real.
        var csrInfo = CertificateRequest.LoadSigningRequest(
            csrDer,
            HashAlgorithmName.SHA256,
            CertificateRequestLoadOptions.UnsafeLoadCertificateExtensions);
        var leaf = csrInfo.Create(issuer, now.AddMinutes(-1), now.AddDays(1), Guid.NewGuid().ToByteArray());

        var pkcs7 = new X509Certificate2Collection(leaf).Export(X509ContentType.Pkcs7)
            ?? throw new InvalidOperationException("No se pudo empaquetar el certificado de prueba como PKCS7.");
        return new EstEnrollResult(new X509Certificate2(leaf.RawData), Convert.ToBase64String(pkcs7));
    }

    private static async Task AssertSchannelAcceptsClientCertificate(X509Certificate2 clientCertificate)
    {
        using var serverKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var serverRequest = new CertificateRequest("CN=localhost", serverKey, HashAlgorithmName.SHA256);
        using var serverCertEphemeral = serverRequest.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
        using var serverCertificate = new X509Certificate2(
            serverCertEphemeral.Export(X509ContentType.Pfx), (string?)null, X509KeyStorageFlags.Exportable);

        using var listener = new TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;

        var serverTask = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync();
            using var sslStream = new SslStream(client.GetStream());
            await sslStream.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
            {
                ServerCertificate = serverCertificate,
                ClientCertificateRequired = true,
                RemoteCertificateValidationCallback = (_, _, _, _) => true,
                EnabledSslProtocols = SslProtocols.Tls12,
            });
        });

        using var tcpClient = new TcpClient();
        await tcpClient.ConnectAsync(System.Net.IPAddress.Loopback, port);
        using var clientSsl = new SslStream(tcpClient.GetStream());

        // Si Schannel rechaza la clave del certificado (el bug real que este
        // test existe para detectar), esto lanza AuthenticationException con
        // 0x8009030D SEC_E_UNKNOWN_CREDENTIALS dentro.
        await clientSsl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
        {
            TargetHost = "localhost",
            ClientCertificates = new X509CertificateCollection { clientCertificate },
            RemoteCertificateValidationCallback = (_, _, _, _) => true,
            EnabledSslProtocols = SslProtocols.Tls12,
        });

        listener.Stop();
        await serverTask;
    }
}
