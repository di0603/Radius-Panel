using System.Text.RegularExpressions;

namespace DidevVpn.Core.Versioning;

/// <summary>
/// Semver simplificado (X.Y.Z, sin prerelease/build) - lo mismo que valida
/// el panel para <c>panel_vpn_settings.min_app_version</c>
/// (server/src/services/vpnSettings.ts, SEMVER_RE). Basta para comparar la
/// version de esta app contra <c>GET /.well-known/est/status</c>.
/// </summary>
public readonly partial struct AppVersion : IComparable<AppVersion>, IEquatable<AppVersion>
{
    [GeneratedRegex(@"^(\d+)\.(\d+)\.(\d+)$")]
    private static partial Regex Pattern();

    public int Major { get; }
    public int Minor { get; }
    public int Patch { get; }

    public AppVersion(int major, int minor, int patch)
    {
        Major = major;
        Minor = minor;
        Patch = patch;
    }

    public static bool TryParse(string? value, out AppVersion version)
    {
        version = default;
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var match = Pattern().Match(value.Trim());
        if (!match.Success)
        {
            return false;
        }

        version = new AppVersion(
            int.Parse(match.Groups[1].Value),
            int.Parse(match.Groups[2].Value),
            int.Parse(match.Groups[3].Value));
        return true;
    }

    public static AppVersion Parse(string value) =>
        TryParse(value, out var version)
            ? version
            : throw new FormatException($"\"{value}\" no es una version X.Y.Z valida.");

    public int CompareTo(AppVersion other)
    {
        var major = Major.CompareTo(other.Major);
        if (major != 0) return major;
        var minor = Minor.CompareTo(other.Minor);
        if (minor != 0) return minor;
        return Patch.CompareTo(other.Patch);
    }

    /// <summary>True si esta version es estrictamente inferior a la minima exigida por el panel.</summary>
    public bool IsBelow(AppVersion minimum) => CompareTo(minimum) < 0;

    public bool Equals(AppVersion other) => Major == other.Major && Minor == other.Minor && Patch == other.Patch;

    public override bool Equals(object? obj) => obj is AppVersion other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(Major, Minor, Patch);

    public override string ToString() => $"{Major}.{Minor}.{Patch}";

    public static bool operator <(AppVersion left, AppVersion right) => left.CompareTo(right) < 0;
    public static bool operator >(AppVersion left, AppVersion right) => left.CompareTo(right) > 0;
    public static bool operator <=(AppVersion left, AppVersion right) => left.CompareTo(right) <= 0;
    public static bool operator >=(AppVersion left, AppVersion right) => left.CompareTo(right) >= 0;
    public static bool operator ==(AppVersion left, AppVersion right) => left.Equals(right);
    public static bool operator !=(AppVersion left, AppVersion right) => !left.Equals(right);
}
