using System.Diagnostics;
using System.Text;
using DidevVpn.App.Services.Ras;

namespace DidevVpn.App.Services;

/// <summary>
/// Crea/actualiza la conexion IKEv2/EAP-TLS "didev VPN" con los cmdlets
/// VpnClient (Add-VpnConnection, Set-VpnConnectionIPsecConfiguration,
/// Add-VpnConnectionRoute) via PowerShellRunner. SIEMPRE por usuario (nunca
/// -AllUserConnection): no hace falta elevar para nada de esto (ver
/// APPS/Windows/NOTAS-prompt-12-en-pausa.md, punto 2), y es lo que
/// corresponde a un certificado de cliente que vive en CurrentUser\My.
///
/// La plantilla del XML EAP es la misma, campo a campo, que ya usa
/// WINDOWS_INSTALL_PS1 en server/src/services/vpnClientPackages.ts del panel
/// (EAP tipo 13 = EAP-TLS, PerformServerValidation/AcceptServerName de la V2,
/// TrustedRootCA = huella SHA-1 tal cual la da $cert.Thumbprint en
/// PowerShell): ese script ya se probo de extremo a extremo con un
/// dispositivo real, asi que se reutiliza la misma forma exacta en vez de
/// inventar una nueva a partir solo de la documentacion.
///
/// Consultar el ESTADO (existe/conectada/IP) ya NO pasa por PowerShell
/// (prompt 12.7): powershell.exe tarda 1-3s solo en arrancar y cargar el
/// modulo VpnClient, y esto se llama muy a menudo (refresco periodico de la
/// bandeja y de la ventana). Va por RAS nativo (RasStateReader, P/Invoke a
/// rasapi32.dll: milisegundos, sin crear ningun proceso), con el camino de
/// PowerShell de siempre como RESPALDO si el P/Invoke fallara -no se ha
/// podido validar ese P/Invoke contra una conexion RAS activa real en este
/// entorno de desarrollo, ver RasInterop-. Conectar/desconectar usa
/// rasdial.exe directamente (sin powershell.exe de por medio: un unico
/// proceso en vez de dos).
/// </summary>
internal sealed class VpnConnectionService : IVpnConnectionService
{
    private readonly IRasStateReader _rasReader;
    private readonly IEapUserCredentialStore _eapCredentials;
    private readonly FileLogger? _logger;
    private volatile bool _nativeReaderFailed;

    public VpnConnectionService(FileLogger? logger = null) : this(new RasStateReader(logger), new EapUserCredentialStore(), logger)
    {
    }

    internal VpnConnectionService(IRasStateReader rasReader, IEapUserCredentialStore eapCredentials, FileLogger? logger)
    {
        _rasReader = rasReader;
        _eapCredentials = eapCredentials;
        _logger = logger;
    }

    public string? GetSavedEapCertificateThumbprint(string connectionName) =>
        _eapCredentials.GetSavedCertificateThumbprint(connectionName);

    public void SaveEapCredentials(string connectionName, System.Security.Cryptography.X509Certificates.X509Certificate2 certificate)
    {
        _eapCredentials.SaveCertificate(connectionName, certificate);
        _logger?.Info($"Credenciales EAP guardadas para \"{connectionName}\" (certificado {certificate.Thumbprint}): conectar ya no deberia pedir certificado.");
    }

    public void CreateOrUpdateConnection(VpnConnectionSpec spec)
    {
        var eapXml = BuildEapConfigXml(spec.EapServerName, spec.RootCertificateThumbprintSha1, spec.ClientCertificateIssuerThumbprintSha1);
        var eapXmlPath = Path.Combine(Path.GetTempPath(), $"didev-vpn-eap-{Guid.NewGuid():N}.xml");
        File.WriteAllText(eapXmlPath, eapXml, Encoding.UTF8);

        try
        {
            var script = new StringBuilder();
            script.AppendLine("$ErrorActionPreference = 'Stop'");
            script.AppendLine($"$name = {PsString(spec.ConnectionName)}");
            script.AppendLine("if (Get-VpnConnection -Name $name -ErrorAction SilentlyContinue) {");
            script.AppendLine("  Remove-VpnConnection -Name $name -Force -ErrorAction Stop");
            script.AppendLine("}");
            script.AppendLine($"$eapXml = [xml](Get-Content -Raw -Path {PsString(eapXmlPath)})");
            script.AppendLine("$vpnParams = @{");
            script.AppendLine("  Name = $name");
            script.AppendLine($"  ServerAddress = {PsString(spec.ServerAddress)}");
            script.AppendLine("  TunnelType = 'Ikev2'");
            script.AppendLine("  AuthenticationMethod = 'Eap'");
            script.AppendLine("  EapConfigXmlStream = $eapXml");
            script.AppendLine($"  SplitTunneling = {(spec.SplitTunneling ? "$true" : "$false")}");
            script.AppendLine("  Force = $true");
            script.AppendLine("}");
            script.AppendLine("Add-VpnConnection @vpnParams | Out-Null");

            script.AppendLine("$ipsecParams = @{");
            script.AppendLine("  ConnectionName = $name");
            script.AppendLine($"  AuthenticationTransformConstants = {PsString(spec.IkeEncryption)}");
            script.AppendLine($"  CipherTransformConstants = {PsString(spec.IkeEncryption)}");
            script.AppendLine($"  EncryptionMethod = {PsString(spec.IkeEncryption)}");
            script.AppendLine($"  IntegrityCheckMethod = {PsString(spec.IkeIntegrity)}");
            script.AppendLine($"  DHGroup = {PsString(spec.IkeDhGroup)}");
            script.AppendLine($"  PfsGroup = {PsString(spec.EspPfsGroup)}");
            script.AppendLine("  Force = $true");
            script.AppendLine("}");
            script.AppendLine("Set-VpnConnectionIPsecConfiguration @ipsecParams | Out-Null");

            foreach (var route in spec.SplitRoutes)
            {
                script.AppendLine($"Add-VpnConnectionRoute -ConnectionName $name -DestinationPrefix {PsString(route)} -Force | Out-Null");
            }

            PowerShellRunner.RunScript(script.ToString());
        }
        finally
        {
            try { File.Delete(eapXmlPath); } catch { /* best effort */ }
        }
    }

    public void RemoveConnection(string connectionName)
    {
        var script =
            $"$ErrorActionPreference = 'Stop'\n" +
            $"if (Get-VpnConnection -Name {PsString(connectionName)} -ErrorAction SilentlyContinue) {{\n" +
            $"  Remove-VpnConnection -Name {PsString(connectionName)} -Force\n" +
            $"}}\n";
        PowerShellRunner.RunScript(script);
    }

    public bool ConnectionExists(string connectionName)
    {
        if (!_nativeReaderFailed)
        {
            try
            {
                return _rasReader.EntryExists(connectionName);
            }
            catch (Exception ex)
            {
                OnNativeReaderFailure(ex);
            }
        }
        return ConnectionExistsViaPowerShell(connectionName);
    }

    public bool IsConnected(string connectionName)
    {
        if (!_nativeReaderFailed)
        {
            try
            {
                return _rasReader.GetState(connectionName).Connected;
            }
            catch (Exception ex)
            {
                OnNativeReaderFailure(ex);
            }
        }
        return IsConnectedViaPowerShell(connectionName);
    }

    public string? GetAssignedIPv4Address(string connectionName)
    {
        if (!_nativeReaderFailed)
        {
            try
            {
                return _rasReader.GetState(connectionName).Ipv4Address;
            }
            catch (Exception ex)
            {
                OnNativeReaderFailure(ex);
            }
        }
        return GetAssignedIPv4AddressViaPowerShell(connectionName);
    }

    /// <summary>
    /// Un fallo del P/Invoke de RAS (no "sin conexiones"/"no encontrada": eso
    /// ya lo maneja RasStateReader como resultado normal, esto es un fallo
    /// del marshaling/la propia llamada) desactiva el camino nativo para el
    /// RESTO de esta instancia -no tiene sentido reintentar un P/Invoke roto
    /// en cada refresco-, y cae al camino por PowerShell de siempre.
    /// </summary>
    private void OnNativeReaderFailure(Exception ex)
    {
        _nativeReaderFailed = true;
        _logger?.Warn($"RAS nativo (P/Invoke) ha fallado, usando PowerShell como respaldo para el resto de esta sesion: {ex.Message}");
    }

    // ERROR_REMOTE_ACCESS_NO_UI_INTERACTION_ALLOWED (703): "la conexion
    // necesita informacion de su parte, pero la aplicacion no permite
    // interaccion del usuario". rasdial.exe no tiene consola con la que
    // preguntar (CreateNoWindow=true): en vez de fallar sin mas, se cae al
    // dialogo nativo como ultimo recurso (ver Connect).
    private const int ErrorNoUiInteractionAllowed = 703;

    public void Connect(string connectionName)
    {
        Process? dialog = null;
        try
        {
            RunRasDialExe(connectionName, disconnect: false);
        }
        catch (RasDialException ex) when (ex.ExitCode == ErrorNoUiInteractionAllowed)
        {
            _logger?.Warn(
                $"rasdial.exe necesita interaccion del usuario para \"{connectionName}\" (703): " +
                "abriendo el dialogo nativo (rasphone.exe -d) como ultimo recurso.");
            dialog = RunRasPhoneDialog(connectionName);
        }

        // El resultado NO se deduce del codigo de salida (rasphone sale al
        // instante; rasdial puede salir antes de que el tunel este arriba):
        // se sigue la fase real de RAS hasta Connected, error o 60 s (que, con
        // el dialogo de Windows abierto, empiezan al cerrarse, con tope de 120 s).
        try
        {
            WaitForConnected(connectionName, dialog);
        }
        finally
        {
            dialog?.Dispose();
        }
    }

    public RasPhaseInfo GetConnectionPhase(string connectionName)
    {
        if (!_nativeReaderFailed)
        {
            try
            {
                return _rasReader.GetPhase(connectionName);
            }
            catch (Exception ex)
            {
                OnNativeReaderFailure(ex);
            }
        }
        return new RasPhaseInfo(IsConnectedViaPowerShell(connectionName) ? RasPhase.Connected : RasPhase.Disconnected);
    }

    private void WaitForConnected(string connectionName, Process? dialog)
    {
        var result = ConnectionWaiter
            .WaitUntilSettledAsync(
                () => GetConnectionPhase(connectionName),
                ConnectionWaiter.DefaultTimeout,
                ConnectionWaiter.DefaultPollInterval,
                interactiveDialogOpen: dialog is null ? null : () => !SafeHasExited(dialog))
            .GetAwaiter().GetResult();

        if (result.Outcome == WaitOutcome.TimedOut)
        {
            // Ultima palabra: se relee el estado REAL justo al agotar el limite.
            // Puede haberse establecido entre el ultimo sondeo y ahora.
            var last = GetConnectionPhase(connectionName);
            _logger?.Warn($"Limite agotado para \"{connectionName}\": estado real al releer = {last.Phase} (error {last.Error}).");
            if (last.Phase == RasPhase.Connected)
            {
                result = new WaitResult(WaitOutcome.Connected);
            }
            else if (last.Phase == RasPhase.Failed)
            {
                result = new WaitResult(WaitOutcome.Failed, last.Error);
            }
        }

        switch (result.Outcome)
        {
            case WaitOutcome.Connected:
                _logger?.Info($"\"{connectionName}\" conectada.");
                return;
            case WaitOutcome.Failed:
                var detail = result.Error != 0 ? $"{RasErrorText(result.Error)} (codigo {result.Error})" : "la conexion se cerro antes de establecerse";
                _logger?.Warn($"\"{connectionName}\" no se ha podido conectar: {detail}");
                throw new InvalidOperationException($"No se ha podido conectar: {detail}.");
            default:
                _logger?.Warn($"\"{connectionName}\" no se ha establecido en {ConnectionWaiter.DefaultTimeout.TotalSeconds:0} s.");
                throw new TimeoutException(
                    $"La conexion no se ha establecido en {ConnectionWaiter.DefaultTimeout.TotalSeconds:0} segundos.");
        }
    }

    private static string RasErrorText(int error)
    {
        var text = new StringBuilder(512);
        return RasInterop.RasGetErrorStringW((uint)error, text, (uint)text.Capacity) == 0
            ? text.ToString().Trim()
            : $"error RAS {error}";
    }

    public void Disconnect(string connectionName) => RunRasDialExe(connectionName, disconnect: true);

    /// <summary>rasdial.exe directamente (nunca via powershell.exe: un unico proceso, no dos). No existe Connect-VpnConnection; este es el mecanismo real (ver APPS/Windows/NOTAS-prompt-12-en-pausa.md, punto 1).</summary>
    private static void RunRasDialExe(string connectionName, bool disconnect)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "rasdial.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add(connectionName);
        if (disconnect)
        {
            startInfo.ArgumentList.Add("/disconnect");
        }

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("No se ha podido iniciar rasdial.exe.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        if (process.ExitCode != 0)
        {
            var message = !string.IsNullOrWhiteSpace(stdout) ? stdout.Trim() : stderr.Trim();
            throw new RasDialException(
                process.ExitCode,
                string.IsNullOrEmpty(message) ? $"rasdial.exe termino con codigo {process.ExitCode}." : message);
        }
    }

    /// <summary>Ultimo recurso (item 7c del prompt 12.7): el dialogo nativo de marcado, VISIBLE, para que la persona delante del equipo elija el certificado a mano si ni SimpleCertSelection ni el filtro por emisor bastaron. No se espera a que termine: es interactivo, la persona lo cierra.</summary>
    private static bool SafeHasExited(Process process)
    {
        try
        {
            return process.HasExited;
        }
        catch (InvalidOperationException)
        {
            return true;
        }
    }

    private static Process? RunRasPhoneDialog(string connectionName)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "rasphone.exe",
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("-d");
        startInfo.ArgumentList.Add(connectionName);
        return Process.Start(startInfo);
    }

    private static bool ConnectionExistsViaPowerShell(string connectionName)
    {
        var script =
            $"if (Get-VpnConnection -Name {PsString(connectionName)} -ErrorAction SilentlyContinue) {{ 'yes' }} else {{ 'no' }}";
        return PowerShellRunner.RunScript(script).Trim() == "yes";
    }

    private static bool IsConnectedViaPowerShell(string connectionName)
    {
        var script =
            $"(Get-VpnConnection -Name {PsString(connectionName)} -ErrorAction SilentlyContinue).ConnectionStatus";
        return PowerShellRunner.RunScript(script).Trim() == "Connected";
    }

    private static string? GetAssignedIPv4AddressViaPowerShell(string connectionName)
    {
        try
        {
            var script =
                $"(Get-NetIPAddress -InterfaceAlias {PsString(connectionName)} -AddressFamily IPv4 -ErrorAction SilentlyContinue | " +
                "Select-Object -First 1 -ExpandProperty IPAddress)";
            var result = PowerShellRunner.RunScript(script).Trim();
            return string.IsNullOrEmpty(result) ? null : result;
        }
        catch (PowerShellExecutionException)
        {
            return null;
        }
    }

    /// <summary>
    /// XML de EapHost (EAP-TLS, tipo 13). La estructura, el ORDEN de los
    /// elementos y los namespaces son los del XML que el propio Windows genero
    /// con New-EapConfiguration -Tls -UserCertificate -VerifyServerIdentity
    /// para una conexion que conecto bien (prueba real de la 0.1.6): EapHost
    /// valida contra un esquema estricto y un orden o namespace distinto hace
    /// fallar Add-VpnConnection con "Failed to generate the EAP Configuration"
    /// (WIN32 1). Por eso va en UNA linea, sin sangrias, y las huellas en el
    /// formato que usa Windows ("5c 0d ed ...": pares hex en minusculas
    /// separados por espacio, con un espacio final).
    ///
    /// Sobre esa base se anade, como en el ejemplo de Microsoft para EAP-TLS
    /// con filtrado por emisor: ServerNames + TrustedRootCA (sin aviso de
    /// "verificar el servidor") y TLSExtensions (V2) > FilteringInfo (V3) >
    /// CAHashList/IssuerHash (item 7 del prompt 12.7): con el emisor fijado
    /// solo el certificado de ESTE dispositivo encaja y SimpleCertSelection no
    /// tiene que elegir entre varios en CurrentUser\My (sin eso rasdial.exe
    /// falla con el error 703 porque no hay consola con la que preguntar).
    ///
    /// DisableUserPromptForServerValidation = true (prompt 12.9): nadie acepta
    /// "a ciegas" otro servidor, porque la raiz (TrustedRootCA) y el nombre
    /// (ServerNames) ya van fijados aqui: si el servidor no valida, falla
    /// CERRADO, no pregunta. Medido en un equipo real con un solo certificado:
    /// rasdial conecta con las cuatro combinaciones de este flag y
    /// RememberCredential, asi que RememberCredential NO hace falta y no se usa.
    /// </summary>
    internal static string BuildEapConfigXml(string serverName, string rootThumbprintSha1, string clientCertificateIssuerThumbprintSha1) =>
        "<EapHostConfig xmlns=\"http://www.microsoft.com/provisioning/EapHostConfig\">" +
        "<EapMethod>" +
        "<Type xmlns=\"http://www.microsoft.com/provisioning/EapCommon\">13</Type>" +
        "<VendorId xmlns=\"http://www.microsoft.com/provisioning/EapCommon\">0</VendorId>" +
        "<VendorType xmlns=\"http://www.microsoft.com/provisioning/EapCommon\">0</VendorType>" +
        "<AuthorId xmlns=\"http://www.microsoft.com/provisioning/EapCommon\">0</AuthorId>" +
        "</EapMethod>" +
        "<Config xmlns=\"http://www.microsoft.com/provisioning/EapHostConfig\">" +
        "<Eap xmlns=\"http://www.microsoft.com/provisioning/BaseEapConnectionPropertiesV1\">" +
        "<Type>13</Type>" +
        "<EapType xmlns=\"http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV1\">" +
        "<CredentialsSource><CertificateStore><SimpleCertSelection>true</SimpleCertSelection></CertificateStore></CredentialsSource>" +
        "<ServerValidation>" +
        "<DisableUserPromptForServerValidation>true</DisableUserPromptForServerValidation>" +
        $"<ServerNames>{System.Security.SecurityElement.Escape(serverName)}</ServerNames>" +
        $"<TrustedRootCA>{FormatThumbprint(rootThumbprintSha1)}</TrustedRootCA>" +
        "</ServerValidation>" +
        "<DifferentUsername>false</DifferentUsername>" +
        "<PerformServerValidation xmlns=\"http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2\">true</PerformServerValidation>" +
        "<AcceptServerName xmlns=\"http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2\">true</AcceptServerName>" +
        "<TLSExtensions xmlns=\"http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2\">" +
        "<FilteringInfo xmlns=\"http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV3\">" +
        $"<CAHashList Enabled=\"true\"><IssuerHash>{FormatThumbprint(clientCertificateIssuerThumbprintSha1)}</IssuerHash></CAHashList>" +
        "</FilteringInfo>" +
        "</TLSExtensions>" +
        "</EapType></Eap></Config></EapHostConfig>";

    /// <summary>"5C0DED..." (o ya con espacios) -> "5c 0d ed ... " (formato de EapHost: minusculas, pares separados por espacio, espacio final).</summary>
    internal static string FormatThumbprint(string thumbprint)
    {
        var hex = new string(thumbprint.Where(Uri.IsHexDigit).ToArray()).ToLowerInvariant();
        var sb = new StringBuilder();
        for (var i = 0; i + 1 < hex.Length; i += 2)
        {
            sb.Append(hex, i, 2).Append(' ');
        }
        return sb.ToString();
    }

    /// <summary>Cadena literal de PowerShell entre comillas simples, con las comillas simples internas dobladas (escape estandar de PS).</summary>
    private static string PsString(string value) => "'" + value.Replace("'", "''") + "'";
}

/// <summary>rasdial.exe termino con un codigo de error (el mismo que devolveria la API RAS nativa, p.ej. 703).</summary>
internal sealed class RasDialException : Exception
{
    public int ExitCode { get; }

    public RasDialException(int exitCode, string message) : base(message)
    {
        ExitCode = exitCode;
    }
}
