namespace DidevVpn.Core.Profile;

/// <summary>
/// <see cref="ProvisioningProfile.EstBaseUrl"/> no lleva barra final
/// (p.ej. ".../.well-known/est"): combinarlo con <c>new Uri(baseUri, "simpleenroll")</c>
/// sin normalizar reemplazaria el ultimo segmento en vez de anadir uno
/// nuevo. Este helper deja siempre una barra final antes de construir el <see cref="Uri"/>.
/// </summary>
public static class EstBaseUrl
{
    public static Uri Normalize(string estBaseUrl)
    {
        if (string.IsNullOrWhiteSpace(estBaseUrl))
        {
            throw new ArgumentException("estBaseUrl esta vacio.", nameof(estBaseUrl));
        }

        var withTrailingSlash = estBaseUrl.EndsWith('/') ? estBaseUrl : estBaseUrl + "/";
        return new Uri(withTrailingSlash, UriKind.Absolute);
    }
}
