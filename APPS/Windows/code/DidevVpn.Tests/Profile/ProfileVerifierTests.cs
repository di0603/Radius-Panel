using System.Text;
using System.Text.Json;
using DidevVpn.Core.Profile;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

namespace DidevVpn.Tests.Profile;

public class ProfileVerifierTests
{
    // Vector de interoperabilidad REAL: clave, payload y firma generados con
    // `openssl genpkey -algorithm ED25519` / `openssl pkeyutl -sign -rawin`
    // -una implementacion totalmente independiente de BouncyCastle-, para
    // demostrar que el PEM parsing + la verificacion Ed25519 de esta app
    // interoperan de verdad con lo que producira el panel (Node usa
    // tambien Ed25519 estandar via OpenSSL, igual que aqui).
    private const string OpenSslPublicKeyPem = """
        -----BEGIN PUBLIC KEY-----
        MCowBQYDK2VwAyEAoqwyx4QDuMFjhSI5X7i9M1JEiHHuDk6Nr1j9KkUGCWs=
        -----END PUBLIC KEY-----
        """;

    private const string OpenSslSignedPayloadB64Url =
        "eyJ2ZXJzaW9uIjoxLCJ2YXJpYW50IjoiZnVsbCIsImNuIjoidnBuLWp1YW4tbGFwdG9wIiwic2VydmVyIjoidnBuLnZsYy5kaWRldi5lcyIsImFhYUlkIjoiQ049cmFkaXVzLnZwbi52bGMuZGlkZXYuZXMiLCJyb290Q2FTaGEyNTYiOiJhMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MDExMjIzMzQ0NTU2Njc3ODg5OWFhYmJjY2RkZWVmZiIsImNhQ2hhaW5QZW0iOiItLS0tLUJFR0lOIENFUlRJRklDQVRFLS0tLS1cblptRnJaUT09XG4tLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tIiwiaWtlIjp7ImVuY3J5cHRpb24iOiJhZXMyNTZnY20xNiIsInByZiI6InNoYTM4NCIsImRoR3JvdXAiOiJlY3AzODQifSwiZXNwIjp7ImVuY3J5cHRpb24iOiJhZXMyNTZnY20xNiIsImRoR3JvdXAiOiJlY3AzODQifSwidHVubmVsTW9kZSI6ImZ1bGwiLCJzcGxpdFJvdXRlcyI6W10sImRucyI6IjEuMS4xLjEiLCJlc3RCYXNlVXJsIjoiaHR0cHM6Ly9wa2kudmxjLmRpZGV2LmVzOjg0NDMvLndlbGwta25vd24vZXN0IiwiZW5yb2xsVG9rZW4iOiJlbC10b2tlbi1zZWNyZXRvIiwiaXNzdWVkQXQiOiIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJleHBpcmVzQXQiOiIyMDk5LTAxLTAyVDAwOjAwOjAwLjAwMFoifQ";

    private const string OpenSslSignatureB64Url =
        "Vk_Vq0H3VXmNF8se-8DmUApiXDRyoVR9a_ZZpOkAMAS-FQEo907o7kRPkZcm_mhGOhwufGStrwUZOgSdKWulBw";

    private static string BuildEnvelopeJson(string payloadB64Url, string signatureB64Url, string keyId = "vpn-profile-signing-v1")
        => JsonSerializer.Serialize(new { payload = payloadB64Url, signature = signatureB64Url, keyId });

    [Fact]
    public void Verify_VectorDeInteroperabilidadConOpenSSL_AceptaElPerfil()
    {
        var verifier = ProfileVerifier.FromPublicKeyPem(OpenSslPublicKeyPem);
        var envelopeJson = BuildEnvelopeJson(OpenSslSignedPayloadB64Url, OpenSslSignatureB64Url);

        var result = verifier.Verify(envelopeJson, now: new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.True(result.Success);
        Assert.NotNull(result.Profile);
        Assert.Equal("vpn-juan-laptop", result.Profile!.Cn);
        Assert.Equal(ProfileVariant.Full, result.Profile.Variant);
        Assert.Equal("el-token-secreto", result.Profile.EnrollToken);
        Assert.Equal("aes256gcm16", result.Profile.Ike.Encryption);
        Assert.Equal("a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff", result.Profile.RootCaSha256);
    }

    [Fact]
    public void Verify_VectorDeInteroperabilidad_UnByteCambiadoEnElPayload_RechazaLaFirma()
    {
        var verifier = ProfileVerifier.FromPublicKeyPem(OpenSslPublicKeyPem);
        var payloadBytes = Base64Url.Decode(OpenSslSignedPayloadB64Url);
        payloadBytes[10] ^= 0xFF;
        var tamperedPayload = Convert.ToBase64String(payloadBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var envelopeJson = BuildEnvelopeJson(tamperedPayload, OpenSslSignatureB64Url);

        var result = verifier.Verify(envelopeJson, now: new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.InvalidSignature, result.RejectionReason);
    }

    [Fact]
    public void Verify_ExpiresAtYaPaso_RechazaComoCaducado()
    {
        var verifier = ProfileVerifier.FromPublicKeyPem(OpenSslPublicKeyPem);
        var envelopeJson = BuildEnvelopeJson(OpenSslSignedPayloadB64Url, OpenSslSignatureB64Url);

        // El vector fijo caduca en 2099; forzamos "ahora" a despues de esa fecha.
        var result = verifier.Verify(envelopeJson, now: new DateTimeOffset(2100, 1, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.Expired, result.RejectionReason);
    }

    [Fact]
    public void Verify_ClavePublicaDistinta_RechazaLaFirma()
    {
        var (_, otherPublicPem) = GenerateKeyPairPem();
        var verifier = ProfileVerifier.FromPublicKeyPem(otherPublicPem);
        var envelopeJson = BuildEnvelopeJson(OpenSslSignedPayloadB64Url, OpenSslSignatureB64Url);

        var result = verifier.Verify(envelopeJson, now: new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.InvalidSignature, result.RejectionReason);
    }

    [Fact]
    public void Verify_VarianteQr_SeRechazaAunqueLaFirmaSeaValida()
    {
        var (privateKey, publicPem) = GenerateKeyPairPem();
        var payload = BuildValidProfilePayload(overrides: p => p["variant"] = "qr", includeCaChain: false);
        var envelopeJson = SignAndBuildEnvelope(privateKey, payload);
        var verifier = ProfileVerifier.FromPublicKeyPem(publicPem);

        var result = verifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.WrongVariant, result.RejectionReason);
    }

    [Fact]
    public void Verify_VersionDeEsquemaNoSoportada_Rechaza()
    {
        var (privateKey, publicPem) = GenerateKeyPairPem();
        var payload = BuildValidProfilePayload(overrides: p => p["version"] = 99);
        var envelopeJson = SignAndBuildEnvelope(privateKey, payload);
        var verifier = ProfileVerifier.FromPublicKeyPem(publicPem);

        var result = verifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.UnsupportedVersion, result.RejectionReason);
    }

    [Fact]
    public void Verify_PerfilValidoFirmadoConBouncyCastle_SeAcepta()
    {
        var (privateKey, publicPem) = GenerateKeyPairPem();
        var payload = BuildValidProfilePayload();
        var envelopeJson = SignAndBuildEnvelope(privateKey, payload);
        var verifier = ProfileVerifier.FromPublicKeyPem(publicPem);

        var result = verifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.True(result.Success);
        Assert.Equal("split", result.Profile!.TunnelMode);
        Assert.Single(result.Profile.SplitRoutes);
    }

    [Fact]
    public void Verify_KeyIdDesconocido_SeRechazaAntesDeMirarLaFirma()
    {
        var (privateKey, publicPem) = GenerateKeyPairPem();
        var payload = BuildValidProfilePayload();
        var payloadBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        var signer = new Ed25519Signer();
        signer.Init(forSigning: true, privateKey);
        signer.BlockUpdate(payloadBytes, 0, payloadBytes.Length);
        var signature = signer.GenerateSignature();
        var payloadB64Url = Convert.ToBase64String(payloadBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var signatureB64Url = Convert.ToBase64String(signature).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var envelopeJson = BuildEnvelopeJson(payloadB64Url, signatureB64Url, keyId: "vpn-profile-signing-v2");
        var verifier = ProfileVerifier.FromPublicKeyPem(publicPem);

        var result = verifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.UnknownKeyId, result.RejectionReason);
    }

    [Fact]
    public void ExpectedKeyId_CoincideConLaConstanteDelPanel()
    {
        // server/src/lib/vpnProfileSigning.ts: PROFILE_SIGNING_KEY_ID. Si esto falla porque
        // alguien cambio uno de los dos lados sin el otro, las apps ya distribuidas
        // empezarian a rechazar todos los perfiles nuevos con UnknownKeyId.
        Assert.Equal("vpn-profile-signing-v1", ProfileVerifier.ExpectedKeyId);
    }

    [Fact]
    public void Verify_SobreConJsonRoto_RechazaComoInvalidEnvelope()
    {
        var (_, publicPem) = GenerateKeyPairPem();
        var verifier = ProfileVerifier.FromPublicKeyPem(publicPem);

        var result = verifier.Verify("esto no es JSON", DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.InvalidEnvelope, result.RejectionReason);
    }

    private static (Ed25519PrivateKeyParameters PrivateKey, string PublicKeyPem) GenerateKeyPairPem()
    {
        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var keyPair = generator.GenerateKeyPair();
        var privateKey = (Ed25519PrivateKeyParameters)keyPair.Private;
        var publicKey = (Ed25519PublicKeyParameters)keyPair.Public;

        // SubjectPublicKeyInfo DER = 12 bytes de cabecera fija (OID Ed25519) + 32 bytes de clave.
        var spki = new byte[] { 0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00 }
            .Concat(publicKey.GetEncoded())
            .ToArray();
        var pem = "-----BEGIN PUBLIC KEY-----\n" +
                  string.Join("\n", Chunk(Convert.ToBase64String(spki), 64)) +
                  "\n-----END PUBLIC KEY-----\n";
        return (privateKey, pem);
    }

    private static IEnumerable<string> Chunk(string value, int size)
    {
        for (var i = 0; i < value.Length; i += size)
        {
            yield return value.Substring(i, Math.Min(size, value.Length - i));
        }
    }

    private static Dictionary<string, object?> BuildValidProfilePayload(Action<Dictionary<string, object?>>? overrides = null, bool includeCaChain = true)
    {
        var payload = new Dictionary<string, object?>
        {
            ["version"] = 1,
            ["variant"] = "full",
            ["cn"] = "vpn-maria-vps",
            ["server"] = "vpn.vlc.didev.es",
            ["aaaId"] = "CN=radius.vpn.vlc.didev.es",
            ["rootCaSha256"] = "00112233445566778899aabbccddeeff00112233445566778899aabbccddee",
            ["ike"] = new Dictionary<string, object?> { ["encryption"] = "aes256gcm16", ["prf"] = "sha384", ["dhGroup"] = "ecp384" },
            ["esp"] = new Dictionary<string, object?> { ["encryption"] = "aes256gcm16", ["dhGroup"] = "ecp384" },
            ["tunnelMode"] = "split",
            ["splitRoutes"] = new[] { "192.168.10.0/24" },
            ["dns"] = null,
            ["estBaseUrl"] = "https://pki.vlc.didev.es:8443/.well-known/est",
            ["enrollToken"] = "otro-token-secreto",
            ["issuedAt"] = "2026-01-01T00:00:00.000Z",
            ["expiresAt"] = DateTimeOffset.UtcNow.AddHours(24).ToString("O"),
        };
        if (includeCaChain)
        {
            payload["caChainPem"] = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----";
        }
        overrides?.Invoke(payload);
        return payload;
    }

    private static string SignAndBuildEnvelope(Ed25519PrivateKeyParameters privateKey, Dictionary<string, object?> payload)
    {
        var payloadBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        var signer = new Ed25519Signer();
        signer.Init(forSigning: true, privateKey);
        signer.BlockUpdate(payloadBytes, 0, payloadBytes.Length);
        var signature = signer.GenerateSignature();

        var payloadB64Url = Convert.ToBase64String(payloadBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var signatureB64Url = Convert.ToBase64String(signature).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return BuildEnvelopeJson(payloadB64Url, signatureB64Url);
    }
}
