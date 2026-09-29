using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.OpenSsl;

namespace DidevVpn.Core.Profile;

/// <summary>
/// La clave publica de firma se distribuye como PEM SubjectPublicKeyInfo
/// ("-----BEGIN PUBLIC KEY-----"), tal cual la exporta
/// <c>openssl pkey -in ... -pubout</c> en el panel (ver su README,
/// "Aprovisionamiento de apps"). BouncyCastle reconoce el OID Ed25519
/// (1.3.101.112) dentro del SPKI y devuelve el tipo correcto sin mas ayuda.
/// </summary>
public static class Ed25519PublicKeyPem
{
    public static Ed25519PublicKeyParameters Parse(string pem)
    {
        if (string.IsNullOrWhiteSpace(pem))
        {
            throw new FormatException("La clave publica de firma de perfiles esta vacia.");
        }

        using var reader = new StringReader(pem);
        var pemReader = new PemReader(reader);
        object? obj;
        try
        {
            obj = pemReader.ReadObject();
        }
        catch (Exception ex)
        {
            throw new FormatException("No se ha podido leer la clave publica de firma de perfiles (PEM invalido).", ex);
        }

        if (obj is Ed25519PublicKeyParameters keyParams)
        {
            return keyParams;
        }

        throw new FormatException(
            "El fichero configurado no contiene una clave publica Ed25519 en formato SubjectPublicKeyInfo " +
            "('-----BEGIN PUBLIC KEY-----'). Genera la clave con 'openssl genpkey -algorithm ED25519' y " +
            "extrae la publica con 'openssl pkey -pubout' (ver README del panel).");
    }
}
