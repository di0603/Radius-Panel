using DidevVpn.Core.Profile;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;

namespace DidevVpn.Tests.Profile;

public class Ed25519PublicKeySpkiTests
{
    // Mismo vector real de OpenSSL que ProfileVerifierTests: la SPKI DER que
    // realmente produce `openssl pkey -pubout -outform DER` para una clave
    // Ed25519, en hexadecimal.
    private static readonly byte[] OpenSslSpkiDer = Convert.FromHexString(
        "302a300506032b65700321003754ccb90c014d92afd1c6ff723744b3aa8583659a938b6e6c56e01b8ccd98a4");

    [Fact]
    public void Parse_SpkiRealDeOpenSSL_ExtraeLos32BytesDeLaClave()
    {
        var key = Ed25519PublicKeySpki.Parse(OpenSslSpkiDer);
        Assert.Equal(32, key.GetEncoded().Length);
    }

    [Fact]
    public void Parse_LongitudIncorrecta_LanzaFormatException()
    {
        Assert.Throws<FormatException>(() => Ed25519PublicKeySpki.Parse(new byte[10]));
        Assert.Throws<FormatException>(() => Ed25519PublicKeySpki.Parse(new byte[100]));
    }

    [Fact]
    public void Parse_CabeceraDistinta_LanzaFormatException()
    {
        // Misma longitud (44 bytes) pero la cabecera fija del OID no coincide.
        var corrupted = (byte[])OpenSslSpkiDer.Clone();
        corrupted[0] = 0xFF;
        Assert.Throws<FormatException>(() => Ed25519PublicKeySpki.Parse(corrupted));
    }

    [Fact]
    public void EncodeParse_IdaYVuelta()
    {
        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var keyPair = generator.GenerateKeyPair();
        var publicKey = (Ed25519PublicKeyParameters)keyPair.Public;

        var der = Ed25519PublicKeySpki.Encode(publicKey);
        var parsed = Ed25519PublicKeySpki.Parse(der);

        Assert.Equal(publicKey.GetEncoded(), parsed.GetEncoded());
        Assert.Equal(Ed25519PublicKeySpki.SpkiLength, der.Length);
    }
}
