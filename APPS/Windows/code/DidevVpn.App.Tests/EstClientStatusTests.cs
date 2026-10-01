using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

public class EstClientStatusTests
{
    [Theory]
    [InlineData("2026-10-31T10:03:43.000Z")]
    [InlineData("2026-10-31T10:03:43Z")]
    [InlineData("2026-10-31 10:03:43")] // formato DATETIME de MariaDB de los paneles anteriores: UTC sin zona
    [InlineData("2026-10-31T12:03:43+02:00")]
    public void ParseNotAfter_AcceptsIsoAndTheOldMariaDbFormat_AllAsTheSameUtcInstant(string input)
    {
        var parsed = EstClient.ParseNotAfter(input);

        Assert.Equal(new DateTimeOffset(2026, 10, 31, 10, 3, 43, TimeSpan.Zero), parsed.ToUniversalTime());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("manana")]
    public void ParseNotAfter_Garbage_ThrowsWithAUsefulMessage(string? input)
    {
        var ex = Assert.Throws<FormatException>(() => EstClient.ParseNotAfter(input));

        Assert.Contains("notAfter", ex.Message);
    }
}
