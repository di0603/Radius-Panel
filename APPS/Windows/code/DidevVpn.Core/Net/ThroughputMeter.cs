namespace DidevVpn.Core.Net;

/// <summary>
/// Velocidad actual de subida y bajada a partir de contadores acumulados de
/// bytes (muestreados cada 1-2 s). Un contador que baja (la interfaz se
/// reinicio, se reconecto) no da velocidad negativa: se toma como reinicio y
/// la velocidad de esa muestra es 0.
/// </summary>
public sealed class ThroughputMeter
{
    private DateTime? _lastAt;
    private long _lastSent;
    private long _lastReceived;

    public double UploadBytesPerSecond { get; private set; }
    public double DownloadBytesPerSecond { get; private set; }

    public void Add(DateTime at, long bytesSent, long bytesReceived)
    {
        if (_lastAt is { } previous)
        {
            var seconds = (at - previous).TotalSeconds;
            if (seconds > 0)
            {
                UploadBytesPerSecond = bytesSent >= _lastSent ? (bytesSent - _lastSent) / seconds : 0;
                DownloadBytesPerSecond = bytesReceived >= _lastReceived ? (bytesReceived - _lastReceived) / seconds : 0;
            }
        }
        _lastAt = at;
        _lastSent = bytesSent;
        _lastReceived = bytesReceived;
    }

    /// <summary>Al desconectar o cambiar de conexion: la siguiente muestra no se compara con la anterior.</summary>
    public void Reset()
    {
        _lastAt = null;
        UploadBytesPerSecond = 0;
        DownloadBytesPerSecond = 0;
    }
}
