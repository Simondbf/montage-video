#!/bin/bash
# Installe ou met à jour la configuration nginx de ce site, depuis le dépôt :
#
#   bash deploiement/nginx.sh
#
# Au premier lancement, il obtient aussi le certificat HTTPS (Let's Encrypt).
# On peut le relancer sans risque : si nginx refuse la nouvelle
# configuration, l'ancienne est remise en place.
set -euo pipefail

DOMAINE="montage.soleiljaune.be"
PORT="3013"

DEPOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELE="$DEPOT/deploiement/nginx.conf"
CIBLE="/etc/nginx/sites-available/$DOMAINE"
LIEN="/etc/nginx/sites-enabled/$DOMAINE"
CERTIFICAT="/etc/letsencrypt/live/$DOMAINE/fullchain.pem"

if [ "$(id -u)" -ne 0 ]; then echo "À lancer en root."; exit 1; fi

# Copie de la configuration actuelle, pour pouvoir revenir en arrière.
ANCIENNE=""
if [ -f "$CIBLE" ]; then
  ANCIENNE="$(mktemp)"
  cat "$CIBLE" > "$ANCIENNE"
fi

remettre() {
  if [ -n "$ANCIENNE" ]; then cat "$ANCIENNE" > "$CIBLE"; else rm -f "$CIBLE" "$LIEN"; fi
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; fi
}

activer() {
  ln -sfn "$CIBLE" "$LIEN"
  if ! nginx -t; then
    echo "nginx refuse cette configuration : l'ancienne est remise en place."
    remettre
    exit 1
  fi
  systemctl reload nginx
}

if [ ! -f "$CERTIFICAT" ]; then
  echo "Premier lancement : demande du certificat HTTPS pour $DOMAINE."
  # Le temps que Let's Encrypt vérifie le domaine : le site en HTTP seulement.
  cat > "$CIBLE" <<FIN
server {
    listen 80;
    server_name $DOMAINE;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
    }
}
FIN
  activer
  # certonly : certbot ne touche pas aux fichiers de configuration, qui
  # restent ceux du dépôt. Après chaque renouvellement, nginx est rechargé.
  if ! certbot certonly --nginx -d "$DOMAINE" --non-interactive --agree-tos --deploy-hook "systemctl reload nginx"; then
    echo "Certificat refusé. Vérifie que l'enregistrement DNS de $DOMAINE pointe bien vers ce serveur, puis relance ce script."
    exit 1
  fi
fi

cat "$MODELE" > "$CIBLE"
activer
echo "C'est en ligne : https://$DOMAINE"
