using DidevVpn.Core.Versioning;

namespace DidevVpn.Tests.Versioning;

public class MsiUiLevelTests
{
    [Theory]
    [InlineData(0, true)]
    [InlineData(2, true)]
    [InlineData(3, false)]
    [InlineData(4, false)]
    [InlineData(5, false)]
    public void IsSilent_SoloUiLevelDosOMenosEsSilencioso(int uiLevel, bool expected)
    {
        Assert.Equal(expected, MsiUiLevel.IsSilent(uiLevel));
    }

    [Fact]
    public void DefaultWhenUnspecified_NoEsSilencioso()
    {
        Assert.False(MsiUiLevel.IsSilent(MsiUiLevel.DefaultWhenUnspecified));
    }
}
