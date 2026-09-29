using DidevVpn.Core.Ipsec;

namespace DidevVpn.Tests.Ipsec;

public class WindowsIpsecProposalMapperTests
{
    [Fact]
    public void MapEncryption_Aes256Gcm16_DevuelveGCMAES256()
    {
        Assert.Equal("GCMAES256", WindowsIpsecProposalMapper.MapEncryption("aes256gcm16"));
    }

    [Fact]
    public void MapIntegrityOrPrf_Sha384_DevuelveSHA384()
    {
        Assert.Equal("SHA384", WindowsIpsecProposalMapper.MapIntegrityOrPrf("sha384"));
    }

    [Fact]
    public void MapDhOrPfsGroup_Ecp384_DevuelveECP384()
    {
        Assert.Equal("ECP384", WindowsIpsecProposalMapper.MapDhOrPfsGroup("ecp384"));
    }

    [Theory]
    [InlineData("aes128gcm16")]
    [InlineData("")]
    [InlineData("algo-inventado")]
    public void MapEncryption_ValorNoReconocido_LanzaNotSupported(string value)
    {
        Assert.Throws<NotSupportedException>(() => WindowsIpsecProposalMapper.MapEncryption(value));
    }

    [Fact]
    public void MapDhOrPfsGroup_ValorNoReconocido_LanzaNotSupported()
    {
        Assert.Throws<NotSupportedException>(() => WindowsIpsecProposalMapper.MapDhOrPfsGroup("modp2048"));
    }
}
