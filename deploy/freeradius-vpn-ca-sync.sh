#!/usr/bin/env bash
# Sincroniza la CA intermedia (y su CRL) del panel con FreeRADIUS para el
# virtual server `vpn` (EAP-TLS, modulo eap_vpn, tls-config tls-vpn).
#
# IMPORTANTE (correccion del prompt 12.7, item 9): la intermedia NUNCA se
# copia dentro de ca_path. FreeRADIUS activa X509_V_FLAG_PARTIAL_CHAIN, asi
# que cualquier certificado presente directamente en ca_path se trata como
# ancla de confianza propia: si la intermedia estuviera ahi, la cadena se
# trunca en ella antes de llegar a la raiz, y check_all_crl no puede
# comprobar la revocacion de la PROPIA intermedia (necesita la CRL de la
# raiz, que ya no forma parte de la cadena construida) -> "unable to get
# certificate CRL" (error 3). Este script deja en ca_path SOLO la CRL de la
# intermedia (con su enlace hash .r0 tras `openssl rehash`, nunca un
# certificado ni un enlace .0); la intermedia se guarda aparte, en
# INTERMEDIATE_DIR, fuera de cualquier ca_path. El cliente EAP-TLS (Windows/
# Linux) envia la intermedia en la propia cadena TLS -de ahi que el alta del
# dispositivo la instale en LocalMachine\CA (prompt 12.7, item 10)-, asi que
# FreeRADIUS la recibe en cada conexion como certificado "no confiable" para
# completar la cadena hasta la raiz, y no necesita tenerla ya en el disco.
#
# tls-config tls-vpn necesita ADEMAS "ca_file" apuntando a un fichero con la
# raiz + su propia CRL (p.ej. root-bundle.pem): ca_path y ca_file son
# complementarios en OpenSSL, no alternativos. Este script NUNCA toca ese
# fichero (se prepara a mano, una vez); solo avisa si no lo encuentra.
#
# Descarga por loopback (server/src/routes/pkiPublic.ts, sin autenticacion:
# es informacion publica, como la de cualquier CA) y NUNCA confia en la raiz
# que venga en esa respuesta: valida la cadena contra la raiz que YA esta en
# el ca_path (por su huella SHA-256, fija en la config de este script), y
# cada CRL contra su propia CA. Si algo falla, no toca nada de lo que ya
# habia y sale con error -nunca deja el ca_path a medias-.
#
# Configuracion (no se versiona, crear a mano en la .28):
#   /etc/freeradius-vpn-ca-sync/config.sh
# Ver deploy/freeradius-vpn-ca-sync.config.sh.example para cada variable.
set -euo pipefail

CONFIG_FILE="${FREERADIUS_VPN_CA_SYNC_CONFIG:-/etc/freeradius-vpn-ca-sync/config.sh}"
STATE_DIR="${FREERADIUS_VPN_CA_SYNC_STATE_DIR:-/var/lib/freeradius-vpn-ca-sync}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Falta $CONFIG_FILE (ver deploy/freeradius-vpn-ca-sync.config.sh.example)" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CONFIG_FILE"

: "${PANEL_PKI_URL:=http://127.0.0.1:1003/pki}"
: "${CA_PATH:=/etc/freeradius/3.0/certs/vpn/ca}"
# Donde vive la intermedia (solo referencia/backup: FreeRADIUS no la lee de
# aqui para la validacion, ver la cabecera de este fichero), SIEMPRE fuera
# de CA_PATH.
: "${INTERMEDIATE_DIR:=/etc/freeradius/3.0/certs/vpn}"
: "${ROOT_CERT_FILE:?Falta ROOT_CERT_FILE en $CONFIG_FILE: ruta al certificado de la raiz offline ya presente en CA_PATH}"
: "${ROOT_CERT_SHA256:?Falta ROOT_CERT_SHA256 en $CONFIG_FILE: huella SHA-256 (hex, sin separadores) esperada de ROOT_CERT_FILE}"
: "${FREERADIUS_SERVICE:=freeradius}"
: "${FREERADIUS_BINARY:=freeradius}"
# El EAP-TLS de la VPN no esta en el modulo "eap" comun (el de la WiFi, que
# no se toca): es su propio modulo eap_vpn con su propio tls-config tls-vpn.
: "${TLS_CONFIG_FILE:=/etc/freeradius/3.0/mods-enabled/eap_vpn}"
# Variables de FreeRADIUS que puede usar TLS_CONFIG_FILE en vez de una ruta
# literal (p.ej. ca_path = "${certdir}/vpn/ca"): se resuelven igual que las
# resolveria FreeRADIUS antes de comparar con CA_PATH. Los valores por
# defecto son los mismos que trae FreeRADIUS de fabrica en radiusd.conf.
: "${CONFDIR:=/etc/freeradius/3.0}"
: "${CERTDIR:=$CONFDIR/certs}"

if [ ! -d "$CA_PATH" ]; then
  echo "CA_PATH '$CA_PATH' no existe: revisa la configuracion antes de continuar." >&2
  exit 1
fi
# Lo que hay que impedir: que la intermedia acabe DENTRO de ca_path (ahi
# X509_V_FLAG_PARTIAL_CHAIN la tomaria como ancla y rompe la validacion de su
# propia revocacion, ver la cabecera). INTERMEDIATE_DIR puede estar en un
# directorio PADRE de CA_PATH (el valor por defecto: .../certs/vpn contiene a
# .../certs/vpn/ca); lo que no puede ser es CA_PATH ni quedar dentro de el.
# Se normalizan las barras finales para que "ca/" y "ca" cuenten como lo mismo.
ca_path_normalized="${CA_PATH%/}"
intermediate_dir_normalized="${INTERMEDIATE_DIR%/}"
case "$intermediate_dir_normalized" in
  "$ca_path_normalized"|"$ca_path_normalized"/*)
    echo "INTERMEDIATE_DIR ('$INTERMEDIATE_DIR') es CA_PATH ('$CA_PATH') o esta dentro de el: la intermedia acabaria en ca_path y FreeRADIUS la tomaria como ancla de confianza (X509_V_FLAG_PARTIAL_CHAIN). Ponla fuera de CA_PATH (por defecto, su directorio padre)." >&2
    exit 1
    ;;
esac
if [ ! -f "$ROOT_CERT_FILE" ]; then
  echo "ROOT_CERT_FILE '$ROOT_CERT_FILE' no existe: revisa la configuracion antes de continuar." >&2
  exit 1
fi
if [ ! -f "$TLS_CONFIG_FILE" ]; then
  echo "TLS_CONFIG_FILE '$TLS_CONFIG_FILE' no existe: revisa la configuracion (deberia ser el modulo eap_vpn, no el eap generico de la WiFi)." >&2
  exit 1
fi

# Sin esto, un CA_PATH mal configurado en este script (o en FreeRADIUS)
# pasaria desapercibido: todo lo de abajo verificaria y escribiria ficheros
# en un directorio que rlm_eap ni siquiera lee. Se extrae el VALOR real de
# "ca_path = ..." (con o sin comillas) y se resuelven ${certdir}/${confdir}
# igual que FreeRADIUS, en vez de buscar CA_PATH como subcadena literal:
# ese metodo antiguo no reconocia un ca_path escrito con esas variables.
configured_ca_path_raw="$(grep -E '^[[:space:]]*ca_path[[:space:]]*=' "$TLS_CONFIG_FILE" | head -n1 | sed -E 's/^[[:space:]]*ca_path[[:space:]]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')"
if [ -z "$configured_ca_path_raw" ]; then
  echo "TLS_CONFIG_FILE '$TLS_CONFIG_FILE' no tiene ninguna linea 'ca_path = ...': revisa que es el tls-config tls-vpn correcto." >&2
  exit 1
fi
configured_ca_path="${configured_ca_path_raw//\$\{certdir\}/$CERTDIR}"
configured_ca_path="${configured_ca_path//\$\{confdir\}/$CONFDIR}"
if [ "$configured_ca_path" != "$CA_PATH" ]; then
  echo "TLS_CONFIG_FILE '$TLS_CONFIG_FILE' tiene ca_path = '$configured_ca_path_raw' (resuelto: '$configured_ca_path'), que no coincide con CA_PATH ('$CA_PATH')." >&2
  exit 1
fi
if ! grep -qE '^[[:space:]]*ca_file[[:space:]]*=' "$TLS_CONFIG_FILE"; then
  echo "AVISO: TLS_CONFIG_FILE '$TLS_CONFIG_FILE' no tiene ninguna linea 'ca_file = ...'. Sin ca_file (raiz + CRL de la raiz en un unico fichero) la validacion de la cadena puede fallar con 'unable to get certificate CRL'; ver el README, seccion de sincronizacion con FreeRADIUS. Este script no la crea ni la toca, solo avisa." >&2
fi

echo "Comprobando que la raiz local (ROOT_CERT_FILE) sigue siendo la esperada..."
actual_root_sha256="$(openssl x509 -in "$ROOT_CERT_FILE" -outform DER 2>/dev/null | openssl dgst -sha256 -r | awk '{print $1}')"
expected_root_sha256="$(printf '%s' "$ROOT_CERT_SHA256" | tr 'A-F' 'a-f')"
if [ "$actual_root_sha256" != "$expected_root_sha256" ]; then
  echo "La huella de '$ROOT_CERT_FILE' ($actual_root_sha256) no coincide con ROOT_CERT_SHA256 ($expected_root_sha256)." >&2
  echo "No se continua: podria ser una raiz distinta de la esperada, o la configuracion esta desactualizada." >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "Descargando la cadena de CA y la CRL desde $PANEL_PKI_URL (loopback)..."
chain_file="$work_dir/ca-chain.pem"
crl_file="$work_dir/crl.pem"
if ! curl -sS --fail --max-time 15 "$PANEL_PKI_URL/ca-chain.pem" -o "$chain_file"; then
  echo "No se pudo descargar ca-chain.pem: se conserva la configuracion actual de FreeRADIUS." >&2
  exit 1
fi
if ! curl -sS --fail --max-time 15 "$PANEL_PKI_URL/crl.pem" -o "$crl_file"; then
  echo "No se pudo descargar crl.pem: se conserva la configuracion actual de FreeRADIUS." >&2
  exit 1
fi
if [ ! -s "$chain_file" ] || [ ! -s "$crl_file" ]; then
  echo "La cadena de CA o la CRL descargadas estan vacias: se conserva la configuracion actual." >&2
  exit 1
fi

# TOLERANCIA hacia paneles antiguos, no algo que deba hacer falta hoy: hasta
# el prompt 14.5, @peculiar/x509 (lib/x509.ts) etiquetaba las CRL como
# "-----BEGIN CRL-----" en vez de "-----BEGIN X509 CRL-----" (la etiqueta de
# RFC 7468 SS4, la unica que "openssl crl"/PEM_read_bio_X509_CRL reconocen de
# verdad). Esto ya esta corregido EN ORIGEN (lib/x509.ts: crlToPem) y
# GET /pki/crl.pem ya sirve la etiqueta correcta: este sed es un no-op contra
# un panel al dia (ninguna de las dos lineas de abajo encuentra nada que
# sustituir), y solo hace falta de verdad si este script se usa contra un
# panel desplegado ANTES de ese fix. Se deja por si acaso, no por necesidad.
sed -i \
  -e 's/-----BEGIN CRL-----/-----BEGIN X509 CRL-----/' \
  -e 's/-----END CRL-----/-----END X509 CRL-----/' \
  "$crl_file"

# ca-chain.pem = una o mas intermedias + la raiz AL FINAL (services/pki.ts,
# getCaChainPem). Se descarta la raiz de ese fichero: NUNCA se usa la raiz
# que llega por HTTP como ancla de confianza, solo la que ya habia en
# ROOT_CERT_FILE (ya comprobada arriba por huella).
echo "Separando los certificados de la cadena descargada..."
mapfile -t cert_files < <(
  csplit -s -z -f "$work_dir/cert-" -b '%02d.pem' "$chain_file" '/-----BEGIN CERTIFICATE-----/' '{*}' 2>/dev/null
  ls "$work_dir"/cert-*.pem 2>/dev/null | sort
)
if [ "${#cert_files[@]}" -lt 1 ]; then
  echo "No se ha podido extraer ningun certificado de ca-chain.pem." >&2
  exit 1
fi

intermediate_files=()
last_index=$((${#cert_files[@]} - 1))
for i in "${!cert_files[@]}"; do
  cert="${cert_files[$i]}"
  if [ "$i" -eq "$last_index" ]; then
    # Se asume que la raiz va al final, tal como la construye el panel; no
    # se usa para nada (ver el comentario de arriba), solo se descarta.
    continue
  fi
  intermediate_files+=("$cert")
done

if [ "${#intermediate_files[@]}" -lt 1 ]; then
  echo "ca-chain.pem solo trae la raiz, ninguna intermedia: nada que sincronizar." >&2
  exit 1
fi

echo "Verificando cada intermedia contra la raiz local (nunca contra la del HTTP)..."
for cert in "${intermediate_files[@]}"; do
  if ! openssl verify -CAfile "$ROOT_CERT_FILE" "$cert" >/dev/null 2>&1; then
    echo "La intermedia '$cert' no verifica contra la raiz local ('$ROOT_CERT_FILE')." >&2
    exit 1
  fi
done

echo "Separando las CRL descargadas..."
mapfile -t crl_files < <(
  csplit -s -z -f "$work_dir/crl-" -b '%02d.pem' "$crl_file" '/-----BEGIN X509 CRL-----/' '{*}' 2>/dev/null
  ls "$work_dir"/crl-*.pem 2>/dev/null | sort
)
if [ "${#crl_files[@]}" -lt 1 ]; then
  echo "No se ha podido extraer ninguna CRL de crl.pem." >&2
  exit 1
fi

echo "Verificando que cada CRL esta firmada por una de las intermedias y no ha caducado..."
now_epoch="$(date -u +%s)"
for crl in "${crl_files[@]}"; do
  next_update_raw="$(openssl crl -in "$crl" -noout -nextupdate 2>/dev/null | sed 's/^nextUpdate=//')"
  if [ -z "$next_update_raw" ]; then
    echo "La CRL '$crl' no trae nextUpdate: se rechaza (RFC 5280 la exige)." >&2
    exit 1
  fi
  next_update_epoch="$(date -u -d "$next_update_raw" +%s 2>/dev/null || true)"
  if [ -z "$next_update_epoch" ]; then
    echo "No se ha podido interpretar nextUpdate ('$next_update_raw') de '$crl'." >&2
    exit 1
  fi
  if [ "$next_update_epoch" -le "$now_epoch" ]; then
    echo "La CRL '$crl' ya ha caducado (nextUpdate=$next_update_raw): se rechaza." >&2
    exit 1
  fi

  signed_by_known_intermediate=0
  for cert in "${intermediate_files[@]}"; do
    # No basta con el codigo de salida: comprobar el texto de la salida
    # ("verify OK" presente, "verify failure" ausente). "openssl crl -CAfile"
    # es un caso limite poco usado de la CLI de OpenSSL; no arriesgarse a que
    # un codigo de salida 0 acompanado de un mensaje de fallo (o al reves) se
    # interprete al contrario de lo que dice el propio texto.
    crl_verify_output="$(openssl crl -in "$crl" -CAfile "$cert" -noout 2>&1 || true)"
    if printf '%s\n' "$crl_verify_output" | grep -q 'verify OK' && \
       ! printf '%s\n' "$crl_verify_output" | grep -q 'verify failure'; then
      signed_by_known_intermediate=1
      break
    fi
  done
  if [ "$signed_by_known_intermediate" -ne 1 ]; then
    echo "La CRL '$crl' no verifica contra ninguna de las intermedias descargadas." >&2
    exit 1
  fi
done

echo "Todo verifica. Preparando los ficheros nuevos..."
new_dir="$work_dir/new"
mkdir -p "$new_dir"
n=1
for cert in "${intermediate_files[@]}"; do
  cp "$cert" "$new_dir/panel-intermediate-$n.pem"
  n=$((n + 1))
done
cat "${crl_files[@]}" > "$new_dir/panel-crl.pem"

# "v2" en la huella: fuerza una resincronizacion la primera vez que se
# ejecuta esta version corregida del script, aunque la intermedia/CRL no
# hayan cambiado desde la ultima vez que corrio la version anterior (que
# dejaba la intermedia, mal, dentro de CA_PATH). Sin esto, "sin cambios"
# haria salir antes de llegar a la limpieza de mas abajo y la instalacion
# quedaria con el fallo del item 9 sin corregir hasta el siguiente cambio
# real de CA.
new_hash="$( { printf 'v2\n'; cat "$new_dir"/panel-intermediate-*.pem "$new_dir/panel-crl.pem"; } | openssl dgst -sha256 -r | awk '{print $1}')"
state_file="$STATE_DIR/last-applied.sha256"
previous_hash=""
[ -f "$state_file" ] && previous_hash="$(cat "$state_file")"

if [ "$new_hash" = "$previous_hash" ]; then
  echo "Sin cambios respecto a la ultima sincronizacion (huella $new_hash): no se toca nada."
  exit 0
fi

echo "Hay cambios (huella anterior: ${previous_hash:-ninguna}, nueva: $new_hash). Aplicando..."

echo "Guardando la intermedia en $INTERMEDIATE_DIR (fuera de ca_path)..."
mkdir -p "$INTERMEDIATE_DIR"
chmod 755 "$INTERMEDIATE_DIR"
find "$INTERMEDIATE_DIR" -maxdepth 1 -name 'panel-intermediate-*.pem' -delete
cp "$new_dir"/panel-intermediate-*.pem "$INTERMEDIATE_DIR/"
chmod 644 "$INTERMEDIATE_DIR"/panel-intermediate-*.pem

echo "Actualizando la CRL de la intermedia en $CA_PATH (sin el certificado de la intermedia)..."
# Limpia tambien cualquier panel-intermediate-*.pem que hubiera quedado en
# CA_PATH de una instalacion con la version anterior de este script (el
# propio bug que corrige el item 9): nunca los de la raiz, que no llevan el
# prefijo "panel-".
find "$CA_PATH" -maxdepth 1 -name 'panel-intermediate-*.pem' -delete
find "$CA_PATH" -maxdepth 1 -name 'panel-crl.pem' -delete
cp "$new_dir/panel-crl.pem" "$CA_PATH/panel-crl.pem"
chmod 644 "$CA_PATH/panel-crl.pem"

echo "Reindexando $CA_PATH (openssl rehash: solo genera enlaces .r0 para la CRL, sin certificados que enlazar con .0)..."
openssl rehash "$CA_PATH" >/dev/null

echo "$new_hash" > "$state_file"

# En FreeRADIUS 3, un HUP (systemctl reload) NO vuelve a cargar los
# contextos TLS de rlm_eap: una CRL nueva no se aplicaria y una revocacion
# no tendria efecto hasta un restart de verdad. La UNICA forma de que
# FreeRADIUS relea ca_path sin restart es "ca_path_reload_interval" en el
# propio tls-config (FreeRADIUS 3.2+, ver README) -este script NUNCA toca la
# configuracion de FreeRADIUS, solo comprueba si ya esta puesta-.
if grep -qE '^\s*ca_path_reload_interval\b' "$TLS_CONFIG_FILE"; then
  echo "TLS_CONFIG_FILE ('$TLS_CONFIG_FILE') ya tiene ca_path_reload_interval: FreeRADIUS releera $CA_PATH solo, sin restart."
else
  echo "Comprobando la configuracion de FreeRADIUS antes de reiniciar (freeradius -XC)..."
  if ! "$FREERADIUS_BINARY" -XC >/dev/null 2>&1; then
    echo "ATENCION: 'freeradius -XC' dice que la configuracion actual no es valida. Los ficheros nuevos YA estan en $CA_PATH, pero NO se reinicia $FREERADIUS_SERVICE para no tumbar un servicio que quiza siga funcionando con la configuracion cargada. Revisa 'freeradius -XC' a mano." >&2
    exit 1
  fi
  echo "Configuracion valida. Reiniciando $FREERADIUS_SERVICE (restart, no reload: en FreeRADIUS 3 un reload no recarga los contextos TLS)..."
  if systemctl restart "$FREERADIUS_SERVICE"; then
    echo "Reiniciado correctamente."
  else
    echo "ATENCION: el restart de $FREERADIUS_SERVICE ha fallado. Los ficheros nuevos YA estan en $CA_PATH; revisa 'systemctl status $FREERADIUS_SERVICE' a mano." >&2
    exit 1
  fi
fi

echo "Sincronizacion completada."
