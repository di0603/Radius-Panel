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

public class RenewalThresholdTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    private static EstStatus Status(bool due, int expiresInDays) =>
        new("vpn-x", Now.AddDays(expiresInDays), due, "0.0.0");

    [Fact]
    public void ServerSaysDue_AlwaysRenews()
    {
        Assert.True(DidevVpn.App.Orchestration.RenewalOrchestrator.IsRenewalDue(Status(true, 25), Now, null, out var forced));
        Assert.False(forced);
    }

    [Fact]
    public void NotDue_WithoutOverride_DoesNotRenew()
    {
        Assert.False(DidevVpn.App.Orchestration.RenewalOrchestrator.IsRenewalDue(Status(false, 25), Now, null, out _));
        Assert.False(DidevVpn.App.Orchestration.RenewalOrchestrator.IsRenewalDue(Status(false, 25), Now, "", out _));
        Assert.False(DidevVpn.App.Orchestration.RenewalOrchestrator.IsRenewalDue(Status(false, 25), Now, "no-numero", out _));
        Assert.False(DidevVpn.App.Orchestration.RenewalOrchestrator.IsRenewalDue(Status(false, 25), Now, "-5", out _));
    }

    [Fact]
    public void Override40Days_ForcesRenewalOfAThirtyDayCertificate()
    {
        Assert.True(DidevVpn.App.Orchestration.RenewalOrchestrator.IsRenewalDue(Status(false, 29), Now, "40", out var forced));
        Assert.True(forced);
    }

    [Fact]
    public void Override10Days_DoesNotForceWhenThereAre25DaysLeft()
    {
        Assert.False(DidevVpn.App.Orchestration.RenewalOrchestrator.IsRenewalDue(Status(false, 25), Now, "10", out _));
    }
}
