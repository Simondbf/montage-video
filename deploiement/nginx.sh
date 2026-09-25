#!/bin/bash
# Installe ou met à jour la configuration nginx des sites de ce dépôt :
#
#   bash deploiement/nginx.sh
#
# Pour chaque site : au premier lancement, il obtient aussi le certificat
# HTTPS (Let's Encrypt). On peut le relancer sans risque : si nginx refuse
# une configuration, l'ancienne est remise en place.
set -uo pipefail

# Domaine, port du conteneur, fichier de configuration dans deploiement/.
SITES=(
  "montage.soleiljaune.be 3013 nginx.conf"
)

DEPOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$(id -u)" -ne 0 ]; then echo "À lancer en root."; exit 1; fi

installer() {
  local DOMAINE="$1" PORT="$2" MODELE="$DEPOT/deploiement/$3"
  local CIBLE="/etc/nginx/sites-available/$DOMAINE"
  local LIEN="/etc/nginx/sites-enabled/$DOMAINE"
  local CERTIFICAT="/etc/letsencrypt/live/$DOMAINE/fullchain.pem"
  echo "== $DOMAINE"

  # Ne jamais écraser la configuration d'un autre site qui porterait ce nom.
  if [ -f "$CIBLE" ] && ! grep -q "deploiement/nginx.sh" "$CIBLE" && ! grep -q "127.0.0.1:$PORT" "$CIBLE"; then
    echo "$CIBLE existe déjà et sert un autre site : rien n'est changé."
    return 1
  fi

  # Copie de la configuration actuelle, pour pouvoir revenir en arrière.
  local ANCIENNE=""
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
      return 1
    fi
    systemctl reload nginx
  }

  if [ ! -f "$CERTIFICAT" ]; then
    echo "Premier lancement : demande du certificat HTTPS pour $DOMAINE."
    # Le temps que Let's Encrypt vérifie le domaine : le site en HTTP seulement.
    cat > "$CIBLE" <<FIN
# Provisoire, écrit par deploiement/nginx.sh le temps d'obtenir le certificat.
server {
    listen 80;
    server_name $DOMAINE;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
    }
}
FIN
    activer || return 1
    # certonly : certbot ne touche pas aux fichiers de configuration, qui
    # restent ceux du dépôt. Après chaque renouvellement, nginx est rechargé.
    if ! certbot certonly --nginx -d "$DOMAINE" --non-interactive --agree-tos --deploy-hook "systemctl reload nginx"; then
      echo "Certificat refusé. Vérifie que l'enregistrement DNS de $DOMAINE pointe bien vers ce serveur, puis relance ce script."
      return 1
    fi
  fi

  cat "$MODELE" > "$CIBLE"
  activer || return 1
  echo "C'est en ligne : https://$DOMAINE"
}

ECHECS=0
for site in "${SITES[@]}"; do
  # shellcheck disable=SC2086
  installer $site || ECHECS=$((ECHECS + 1))
done
exit "$ECHECS"
