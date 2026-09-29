#!/usr/bin/env bash
# Sincroniza la CA intermedia (y su CRL) del panel con el ca_path de
# FreeRADIUS para el virtual server `vpn` (EAP-TLS). FreeRADIUS valida ahi
# con ca_path + check_crl + check_all_crl = yes: hoy ese directorio solo
# tiene la raiz offline y su CRL, puestas a mano, asi que cualquier
# certificado de dispositivo firmado por la intermedia del panel (en vez de
# directamente por la raiz) se rechaza. Este script anade la intermedia y su
# CRL como ficheros propios, SIN TOCAR los de la raiz.
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
: "${ROOT_CERT_FILE:?Falta ROOT_CERT_FILE en $CONFIG_FILE: ruta al certificado de la raiz offline ya presente en CA_PATH}"
: "${ROOT_CERT_SHA256:?Falta ROOT_CERT_SHA256 en $CONFIG_FILE: huella SHA-256 (hex, sin separadores) esperada de ROOT_CERT_FILE}"
: "${FREERADIUS_SERVICE:=freeradius}"
: "${TLS_CONFIG_FILE:=/etc/freeradius/3.0/mods-enabled/eap}"

if [ ! -d "$CA_PATH" ]; then
  echo "CA_PATH '$CA_PATH' no existe: revisa la configuracion antes de continuar." >&2
  exit 1
fi
if [ ! -f "$ROOT_CERT_FILE" ]; then
  echo "ROOT_CERT_FILE '$ROOT_CERT_FILE' no existe: revisa la configuracion antes de continuar." >&2
  exit 1
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

# El panel serializa las CRL con @peculiar/x509 (services/pki.ts,
# lib/x509.ts), cuya libreria etiqueta el PEM como "-----BEGIN CRL-----"
# (PemConverter.CrlTag = "CRL"), no "-----BEGIN X509 CRL-----" -la etiqueta
# de RFC 7468 SS4 para una CRL, y la unica que "openssl crl"/PEM_read_bio_X509_CRL
# reconocen de verdad-. Sin esto, TODO lo de abajo (verificar firma,
# nextUpdate, e instalarla donde FreeRADIUS espera poder leerla con su
# propio OpenSSL) fallaria en silencio o de forma confusa. Se normaliza aqui
# -sed, no algo fragil- en vez de arriesgarse a que quien consuma este
# fichero mas adelante (FreeRADIUS incluido) no la reconozca.
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
    if openssl crl -in "$crl" -CAfile "$cert" -noout >/dev/null 2>&1; then
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

new_hash="$(cat "$new_dir"/panel-intermediate-*.pem "$new_dir/panel-crl.pem" | openssl dgst -sha256 -r | awk '{print $1}')"
state_file="$STATE_DIR/last-applied.sha256"
previous_hash=""
[ -f "$state_file" ] && previous_hash="$(cat "$state_file")"

if [ "$new_hash" = "$previous_hash" ]; then
  echo "Sin cambios respecto a la ultima sincronizacion (huella $new_hash): no se toca nada."
  exit 0
fi

echo "Hay cambios (huella anterior: ${previous_hash:-ninguna}, nueva: $new_hash). Aplicando en $CA_PATH..."
# Limpia solo LOS FICHEROS PROPIOS de sincronizaciones anteriores (nunca los
# de la raiz, que no llevan el prefijo "panel-"), para no acumular
# intermedias retiradas que ya no vienen en la respuesta del panel.
find "$CA_PATH" -maxdepth 1 -name 'panel-intermediate-*.pem' -delete
cp "$new_dir"/panel-intermediate-*.pem "$CA_PATH/"
cp "$new_dir/panel-crl.pem" "$CA_PATH/panel-crl.pem"
chmod 644 "$CA_PATH"/panel-intermediate-*.pem "$CA_PATH/panel-crl.pem"

echo "Reindexando $CA_PATH (openssl rehash)..."
openssl rehash "$CA_PATH" >/dev/null

echo "$new_hash" > "$state_file"

# FreeRADIUS 3.2+ puede releer ca_path solo (sin reiniciar ni recargar) si
# el tls-config tiene "ca_path_reload_interval" -comprobarlo antes de forzar
# nada: si ya esta configurado, dejarlo actuar solo es lo menos disruptivo
# posible (ni siquiera un reload).
if [ -f "$TLS_CONFIG_FILE" ] && grep -qE '^\s*ca_path_reload_interval\b' "$TLS_CONFIG_FILE"; then
  echo "TLS_CONFIG_FILE ('$TLS_CONFIG_FILE') ya tiene ca_path_reload_interval: FreeRADIUS releera $CA_PATH solo, sin reload ni restart."
else
  echo "Recargando $FREERADIUS_SERVICE (reload, no restart: menos disruptivo)..."
  if systemctl reload "$FREERADIUS_SERVICE"; then
    echo "Recargado correctamente."
  else
    echo "El reload ha fallado: probando un restart..." >&2
    if systemctl restart "$FREERADIUS_SERVICE"; then
      echo "Reiniciado correctamente (el reload no funciono, pero el restart si)." >&2
    else
      echo "ATENCION: ni el reload ni el restart de $FREERADIUS_SERVICE han funcionado. Los ficheros nuevos YA estan en $CA_PATH; revisa 'systemctl status $FREERADIUS_SERVICE' a mano." >&2
      exit 1
    fi
  fi
fi

echo "Sincronizacion completada."
