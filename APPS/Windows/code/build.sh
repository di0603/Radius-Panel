#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Uso: ./build.sh X.Y.Z" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/../ejecutables"
NORMAL="$ROOT/DidevVpn.App/bin/Release/net8.0-windows/win-x64/publish"
SINGLE="$ROOT/DidevVpn.App/bin/Release-SingleFile/net8.0-windows/win-x64/publish"
mkdir -p "$OUT"

dotnet test "$ROOT/DidevVpn.Tests/DidevVpn.Tests.csproj" -c Release
case "${OSTYPE:-}" in
  msys*|cygwin*) dotnet test "$ROOT/DidevVpn.App.Tests/DidevVpn.App.Tests.csproj" -c Release ;;
  *) echo "Aviso: se omiten los tests Windows/CNG/TPM en este entorno no Windows." ;;
esac
dotnet publish "$ROOT/DidevVpn.App/DidevVpn.App.csproj" -r win-x64 --self-contained true -c Release \
  -p:EnableWindowsTargeting=true -p:Version="$VERSION" -p:PublishSingleFile=false -o "$NORMAL"
dotnet publish "$ROOT/DidevVpn.App/DidevVpn.App.csproj" -r win-x64 --self-contained true -c Release \
  -p:EnableWindowsTargeting=true -p:Version="$VERSION" -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true -o "$SINGLE"

EXE="$SINGLE/didev-vpn.exe"
cp "$EXE" "$OUT/didev-vpn-$VERSION.exe"
rm -f "$OUT/didev-vpn-portable-$VERSION.zip"
(
  cd "$SINGLE"
  zip -q "$OUT/didev-vpn-portable-$VERSION.zip" didev-vpn.exe
)

MSI="$ROOT/DidevVpn.Installer/bin/x64/Release/didev-vpn-setup.msi"
if dotnet build "$ROOT/DidevVpn.Installer/DidevVpn.Installer.wixproj" -c Release -p:Platform=x64 \
  -p:EnableWindowsTargeting=true -p:ProductVersion="$VERSION" -p:AppPublishDir="$NORMAL/"; then
  if [[ -f "$MSI" ]]; then cp "$MSI" "$OUT/didev-vpn-setup-$VERSION.msi"; fi
else
  echo "Aviso: WiX no pudo generar el MSI en este entorno; se deja el comando para Windows en el README." >&2
fi

rm -f "$OUT/SHA256SUMS.txt"
(
  cd "$OUT"
  sha256sum "didev-vpn-$VERSION.exe" "didev-vpn-portable-$VERSION.zip"
  [[ -f "didev-vpn-setup-$VERSION.msi" ]] && sha256sum "didev-vpn-setup-$VERSION.msi"
) > "$OUT/SHA256SUMS.txt"
echo "Artefactos generados en $OUT"
