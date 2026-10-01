using System.Globalization;

namespace DidevVpn.Core.Net;

/// <summary>Formateo de bytes, velocidades y duraciones para el panel de detalles (siempre en espanol, coma decimal, independiente de la cultura del equipo para que sea determinista).</summary>
public static class TrafficFormatter
{
    private static readonly CultureInfo Spanish = CultureInfo.GetCultureInfo("es-ES");
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    public static string FormatBytes(long bytes) => FormatScaled(Math.Max(0, bytes));

    /// <summary>Velocidad en bytes por segundo, p.ej. "1,2 MB/s".</summary>
    public static string FormatSpeed(double bytesPerSecond) =>
        FormatScaled(bytesPerSecond < 0 || double.IsNaN(bytesPerSecond) ? 0 : bytesPerSecond) + "/s";

    public static string FormatDuration(TimeSpan duration)
    {
        if (duration < TimeSpan.Zero)
        {
            duration = TimeSpan.Zero;
        }
        return duration.TotalDays >= 1
            ? string.Create(CultureInfo.InvariantCulture, $"{(int)duration.TotalDays} d {duration.Hours:00}:{duration.Minutes:00}:{duration.Seconds:00}")
            : string.Create(CultureInfo.InvariantCulture, $"{(int)duration.TotalHours}:{duration.Minutes:00}:{duration.Seconds:00}");
    }

    private static string FormatScaled(double value)
    {
        var unit = 0;
        while (value >= 1024 && unit < Units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        // Bytes sin decimales; el resto con uno ("1,5 MB"), y sin ",0" sobrante ("2 MB").
        var text = unit == 0
            ? ((long)value).ToString(Spanish)
            : Math.Round(value, 1, MidpointRounding.AwayFromZero).ToString("0.#", Spanish);
        return $"{text} {Units[unit]}";
    }
}
