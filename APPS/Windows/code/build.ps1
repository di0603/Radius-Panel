#Requires -Version 5.1
<#
.SYNOPSIS
    Compila didev-vpn-windows en sus dos variantes y las deja en
    APPS/Windows/ejecutables/ (fuera de git, ver .gitignore).

.DESCRIPTION
    1) Corre los tests (DidevVpn.Tests). Si fallan, no sigue.
    2) Publica DidevVpn.App dos veces: self-contained "normal" (para el MSI)
       y self-contained single-file (para el .zip portable).
    3) Firma el .exe portable con signtool (si se da un certificado).
    4) Copia el .exe portable y lo empaqueta en didev-vpn-portable-<version>.zip.
    5) Intenta compilar el instalador WiX (DidevVpn.Installer) contra la publicacion
       "normal", produciendo didev-vpn-setup-<version>.msi.
    6) Firma el .msi con signtool (si se da un certificado).
    7) Genera SHA256SUMS.txt de todos los artefactos presentes.

    Este cliente generico no necesita ninguna clave, certificado ni servidor
    de didev para compilar. La confianza se decide al importar cada perfil.

.PARAMETER Version
    Version X.Y.Z de este build (se usa tal cual como -p:Version/-p:ProductVersion
    y en los nombres de fichero). Obligatoria: no hay un valor "de mentira"
    razonable para un instalador de verdad.

.PARAMETER SigningCertThumbprint
    Huella del certificado de firma de codigo YA instalado en el almacen de
    certificados del usuario/equipo que ejecuta el build (el caso normal en
    un equipo de compilacion con un certificado EV en un token). Si no se da
    ni -SigningCertPath, el .exe/.msi NO se firman (se avisa por pantalla,
    no se aborta: util para builds de desarrollo).

.PARAMETER SigningCertPath
    Alternativa a -SigningCertThumbprint: ruta a un .pfx. Pide
    -SigningCertPassword (como SecureString) si el .pfx tiene contrasena.

.PARAMETER SigningCertPassword
    Contrasena del .pfx de -SigningCertPath, como SecureString. Nunca la
    pases como texto plano en la linea de comandos de una sesion compartida.

.PARAMETER TimestampUrl
    Servidor de sellado de tiempo para signtool (por defecto, DigiCert). Sin
    sello de tiempo, la firma dejaria de considerarse valida en cuanto
    caduque el certificado, aunque el binario no haya cambiado.

.EXAMPLE
    ./build.ps1 -Version 1.0.0
    Build sin firmar (desarrollo/pruebas locales).

.EXAMPLE
    ./build.ps1 -Version 1.0.0 -SigningCertThumbprint AB12CD34EF56...
    Build de verdad, firmado con un certificado ya instalado.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string]$SigningCertThumbprint,

    [string]$SigningCertPath,

    [System.Security.SecureString]$SigningCertPassword,

    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$outputDir = Join-Path (Split-Path $root -Parent) 'ejecutables'
$publishNormalDir = Join-Path $root 'DidevVpn.App\bin\Release\net8.0-windows\win-x64\publish'
$publishSingleFileDir = Join-Path $root 'DidevVpn.App\bin\Release-SingleFile\net8.0-windows\win-x64\publish'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Find-SignTool {
    $candidate = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($candidate) { return $candidate.Source }

    $kitsRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
    if (Test-Path $kitsRoot) {
        $found = Get-ChildItem -Path $kitsRoot -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like '*x64*' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

function Invoke-SignTool([string]$FilePath) {
    if (-not $script:SignToolPath) {
        Write-Warning "signtool.exe no disponible: '$FilePath' se queda SIN FIRMAR. Solo valido para pruebas locales."
        return
    }
    if (-not $SigningCertThumbprint -and -not $SigningCertPath) {
        Write-Warning "No se ha dado ningun certificado de firma de codigo: '$FilePath' se queda SIN FIRMAR."
        return
    }

    $signArgs = @('sign', '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256')
    if ($SigningCertThumbprint) {
        $signArgs += @('/sha1', $SigningCertThumbprint)
    }
    else {
        $signArgs += @('/f', $SigningCertPath)
        if ($SigningCertPassword) {
            $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SigningCertPassword))
            $signArgs += @('/p', $plain)
        }
    }
    $signArgs += $FilePath

    & $script:SignToolPath @signArgs
    if ($LASTEXITCODE -ne 0) {
        throw "signtool fallo firmando '$FilePath' (codigo $LASTEXITCODE)."
    }
    Write-Host "Firmado: $FilePath"
}

# ------------------------------------------------------------------------
Write-Step "1/7 - Tests (DidevVpn.Tests)"
dotnet test (Join-Path $root 'DidevVpn.Tests\DidevVpn.Tests.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw "Los tests han fallado: no se genera ningun artefacto." }

# ------------------------------------------------------------------------
Write-Step "2/7 - Publicando la variante instalada (self-contained, multi-fichero)"
dotnet publish (Join-Path $root 'DidevVpn.App\DidevVpn.App.csproj') `
    -r win-x64 --self-contained true -c Release `
    -p:Version=$Version -p:PublishSingleFile=false `
    -o $publishNormalDir
if ($LASTEXITCODE -ne 0) { throw "Fallo publicando la variante instalada." }

# ------------------------------------------------------------------------
Write-Step "3/7 - Publicando la variante portable (self-contained, un unico .exe)"
dotnet publish (Join-Path $root 'DidevVpn.App\DidevVpn.App.csproj') `
    -r win-x64 --self-contained true -c Release `
    -p:Version=$Version -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $publishSingleFileDir
if ($LASTEXITCODE -ne 0) { throw "Fallo publicando la variante portable." }

$script:SignToolPath = Find-SignTool
if (-not $script:SignToolPath) {
    Write-Warning "signtool.exe no encontrado (instala el Windows SDK). Los artefactos saldran sin firmar."
}

$portableExe = Join-Path $publishSingleFileDir 'didev-vpn.exe'
Invoke-SignTool -FilePath $portableExe

# ------------------------------------------------------------------------
Write-Step "4/7 - Empaquetando la variante portable"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$finalPortableExe = Join-Path $outputDir "didev-vpn-$Version.exe"
Copy-Item -Path $portableExe -Destination $finalPortableExe -Force
$portableZip = Join-Path $outputDir "didev-vpn-portable-$Version.zip"
Remove-Item -Path $portableZip -ErrorAction SilentlyContinue
Compress-Archive -Path $portableExe -DestinationPath $portableZip -CompressionLevel Optimal

# ------------------------------------------------------------------------
Write-Step "5/7 - Intentando compilar el instalador (WiX)"
$builtMsi = Join-Path $root 'DidevVpn.Installer\bin\x64\Release\didev-vpn-setup.msi'
Remove-Item -Path $builtMsi -ErrorAction SilentlyContinue
dotnet build (Join-Path $root 'DidevVpn.Installer\DidevVpn.Installer.wixproj') `
    -c Release -p:Platform=x64 -p:ProductVersion=$Version `
    "-p:AppPublishDir=$publishNormalDir\"
$finalMsi = Join-Path $outputDir "didev-vpn-setup-$Version.msi"
if ($LASTEXITCODE -eq 0 -and (Test-Path $builtMsi)) {
    Copy-Item -Path $builtMsi -Destination $finalMsi -Force
}
else {
    Write-Warning "WiX no esta disponible o no pudo generar el MSI. Se continua con el EXE, ZIP y SHA256SUMS."
}

# ------------------------------------------------------------------------
Write-Step "6/7 - Firmando el instalador"
if (Test-Path $finalMsi) { Invoke-SignTool -FilePath $finalMsi }

# ------------------------------------------------------------------------
Write-Step "7/7 - SHA256SUMS.txt"
$sumsPath = Join-Path $outputDir 'SHA256SUMS.txt'
$lines = Get-ChildItem -Path $outputDir -File | Where-Object {
    $_.Name -ne 'SHA256SUMS.txt' -and $_.Extension -in '.exe', '.zip', '.msi'
} | ForEach-Object {
    $hash = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($_.Name)"
}
Set-Content -Path $sumsPath -Value $lines -Encoding utf8

Write-Host ""
Write-Host "Listo. Artefactos en $outputDir :" -ForegroundColor Green
Get-ChildItem -Path $outputDir -File | ForEach-Object { Write-Host "  $($_.Name)" }
