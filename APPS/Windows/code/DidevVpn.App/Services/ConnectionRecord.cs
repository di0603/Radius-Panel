using System.Text.Json;
using System.Text.Json.Serialization;

namespace DidevVpn.App.Services;

/// <summary>
/// Una conexion VPN configurada en esta app: esta app es un cliente
/// GENERICO desde el prompt 12.5 (como FortiClient), puede tener varias a
/// la vez, cada una a un servidor distinto. "Cn" es tanto la clave de
/// almacenamiento como el nombre de la conexion RAS/VpnClient de Windows
/// (ya es unico por construccion: username RADIUS del dispositivo).
///
/// Lleva el ANCLA DE CONFIANZA (SignerKeySha256/RootCaSha256) confirmada por
/// el usuario la primera vez que se importo un perfil para este servidor, ver
/// EnrollmentOrchestrator. Todas las conexiones del mismo servidor reutilizan
/// esa ancla y exigen coincidencia exacta, sin excepciones.
///
/// Nunca lleva el token de alta (de un solo uso, ya gastado) ni ninguna
/// clave privada (esa vive en el TPM/CNG, identificada solo por nombre).
/// </summary>
internal sealed class ConnectionRecord
{
    [JsonPropertyName("cn")]
    public string Cn { get; set; } = string.Empty;

    [JsonPropertyName("server")]
    public string Server { get; set; } = string.Empty;

    [JsonPropertyName("estBaseUrl")]
    public string EstBaseUrl { get; set; } = string.Empty;

    [JsonPropertyName("caChainPem")]
    public string CaChainPem { get; set; } = string.Empty;

    /// <summary>Ancla de confianza: huella de la raiz confirmada la primera vez para este servidor.</summary>
    [JsonPropertyName("rootCaSha256")]
    public string RootCaSha256 { get; set; } = string.Empty;

    /// <summary>Ancla de confianza: huella de la clave de firma del panel confirmada la primera vez para este servidor.</summary>
    [JsonPropertyName("signerKeySha256")]
    public string SignerKeySha256 { get; set; } = string.Empty;

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

/// <summary>
/// Un fichero JSON por conexion en AppPaths.ConnectionsDirectory, nombrado
/// por "cn" (ya es un identificador seguro para nombre de fichero: username
/// RADIUS del dispositivo, solo minusculas/numeros/guiones).
/// </summary>
internal static class ConnectionStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private static string PathFor(string cn) => Path.Combine(AppPaths.ConnectionsDirectory, $"{SanitizeFileName(cn)}.json");

    /// <summary>Nunca deberia hacer falta en la practica (cn ya es seguro por construccion), pero nunca hay que confiar ciegamente en datos de fuera de esta app.</summary>
    private static string SanitizeFileName(string cn)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string(cn.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
    }

    public static ConnectionRecord? Load(string cn)
    {
        var path = PathFor(cn);
        if (!File.Exists(path))
        {
            return null;
        }
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<ConnectionRecord>(json, JsonOptions);
    }

    public static void Save(ConnectionRecord record)
    {
        AppPaths.EnsureDataDirectoryExists();
        var json = JsonSerializer.Serialize(record, JsonOptions);
        File.WriteAllText(PathFor(record.Cn), json);
    }

    public static void Delete(string cn)
    {
        var path = PathFor(cn);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    /// <summary>Todas las conexiones de este usuario, en el orden en que las devuelve el sistema de ficheros (no hay un orden "natural" que preservar).</summary>
    public static List<ConnectionRecord> List()
    {
        if (!Directory.Exists(AppPaths.ConnectionsDirectory))
        {
            return new List<ConnectionRecord>();
        }

        var result = new List<ConnectionRecord>();
        foreach (var file in Directory.EnumerateFiles(AppPaths.ConnectionsDirectory, "*.json"))
        {
            try
            {
                var json = File.ReadAllText(file);
                var record = JsonSerializer.Deserialize<ConnectionRecord>(json, JsonOptions);
                if (record is not null)
                {
                    result.Add(record);
                }
            }
            catch (JsonException)
            {
                // Fichero corrupto/a medio escribir: se ignora, no se rompe el listado entero por uno.
            }
        }
        return result;
    }
}
