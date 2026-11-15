#!/usr/bin/env bash
# À installer comme /usr/local/sbin/deploy-montage-video (root:root, 0755).
# Ne déploie que le commit actuel de main après validation CI.
set -Eeuo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage : deploy-montage-video <SHA Git complet>" >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then echo "Exécution root requise." >&2; exit 1; fi
CIBLE_SHA="$1"
exec 9>/run/lock/deploy-montage-video.lock
flock -w 60 9 || { echo "Un déploiement est déjà en cours." >&2; exit 1; }
cd /root/montage-video
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Le checkout VPS doit être sur main ; aucun changement effectué." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Fichiers suivis modifiés sur le VPS ; déploiement refusé." >&2
  exit 1
fi

git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
DISTANT="$(git rev-parse refs/remotes/origin/main)"
if [[ "$DISTANT" != "$CIBLE_SHA" ]]; then
  echo "Commit demandé non actuel ($CIBLE_SHA), un nouveau push le remplace."
  exit 0
fi
AVANT="$(git rev-parse HEAD)"
git merge --ff-only "$CIBLE_SHA"
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 240
curl --fail --silent --show-error --max-time 10 -o /dev/null http://127.0.0.1:3013/api/session

if git diff --name-only "$AVANT" "$CIBLE_SHA" -- deploiement/nginx.conf deploiement/nginx.sh \
  | grep -q .; then
  bash deploiement/nginx.sh
fi
echo "Montage Vidéo déployé : $CIBLE_SHA"
