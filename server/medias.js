// Analyse de chaque fichier envoyé.
//
// Photo : date de prise de vue, orientation, netteté (une photo floue a peu
// de contours nets), empreinte (deux photos d'une rafale ont presque la même),
// vignette et aperçu.
// Vidéo : durée, sens, et pour chaque quart de seconde une note qui
// récompense la netteté et pénalise les secousses : le montage prendra le
// meilleur passage. Plus une version légère pour l'aperçu dans la page.
// Musique : tempo, premier temps, « 1 » de la mesure (voir tempo.js).
import exifr from 'exifr';
import { rename } from 'node:fs/promises';
import { executer, imagesBrutes, FFMPEG, FFPROBE, derniereLigne } from './outils.js';
import { analyserMusique } from './tempo.js';

/* ------------------------------ Dates ------------------------------ */

// Les dates sont gardées en « heure locale du téléphone », écrite comme si
// c'était UTC : les photos et les vidéos d'un même voyage se rangent ainsi
// dans le bon ordre, quel que soit le fuseau.
const utc = (a, mo, j, h = 12, mi = 0, s = 0) => {
  const t = Date.UTC(+a, +mo - 1, +j, +h, +mi, +s);
  return Number.isFinite(t) && +a >= 1990 && +a <= 2100 && +mo >= 1 && +mo <= 12 && +j >= 1 && +j <= 31 ? t : null;
};

// Noms donnés par les téléphones Android : IMG_20260815_143012.jpg,
// VID_20260815_143512.mp4, PXL_20260815_143012345.jpg, 20260815_143012.jpg,
// Screenshot_20260815-143012.png…
export const dateDepuisNom = (nom) => {
  const m = String(nom).match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (m && +m[4] < 24 && +m[5] < 60 && +m[6] < 60) return utc(m[1], m[2], m[3], m[4], m[5], m[6]);
  return null;
};
// Date seule dans le nom (IMG-20260815-WA0003.jpg) : midi, faute de mieux.
export const jourDepuisNom = (nom) => {
  const m = String(nom).match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/);
  return m ? utc(m[1], m[2], m[3]) : null;
};
export const dateExif = (texte) => {
  const m = String(texte || '').match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? utc(...m.slice(1)) : null;
};

/* ------------------------------ Mesures ------------------------------ */

// Netteté : variance du laplacien, calculée sur une image de 512 px de large.
export const nettete = (img, W, H) => {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const v = 4 * img[i] - img[i - 1] - img[i + 1] - img[i - W] - img[i + W];
      s += v; s2 += v * v; n++;
    }
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
};

// Empreinte de 64 bits (« dHash ») : chaque bit dit si un pavé est plus clair
// que son voisin de droite, sur une grille de 9 × 8 pavés.
export const empreinte = (img, W, H) => {
  const pave = (cx, cy) => {
    const x0 = Math.floor((cx * W) / 9), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * W) / 9));
    const y0 = Math.floor((cy * H) / 8), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * H) / 8));
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += img[y * W + x];
    return s / ((x1 - x0) * (y1 - y0));
  };
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += pave(x, y) > pave(x + 1, y) ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
};

// Filtres ffmpeg qui redressent une photo selon son orientation EXIF.
export const filtreOrientation = (o) => ({ 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' })[o] || '';

const sonder = async (chemin) => {
  const { code, sortie, erreurs } = await executer(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', chemin]);
  if (code !== 0) throw new Error(`Fichier illisible : ${derniereLigne(erreurs)}`);
  const info = JSON.parse(sortie);
  const video = (info.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  return { info, video };
};

const images = async (chemin, avant, filtre, W, H, surImage) => {
  await imagesBrutes(['-hide_banner', '-nostats', ...avant, '-i', chemin, '-map', '0:v:0', '-vf', `${filtre},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], W * H, surImage);
};

const ffmpeg = async (args, message) => {
  const { code, erreurs } = await executer(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (code !== 0) throw new Error(`${message} : ${derniereLigne(erreurs)}`);
};

// Vignette 320 px et aperçu 1280 px, écrits d'abord sous un nom provisoire.
const vignettes = async (chemin, avant, filtre, apercu, vignette) => {
  await ffmpeg([...avant, '-i', chemin, '-frames:v', '1', '-vf', `${filtre ? `${filtre},` : ''}scale='min(1280,iw)':-2:flags=lanczos,format=yuvj420p`, '-q:v', '3', `${apercu}.tmp.jpg`], 'Aperçu impossible');
  await ffmpeg(['-i', `${apercu}.tmp.jpg`, '-vf', "scale='min(320,iw)':-2:flags=lanczos", '-q:v', '4', `${vignette}.tmp.jpg`], 'Vignette impossible');
  await rename(`${apercu}.tmp.jpg`, apercu);
  await rename(`${vignette}.tmp.jpg`, vignette);
};

/* ------------------------------ Photo ------------------------------ */

export const analyserPhoto = async (chemin, { nom, modifie }, { apercu, vignette }) => {
  const exif = (await exifr.parse(chemin, {
    pick: ['Orientation', 'DateTimeOriginal', 'CreateDate'], translateValues: false, reviveValues: false,
  }).catch(() => null)) || {};
  const orientation = Number.isInteger(exif.Orientation) && exif.Orientation >= 1 && exif.Orientation <= 8 ? exif.Orientation : 1;
  const { video } = await sonder(chemin);
  if (!video?.width) throw new Error('Image illisible.');
  const tourne = orientation >= 5;
  const largeur = tourne ? video.height : video.width;
  const hauteur = tourne ? video.width : video.height;
  const date = dateDepuisNom(nom) ?? dateExif(exif.DateTimeOriginal) ?? dateExif(exif.CreateDate) ?? jourDepuisNom(nom) ?? (Number.isFinite(modifie) ? modifie : null);
  // Mesures sur l'image telle qu'enregistrée (le sens n'y change rien).
  const W = 512, H = Math.max(8, 2 * Math.round((W * video.height) / video.width / 2));
  let gris = null;
  await images(chemin, ['-noautorotate'], 'null', W, H, (img) => { gris = img; });
  if (!gris) throw new Error('Image illisible.');
  await vignettes(chemin, ['-noautorotate'], filtreOrientation(orientation), apercu, vignette);
  return {
    date, largeur, hauteur, orientation,
    nettete: Math.round(nettete(gris, W, H) * 10) / 10,
    empreinte: empreinte(gris, W, H),
  };
};

/* ------------------------------ Vidéo ------------------------------ */

export const CADENCE_NOTES = 4; // notes par seconde de vidéo

// Note d'un instant : netteté (en logarithme) moins secousses (écart moyen
// avec l'image précédente, en niveaux de gris).
export const noteInstant = (net, mouvement) => Math.log1p(net) - 0.08 * mouvement;

export const analyserVideo = async (chemin, { nom, modifie }, { apercu, vignette, proxy }) => {
  const { info, video } = await sonder(chemin);
  if (!video?.width) throw new Error('Ce fichier ne contient pas de vidéo.');
  const duree = Number(info.format?.duration) || Number(video.duration) || 0;
  if (!(duree > 0.3)) throw new Error('Vidéo trop courte ou illisible.');
  const rotation = Math.abs(Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)) % 180;
  const largeur = rotation === 90 ? video.height : video.width;
  const hauteur = rotation === 90 ? video.width : video.height;
  const [a, b] = String(video.avg_frame_rate || video.r_frame_rate || '30/1').split('/').map(Number);
  const creation = Date.parse(video.tags?.creation_time || info.format?.tags?.creation_time || '');
  const date = dateDepuisNom(nom) ?? (Number.isFinite(creation) ? creation : null) ?? jourDepuisNom(nom) ?? (Number.isFinite(modifie) ? modifie : null);
  // Petites images grises, quatre par seconde (le sens est déjà appliqué).
  const W = 160, H = Math.max(8, 2 * Math.round((W * hauteur) / largeur / 2));
  const notes = [];
  let precedente = null;
  await images(chemin, [], `fps=${CADENCE_NOTES}`, W, H, (img) => {
    let mouvement = 0;
    if (precedente) {
      for (let i = 0; i < img.length; i++) mouvement += Math.abs(img[i] - precedente[i]);
      mouvement /= img.length;
    }
    notes.push(Math.round(noteInstant(nettete(img, W, H), mouvement) * 100) / 100);
    precedente = img;
  });
  // La première image n'a pas de précédente : on lui donne la note de la suivante.
  if (notes.length > 1) notes[0] = Math.min(notes[0], notes[1]);
  await vignettes(chemin, ['-ss', (duree * 0.3).toFixed(3)], '', apercu, vignette);
  await ffmpeg(['-i', chemin, '-an', '-sn', '-vf', "fps=30,scale='if(gte(iw,ih),640,-2)':'if(gte(iw,ih),-2,640)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-movflags', '+faststart', `${proxy}.tmp.mp4`], 'Version légère impossible');
  await rename(`${proxy}.tmp.mp4`, proxy);
  return {
    date, largeur, hauteur, duree: Math.round(duree * 1000) / 1000,
    fps: b ? Math.round((a / b) * 100) / 100 : 30,
    notes,
  };
};

/* ------------------------------ Musique ------------------------------ */

export { analyserMusique };
