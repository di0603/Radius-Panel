using System.Text.Json;
using System.Text.Json.Serialization;

namespace DidevVpn.App.Services;

/// <summary>
/// Lo que hace falta recordar entre arranques para poder renovar sin volver
/// a importar el perfil: en %LOCALAPPDATA%\didev-vpn\device.json. Nunca lleva
/// el token de alta (de un solo uso, ya gastado tras el alta) ni ninguna
/// clave privada (esa vive en el TPM/CNG, identificada solo por nombre).
/// </summary>
internal sealed class DeviceState
{
    [JsonPropertyName("cn")]
    public string Cn { get; set; } = string.Empty;

    [JsonPropertyName("server")]
    public string Server { get; set; } = string.Empty;

    [JsonPropertyName("estBaseUrl")]
    public string EstBaseUrl { get; set; } = string.Empty;

    [JsonPropertyName("caChainPem")]
    public string CaChainPem { get; set; } = string.Empty;

    [JsonPropertyName("rootCaSha256")]
    public string RootCaSha256 { get; set; } = string.Empty;

    [JsonPropertyName("certificateThumbprint")]
    public string CertificateThumbprint { get; set; } = string.Empty;

    [JsonPropertyName("isTpmBacked")]
    public bool IsTpmBacked { get; set; }

    [JsonPropertyName("tunnelMode")]
    public string TunnelMode { get; set; } = string.Empty;

    [JsonPropertyName("splitRoutes")]
    public List<string> SplitRoutes { get; set; } = new();

    [JsonPropertyName("dns")]
    public string? Dns { get; set; }

    [JsonPropertyName("ikeEncryption")]
    public string IkeEncryption { get; set; } = string.Empty;

    [JsonPropertyName("ikeIntegrity")]
    public string IkeIntegrity { get; set; } = string.Empty;

    [JsonPropertyName("ikeDhGroup")]
    public string IkeDhGroup { get; set; } = string.Empty;

    [JsonPropertyName("espEncryption")]
    public string EspEncryption { get; set; } = string.Empty;

    [JsonPropertyName("espPfsGroup")]
    public string EspPfsGroup { get; set; } = string.Empty;

    [JsonPropertyName("lastEnrolledAtUtc")]
    public DateTimeOffset LastEnrolledAtUtc { get; set; }
}

internal static class DeviceStateStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static DeviceState? Load()
    {
        if (!File.Exists(AppPaths.ConfigFilePath))
        {
            return null;
        }

        var json = File.ReadAllText(AppPaths.ConfigFilePath);
        return JsonSerializer.Deserialize<DeviceState>(json, JsonOptions);
    }

    public static void Save(DeviceState state)
    {
        AppPaths.EnsureDataDirectoryExists();
        var json = JsonSerializer.Serialize(state, JsonOptions);
        File.WriteAllText(AppPaths.ConfigFilePath, json);
    }

    public static void Delete()
    {
        if (File.Exists(AppPaths.ConfigFilePath))
        {
            File.Delete(AppPaths.ConfigFilePath);
        }
    }
}
