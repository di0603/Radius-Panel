using System.Runtime.InteropServices;

namespace DidevVpn.App.Services.Ras;

/// <summary>
/// P/Invoke minimo de rasapi32.dll para leer el estado de una conexion RAS
/// sin lanzar ningun proceso (powershell.exe tarda 1-3s solo en arrancar y
/// cargar el modulo VpnClient; esto tarda milisegundos). Solo LECTURA:
/// crear/actualizar/borrar la conexion sigue por PowerShell
/// (VpnConnectionService.CreateOrUpdateConnection/RemoveConnection), que es
/// raro (solo en el alta) y necesita Add-/Set-VpnConnection de verdad.
///
/// Los tamanos de struct de aqui estan VERIFICADOS DE VERDAD en esta maquina
/// (Windows 11, x64) con un programa de sondeo aparte (no versionado, ver el
/// historial de esta rama) que probo RasEnumConnectionsW/RasEnumEntriesW con
/// un rango de dwSize hasta encontrar cuales acepta Windows de verdad -esta
/// API es tristemente celebre por exigir que dwSize coincida EXACTAMENTE con
/// uno de varios tamanos de struct que reconoce (no hace un relleno parcial
/// generico como la mayoria de APIs de Windows: un tamano que no coincida
/// devuelve ERROR_INVALID_SIZE=632, no un fallo de "buffer pequeno" util-.
/// Con ellos se obtuvieron entradas reales de la agenda de este equipo
/// (RasEnumEntriesW) y una enumeracion sin conexiones activas correcta
/// (RasEnumConnectionsW, count=0 con esta maquina sin VPN conectada en ese
/// momento). RasGetConnectStatusW/RasGetProjectionInfoW NO mostraron el
/// mismo problema (ERROR_INVALID_HANDLE con un handle invalido, no
/// ERROR_INVALID_SIZE, con los tamanos de aqui) pero no se ha podido probar
/// con una conexion activa de verdad (esta maquina no tenia ninguna VPN
/// conectada al hacer esta comprobacion): VpnConnectionService cae de vuelta
/// a PowerShell si cualquiera de estas llamadas fallara.
/// </summary>
internal static class RasInterop
{
    public const int ErrorSuccess = 0;
    public const int ErrorBufferTooSmall = 603;

    /// <summary>
    /// Layout verificado: Pack=1 (sin relleno automatico de .NET) + un
    /// "short" final de relleno, para que Marshal.SizeOf de EXACTAMENTE 1360
    /// -el unico de los tamanos historicos de RASCONNW que Windows acepto en
    /// las pruebas de esta maquina (se probaron ademas 1344/1372/1388, todos
    /// tambien aceptados: son otras versiones del struct con mas campos al
    /// final que aqui no se necesitan para nada -solo se usan szEntryName y
    /// hrasconn-, 1360 es la mas simple de las aceptadas)-.
    /// </summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 1)]
    public struct RasConn
    {
        public int dwSize;
        public IntPtr hrasconn;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)] // RAS_MaxEntryName+1
        public string szEntryName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 17)] // RAS_MaxDeviceType+1
        public string szDeviceType;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)] // RAS_MaxDeviceName+1
        public string szDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] // MAX_PATH
        public string szPhonebook;
        public int dwSubEntry;
        public Guid guidEntry;
        private readonly short _paddingToVerifiedSize;

        public static int Size => Marshal.SizeOf<RasConn>();
    }

    public enum RasConnState
    {
        OpenPort = 0,
        PortOpened,
        ConnectDevice,
        DeviceConnected,
        AllDevicesConnected,
        Authenticate,
        AuthNotify,
        AuthRetry,
        AuthCallback,
        AuthChangePassword,
        AuthProject,
        AuthLinkSpeed,
        AuthAck,
        ReAuthenticate,
        Authenticated,
        PrepareForCallback,
        WaitForModemReset,
        WaitForCallback,
        Projected,
        StartAuthentication,
        CallbackComplete,
        LogonNetwork,
        SubEntryConnected,
        SubEntryDisconnected,
        Interactive = 0x1000,
        RetryAuthentication,
        CallbackSetByCaller,
        PasswordExpired,
        InvokeEapUI,
        Connected = 0x2000,
        Disconnected,
    }

    /// <summary>Layout verificado: RasGetConnectStatusW no rechazo este tamano (Pack=1, sin campos de tunel/subestado posteriores a Vista, que no se necesitan).</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 1)]
    public struct RasConnStatus
    {
        public int dwSize;
        public RasConnState rasconnstate;
        public int dwError;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 17)] // RAS_MaxDeviceType+1
        public string szDeviceType;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)] // RAS_MaxDeviceName+1
        public string szDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)] // RAS_MaxPhoneNumber+1
        public string szPhoneNumber;

        public static int Size => Marshal.SizeOf<RasConnStatus>();
    }

    public enum RasProjection : uint
    {
        PppIp = 0x0000_0800,
    }

    /// <summary>Layout verificado: RasGetProjectionInfoW no rechazo este tamano (Pack=1).</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 1)]
    public struct RasPppIp
    {
        public int dwSize;
        public int dwError;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 16)] // RAS_MaxIpAddress+1
        public string szIpAddress;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 16)] // RAS_MaxIpAddress+1
        public string szServerIpAddress;
        public int dwOptions;
        public int dwServerOptions;

        public static int Size => Marshal.SizeOf<RasPppIp>();
    }

    /// <summary>
    /// Layout verificado: SIN Pack=1 a proposito -a diferencia de RasConn/
    /// RasConnStatus/RasPppIp de arriba-: con el relleno automatico normal
    /// de .NET mas el "_padding" final explicito, Marshal.SizeOf da 1048, el
    /// unico tamano que RasEnumEntriesW acepto en esta maquina (result=0,
    /// entradas reales de la agenda de este equipo devueltas de verdad). Con
    /// Pack=1 el resultado es otro numero y Windows lo rechaza con
    /// ERROR_INVALID_SIZE.
    /// </summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RasEntryName
    {
        public int dwSize;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)] // RAS_MaxEntryName+1
        public string szEntryName;
        public int dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] // MAX_PATH
        public string szPhonebookPath;
        private readonly int _paddingToVerifiedSize;

        public static int Size => Marshal.SizeOf<RasEntryName>();
    }

    /// <summary>RAS_STATS de Ras.h: 15 DWORD (60 bytes). Los contadores de bytes son de 32 bits (dan la vuelta a los 4 GB): para bytes se usa NetworkInterface; de aqui solo se aprovecha dwConnectDuration (ms).</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct RasStats
    {
        public int dwSize;
        public uint dwBytesXmited;
        public uint dwBytesRcved;
        public uint dwFramesXmited;
        public uint dwFramesRcved;
        public uint dwCrcErr;
        public uint dwTimeoutErr;
        public uint dwAlignmentErr;
        public uint dwHardwareOverrunErr;
        public uint dwFramingErr;
        public uint dwBufferOverrunErr;
        public uint dwCompressionRatioIn;
        public uint dwCompressionRatioOut;
        public uint dwBps;
        public uint dwConnectDuration;

        public static int Size => Marshal.SizeOf<RasStats>();
    }

    [DllImport("rasapi32.dll", SetLastError = false)]
    public static extern int RasGetConnectionStatistics(IntPtr hrasconn, ref RasStats lpStatistics);

    /// <summary>hrasconn = INVALID_HANDLE_VALUE (-1) significa "todas las conexiones", segun Ras.h/MSDN.</summary>
    public static readonly IntPtr AllConnections = new(-1);
    public const uint RasCnConnection = 0x1;
    public const uint RasCnDisconnection = 0x2;

    [DllImport("rasapi32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RasConnectionNotificationW(IntPtr hrasconn, IntPtr hEvent, uint dwFlags);

    [DllImport("rasapi32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RasGetErrorStringW(uint uErrorValue, [Out] System.Text.StringBuilder lpszErrorString, uint cBufSize);

    [DllImport("rasapi32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RasEnumConnectionsW(
        [In, Out] RasConn[]? lprasconn, ref int lpcb, out int lpcConnections);

    [DllImport("rasapi32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RasGetConnectStatusW(IntPtr hrasconn, ref RasConnStatus lprasconnstatus);

    [DllImport("rasapi32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RasGetProjectionInfoW(
        IntPtr hrasconn, RasProjection rasprojection, ref RasPppIp lprasprojection, ref int lpcb);

    [DllImport("rasapi32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RasEnumEntriesW(
        string? reserved, string? lpszPhonebook, [In, Out] RasEntryName[]? lprasentryname, ref int lpcb, out int lpcEntries);
}
