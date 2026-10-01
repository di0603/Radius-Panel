using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DidevVpn.App.Services;

/// <summary>Un certificado de dispositivo que ESTA app ha instalado en CurrentUser\My. Sin secretos: solo huella (publica) y a que pertenece.</summary>
internal sealed record InstalledCertificateEntry(
    [property: JsonPropertyName("thumbprint")] string Thumbprint,
    [property: JsonPropertyName("device")] string Device,
    [property: JsonPropertyName("server")] string Server,
    [property: JsonPropertyName("connection")] string Connection,
    [property: JsonPropertyName("issuer")] string Issuer,
    [property: JsonPropertyName("installedAtUtc")] DateTimeOffset InstalledAtUtc);

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

/// <summary>Ciclo de vida de los certificados instalados por la app: registrarlos, borrarlos con su clave, y limpiar los que sobran.</summary>
internal interface ICertificateLifecycle
{
    void Register(X509Certificate2 certificate, string device, string server, string connection);

    /// <summary>Borra el certificado Y su clave (TPM o software) de CurrentUser\My y su entrada del registro. True si el certificado estaba en el almacen.</summary>
    bool RemoveWithKey(string thumbprint);

    /// <summary>
    /// Tras instalar <paramref name="keep"/>: borra los certificados ANTERIORES del mismo dispositivo y los que ya no pertenezcan a
    /// ninguna conexion existente -solo los del registro y del MISMO emisor que <paramref name="keep"/>-. Devuelve las huellas borradas.
    /// </summary>
    IReadOnlyList<string> CleanupStale(string device, X509Certificate2 keep, IReadOnlyCollection<string> existingConnections);

    /// <summary>Certificados de conexiones ya existentes dadas de alta antes de que hubiera registro: los instalo la app, se anotan.</summary>
    void AdoptConnectionCertificates(IEnumerable<ConnectionRecord> connections);
}

internal sealed class CertificateLifecycle : ICertificateLifecycle
{
    private readonly IInstalledCertificateRegistry _registry;
    private readonly FileLogger? _logger;

    public CertificateLifecycle(FileLogger? logger = null, IInstalledCertificateRegistry? registry = null)
    {
        _logger = logger;
        _registry = registry ?? new InstalledCertificateRegistry();
    }

    public void Register(X509Certificate2 certificate, string device, string server, string connection)
    {
        _registry.Add(new InstalledCertificateEntry(
            certificate.Thumbprint, device, server, connection, certificate.Issuer, DateTimeOffset.UtcNow));
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
        _registry.Remove(thumbprint);
        return removed;
    }

    public IReadOnlyList<string> CleanupStale(string device, X509Certificate2 keep, IReadOnlyCollection<string> existingConnections)
    {
        var removed = new List<string>();
        var connections = new HashSet<string>(existingConnections, StringComparer.OrdinalIgnoreCase);
        foreach (var entry in _registry.List())
        {
            if (InstalledCertificateRegistry.SameThumbprint(entry.Thumbprint, keep.Thumbprint))
            {
                continue;
            }
            // Nunca de otro emisor: otra CA/otro servidor no es asunto de esta limpieza.
            if (!string.Equals(entry.Issuer, keep.Issuer, StringComparison.Ordinal))
            {
                continue;
            }
            var superseded = string.Equals(entry.Device, device, StringComparison.OrdinalIgnoreCase);
            var orphan = !connections.Contains(entry.Connection);
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
        var known = _registry.List().Select(e => e.Thumbprint).ToHashSet(StringComparer.OrdinalIgnoreCase);
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        foreach (var connection in connections)
        {
            if (string.IsNullOrEmpty(connection.CertificateThumbprint) || known.Contains(connection.CertificateThumbprint))
            {
                continue;
            }
            var match = store.Certificates.Find(X509FindType.FindByThumbprint, connection.CertificateThumbprint, validOnly: false)
                .Cast<X509Certificate2>().FirstOrDefault();
            if (match is not null)
            {
                Register(match, connection.Cn, connection.Server, connection.Cn);
            }
        }
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
