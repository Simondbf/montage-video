// Tempo d'une musique : même méthode que l'appli Cadence, vérifiée sur des
// morceaux de synthèse (chaque temps à moins de 2 ms de sa vraie place).
//   1. flux spectral (FFT de 1024 points, pas de 256) : les attaques ;
//   2. autocorrélation pondérée autour de 120 BPM : le tempo approximatif ;
//   3. grille régulière ajustée sur tout le morceau : tempo précis et phase ;
//   4. énergie des basses sur chaque temps : où tombe le « 1 » de la mesure.
import { spawn } from 'node:child_process';
import { FFMPEG } from './outils.js';


const preparerFft = (n) => {
  const niveaux = Math.round(Math.log2(n));
  const inv = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0, x = i;
    for (let b = 0; b < niveaux; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    inv[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const re = new Float64Array(n), im = new Float64Array(n);
  return (entree) => {
    for (let i = 0; i < n; i++) { re[inv[i]] = entree[i]; im[inv[i]] = 0; }
    for (let taille = 2; taille <= n; taille <<= 1) {
      const demi = taille >> 1, pas = n / taille;
      for (let i = 0; i < n; i += taille) {
        for (let j = 0, k = 0; j < demi; j++, k += pas) {
          const a = i + j, b = a + demi;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    return [re, im];
  };
};

// Soustrait la moyenne locale et garde le positif : ne restent que les attaques.
const redresser = (x, rayon) => {
  const n = x.length, sortie = new Float32Array(n);
  let somme = 0, a = 0, b = -1;
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - rayon), hi = Math.min(n - 1, t + rayon);
    while (b < hi) somme += x[++b];
    while (a < lo) somme -= x[a++];
    sortie[t] = Math.max(0, x[t] - somme / (hi - lo + 1));
  }
  return sortie;
};

const lisser = (x, sigma) => {
  const r = Math.ceil(sigma * 3), noyau = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); noyau.push(v); s += v; }
  const n = x.length, sortie = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let v = 0;
    for (let i = -r; i <= r; i++) { const j = t + i; if (j >= 0 && j < n) v += x[j] * noyau[i + r]; }
    sortie[t] = v / s;
  }
  return sortie;
};

// Moyenne de l'enveloppe aux instants d'une grille (période et phase en trames).
const scoreGrille = (env, a, b, per, phase) => {
  let s = 0, n = 0;
  let x = phase + Math.ceil((a - phase) / per) * per;
  for (; x < b - 1; x += per) {
    const i = x | 0, f = x - i;
    s += env[i] * (1 - f) + env[i + 1] * f;
    n++;
  }
  return n ? s / n : 0;
};

// Le pic de l'enveloppe arrive 5 ms avant le début réel de l'attaque :
// mesuré sur des morceaux de synthèse dont chaque temps est connu.
export const RETARD_ANALYSE = 0.005;

export const meilleurUn = (envB, rate, bpm, premier, mesure, a, b) => {
  const per = (60 / bpm) * rate;
  const scores = [];
  for (let j = 0; j < mesure; j++) {
    const phase = premier * rate + j * per;
    scores.push(scoreGrille(envB, a, b, per * mesure, phase));
  }
  let meilleur = 0;
  scores.forEach((s, j) => { if (s > scores[meilleur]) meilleur = j; });
  return meilleur;
};

const pause = () => new Promise((r) => setTimeout(r, 0));

export const analyser = async (mono, sr, progres = () => {}) => {
  const N = 1024, H = 256, rate = sr / H;
  if (mono.length < sr * 6) throw new Error('trop-court');
  const nT = Math.floor(mono.length / H) + 1;
  const fft = preparerFft(N);
  const fenetre = new Float64Array(N);
  for (let i = 0; i < N; i++) fenetre[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const cadre = new Float64Array(N);
  const nb = N / 2;
  const kBas = Math.max(2, Math.round((180 * N) / sr));
  let prec = new Float32Array(nb + 1), cour = new Float32Array(nb + 1);
  const flux = new Float32Array(nT), fluxBas = new Float32Array(nT), rms = new Float32Array(nT);

  for (let t = 0; t < nT; t++) {
    const debut = t * H - N / 2;
    for (let i = 0; i < N; i++) {
      const j = debut + i;
      cadre[i] = j >= 0 && j < mono.length ? mono[j] * fenetre[i] : 0;
    }
    let e = 0;
    for (let i = 0, j = t * H - H / 2; i < H; i++, j++) if (j >= 0 && j < mono.length) e += mono[j] * mono[j];
    rms[t] = Math.sqrt(e / H);
    const [re, im] = fft(cadre);
    let f = 0, fb = 0;
    for (let k = 1; k <= nb; k++) {
      const m = Math.log1p(10 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      const d = m - prec[k];
      cour[k] = m;
      if (d > 0) { f += d; if (k <= kBas) fb += d; }
    }
    flux[t] = t ? f : 0;
    fluxBas[t] = t ? fb : 0;
    const echange = prec; prec = cour; cour = echange;
    if (t % 1500 === 0) { progres((t / nT) * 0.75); await pause(); }
  }

  // Zone où il y a vraiment du son.
  const tri = Float32Array.from(rms).sort();
  const ref = tri[Math.floor(0.95 * (nT - 1))];
  if (!(ref > 1e-4)) throw new Error('silence');
  const seuil = ref * 0.03;
  let a = 0, b = nT - 1;
  while (a < nT && rms[a] < seuil) a++;
  while (b > a && rms[b] < seuil) b--;
  if (b - a < rate * 5) throw new Error('trop-court');

  const env = lisser(redresser(flux, Math.round(0.1 * rate)), 1.2);
  const envB = lisser(redresser(fluxBas, Math.round(0.1 * rate)), 1.5);
  progres(0.8); await pause();

  // 1) Tempo approximatif : autocorrélation, pondérée autour de 120 BPM.
  let moyenne = 0;
  for (let t = a; t <= b; t++) moyenne += env[t];
  moyenne /= b - a + 1;
  const lagMin = Math.floor((rate * 60) / 210), lagMax = Math.ceil((rate * 60) / 50);
  const corr = new Float64Array(lagMax + 2);
  for (let L = lagMin - 1; L <= lagMax + 1; L++) {
    let s = 0;
    for (let t = a; t + L <= b; t++) s += (env[t] - moyenne) * (env[t + L] - moyenne);
    corr[L] = s / (b - a + 1 - L);
  }
  let meilleurL = lagMin, meilleurS = -Infinity;
  for (let L = lagMin; L <= lagMax; L++) {
    const bpm = (60 * rate) / L;
    const poids = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const s = corr[L] * poids;
    if (s > meilleurS && corr[L] >= corr[L - 1] && corr[L] >= corr[L + 1]) { meilleurS = s; meilleurL = L; }
  }
  const y0 = corr[meilleurL - 1], y1 = corr[meilleurL], y2 = corr[meilleurL + 1];
  const denom = y0 - 2 * y1 + y2;
  const Lfin = meilleurL + (denom < 0 ? (0.5 * (y0 - y2)) / denom : 0);
  const bpm0 = (60 * rate) / Lfin;
  progres(0.85); await pause();

  // 2) Tempo précis et phase : la grille régulière qui tombe le mieux sur
  //    les attaques, sur toute la durée du morceau.
  let best = { bpm: bpm0, phase: 0, s: -1 };
  for (let bpm = bpm0 * 0.98; bpm <= bpm0 * 1.02; bpm += 0.02) {
    const per = (60 * rate) / bpm;
    for (let ph = 0; ph < per; ph += 0.5) {
      const s = scoreGrille(env, a, b, per, ph);
      if (s > best.s) best = { bpm, phase: ph, s };
    }
  }
  progres(0.93); await pause();
  const affiner = (centre) => {
    let r = centre;
    for (let bpm = centre.bpm - 0.03; bpm <= centre.bpm + 0.03; bpm += 0.002) {
      const per = (60 * rate) / bpm;
      for (let ph = centre.phase - 1.2; ph <= centre.phase + 1.2; ph += 0.1) {
        const s = scoreGrille(env, a, b, per, ph);
        if (s > r.s) r = { bpm, phase: ph, s };
      }
    }
    return r;
  };
  best = affiner(best);

  // Les morceaux produits sur ordinateur ont presque toujours un tempo entier.
  const entier = Math.round(best.bpm);
  if (Math.abs(best.bpm - entier) < 0.06) {
    const per = (60 * rate) / entier;
    let e = { bpm: entier, phase: best.phase, s: -1 };
    for (let ph = best.phase - 2; ph <= best.phase + 2; ph += 0.1) {
      const s = scoreGrille(env, a, b, per, ph);
      if (s > e.s) e = { bpm: entier, phase: ph, s };
    }
    if (e.s >= best.s * 0.985) best = e;
  }

  const bpm = best.bpm;
  const perS = 60 / bpm;
  let premier = best.phase / rate + RETARD_ANALYSE;
  const debutActif = a / rate, finActif = b / rate;
  premier += Math.ceil((debutActif - perS / 2 - premier) / perS) * perS;
  const decalage = meilleurUn(envB, rate, bpm, premier, 4, a, b);
  progres(1);
  return {
    bpm, premier, decalage, debutActif, finActif,
    duree: mono.length / sr, rate, envB, a, b,
    clarte: best.s / (moyenne || 1),
  };
};

// Décode une musique en échantillons mono à 22 050 Hz.
export const decoder = (chemin, sr = 22050) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', chemin, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-']);
  const morceaux = [];
  let erreurs = '';
  p.stdout.on('data', (d) => morceaux.push(d));
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (t) => { erreurs = (erreurs + t).slice(-2000); });
  p.on('error', reject);
  p.on('close', (code) => {
    if (code !== 0) return reject(new Error(`Musique illisible : ${erreurs.trim().split('\n').pop() || code}`));
    const tout = Buffer.concat(morceaux);
    const utile = tout.length - (tout.length % 4);
    resolve(new Float32Array(tout.buffer.slice(tout.byteOffset, tout.byteOffset + utile)));
  });
});

// Tempo, premier temps et « 1 » de la mesure d'un fichier audio.
export const analyserMusique = async (chemin) => {
  const sr = 22050;
  const mono = await decoder(chemin, sr);
  let r;
  try { r = await analyser(mono, sr); } catch (e) {
    const raisons = { 'trop-court': 'Musique trop courte (dix secondes au moins).', silence: 'La musique ne contient que du silence.' };
    throw new Error(raisons[e.message] || e.message);
  }
  return {
    duree: Math.round((mono.length / sr) * 1000) / 1000,
    bpm: Math.round(r.bpm * 1000) / 1000,
    premier: Math.round(r.premier * 10000) / 10000,
    decalage: r.decalage,
    clarte: Math.round(r.clarte * 100) / 100,
    finSon: Math.round(r.finActif * 1000) / 1000,
  };
};
