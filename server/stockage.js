// Tout est rangé sur disque, un dossier par projet :
//   projets/<id>/projet.json     nom, réglages, ordre, fichiers et leur analyse
//   projets/<id>/medias/         photos, vidéos et musiques d'origine
//   projets/<id>/vignettes/      petites images (320 px) pour la liste
//   projets/<id>/apercus/        images moyennes (1280 px) pour l'aperçu
//   projets/<id>/proxys/         vidéos légères pour l'aperçu
//   projets/<id>/exports/        vidéos montées
import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
// Les chemins apparaissent dans les commandes ffmpeg : on les veut simples.
if (!/^[\w/.-]+$/.test(DATA_DIR)) throw new Error(`DATA_DIR doit être un chemin simple (lettres, chiffres, / . - _) : ${DATA_DIR}`);
export const PROJETS = path.join(DATA_DIR, 'projets');

export const nouvelId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(8), (b) => alphabet[b % 36]).join('');
};
export const idValide = (id) => typeof id === 'string' && /^[a-z0-9]{8}$/.test(id);

export const dossier = (id, ...suite) => {
  if (!idValide(id)) throw new Error('identifiant invalide');
  return path.join(PROJETS, id, ...suite);
};

export const TYPES = {
  photo: ['jpg', 'jpeg', 'png', 'webp'],
  video: ['mp4', 'mov', 'm4v', 'mkv', 'webm', '3gp'],
  musique: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus'],
};
export const typeDe = (nom) => {
  const ext = String(nom).toLowerCase().split('.').pop();
  for (const [type, liste] of Object.entries(TYPES)) if (liste.includes(ext)) return { type, ext };
  return null;
};

export const cheminMedia = (id, media) => dossier(id, 'medias', `${media.id}.${media.ext}`);

const lireJson = async (fichier, defaut = null) => {
  try { return JSON.parse(await readFile(fichier, 'utf8')); } catch { return defaut; }
};
// Écriture en deux temps : jamais de fichier à moitié écrit après une coupure.
const ecrireJson = async (fichier, donnees) => {
  const temporaire = `${fichier}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaire, JSON.stringify(donnees));
  await rename(temporaire, fichier);
};

export const lireProjet = (id) => lireJson(dossier(id, 'projet.json'));

// Les analyses finissent pendant que la page enregistre des réglages : chaque
// modification lit, change et réécrit le projet à son tour, jamais en même temps.
const verrous = new Map();
export const modifierProjet = (id, changer) => {
  const precedent = verrous.get(id) || Promise.resolve();
  const suite = precedent.catch(() => {}).then(async () => {
    const projet = await lireProjet(id);
    if (!projet) throw new Error('Projet introuvable.');
    const resultat = await changer(projet);
    await ecrireJson(dossier(id, 'projet.json'), projet);
    return resultat === undefined ? projet : resultat;
  });
  verrous.set(id, suite);
  suite.finally(() => { if (verrous.get(id) === suite) verrous.delete(id); }).catch(() => {});
  return suite;
};

export const REGLAGES_DEFAUT = { format: 'paysage', definition: 'auto', tempsPhoto: 2, tempsVideo: 4, musique: null, zoom: true };

export const creerProjet = async (nom) => {
  let id;
  do { id = nouvelId(); } while (await lireProjet(id));
  for (const sous of ['medias', 'vignettes', 'apercus', 'proxys', 'exports']) await mkdir(dossier(id, sous), { recursive: true });
  const projet = { id, nom: nettoyerTexte(nom, 80) || 'Sans titre', creee: Date.now(), reglages: { ...REGLAGES_DEFAUT }, ordre: null, medias: {} };
  await ecrireJson(dossier(id, 'projet.json'), projet);
  return projet;
};

export const listerProjets = async () => {
  await mkdir(PROJETS, { recursive: true });
  const noms = (await readdir(PROJETS)).filter(idValide);
  const projets = (await Promise.all(noms.map(lireProjet))).filter(Boolean);
  return projets.sort((a, b) => b.creee - a.creee);
};

export const supprimerProjet = (id) => rm(dossier(id), { recursive: true, force: true });

export const supprimerFichiersMedia = async (id, media) => {
  await Promise.all([
    rm(cheminMedia(id, media), { force: true }),
    rm(dossier(id, 'vignettes', `${media.id}.jpg`), { force: true }),
    rm(dossier(id, 'apercus', `${media.id}.jpg`), { force: true }),
    rm(dossier(id, 'proxys', `${media.id}.mp4`), { force: true }),
  ]);
};

export const nomExportValide = (nom) => typeof nom === 'string' && /^montage-\d{8}-\d{6}\.mp4$/.test(nom);
export const listerExports = async (id) => {
  let noms = [];
  try { noms = await readdir(dossier(id, 'exports')); } catch { return []; }
  const fichiers = [];
  for (const nom of noms.filter(nomExportValide)) {
    const s = await stat(dossier(id, 'exports', nom)).catch(() => null);
    if (s?.isFile()) fichiers.push({ nom, taille: s.size, date: s.mtimeMs });
  }
  return fichiers.sort((a, b) => b.date - a.date);
};

/* ------------------------------ Validation ------------------------------ */

export const nettoyerTexte = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const borne = (v, min, max, defaut) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
};

// Applique au projet les changements envoyés par la page, en les vérifiant.
export const appliquerChangements = (projet, brut) => {
  if (!brut || typeof brut !== 'object') throw new Error('changements invalides');
  if (brut.nom !== undefined) projet.nom = nettoyerTexte(brut.nom, 80) || projet.nom;
  const r = brut.reglages;
  if (r && typeof r === 'object') {
    const g = projet.reglages;
    if (['paysage', 'vertical'].includes(r.format)) g.format = r.format;
    if (['auto', '1080', '2160'].includes(r.definition)) g.definition = r.definition;
    if ([1, 2, 4].includes(r.tempsPhoto)) g.tempsPhoto = r.tempsPhoto;
    if ([2, 4, 8].includes(r.tempsVideo)) g.tempsVideo = r.tempsVideo;
    if (r.musique === null || (idValide(r.musique) && projet.medias[r.musique]?.type === 'musique')) g.musique = r.musique;
    if (typeof r.zoom === 'boolean') g.zoom = r.zoom;
  }
  if (brut.ordre === null) projet.ordre = null;
  else if (Array.isArray(brut.ordre)) {
    const vus = new Set();
    projet.ordre = brut.ordre.filter((id) => idValide(id) && projet.medias[id] && projet.medias[id].type !== 'musique' && !vus.has(id) && vus.add(id)).slice(0, 5000);
  }
  if (brut.medias && typeof brut.medias === 'object') {
    for (const [id, c] of Object.entries(brut.medias)) {
      const m = projet.medias[id];
      if (!idValide(id) || !m || !c || typeof c !== 'object') continue;
      if (['auto', 'garder', 'retirer'].includes(c.choix)) m.choix = c.choix;
      if (c.debutExtrait === null) m.debutExtrait = null;
      else if (c.debutExtrait !== undefined && m.type === 'video') m.debutExtrait = Math.round(borne(c.debutExtrait, 0, m.duree || 0, 0) * 1000) / 1000;
    }
  }
  return projet;
};
