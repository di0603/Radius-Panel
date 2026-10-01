using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>Aviso de certificados candidatos (punto 5c del 12.9): sin tocar el almacen real, con certificados en memoria.</summary>
public class CertificateCandidatesTests
{
    private static (X509Certificate2 Cert, X509Certificate2 Ca) Ca(string name)
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={name}", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        var now = DateTimeOffset.UtcNow;
        var cert = request.CreateSelfSigned(now.AddDays(-1), now.AddDays(300));
        return (cert, cert);
    }

    private static X509Certificate2 Leaf(X509Certificate2 ca, string cn, bool clientAuth = true, int validDays = 20, int startDays = -1, bool withKey = true)
    {
        using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={cn}", leafKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new Oid(clientAuth ? "1.3.6.1.5.5.7.3.2" : "1.3.6.1.5.5.7.3.1") }, true));
        var now = DateTimeOffset.UtcNow;
        using var caKey = ca.GetECDsaPrivateKey()!;
        using var signed = request.Create(ca.SubjectName, X509SignatureGenerator.CreateForECDsa(caKey),
            now.AddDays(startDays), now.AddDays(startDays + validDays), RandomNumberGenerator.GetBytes(12));
        return withKey ? signed.CopyWithPrivateKey(leafKey) : new X509Certificate2(signed.RawData);
    }

    [Fact]
    public void OnlyOneCertificate_IsNotAmbiguous()
    {
        var (ca, _) = Ca("CA-1");
        var mine = Leaf(ca, "vpn-a");

        var report = CertificateCandidates.Check(mine.Thumbprint, new[] { mine }, DateTimeOffset.UtcNow)!;

        Assert.False(report.IsAmbiguous);
        Assert.Single(report.Candidates);
    }

    [Fact]
    public void TwoClientCertificatesOfTheSameIssuer_AreAmbiguous_AndTheWarningListsThemWithHowToRemove()
    {
        var (ca, _) = Ca("VPN Intermediate CA");
        var mine = Leaf(ca, "vpn-diego-portatil-hp");
        var other = Leaf(ca, "vpn-diego-prueba", validDays: 5);

        var report = CertificateCandidates.Check(mine.Thumbprint, new[] { mine, other }, DateTimeOffset.UtcNow)!;
        var warning = report.BuildWarning("vpn-diego-portatil-hp");

        Assert.True(report.IsAmbiguous);
        Assert.Contains("vpn-diego-prueba", warning);
        Assert.Contains("vpn-diego-portatil-hp", warning);
        Assert.Contains("(el de esta conexion)", warning);
        Assert.Contains("certmgr.msc", warning);
        Assert.Contains("VPN Intermediate CA", warning);
        Assert.DoesNotContain(mine.Thumbprint, warning); // sin huellas en el aviso
    }

    [Fact]
    public void CertificatesFromAnotherIssuer_ExpiredOnes_WithoutKey_OrWithoutClientAuth_AreNotCandidates()
    {
        var (ca, _) = Ca("CA-main");
        var (otherCa, _) = Ca("CA-other");
        var mine = Leaf(ca, "vpn-a");
        var store = new List<X509Certificate2>
        {
            mine,
            Leaf(otherCa, "otro-emisor"),
            Leaf(ca, "caducado", validDays: 2, startDays: -10),
            Leaf(ca, "sin-clave", withKey: false),
            Leaf(ca, "solo-servidor", clientAuth: false),
        };

        var report = CertificateCandidates.Check(mine.Thumbprint, store, DateTimeOffset.UtcNow)!;

        Assert.Single(report.Candidates);
        Assert.Equal("vpn-a", report.Candidates[0].CommonName);
    }

    [Fact]
    public void ConnectionCertificateMissingFromTheStore_CannotBeChecked()
    {
        var (ca, _) = Ca("CA-1");

        Assert.Null(CertificateCandidates.Check("0000", new[] { Leaf(ca, "x") }, DateTimeOffset.UtcNow));
    }
}
