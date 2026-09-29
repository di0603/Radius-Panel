# Ejecutables locales

`APPS/Windows/ejecutables/` es donde `../code/build.ps1` deja los binarios
compilados de didev-vpn-windows:

- `didev-vpn-<version>.exe` (portable single-file)
- `didev-vpn-portable-<version>.zip`
- `didev-vpn-setup-<version>.msi` (si WiX esta disponible)
- `SHA256SUMS.txt`

Ninguno de esos ficheros se sube al repositorio (ver `.gitignore`, que
excluye todo lo demas de esta carpeta): son binarios grandes, regenerables
en cualquier momento con `build.ps1`, y en el caso del `.msi`/`.exe` pueden
llevar una firma de codigo que no tiene sentido versionar. Los builds de
desarrollo salen sin firma de codigo hasta proporcionar un certificado a
`build.ps1`.

Para generarlos en Windows, ver "Compilar" en `../README.md`. En Linux se
puede usar `../code/build.sh 0.1.0`; requiere SDK .NET 8, `zip` y `sha256sum`.
