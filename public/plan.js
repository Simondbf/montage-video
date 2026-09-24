// Le plan de montage, calculé de la même façon par la page (aperçu, liste)
// et par le serveur (rendu de la vidéo).
//
// 1. Les photos et vidéos prêtes, dans l'ordre chronologique (ou l'ordre
//    choisi à la main).
// 2. Mises de côté d'office : les photos floues, et dans une rafale de photos
//    presque identiques, toutes sauf la plus nette. On peut les reprendre.
// 3. Chaque photo dure un nombre de temps de la musique (2 par défaut),
//    chaque vidéo un nombre de temps (4 : une mesure) pris dans son meilleur
//    passage. Tous les changements d'image tombent sur un temps.
// 4. S'il y a plus d'images que de musique, les moins bonnes sont mises de
//    côté, les photos avant les vidéos.

export const FPS = 30;
export const FORMATS = {
  paysage: { largeur: 1920, hauteur: 1080, nom: 'Paysage 16:9' },
  vertical: { largeur: 1080, hauteur: 1920, nom: 'Vertical 9:16' },
};
// Une image dont les proportions sont proches de l'écran le remplit (quitte
// à rogner un peu) ; sinon elle est posée sur un fond flou.
export const remplit = (largeur, hauteur, format) => {
  const f = FORMATS[format] || FORMATS.paysage;
  return largeur > 0 && hauteur > 0 && Math.abs(Math.log((largeur / hauteur) / (f.largeur / f.hauteur))) < Math.log(1.2);
};

export const SEUIL_FLOU = 30;
export const ECART_DOUBLON = 10;        // bits d'empreinte différents, sur 64
export const DELAI_RAFALE = 120 * 1000; // deux photos d'une rafale : moins de 2 minutes d'écart
export const CADENCE_NOTES = 4;
export const RAISONS = {
  floue: 'floue',
  doublon: 'presque identique à sa voisine',
  retiree: 'retirée à la main',
  place: 'plus de place dans la musique',
};

const mediane = (v) => {
  if (!v.length) return 0;
  const t = [...v].sort((a, b) => a - b);
  return t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
};

export const ecartEmpreintes = (a, b) => {
  let n = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
};

const hachage = (texte) => {
  let h = 2166136261;
  for (const c of String(texte)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
};

export const visuels = (projet) => Object.values(projet.medias || {}).filter((m) => m.type === 'photo' || m.type === 'video');
export const musiques = (projet) => Object.values(projet.medias || {}).filter((m) => m.type === 'musique');

const parDate = (a, b) => (a.date ?? Infinity) - (b.date ?? Infinity) || (a.recu || 0) - (b.recu || 0) || String(a.nom).localeCompare(String(b.nom));

// Ordre chronologique, ou celui choisi à la main. Un fichier ajouté après
// coup vient se placer après le dernier élément plus ancien que lui.
export const ordonner = (projet) => {
  const prets = visuels(projet).filter((m) => m.etat === 'pret').sort(parDate);
  if (!Array.isArray(projet.ordre) || !projet.ordre.length) return prets;
  const parId = new Map(prets.map((m) => [m.id, m]));
  const liste = projet.ordre.filter((id) => parId.has(id)).map((id) => parId.get(id));
  const places = new Set(liste.map((m) => m.id));
  for (const m of prets) {
    if (places.has(m.id)) continue;
    let i = liste.length;
    if (m.date != null) {
      i = 0;
      liste.forEach((x, k) => { if ((x.date ?? -Infinity) <= m.date) i = k + 1; });
    }
    liste.splice(i, 0, m);
    places.add(m.id);
  }
  return liste;
};

// Photos floues et rafales : une raison par photo concernée.
export const reperer = (liste) => {
  const raisons = new Map();
  const photos = liste.filter((m) => m.type === 'photo' && Number.isFinite(m.nettete));
  const med = mediane(photos.map((p) => p.nettete));
  for (const p of photos) {
    if (p.nettete < SEUIL_FLOU || (photos.length >= 5 && p.nettete < 0.2 * med)) raisons.set(p.id, 'floue');
  }
  let groupe = [];
  const fermer = () => {
    if (groupe.length > 1) {
      const garde = groupe.reduce((a, b) => (b.nettete > a.nettete ? b : a));
      for (const p of groupe) if (p !== garde && !raisons.has(p.id)) raisons.set(p.id, 'doublon');
    }
    groupe = [];
  };
  for (const m of liste) {
    if (m.type !== 'photo' || !m.empreinte) { fermer(); continue; }
    const prec = groupe[groupe.length - 1];
    const proche = prec && ecartEmpreintes(prec.empreinte, m.empreinte) <= ECART_DOUBLON
      && (m.date == null || prec.date == null || Math.abs(m.date - prec.date) <= DELAI_RAFALE);
    if (!proche) fermer();
    groupe.push(m);
  }
  fermer();
  return raisons;
};

// Début du meilleur passage d'une vidéo, pour une durée donnée : la plus
// haute note moyenne, sans la première ni la dernière demi-seconde (le doigt
// qui appuie sur le bouton).
export const meilleurPassage = (notes, duree, longueur) => {
  const libre = duree - longueur;
  if (!(libre > 0.05)) return 0;
  const marge = Math.min(0.5, libre / 2);
  if (!Array.isArray(notes) || !notes.length) return Math.round((libre / 2) * 1000) / 1000;
  const n = Math.max(1, Math.round(longueur * CADENCE_NOTES));
  let meilleur = marge, note = -Infinity;
  for (let d = marge; d <= libre - marge + 1e-9; d += 1 / CADENCE_NOTES) {
    const i0 = Math.round(d * CADENCE_NOTES);
    let s = 0, k = 0;
    for (let i = i0; i < i0 + n && i < notes.length; i++) { s += notes[i]; k++; }
    const moyenne = k ? s / k : -Infinity;
    if (moyenne > note + 1e-9) { note = moyenne; meilleur = d; }
  }
  return Math.round(meilleur * 1000) / 1000;
};

export const musiqueChoisie = (projet) => {
  const pretes = musiques(projet).filter((m) => m.etat === 'pret');
  return pretes.find((m) => m.id === projet.reglages?.musique) || pretes.sort(parDate)[0] || null;
};

export const planifier = (projet) => {
  const r = projet.reglages || {};
  const tempsPhoto = [1, 2, 4].includes(r.tempsPhoto) ? r.tempsPhoto : 2;
  const tempsVideo = [2, 4, 8].includes(r.tempsVideo) ? r.tempsVideo : 4;
  const liste = ordonner(projet);
  const auto = reperer(liste);
  const musique = musiqueChoisie(projet);
  const bpm = musique?.bpm || 120;
  const per = 60 / bpm;
  const ecartes = new Map();
  let choisis = [];
  for (const m of liste) {
    if (m.choix === 'retirer') ecartes.set(m.id, 'retiree');
    else if (m.choix !== 'garder' && auto.has(m.id)) ecartes.set(m.id, auto.get(m.id));
    else choisis.push(m);
  }
  const temps = (m) => (m.type === 'video' ? Math.max(1, Math.min(tempsVideo, Math.floor(m.duree / per + 1e-6))) : tempsPhoto);

  // Place disponible : du premier temps jusqu'à la fin du son.
  // Une longue introduction est coupée : on démarre un temps avant le premier.
  const premier = musique ? musique.premier : 0;
  const decalage = musique && premier > 3 ? premier - per : 0;
  const fin = musique ? (musique.finSon || musique.duree) : Infinity;
  const dispo = musique ? Math.max(0, Math.floor((fin - premier) / per)) : Infinity;
  let total = choisis.reduce((s, m) => s + temps(m), 0);
  if (total > dispo) {
    // Les moins bonnes d'abord : photos avant vidéos, les moins nettes en
    // premier, ce qu'on a gardé à la main en dernier recours.
    const candidats = [...choisis].sort((a, b) => (a.choix === 'garder') - (b.choix === 'garder')
      || (a.type === 'video') - (b.type === 'video')
      || (a.nettete ?? 0) - (b.nettete ?? 0));
    const retires = new Set();
    for (const m of candidats) {
      if (total <= dispo) break;
      retires.add(m.id);
      ecartes.set(m.id, 'place');
      total -= temps(m);
    }
    choisis = choisis.filter((m) => !retires.has(m.id));
  }

  // Frontières sur la grille des temps, arrondies à l'image près.
  const elements = [];
  let temps0 = 0;
  let photos = 0;
  choisis.forEach((m, i) => {
    const n = temps(m);
    const debut = i === 0 ? 0 : premier - decalage + temps0 * per;
    temps0 += n;
    const finE = premier - decalage + temps0 * per;
    const e = { id: m.id, type: m.type, nom: m.nom, temps: n, debut: arr(debut), fin: arr(finE) };
    e.f0 = Math.round(debut * FPS);
    e.f1 = Math.round(finE * FPS);
    if (m.type === 'video') {
      const longueur = (e.f1 - e.f0) / FPS;
      const max = Math.max(0, m.duree - longueur);
      const voulu = Number.isFinite(m.debutExtrait) ? m.debutExtrait : meilleurPassage(m.notes, m.duree, longueur);
      e.extrait = arr(Math.min(max, Math.max(0, voulu)));
      e.extraitAuto = !Number.isFinite(m.debutExtrait);
    } else if (r.zoom !== false) {
      // Zoom lent, avant puis arrière, vers un point qui change d'une photo à l'autre.
      const h = hachage(m.id);
      const arriere = photos++ % 2 === 1;
      e.zoom = { de: arriere ? 1.08 : 1, a: arriere ? 1 : 1.08, px: 0.35 + ((h & 255) / 255) * 0.3, py: 0.35 + (((h >> 8) & 255) / 255) * 0.3 };
    }
    elements.push(e);
  });
  const duree = elements.length ? elements[elements.length - 1].f1 / FPS : 0;
  const etat = new Map();
  for (const m of liste) etat.set(m.id, ecartes.has(m.id) ? { inclus: false, raison: ecartes.get(m.id) } : { inclus: true, raison: null });
  let erreur = null;
  if (!musique) erreur = musiques(projet).some((m) => m.etat !== 'erreur') ? 'musique-en-cours' : 'musique';
  else if (!elements.length) erreur = 'vide';
  return {
    elements, ordre: liste.map((m) => m.id), etat, auto,
    musique: musique ? { id: musique.id, bpm, premier, decalage: arr(decalage), duree: musique.duree } : null,
    dispo: Number.isFinite(dispo) ? dispo : null,
    utilises: elements.reduce((s, e) => s + e.temps, 0),
    duree: arr(duree),
    erreur,
  };
};

const arr = (v) => Math.round(v * 1000) / 1000;
