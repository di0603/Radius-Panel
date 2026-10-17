using DidevVpn.App.Services;

namespace DidevVpn.App.Tests;

/// <summary>
/// Regresion 0.1.13: el script generado llamaba a Add-VpnConnectionRoute con
/// -Force (el cmdlet no lo tiene) y en modo dividido fallaba con
/// NamedParameterNotFound. Aqui se analiza el script con el parser de PowerShell
/// y se comprueba, con (Get-Command X).Parameters, que cada parametro nombrado
/// -incluidas las claves de los hashtables usados con splatting- existe.
/// No crea conexiones ni toca el sistema.
/// </summary>
public class VpnScriptParametersTests
{

    private const string Checker = @"
param([string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$cmdlets = @('Add-VpnConnection','Set-VpnConnectionIPsecConfiguration','Add-VpnConnectionRoute','Remove-VpnConnection')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { Write-Output ('PARSE: ' + $errors[0].Message); exit 0 }
$hashKeys = @{}
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
  if ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {
    $h = $a.Right.Find({ param($n) $n -is [System.Management.Automation.Language.HashtableAst] }, $true)
    if ($h) { $hashKeys[$a.Left.VariablePath.UserPath] = @($h.KeyValuePairs | ForEach-Object { $_.Item1.Value }) }
  }
}
$seen = @{}
foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
  $name = $c.GetCommandName()
  if ($cmdlets -notcontains $name) { continue }
  $seen[$name] = $true
  $known = (Get-Command $name).Parameters
  $used = @()
  foreach ($e in $c.CommandElements) {
    if ($e -is [System.Management.Automation.Language.CommandParameterAst]) { $used += $e.ParameterName }
    elseif ($e -is [System.Management.Automation.Language.VariableExpressionAst] -and $e.Splatted) {
      $used += @($hashKeys[$e.VariablePath.UserPath])
    }
  }
  foreach ($p in $used) {
    # ParameterName admite abreviaturas; se exige el nombre completo (o un alias declarado)
    $ok = $known.ContainsKey($p) -or (@($known.Values | ForEach-Object { $_.Aliases }) -contains $p)
    if (-not $ok) { Write-Output ('MISSING: ' + $name + ' -' + $p) }
  }
}
foreach ($n in $cmdlets) { if (-not $seen[$n]) { Write-Output ('NOTSEEN: ' + $n) } }
";

    private static string RunChecker(VpnConnectionSpec spec)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"didev-vpn-params-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var script = VpnConnectionService.BuildCreateOrUpdateScript(spec, Path.Combine(dir, "eap.xml"));
            var scriptPath = Path.Combine(dir, "generado.ps1");
            File.WriteAllText(scriptPath, script, System.Text.Encoding.UTF8);
            var checkerPath = Path.Combine(dir, "check.ps1");
            File.WriteAllText(checkerPath, Checker, System.Text.Encoding.UTF8);
            return PowerShellRunner.RunScript($"& '{checkerPath}' -ScriptPath '{scriptPath}'");
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { /* best effort */ }
        }
    }

    private static VpnConnectionSpec NewSpec(bool split, params string[] routes) => new(
        "vpn-test", "vpn.example.org", "radius.vpn.example.org",
        "5C0DEDF66D5F6B169CA733F99D68899D50CF0136", "AABBCCDDEEFF00112233445566778899AABBCCDD",
        split, routes, "AES256", "SHA384", "ECP384", "AES256", "ECP384");

    [Fact]
    public void GeneratedScriptWithRoutes_OnlyUsesParametersThatExistInTheCmdlets()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var output = RunChecker(NewSpec(true, "192.168.10.0/24", "10.0.0.0/8"));
        Assert.True(string.IsNullOrWhiteSpace(output), "Parametros inexistentes en el script generado:\n" + output);
    }

    [Fact]
    public void GeneratedScript_DoesNotPassForceToAddVpnConnectionRoute()
    {
        var script = VpnConnectionService.BuildCreateOrUpdateScript(NewSpec(true, "192.168.10.0/24"), "x.xml");
        var line = script.Split('\n').Single(l => l.StartsWith("Add-VpnConnectionRoute", StringComparison.Ordinal));
        Assert.DoesNotContain("-Force", line);
    }
}
