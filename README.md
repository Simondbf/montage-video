# Montage

Tes photos et tes vidéos de voyage, montées sur une musique, sans rien savoir du montage.

Tu crées un projet, tu envoies les photos, les vidéos et une musique (depuis le téléphone ou l'ordinateur). Le site :

- **range tout par date de prise de vue** : celle du nom de fichier des téléphones Android (`IMG_20260815_143012.jpg`, `VID_…`, `PXL_…`), sinon celle enregistrée dans la photo ;
- **redresse les photos** prises en hauteur ;
- **met de côté les photos floues** et, dans une rafale de photos presque identiques, **garde seulement la plus nette** ;
- **choisit le meilleur passage de chaque vidéo** : net et sans secousse, jamais la première demi-seconde (le doigt qui appuie sur le bouton) ;
- **trouve le tempo de la musique** et fait tomber **chaque changement d'image pile sur un temps** : une photo dure 1, 2 ou 4 temps, une vidéo 2, 4 ou 8 ;
- ajoute un **zoom lent sur les photos**, un fondu au début et à la fin, et pose les images qui n'ont pas la forme de l'écran sur une copie floue d'elles-mêmes plutôt que sur des bandes noires.

Tout reste modifiable : garder une photo mise de côté, en retirer une autre, changer l'ordre, choisir un autre passage d'une vidéo. Un aperçu joue la musique avec les images, pour juger du rythme avant de fabriquer la vraie vidéo.

La vidéo produite est en MP4 (H.264, AAC), 1920 × 1080 en paysage ou 1080 × 1920 en vertical, à 30 images par seconde.

## Installation sur le VPS

Tout tourne dans Docker. Le site écoute sur `127.0.0.1:3013` ; nginx le publie.
Les commandes supposent le dossier `/root/montage-video` et le sous-domaine
`montage.soleiljaune.be`.

### 1. Le site

```bash
cd /root
git clone https://github.com/Simondbf/montage-video.git
cd montage-video
mkdir -p data
chown 1000:1000 data           # le conteneur n'a pas les droits root
docker compose up -d --build
docker compose logs --tail 5   # « Montage écoute sur 0.0.0.0:3013 (sans mot de passe) »
```

Par défaut, il n'y a pas de mot de passe : quiconque connaît l'adresse voit les projets.
Pour en mettre un, crée un fichier `.env` dans le dossier avec la ligne
`MOT_DE_PASSE=…` (8 caractères au moins), puis `docker compose up -d`.

### 2. Le nom de domaine (Infomaniak)

Dans la zone DNS de `soleiljaune.be`, ajoute un enregistrement **A**
`montage` vers `178.105.235.106`.

### 3. nginx et le certificat

Le fichier de configuration est dans le dépôt, sous
`etc/nginx/sites-available/montage.soleiljaune.be`. Il doit se trouver sur le
serveur à ce même chemin, `/etc/nginx/sites-available/montage.soleiljaune.be`,
avant de l'activer :

```bash
ln -s /etc/nginx/sites-available/montage.soleiljaune.be /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d montage.soleiljaune.be
```

### Mise à jour

`maj` dans `/root/montage-video`.

### Place sur le disque

Les photos et vidéos d'origine restent sur le serveur, dans `data/projets/`,
avec une version légère de chaque vidéo pour l'aperçu. Supprimer un projet
depuis le site efface tout son dossier.

## Utilisation

1. **Créer un projet**, puis **Choisir des fichiers** : photos, vidéos et au moins une musique. On peut en envoyer des dizaines d'un coup, ou les glisser sur le cadre.
2. Attendre l'analyse (quelques secondes par fichier).
3. **Déroulé** : l'ordre de la vidéo. Les cartes grisées sont mises de côté, avec la raison ; « Garder » les remet, « Retirer » en enlève. Les flèches changent l'ordre ; « Revenir à l'ordre des dates » annule. Pour une vidéo, le curseur choisit le passage.
4. **Réglages** : paysage ou vertical, durée d'une photo et d'une vidéo en temps de musique, zoom lent.
5. **Aperçu** : « Lire » joue la musique avec les images. Toucher une carte y va directement.
6. **Fabriquer la vidéo**, puis **Télécharger**.

Si la musique est plus courte que toutes les images, le site met de côté les moins bonnes (les photos les moins nettes d'abord) et le signale. Il suffit alors de passer à 1 temps par photo, ou de prendre une musique plus longue.

## Fonctionnement

- `public/plan.js` : le plan de montage (ordre, tri automatique, place de chaque image sur les temps), le même pour la page et pour le serveur.
- `server/medias.js` : analyse des photos (date, orientation, netteté par variance du laplacien, empreinte « dHash » pour les rafales) et des vidéos (une note par quart de seconde : netteté moins secousses).
- `server/tempo.js` : tempo de la musique (même méthode que l'appli Cadence).
- `server/rendu.js` : un petit clip par image, au nombre d'images exact, puis tous les clips bout à bout avec la musique.

## Développement

```bash
npm install
npm test        # ffmpeg doit être installé
DATA_DIR=./data npm start
```
