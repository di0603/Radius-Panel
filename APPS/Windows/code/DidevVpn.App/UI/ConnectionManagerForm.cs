using DidevVpn.App.Services;

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
    private string? _selectedCn;
    private bool _refreshing;

    public ConnectionManagerForm(
        Func<IReadOnlyList<ConnectionRecord>> loadConnections,
        Func<string, ConnectionRuntimeState> getState,
        Action import,
        Action<string, bool> toggleConnection,
        Action<string> showStatus,
        Action<string> removeConnection,
        Func<string, bool> isBusy)
    {
        _loadConnections = loadConnections;
        _getState = getState;
        _import = import;
        _toggleConnection = toggleConnection;
        _showStatus = showStatus;
        _removeConnection = removeConnection;
        _isBusy = isBusy;

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
        statusButton.Click += (_, _) => { if (_selectedCn is not null) _showStatus(_selectedCn); };
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

    private ConnectionRow BuildConnectionRow(ConnectionRecord connection, ConnectionRuntimeState state, bool busy, bool selected)
    {
        var row = new Panel
        {
            Width = 248,
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
        else
        {
            row.Status.Text = state.Connected ? "● Conectado" : "● Desconectado";
            row.Status.ForeColor = state.Connected ? Color.FromArgb(110, 220, 170) : Color.FromArgb(180, 193, 196);
        }
    }

    private void SelectConnection(string cn)
    {
        _selectedCn = cn;
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
        _connectionState.Text = busy ? "Trabajando..." : state.Connected ? "Conectado" : "Desconectado";
        _connectionState.ForeColor = busy ? Color.FromArgb(200, 160, 40) : state.Connected ? ConnectedColor : Muted;
        _stateMark.ForeColor = busy ? Color.FromArgb(200, 160, 40) : state.Connected ? ConnectedColor : Color.FromArgb(144, 155, 160);
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

    private static void AddInfoRow(TableLayoutPanel layout, int row, string caption, out Label value)
    {
        layout.Controls.Add(new Label { Text = caption, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Muted, Font = new Font("Segoe UI", 9f) }, 0, row);
        value = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Ink, Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold), AutoEllipsis = true };
        layout.Controls.Add(value, 1, row);
    }
}
