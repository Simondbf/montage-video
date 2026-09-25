// Tests de bout en bout avec ffmpeg : des fichiers de test sont fabriqués,
// analysés, montés. Lancement : npm test (ffmpeg doit être disponible).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

const racine = await mkdtemp(path.join(tmpdir(), 'montage-'));
// Réglages lus au chargement des modules : à poser avant de les importer.
process.env.DATA_DIR = path.join(racine, 'data');
process.env.MOT_DE_PASSE = 'mot-de-passe-de-test';

const { executer, FFMPEG, FFPROBE } = await import('../server/outils.js');
const { fabriquer } = await import('./fixtures.js');
const { analyserPhoto, analyserVideo, analyserMusique } = await import('../server/medias.js');
const { planifier, FPS } = await import('../public/plan.js');
const { rendre } = await import('../server/rendu.js');
const { creerApp } = await import('../server/index.js');
const taches = await import('../server/taches.js');

const ffmpegPresent = await executer(FFMPEG, ['-version']).then((r) => r.code === 0).catch(() => false);
const sauter = ffmpegPresent ? false : 'ffmpeg absent';

let fx;
const analyses = {};
before(async () => {
  if (!ffmpegPresent) return;
  fx = await fabriquer(path.join(racine, 'fichiers'));
  for (const nom of [...fx.photos, ...fx.videos, fx.musique]) {
    const chemin = path.join(fx.dossier, nom);
    const sorties = { apercu: path.join(racine, `${nom}.apercu.jpg`), vignette: path.join(racine, `${nom}.vignette.jpg`), proxy: path.join(racine, `${nom}.proxy.mp4`) };
    analyses[nom] = nom.endsWith('.jpg') ? await analyserPhoto(chemin, { nom }, sorties)
      : nom.endsWith('.mp4') ? await analyserVideo(chemin, { nom }, sorties)
        : await analyserMusique(chemin);
  }
});

const sonde = async (fichier) => JSON.parse((await executer(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', fichier])).sortie);

// Toutes les images d'une vidéo, en petit et en niveaux de gris.
const imagesGrises = (fichier, W = 96, H = 54) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', fichier, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']);
  const morceaux = [];
  p.stdout.on('data', (d) => morceaux.push(d));
  p.on('error', reject);
  p.on('close', () => {
    const tout = Buffer.concat(morceaux);
    const images = [];
    for (let i = 0; i + W * H <= tout.length; i += W * H) images.push(tout.subarray(i, i + W * H));
    resolve(images);
  });
});
const imageCouleur = (fichier, t, W, H) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', fichier, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const morceaux = [];
  p.stdout.on('data', (d) => morceaux.push(d));
  p.on('error', reject);
  p.on('close', () => { const b = Buffer.concat(morceaux); resolve((x, y) => [...b.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]); });
});

const projetDepuisAnalyses = (reglages = {}, garder = null) => {
  const medias = {};
  let i = 0;
  for (const [nom, a] of Object.entries(analyses)) {
    if (garder && !garder.includes(nom)) continue;
    const id = `f${String(i++).padStart(7, '0')}`;
    const type = nom.endsWith('.jpg') ? 'photo' : nom.endsWith('.mp4') ? 'video' : 'musique';
    medias[id] = { id, type, nom, ext: nom.split('.').pop(), etat: 'pret', recu: i, choix: 'auto', chemin: path.join(fx.dossier, nom), ...a };
  }
  return { id: 'essai001', nom: 'Essai', reglages: { format: 'paysage', tempsPhoto: 2, tempsVideo: 4, musique: null, zoom: true, ...reglages }, ordre: null, medias };
};

test('analyse : dates, sens, netteté, rafale, meilleur passage, tempo', { skip: sauter }, () => {
  const t = (h, mi, s) => Date.UTC(2026, 7, 15, h, mi, s);
  assert.equal(analyses['IMG_20260815_100000.jpg'].date, t(10, 0, 0));
  assert.equal(analyses['photo-sans-date.jpg'].date, t(10, 20, 0), 'date prise dans l\'EXIF');
  assert.equal(analyses['VID_20260815_101000.mp4'].date, t(10, 10, 0));
  const debout = analyses['photo-sans-date.jpg'];
  assert.deepEqual([debout.orientation, debout.largeur, debout.hauteur], [6, 1200, 1600], 'photo redressée : en hauteur');
  assert.ok(analyses['IMG_20260815_100500.jpg'].nettete < 30, 'la photo floue est reconnue');
  assert.ok(analyses['IMG_20260815_100000.jpg'].nettete > 2 * analyses['IMG_20260815_100002.jpg'].nettete);
  const v = analyses['VID_20260815_101000.mp4'];
  assert.equal(v.duree, 8);
  assert.equal(v.notes.length, 32);
  const moyenne = (l) => l.reduce((a, b) => a + b, 0) / l.length;
  assert.ok(moyenne(v.notes.slice(18, 32)) > moyenne(v.notes.slice(2, 14)) + 0.5, 'la partie secouée est moins bien notée');
  assert.deepEqual([analyses['VID_20260815_103000.mp4'].largeur, analyses['VID_20260815_103000.mp4'].hauteur], [720, 1280]);
  const m = analyses['musique.mp3'];
  assert.equal(m.bpm, 120);
  assert.ok(Math.abs(m.premier - 0.5) < 0.02, `premier temps ${m.premier}`);
  const plan = planifier(projetDepuisAnalyses());
  assert.deepEqual(plan.ordre.map((id) => projetDepuisAnalyses().medias[id].nom), fx.ordre);
  const video = plan.elements.find((e) => e.type === 'video');
  assert.ok(video.extrait >= 4, `passage choisi dans la partie stable (${video.extrait})`);
});

test('rendu paysage : durée, images changées pile sur les temps, photo redressée sur fond flou', { skip: sauter }, async () => {
  const projet = projetDepuisAnalyses();
  const plan = planifier(projet);
  assert.equal(plan.elements.length, 5);
  const sortie = path.join(racine, 'montage.mp4');
  const etapes = [];
  await rendre({ plan, projet, cheminMedia: (m) => m.chemin, dossierTravail: path.join(racine, 'travail'), sortie, progres: (p) => etapes.push(p) });
  assert.equal(etapes.at(-1), 1);
  const info = await sonde(sortie);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.deepEqual([v.width, v.height, v.r_frame_rate], [1920, 1080, '30/1']);
  assert.equal(Number(v.nb_read_frames), plan.elements.at(-1).f1, 'nombre d\'images exact');
  assert.ok(a && a.codec_name === 'aac' && a.sample_rate === '48000');
  assert.ok(Math.abs(Number(info.format.duration) - plan.duree) < 0.05, `durée ${info.format.duration}`);
  // Changement d'image : l'écart entre deux images voisines est au plus fort
  // exactement à chaque frontière du plan.
  const images = await imagesGrises(sortie);
  const ecart = (i) => { let s = 0; for (let k = 0; k < images[i].length; k++) s += Math.abs(images[i][k] - images[i - 1][k]); return s / images[i].length; };
  for (const e of plan.elements.slice(1)) {
    const autour = [-3, -2, -1, 0, 1, 2, 3].map((d) => ({ d, v: ecart(e.f0 + d) }));
    const pic = autour.reduce((x, y) => (y.v > x.v ? y : x));
    assert.equal(pic.d, 0, `coupe attendue à l'image ${e.f0}, trouvée à ${e.f0 + pic.d}`);
  }
  // La photo en hauteur : bande rouge en haut, fond flou (pas noir) sur les côtés.
  const debout = plan.elements.find((e) => projet.medias[e.id].nom === 'photo-sans-date.jpg');
  const px = await imageCouleur(sortie, (debout.f0 + debout.f1) / 2 / FPS, 1920, 1080);
  const [r, g, b] = px(960, 40);
  assert.ok(r > 170 && g < 90 && b < 90, `haut de la photo redressée : ${[r, g, b]}`);
  const cote = px(120, 540);
  assert.ok(Math.max(...cote) > 40, `fond flou sur le côté, pas du noir : ${cote}`);
  // Fondu au noir au début et à la fin.
  const moyenne = (img) => img.reduce((s, x) => s + x, 0) / img.length;
  assert.ok(moyenne(images[0]) < 0.3 * moyenne(images[20]), 'fondu d\'entrée');
  assert.ok(moyenne(images.at(-1)) < 0.3 * moyenne(images.at(-35)), 'fondu de sortie');
});

test('rendu vertical en 4K : 2160 × 3840, la vidéo en hauteur remplit l\'écran', { skip: sauter }, async () => {
  const projet = projetDepuisAnalyses({ format: 'vertical', tempsVideo: 2, definition: '2160' }, ['VID_20260815_103000.mp4', 'IMG_20260815_110000.jpg', 'musique.mp3']);
  const plan = planifier(projet);
  const sortie = path.join(racine, 'vertical.mp4');
  await rendre({ plan, projet, cheminMedia: (m) => m.chemin, dossierTravail: path.join(racine, 'travail2'), sortie });
  const v = (await sonde(sortie)).streams.find((s) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [2160, 3840]);
  const px = await imageCouleur(sortie, 0.8, 2160, 3840);
  // testsrc2 en hauteur remplit tout : pas de fond flou, donc des couleurs vives jusqu'aux bords.
  const bord = px(40, 1920);
  assert.ok(Math.max(...bord) - Math.min(...bord) > 100, `bord de la vidéo, couleurs franches : ${bord}`);
});

test('API : projet, envoi, analyse, réglages, rendu, téléchargement, suppression', { skip: sauter }, async () => {
  const app = await creerApp();
  const serveur = app.listen(0, '127.0.0.1');
  await new Promise((r) => serveur.once('listening', r));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  let cookie = '';
  const appel = async (chemin, { methode = 'GET', corps, brut } = {}) => {
    const r = await fetch(base + chemin, {
      method: methode,
      headers: { ...(cookie ? { cookie } : {}), ...(corps !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: brut ?? (corps !== undefined ? JSON.stringify(corps) : undefined),
      duplex: brut ? 'half' : undefined,
    });
    const texte = r.status === 204 ? '' : await r.text();
    let json = null;
    try { json = JSON.parse(texte); } catch { /* pas du JSON */ }
    return { statut: r.status, json, entetes: r.headers, texte };
  };
  try {
    assert.equal((await appel('/api/projets')).statut, 401);
    assert.equal((await appel('/api/connexion', { methode: 'POST', corps: { motDePasse: 'faux' } })).statut, 401);
    const r = await fetch(`${base}/api/connexion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ motDePasse: 'mot-de-passe-de-test' }) });
    cookie = r.headers.get('set-cookie').split(';')[0];
    const projet = (await appel('/api/projets', { methode: 'POST', corps: { nom: 'Angleterre 2026' } })).json;
    assert.match(projet.id, /^[a-z0-9]{8}$/);
    for (const nom of [...fx.photos, ...fx.videos, fx.musique]) {
      const envoi = await appel(`/api/projets/${projet.id}/medias?nom=${encodeURIComponent(nom)}&modifie=1700000000000`, { methode: 'PUT', brut: await readFile(path.join(fx.dossier, nom)) });
      assert.equal(envoi.statut, 201, envoi.texte);
    }
    assert.equal((await appel(`/api/projets/${projet.id}/medias?nom=notes.pdf`, { methode: 'PUT', brut: Buffer.from('x') })).statut, 400);
    await taches.attendreTout();
    let lu = (await appel(`/api/projets/${projet.id}`)).json;
    const medias = Object.values(lu.projet.medias);
    assert.equal(medias.length, 8);
    assert.ok(medias.every((m) => m.etat === 'pret'), JSON.stringify(medias.map((m) => [m.nom, m.etat, m.message])));
    const musique = medias.find((m) => m.type === 'musique');
    assert.equal(lu.projet.reglages.musique, musique.id, 'la musique est choisie d\'office');
    for (const sorte of ['vignettes', 'apercus']) assert.equal((await fetch(`${base}/fichiers/${projet.id}/${sorte}/${medias[0].id}.jpg`, { headers: { cookie } })).status, 200);
    const video = medias.find((m) => m.type === 'video');
    const proxy = await fetch(`${base}/fichiers/${projet.id}/proxys/${video.id}.mp4`, { headers: { cookie, range: 'bytes=0-99' } });
    assert.equal(proxy.status, 206, 'la version légère se lit par morceaux');
    assert.equal((await fetch(`${base}/fichiers/${projet.id}/originaux/${musique.id}`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/fichiers/${projet.id}/vignettes/..%2F..%2Fprojet.json`, { headers: { cookie } })).status, 404);
    // Réglages : une photo par temps, et la photo floue gardée malgré tout.
    const floue = medias.find((m) => m.nom === 'IMG_20260815_100500.jpg');
    const patch = await appel(`/api/projets/${projet.id}`, { methode: 'PATCH', corps: { reglages: { tempsPhoto: 1 }, medias: { [floue.id]: { choix: 'garder' } } } });
    assert.equal(patch.statut, 200);
    const plan = planifier(patch.json.projet);
    assert.ok(plan.elements.some((e) => e.id === floue.id) && plan.elements.filter((e) => e.type === 'photo').every((e) => e.temps === 1));
    // Rendu.
    assert.equal((await appel(`/api/projets/${projet.id}/rendu`, { methode: 'POST' })).statut, 202);
    await taches.attendreTout();
    lu = (await appel(`/api/projets/${projet.id}`)).json;
    assert.equal(lu.exports.length, 1, JSON.stringify(lu.taches));
    const fichier = await fetch(`${base}/fichiers/${projet.id}/exports/${lu.exports[0].nom}`, { headers: { cookie } });
    assert.equal(fichier.status, 200);
    assert.match(decodeURIComponent(fichier.headers.get('content-disposition')), /attachment; filename\*=UTF-8''Angleterre 2026 - \d{8}\.mp4/);
    assert.ok((await fichier.arrayBuffer()).byteLength > 50000);
    // Suppressions.
    assert.equal((await appel(`/api/projets/${projet.id}/medias/${musique.id}`, { methode: 'DELETE' })).statut, 204);
    lu = (await appel(`/api/projets/${projet.id}`)).json;
    assert.equal(lu.projet.reglages.musique, null);
    assert.equal((await appel(`/api/projets/${projet.id}/rendu`, { methode: 'POST' })).json.erreur, 'Ajoute une musique d\'abord.');
    assert.equal((await appel(`/api/projets/${projet.id}/exports/${lu.exports[0].nom}`, { methode: 'DELETE' })).statut, 204);
    assert.equal((await appel(`/api/projets/${projet.id}`, { methode: 'DELETE' })).statut, 204);
    assert.equal((await appel(`/api/projets/${projet.id}`)).statut, 404);
  } finally {
    serveur.close();
  }
});

test('sans mot de passe : site ouvert', async () => {
  const avant = process.env.MOT_DE_PASSE;
  process.env.MOT_DE_PASSE = '';
  try {
    const app = await creerApp();
    const serveur = app.listen(0, '127.0.0.1');
    await new Promise((r) => serveur.once('listening', r));
    const base = `http://127.0.0.1:${serveur.address().port}`;
    assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { connecte: true, motDePasse: false });
    assert.equal((await fetch(`${base}/api/projets`)).status, 200);
    serveur.close();
    process.env.MOT_DE_PASSE = 'court';
    await assert.rejects(creerApp(), /trop court/);
  } finally {
    process.env.MOT_DE_PASSE = avant;
  }
});
