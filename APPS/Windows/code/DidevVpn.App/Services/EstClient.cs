using System.Net.Http.Headers;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace DidevVpn.App.Services;

internal sealed class EstClient : IEstClient
{
    private const string Pkcs7ContentType = "application/pkcs7-mime";
    private const string Pkcs10ContentType = "application/pkcs10";

    public async Task<EstEnrollResult> SimpleEnrollAsync(
        Uri estBaseUrl, string username, string enrollToken, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct)
    {
        using var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (msg, cert, chain, errors) =>
                EstTrustValidator.CreateCallback(trustedChain)(msg, cert, chain, errors),
        };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };

        var auth = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{username}:{enrollToken}"));
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(estBaseUrl, "simpleenroll"))
        {
            Content = new StringContent(Convert.ToBase64String(csrDer), Encoding.ASCII, Pkcs10ContentType),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", auth);

        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        return await ReadPkcs7CertificateAsync(response, ct).ConfigureAwait(false);
    }

    public async Task<EstEnrollResult> SimpleReenrollAsync(
        Uri estBaseUrl, X509Certificate2 clientCertificate, byte[] csrDer, X509Certificate2Collection trustedChain, CancellationToken ct)
    {
        using var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (msg, cert, chain, errors) =>
                EstTrustValidator.CreateCallback(trustedChain)(msg, cert, chain, errors),
        };
        handler.ClientCertificates.Add(clientCertificate);
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };

        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(estBaseUrl, "simplereenroll"))
        {
            Content = new StringContent(Convert.ToBase64String(csrDer), Encoding.ASCII, Pkcs10ContentType),
        };

        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        return await ReadPkcs7CertificateAsync(response, ct).ConfigureAwait(false);
    }

    public async Task<EstStatus> GetStatusAsync(
        Uri estBaseUrl, X509Certificate2 clientCertificate, X509Certificate2Collection trustedChain, CancellationToken ct)
    {
        using var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (msg, cert, chain, errors) =>
                EstTrustValidator.CreateCallback(trustedChain)(msg, cert, chain, errors),
        };
        handler.ClientCertificates.Add(clientCertificate);
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };

        using var response = await http.GetAsync(new Uri(estBaseUrl, "status"), ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new EstRequestException(response.StatusCode, await SafeReadBodyAsync(response, ct).ConfigureAwait(false));
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        var root = doc.RootElement;
        return new EstStatus(
            Username: root.GetProperty("username").GetString() ?? string.Empty,
            NotAfter: root.GetProperty("notAfter").GetDateTimeOffset(),
            RenewDue: root.GetProperty("renewDue").GetBoolean(),
            MinAppVersion: root.TryGetProperty("minAppVersion", out var minVersion) ? minVersion.GetString() ?? "0.0.0" : "0.0.0");
    }

    private static async Task<EstEnrollResult> ReadPkcs7CertificateAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new EstRequestException(response.StatusCode, await SafeReadBodyAsync(response, ct).ConfigureAwait(false));
        }

        var body = (await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false)).Trim();
        byte[] der;
        try
        {
            der = Convert.FromBase64String(body);
        }
        catch (FormatException ex)
        {
            throw new EstRequestException(response.StatusCode, "La respuesta de EST no es base64 valido.", ex);
        }

        var cms = new SignedCms();
        cms.Decode(der);
        if (cms.Certificates.Count == 0)
        {
            throw new EstRequestException(response.StatusCode, "La respuesta PKCS7 de EST no contiene ningun certificado.");
        }

        // "certs-only": un unico certificado, el recien emitido. Se devuelve
        // tambien el cuerpo PKCS7 crudo (base64 sin cabecera PEM, tal cual lo
        // envio EST): CertificateEnrollmentService lo necesita sin tocar para
        // CX509Enrollment.InstallResponse.
        return new EstEnrollResult(new X509Certificate2(cms.Certificates[0]), body);
    }

    private static async Task<string> SafeReadBodyAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            return await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            return string.Empty;
        }
    }
}

/// <summary>
/// EST rechazo un simpleenroll/simplereenroll/status. El mensaje del panel
/// (`ApiError.message`) nunca lleva detalles internos (ver
/// server/src/estServer.ts, estErrorHandler) asi que es seguro mostrarlo tal
/// cual en la UI.
/// </summary>
internal sealed class EstRequestException : Exception
{
    public System.Net.HttpStatusCode StatusCode { get; }

    public EstRequestException(System.Net.HttpStatusCode statusCode, string responseBody, Exception? inner = null)
        : base($"EST respondio {(int)statusCode}: {responseBody}", inner)
    {
        StatusCode = statusCode;
    }
}
