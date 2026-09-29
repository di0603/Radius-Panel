using DidevVpn.App.UI;
using DidevVpn.Core.Profile;

namespace DidevVpn.App.Orchestration;

internal sealed class MessageBoxUserConfirmations : IUserConfirmations
{
    public bool ConfirmTrustAnchor(string server, string cn, FormattedFingerprint panelFingerprint, FormattedFingerprint rootFingerprint)
    {
        using var form = new TrustAnchorConfirmationForm(server, cn, panelFingerprint, rootFingerprint);
        return form.ShowDialog() == DialogResult.OK;
    }

    public bool ConfirmSoftwareKeyFallback(string reason) =>
        MessageBox.Show(
            $"No se ha podido usar el TPM de este equipo para generar la clave del dispositivo ({reason}).\n\n" +
            "Se puede seguir con una clave por software: sigue sin poder exportarse, pero no vive en un chip " +
            "separado del disco.\n\n?Continuar de todas formas?",
            "didev VPN - sin TPM disponible",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2) == DialogResult.Yes;

    public bool ConfirmRootCertificateElevation() =>
        MessageBox.Show(
            "Para confiar en el certificado raiz de este servidor hace falta un permiso de administrador, una sola " +
            "vez (se instala en el almacen de certificados del equipo).\n\nSe pedira confirmacion de Windows (UAC) a continuacion.\n\n" +
            "?Continuar?",
            "didev VPN - permiso de administrador",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Information,
            MessageBoxDefaultButton.Button1) == DialogResult.Yes;
}
