using System.Formats.Asn1;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DidevVpn.App.Services;

/// <summary>
/// Un certificado de dispositivo que ESTA app ha instalado en CurrentUser\My.
/// Sin secretos: solo huella (publica) y a que pertenece. El emisor se
/// identifica por su nombre distinguido Y, si el certificado lo lleva, por el
/// Authority Key Identifier: dos CA distintas pueden llamarse igual.
/// </summary>
internal sealed record InstalledCertificateEntry(
    [property: JsonPropertyName("thumbprint")] string Thumbprint,
    [property: JsonPropertyName("device")] string Device,
    [property: JsonPropertyName("server")] string Server,
    [property: JsonPropertyName("connection")] string Connection,
    [property: JsonPropertyName("issuer")] string Issuer,
    [property: JsonPropertyName("installedAtUtc")] DateTimeOffset InstalledAtUtc,
    [property: JsonPropertyName("issuerKeyId")] string? IssuerKeyId = null);

/// <summary>Registro propio (installed-certificates.json en %LOCALAPPDATA%\didev-vpn) de los certificados instalados por la app: la unica lista de la que se borra nada.</summary>
internal interface IInstalledCertificateRegistry
{
    IReadOnlyList<InstalledCertificateEntry> List();
    void Add(InstalledCertificateEntry entry);
    bool Remove(string thumbprint);
}

internal sealed class InstalledCertificateRegistry : IInstalledCertificateRegistry
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private static readonly object FileLock = new();

    private readonly string _path;

    public InstalledCertificateRegistry(string? path = null)
    {
        _path = path ?? Path.Combine(AppPaths.DataDirectory, "installed-certificates.json");
    }

    public IReadOnlyList<InstalledCertificateEntry> List()
    {
        lock (FileLock)
        {
            return Load();
        }
    }

    public void Add(InstalledCertificateEntry entry)
    {
        lock (FileLock)
        {
            var all = Load().Where(e => !SameThumbprint(e.Thumbprint, entry.Thumbprint)).ToList();
            all.Add(entry);
            Save(all);
        }
    }

    public bool Remove(string thumbprint)
    {
        lock (FileLock)
        {
            var all = Load();
            var kept = all.Where(e => !SameThumbprint(e.Thumbprint, thumbprint)).ToList();
            if (kept.Count == all.Count)
            {
                return false;
            }
            Save(kept);
            return true;
        }
    }

    internal static bool SameThumbprint(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private List<InstalledCertificateEntry> Load()
    {
        if (!File.Exists(_path))
        {
            return new List<InstalledCertificateEntry>();
        }
        try
        {
            return JsonSerializer.Deserialize<List<InstalledCertificateEntry>>(File.ReadAllText(_path), JsonOptions)
                   ?? new List<InstalledCertificateEntry>();
        }
        catch (JsonException)
        {
            // Fichero corrupto: se trata como vacio (es mas seguro no borrar nada que borrar a ciegas).
            return new List<InstalledCertificateEntry>();
        }
    }

    private void Save(List<InstalledCertificateEntry> entries)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(entries, JsonOptions));
        File.Move(temp, _path, overwrite: true);
    }
}

/// <summary>Almacen CurrentUser\My, separado para poder simularlo en los tests de la limpieza.</summary>
internal interface IUserCertificateStore
{
    /// <summary>Copia del certificado con esa huella, o null si no esta.</summary>
    X509Certificate2? Find(string thumbprint);

    /// <summary>Borra el certificado Y su clave (TPM o software). True si estaba.</summary>
    bool RemoveWithKey(string thumbprint);
}

internal sealed class CurrentUserCertificateStore : IUserCertificateStore
{
    private readonly FileLogger? _logger;

    public CurrentUserCertificateStore(FileLogger? logger = null) => _logger = logger;

    public X509Certificate2? Find(string thumbprint)
    {
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        var match = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false)
            .Cast<X509Certificate2>().FirstOrDefault();
        return match is null ? null : new X509Certificate2(match.RawData);
    }

    public bool RemoveWithKey(string thumbprint)
    {
        var removed = false;
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadWrite);
        foreach (var certificate in store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false))
        {
            // El manejador de la clave se obtiene ANTES de quitar el certificado.
            var key = TryGetCngKey(certificate);
            store.Remove(certificate);
            removed = true;
            TryDeleteKey(key, certificate.Thumbprint);
            certificate.Dispose();
        }
        return removed;
    }

    private static CngKey? TryGetCngKey(X509Certificate2 certificate)
    {
        try
        {
            using var ecdsa = certificate.GetECDsaPrivateKey();
            if (ecdsa is ECDsaCng ecdsaCng)
            {
                return CngKey.Open(ecdsaCng.Key.KeyName!, ecdsaCng.Key.Provider!, ecdsaCng.Key.IsMachineKey ? CngKeyOpenOptions.MachineKey : CngKeyOpenOptions.UserKey);
            }
            using var rsa = certificate.GetRSAPrivateKey();
            if (rsa is RSACng rsaCng)
            {
                return CngKey.Open(rsaCng.Key.KeyName!, rsaCng.Key.Provider!, rsaCng.Key.IsMachineKey ? CngKeyOpenOptions.MachineKey : CngKeyOpenOptions.UserKey);
            }
        }
        catch (Exception)
        {
            // sin clave accesible (ya borrada, otro proveedor...): solo se quita el certificado
        }
        return null;
    }

    private void TryDeleteKey(CngKey? key, string thumbprint)
    {
        if (key is null)
        {
            return;
        }
        try
        {
            key.Delete();
        }
        catch (Exception ex)
        {
            _logger?.Warn($"Certificado {thumbprint} borrado, pero no se ha podido borrar su clave: {ex.Message}");
            key.Dispose();
        }
    }
}

/// <summary>Ciclo de vida de los certificados instalados por la app: registrarlos, borrarlos con su clave, y limpiar los que sobran.</summary>
internal interface ICertificateLifecycle
{
    void Register(X509Certificate2 certificate, string device, string server, string connection);

    /// <summary>Borra el certificado Y su clave (TPM o software) de CurrentUser\My y su entrada del registro. True si el certificado estaba en el almacen.</summary>
    bool RemoveWithKey(string thumbprint);

    /// <summary>
    /// Tras instalar <paramref name="keep"/> (de <paramref name="device"/> en <paramref name="server"/>): borra los ANTERIORES
    /// del mismo dispositivo y servidor y, si se leyo bien la lista de conexiones, los de conexiones que ya no existen. Solo los
    /// del registro, del MISMO servidor y del MISMO emisor. <paramref name="existingConnections"/> a null = no se pudo leer la
    /// lista: NO se borra ningun huerfano (solo los sustituidos). Devuelve las huellas borradas.
    /// </summary>
    IReadOnlyList<string> CleanupStale(string device, string server, X509Certificate2 keep, IReadOnlyCollection<string>? existingConnections);

    /// <summary>Certificados de conexiones ya existentes dadas de alta antes de que hubiera registro: los instalo la app, se anotan (y se completa el identificador del emisor de las entradas antiguas).</summary>
    void AdoptConnectionCertificates(IEnumerable<ConnectionRecord> connections);
}

internal sealed class CertificateLifecycle : ICertificateLifecycle
{
    private readonly IInstalledCertificateRegistry _registry;
    private readonly IUserCertificateStore _store;
    private readonly FileLogger? _logger;

    public CertificateLifecycle(FileLogger? logger = null, IInstalledCertificateRegistry? registry = null, IUserCertificateStore? store = null)
    {
        _logger = logger;
        _registry = registry ?? new InstalledCertificateRegistry();
        _store = store ?? new CurrentUserCertificateStore(logger);
    }

    public void Register(X509Certificate2 certificate, string device, string server, string connection)
    {
        _registry.Add(new InstalledCertificateEntry(
            certificate.Thumbprint, device, server, connection, certificate.Issuer, DateTimeOffset.UtcNow, IssuerKeyId(certificate)));
    }

    public bool RemoveWithKey(string thumbprint)
    {
        var removed = _store.RemoveWithKey(thumbprint);
        _registry.Remove(thumbprint);
        return removed;
    }

    public IReadOnlyList<string> CleanupStale(string device, string server, X509Certificate2 keep, IReadOnlyCollection<string>? existingConnections)
    {
        var removed = new List<string>();
        HashSet<string>? connections = existingConnections is null
            ? null
            : new HashSet<string>(existingConnections, StringComparer.OrdinalIgnoreCase);
        if (connections is null)
        {
            _logger?.Warn("No se ha podido leer la lista de conexiones existentes: no se borra ningun certificado huerfano (solo los sustituidos del mismo dispositivo).");
        }

        var keepKeyId = IssuerKeyId(keep);
        foreach (var entry in _registry.List())
        {
            if (InstalledCertificateRegistry.SameThumbprint(entry.Thumbprint, keep.Thumbprint))
            {
                continue;
            }
            // Mismo servidor: el mismo dispositivo o una conexion "huerfana" de OTRO servidor no es asunto de esta limpieza.
            if (!string.Equals(entry.Server, server, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            // Mismo emisor: por nombre Y, si ambos lo conocen, por identificador de clave de la CA (dos CA pueden llamarse igual).
            if (!SameIssuer(entry, keep.Issuer, keepKeyId))
            {
                continue;
            }

            var superseded = string.Equals(entry.Device, device, StringComparison.OrdinalIgnoreCase);
            var orphan = connections is not null && !connections.Contains(entry.Connection);
            if (!superseded && !orphan)
            {
                continue;
            }

            try
            {
                RemoveWithKey(entry.Thumbprint);
                removed.Add(entry.Thumbprint);
                _logger?.Info($"Certificado antiguo de \"{entry.Device}\" borrado ({(superseded ? "sustituido" : "sin conexion")}, huella {entry.Thumbprint}).");
            }
            catch (Exception ex)
            {
                _logger?.Warn($"No se ha podido borrar el certificado antiguo {entry.Thumbprint}: {ex.Message}");
            }
        }
        return removed;
    }

    public void AdoptConnectionCertificates(IEnumerable<ConnectionRecord> connections)
    {
        var entries = _registry.List();
        foreach (var connection in connections)
        {
            if (string.IsNullOrEmpty(connection.CertificateThumbprint))
            {
                continue;
            }
            var existing = entries.FirstOrDefault(e => InstalledCertificateRegistry.SameThumbprint(e.Thumbprint, connection.CertificateThumbprint));
            if (existing is not null && existing.IssuerKeyId is not null)
            {
                continue;
            }
            using var certificate = _store.Find(connection.CertificateThumbprint);
            if (certificate is null)
            {
                continue;
            }
            if (existing is null)
            {
                Register(certificate, connection.Cn, connection.Server, connection.Cn);
            }
            else if (IssuerKeyId(certificate) is { } keyId)
            {
                // Entrada de una version anterior sin identificador de emisor: se completa.
                _registry.Add(existing with { IssuerKeyId = keyId });
            }
        }
    }

    private static bool SameIssuer(InstalledCertificateEntry entry, string issuerName, string? issuerKeyId)
    {
        if (!string.Equals(entry.Issuer, issuerName, StringComparison.Ordinal))
        {
            return false;
        }
        // Si solo uno de los dos conoce el identificador no se puede demostrar que sea la misma CA: no se borra.
        if (entry.IssuerKeyId is null != issuerKeyId is null)
        {
            return false;
        }
        return entry.IssuerKeyId is null || string.Equals(entry.IssuerKeyId, issuerKeyId, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>keyIdentifier del Authority Key Identifier (2.5.29.35) en hexadecimal, o null si el certificado no lo lleva.</summary>
    internal static string? IssuerKeyId(X509Certificate2 certificate)
    {
        var extension = certificate.Extensions["2.5.29.35"];
        if (extension is null)
        {
            return null;
        }
        try
        {
            var reader = new AsnReader(extension.RawData, AsnEncodingRules.DER).ReadSequence();
            var tag = new Asn1Tag(TagClass.ContextSpecific, 0);
            while (reader.HasData)
            {
                if (reader.PeekTag().HasSameClassAndValue(tag))
                {
                    return Convert.ToHexString(reader.ReadOctetString(tag));
                }
                reader.ReadEncodedValue();
            }
        }
        catch (AsnContentException)
        {
            // extension ilegible: se trata como "sin identificador"
        }
        return null;
    }
}
