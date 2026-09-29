using System.Security.Cryptography;
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
    // `openssl genpkey -algorithm ED25519` / `openssl pkey -pubout -outform DER` /
    // `openssl pkeyutl -sign -rawin` -una implementacion totalmente independiente
    // de BouncyCastle-, para demostrar que el parsing SPKI + la verificacion
    // Ed25519 de esta app interoperan de verdad con lo que produce el panel
    // (Node usa tambien Ed25519 estandar via OpenSSL). Formato del prompt 12.5:
    // signerPublicKey en el sobre, signerKeySha256 dentro del payload firmado.
    private const string OpenSslSignerPublicKeyB64Url = "MCowBQYDK2VwAyEAN1TMuQwBTZKv0cb_cjdEs6qFg2Wak4tubFbgG4zNmKQ";
    private const string OpenSslSignerKeySha256 = "d1486afcf15562581809f1cb1e0a4596f75261ac549f46a3c5035f5f2ca81b90";

    private const string OpenSslSignedPayloadB64Url =
        "eyJ2ZXJzaW9uIjoxLCJ2YXJpYW50IjoiZnVsbCIsImNuIjoidnBuLWp1YW4tbGFwdG9wIiwic2VydmVyIjoidnBuLnZsYy5kaWRldi5lcyIsImFhYUlkIjoiQ049cmFkaXVzLnZwbi52bGMuZGlkZXYuZXMiLCJyb290Q2FTaGEyNTYiOiJhMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MDExMjIzMzQ0NTU2Njc3ODg5OWFhYmJjY2RkZWVmZiIsInNpZ25lcktleVNoYTI1NiI6ImQxNDg2YWZjZjE1NTYyNTgxODA5ZjFjYjFlMGE0NTk2Zjc1MjYxYWM1NDlmNDZhM2M1MDM1ZjVmMmNhODFiOTAiLCJjYUNoYWluUGVtIjoiLS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tXG5abUZyWlE9PVxuLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLSIsImlrZSI6eyJlbmNyeXB0aW9uIjoiYWVzMjU2Z2NtMTYiLCJwcmYiOiJzaGEzODQiLCJkaEdyb3VwIjoiZWNwMzg0In0sImVzcCI6eyJlbmNyeXB0aW9uIjoiYWVzMjU2Z2NtMTYiLCJkaEdyb3VwIjoiZWNwMzg0In0sInR1bm5lbE1vZGUiOiJmdWxsIiwic3BsaXRSb3V0ZXMiOltdLCJkbnMiOiIxLjEuMS4xIiwiZXN0QmFzZVVybCI6Imh0dHBzOi8vcGtpLnZsYy5kaWRldi5lczo4NDQzLy53ZWxsLWtub3duL2VzdCIsImVucm9sbFRva2VuIjoiZWwtdG9rZW4tc2VjcmV0byIsImlzc3VlZEF0IjoiMjAyNi0wMS0wMVQwMDowMDowMC4wMDBaIiwiZXhwaXJlc0F0IjoiMjA5OS0wMS0wMlQwMDowMDowMC4wMDBaIn0";

    private const string OpenSslSignatureB64Url =
        "cjLsfkj_kPvs-VELUAjUlEvXmvtMb1sZMzzrqryWS4OiCImdoIj5XJyYCnC9Uoe-CmzqjiMXGSHVTuOwxwI2AQ";

    private static string BuildEnvelopeJson(
        string payloadB64Url, string signatureB64Url, string signerPublicKeyB64Url, string keyId = "vpn-profile-signing-v1")
        => JsonSerializer.Serialize(new { payload = payloadB64Url, signature = signatureB64Url, keyId, signerPublicKey = signerPublicKeyB64Url });

    [Fact]
    public void Verify_VectorDeInteroperabilidadConOpenSSL_AceptaElPerfil()
    {
        var envelopeJson = BuildEnvelopeJson(OpenSslSignedPayloadB64Url, OpenSslSignatureB64Url, OpenSslSignerPublicKeyB64Url);

        var result = ProfileVerifier.Verify(envelopeJson, now: new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.True(result.Success);
        Assert.NotNull(result.Profile);
        Assert.Equal("vpn-juan-laptop", result.Profile!.Cn);
        Assert.Equal(ProfileVariant.Full, result.Profile.Variant);
        Assert.Equal("el-token-secreto", result.Profile.EnrollToken);
        Assert.Equal("aes256gcm16", result.Profile.Ike.Encryption);
        Assert.Equal("a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff", result.Profile.RootCaSha256);
        Assert.Equal(OpenSslSignerKeySha256, result.Profile.SignerKeySha256);
    }

    [Fact]
    public void Verify_VectorDeInteroperabilidad_UnByteCambiadoEnElPayload_RechazaLaFirma()
    {
        var payloadBytes = Base64Url.Decode(OpenSslSignedPayloadB64Url);
        payloadBytes[10] ^= 0xFF;
        var tamperedPayload = Convert.ToBase64String(payloadBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var envelopeJson = BuildEnvelopeJson(tamperedPayload, OpenSslSignatureB64Url, OpenSslSignerPublicKeyB64Url);

        var result = ProfileVerifier.Verify(envelopeJson, now: new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.InvalidSignature, result.RejectionReason);
    }

    [Fact]
    public void Verify_ExpiresAtYaPaso_RechazaComoCaducado()
    {
        var envelopeJson = BuildEnvelopeJson(OpenSslSignedPayloadB64Url, OpenSslSignatureB64Url, OpenSslSignerPublicKeyB64Url);

        // El vector fijo caduca en 2099; forzamos "ahora" a despues de esa fecha.
        var result = ProfileVerifier.Verify(envelopeJson, now: new DateTimeOffset(2100, 1, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.Expired, result.RejectionReason);
    }

    [Fact]
    public void Verify_SignerPublicKeyDistintaDeLaQueFirmo_RechazaLaFirma()
    {
        // Sustituir signerPublicKey por la de OTRA clave (que no firmo esto): la
        // firma deja de verificar contra ella. Esto es justo el caso que hace
        // que "aprender la clave del propio sobre" siga siendo seguro: cambiar
        // signerPublicKey sin re-firmar invalida la firma.
        var (_, otherPublicKey) = GenerateKeyPair();
        var otherSpkiDer = Ed25519PublicKeySpki.Encode(otherPublicKey);
        var envelopeJson = BuildEnvelopeJson(
            OpenSslSignedPayloadB64Url, OpenSslSignatureB64Url, Base64Url.Encode(otherSpkiDer));

        var result = ProfileVerifier.Verify(envelopeJson, now: new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero));

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.InvalidSignature, result.RejectionReason);
    }

    [Fact]
    public void Verify_SignerKeySha256NoCoincideConSignerPublicKey_RechazaComoSobreIncoherente()
    {
        // Firma valida, signerPublicKey valida (es justo la que firmo) -pero el
        // payload declara un signerKeySha256 que no es el SHA-256 real de esa
        // clave-: el sobre es incoherente. Este es el caso de "sobre cuya
        // signerPublicKey no corresponde a signerKeySha256" del enunciado.
        var (privateKey, publicKey) = GenerateKeyPair();
        var payload = BuildValidProfilePayload(overrides: p => p["signerKeySha256"] = "00".PadRight(64, '0'));
        var envelopeJson = SignAndBuildEnvelope(privateKey, publicKey, payload);

        var result = ProfileVerifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.SignerKeyMismatch, result.RejectionReason);
    }

    [Fact]
    public void Verify_VarianteQr_SeRechazaAunqueLaFirmaSeaValida()
    {
        var (privateKey, publicKey) = GenerateKeyPair();
        var payload = BuildValidProfilePayload(overrides: p => p["variant"] = "qr", includeCaChain: false);
        var envelopeJson = SignAndBuildEnvelope(privateKey, publicKey, payload);

        var result = ProfileVerifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.WrongVariant, result.RejectionReason);
    }

    [Fact]
    public void Verify_VersionDeEsquemaNoSoportada_Rechaza()
    {
        var (privateKey, publicKey) = GenerateKeyPair();
        var payload = BuildValidProfilePayload(overrides: p => p["version"] = 99);
        var envelopeJson = SignAndBuildEnvelope(privateKey, publicKey, payload);

        var result = ProfileVerifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.UnsupportedVersion, result.RejectionReason);
    }

    [Fact]
    public void Verify_PerfilValidoFirmadoConBouncyCastle_SeAcepta()
    {
        var (privateKey, publicKey) = GenerateKeyPair();
        var payload = BuildValidProfilePayload();
        var envelopeJson = SignAndBuildEnvelope(privateKey, publicKey, payload);

        var result = ProfileVerifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.True(result.Success);
        Assert.Equal("split", result.Profile!.TunnelMode);
        Assert.Single(result.Profile.SplitRoutes);
    }

    [Fact]
    public void Verify_SobreConJsonRoto_RechazaComoInvalidEnvelope()
    {
        var result = ProfileVerifier.Verify("esto no es JSON", DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.InvalidEnvelope, result.RejectionReason);
    }

    [Fact]
    public void Verify_SobreSinSignerPublicKey_RechazaComoInvalidEnvelope()
    {
        var envelopeJson = JsonSerializer.Serialize(new { payload = "YWJj", signature = "ZGVm", keyId = "v1" });

        var result = ProfileVerifier.Verify(envelopeJson, DateTimeOffset.UtcNow);

        Assert.False(result.Success);
        Assert.Equal(ProfileRejectionReason.InvalidEnvelope, result.RejectionReason);
    }

    private static (Ed25519PrivateKeyParameters PrivateKey, Ed25519PublicKeyParameters PublicKey) GenerateKeyPair()
    {
        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var keyPair = generator.GenerateKeyPair();
        return ((Ed25519PrivateKeyParameters)keyPair.Private, (Ed25519PublicKeyParameters)keyPair.Public);
    }

    private static Dictionary<string, object?> BuildValidProfilePayload(
        Action<Dictionary<string, object?>>? overrides = null, bool includeCaChain = true, string signerKeySha256 = "")
    {
        var payload = new Dictionary<string, object?>
        {
            ["version"] = 1,
            ["variant"] = "full",
            ["cn"] = "vpn-maria-vps",
            ["server"] = "vpn.vlc.didev.es",
            ["aaaId"] = "CN=radius.vpn.vlc.didev.es",
            ["rootCaSha256"] = "00112233445566778899aabbccddeeff00112233445566778899aabbccddee",
            ["signerKeySha256"] = signerKeySha256,
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

    /// <summary>
    /// Firma el payload con la clave dada, calculando primero el
    /// signerKeySha256 correcto (SHA-256 del SPKI DER de publicKey) salvo que
    /// las "overrides" ya lo hayan fijado a otra cosa a proposito (para el
    /// test de incoherencia).
    /// </summary>
    private static string SignAndBuildEnvelope(
        Ed25519PrivateKeyParameters privateKey, Ed25519PublicKeyParameters publicKey, Dictionary<string, object?> payload)
    {
        var spkiDer = Ed25519PublicKeySpki.Encode(publicKey);
        if (string.IsNullOrEmpty((string?)payload["signerKeySha256"]))
        {
            payload["signerKeySha256"] = Convert.ToHexString(SHA256.HashData(spkiDer)).ToLowerInvariant();
        }

        var payloadBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        var signer = new Ed25519Signer();
        signer.Init(forSigning: true, privateKey);
        signer.BlockUpdate(payloadBytes, 0, payloadBytes.Length);
        var signature = signer.GenerateSignature();

        return BuildEnvelopeJson(Base64Url.Encode(payloadBytes), Base64Url.Encode(signature), Base64Url.Encode(spkiDer));
    }
}
