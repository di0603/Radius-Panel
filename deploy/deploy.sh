#!/usr/bin/env bash
# Deploy automatico de Radius-Panel: se ejecuta cada 2 min via
# deploy/radius-panel-deploy.timer. Si hay commits nuevos en origin/main,
# hace pull, instala deps, compila y reinicia el servicio de la API.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/radius-panel-deploy.lock"
SERVICE_NAME="radius-panel.service"
BRANCH="main"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Ya hay un deploy en curso, salgo."
  exit 0
fi

cd "$REPO_DIR"

git fetch origin "$BRANCH"

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  exit 0
fi

echo "$(date -Iseconds) Nuevo commit detectado: $LOCAL_HEAD -> $REMOTE_HEAD"

git merge --ff-only "origin/$BRANCH"

npm run install:all
npm run build

echo "$(date -Iseconds) Build OK, reiniciando $SERVICE_NAME"
sudo /usr/bin/systemctl restart "$SERVICE_NAME"

echo "$(date -Iseconds) Deploy completado en $(git rev-parse HEAD)"
