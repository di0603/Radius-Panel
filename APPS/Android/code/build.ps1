param(
    [Parameter(Mandatory = $false)][string]$Version = "1.0.0",
    [Parameter(Mandatory = $false)][string]$SigningKeystore = $env:DIDEV_ANDROID_SIGNING_KEYSTORE,
    [Parameter(Mandatory = $false)][string]$SigningAlias = $env:DIDEV_ANDROID_SIGNING_ALIAS,
    [Parameter(Mandatory = $false)][string]$SigningStorePassword = $env:DIDEV_ANDROID_SIGNING_STORE_PASSWORD,
    [Parameter(Mandatory = $false)][string]$SigningKeyPassword = $env:DIDEV_ANDROID_SIGNING_KEY_PASSWORD
)

$ErrorActionPreference = "Stop"
$code = Split-Path -Parent $MyInvocation.MyCommand.Path
$output = Join-Path $code "..\ejecutables"
$strongswanCommit = "c5652d46231f9513c5e84ac4aa2e2e109db15624"
$sourceDir = Join-Path ([System.IO.Path]::GetTempPath()) ("didev-strongswan-{0}" -f $strongswanCommit.Substring(0, 12))
New-Item -ItemType Directory -Force -Path $output | Out-Null
Push-Location $code
try {
    if (-not (Test-Path (Join-Path $sourceDir "src\libcharon"))) {
        git clone https://github.com/strongswan/strongswan.git $sourceDir
        git -C $sourceDir checkout --detach $strongswanCommit
    }
    $common = Join-Path $sourceDir "Android.common.mk"
    if (-not (Test-Path $common)) {
        $commonText = Get-Content -Raw -LiteralPath (Join-Path $sourceDir "Android.common.mk.in")
        $commonText.Replace('@PACKAGE_VERSION@', '6.0.0') | Set-Content -LiteralPath $common -NoNewline
    }
    $ndk = if ($env:ANDROID_NDK_ROOT) { $env:ANDROID_NDK_ROOT } else { Join-Path $env:ANDROID_HOME 'ndk\27.3.13750724' }
    if (-not (Test-Path (Join-Path $ndk 'ndk-build.cmd'))) { throw "Falta NDK 27.3.13750724" }
    if (-not (Test-Path (Join-Path $code 'app\src\main\jni\openssl\Android.mk'))) {
        if (-not $env:OPENSSL_SRC) { throw "Falta OpenSSL compilado; define OPENSSL_SRC y ejecuta openssl/build.sh" }
        $env:ANDROID_NDK_ROOT = $ndk
        & bash (Join-Path $code 'openssl\build.sh')
        if ($LASTEXITCODE -ne 0) { throw "La compilacion de OpenSSL fallo" }
    }
    $env:ORG_GRADLE_PROJECT_strongswanSourceDir = ($sourceDir -replace '\\', '/')
    $env:ORG_GRADLE_PROJECT_didevVersion = $Version
    & .\gradlew.bat --no-daemon --offline testReleaseUnitTest assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "Gradle fallo" }
    $unsigned = Join-Path $code "app\build\outputs\apk\release\app-release-unsigned.apk"
    $apk = Join-Path $output ("didev-vpn-{0}.apk" -f $Version)
    if ($SigningKeystore) {
        if (-not (Test-Path -LiteralPath $SigningKeystore)) { throw "No existe el keystore indicado" }
        $signed = Join-Path $code "app\build\outputs\apk\release\app-release-signed.apk"
        & $env:ANDROID_HOME\build-tools\35.0.0\apksigner.bat sign --ks $SigningKeystore --ks-key-alias $SigningAlias --ks-pass ("pass:" + $SigningStorePassword) --key-pass ("pass:" + $SigningKeyPassword) --out $signed $unsigned
        if ($LASTEXITCODE -ne 0) { throw "apksigner fallo" }
        Copy-Item $signed $apk -Force
    } else {
        Write-Warning "DIDEV_ANDROID_SIGNING_KEYSTORE no esta configurado; se genera APK de depuracion sin firma de distribucion."
        & .\gradlew.bat --no-daemon --offline assembleDebug
        if ($LASTEXITCODE -ne 0) { throw "Gradle debug fallo" }
        Copy-Item (Join-Path $code "app\build\outputs\apk\debug\app-debug.apk") $apk -Force
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apk).Hash.ToLowerInvariant()
    "{0}  {1}" -f $hash, (Split-Path $apk -Leaf) | Set-Content (Join-Path $output "SHA256SUMS.txt")
    Write-Host "APK: $apk"
} finally { Pop-Location }
