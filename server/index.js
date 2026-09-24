// Montage : des photos, des vidéos et une musique, une vidéo calée sur le rythme.
import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as stock from './stockage.js';
import * as taches from './taches.js';
import { analyserPhoto, analyserVideo, analyserMusique } from './medias.js';
import { rendre } from './rendu.js';
import { planifier } from '../public/plan.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const TAILLE_MAX = Number(process.env.TAILLE_MAX_GO || 4) * 1024 ** 3;

/* ------------------------------ Connexion ------------------------------ */

const lireSecret = async () => {
  if (process.env.SECRET_SESSION) return process.env.SECRET_SESSION;
  const fichier = path.join(stock.DATA_DIR, '.secret');
  try { return (await readFile(fichier, 'utf8')).trim(); } catch { /* premier démarrage */ }
  const s = randomBytes(32).toString('hex');
  await mkdir(stock.DATA_DIR, { recursive: true });
  await writeFile(fichier, s, { mode: 0o600 });
  return s;
};
const empreinte = (v) => createHash('sha256').update(String(v)).digest();
const egal = (a, b) => timingSafeEqual(empreinte(a), empreinte(b));

const horodatage = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export const creerApp = async () => {
  // Sans mot de passe, le site est ouvert à quiconque connaît son adresse.
  const MOT_DE_PASSE = process.env.MOT_DE_PASSE || '';
  const OUVERT = MOT_DE_PASSE === '';
  if (!OUVERT && MOT_DE_PASSE.length < 8) throw new Error('MOT_DE_PASSE trop court (8 caractères au moins), ou vide pour un site sans mot de passe : voir le README');
  const cle = createHmac('sha256', await lireSecret()).update(MOT_DE_PASSE).digest();
  const DUREE_SESSION = 30 * 24 * 3600 * 1000;
  const signer = (expire) => `${expire}.${createHmac('sha256', cle).update(String(expire)).digest('base64url')}`;
  const sessionValide = (jeton) => {
    const [expire, sig] = String(jeton || '').split('.');
    if (!expire || !sig || !(Number(expire) > Date.now())) return false;
    return egal(signer(expire), jeton);
  };
  const lireCookie = (req, nom) => {
    for (const morceau of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = morceau.trim().split('=');
      if (k === nom) return decodeURIComponent(v.join('='));
    }
    return '';
  };
  const essais = new Map();

  const app = express();
  app.disable('x-powered-by');
  // nginx joint le conteneur par le réseau Docker : on lui fait confiance
  // pour l'adresse réelle du visiteur (limite des essais de mot de passe).
  app.set('trust proxy', ['loopback', 'uniquelocal']);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // Refuse les requêtes d'écriture venues d'un autre site.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      let hote = '';
      try { hote = new URL(req.headers.origin).host; } catch { /* origine illisible */ }
      if (hote !== req.headers.host) return res.status(403).json({ erreur: 'Origine refusée.' });
    }
    next();
  });
  const json = express.json({ limit: '2mb' });
  const enveloppe = (f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);

  app.post('/api/connexion', json, (req, res) => {
    if (OUVERT) return res.json({ connecte: true, motDePasse: false });
    const ip = req.ip || '?';
    const maintenant = Date.now();
    const e = (essais.get(ip) || []).filter((t) => maintenant - t < 10 * 60 * 1000);
    if (e.length >= 8) return res.status(429).json({ erreur: 'Trop d\'essais. Réessaie dans quelques minutes.' });
    if (!egal(req.body?.motDePasse ?? '', MOT_DE_PASSE)) {
      e.push(maintenant);
      essais.set(ip, e);
      return res.status(401).json({ erreur: 'Mot de passe incorrect.' });
    }
    essais.delete(ip);
    const securise = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `mv_session=${signer(maintenant + DUREE_SESSION)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DUREE_SESSION / 1000}${securise ? '; Secure' : ''}`);
    res.json({ connecte: true, motDePasse: true });
  });
  app.post('/api/deconnexion', (req, res) => {
    res.setHeader('Set-Cookie', 'mv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ connecte: false });
  });
  app.get('/api/session', (req, res) => res.json({ connecte: OUVERT || sessionValide(lireCookie(req, 'mv_session')), motDePasse: !OUVERT }));
  const protege = (req, res, next) => (OUVERT || sessionValide(lireCookie(req, 'mv_session')) ? next() : res.status(401).json({ erreur: 'Connexion requise.' }));
  app.use('/api', protege);
  app.use('/fichiers', protege);

  const avecId = (req, res, next) => (stock.idValide(req.params.id) ? next() : res.status(404).json({ erreur: 'Projet introuvable.' }));
  const avecMedia = (req, res, next) => (stock.idValide(req.params.mid) ? next() : res.status(404).json({ erreur: 'Fichier introuvable.' }));

  /* ------------------------------ Tâches ------------------------------ */

  const analyser = (id, mid) => taches.ajouter({
    type: 'analyse', projetId: id, libelle: 'Analyse',
    travail: async () => {
      const projet = await stock.lireProjet(id);
      const media = projet?.medias[mid];
      if (!media) return null;
      await stock.modifierProjet(id, (p) => { if (p.medias[mid]) p.medias[mid].etat = 'analyse'; });
      const chemin = stock.cheminMedia(id, media);
      const sorties = {
        apercu: stock.dossier(id, 'apercus', `${mid}.jpg`),
        vignette: stock.dossier(id, 'vignettes', `${mid}.jpg`),
        proxy: stock.dossier(id, 'proxys', `${mid}.mp4`),
      };
      const infos = { nom: media.nom, modifie: media.modifie };
      const resultat = media.type === 'photo' ? await analyserPhoto(chemin, infos, sorties)
        : media.type === 'video' ? await analyserVideo(chemin, infos, sorties)
          : await analyserMusique(chemin);
      await stock.modifierProjet(id, (p) => {
        const m = p.medias[mid];
        if (!m) return;
        Object.assign(m, resultat, { etat: 'pret', message: '' });
        // La première musique prête devient celle du montage.
        if (m.type === 'musique' && !p.reglages.musique) p.reglages.musique = mid;
      });
      return null;
    },
    surEchec: (erreur) => stock.modifierProjet(id, (p) => { if (p.medias[mid]) Object.assign(p.medias[mid], { etat: 'erreur', message: erreur }); }).catch(() => {}),
  });

  const lancerRendu = (id) => taches.ajouter({
    type: 'rendu', projetId: id, libelle: 'Fabrication de la vidéo',
    travail: async ({ progres, signal }) => {
      const projet = await stock.lireProjet(id);
      if (!projet) throw new Error('Projet introuvable.');
      const plan = planifier(projet);
      const nom = `montage-${horodatage()}.mp4`;
      const cible = stock.dossier(id, 'exports', nom);
      await rendre({
        plan, projet, signal, progres,
        cheminMedia: (m) => stock.cheminMedia(id, m),
        dossierTravail: stock.dossier(id, 'rendu'),
        sortie: `${cible}.tmp.mp4`,
      });
      await rename(`${cible}.tmp.mp4`, cible);
      return { fichier: nom };
    },
  });

  // Au redémarrage, les analyses interrompues reprennent.
  for (const p of await stock.listerProjets()) {
    for (const m of Object.values(p.medias)) if (m.etat === 'attente' || m.etat === 'analyse') analyser(p.id, m.id);
  }

  /* ------------------------------ Projets ------------------------------ */

  const resumeProjet = (p) => {
    const medias = Object.values(p.medias);
    return {
      id: p.id, nom: p.nom, creee: p.creee,
      photos: medias.filter((m) => m.type === 'photo').length,
      videos: medias.filter((m) => m.type === 'video').length,
      musiques: medias.filter((m) => m.type === 'musique').length,
      couverture: medias.find((m) => m.type !== 'musique' && m.etat === 'pret')?.id || null,
    };
  };

  app.get('/api/projets', enveloppe(async (req, res) => res.json((await stock.listerProjets()).map(resumeProjet))));
  app.post('/api/projets', json, enveloppe(async (req, res) => {
    res.status(201).json(resumeProjet(await stock.creerProjet(req.body?.nom)));
  }));
  app.get('/api/projets/:id', avecId, enveloppe(async (req, res) => {
    const projet = await stock.lireProjet(req.params.id);
    if (!projet) return res.status(404).json({ erreur: 'Projet introuvable.' });
    res.json({ projet, taches: taches.lister(req.params.id).filter((t) => t.type === 'rendu' || !t.finie).slice(0, 20), exports: await stock.listerExports(req.params.id) });
  }));
  app.patch('/api/projets/:id', avecId, json, enveloppe(async (req, res) => {
    const projet = await stock.modifierProjet(req.params.id, (p) => { stock.appliquerChangements(p, req.body); });
    res.json({ projet });
  }));
  app.delete('/api/projets/:id', avecId, enveloppe(async (req, res) => {
    taches.annulerPourProjet(req.params.id);
    await stock.supprimerProjet(req.params.id);
    res.status(204).end();
  }));

  // Envoi d'un fichier : le corps de la requête est le fichier lui-même.
  app.put('/api/projets/:id/medias', avecId, enveloppe(async (req, res) => {
    const projet = await stock.lireProjet(req.params.id);
    if (!projet) return res.status(404).json({ erreur: 'Projet introuvable.' });
    const nom = stock.nettoyerTexte(req.query.nom || 'fichier', 200);
    const genre = stock.typeDe(nom);
    if (!genre) return res.status(400).json({ erreur: `Format non pris en charge : ${nom}` });
    if (Number(req.headers['content-length'] || 0) > TAILLE_MAX) return res.status(413).json({ erreur: 'Fichier trop lourd.' });
    let mid;
    do { mid = stock.nouvelId(); } while (projet.medias[mid]);
    const media = { id: mid, type: genre.type, ext: genre.ext, nom, recu: Date.now(), etat: 'attente', message: '', choix: 'auto' };
    const modifie = Number(req.query.modifie);
    if (Number.isFinite(modifie) && modifie > 0) media.modifie = modifie;
    const cible = stock.cheminMedia(req.params.id, media);
    let recu = 0;
    const compteur = new Transform({
      transform(morceau, _enc, suite) {
        recu += morceau.length;
        if (recu > TAILLE_MAX) return suite(new Error('Fichier trop lourd.'));
        suite(null, morceau);
      },
    });
    try {
      await pipeline(req, compteur, createWriteStream(`${cible}.part`));
      if (!recu) throw new Error('Fichier vide.');
      await rename(`${cible}.part`, cible);
    } catch (e) {
      await rm(`${cible}.part`, { force: true });
      if (!res.headersSent) res.status(400).json({ erreur: ['Fichier trop lourd.', 'Fichier vide.'].includes(e.message) ? e.message : 'Envoi interrompu.' });
      return;
    }
    media.taille = recu;
    await stock.modifierProjet(req.params.id, (p) => { p.medias[mid] = media; });
    analyser(req.params.id, mid);
    res.status(201).json(media);
  }));
  app.delete('/api/projets/:id/medias/:mid', avecId, avecMedia, enveloppe(async (req, res) => {
    let media = null;
    await stock.modifierProjet(req.params.id, (p) => {
      media = p.medias[req.params.mid] || null;
      delete p.medias[req.params.mid];
      if (p.reglages.musique === req.params.mid) p.reglages.musique = null;
      if (Array.isArray(p.ordre)) p.ordre = p.ordre.filter((x) => x !== req.params.mid);
    });
    if (media) await stock.supprimerFichiersMedia(req.params.id, media);
    res.status(204).end();
  }));

  app.post('/api/projets/:id/rendu', avecId, enveloppe(async (req, res) => {
    const projet = await stock.lireProjet(req.params.id);
    if (!projet) return res.status(404).json({ erreur: 'Projet introuvable.' });
    const plan = planifier(projet);
    if (plan.erreur) {
      const messages = { musique: 'Ajoute une musique d\'abord.', 'musique-en-cours': 'La musique est encore en cours d\'analyse.', vide: 'Aucune photo ni vidéo à monter.' };
      return res.status(400).json({ erreur: messages[plan.erreur] || plan.erreur });
    }
    res.status(202).json(lancerRendu(req.params.id));
  }));
  app.delete('/api/projets/:id/exports/:nom', avecId, enveloppe(async (req, res) => {
    if (!stock.nomExportValide(req.params.nom)) return res.status(404).end();
    await rm(stock.dossier(req.params.id, 'exports', req.params.nom), { force: true });
    res.status(204).end();
  }));
  app.post('/api/taches/:tid/annuler', (req, res) => res.json({ annulee: taches.annuler(req.params.tid) }));

  /* ------------------------------ Fichiers ------------------------------ */

  const envoyer = (res, chemin, options = {}) => res.sendFile(chemin, { headers: { 'Cache-Control': 'private, max-age=86400', ...options.headers } }, (e) => {
    if (e && !res.headersSent) res.status(404).end();
  });
  app.get('/fichiers/:id/:sorte/:fichier', avecId, enveloppe(async (req, res) => {
    const { id, sorte, fichier } = req.params;
    const m = String(fichier).match(/^([a-z0-9]{8})\.(jpg|mp4)$/);
    if (sorte === 'exports') {
      if (!stock.nomExportValide(fichier)) return res.status(404).end();
      const projet = await stock.lireProjet(id);
      const joli = `${stock.nettoyerTexte(projet?.nom || 'montage', 60).replace(/[\\/:*?"<>|]/g, '')} - ${fichier.slice(8, 16)}.mp4`;
      return envoyer(res, stock.dossier(id, 'exports', fichier), req.query.voir === '1' ? {} : { headers: { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(joli)}` } });
    }
    if (sorte === 'originaux') {
      const projet = await stock.lireProjet(id);
      const media = projet?.medias[String(fichier)];
      if (!media) return res.status(404).end();
      return envoyer(res, stock.cheminMedia(id, media));
    }
    if (!m || !['vignettes', 'apercus', 'proxys'].includes(sorte)) return res.status(404).end();
    if ((sorte === 'proxys') !== (m[2] === 'mp4')) return res.status(404).end();
    return envoyer(res, stock.dossier(id, sorte, fichier));
  }));

  app.use(express.static(path.join(ICI, '..', 'public'), {
    setHeaders: (res, fichier) => { if (/\.(html|js|css)$/.test(fichier)) res.setHeader('Cache-Control', 'no-cache'); },
  }));

  app.use((err, req, res, _next) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ erreur: err.message === 'Projet introuvable.' ? err.message : 'Erreur du serveur.' });
  });
  return app;
};

// Lancement direct (node server/index.js), pas lors des tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3013);
  const hote = process.env.HOTE || '0.0.0.0';
  creerApp()
    .then((app) => app.listen(port, hote, () => console.log(`Montage écoute sur ${hote}:${port}${process.env.MOT_DE_PASSE ? '' : ' (sans mot de passe)'}`)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
