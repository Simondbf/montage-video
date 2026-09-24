// Lancement des programmes externes (ffmpeg, ffprobe, yt-dlp) sans shell :
// les arguments ne sont jamais interprétés, quelle que soit l'adresse collée.
import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE || 'ffprobe';
export const YTDLP = process.env.YTDLP || 'yt-dlp';

// nice : le serveur héberge d'autres sites, qui doivent rester fluides.
const avecPriorite = (commande, args) =>
  process.platform === 'linux' ? ['nice', ['-n', '10', commande, ...args]] : [commande, args];

// Exécute une commande. surLigne reçoit chaque ligne de stdout et de stderr.
export const executer = (commande, args, { surLigne, signal, garder = 20000 } = {}) =>
  new Promise((resolve, reject) => {
    const [cmd, argv] = avecPriorite(commande, args);
    const enfant = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    let erreurs = '';
    const suivre = (flux, garderTexte) => {
      let reste = '';
      flux.setEncoding('utf8');
      flux.on('data', (morceau) => {
        garderTexte(morceau);
        if (!surLigne) return;
        reste += morceau;
        const lignes = reste.split(/\r\n|\r|\n/);
        reste = lignes.pop();
        lignes.forEach((l) => surLigne(l));
      });
      flux.on('end', () => { if (reste && surLigne) surLigne(reste); });
    };
    suivre(enfant.stdout, (t) => { if (sortie.length < 5_000_000) sortie += t; });
    suivre(enfant.stderr, (t) => { erreurs = (erreurs + t).slice(-garder); });
    const arreter = () => enfant.kill('SIGTERM');
    signal?.addEventListener('abort', arreter, { once: true });
    enfant.on('error', (e) => reject(new Error(`${commande} est introuvable ou ne peut pas être lancé (${e.message})`)));
    enfant.on('close', (code) => {
      signal?.removeEventListener('abort', arreter);
      if (signal?.aborted) return reject(new Error('annulé'));
      resolve({ code, sortie, erreurs });
    });
  });

// Lit des images brutes de taille fixe sur la sortie de ffmpeg, une par une.
// surLigne reçoit les lignes du journal de ffmpeg (sortie d'erreur).
export const imagesBrutes = (args, taille, surImage, { surLigne, signal } = {}) =>
  new Promise((resolve, reject) => {
    const [cmd, argv] = avecPriorite(FFMPEG, args);
    const enfant = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const arreter = () => enfant.kill('SIGTERM');
    signal?.addEventListener('abort', arreter, { once: true });
    let tampon = Buffer.alloc(0);
    let erreurs = '';
    let reste = '';
    enfant.stdout.on('data', (morceau) => {
      tampon = tampon.length ? Buffer.concat([tampon, morceau]) : morceau;
      while (tampon.length >= taille) {
        surImage(new Uint8Array(tampon.subarray(0, taille)));
        tampon = tampon.subarray(taille);
      }
    });
    enfant.stderr.setEncoding('utf8');
    enfant.stderr.on('data', (t) => {
      erreurs = (erreurs + t).slice(-4000);
      if (!surLigne) return;
      reste += t;
      const lignes = reste.split(/\r\n|\r|\n/);
      reste = lignes.pop();
      lignes.forEach((l) => surLigne(l));
    });
    enfant.on('error', reject);
    enfant.on('close', (code) => {
      signal?.removeEventListener('abort', arreter);
      if (reste && surLigne) surLigne(reste);
      if (signal?.aborted) return reject(new Error('annulé'));
      return code === 0 ? resolve() : reject(new Error(`ffmpeg a échoué : ${derniereLigne(erreurs)}`));
    });
  });

export const derniereLigne = (texte) => String(texte || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
