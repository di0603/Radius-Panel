using DidevVpn.Core.Profile;

namespace DidevVpn.Tests.Profile;

public class Base64UrlTests
{
    [Theory]
    [InlineData("eyJhIjoxfQ", "{\"a\":1}")] // sin relleno (longitud multiplo de 4 tras decodificar el caso feliz)
    public void Decode_TextoConocido_DevuelveLosBytesEsperados(string input, string expectedUtf8)
    {
        var bytes = Base64Url.Decode(input);
        Assert.Equal(expectedUtf8, System.Text.Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public void Decode_UsaGuionYGuionBajo_NoMasSignoYBarra()
    {
        // Bytes elegidos para que su base64 estandar contenga '+' y '/', y
        // comprobar que Decode acepta la variante '-'/'_' (base64url).
        var original = new byte[] { 0xFB, 0xFF, 0xBE };
        var standard = Convert.ToBase64String(original); // "+/++" -> en este caso concreto "-/++" da igual, lo importante es el roundtrip
        var urlSafe = standard.TrimEnd('=').Replace('+', '-').Replace('/', '_');

        var decoded = Base64Url.Decode(urlSafe);

        Assert.Equal(original, decoded);
    }

    [Theory]
    [InlineData("a")] // longitud 1 mod 4: imposible en base64
    public void Decode_LongitudImposible_LanzaFormatException(string input)
    {
        Assert.Throws<FormatException>(() => Base64Url.Decode(input));
    }

    [Fact]
    public void Decode_CadenaVacia_LanzaFormatException()
    {
        Assert.Throws<FormatException>(() => Base64Url.Decode(string.Empty));
    }
}
