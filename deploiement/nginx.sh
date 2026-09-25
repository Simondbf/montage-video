#!/bin/bash
# Installe ou met à jour la configuration nginx des sites de ce dépôt :
#
#   bash deploiement/nginx.sh
#
# Pour chaque site : au premier lancement, il obtient aussi le certificat
# HTTPS (Let's Encrypt). Avant de le demander, il vérifie lui-même que le
# domaine arrive bien sur ce site, et sinon explique ce qui répond à la place.
# On peut le relancer sans risque : si nginx refuse une configuration,
# l'ancienne est remise en place.
set -uo pipefail

# Domaine, port du conteneur, fichier de configuration dans deploiement/.
SITES=(
  "montage.soleiljaune.be 3013 nginx.conf"
)

DEPOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Dossier où certbot dépose ses fichiers de vérification (méthode « webroot »).
WEBROOT=/var/www/letsencrypt
if [ "$(id -u)" -ne 0 ]; then echo "À lancer en root."; exit 1; fi

# Adresses IP précises sur lesquelles d'autres sites nginx écoutent (par
# exemple « listen 178.105.235.106:80; »). nginx ne propose une connexion
# arrivée sur une de ces adresses qu'aux sites qui l'écoutent eux aussi :
# sans elles, nos sites seraient ignorés et un autre site répondrait.
adresses_precises() {
  nginx -T 2>/dev/null \
    | grep -oE "^[[:space:]]*listen[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:$1([^0-9]|\$)" \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | sort -u | tr '\n' ' '
}

# Recopie une configuration en ajoutant ces adresses à nos « listen ».
avec_adresses() {
  awk -v a80="$A80" -v a443="$A443" '
    { print }
    /^[[:space:]]*listen[[:space:]]+80;/      { n = split(a80, t, " ");  for (i = 1; i <= n; i++) print "    listen " t[i] ":80;" }
    /^[[:space:]]*listen[[:space:]]+443 ssl;/ { n = split(a443, t, " "); for (i = 1; i <= n; i++) print "    listen " t[i] ":443 ssl;" }
  '
}

# Quand le domaine n'arrive pas sur nginx par l'adresse publique : qui
# répond à sa place sur le port 80 ?
diagnostiquer_port80() {
  local DOMAINE="$1"
  echo "  --- Ce qui répond sur le port 80 (à m'envoyer si besoin) :"
  ss -ltnpH 'sport = :80' 2>/dev/null | awk '{print "  écoute : " $4 "  " $6}'
  if command -v docker >/dev/null; then
    docker ps --format '{{.Names}}  {{.Ports}}' 2>/dev/null | grep -E '(^|[ ,])(0\.0\.0\.0|\[?::\]?|[0-9.]+):80->' | sed 's/^/  conteneur qui publie le port 80 : /'
  fi
  nginx -T 2>/dev/null | grep -E '^[[:space:]]*listen[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:80([^0-9]|$)' | sed 's/^[[:space:]]*/  nginx, écoute sur une adresse précise : /'
  curl -s -m 10 -o /dev/null -D - "http://$DOMAINE/.well-known/acme-challenge/test" 2>/dev/null \
    | grep -iE '^(HTTP/|server:|content-type:|x-powered-by:)' | tr -d '\r' | sed 's/^/  réponse reçue : /'
  if command -v iptables >/dev/null; then
    iptables -t nat -S 2>/dev/null | grep -E -- '--dport 80( |$)' | sed 's/^/  règle réseau : /'
  fi
}

# Vérifie qu'un fichier déposé dans WEBROOT est bien servi pour ce domaine,
# d'abord par nginx sur ce serveur, puis par Internet (comme Let's Encrypt).
verifier_domaine() {
  local DOMAINE="$1"
  command -v curl >/dev/null || { echo "(curl absent : vérification sautée)"; return 0; }
  local JETON="verification-$(date +%s)-$RANDOM"
  local FICHIER="$WEBROOT/.well-known/acme-challenge/$JETON"
  mkdir -p "$WEBROOT/.well-known/acme-challenge"
  echo "$JETON" > "$FICHIER"
  local LOCAL PUBLIC CODE
  LOCAL="$(curl -s -m 10 -H "Host: $DOMAINE" "http://127.0.0.1/.well-known/acme-challenge/$JETON" 2>/dev/null)"
  PUBLIC="$(curl -s -m 15 "http://$DOMAINE/.well-known/acme-challenge/$JETON" 2>/dev/null)"
  CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code} depuis %{remote_ip}' "http://$DOMAINE/.well-known/acme-challenge/$JETON" 2>/dev/null)"
  rm -f "$FICHIER"
  if [ "$LOCAL" != "$JETON" ]; then
    echo "Sur ce serveur, nginx ne sert pas $DOMAINE avec la configuration de ce dépôt."
    echo "Autres fichiers nginx qui parlent de $DOMAINE (un doublon prend la place) :"
    grep -rl --exclude="$DOMAINE" "$DOMAINE" /etc/nginx/ 2>/dev/null | sed 's/^/  /' || true
    nginx -T 2>&1 | grep -i "conflicting server name" | sed 's/^/  /' || true
    return 1
  fi
  if [ "$PUBLIC" != "$JETON" ]; then
    echo "nginx est prêt, mais par Internet $DOMAINE n'arrive pas ici (réponse $CODE)."
    echo "  Adresse du domaine : $(getent ahostsv4 "$DOMAINE" 2>/dev/null | awk 'NR==1{print $1}')"
    echo "  Adresses de ce serveur : $(hostname -I 2>/dev/null)"
    local IP_DOMAINE
    IP_DOMAINE="$(getent ahostsv4 "$DOMAINE" 2>/dev/null | awk 'NR==1{print $1}')"
    if [ -n "$IP_DOMAINE" ] && hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$IP_DOMAINE"; then
      echo "  Le DNS est bon : c'est un autre programme de ce serveur qui répond à la place de nginx."
      diagnostiquer_port80 "$DOMAINE"
    else
      echo "  Vérifie l'enregistrement A chez Infomaniak, et qu'aucun AAAA (IPv6) ne pointe ailleurs."
    fi
    return 1
  fi
  return 0
}

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
    sleep 1
  }

  mkdir -p "$WEBROOT"
  A80="$(adresses_precises 80)"
  A443="$(adresses_precises 443)"
  if [ -n "$A80$A443" ]; then echo "D'autres sites nginx écoutent sur une adresse précise ($(echo $A80 $A443 | tr ' ' '\n' | sort -u | xargs)) : ce site l'écoute aussi."; fi
  if [ ! -f "$CERTIFICAT" ]; then
    echo "Premier lancement : demande du certificat HTTPS pour $DOMAINE."
    # Le temps d'obtenir le certificat : le site en HTTP, et le dossier de
    # vérification de Let's Encrypt servi tel quel.
    avec_adresses > "$CIBLE" <<FIN
# Provisoire, écrit par deploiement/nginx.sh le temps d'obtenir le certificat.
server {
    listen 80;
    server_name $DOMAINE;
    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
    }
    location / {
        proxy_pass http://127.0.0.1:$PORT;
    }
}
FIN
    activer || return 1
    # Vérification maison d'abord : un échec chez Let's Encrypt compte dans
    # leurs limites (5 par heure et par domaine).
    verifier_domaine "$DOMAINE" || { echo "Certificat non demandé. Relance ce script une fois le problème réglé."; return 1; }
    # certonly + webroot : certbot dépose un fichier dans WEBROOT et ne touche
    # jamais à la configuration nginx. Après chaque renouvellement, nginx est rechargé.
    if ! certbot certonly --webroot -w "$WEBROOT" -d "$DOMAINE" --non-interactive --agree-tos --deploy-hook "systemctl reload nginx"; then
      echo "Let's Encrypt a refusé le certificat de $DOMAINE (détails ci-dessus)."
      return 1
    fi
  fi

  avec_adresses < "$MODELE" > "$CIBLE"
  activer || return 1
  echo "C'est en ligne : https://$DOMAINE"
}

ECHECS=0
for site in "${SITES[@]}"; do
  # shellcheck disable=SC2086
  installer $site || ECHECS=$((ECHECS + 1))
done
exit "$ECHECS"
