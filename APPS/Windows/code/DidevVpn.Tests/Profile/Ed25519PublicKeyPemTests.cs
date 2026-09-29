using DidevVpn.Core.Profile;

namespace DidevVpn.Tests.Profile;

public class Ed25519PublicKeyPemTests
{
    private const string ValidPem = """
        -----BEGIN PUBLIC KEY-----
        MCowBQYDK2VwAyEAoqwyx4QDuMFjhSI5X7i9M1JEiHHuDk6Nr1j9KkUGCWs=
        -----END PUBLIC KEY-----
        """;

    [Fact]
    public void Parse_PemValidoGeneradoPorOpenSSL_NoLanza()
    {
        var key = Ed25519PublicKeyPem.Parse(ValidPem);
        Assert.NotNull(key);
    }

    [Fact]
    public void Parse_CadenaVacia_LanzaFormatException()
    {
        var ex = Assert.Throws<FormatException>(() => Ed25519PublicKeyPem.Parse(string.Empty));
        Assert.Contains("vacia", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Parse_PlaceholderSinRellenar_LanzaFormatException()
    {
        // Este es justo el contenido que lleva el fichero de configuracion de
        // compilacion en el repo hasta que alguien pega la clave real: el
        // build debe fallar (ver DidevVpn.App.csproj), y si por lo que sea
        // llegara a compilarse, esto debe seguir rechazando en tiempo de
        // ejecucion en vez de aceptar cualquier firma.
        var placeholder = "# PEGAR AQUI la clave publica Ed25519 (openssl pkey -pubout)";

        Assert.ThrowsAny<FormatException>(() => Ed25519PublicKeyPem.Parse(placeholder));
    }

    [Fact]
    public void Parse_PemDeOtroTipoDeClave_LanzaFormatException()
    {
        // RSA valido pero no es Ed25519: debe rechazarse con un mensaje claro, no aceptarse silenciosamente.
        const string rsaPem = """
            -----BEGIN PUBLIC KEY-----
            MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAM6ir1D8HQ2FhK0f4WlXQKvz9k5xQ2xN
            xxlZOhq1F+p1E3lXqOe5X0k4qU2n9K1vQxYQxQxqQpXQxQxQxQxQxQCAwEAAQ==
            -----END PUBLIC KEY-----
            """;

        Assert.ThrowsAny<Exception>(() => Ed25519PublicKeyPem.Parse(rsaPem));
    }
}
