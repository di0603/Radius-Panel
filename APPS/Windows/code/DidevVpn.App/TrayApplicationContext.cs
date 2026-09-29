using DidevVpn.App.Orchestration;
using DidevVpn.App.Services;
using DidevVpn.App.UI;
using DidevVpn.Core.Profile;
using DidevVpn.Core.Versioning;

namespace DidevVpn.App;

/// <summary>
/// Icono de bandeja: conectar/desconectar, estado, IP asignada, caducidad
/// del certificado, ultimo error legible, variante y version (ver enunciado
/// original). Sin ventana principal -toda la interaccion es por el menu
/// contextual y dialogos puntuales (importar perfil, confirmaciones)-.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;
    private readonly FileLogger _logger = new();
    private readonly ICertificateEnrollmentService _certificateService = new CertificateEnrollmentService();
    private readonly IEstClient _estClient = new EstClient();
    private readonly IVpnConnectionService _vpnService = new VpnConnectionService();
    private readonly IRootCertificateStoreService _rootStore = new RootCertificateStoreService();
    private readonly ITaskSchedulerService _taskScheduler = new TaskSchedulerService();
    private readonly IUserConfirmations _confirmations = new MessageBoxUserConfirmations();
    private readonly System.Windows.Forms.Timer _refreshTimer;
    private readonly System.Windows.Forms.Timer _renewalTimer;

    private DeviceState? _deviceState;
    private string? _lastErrorMessage;

    private const string RenewalTaskName = "didevVpnRenewal";

    public TrayApplicationContext()
    {
        AppPaths.EnsureDataDirectoryExists();
        _deviceState = DeviceStateStore.Load();

        _notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Shield,
            Visible = true,
            Text = AppPaths.DisplayName,
            ContextMenuStrip = new ContextMenuStrip(),
        };
        _notifyIcon.DoubleClick += (_, _) => ShowStatus();

        BuildMenu();
        RefreshStatus();

        // "al arrancar y cada 12h mientras este abierta" (variante portable e
        // instalada por igual: no hace dano comprobarlo tambien aqui aunque
        // exista ademas la tarea programada, GetStatus/simplereenroll son
        // idempotentes respecto a si "toca renovar" o no).
        _ = RenewIfDueAsync();
        _renewalTimer = new System.Windows.Forms.Timer { Interval = (int)TimeSpan.FromHours(12).TotalMilliseconds };
        _renewalTimer.Tick += async (_, _) => await RenewIfDueAsync();
        _renewalTimer.Start();

        _refreshTimer = new System.Windows.Forms.Timer { Interval = 15_000 };
        _refreshTimer.Tick += (_, _) => RefreshStatus();
        _refreshTimer.Start();
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
        var headerText = _deviceState is null
            ? "Sin dispositivo dado de alta"
            : $"{_deviceState.Cn} ({(variant == AppVariant.Installed ? "instalada" : "portable")} {version})";
        menu.Items.Add(new ToolStripMenuItem(headerText) { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());

        if (_deviceState is not null)
        {
            var connected = _vpnService.ConnectionExists(AppPaths.ConnectionName) && _vpnService.IsConnected(AppPaths.ConnectionName);
            var toggleConnection = new ToolStripMenuItem(connected ? "Desconectar" : "Conectar");
            toggleConnection.Click += (_, _) => ToggleConnection(connected);
            menu.Items.Add(toggleConnection);

            var statusItem = new ToolStripMenuItem("Ver estado...");
            statusItem.Click += (_, _) => ShowStatus();
            menu.Items.Add(statusItem);

            var renewItem = new ToolStripMenuItem("Renovar ahora");
            renewItem.Click += async (_, _) => await RenewIfDueAsync(force: true);
            menu.Items.Add(renewItem);

            menu.Items.Add(new ToolStripSeparator());
        }

        var importItem = new ToolStripMenuItem(_deviceState is null ? "Importar perfil..." : "Importar otro perfil...");
        importItem.Click += (_, _) => ImportProfile();
        menu.Items.Add(importItem);

        if (variant == AppVariant.Portable && _deviceState is not null)
        {
            var taskRegistered = _taskScheduler.PerUserRenewalTaskExists(RenewalTaskName);
            var toggleTask = new ToolStripMenuItem("Renovar aunque la app este cerrada") { Checked = taskRegistered, CheckOnClick = true };
            toggleTask.Click += (_, _) => ToggleBackgroundRenewalTask(!taskRegistered);
            menu.Items.Add(toggleTask);
        }

        var logsItem = new ToolStripMenuItem("Ver registro");
        logsItem.Click += (_, _) => System.Diagnostics.Process.Start("explorer.exe", AppPaths.LogsDirectory);
        menu.Items.Add(logsItem);

        menu.Items.Add(new ToolStripSeparator());

        if (_deviceState is not null)
        {
            var removeItem = new ToolStripMenuItem("Quitar de este equipo...");
            removeItem.Click += (_, _) => RemoveFromThisComputer();
            menu.Items.Add(removeItem);
        }

        var aboutItem = new ToolStripMenuItem("Acerca de didev VPN");
        aboutItem.Click += (_, _) => ShowAbout(variant, version);
        menu.Items.Add(aboutItem);

        menu.Items.Add(new ToolStripSeparator());

        var exitItem = new ToolStripMenuItem("Salir");
        exitItem.Click += (_, _) => ExitApplication();
        menu.Items.Add(exitItem);
    }

    private void ToggleConnection(bool currentlyConnected)
    {
        try
        {
            if (currentlyConnected)
            {
                _vpnService.Disconnect(AppPaths.ConnectionName);
            }
            else
            {
                _vpnService.Connect(AppPaths.ConnectionName);
            }
            _lastErrorMessage = null;
        }
        catch (Exception ex)
        {
            HandleError("No se ha podido cambiar el estado de la conexion", ex);
        }
        RefreshStatus();
    }

    private async void ImportProfile()
    {
        using var form = new ImportProfileForm();
        if (form.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(form.EnvelopeJson))
        {
            return;
        }

        try
        {
            var verifier = ProfileSigningKeyLoader.CreateVerifier();
            var result = verifier.Verify(form.EnvelopeJson, DateTimeOffset.UtcNow);
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
            _deviceState = await orchestrator.EnrollAsync(result.Profile!, CancellationToken.None);
            _lastErrorMessage = null;
            MessageBox.Show(
                $"Dispositivo \"{_deviceState.Cn}\" dado de alta. Ya puedes conectar desde el menu de la bandeja.",
                "Alta completada",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (OperationCanceledException ex)
        {
            MessageBox.Show(ex.Message, "Alta cancelada", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (MinAppVersionRequiredException ex)
        {
            _lastErrorMessage = ex.Message;
            MessageBox.Show(ex.Message, "Hace falta actualizar didev VPN", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            HandleError("No se ha podido completar el alta", ex);
        }
        RefreshStatus();
    }

    private async Task RenewIfDueAsync(bool force = false)
    {
        if (_deviceState is null)
        {
            return;
        }

        try
        {
            var orchestrator = new RenewalOrchestrator(_certificateService, _estClient, _confirmations, _logger, AppVersionHelper.GetAppVersion());
            var result = await orchestrator.RenewIfDueAsync(_deviceState, CancellationToken.None);
            switch (result.Outcome)
            {
                case RenewalOutcome.Renewed:
                    _lastErrorMessage = null;
                    if (force)
                    {
                        MessageBox.Show("Certificado renovado.", "didev VPN", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    break;
                case RenewalOutcome.BlockedByMinAppVersion:
                    _lastErrorMessage = result.Message;
                    ShowBalloon("Hace falta actualizar didev VPN", result.Message ?? string.Empty, ToolTipIcon.Warning);
                    break;
                case RenewalOutcome.NotDue:
                    if (force)
                    {
                        MessageBox.Show("Todavia no toca renovar.", "didev VPN", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            HandleError("No se ha podido comprobar/renovar el certificado", ex);
        }
        RefreshStatus();
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

    private void RemoveFromThisComputer()
    {
        if (_deviceState is null)
        {
            return;
        }

        var confirm = MessageBox.Show(
            $"Se borrara la conexion \"{AppPaths.ConnectionName}\", la configuracion guardada y la tarea de renovacion si existe.\n\n" +
            "?Borrar tambien el certificado del dispositivo de este equipo?",
            "Quitar didev VPN de este equipo",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Warning);
        if (confirm == DialogResult.Cancel)
        {
            return;
        }

        try
        {
            _vpnService.RemoveConnection(AppPaths.ConnectionName);
            _taskScheduler.RemovePerUserRenewalTask(RenewalTaskName);

            if (confirm == DialogResult.Yes)
            {
                using var store = new System.Security.Cryptography.X509Certificates.X509Store(
                    System.Security.Cryptography.X509Certificates.StoreName.My,
                    System.Security.Cryptography.X509Certificates.StoreLocation.CurrentUser);
                store.Open(System.Security.Cryptography.X509Certificates.OpenFlags.ReadWrite);
                var matches = store.Certificates.Find(
                    System.Security.Cryptography.X509Certificates.X509FindType.FindByThumbprint,
                    _deviceState.CertificateThumbprint, validOnly: false);
                foreach (var cert in matches)
                {
                    store.Remove(cert);
                }
            }

            DeviceStateStore.Delete();
            _deviceState = null;
            _logger.Info("Dispositivo eliminado de este equipo.");
        }
        catch (Exception ex)
        {
            HandleError("No se ha podido quitar el dispositivo por completo", ex);
        }
        RefreshStatus();
    }

    private void ShowStatus()
    {
        if (_deviceState is null)
        {
            MessageBox.Show("Todavia no hay ningun dispositivo dado de alta. Usa \"Importar perfil...\".", "didev VPN");
            return;
        }

        var connected = _vpnService.ConnectionExists(AppPaths.ConnectionName) && _vpnService.IsConnected(AppPaths.ConnectionName);
        var ip = connected ? _vpnService.GetAssignedIPv4Address(AppPaths.ConnectionName) : null;
        var lines = new List<string>
        {
            $"Dispositivo: {_deviceState.Cn}",
            $"Servidor: {_deviceState.Server}",
            $"Estado: {(connected ? "Conectado" : "Desconectado")}",
            $"IP asignada: {ip ?? "(no conectado)"}",
            $"Clave: {(_deviceState.IsTpmBacked ? "TPM" : "software")}",
            $"Ultima emision/renovacion: {_deviceState.LastEnrolledAtUtc:u}",
        };
        if (_lastErrorMessage is not null)
        {
            lines.Add("");
            lines.Add($"Ultimo error: {_lastErrorMessage}");
        }
        MessageBox.Show(string.Join(Environment.NewLine, lines), "Estado de didev VPN");
    }

    private void ShowAbout(AppVariant variant, AppVersion version)
    {
        MessageBox.Show(
            $"didev VPN\nVersion: {version}\nVariante: {(variant == AppVariant.Installed ? "instalada (MSI)" : "portable")}",
            "Acerca de didev VPN");
    }

    private void RefreshStatus()
    {
        if (_deviceState is null)
        {
            _notifyIcon.Text = $"{AppPaths.DisplayName} - sin dispositivo";
            return;
        }

        var connected = _vpnService.ConnectionExists(AppPaths.ConnectionName) && _vpnService.IsConnected(AppPaths.ConnectionName);
        var tooltip = $"{AppPaths.DisplayName} - {_deviceState.Cn} - {(connected ? "conectado" : "desconectado")}";
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
        _refreshTimer.Stop();
        _renewalTimer.Stop();
        Application.Exit();
    }
}
