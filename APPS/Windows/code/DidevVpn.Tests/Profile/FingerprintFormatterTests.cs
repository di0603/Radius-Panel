using DidevVpn.Core.Profile;

namespace DidevVpn.Tests.Profile;

public class FingerprintFormatterTests
{
    // Mismo hex y mismo resultado esperado que server/src/lib/fingerprint.test.ts
    // del panel: tienen que coincidir byte a byte, es literalmente lo que el
    // usuario compara a ojo entre las dos pantallas.
    private const string Sha256Hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff";

    [Fact]
    public void Format_AgrupaDeCuatroEnCuatroEnMayusculas()
    {
        var result = FingerprintFormatter.Format(Sha256Hex);
        Assert.Equal("A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90 1122 3344 5566 7788 99AA BBCC DDEE FF", result.Full);
    }

    [Fact]
    public void Format_CodigoCortoEsExactamenteLosPrimeros8Grupos()
    {
        var result = FingerprintFormatter.Format(Sha256Hex);
        Assert.Equal("A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90", result.Short);
        Assert.Equal(32, result.Short.Replace(" ", "").Length);
    }

    [Fact]
    public void Format_EsInsensibleAMayusculasMinusculasDeEntrada()
    {
        Assert.Equal(FingerprintFormatter.Format(Sha256Hex), FingerprintFormatter.Format(Sha256Hex.ToUpperInvariant()));
    }
}
