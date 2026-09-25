// Tests des calculs, sans ffmpeg : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planifier, ordonner, reperer, meilleurPassage, ecartEmpreintes, remplit, definitionFinale, dimensions, FPS } from '../public/plan.js';
import { dateDepuisNom, jourDepuisNom, dateExif, nettete, empreinte, filtreOrientation } from '../server/medias.js';
import { appliquerChangements, typeDe } from '../server/stockage.js';

const photo = (id, date, extra = {}) => ({ id, type: 'photo', nom: `${id}.jpg`, etat: 'pret', date, recu: 0, largeur: 1600, hauteur: 1200, nettete: 300, empreinte: 'ffffffff00000000', choix: 'auto', ...extra });
const video = (id, date, duree, extra = {}) => ({ id, type: 'video', nom: `${id}.mp4`, etat: 'pret', date, recu: 0, largeur: 1920, hauteur: 1080, duree, notes: [], choix: 'auto', ...extra });
const musique = (extra = {}) => ({ id: 'musique1', type: 'musique', nom: 'm.mp3', etat: 'pret', recu: 0, bpm: 120, premier: 0.5, duree: 60, finSon: 60, ...extra });
const projet = (medias, reglages = {}, ordre = null) => ({
  reglages: { format: 'paysage', tempsPhoto: 2, tempsVideo: 4, musique: null, zoom: true, ...reglages },
  ordre, medias: Object.fromEntries(medias.map((m) => [m.id, m])),
});

test('dates : noms Android, EXIF, jour seul', () => {
  const t = (a, mo, j, h, mi, s) => Date.UTC(a, mo - 1, j, h, mi, s);
  assert.equal(dateDepuisNom('IMG_20260815_143012.jpg'), t(2026, 8, 15, 14, 30, 12));
  assert.equal(dateDepuisNom('VID_20260815_143512.mp4'), t(2026, 8, 15, 14, 35, 12));
  assert.equal(dateDepuisNom('PXL_20260815_143012345.jpg'), t(2026, 8, 15, 14, 30, 12));
  assert.equal(dateDepuisNom('20260815_143012.jpg'), t(2026, 8, 15, 14, 30, 12));
  assert.equal(dateDepuisNom('Screenshot_20260815-143012.png'), t(2026, 8, 15, 14, 30, 12));
  assert.equal(dateDepuisNom('IMG-20260815-WA0003.jpg'), null);
  assert.equal(jourDepuisNom('IMG-20260815-WA0003.jpg'), t(2026, 8, 15, 12, 0, 0));
  assert.equal(dateDepuisNom('vacances.jpg'), null);
  assert.equal(dateDepuisNom('IMG_20261399_250000.jpg'), null, 'date impossible');
  assert.equal(dateExif('2026:08:15 10:20:00'), t(2026, 8, 15, 10, 20, 0));
  assert.equal(dateExif(''), null);
});

test('mesures : netteté, empreinte, orientation, types de fichiers', () => {
  const W = 64, H = 48;
  const net = new Uint8Array(W * H).map((_, i) => ((i % W) >> 2) % 2 ? 255 : 0);
  const uni = new Uint8Array(W * H).fill(128);
  assert.ok(nettete(net, W, H) > 1000 && nettete(uni, W, H) === 0);
  const degrade = new Uint8Array(W * H).map((_, i) => (i % W) * 4);
  assert.equal(empreinte(degrade, W, H), '0000000000000000', 'chaque pavé plus sombre que son voisin de droite');
  assert.equal(empreinte(degrade.map((v) => 255 - v), W, H), 'ffffffffffffffff');
  assert.equal(ecartEmpreintes('ffffffffffffffff', 'fffffffffffffff0'), 4);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(filtreOrientation), ['', 'hflip', 'hflip,vflip', 'vflip', 'transpose=0', 'transpose=1', 'transpose=3', 'transpose=2']);
  assert.deepEqual(typeDe('IMG_1.JPG'), { type: 'photo', ext: 'jpg' });
  assert.deepEqual(typeDe('son.m4a'), { type: 'musique', ext: 'm4a' });
  assert.equal(typeDe('document.pdf'), null);
  assert.ok(remplit(1920, 1080, 'paysage') && !remplit(1600, 1200, 'paysage') && remplit(1080, 1920, 'vertical') && !remplit(1920, 1080, 'vertical'));
});

test('ordre : dates, ordre choisi à la main, nouveaux fichiers insérés à leur date', () => {
  const p = projet([photo('ccc00001', 3000), photo('aaa00001', 1000), video('bbb00001', 2000, 5), photo('sansdate', null), musique()]);
  assert.deepEqual(ordonner(p).map((m) => m.id), ['aaa00001', 'bbb00001', 'ccc00001', 'sansdate']);
  p.ordre = ['ccc00001', 'aaa00001'];
  assert.deepEqual(ordonner(p).map((m) => m.id), ['ccc00001', 'aaa00001', 'bbb00001', 'sansdate'], 'bbb vient après le dernier plus ancien');
  p.medias.pasPret1 = { ...photo('pasPret1', 1500), etat: 'analyse' };
  assert.ok(!ordonner(p).some((m) => m.id === 'pasPret1'));
});

test('tri automatique : photo floue, rafale, gardée à la main', () => {
  const liste = [
    photo('a0000001', 1000, { nettete: 400, empreinte: 'ffff0000ffff0000' }),
    photo('a0000002', 3000, { nettete: 250, empreinte: 'ffff0000ffff0001' }),
    photo('a0000003', 4000, { nettete: 500, empreinte: 'ffff0000ffff0003' }),
    photo('a0000004', 400000, { nettete: 450, empreinte: 'ffff0000ffff0000' }), // même image, mais bien plus tard
    photo('a0000005', 500000, { nettete: 10, empreinte: '0f0f0f0f0f0f0f0f' }),
  ];
  const r = reperer(liste);
  assert.equal(r.get('a0000001'), 'doublon');
  assert.equal(r.get('a0000002'), 'doublon');
  assert.equal(r.has('a0000003'), false, 'la plus nette de la rafale reste');
  assert.equal(r.has('a0000004'), false, 'trop loin dans le temps pour être un doublon');
  assert.equal(r.get('a0000005'), 'floue');
  const p = projet([...liste, musique()]);
  p.medias.a0000005.choix = 'garder';
  p.medias.a0000003.choix = 'retirer';
  const plan = planifier(p);
  assert.deepEqual(plan.elements.map((e) => e.id), ['a0000004', 'a0000005']);
  assert.equal(plan.etat.get('a0000003').raison, 'retiree');
  assert.equal(plan.etat.get('a0000001').raison, 'doublon');
});

test('plan : chaque changement tombe sur un temps, à l\'image près', () => {
  const p = projet([photo('p0000001', 1000), video('v0000001', 2000, 10), photo('p0000002', 3000, { empreinte: '0000ffff0000ffff' }), musique({ bpm: 97, premier: 1.234 })]);
  const plan = planifier(p);
  const per = 60 / 97;
  assert.deepEqual(plan.elements.map((e) => e.temps), [2, 4, 2]);
  assert.equal(plan.elements[0].debut, 0);
  plan.elements.forEach((e, i) => {
    const attendu = 1.234 + [2, 6, 8][i] * per;
    assert.ok(Math.abs(e.fin - attendu) < 0.001, `fin ${i}`);
    assert.equal(e.f1, Math.round(attendu * FPS));
    if (i) assert.equal(e.f0, plan.elements[i - 1].f1, 'pas de trou ni de chevauchement');
  });
  assert.ok(Math.abs(plan.duree - plan.elements[2].f1 / FPS) < 0.001);
  assert.ok(plan.elements[0].zoom.de !== plan.elements[2].zoom.de, "zoom avant puis arrière");
  assert.equal(plan.musique.decalage, 0);
  // Longue introduction : on démarre un temps avant le premier.
  const long = planifier(projet([photo('p0000001', 1000), musique({ premier: 7.5 })]));
  assert.equal(long.musique.decalage, 7);
  assert.equal(long.elements[0].fin, 0.5 + 2 * 0.5);
});

test('plan : vidéo courte, réglages, pas de musique', () => {
  const p = projet([video('v0000001', 1000, 1.3), photo('p0000001', 2000), musique()], { tempsPhoto: 4, tempsVideo: 8 });
  const plan = planifier(p);
  assert.deepEqual(plan.elements.map((e) => e.temps), [2, 4], 'une vidéo de 1,3 s tient 2 temps à 120 BPM');
  assert.equal(plan.elements[0].extrait, 0);
  p.reglages.zoom = false;
  assert.equal(planifier(p).elements[1].zoom, undefined);
  delete p.medias.musique1;
  assert.equal(planifier(p).erreur, 'musique');
  p.medias.m2 = { ...musique(), id: 'm2', etat: 'analyse' };
  assert.equal(planifier(p).erreur, 'musique-en-cours');
});

test('plan : trop d\'images pour la musique, les moins bonnes sont mises de côté', () => {
  const medias = [musique({ duree: 6, finSon: 5.6, premier: 0.5 })]; // 10 temps disponibles
  for (let i = 0; i < 6; i++) medias.push(photo(`p000000${i}`, 1000 + i * 1e6, { nettete: 100 + i * 10, empreinte: `${i}`.repeat(16) }));
  medias.push(video('v0000001', 500, 10));
  const plan = planifier(projet(medias));
  assert.equal(plan.dispo, 10);
  assert.ok(plan.utilises <= 10);
  assert.equal(plan.utilises, 10);
  assert.ok(plan.elements.some((e) => e.id === 'v0000001'), 'la vidéo passe avant les photos');
  const ecartees = [...plan.etat].filter(([, x]) => x.raison === 'place').map(([id]) => id);
  assert.deepEqual(ecartees.sort(), ['p0000000', 'p0000001', 'p0000002'], 'les moins nettes');
});

test('meilleur passage : évite le début, prend la partie la mieux notée', () => {
  const notes = [...Array(16).fill(5), ...Array(16).fill(7)]; // 8 s, la seconde moitié meilleure
  assert.equal(meilleurPassage(notes, 8, 2), 4);
  assert.equal(meilleurPassage([], 8, 2), 3, 'sans notes : au milieu');
  assert.equal(meilleurPassage(notes, 2, 2), 0, 'vidéo juste assez longue');
  assert.ok(meilleurPassage(Array(32).fill(6), 8, 2) >= 0.5, 'jamais la première demi-seconde');
});

test('changements envoyés par la page : vérifiés et bornés', () => {
  const p = projet([photo('p0000001', 1), video('v0000001', 2, 10), musique()]);
  p.nom = 'Avant';
  appliquerChangements(p, {
    nom: '  Angleterre\u0007 2026 ',
    reglages: { format: 'carre', tempsPhoto: 3, tempsVideo: 8, musique: 'p0000001', zoom: 'oui' },
    ordre: ['v0000001', 'v0000001', 'musique1', 'inconnu1', 'p0000001'],
    medias: { v0000001: { debutExtrait: 400, choix: 'garder' }, p0000001: { debutExtrait: 3, choix: 'effacer' }, '../x': { choix: 'garder' } },
  });
  assert.equal(p.nom, 'Angleterre  2026');
  assert.deepEqual(p.reglages, { format: 'paysage', tempsPhoto: 2, tempsVideo: 8, musique: null, zoom: true });
  appliquerChangements(p, { reglages: { definition: '4k' } });
  assert.equal(p.reglages.definition, undefined, 'valeur inconnue refusée');
  appliquerChangements(p, { reglages: { definition: '2160' } });
  assert.equal(p.reglages.definition, '2160');
  delete p.reglages.definition;
  assert.deepEqual(p.ordre, ['v0000001', 'p0000001']);
  assert.equal(p.medias.v0000001.debutExtrait, 10);
  assert.equal(p.medias.v0000001.choix, 'garder');
  assert.equal(p.medias.p0000001.debutExtrait, undefined);
  assert.equal(p.medias.p0000001.choix, 'auto');
  appliquerChangements(p, { reglages: { musique: 'musique1' }, ordre: null, medias: { v0000001: { debutExtrait: null } } });
  assert.equal(p.reglages.musique, 'musique1');
  assert.equal(p.ordre, null);
  assert.equal(p.medias.v0000001.debutExtrait, null);
  assert.throws(() => appliquerChangements(p, null));
});

test('définition : 4K automatique quand les fichiers sont assez fins', () => {
  const photo12mp = { largeur: 4000, hauteur: 3000 }, video1080 = { largeur: 1920, hauteur: 1080 }, video4k = { largeur: 3840, hauteur: 2160 };
  assert.equal(definitionFinale('auto', [photo12mp, photo12mp, video1080]), 2160);
  assert.equal(definitionFinale('auto', [photo12mp, video1080, video1080]), 1080);
  assert.equal(definitionFinale('auto', [video4k]), 2160);
  assert.equal(definitionFinale('auto', []), 1080);
  assert.equal(definitionFinale('1080', [photo12mp]), 1080);
  assert.equal(definitionFinale('2160', [video1080]), 2160);
  assert.deepEqual(dimensions('paysage', 2160), { largeur: 3840, hauteur: 2160 });
  assert.deepEqual(dimensions('vertical', 1080), { largeur: 1080, hauteur: 1920 });
  const plan = planifier(projet([photo('p0000001', 1, { largeur: 4000, hauteur: 3000 }), musique()]));
  assert.deepEqual([plan.definition, plan.largeur, plan.hauteur], [2160, 3840, 2160]);
});
