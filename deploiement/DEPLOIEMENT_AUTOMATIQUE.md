# Déploiement automatique de Montage Vidéo depuis GitHub

Le workflow `.github/workflows/tests-deploy.yml` teste toutes les PR et chaque push sur `main`. Si les tests passent, un déploiement est possible **uniquement** pour un push sur `main` et si la variable GitHub `DEPLOY_ENABLED` vaut `true`.

## Configuration initiale du VPS

1. Vérifier que `3013` appartient à Montage et que le code est cloné dans `/root/montage-video` sur la branche `main`. Vérifier `sudo ss -ltnp`, `docker ps` et `sudo nginx -t`. Ne pas modifier les répertoires `data/`, les projets, les exports ou `.env`.
2. Une fois la PR fusionnée et le script vérifié, placer le script dans un chemin **root-owned** indépendant du dépôt :
   ```bash
   sudo install -o root -g root -m 0755 /root/montage-video/deploiement/deploy-main.sh /usr/local/sbin/deploy-montage-video
   ```
   Réinstaller le script manuellement si sa logique change plus tard.
3. Utiliser un compte technique SSH dédié (par exemple `deploybot`) et une clé SSH dédiée. Le compte ne doit pas appartenir au groupe Docker ni pouvoir modifier le script root-owned.
4. Dans `sudo visudo -f /etc/sudoers.d/deploybot`, autoriser uniquement les commandes nécessaires :
   ```text
   deploybot ALL=(root) NOPASSWD: /usr/local/sbin/deploy-quiz-pub, /usr/local/sbin/deploy-montage-video
   ```
   Confirmer les droits et les restrictions d'accès du compte avant d'activer le workflow.

## Configuration du dépôt GitHub

Dans **Settings → Secrets and variables → Actions**, ajouter :
- Secrets : `VPS_HOST`, `VPS_SSH_USER`, `VPS_SSH_PRIVATE_KEY`, `VPS_SSH_KNOWN_HOSTS`.
- Variables : `VPS_SSH_PORT` (optionnel, 22 par défaut) et `DEPLOY_ENABLED=true` **uniquement une fois que tout est prêt**.

L'empreinte de la clé hôte SSH du VPS doit être vérifiée par un canal déjà fiable, et non acceptée aveuglément après `ssh-keyscan`. La clé privée SSH ne doit jamais être committée. Les mêmes paramètres peuvent être définis dans le dépôt `quiz-pub`, qui déploie séparément Quiz Pub et YT téléchargeur.

## Exécution et sécurité

Après un push sur `main` : `npm ci && npm test` avec FFmpeg → SSH → `sudo -n /usr/local/sbin/deploy-montage-video <sha>`. Le script prend un verrou, vérifie le SHA de `main`, refuse les modifications locales suivies, effectue un `git merge --ff-only` et relance uniquement le conteneur Montage par `docker compose up -d --build --wait`. Il vérifie ensuite `http://127.0.0.1:3013/api/session`.

Si nginx a changé dans le commit, le script relance `deploiement/nginx.sh`. Les données persistantes ne sont jamais supprimées par la procédure. Un éventuel échec stoppe le déploiement : examiner les logs GitHub et Docker ; aucun rollback automatique n'est effectué.

**Ce dépôt n'installe pas la connexion SSH et ne peut pas activer seul GitHub Actions sur le VPS.** Il faut réaliser cette préparation une fois, puis activer la variable `DEPLOY_ENABLED`.

Le registre des ports est centralisé dans `Simondbf/quiz-pub/deploiement/PORTS_VPS.md` et copié à `/etc/vps/ports.md` par le déploiement de Quiz Pub.
