using DidevVpn.App.Orchestration;
using DidevVpn.App.Services;
using DidevVpn.App.UI;
using DidevVpn.Core.Profile;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App;

/// <summary>
/// Ventana principal para gestionar conexiones VPN, con icono de bandeja
/// disponible al ocultar la ventana. Puede mantener varias conexiones a la vez.
///
/// Rendimiento (prompt 12.7): el estado de las conexiones (existe/conectada/
/// IP) ya NO se consulta aqui directamente -eso lanzaba PowerShell por cada
/// conexion, en el hilo de interfaz, en cada refresco-. Se lee siempre de
/// <see cref="ConnectionStateService"/> (cache compartida con
/// ConnectionManagerForm, refrescada en segundo plano por eventos de red).
/// Las operaciones largas (conectar/desconectar, importar perfil, renovar)
/// van en Task.Run, nunca bloquean el hilo de interfaz.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;
    private readonly FileLogger _logger = new();
    private readonly ICertificateEnrollmentService _certificateService = new CertificateEnrollmentService();
    private readonly IEstClient _estClient = new EstClient();
    private readonly IVpnConnectionService _vpnService;
    private readonly IRootCertificateStoreService _rootStore = new RootCertificateStoreService();
    private readonly ITaskSchedulerService _taskScheduler = new TaskSchedulerService();
    private readonly IUserConfirmations _confirmations = new MessageBoxUserConfirmations();
    private readonly ConnectionStateService _stateService;
    private readonly System.Windows.Forms.Timer _renewalTimer;
    private readonly ConnectionManagerForm _managerForm;
    private readonly HashSet<string> _busyConnections = new(StringComparer.OrdinalIgnoreCase);

    private string? _lastErrorMessage;
    private bool _importing;

    private const string RenewalTaskName = "didevVpnRenewal";

    public TrayApplicationContext()
    {
        AppPaths.EnsureDataDirectoryExists();
        _vpnService = new VpnConnectionService(_logger);

        _notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Shield,
            Visible = true,
            Text = AppPaths.DisplayName,
            ContextMenuStrip = new ContextMenuStrip(),
        };

        _stateService = new ConnectionStateService(_vpnService, ConnectionStore.List, _logger, new Services.Ras.RasConnectionMonitor(_logger));
        _stateService.StateChanged += OnStateChanged;

        _managerForm = new ConnectionManagerForm(
            ConnectionStore.List,
            _stateService.GetState,
            ImportProfile,
            ToggleConnection,
            ShowConnectionStatus,
            RemoveConnection,
            IsBusy,
            new ConnectionDetailsCollector());
        _notifyIcon.DoubleClick += (_, _) => ShowManager();

        BuildMenu();
        RefreshStatus();
        _managerForm.Show();

        // "al arrancar y cada 12h mientras este abierta" (variante portable e
        // instalada por igual: no hace dano comprobarlo tambien aqui aunque
        // exista ademas la tarea programada, GetStatus/simplereenroll son
        // idempotentes respecto a si "toca renovar" o no). Renueva TODAS las
        // conexiones, una por una, en segundo plano.
        _ = RenewAllIfDueAsync();
        _renewalTimer = new System.Windows.Forms.Timer { Interval = (int)TimeSpan.FromHours(12).TotalMilliseconds };
        _renewalTimer.Tick += async (_, _) => await RenewAllIfDueAsync();
        _renewalTimer.Start();

        _ = _stateService.RefreshAsync();
    }

    /// <summary>Entregado en el hilo de interfaz por ConnectionStateService (ver su comentario): seguro llamar directamente a controles de aqui.</summary>
    private void OnStateChanged()
    {
        RefreshStatus();
        _managerForm.RefreshConnections();
    }

    private bool IsBusy(string cn)
    {
        lock (_busyConnections)
        {
            return _busyConnections.Contains(cn);
        }
    }

    private void SetBusy(string cn, bool busy)
    {
        lock (_busyConnections)
        {
            if (busy) _busyConnections.Add(cn);
            else _busyConnections.Remove(cn);
        }
        _managerForm.RefreshConnections();
    }

    private void BuildMenu()
    {
        var menu = _notifyIcon.ContextMenuStrip!;
        menu.Opening += (_, _) => RebuildMenuItems(menu);
        RebuildMenuItems(menu);
    }

    private void RebuildMenuItems(ContextMenuStrip menu)
    {
        menu.Items.Clear();

        var variant = AppPaths.DetectVariant();
        var version = AppVersionHelper.GetAppVersion();
        var connections = ConnectionStore.List();

        var headerText = $"didev VPN ({(variant == AppVariant.Installed ? "instalada" : "portable")} {version})";
        menu.Items.Add(new ToolStripMenuItem(headerText) { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());

        if (connections.Count == 0)
        {
            menu.Items.Add(new ToolStripMenuItem("Sin conexiones configuradas") { Enabled = false });
        }
        else
        {
            foreach (var connection in connections.OrderBy(c => c.Cn, StringComparer.OrdinalIgnoreCase))
            {
                menu.Items.Add(BuildConnectionSubmenu(connection));
            }
        }

        menu.Items.Add(new ToolStripSeparator());

        var importItem = new ToolStripMenuItem(_importing ? "Importando perfil..." : "Importar perfil...") { Enabled = !_importing };
        importItem.Click += (_, _) => ImportProfile();
        menu.Items.Add(importItem);

        if (variant == AppVariant.Portable && connections.Count > 0)
        {
            // Una excepcion aqui subiria hasta el WndProc del icono de bandeja
            // y tumbaria la app entera (volcado real: FileNotFoundException al
            // cargar el Programador de tareas): es un extra del menu, no puede
            // ser fatal. Si falla, el elemento sale desactivado y se registra.
            bool taskRegistered;
            string? taskError = null;
            try
            {
                taskRegistered = _taskScheduler.PerUserRenewalTaskExists(RenewalTaskName);
            }
            catch (Exception ex)
            {
                taskRegistered = false;
                taskError = ex.Message;
                _logger.Warn($"No se ha podido consultar la tarea de renovacion en segundo plano: {ex}");
            }

            var toggleTask = new ToolStripMenuItem("Renovar aunque la app este cerrada")
            {
                Checked = taskRegistered,
                CheckOnClick = true,
                Enabled = taskError is null,
                ToolTipText = taskError is null ? null : "No se puede consultar el Programador de tareas de Windows (ver el registro).",
            };
            toggleTask.Click += (_, _) => ToggleBackgroundRenewalTask(!taskRegistered);
            menu.Items.Add(toggleTask);
        }

        var logsItem = new ToolStripMenuItem("Ver registro");
        logsItem.Click += (_, _) => System.Diagnostics.Process.Start("explorer.exe", AppPaths.LogsDirectory);
        menu.Items.Add(logsItem);

        var aboutItem = new ToolStripMenuItem("Acerca de didev VPN");
        aboutItem.Click += (_, _) => ShowAbout(variant, version);
        menu.Items.Add(aboutItem);

        menu.Items.Add(new ToolStripSeparator());

        var exitItem = new ToolStripMenuItem("Salir");
        exitItem.Click += (_, _) => ExitApplication();
        menu.Items.Add(exitItem);
    }

    private ToolStripMenuItem BuildConnectionSubmenu(ConnectionRecord connection)
    {
        var state = _stateService.GetState(connection.Cn);
        var busy = IsBusy(connection.Cn);
        var submenu = new ToolStripMenuItem($"{connection.Cn} ({connection.Server}) - {(busy ? "trabajando..." : state.Connected ? "conectado" : "desconectado")}");

        var toggleConnection = new ToolStripMenuItem(state.Connected ? "Desconectar" : "Conectar") { Enabled = !busy };
        toggleConnection.Click += (_, _) => ToggleConnection(connection.Cn, state.Connected);
        submenu.DropDownItems.Add(toggleConnection);

        var statusItem = new ToolStripMenuItem("Ver estado...");
        statusItem.Click += (_, _) => ShowConnectionStatus(connection.Cn);
        submenu.DropDownItems.Add(statusItem);

        var renewItem = new ToolStripMenuItem("Renovar ahora") { Enabled = !busy };
        renewItem.Click += async (_, _) => await RenewIfDueAsync(connection.Cn, force: true);
        submenu.DropDownItems.Add(renewItem);

        submenu.DropDownItems.Add(new ToolStripSeparator());

        var removeItem = new ToolStripMenuItem("Quitar de este equipo...") { Enabled = !busy };
        removeItem.Click += (_, _) => RemoveConnection(connection.Cn);
        submenu.DropDownItems.Add(removeItem);

        return submenu;
    }

    private async void ToggleConnection(string cn, bool currentlyConnected)
    {
        if (IsBusy(cn))
        {
            return;
        }
        SetBusy(cn, true);
        try
        {
            await Task.Run(() =>
            {
                if (currentlyConnected)
                {
                    _vpnService.Disconnect(cn);
                }
                else
                {
                    EnsureEapCredentials(cn);
                    _vpnService.Connect(cn);
                }
            }).ConfigureAwait(true); // true: seguir en el hilo de interfaz al continuar (BuildMenu/RefreshStatus tocan controles)
            _lastErrorMessage = null;
        }
        catch (Exception ex)
        {
            HandleError($"No se ha podido cambiar el estado de la conexion \"{cn}\"", ex);
        }
        finally
        {
            // La UI nunca se queda en "Trabajando...": pase lo que pase se
            // libera y se relee el estado real (Conectado/Desconectado).
            SetBusy(cn, false);
        }
        await _stateService.RefreshAsync();
    }

    /// <summary>
    /// "Reparar" una conexion ya existente (dada de alta con una version
    /// anterior, sin credenciales EAP guardadas): antes de conectar, apunta
    /// las credenciales de la entrada al certificado vigente. Idempotente y
    /// barato; un fallo aqui no impide conectar (solo se avisa en el log: lo
    /// peor que pasa es el dialogo de seleccion de siempre).
    /// </summary>
    private void EnsureEapCredentials(string cn)
    {
        try
        {
            var record = ConnectionStore.Load(cn);
            if (record is null)
            {
                return;
            }
            using var store = new System.Security.Cryptography.X509Certificates.X509Store(
                System.Security.Cryptography.X509Certificates.StoreName.My,
                System.Security.Cryptography.X509Certificates.StoreLocation.CurrentUser);
            store.Open(System.Security.Cryptography.X509Certificates.OpenFlags.ReadOnly);
            var matches = store.Certificates.Find(
                System.Security.Cryptography.X509Certificates.X509FindType.FindByThumbprint,
                record.CertificateThumbprint, validOnly: false);
            if (matches.Count == 0)
            {
                _logger.Warn($"No se encuentra el certificado de \"{cn}\" ({record.CertificateThumbprint}) en CurrentUser\\My: no se pueden guardar las credenciales EAP.");
                return;
            }
            _vpnService.SaveEapCredentials(cn, matches[0]);
        }
        catch (Exception ex)
        {
            _logger.Warn($"No se han podido guardar las credenciales EAP de \"{cn}\" (se conecta igualmente): {ex.Message}");
        }
    }

    private async void ImportProfile()
    {
        if (_importing)
        {
            return;
        }

        using var form = new ImportProfileForm();
        if (form.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(form.EnvelopeJson))
        {
            return;
        }

        _importing = true;
        try
        {
            var result = ProfileVerifier.Verify(form.EnvelopeJson, DateTimeOffset.UtcNow);
            if (!result.Success)
            {
                MessageBox.Show(
                    result.ErrorMessage,
                    "Perfil rechazado",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            var orchestrator = new EnrollmentOrchestrator(
                _certificateService, _estClient, _vpnService, _rootStore, _confirmations, _logger, AppVersionHelper.GetAppVersion());
            var connection = await Task.Run(() => orchestrator.EnrollAsync(result.Profile!, CancellationToken.None)).ConfigureAwait(true);
            _lastErrorMessage = null;
            _managerForm.RefreshConnections();
            MessageBox.Show(
                $"Conexion \"{connection.Cn}\" ({connection.Server}) dada de alta. Ya puedes conectar desde el menu de la bandeja.",
                "Alta completada",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (OperationCanceledException ex)
        {
            MessageBox.Show(ex.Message, "Alta cancelada", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (TrustAnchorMismatchException ex)
        {
            _lastErrorMessage = ex.Message;
            MessageBox.Show(ex.Message, "Identidad del servidor cambiada", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch (MinAppVersionRequiredException ex)
        {
            _lastErrorMessage = ex.Message;
            MessageBox.Show(ex.Message, "Hace falta actualizar didev VPN", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            const string context = "No se ha podido completar el alta";
            _lastErrorMessage = $"{context}: {ex.Message}";
            _logger.Error(context, ex);
            MessageBox.Show(
                $"{ex.Message}\n\nNo se ha guardado la conexion. Si EST llego a emitir el certificado antes del error, el token de un solo uso puede haberse consumido. En ese caso, genera un token y un perfil nuevos desde el panel.",
                "Error al importar el perfil",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _importing = false;
        }
        await _stateService.RefreshAsync();
    }

    private async Task RenewAllIfDueAsync()
    {
        foreach (var connection in ConnectionStore.List())
        {
            await RenewIfDueAsync(connection.Cn, force: false);
        }
    }

    private async Task RenewIfDueAsync(string cn, bool force)
    {
        if (IsBusy(cn))
        {
            return;
        }
        var connection = ConnectionStore.Load(cn);
        if (connection is null)
        {
            return;
        }

        SetBusy(cn, true);
        try
        {
            var orchestrator = new RenewalOrchestrator(_certificateService, _estClient, _vpnService, _confirmations, _logger, AppVersionHelper.GetAppVersion());
            var result = await Task.Run(() => orchestrator.RenewIfDueAsync(connection, CancellationToken.None)).ConfigureAwait(true);
            switch (result.Outcome)
            {
                case RenewalOutcome.Renewed:
                    _lastErrorMessage = null;
                    if (force)
                    {
                        MessageBox.Show($"Certificado de \"{cn}\" renovado.", "didev VPN", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    break;
                case RenewalOutcome.BlockedByMinAppVersion:
                    _lastErrorMessage = result.Message;
                    ShowBalloon("Hace falta actualizar didev VPN", result.Message ?? string.Empty, ToolTipIcon.Warning);
                    break;
                case RenewalOutcome.NotDue:
                    if (force)
                    {
                        MessageBox.Show($"\"{cn}\" todavia no toca renovarla.", "didev VPN", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            HandleError($"No se ha podido comprobar/renovar el certificado de \"{cn}\"", ex);
        }
        SetBusy(cn, false);
    }

    private void ToggleBackgroundRenewalTask(bool enable)
    {
        try
        {
            if (enable)
            {
                _taskScheduler.RegisterPerUserRenewalTask(RenewalTaskName, AppPaths.CurrentExecutablePath);
            }
            else
            {
                _taskScheduler.RemovePerUserRenewalTask(RenewalTaskName);
            }
        }
        catch (Exception ex)
        {
            HandleError("No se ha podido cambiar la tarea de renovacion en segundo plano", ex);
        }
    }

    private void RemoveConnection(string cn)
    {
        var connection = ConnectionStore.Load(cn);
        if (connection is null)
        {
            return;
        }

        var confirm = MessageBox.Show(
            $"Se borrara la conexion \"{cn}\" y la configuracion guardada.\n\n?Borrar tambien el certificado del dispositivo de este equipo?",
            $"Quitar \"{cn}\" de este equipo",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Warning);
        if (confirm == DialogResult.Cancel)
        {
            return;
        }

        try
        {
            _vpnService.RemoveConnection(cn);

            if (confirm == DialogResult.Yes)
            {
                using var store = new System.Security.Cryptography.X509Certificates.X509Store(
                    System.Security.Cryptography.X509Certificates.StoreName.My,
                    System.Security.Cryptography.X509Certificates.StoreLocation.CurrentUser);
                store.Open(System.Security.Cryptography.X509Certificates.OpenFlags.ReadWrite);
                var matches = store.Certificates.Find(
                    System.Security.Cryptography.X509Certificates.X509FindType.FindByThumbprint,
                    connection.CertificateThumbprint, validOnly: false);
                foreach (var cert in matches)
                {
                    store.Remove(cert);
                }
            }

            ConnectionStore.Delete(cn);

            // Si ya no queda ninguna conexion, la tarea de renovacion en
            // segundo plano (si estaba activada) ya no tiene nada que hacer.
            if (ConnectionStore.List().Count == 0)
            {
                try { _taskScheduler.RemovePerUserRenewalTask(RenewalTaskName); } catch { /* best effort */ }
            }

            _logger.Info($"Conexion \"{cn}\" eliminada de este equipo.");
        }
        catch (Exception ex)
        {
            HandleError($"No se ha podido quitar \"{cn}\" por completo", ex);
        }
        _ = _stateService.RefreshAsync();
    }

    private void ShowConnectionStatus(string cn)
    {
        var connection = ConnectionStore.Load(cn);
        if (connection is null)
        {
            return;
        }

        var state = _stateService.GetState(cn);
        var lines = new List<string>
        {
            $"Conexion: {connection.Cn}",
            $"Servidor: {connection.Server}",
            $"Estado: {(state.Connected ? "Conectado" : "Desconectado")}",
            $"IP asignada: {state.Ipv4Address ?? "(no conectado)"}",
            $"Clave: {(connection.IsTpmBacked ? "TPM" : "software")}",
            $"Ultima emision/renovacion: {connection.LastEnrolledAtUtc:u}",
        };
        if (_lastErrorMessage is not null)
        {
            lines.Add("");
            lines.Add($"Ultimo error: {_lastErrorMessage}");
        }
        MessageBox.Show(string.Join(Environment.NewLine, lines), $"Estado de \"{cn}\"");
    }

    private void ShowAbout(AppVariant variant, AppVersion version)
    {
        MessageBox.Show(
            $"didev VPN\nVersion: {version}\nVariante: {(variant == AppVariant.Installed ? "instalada (MSI)" : "portable")}",
            "Acerca de didev VPN");
    }

    private void RefreshStatus()
    {
        var connections = ConnectionStore.List();
        if (connections.Count == 0)
        {
            _notifyIcon.Text = $"{AppPaths.DisplayName} - sin conexiones";
            return;
        }

        var connectedCount = connections.Count(c => _stateService.GetState(c.Cn).Connected);
        var tooltip = connections.Count == 1
            ? $"{AppPaths.DisplayName} - {connections[0].Cn} - {(connectedCount > 0 ? "conectado" : "desconectado")}"
            : $"{AppPaths.DisplayName} - {connectedCount}/{connections.Count} conectadas";
        // NotifyIcon.Text tiene un limite de 63 caracteres.
        _notifyIcon.Text = tooltip.Length > 63 ? tooltip[..63] : tooltip;
    }

    private void HandleError(string context, Exception ex)
    {
        _lastErrorMessage = $"{context}: {ex.Message}";
        _logger.Error(context, ex);
        ShowBalloon(context, ex.Message, ToolTipIcon.Error);
    }

    private void ShowBalloon(string title, string text, ToolTipIcon icon)
    {
        _notifyIcon.BalloonTipTitle = title;
        _notifyIcon.BalloonTipText = text;
        _notifyIcon.BalloonTipIcon = icon;
        _notifyIcon.ShowBalloonTip(8000);
    }

    private void ExitApplication()
    {
        _notifyIcon.Visible = false;
        _managerForm.Dispose();
        _stateService.StateChanged -= OnStateChanged;
        _stateService.Dispose();
        _renewalTimer.Stop();
        Application.Exit();
    }

    private void ShowManager()
    {
        _managerForm.RefreshConnections();
        _managerForm.Show();
        _managerForm.WindowState = FormWindowState.Normal;
        _managerForm.Activate();
    }
}
