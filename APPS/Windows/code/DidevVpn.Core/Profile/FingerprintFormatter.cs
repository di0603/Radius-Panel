namespace DidevVpn.Core.Profile;

/// <summary>Huella SHA-256 formateada para comparar a ojo: ver <see cref="FingerprintFormatter"/>.</summary>
public sealed record FormattedFingerprint(string Full, string Short);

/// <summary>
/// Mismo formato que <c>server/src/lib/fingerprint.ts</c> del panel (deben
/// coincidir byte a byte: es literalmente lo que el usuario compara a ojo
/// entre la pantalla del panel y la de esta app en la confirmacion de
/// confianza en el primer uso): grupos de 4 caracteres hexadecimales en
/// MAYUSCULAS separados por espacio, mas un "codigo corto" = los primeros 8
/// grupos (32 caracteres) para comparar de un vistazo.
/// </summary>
public static class FingerprintFormatter
{
    private const int GroupSize = 4;
    private const int ShortGroupCount = 8;

    public static FormattedFingerprint Format(string sha256Hex)
    {
        var upper = sha256Hex.Trim().ToUpperInvariant();
        var groups = new List<string>();
        for (var i = 0; i < upper.Length; i += GroupSize)
        {
            groups.Add(upper.Substring(i, Math.Min(GroupSize, upper.Length - i)));
        }

        return new FormattedFingerprint(
            Full: string.Join(' ', groups),
            Short: string.Join(' ', groups.Take(ShortGroupCount)));
    }
}
