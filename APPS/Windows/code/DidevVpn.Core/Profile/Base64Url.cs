namespace DidevVpn.Core.Profile;

/// <summary>
/// El panel codifica "payload"/"signature" con Node's <c>Buffer.toString('base64url')</c>
/// (RFC 4648 §5: '-' y '_' en vez de '+' y '/', sin relleno '='). .NET solo trae
/// <c>Convert.FromBase64String</c> para base64 estandar, asi que hace falta
/// traducir el alfabeto y reponer el relleno antes de decodificar.
/// </summary>
public static class Base64Url
{
    public static byte[] Decode(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new FormatException("Cadena base64url vacia.");
        }

        var standard = value.Replace('-', '+').Replace('_', '/');
        var remainder = standard.Length % 4;
        var padded = remainder switch
        {
            2 => standard + "==",
            3 => standard + "=",
            0 => standard,
            _ => throw new FormatException($"Longitud base64url invalida: {value.Length}."),
        };
        return Convert.FromBase64String(padded);
    }

    /// <summary>Inverso de <see cref="Decode"/>: mismo alfabeto ('-'/'_'), sin relleno '='.</summary>
    public static string Encode(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
