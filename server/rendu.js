// Rendu de la vidéo, en deux étapes :
//   1. un petit clip par élément du plan, au nombre d'images exact
//      (les frontières tombent sur les temps de la musique) ;
//   2. les clips mis bout à bout sans réencodage, avec la musique.
// Une photo qui n'a pas la forme de l'écran est posée sur une copie
// d'elle-même, agrandie et floutée, plutôt que sur des bandes noires.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executer, FFMPEG, derniereLigne } from './outils.js';
import { filtreOrientation } from './medias.js';
import { FPS, FORMATS, remplit } from '../public/plan.js';

const n3 = (v) => (Math.round(v * 1000) / 1000).toString();

// Image composée à la taille W × H : [entree] → [sortie].
const composition = (entree, sortie, W, H, plein) => {
  if (plein) return [`[${entree}]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1[${sortie}]`];
  const w4 = 2 * Math.round(W / 8), h4 = 2 * Math.round(H / 8);
  return [
    `[${entree}]split=2[fa][fb]`,
    `[fa]scale=${w4}:${h4}:force_original_aspect_ratio=increase,crop=${w4}:${h4},gblur=sigma=6,eq=brightness=-0.12:saturation=0.8,scale=${W}:${H},setsar=1[fond]`,
    `[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[img]`,
    `[fond][img]overlay=(W-w)/2:(H-h)/2,format=yuv420p[${sortie}]`,
  ];
};

const fondus = (nbImages, { premier, dernier }) => {
  const f = [];
  if (premier) f.push('fade=t=in:st=0:d=0.5');
  if (dernier) f.push(`fade=t=out:st=${n3(Math.max(0, nbImages / FPS - 1))}:d=1`);
  return f.length ? `,${f.join(',')}` : '';
};

const encodage = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

export const commandeClipPhoto = ({ entree, media, element, format, sortie, premier, dernier }) => {
  const { largeur: W, hauteur: H } = FORMATS[format];
  const N = element.f1 - element.f0;
  const orient = filtreOrientation(media.orientation);
  // Composition au double de la taille : le zoom lent reste fluide.
  const graphe = [`[0:v]${orient ? `${orient},` : ''}format=yuv420p[src]`,
    ...composition('src', 'c', 2 * W, 2 * H, remplit(media.largeur, media.hauteur, format))];
  const z = element.zoom;
  const zoom = z ? `'${n3(z.de)}+${n3(z.a - z.de)}*on/${Math.max(1, N - 1)}'` : '1';
  const px = z ? n3(z.px) : '0.5', py = z ? n3(z.py) : '0.5';
  graphe.push(`[c]zoompan=z=${zoom}:x='(iw-iw/zoom)*${px}':y='(ih-ih/zoom)*${py}':d=${N}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p${fondus(N, { premier, dernier })}[v]`);
  return ['-hide_banner', '-nostats', '-y', '-noautorotate', '-i', entree, '-filter_complex', graphe.join(';'), '-map', '[v]', '-frames:v', String(N), ...encodage, sortie];
};

export const commandeClipVideo = ({ entree, media, element, format, sortie, premier, dernier }) => {
  const { largeur: W, hauteur: H } = FORMATS[format];
  const N = element.f1 - element.f0;
  const graphe = [`[0:v]setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p[src]`,
    ...composition('src', 'c', W, H, remplit(media.largeur, media.hauteur, format))];
  // Si la vidéo s'arrête un peu avant, sa dernière image est prolongée.
  graphe.push(`[c]tpad=stop_mode=clone:stop_duration=2,setsar=1,format=yuv420p${fondus(N, { premier, dernier })}[v]`);
  return ['-hide_banner', '-nostats', '-y', '-ss', n3(element.extrait), '-i', entree, '-filter_complex', graphe.join(';'), '-map', '[v]', '-frames:v', String(N), ...encodage, sortie];
};

export const commandeAssemblage = ({ liste, musique, decalage, duree, sortie }) => {
  const fondu = Math.min(1.5, duree / 4);
  const filtres = [
    ...(decalage > 0 ? ['afade=t=in:st=0:d=0.3'] : []),
    `afade=t=out:st=${n3(Math.max(0, duree - fondu))}:d=${n3(fondu)}`,
  ];
  return ['-hide_banner', '-nostats', '-y', '-f', 'concat', '-safe', '0', '-i', liste,
    ...(decalage > 0 ? ['-ss', n3(decalage)] : []), '-i', musique,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', filtres.join(','),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', n3(duree), '-movflags', '+faststart', sortie];
};

// Rend tout le plan. cheminMedia(media) donne le fichier d'origine.
export const rendre = async ({ plan, projet, cheminMedia, dossierTravail, sortie, progres = () => {}, signal }) => {
  if (plan.erreur) throw new Error({ musique: 'Ajoute une musique d\'abord.', 'musique-en-cours': 'La musique est encore en cours d\'analyse.', vide: 'Aucune photo ni vidéo à monter.' }[plan.erreur] || plan.erreur);
  const format = FORMATS[projet.reglages.format] ? projet.reglages.format : 'paysage';
  await rm(dossierTravail, { recursive: true, force: true });
  await mkdir(dossierTravail, { recursive: true });
  try {
    const clips = [];
    const nb = plan.elements.length;
    for (const [i, element] of plan.elements.entries()) {
      if (signal?.aborted) throw new Error('annulé');
      const media = projet.medias[element.id];
      const clip = path.join(dossierTravail, `clip-${String(i).padStart(5, '0')}.mp4`);
      const options = { entree: cheminMedia(media), media, element, format, sortie: clip, premier: i === 0, dernier: i === nb - 1 };
      const args = element.type === 'photo' ? commandeClipPhoto(options) : commandeClipVideo(options);
      const { code, erreurs } = await executer(FFMPEG, args, { signal });
      if (code !== 0) throw new Error(`Rendu impossible pour « ${media.nom} » : ${derniereLigne(erreurs)}`);
      clips.push(clip);
      progres(((i + 1) / nb) * 0.95, `Image ${i + 1} sur ${nb}`);
    }
    const liste = path.join(dossierTravail, 'liste.txt');
    await writeFile(liste, clips.map((c) => `file '${c}'`).join('\n'));
    progres(0.96, 'Assemblage avec la musique');
    const musique = projet.medias[plan.musique.id];
    const { code, erreurs } = await executer(FFMPEG, commandeAssemblage({
      liste, musique: cheminMedia(musique), decalage: plan.musique.decalage, duree: plan.duree, sortie,
    }), { signal });
    if (code !== 0) throw new Error(`Assemblage impossible : ${derniereLigne(erreurs)}`);
    progres(1);
  } finally {
    await rm(dossierTravail, { recursive: true, force: true });
  }
};
