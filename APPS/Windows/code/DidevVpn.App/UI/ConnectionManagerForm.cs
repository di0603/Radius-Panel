using DidevVpn.App.Services;

namespace DidevVpn.App.UI;

internal sealed class ConnectionManagerForm : Form
{
    private static readonly Color Accent = Color.FromArgb(0, 137, 123);
    private static readonly Color Canvas = Color.FromArgb(246, 247, 248);
    private static readonly Color Ink = Color.FromArgb(36, 45, 51);
    private static readonly Color Muted = Color.FromArgb(105, 117, 123);
    private static readonly Color ConnectedColor = Color.FromArgb(29, 135, 91);

    private readonly Func<IReadOnlyList<ConnectionRecord>> _loadConnections;
    private readonly Func<string, bool> _isConnected;
    private readonly Action _import;
    private readonly Action<string, bool> _toggleConnection;
    private readonly Action<string> _showStatus;
    private readonly Action<string> _removeConnection;
    private readonly FlowLayoutPanel _connectionList;
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
    private ConnectionRecord? _selected;
    private bool _refreshing;

    public ConnectionManagerForm(
        Func<IReadOnlyList<ConnectionRecord>> loadConnections,
        Func<string, bool> isConnected,
        Action import,
        Action<string, bool> toggleConnection,
        Action<string> showStatus,
        Action<string> removeConnection)
    {
        _loadConnections = loadConnections;
        _isConnected = isConnected;
        _import = import;
        _toggleConnection = toggleConnection;
        _showStatus = showStatus;
        _removeConnection = removeConnection;

        Text = "didev VPN";
        Width = 1000;
        Height = 650;
        MinimumSize = new Size(820, 520);
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

        var refreshTimer = new System.Windows.Forms.Timer { Interval = 5000 };
        refreshTimer.Tick += (_, _) => RefreshConnections();
        refreshTimer.Start();
        FormClosed += (_, _) => refreshTimer.Dispose();
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

    public void RefreshConnections()
    {
        if (_refreshing) return;
        _refreshing = true;
        try
        {
            var all = _loadConnections().OrderBy(c => c.Cn, StringComparer.OrdinalIgnoreCase).ToList();
            var previousCn = _selected?.Cn;
            _selected = previousCn is null ? null : all.FirstOrDefault(c => string.Equals(c.Cn, previousCn, StringComparison.OrdinalIgnoreCase));

            _connectionList.SuspendLayout();
            _connectionList.Controls.Clear();
            foreach (var connection in all)
            {
                var connected = _isConnected(connection.Cn);
                var selected = _selected is not null && string.Equals(_selected.Cn, connection.Cn, StringComparison.OrdinalIgnoreCase);
                _connectionList.Controls.Add(BuildConnectionRow(connection, connected, selected));
            }
            _connectionList.ResumeLayout();

            if (_selected is null && all.Count > 0) _selected = all[0];
            _emptyState.Visible = all.Count == 0;
            _selectedView.Visible = all.Count > 0;
            if (all.Count == 0) _emptyState.BringToFront();
            else
            {
                _selectedView.BringToFront();
                UpdateSelectedDetails();
            }
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
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 152));
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
        statusButton.Click += (_, _) => { if (_selected is not null) _showStatus(_selected.Cn); };
        var removeButton = CreateButton("Quitar", Color.White, Color.FromArgb(174, 56, 56), 100, 40, Color.FromArgb(231, 203, 203));
        removeButton.Click += (_, _) => RemoveSelectedConnection();
        actions.Controls.AddRange(new Control[] { _connectButton, statusButton, removeButton });
        layout.Controls.Add(actions, 0, 1);

        var infoPanel = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(22, 16, 22, 14) };
        var infoLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 4, BackColor = Color.White };
        infoLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 35));
        infoLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 65));
        for (var i = 0; i < 4; i++) infoLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 25));
        infoPanel.Controls.Add(infoLayout);
        AddInfoRow(infoLayout, 0, "Servidor", out _serverValue);
        AddInfoRow(infoLayout, 1, "Modo de túnel", out _tunnelValue);
        AddInfoRow(infoLayout, 2, "Protección de clave", out _keyValue);
        AddInfoRow(infoLayout, 3, "Última emisión", out _lastIssuedValue);
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

    private Panel BuildConnectionRow(ConnectionRecord connection, bool connected, bool selected)
    {
        var row = new Panel
        {
            Width = 248,
            Height = 72,
            Margin = new Padding(0, 0, 0, 8),
            BackColor = selected ? Color.FromArgb(54, 70, 76) : Color.FromArgb(42, 57, 63),
            Cursor = Cursors.Hand,
        };
        var name = new Label { Text = connection.Cn, AutoEllipsis = true, Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold), ForeColor = Color.White, Location = new Point(12, 7), Size = new Size(215, 21), Cursor = Cursors.Hand };
        var server = new Label { Text = connection.Server, AutoEllipsis = true, Font = new Font("Segoe UI", 8f), ForeColor = Color.FromArgb(188, 200, 203), Location = new Point(12, 29), Size = new Size(215, 17), Cursor = Cursors.Hand };
        var status = new Label { Text = connected ? "● Conectado" : "● Desconectado", AutoSize = true, Font = new Font("Segoe UI", 7.5f, FontStyle.Bold), ForeColor = connected ? Color.FromArgb(110, 220, 170) : Color.FromArgb(180, 193, 196), Location = new Point(12, 50), Cursor = Cursors.Hand };
        void Select(object? _, EventArgs __) => SelectConnection(connection);
        row.Click += Select;
        name.Click += Select;
        server.Click += Select;
        status.Click += Select;
        row.Controls.AddRange(new Control[] { name, server, status });
        return row;
    }

    private void SelectConnection(ConnectionRecord connection)
    {
        _selected = connection;
        UpdateSelectedDetails();
        if (!_refreshing) RefreshConnections();
    }

    private void UpdateSelectedDetails()
    {
        if (_selected is null) return;
        var connected = _isConnected(_selected.Cn);
        _connectionName.Text = _selected.Cn;
        _serverName.Text = _selected.Server;
        _serverValue.Text = _selected.Server;
        _connectionState.Text = connected ? "Conectado" : "Desconectado";
        _connectionState.ForeColor = connected ? ConnectedColor : Muted;
        _stateMark.ForeColor = connected ? ConnectedColor : Color.FromArgb(144, 155, 160);
        _connectButton.Text = connected ? "Desconectar" : "Conectar";
        _tunnelValue.Text = _selected.TunnelMode.Equals("split", StringComparison.OrdinalIgnoreCase) ? "Túnel dividido" : "Túnel completo";
        _keyValue.Text = _selected.IsTpmBacked ? "Protegida por TPM" : "Almacenamiento seguro del sistema";
        _lastIssuedValue.Text = _selected.LastEnrolledAtUtc.ToLocalTime().ToString("dd/MM/yyyy HH:mm");
    }

    private void ToggleSelectedConnection()
    {
        if (_selected is null) return;
        _toggleConnection(_selected.Cn, _isConnected(_selected.Cn));
        RefreshConnections();
    }

    private void RemoveSelectedConnection()
    {
        if (_selected is null) return;
        var cn = _selected.Cn;
        _removeConnection(cn);
        _selected = null;
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

    private static void AddInfoRow(TableLayoutPanel layout, int row, string caption, out Label value)
    {
        layout.Controls.Add(new Label { Text = caption, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Muted, Font = new Font("Segoe UI", 9f) }, 0, row);
        value = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Ink, Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold), AutoEllipsis = true };
        layout.Controls.Add(value, 1, row);
    }
}
