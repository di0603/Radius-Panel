using Org.BouncyCastle.Crypto.Parameters;

namespace DidevVpn.Core.Profile;

/// <summary>
/// La clave publica Ed25519 del panel viaja DENTRO de cada sobre firmado
/// (campo "signerPublicKey", ver ProfileEnvelope), no incrustada en la app:
/// desde el prompt 12.5, esta app es un cliente GENERICO (como FortiClient),
/// compilado sin ninguna clave de didev. Es una SubjectPublicKeyInfo (SPKI)
/// DER cruda -sin envoltorio PEM-, en base64url, tal cual la exporta
/// node:crypto (<c>createPublicKey(key).export({type:'spki',format:'der'})</c>).
///
/// Un SPKI de Ed25519 es SIEMPRE la misma estructura de longitud fija: 12
/// bytes de cabecera ASN.1 (que codifican el OID 1.3.101.112, fijo para
/// Ed25519 -sin parametros de curva, a diferencia de ECDSA-) mas los 32 bytes
/// de la clave. No hace falta un parser ASN.1 generico: basta comprobar que
/// son exactamente esos 12 bytes fijos y quedarse con los 32 siguientes.
/// </summary>
public static class Ed25519PublicKeySpki
{
    private static readonly byte[] Header =
    {
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    };

    public const int RawKeyLength = 32;
    public const int SpkiLength = 44; // Header.Length + RawKeyLength

    public static Ed25519PublicKeyParameters Parse(byte[] spkiDer)
    {
        if (spkiDer is null)
        {
            throw new ArgumentNullException(nameof(spkiDer));
        }

        if (spkiDer.Length != SpkiLength || !spkiDer.AsSpan(0, Header.Length).SequenceEqual(Header))
        {
            throw new FormatException(
                "signerPublicKey no es una SubjectPublicKeyInfo de Ed25519 valida (se esperaban 44 bytes con la " +
                "cabecera fija del OID 1.3.101.112).");
        }

        var rawKey = spkiDer.AsSpan(Header.Length, RawKeyLength).ToArray();
        return new Ed25519PublicKeyParameters(rawKey, 0);
    }

    /// <summary>Inverso de <see cref="Parse"/>: reconstruye el SPKI DER completo a partir de la clave. Solo para tests.</summary>
    public static byte[] Encode(Ed25519PublicKeyParameters key)
    {
        var der = new byte[SpkiLength];
        Header.CopyTo(der, 0);
        key.GetEncoded().CopyTo(der, Header.Length);
        return der;
    }
}
