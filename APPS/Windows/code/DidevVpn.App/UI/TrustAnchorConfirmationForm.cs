using DidevVpn.Core.Profile;

namespace DidevVpn.App.UI;

/// <summary>
/// Confianza en el primer uso (TOFU, prompt 12.5): se muestra la UNICA vez
/// que se importa un perfil para una conexion nueva (sin ancla guardada
/// todavia). El "codigo corto" va grande y en negrita para comparar de un
/// vistazo con lo que ensena el panel; la huella completa va debajo, mas
/// pequena, por si hiciera falta verificar del todo. Construido en codigo
/// (sin .Designer.cs/.resx), igual que ImportProfileForm.
/// </summary>
internal sealed class TrustAnchorConfirmationForm : Form
{
    public TrustAnchorConfirmationForm(string server, string cn, FormattedFingerprint panelFingerprint, FormattedFingerprint rootFingerprint)
    {
        Text = "Confirmar servidor nuevo";
        Width = 520;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            Padding = new Padding(16),
            AutoSize = true,
        };

        void AddLabel(string text, float fontSize = 9f, bool bold = false, int topMargin = 0)
        {
            layout.Controls.Add(new Label
            {
                Text = text,
                AutoSize = true,
                MaximumSize = new Size(470, 0),
                Font = new Font(Font.FontFamily, fontSize, bold ? FontStyle.Bold : FontStyle.Regular),
                Margin = new Padding(0, topMargin, 0, 4),
            });
        }

        void AddMonospace(string text, float fontSize, bool bold)
        {
            layout.Controls.Add(new Label
            {
                Text = text,
                AutoSize = true,
                MaximumSize = new Size(470, 0),
                Font = new Font("Consolas", fontSize, bold ? FontStyle.Bold : FontStyle.Regular),
                Margin = new Padding(0, 0, 0, 4),
            });
        }

        AddLabel($"Es la primera vez que se conecta al servidor \"{server}\" ({cn}).", 10f, bold: true);
        AddLabel(
            "Compara estas huellas con las que muestra el panel (junto al QR/fichero, o en VPN > Ajustes). " +
            "Si no coinciden, cancela: no confies en este servidor.",
            9f, bold: false, topMargin: 8);

        AddLabel("Huella del panel", 9f, bold: true, topMargin: 12);
        AddMonospace(panelFingerprint.Short, 15f, bold: true);
        AddMonospace(panelFingerprint.Full, 8f, bold: false);

        AddLabel("Huella de la raiz", 9f, bold: true, topMargin: 8);
        AddMonospace(rootFingerprint.Short, 15f, bold: true);
        AddMonospace(rootFingerprint.Full, 8f, bold: false);

        var buttonPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            Height = 44,
            Padding = new Padding(8),
        };
        var cancelButton = new Button { Text = "Cancelar", DialogResult = DialogResult.Cancel, AutoSize = true };
        var confirmButton = new Button { Text = "Coinciden: confiar y continuar", DialogResult = DialogResult.OK, AutoSize = true };
        buttonPanel.Controls.Add(cancelButton);
        buttonPanel.Controls.Add(confirmButton);

        var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        scroll.Controls.Add(layout);

        Controls.Add(scroll);
        Controls.Add(buttonPanel);

        AcceptButton = confirmButton;
        CancelButton = cancelButton;
    }
}
