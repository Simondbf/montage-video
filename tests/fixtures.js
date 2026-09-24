// Fichiers de test dont on connaît tout : dates, sens, netteté, doublon,
// passage secoué dans une vidéo, musique à 120 BPM.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executer, FFMPEG } from '../server/outils.js';

const lancer = async (args) => {
  const r = await executer(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.code !== 0) throw new Error(r.erreurs);
};

// Segment EXIF minimal (orientation, date de prise de vue), glissé juste
// après le début d'un JPEG.
export const ajouterExif = async (fichier, { orientation, date }) => {
  const entrees0 = [];
  const exif = [];
  if (orientation) entrees0.push({ tag: 0x0112, type: 3, n: 1, valeur: orientation });
  const dateOctets = date ? Buffer.from(`${date}\0`, 'ascii') : null;
  if (date) entrees0.push({ tag: 0x8769, type: 4, n: 1, valeur: 0 }); // pointeur vers l'IFD Exif
  entrees0.sort((a, b) => a.tag - b.tag);
  // TIFF petit-boutiste : en-tête (8) + IFD0 + IFD Exif + date.
  const tailleIfd = (n) => 2 + n * 12 + 4;
  const debutIfd0 = 8;
  const debutExif = debutIfd0 + tailleIfd(entrees0.length);
  const debutDate = debutExif + tailleIfd(1);
  const tiff = Buffer.alloc(debutDate + (dateOctets ? dateOctets.length : 0));
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(debutIfd0, 4);
  const ecrireIfd = (debut, entrees) => {
    tiff.writeUInt16LE(entrees.length, debut);
    entrees.forEach((e, i) => {
      const o = debut + 2 + i * 12;
      tiff.writeUInt16LE(e.tag, o); tiff.writeUInt16LE(e.type, o + 2); tiff.writeUInt32LE(e.n, o + 4);
      if (e.type === 3) tiff.writeUInt16LE(e.valeur, o + 8); else tiff.writeUInt32LE(e.valeur, o + 8);
    });
    tiff.writeUInt32LE(0, debut + 2 + entrees.length * 12);
  };
  for (const e of entrees0) if (e.tag === 0x8769) e.valeur = debutExif;
  ecrireIfd(debutIfd0, entrees0);
  if (date) {
    exif.push({ tag: 0x9003, type: 2, n: dateOctets.length, valeur: debutDate });
    ecrireIfd(debutExif, exif);
    dateOctets.copy(tiff, debutDate);
  }
  const corps = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(corps.length + 2, 2);
  const jpeg = await readFile(fichier);
  await writeFile(fichier, Buffer.concat([jpeg.subarray(0, 2), app1, corps, jpeg.subarray(2)]));
};

export const fabriquer = async (dossier) => {
  await mkdir(dossier, { recursive: true });
  const f = (nom) => path.join(dossier, nom);
  const image = async (nom, source, filtre = 'null') => lancer(['-f', 'lavfi', '-i', source, '-frames:v', '1', '-vf', `${filtre},format=yuvj420p`, '-q:v', '3', f(nom)]);
  // Photo nette 4:3, puis la même un peu floue deux secondes après (rafale).
  await image('IMG_20260815_100000.jpg', 'testsrc2=size=1600x1200:rate=1');
  await image('IMG_20260815_100002.jpg', 'testsrc2=size=1600x1200:rate=1', 'gblur=sigma=1.2');
  // Photo très floue.
  await image('IMG_20260815_100500.jpg', 'mandelbrot=size=1600x1200:rate=1', 'gblur=sigma=14');
  // Photo en hauteur : enregistrée couchée (bande rouge à gauche), orientation 6,
  // date seulement dans l'EXIF. Redressée, la bande rouge doit être en haut.
  await image('photo-sans-date.jpg', 'testsrc2=size=1600x1200:rate=1', 'drawbox=x=0:y=0:w=300:h=ih:color=red:t=fill');
  await ajouterExif(f('photo-sans-date.jpg'), { orientation: 6, date: '2026:08:15 10:20:00' });
  // Photo 16:9 : elle remplit l'écran.
  await image('IMG_20260815_110000.jpg', 'mandelbrot=size=1920x1080:rate=1');
  // Vidéo : 4 s secouées, puis 4 s stables.
  await lancer(['-f', 'lavfi', '-i', 'testsrc2=size=1360x800:rate=30:duration=8',
    '-vf', "crop=1280:720:x='if(lt(t,4),random(1)*80,40)':y='if(lt(t,4),random(2)*80,40)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', f('VID_20260815_101000.mp4')]);
  // Vidéo en hauteur, 3 s.
  await lancer(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=3', '-vf', 'format=yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', f('VID_20260815_103000.mp4')]);
  // Musique à 120 BPM : un coup grave sur chaque temps, à partir de 0,5 s.
  await lancer(['-f', 'lavfi', '-i', "aevalsrc='if(gte(t,0.5),0.8*sin(2*PI*70*t)*exp(-18*mod(t-0.5,0.5))+0.15*sin(2*PI*220*t),0)':s=44100:d=30",
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '160k', f('musique.mp3')]);
  return {
    dossier,
    photos: ['IMG_20260815_100000.jpg', 'IMG_20260815_100002.jpg', 'IMG_20260815_100500.jpg', 'photo-sans-date.jpg', 'IMG_20260815_110000.jpg'],
    videos: ['VID_20260815_101000.mp4', 'VID_20260815_103000.mp4'],
    musique: 'musique.mp3',
    // Ordre chronologique attendu.
    ordre: ['IMG_20260815_100000.jpg', 'IMG_20260815_100002.jpg', 'IMG_20260815_100500.jpg', 'VID_20260815_101000.mp4', 'photo-sans-date.jpg', 'VID_20260815_103000.mp4', 'IMG_20260815_110000.jpg'],
  };
};
