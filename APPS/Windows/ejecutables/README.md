# Esta carpeta esta vacia en git

`APPS/Windows/ejecutables/` es donde `../code/build.ps1` deja los binarios
compilados de didev-vpn-windows:

- `didev-vpn-setup-<version>.msi`
- `didev-vpn-portable-<version>.zip`
- `SHA256SUMS.txt`

Ninguno de esos ficheros se sube al repositorio (ver `.gitignore`, que
excluye todo lo demas de esta carpeta): son binarios grandes, regenerables
en cualquier momento con `build.ps1`, y en el caso del `.msi`/`.exe` pueden
llevar una firma de codigo que no tiene sentido versionar.

Para generarlos, ver "Compilar" en `../README.md`.
