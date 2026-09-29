using System.Reflection;
using DidevVpn.Core.Profile;
using Org.BouncyCastle.Crypto.Parameters;

namespace DidevVpn.App.Services;

/// <summary>
/// Carga la clave publica Ed25519 embebida en el .exe (ver el
/// <c>EmbeddedResource</c> y el target <c>ValidateProfileSigningKey</c> en
/// DidevVpn.App.csproj): el fichero de configuracion de compilacion
/// SigningKey/vpn-profile-signing-ed25519.pub.pem, nunca una clave escrita a
/// mano en un .cs. Si esto lanza en tiempo de ejecucion (no deberia, el build
/// ya lo valida antes de compilar) es un fallo de empaquetado, no de red.
/// </summary>
internal static class ProfileSigningKeyLoader
{
    private const string ResourceName = "DidevVpn.App.SigningKey.vpn-profile-signing-ed25519.pub.pem";

    public static Ed25519PublicKeyParameters Load()
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException(
                $"No se encuentra el recurso embebido '{ResourceName}'. Esto es un fallo de empaquetado " +
                "(el build deberia haber fallado antes de llegar aqui): revisa el EmbeddedResource en DidevVpn.App.csproj.");

        using var reader = new StreamReader(stream);
        var pem = reader.ReadToEnd();
        return Ed25519PublicKeyPem.Parse(pem);
    }

    public static ProfileVerifier CreateVerifier() => new(Load());
}
