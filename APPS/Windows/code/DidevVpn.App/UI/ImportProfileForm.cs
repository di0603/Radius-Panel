namespace DidevVpn.App.UI;

/// <summary>
/// Importar el perfil: pegar el texto (util si llega por otro canal, p.ej.
/// copiado de un chat) o elegir el fichero .didevvpn descargado del panel.
/// Construido en codigo (sin .Designer.cs/.resx): es un formulario pequeno y
/// no hace falta el editor visual para mantenerlo.
/// </summary>
internal sealed class ImportProfileForm : Form
{
    private readonly TextBox _textBox;

    public string? EnvelopeJson { get; private set; }

    public ImportProfileForm()
    {
        Text = "Importar perfil de aprovisionamiento";
        Width = 560;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        var label = new Label
        {
            Text = "Pega aqui el contenido del fichero .didevvpn, o pulsa \"Abrir fichero...\":",
            Dock = DockStyle.Top,
            Height = 32,
            Padding = new Padding(8, 8, 8, 0),
        };

        _textBox = new TextBox
        {
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            Dock = DockStyle.Fill,
            Font = new Font("Consolas", 9f),
            AcceptsReturn = true,
        };

        var openButton = new Button { Text = "Abrir fichero...", AutoSize = true };
        openButton.Click += (_, _) => OpenFile();

        var okButton = new Button { Text = "Importar", DialogResult = DialogResult.OK, AutoSize = true };
        okButton.Click += (_, _) => EnvelopeJson = _textBox.Text.Trim();

        var cancelButton = new Button { Text = "Cancelar", DialogResult = DialogResult.Cancel, AutoSize = true };

        var buttonPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            Height = 44,
            Padding = new Padding(8),
        };
        buttonPanel.Controls.Add(cancelButton);
        buttonPanel.Controls.Add(okButton);
        buttonPanel.Controls.Add(openButton);

        Controls.Add(_textBox);
        Controls.Add(buttonPanel);
        Controls.Add(label);

        AcceptButton = okButton;
        CancelButton = cancelButton;
    }

    private void OpenFile()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Elegir el perfil .didevvpn",
            Filter = "Perfil didev VPN (*.didevvpn)|*.didevvpn|Todos los ficheros (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _textBox.Text = File.ReadAllText(dialog.FileName);
        }
    }
}
