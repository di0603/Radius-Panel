using DidevVpn.Core.Versioning;

namespace DidevVpn.Tests.Versioning;

public class AppVersionTests
{
    [Theory]
    [InlineData("1.2.3", 1, 2, 3)]
    [InlineData("0.0.0", 0, 0, 0)]
    [InlineData("10.20.30", 10, 20, 30)]
    public void TryParse_FormatoValido_DevuelveLosComponentes(string input, int major, int minor, int patch)
    {
        Assert.True(AppVersion.TryParse(input, out var version));
        Assert.Equal(major, version.Major);
        Assert.Equal(minor, version.Minor);
        Assert.Equal(patch, version.Patch);
    }

    [Theory]
    [InlineData("1.2")]
    [InlineData("1.2.3.4")]
    [InlineData("v1.2.3")]
    [InlineData("1.2.3-beta")]
    [InlineData("")]
    [InlineData(null)]
    public void TryParse_FormatoInvalido_DevuelveFalse(string? input)
    {
        Assert.False(AppVersion.TryParse(input, out _));
    }

    [Fact]
    public void IsBelow_VersionMenor_DevuelveTrue()
    {
        var current = AppVersion.Parse("1.0.0");
        var minimum = AppVersion.Parse("1.2.0");

        Assert.True(current.IsBelow(minimum));
    }

    [Fact]
    public void IsBelow_MismaVersion_DevuelveFalse()
    {
        var current = AppVersion.Parse("1.2.3");
        var minimum = AppVersion.Parse("1.2.3");

        Assert.False(current.IsBelow(minimum));
    }

    [Fact]
    public void IsBelow_VersionMayor_DevuelveFalse()
    {
        var current = AppVersion.Parse("2.0.0");
        var minimum = AppVersion.Parse("1.9.9");

        Assert.False(current.IsBelow(minimum));
    }

    [Theory]
    [InlineData("1.0.0", "1.0.1", true)]
    [InlineData("1.1.0", "1.0.9", false)]
    [InlineData("2.0.0", "1.99.99", false)]
    public void CompareTo_ComparaCampoAcampo(string a, string b, bool aIsLess)
    {
        var left = AppVersion.Parse(a);
        var right = AppVersion.Parse(b);

        Assert.Equal(aIsLess, left < right);
    }
}
