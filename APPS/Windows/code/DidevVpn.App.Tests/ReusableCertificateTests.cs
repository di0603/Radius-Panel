using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using DidevVpn.App.Orchestration;

namespace DidevVpn.App.Tests;

/// <summary>
/// Reintento del alta tras un fallo posterior a simpleenroll (prompt 12.8,
/// item 3): que certificado de CurrentUser\My se puede reutilizar sin gastar
/// un token nuevo.
/// </summary>
public class ReusableCertificateTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UtcNow;

    private sealed class Pki : IDisposable
    {
        public X509Certificate2 Root { get; }
        public X509Certificate2 Intermediate { get; }
        public X509Certificate2Collection Chain { get; }
        private readonly List<IDisposable> _disposables = new();

        public Pki(string intermediateName = "Test Intermediate")
        {
            var rootKey = ECDsa.Create(ECCurve.NamedCurves.nistP384);
            _disposables.Add(rootKey);
            var rootReq = new CertificateRequest("CN=Test Root", rootKey, HashAlgorithmName.SHA384);
            rootReq.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
            Root = rootReq.CreateSelfSigned(Now.AddDays(-200), Now.AddDays(300));

            var intKey = ECDsa.Create(ECCurve.NamedCurves.nistP384);
            _disposables.Add(intKey);
            var intReq = new CertificateRequest($"CN={intermediateName}", intKey, HashAlgorithmName.SHA384);
            intReq.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
            using var intPublic = intReq.Create(Root, Now.AddDays(-100), Now.AddDays(200), new byte[] { 1 });
            Intermediate = intPublic.CopyWithPrivateKey(intKey);

            Chain = new X509Certificate2Collection { Intermediate, Root };
        }

        public X509Certificate2 Leaf(string cn, DateTimeOffset notBefore, DateTimeOffset notAfter, bool withPrivateKey = true, X509Certificate2? issuer = null)
        {
            var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            _disposables.Add(key);
            var req = new CertificateRequest($"CN={cn}", key, HashAlgorithmName.SHA256);
            var serial = RandomNumberGenerator.GetBytes(8);
            serial[0] &= 0x7F;
            using var pub = req.Create(issuer ?? Intermediate, notBefore, notAfter, serial);
            return withPrivateKey ? pub.CopyWithPrivateKey(key) : new X509Certificate2(pub.RawData);
        }

        public void Dispose()
        {
            foreach (var d in _disposables) d.Dispose();
        }
    }

    [Fact]
    public void Selects_ValidCertificateOfTheDevice_IssuedByProfileIntermediate()
    {
        using var pki = new Pki();
        using var leaf = pki.Leaf("vpn-diego-portatil", Now.AddDays(-1), Now.AddDays(29));

        var selected = EnrollmentOrchestrator.SelectReusableCertificate(new[] { leaf }, "vpn-diego-portatil", pki.Chain, pki.Root, Now);

        Assert.NotNull(selected);
        Assert.Equal(leaf.Thumbprint, selected!.Thumbprint);
    }

    [Fact]
    public void Picks_TheNewestOfSeveralValidCertificates()
    {
        using var pki = new Pki();
        using var older = pki.Leaf("vpn-a", Now.AddDays(-10), Now.AddDays(20));
        using var newer = pki.Leaf("vpn-a", Now.AddDays(-1), Now.AddDays(29));

        var selected = EnrollmentOrchestrator.SelectReusableCertificate(new[] { older, newer }, "vpn-a", pki.Chain, pki.Root, Now);

        Assert.Equal(newer.Thumbprint, selected!.Thumbprint);
    }

    [Fact]
    public void Rejects_CertificateOfAnotherDevice()
    {
        using var pki = new Pki();
        using var leaf = pki.Leaf("vpn-otro", Now.AddDays(-1), Now.AddDays(29));
        Assert.Null(EnrollmentOrchestrator.SelectReusableCertificate(new[] { leaf }, "vpn-a", pki.Chain, pki.Root, Now));
    }

    [Fact]
    public void Rejects_ExpiredAndNotYetValidCertificates()
    {
        using var pki = new Pki();
        using var expired = pki.Leaf("vpn-a", Now.AddDays(-60), Now.AddDays(-1));
        using var future = pki.Leaf("vpn-a", Now.AddDays(1), Now.AddDays(30));
        Assert.Null(EnrollmentOrchestrator.SelectReusableCertificate(new[] { expired, future }, "vpn-a", pki.Chain, pki.Root, Now));
    }

    [Fact]
    public void Rejects_CertificateWithoutPrivateKey()
    {
        using var pki = new Pki();
        using var leaf = pki.Leaf("vpn-a", Now.AddDays(-1), Now.AddDays(29), withPrivateKey: false);
        Assert.Null(EnrollmentOrchestrator.SelectReusableCertificate(new[] { leaf }, "vpn-a", pki.Chain, pki.Root, Now));
    }

    [Fact]
    public void Rejects_CertificateIssuedByAnotherCa()
    {
        using var profilePki = new Pki();
        using var otherPki = new Pki("Otra Intermedia");
        using var leaf = otherPki.Leaf("vpn-a", Now.AddDays(-1), Now.AddDays(29));
        Assert.Null(EnrollmentOrchestrator.SelectReusableCertificate(new[] { leaf }, "vpn-a", profilePki.Chain, profilePki.Root, Now));
    }

    [Fact]
    public void Rejects_CertificateWithSameIssuerNameButForgedSignature()
    {
        // Misma DN de emisor que la intermedia del perfil, pero firmado por
        // otra clave: el nombre coincide, la cadena no.
        using var profilePki = new Pki();
        using var impostorPki = new Pki();
        using var leaf = impostorPki.Leaf("vpn-a", Now.AddDays(-1), Now.AddDays(29));
        Assert.Null(EnrollmentOrchestrator.SelectReusableCertificate(new[] { leaf }, "vpn-a", profilePki.Chain, profilePki.Root, Now));
    }

    [Fact]
    public void Accepts_CertificateIssuedDirectlyByRoot_WhenProfileHasNoIntermediate()
    {
        // Dispositivo "vps" de prueba (CLAUDE.md): la raiz firma directamente.
        using var pki = new Pki();
        using var leaf = pki.Leaf("vpn-vps", Now.AddDays(-1), Now.AddDays(29), issuer: pki.Root);

        var selected = EnrollmentOrchestrator.SelectReusableCertificate(
            new[] { leaf }, "vpn-vps", new X509Certificate2Collection { pki.Root }, pki.Root, Now);

        Assert.NotNull(selected);
    }
}
