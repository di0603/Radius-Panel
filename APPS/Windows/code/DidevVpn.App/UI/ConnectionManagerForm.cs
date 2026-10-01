using DidevVpn.App.Services;
using DidevVpn.Core.Net;

namespace DidevVpn.App.UI;

/// <summary>
/// Rendimiento (prompt 12.7): el estado (<paramref name="getState"/>) se lee
/// de la cache de ConnectionStateService, nunca lanza PowerShell aqui.
/// RefreshConnections ya NO hace Controls.Clear() + reconstruir todo en cada
/// llamada -eso causaba parpadeo, y encima se llamaba cada 5s-: ahora solo
/// anade/quita filas cuando la LISTA de conexiones cambia, y actualiza en el
/// sitio (mismo Label, solo cambia Text/ForeColor) cuando lo unico que
/// cambia es el estado. Ya no hay temporizador propio: quien construye este
/// formulario (TrayApplicationContext) llama a RefreshConnections cuando
/// ConnectionStateService.StateChanged se dispara (eventos de red +
/// respaldo de 30s, con debounce), no por sondeo propio.
/// </summary>
internal sealed class ConnectionManagerForm : Form
{
    private static readonly Color Accent = Color.FromArgb(0, 137, 123);
    private static readonly Color Canvas = Color.FromArgb(246, 247, 248);
    private static readonly Color Ink = Color.FromArgb(36, 45, 51);
    private static readonly Color Muted = Color.FromArgb(105, 117, 123);
    private static readonly Color ConnectedColor = Color.FromArgb(29, 135, 91);

    private sealed class ConnectionRow
    {
        public required Panel Panel;
        public required Label Name;
        public required Label Server;
        public required Label Status;
    }

    private readonly Func<IReadOnlyList<ConnectionRecord>> _loadConnections;
    private readonly Func<string, ConnectionRuntimeState> _getState;
    private readonly Action _import;
    private readonly Action<string, bool> _toggleConnection;
    private readonly Action<string> _showStatus;
    private readonly Action<string> _removeConnection;
    private readonly Func<string, bool> _isBusy;
    private readonly FlowLayoutPanel _connectionList;
    private readonly Dictionary<string, ConnectionRow> _rows = new(StringComparer.OrdinalIgnoreCase);
    private readonly Panel _emptyState;
    private readonly Panel _selectedView;
    private Label _connectionName = null!;
    private Label _serverName = null!;
    private Label _connectionState = null!;
    private Label _stateMark = null!;
    private Label _serverValue = null!;
    private Label _tunnelValue = null!;
    private Label _keyValue = null!;
    private Label _lastIssuedValue = null!;
    private Button _connectButton = null!;
    private Button _copyButton = null!;
    private string? _selectedCn;
    private bool _refreshing;

    // Panel de detalles (prompt 12.8, punto 3).
    private readonly IConnectionDetailsCollector? _detailsCollector;
    private readonly System.Windows.Forms.Timer _detailsTimer = new() { Interval = 1500 };
    private readonly ToolTip _toolTip = new() { AutoPopDelay = 12000, InitialDelay = 300 };
    private readonly List<Control> _detailControls = new();
    private readonly Dictionary<string, Label> _detailValues = new();
    private ConnectionDetails? _lastDetails;
    private string? _detailsFor;
    private int _collecting;

    public ConnectionManagerForm(
        Func<IReadOnlyList<ConnectionRecord>> loadConnections,
        Func<string, ConnectionRuntimeState> getState,
        Action import,
        Action<string, bool> toggleConnection,
        Action<string> showStatus,
        Action<string> removeConnection,
        Func<string, bool> isBusy,
        IConnectionDetailsCollector? detailsCollector = null)
    {
        _detailsCollector = detailsCollector;
        _loadConnections = loadConnections;
        _getState = getState;
        _import = import;
        _toggleConnection = toggleConnection;
        _showStatus = showStatus;
        _removeConnection = removeConnection;
        _isBusy = isBusy;

        Text = "didev VPN";
        Width = 1000;
        Height = 780;
        MinimumSize = new Size(820, 560);
        DoubleBuffered = true;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Canvas;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 9f);

        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Canvas };
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 292));
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(shell);

        var sidebar = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(35, 48, 54), Padding = new Padding(20, 22, 16, 18) };
        shell.Controls.Add(sidebar, 0, 0);
        var sideLayout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 4, ColumnCount = 1, BackColor = Color.Transparent };
        sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
        sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
        sideLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        sidebar.Controls.Add(sideLayout);

        var brand = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
        brand.Controls.Add(new Label { Text = "D", TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 13f, FontStyle.Bold), ForeColor = Color.White, BackColor = Accent, Bounds = new Rectangle(0, 5, 38, 38) });
        brand.Controls.Add(new Label { Text = "didev VPN", AutoSize = true, Font = new Font("Segoe UI Semibold", 15f, FontStyle.Bold), ForeColor = Color.White, Location = new Point(50, 4) });
        brand.Controls.Add(new Label { Text = "CLIENTE VPN", AutoSize = true, Font = new Font("Segoe UI", 8f), ForeColor = Color.FromArgb(176, 190, 194), Location = new Point(51, 33) });
        sideLayout.Controls.Add(brand, 0, 0);

        sideLayout.Controls.Add(new Label
        {
            Text = "MIS CONEXIONES",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("Segoe UI Semibold", 8.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(176, 190, 194),
        }, 0, 1);

        _connectionList = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            BackColor = Color.Transparent,
            Padding = new Padding(0, 3, 4, 0),
        };
        sideLayout.Controls.Add(_connectionList, 0, 2);

        var importButton = CreateButton("＋   Añadir conexión", Accent, Color.White, 250, 40);
        importButton.Dock = DockStyle.Fill;
        importButton.Margin = new Padding(0, 8, 0, 0);
        importButton.Click += (_, _) => _import();
        sideLayout.Controls.Add(importButton, 0, 3);

        var main = new Panel { Dock = DockStyle.Fill, BackColor = Canvas, Padding = new Padding(28, 20, 28, 22) };
        shell.Controls.Add(main, 1, 0);
        var mainLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, BackColor = Canvas };
        mainLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        mainLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        mainLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 25));
        main.Controls.Add(mainLayout);

        var heading = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
        heading.Controls.Add(new Label { Text = "Conexión VPN", AutoSize = true, Font = new Font("Segoe UI Semibold", 19f, FontStyle.Bold), ForeColor = Ink, Location = new Point(0, 4) });
        heading.Controls.Add(new Label { Text = "Administra tus perfiles y el estado de la conexión", AutoSize = true, Font = new Font("Segoe UI", 9f), ForeColor = Muted, Location = new Point(2, 38) });
        mainLayout.Controls.Add(heading, 0, 0);

        _emptyState = BuildEmptyState();
        _selectedView = BuildSelectedView();
        mainLayout.Controls.Add(_emptyState, 0, 1);
        mainLayout.Controls.Add(_selectedView, 0, 1);

        mainLayout.Controls.Add(new Label
        {
            Text = $"didev VPN  ·  {AppVersionHelper.GetAppVersion()}",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.BottomRight,
            ForeColor = Muted,
            Font = new Font("Segoe UI", 8f),
        }, 0, 2);

        // El sondeo de detalles solo corre con la ventana visible (no minimizada).
        VisibleChanged += (_, _) => UpdateDetailsTimer();
        SizeChanged += (_, _) => UpdateDetailsTimer();
        _detailsTimer.Tick += (_, _) => CollectDetailsNow();

        FormClosing += (_, e) =>
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
        };
        RefreshConnections();
    }

    /// <summary>
    /// Anade/quita filas solo si CAMBIA la lista de conexiones; si solo
    /// cambia el estado (lo normal, en cada evento de ConnectionStateService),
    /// actualiza los Label existentes en el sitio -sin Clear() ni reconstruir
    /// nada-, para que no parpadee.
    /// </summary>
    public void RefreshConnections()
    {
        if (_refreshing) return;
        _refreshing = true;
        try
        {
            var all = _loadConnections().OrderBy(c => c.Cn, StringComparer.OrdinalIgnoreCase).ToList();
            var currentCns = new HashSet<string>(all.Select(c => c.Cn), StringComparer.OrdinalIgnoreCase);

            foreach (var cn in _rows.Keys.Where(cn => !currentCns.Contains(cn)).ToList())
            {
                _connectionList.Controls.Remove(_rows[cn].Panel);
                _rows.Remove(cn);
            }

            if (_selectedCn is not null && !currentCns.Contains(_selectedCn))
            {
                _selectedCn = null;
            }
            if (_selectedCn is null && all.Count > 0)
            {
                _selectedCn = all[0].Cn;
            }

            foreach (var connection in all)
            {
                var state = _getState(connection.Cn);
                var busy = _isBusy(connection.Cn);
                var selected = string.Equals(_selectedCn, connection.Cn, StringComparison.OrdinalIgnoreCase);

                if (_rows.TryGetValue(connection.Cn, out var row))
                {
                    UpdateConnectionRow(row, connection, state, busy, selected);
                }
                else
                {
                    row = BuildConnectionRow(connection, state, busy, selected);
                    _rows[connection.Cn] = row;
                    _connectionList.Controls.Add(row.Panel);
                }
            }

            _emptyState.Visible = all.Count == 0;
            _selectedView.Visible = all.Count > 0;
            if (all.Count == 0)
            {
                _emptyState.BringToFront();
            }
            else
            {
                _selectedView.BringToFront();
                UpdateSelectedDetails();
            }
            UpdateDetailsTimer();
        }
        finally
        {
            _refreshing = false;
        }
    }

    private Panel BuildEmptyState()
    {
        var empty = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(30) };
        empty.Controls.Add(new Label { Text = "Aún no tienes conexiones", AutoSize = true, Font = new Font("Segoe UI Semibold", 17f, FontStyle.Bold), ForeColor = Ink, Location = new Point(30, 50) });
        empty.Controls.Add(new Label { Text = "Añade un perfil para configurar tu acceso VPN.", AutoSize = true, Font = new Font("Segoe UI", 9.5f), ForeColor = Muted, Location = new Point(33, 91) });
        var add = CreateButton("＋   Importar perfil", Accent, Color.White, 175, 42);
        add.Location = new Point(30, 135);
        add.Click += (_, _) => _import();
        empty.Controls.Add(add);
        return empty;
    }

    private Panel BuildSelectedView()
    {
        var view = new Panel { Dock = DockStyle.Fill, BackColor = Canvas, Visible = false };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, BackColor = Canvas, Padding = new Padding(0, 4, 0, 0) };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 132));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 60));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 55));
        view.Controls.Add(layout);

        var statusPanel = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(22, 18, 22, 16) };
        _stateMark = new Label { Text = "●", AutoSize = true, Font = new Font("Segoe UI", 15f), ForeColor = Muted, Location = new Point(20, 20) };
        _connectionState = new Label { AutoSize = true, Font = new Font("Segoe UI Semibold", 10f, FontStyle.Bold), ForeColor = Muted, Location = new Point(46, 23) };
        _connectionName = new Label { AutoSize = true, Font = new Font("Segoe UI Semibold", 19f, FontStyle.Bold), ForeColor = Ink, Location = new Point(20, 53) };
        _serverName = new Label { AutoSize = true, Font = new Font("Segoe UI", 9.5f), ForeColor = Muted, Location = new Point(22, 94) };
        statusPanel.Controls.AddRange(new Control[] { _stateMark, _connectionState, _connectionName, _serverName });
        layout.Controls.Add(statusPanel, 0, 0);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(0, 10, 0, 4), BackColor = Canvas };
        _connectButton = CreateButton("Conectar", Accent, Color.White, 145, 40);
        _connectButton.Click += (_, _) => ToggleSelectedConnection();
        var statusButton = CreateButton("Ver detalles", Color.White, Ink, 130, 40, Color.FromArgb(213, 219, 221));
        statusButton.Click += (_, _) => { if (_selectedCn is not null) _showStatus(_selectedCn); };
        var removeButton = CreateButton("Quitar", Color.White, Color.FromArgb(174, 56, 56), 100, 40, Color.FromArgb(231, 203, 203));
        removeButton.Click += (_, _) => RemoveSelectedConnection();
        _copyButton = CreateButton("Copiar detalles", Color.White, Ink, 150, 40, Color.FromArgb(213, 219, 221));
        _copyButton.Enabled = false;
        _copyButton.Click += (_, _) => CopyDetails();
        actions.Controls.AddRange(new Control[] { _connectButton, statusButton, _copyButton, removeButton });
        layout.Controls.Add(actions, 0, 1);

        var infoPanel = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(22, 12, 22, 12), AutoScroll = true };
        var infoLayout = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, BackColor = Color.White };
        infoLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        infoLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        infoPanel.Controls.Add(infoLayout);
        AddInfoRow(infoLayout, "Servidor", out _serverValue);
        AddInfoRow(infoLayout, "Modo de túnel", out _tunnelValue);
        AddInfoRow(infoLayout, "Protección de clave", out _keyValue);
        AddInfoRow(infoLayout, "Última emisión", out _lastIssuedValue);

        // Detalles de la conexion activa: filas que solo se ven conectada y se
        // actualizan EN EL SITIO (mismo Label), sin reconstruir nada.
        AddDetailHeader(infoLayout, "Detalles de la conexión");
        AddDetailRow(infoLayout, "state", "Estado");
        AddDetailRow(infoLayout, "serverIp", "IP del servidor");
        AddDetailRow(infoLayout, "ipv4", "IPv4 asignada");
        AddDetailRow(infoLayout, "gateway", "Puerta de enlace ⓘ", ConnectionDetailsText.PointToPointHelp);
        AddDetailRow(infoLayout, "dns", "DNS recibidos");
        AddDetailRow(infoLayout, "tunnel", "Túnel (rutas reales)");
        AddDetailRow(infoLayout, "mtu", "MTU de la interfaz");
        AddDetailRow(infoLayout, "traffic", "Tráfico (enviado / recibido)");
        AddDetailRow(infoLayout, "speed", "Velocidad (subida / bajada)");
        AddDetailRow(infoLayout, "cert", "Certificado");
        AddDetailRow(infoLayout, "issuer", "Emisor");
        AddDetailRow(infoLayout, "keyProvider", "Proveedor de la clave");
        SetDetailsVisible(false);
        layout.Controls.Add(infoPanel, 0, 2);
        layout.Controls.Add(new Label
        {
            Text = "La identidad del servidor se verifica en cada conexión y renovación.",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Muted,
            Font = new Font("Segoe UI", 8.5f),
        }, 0, 3);
        return view;
    }

    private ConnectionRow BuildConnectionRow(ConnectionRecord connection, ConnectionRuntimeState state, bool busy, bool selected)
    {
        var row = new Panel
        {
            Width = 236,
            Height = 72,
            Margin = new Padding(0, 0, 0, 8),
            Cursor = Cursors.Hand,
        };
        var name = new Label { AutoEllipsis = true, Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold), Location = new Point(12, 7), Size = new Size(215, 21), Cursor = Cursors.Hand };
        var server = new Label { AutoEllipsis = true, Font = new Font("Segoe UI", 8f), ForeColor = Color.FromArgb(188, 200, 203), Location = new Point(12, 29), Size = new Size(215, 17), Cursor = Cursors.Hand };
        var status = new Label { AutoSize = true, Font = new Font("Segoe UI", 7.5f, FontStyle.Bold), Location = new Point(12, 50), Cursor = Cursors.Hand };
        void Select(object? _, EventArgs __) => SelectConnection(connection.Cn);
        row.Click += Select;
        name.Click += Select;
        server.Click += Select;
        status.Click += Select;
        row.Controls.AddRange(new Control[] { name, server, status });

        var result = new ConnectionRow { Panel = row, Name = name, Server = server, Status = status };
        UpdateConnectionRow(result, connection, state, busy, selected);
        return result;
    }

    private static void UpdateConnectionRow(ConnectionRow row, ConnectionRecord connection, ConnectionRuntimeState state, bool busy, bool selected)
    {
        row.Panel.BackColor = selected ? Color.FromArgb(54, 70, 76) : Color.FromArgb(42, 57, 63);
        row.Name.Text = connection.Cn;
        row.Name.ForeColor = Color.White;
        row.Server.Text = connection.Server;
        if (busy)
        {
            row.Status.Text = "◐ Trabajando...";
            row.Status.ForeColor = Color.FromArgb(230, 200, 110);
        }
        else if (state.Connecting)
        {
            row.Status.Text = "◐ Conectando...";
            row.Status.ForeColor = Color.FromArgb(230, 200, 110);
        }
        else
        {
            row.Status.Text = state.Connected ? "● Conectado" : "● Desconectado";
            row.Status.ForeColor = state.Connected ? Color.FromArgb(110, 220, 170) : Color.FromArgb(180, 193, 196);
        }
    }

    private void SelectConnection(string cn)
    {
        _selectedCn = cn;
        _lastDetails = null;
        _detailsTimer.Stop(); // otra conexion: UpdateDetailsTimer rearranca el sondeo si procede
        UpdateSelectedDetails();
        RefreshConnections();
    }

    private void UpdateSelectedDetails()
    {
        if (_selectedCn is null)
        {
            return;
        }
        var connection = _loadConnections().FirstOrDefault(c => string.Equals(c.Cn, _selectedCn, StringComparison.OrdinalIgnoreCase));
        if (connection is null)
        {
            return;
        }

        var state = _getState(connection.Cn);
        var busy = _isBusy(connection.Cn);
        _connectionName.Text = connection.Cn;
        _serverName.Text = connection.Server;
        _serverValue.Text = connection.Server;
        var inProgress = busy || state.Connecting;
        _connectionState.Text = busy ? "Trabajando..." : state.Connecting ? "Conectando..." : state.Connected ? "Conectado" : "Desconectado";
        _connectionState.ForeColor = inProgress ? Color.FromArgb(200, 160, 40) : state.Connected ? ConnectedColor : Muted;
        _stateMark.ForeColor = inProgress ? Color.FromArgb(200, 160, 40) : state.Connected ? ConnectedColor : Color.FromArgb(144, 155, 160);
        _connectButton.Text = busy ? "Trabajando..." : state.Connected ? "Desconectar" : "Conectar";
        _connectButton.Enabled = !busy;
        _tunnelValue.Text = connection.TunnelMode.Equals("split", StringComparison.OrdinalIgnoreCase) ? "Túnel dividido" : "Túnel completo";
        _keyValue.Text = connection.IsTpmBacked ? "Protegida por TPM" : "Almacenamiento seguro del sistema";
        _lastIssuedValue.Text = connection.LastEnrolledAtUtc.ToLocalTime().ToString("dd/MM/yyyy HH:mm");
    }

    private void ToggleSelectedConnection()
    {
        if (_selectedCn is null || _isBusy(_selectedCn))
        {
            return;
        }
        _toggleConnection(_selectedCn, _getState(_selectedCn).Connected);
        RefreshConnections();
    }

    private void RemoveSelectedConnection()
    {
        if (_selectedCn is null)
        {
            return;
        }
        var cn = _selectedCn;
        _removeConnection(cn);
        _selectedCn = null;
        RefreshConnections();
    }

    private static Button CreateButton(string text, Color back, Color fore, int width, int height, Color? border = null)
    {
        var button = new Button
        {
            Text = text,
            Width = width,
            Height = height,
            BackColor = back,
            ForeColor = fore,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold),
            Cursor = Cursors.Hand,
            UseVisualStyleBackColor = false,
        };
        button.FlatAppearance.BorderColor = border ?? back;
        button.FlatAppearance.BorderSize = border.HasValue ? 1 : 0;
        button.FlatAppearance.MouseOverBackColor = ControlPaint.Light(back, 0.08f);
        return button;
    }

    private static void AddInfoRow(TableLayoutPanel layout, string caption, out Label value)
    {
        var row = layout.RowCount++;
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(MakeCaption(caption), 0, row);
        value = MakeValue();
        layout.Controls.Add(value, 1, row);
    }

    private void AddDetailHeader(TableLayoutPanel layout, string text)
    {
        var row = layout.RowCount++;
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var header = new Label
        {
            Text = text.ToUpperInvariant(),
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 8.5f, FontStyle.Bold),
            ForeColor = Accent,
            Margin = new Padding(0, 12, 0, 2),
            Anchor = AnchorStyles.Left,
        };
        layout.Controls.Add(header, 0, row);
        layout.SetColumnSpan(header, 2);
        _detailControls.Add(header);
    }

    private void AddDetailRow(TableLayoutPanel layout, string key, string caption, string? help = null)
    {
        var row = layout.RowCount++;
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var captionLabel = MakeCaption(caption);
        var value = MakeValue();
        value.MaximumSize = new Size(560, 0); // se parte en varias lineas (lista de rutas) en vez de salirse
        layout.Controls.Add(captionLabel, 0, row);
        layout.Controls.Add(value, 1, row);
        if (help is not null)
        {
            _toolTip.SetToolTip(captionLabel, help);
            _toolTip.SetToolTip(value, help);
        }
        _detailControls.Add(captionLabel);
        _detailControls.Add(value);
        _detailValues[key] = value;
    }

    private static Label MakeCaption(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Anchor = AnchorStyles.Left | AnchorStyles.Top,
        ForeColor = Muted,
        Font = new Font("Segoe UI", 9f),
        Margin = new Padding(0, 3, 8, 3),
    };

    private static Label MakeValue() => new()
    {
        AutoSize = true,
        Anchor = AnchorStyles.Left | AnchorStyles.Top,
        ForeColor = Ink,
        Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold),
        Margin = new Padding(0, 3, 0, 3),
    };

    private void SetDetailsVisible(bool visible)
    {
        foreach (var control in _detailControls)
        {
            if (control.Visible != visible)
            {
                control.Visible = visible;
            }
        }
    }

    /// <summary>El Label solo se toca si el texto cambia: sin parpadeo.</summary>
    private static void SetText(Label label, string text)
    {
        if (!string.Equals(label.Text, text, StringComparison.Ordinal))
        {
            label.Text = text;
        }
    }

    /// <summary>Sondeo cada 1,5 s SOLO con la ventana visible (no oculta ni minimizada) y la conexion seleccionada conectada.</summary>
    private void UpdateDetailsTimer()
    {
        var connected = _selectedCn is not null && _getState(_selectedCn).Connected;
        var want = _detailsCollector is not null && connected && Visible && WindowState != FormWindowState.Minimized;

        if (want)
        {
            if (!_detailsTimer.Enabled)
            {
                _detailsTimer.Start();
                CollectDetailsNow();
            }
            return;
        }

        _detailsTimer.Stop();
        if (_detailsFor is not null)
        {
            _detailsCollector?.Forget(_detailsFor);
            _detailsFor = null;
        }
        _lastDetails = null;
        _copyButton.Enabled = false;
        SetDetailsVisible(false);
    }

    private void CollectDetailsNow()
    {
        if (_detailsCollector is null || _selectedCn is null || Interlocked.Exchange(ref _collecting, 1) == 1)
        {
            return;
        }

        var cn = _selectedCn;
        var record = _loadConnections().FirstOrDefault(c => string.Equals(c.Cn, cn, StringComparison.OrdinalIgnoreCase));
        var state = _getState(cn);
        if (record is null || !state.Connected)
        {
            Interlocked.Exchange(ref _collecting, 0);
            return;
        }

        _ = Task.Run(() =>
        {
            try
            {
                return _detailsCollector.Collect(record, state);
            }
            catch
            {
                return null;
            }
        }).ContinueWith(task =>
        {
            Interlocked.Exchange(ref _collecting, 0);
            var details = task.Status == TaskStatus.RanToCompletion ? task.Result : null;
            if (details is null || IsDisposed || !IsHandleCreated)
            {
                return;
            }
            try
            {
                BeginInvoke(() => ApplyDetails(cn, details));
            }
            catch (InvalidOperationException)
            {
                // la ventana se cerro mientras tanto
            }
        }, TaskScheduler.Default);
    }

    private void ApplyDetails(string cn, ConnectionDetails details)
    {
        if (!string.Equals(_selectedCn, cn, StringComparison.OrdinalIgnoreCase) || !_detailsTimer.Enabled)
        {
            return;
        }

        _lastDetails = details;
        _detailsFor = cn;
        _copyButton.Enabled = true;
        SetDetailsVisible(true);

        SetText(_detailValues["state"], details.ConnectedFor is { } span
            ? $"Conectado · {TrafficFormatter.FormatDuration(span)}" + (details.ConnectedSince is { } since ? $"  (desde {since.ToLocalTime():dd/MM HH:mm})" : "")
            : "Conectado");
        SetText(_detailValues["serverIp"], details.ServerIp ?? "(sin resolver)");
        SetText(_detailValues["ipv4"], details.Ipv4Address is null ? "-" : details.SubnetMask is null ? details.Ipv4Address : $"{details.Ipv4Address} / {details.SubnetMask}");
        SetText(_detailValues["gateway"], ConnectionDetailsText.Gateway(details));
        SetText(_detailValues["dns"], details.DnsServers.Count == 0 ? "-" : string.Join(", ", details.DnsServers));
        SetText(_detailValues["tunnel"], ConnectionDetailsText.TunnelDescription(details));
        SetText(_detailValues["mtu"], details.Mtu?.ToString() ?? "-");
        SetText(_detailValues["traffic"], $"↑ {TrafficFormatter.FormatBytes(details.BytesSent)}    ↓ {TrafficFormatter.FormatBytes(details.BytesReceived)}");
        SetText(_detailValues["speed"], $"↑ {TrafficFormatter.FormatSpeed(details.UploadBytesPerSecond)}    ↓ {TrafficFormatter.FormatSpeed(details.DownloadBytesPerSecond)}");
        SetText(_detailValues["cert"], details.Certificate is { } cert ? $"{cert.CommonName} · caduca {cert.NotAfter.ToLocalTime():dd/MM/yyyy}" : "-");
        SetText(_detailValues["issuer"], details.Certificate?.Issuer ?? "-");
        SetText(_detailValues["keyProvider"], details.Certificate is { } c ? (c.IsTpm ? $"{c.KeyProvider} (TPM)" : c.KeyProvider) : "-");
    }

    private void CopyDetails()
    {
        if (_lastDetails is null)
        {
            return;
        }
        try
        {
            Clipboard.SetText(ConnectionDetailsText.Build(_lastDetails));
        }
        catch (System.Runtime.InteropServices.ExternalException)
        {
            // el portapapeles puede estar ocupado por otra app: el usuario puede reintentar
        }
    }
}
