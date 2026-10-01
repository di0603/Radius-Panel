using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;
using DidevVpn.App.Services.Ras;

namespace DidevVpn.App.Tests;

/// <summary>ConnectionConfigurationCheck.EnsureConfigured (prompt 12.12, punto 2): la entrada existe Y las credenciales guardadas son las del certificado NUEVO.</summary>
public class ConnectionConfigurationCheckTests
{
    private sealed class StubVpn : IVpnConnectionService
    {
        public bool Exists = true;
        public string? Saved;

        public bool ConnectionExists(string connectionName) => Exists;
        public string? GetSavedEapCertificateThumbprint(string connectionName) => Saved;

        public void CreateOrUpdateConnection(VpnConnectionSpec spec) => throw new NotSupportedException();
        public void RemoveConnection(string connectionName) => throw new NotSupportedException();
        public bool IsConnected(string connectionName) => throw new NotSupportedException();
        public void SaveEapCredentials(string connectionName, X509Certificate2 certificate) => throw new NotSupportedException();
        public void Connect(string connectionName) => throw new NotSupportedException();
        public void Disconnect(string connectionName) => throw new NotSupportedException();
        public RasPhaseInfo GetConnectionPhase(string connectionName) => throw new NotSupportedException();
        public string? GetAssignedIPv4Address(string connectionName) => throw new NotSupportedException();
    }

    private const string NewThumbprint = "1111111111111111111111111111111111111111";

    [Fact]
    public void EntryExistsAndCredentialsAreForTheNewCertificate_DoesNotThrow()
    {
        ConnectionConfigurationCheck.EnsureConfigured(new StubVpn { Saved = NewThumbprint }, "vpn-x", NewThumbprint);
    }

    [Fact]
    public void ThumbprintComparisonIgnoresCase()
    {
        ConnectionConfigurationCheck.EnsureConfigured(new StubVpn { Saved = "abcdef" }, "vpn-x", "ABCDEF");
    }

    [Fact]
    public void CredentialsOfAnotherCertificate_Throws_AndTheMessageSaysSo()
    {
        var vpn = new StubVpn { Saved = "2222222222222222222222222222222222222222" };

        var ex = Assert.Throws<InvalidOperationException>(() => ConnectionConfigurationCheck.EnsureConfigured(vpn, "vpn-x", NewThumbprint));

        Assert.Contains("OTRO certificado", ex.Message);
        Assert.Contains("conserva el certificado anterior", ex.Message);
    }

    [Fact]
    public void NoSavedCredentials_Throws()
    {
        Assert.Throws<InvalidOperationException>(() => ConnectionConfigurationCheck.EnsureConfigured(new StubVpn { Saved = null }, "vpn-x", NewThumbprint));
    }

    [Fact]
    public void EntryMissing_Throws_BeforeLookingAtTheCredentials()
    {
        var ex = Assert.Throws<InvalidOperationException>(() =>
            ConnectionConfigurationCheck.EnsureConfigured(new StubVpn { Exists = false, Saved = NewThumbprint }, "vpn-x", NewThumbprint));

        Assert.Contains("no existe", ex.Message);
    }
}
