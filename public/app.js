// Montage : interface. Aucune bibliothèque ; le plan de montage vient de
// plan.js, le même que celui du serveur.
import { planifier, FORMATS, RAISONS, remplit } from './plan.js';

const $ = (id) => document.getElementById(id);
const creer = (balise, attributs = {}, ...enfants) => {
  const el = document.createElement(balise);
  for (const [k, v] of Object.entries(attributs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'texte') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) if (e !== null && e !== undefined && e !== false) el.append(e instanceof Node ? e : String(e));
  return el;
};
const duree = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const pluriel = (n, un, plusieurs = `${un}s`) => `${n} ${n > 1 ? plusieurs : un}`;
const taille = (o) => (o > 1e9 ? `${(o / 1e9).toFixed(1).replace('.', ',')} Go` : `${Math.max(1, Math.round(o / 1e6))} Mo`);

let minuterieAnnonce = 0;
const annoncer = (texte) => {
  const a = $('annonce');
  a.textContent = texte;
  a.hidden = false;
  clearTimeout(minuterieAnnonce);
  minuterieAnnonce = setTimeout(() => { a.hidden = true; }, 4000);
};

class ErreurApi extends Error {}
const api = async (chemin, { methode = 'GET', corps } = {}) => {
  const r = await fetch(chemin, {
    method: methode,
    headers: corps !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  if (r.status === 401 && !chemin.endsWith('/connexion')) { montrer('vue-connexion'); throw new ErreurApi('Connexion requise.'); }
  if (r.status === 204) return null;
  const donnees = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErreurApi(donnees.erreur || `Erreur ${r.status}`);
  return donnees;
};

/* ------------------------------ Vues ------------------------------ */

const vues = ['vue-connexion', 'vue-accueil', 'vue-projet'];
const montrer = (vue) => { vues.forEach((v) => { $(v).hidden = v !== vue; }); };

$('form-connexion').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('connexion-erreur').textContent = '';
  try {
    await api('/api/connexion', { methode: 'POST', corps: { motDePasse: $('mdp').value } });
    $('mdp').value = '';
    router();
  } catch (err) { $('connexion-erreur').textContent = err.message; }
});
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-action="deconnexion"]')) return;
  await api('/api/deconnexion', { methode: 'POST' }).catch(() => {});
  montrer('vue-connexion');
});

/* ------------------------------ Accueil ------------------------------ */

const afficherAccueil = async () => {
  montrer('vue-accueil');
  document.title = 'Montage';
  const projets = await api('/api/projets');
  $('aucun-projet').hidden = projets.length > 0;
  $('liste-projets').replaceChildren(...projets.map((p) => creer('li', {},
    creer('a', { class: 'couverture', href: `#/projet/${p.id}`, 'aria-hidden': 'true', tabindex: '-1', style: p.couverture ? `background-image:url("/fichiers/${p.id}/vignettes/${p.couverture}.jpg")` : '' }),
    creer('div', { class: 'infos' },
      creer('a', { class: 'nom', href: `#/projet/${p.id}`, texte: p.nom }),
      creer('span', { class: 'discret petit', texte: [pluriel(p.photos, 'photo'), pluriel(p.videos, 'vidéo'), pluriel(p.musiques, 'musique')].join(', ') })))));
};
$('form-projet').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const p = await api('/api/projets', { methode: 'POST', corps: { nom: $('nom-projet').value } });
    $('nom-projet').value = '';
    location.hash = `#/projet/${p.id}`;
  } catch (err) { annoncer(err.message); }
});

/* ------------------------------ Projet ------------------------------ */

const e = {
  id: null, projet: null, plan: null, taches: [], exports: [],
  enAttente: null, minuterieSauvegarde: 0, sauvegardeEnCours: false,
  envois: [], envoiActif: false, minuterieSuivi: 0,
};
window.__montage = { etat: e, plan: () => e.plan };

const url = (sorte, mid, ext = 'jpg') => `/fichiers/${e.id}/${sorte}/${mid}.${ext}`;

const recalculer = () => { e.plan = planifier(e.projet); };

const chargerProjet = async (id, { silencieux = false } = {}) => {
  const r = await api(`/api/projets/${id}`);
  if (e.id !== id) return;
  // Ne pas écraser des changements pas encore enregistrés.
  if (!e.enAttente && !e.sauvegardeEnCours) e.projet = r.projet;
  e.taches = r.taches;
  e.exports = r.exports;
  recalculer();
  toutAfficher({ silencieux });
  suivre();
};

const afficherProjet = async (id) => {
  if (e.id !== id) {
    arreterApercu();
    Object.assign(e, { id, projet: null, plan: null, taches: [], exports: [], enAttente: null });
  }
  montrer('vue-projet');
  try { await chargerProjet(id); } catch (err) {
    if (err instanceof ErreurApi && err.message !== 'Connexion requise.') { annoncer(err.message); location.hash = '#/'; }
  }
};

// Relit le projet tant que quelque chose avance côté serveur.
const suivre = () => {
  clearTimeout(e.minuterieSuivi);
  const actif = Object.values(e.projet?.medias || {}).some((m) => m.etat === 'attente' || m.etat === 'analyse')
    || e.taches.some((t) => t.type === 'rendu' && (t.etat === 'attente' || t.etat === 'en-cours'));
  if (!actif || !e.id) return;
  const id = e.id;
  e.minuterieSuivi = setTimeout(() => chargerProjet(id, { silencieux: true }).catch(() => suivre()), 1500);
};

// Un changement s'applique tout de suite dans la page, puis part au serveur.
const changer = (patch) => {
  const p = e.projet;
  if (patch.nom !== undefined) p.nom = patch.nom;
  if (patch.reglages) Object.assign(p.reglages, patch.reglages);
  if (patch.ordre !== undefined) p.ordre = patch.ordre;
  if (patch.medias) for (const [id, c] of Object.entries(patch.medias)) if (p.medias[id]) Object.assign(p.medias[id], c);
  const a = e.enAttente || {};
  e.enAttente = {
    ...a, ...patch,
    reglages: { ...(a.reglages || {}), ...(patch.reglages || {}) },
    medias: { ...(a.medias || {}) },
  };
  for (const [id, c] of Object.entries(patch.medias || {})) e.enAttente.medias[id] = { ...(e.enAttente.medias[id] || {}), ...c };
  $('sauvegarde').textContent = 'Modifications non enregistrées';
  recalculer();
  toutAfficher();
  clearTimeout(e.minuterieSauvegarde);
  e.minuterieSauvegarde = setTimeout(enregistrer, 500);
};

const enregistrer = async () => {
  if (!e.enAttente || e.sauvegardeEnCours) return;
  const envoi = e.enAttente;
  const id = e.id;
  e.enAttente = null;
  e.sauvegardeEnCours = true;
  try {
    const r = await api(`/api/projets/${id}`, { methode: 'PATCH', corps: envoi });
    if (e.id === id && !e.enAttente) { e.projet = r.projet; recalculer(); toutAfficher({ silencieux: true }); }
    $('sauvegarde').textContent = 'Modifications enregistrées';
  } catch (err) {
    e.enAttente = { ...envoi, ...(e.enAttente || {}) };
    $('sauvegarde').textContent = 'Enregistrement impossible, nouvel essai…';
    setTimeout(enregistrer, 3000);
  } finally {
    e.sauvegardeEnCours = false;
    if (e.enAttente) enregistrer();
  }
};

$('titre-projet').addEventListener('change', () => changer({ nom: $('titre-projet').value.trim() || e.projet.nom }));

/* ------------------------------ Envoi des fichiers ------------------------------ */

const ajouterFichiers = (liste) => {
  const fichiers = [...liste];
  if (!fichiers.length) return;
  e.envois.push(...fichiers.map((f) => ({ fichier: f, projet: e.id })));
  $('ajout-erreurs').textContent = '';
  if (!e.envoiActif) envoyerSuivant();
};
$('fichiers').addEventListener('change', () => { ajouterFichiers($('fichiers').files); $('fichiers').value = ''; });
const zone = $('zone-ajout');
['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (ev) => { ev.preventDefault(); zone.classList.add('survol'); }));
['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (ev) => { ev.preventDefault(); zone.classList.remove('survol'); }));
zone.addEventListener('drop', (ev) => ajouterFichiers(ev.dataTransfer.files));

let envoyes = 0, total = 0;
const envoyerSuivant = () => {
  const suivant = e.envois.shift();
  if (!suivant) {
    e.envoiActif = false;
    $('envoi').hidden = true;
    envoyes = 0; total = 0;
    return;
  }
  if (!e.envoiActif) { envoyes = 0; total = e.envois.length + 1; }
  e.envoiActif = true;
  const { fichier, projet } = suivant;
  $('envoi').hidden = false;
  $('envoi-texte').textContent = `Envoi ${envoyes + 1} sur ${total} : ${fichier.name}`;
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `/api/projets/${projet}/medias?nom=${encodeURIComponent(fichier.name)}&modifie=${fichier.lastModified || ''}`);
  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) return;
    $('envoi').querySelector('.barre-progres div').style.width = `${Math.round(((envoyes + ev.loaded / ev.total) / total) * 100)}%`;
  };
  xhr.onload = () => {
    envoyes++;
    if (xhr.status !== 201) {
      let msg = 'Envoi interrompu.';
      try { msg = JSON.parse(xhr.responseText).erreur || msg; } catch { /* réponse vide */ }
      $('ajout-erreurs').textContent = `${fichier.name} : ${msg}`;
    }
    if (projet === e.id) chargerProjet(projet, { silencieux: true }).catch(() => {});
    envoyerSuivant();
  };
  xhr.onerror = () => { envoyes++; $('ajout-erreurs').textContent = `${fichier.name} : envoi interrompu.`; envoyerSuivant(); };
  xhr.send(fichier);
};

/* ------------------------------ Affichage ------------------------------ */

const toutAfficher = ({ silencieux = false } = {}) => {
  if (!e.projet) return;
  const p = e.projet;
  document.title = `${p.nom} · Montage`;
  if (document.activeElement !== $('titre-projet')) $('titre-projet').value = p.nom;
  afficherAnalyse();
  afficherMusiques();
  afficherReglages();
  afficherResume();
  afficherExports();
  // Ne pas refaire le déroulé pendant qu'on déplace un curseur de passage.
  if (!(silencieux && document.activeElement?.closest?.('#deroule'))) afficherDeroule();
  preparerApercu();
};

const afficherAnalyse = () => {
  const medias = Object.values(e.projet.medias);
  const restants = medias.filter((m) => m.etat === 'attente' || m.etat === 'analyse').length;
  $('analyse-texte').textContent = restants ? `Analyse en cours : ${pluriel(restants, 'fichier')} à examiner.` : '';
};

const afficherMusiques = () => {
  const liste = Object.values(e.projet.medias).filter((m) => m.type === 'musique').sort((a, b) => a.recu - b.recu);
  $('sans-musique').hidden = liste.length > 0;
  const choisie = e.plan.musique?.id;
  $('liste-musiques').replaceChildren(...liste.map((m) => {
    const info = m.etat === 'pret' ? `${String(Math.round(m.bpm * 10) / 10).replace('.', ',')} BPM, ${duree(m.duree)}`
      : m.etat === 'erreur' ? m.message : 'analyse en cours…';
    const radio = creer('input', { type: 'radio', name: 'musique', value: m.id, checked: m.id === choisie, disabled: m.etat !== 'pret' });
    radio.addEventListener('change', () => changer({ reglages: { musique: m.id } }));
    return creer('li', { 'data-media': m.id },
      creer('label', {}, radio, creer('span', {}, creer('span', { class: 'nom-musique', texte: m.nom }), creer('br'), creer('span', { class: `petit ${m.etat === 'erreur' ? 'erreur' : 'discret'}`, texte: info }))),
      creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Supprimer', onclick: () => supprimerMedia(m) }));
  }));
};

const afficherReglages = () => {
  const r = e.projet.reglages;
  document.querySelectorAll('input[name=format]').forEach((i) => { i.checked = i.value === r.format; });
  document.querySelectorAll('input[name=tempsPhoto]').forEach((i) => { i.checked = Number(i.value) === r.tempsPhoto; });
  document.querySelectorAll('input[name=tempsVideo]').forEach((i) => { i.checked = Number(i.value) === r.tempsVideo; });
  $('zoom').checked = r.zoom !== false;
};
document.querySelectorAll('input[name=format]').forEach((i) => i.addEventListener('change', () => changer({ reglages: { format: i.value } })));
document.querySelectorAll('input[name=tempsPhoto]').forEach((i) => i.addEventListener('change', () => changer({ reglages: { tempsPhoto: Number(i.value) } })));
document.querySelectorAll('input[name=tempsVideo]').forEach((i) => i.addEventListener('change', () => changer({ reglages: { tempsVideo: Number(i.value) } })));
$('zoom').addEventListener('change', () => changer({ reglages: { zoom: $('zoom').checked } }));

const afficherResume = () => {
  const plan = e.plan;
  const photos = plan.elements.filter((x) => x.type === 'photo').length;
  const videos = plan.elements.length - photos;
  const ecartees = [...plan.etat.values()].filter((x) => !x.inclus);
  const place = ecartees.filter((x) => x.raison === 'place').length;
  let texte = '';
  if (plan.erreur === 'musique') texte = 'Ajoute une musique : le montage se cale sur ses temps.';
  else if (plan.erreur === 'musique-en-cours') texte = 'La musique est en cours d\'analyse.';
  else if (!plan.ordre.length) texte = 'Ajoute des photos et des vidéos.';
  else if (plan.erreur === 'vide') texte = 'Tout est mis de côté : garde au moins une image.';
  else {
    texte = `${duree(plan.duree)} de vidéo : ${pluriel(photos, 'photo')} et ${pluriel(videos, 'vidéo')}`;
    if (ecartees.length) texte += `, ${ecartees.length} mise${ecartees.length > 1 ? 's' : ''} de côté`;
    texte += '.';
    if (place) texte += ` La musique est trop courte pour tout montrer : choisis 1 temps par photo, ou une musique plus longue.`;
  }
  $('resume').textContent = texte;
  $('fabriquer').disabled = Boolean(plan.erreur) || rendusActifs().length > 0;
  $('ordre-date').hidden = !(Array.isArray(e.projet.ordre) && e.projet.ordre.length);
};
$('ordre-date').addEventListener('click', () => changer({ ordre: null }));

const rendusActifs = () => e.taches.filter((t) => t.type === 'rendu' && (t.etat === 'attente' || t.etat === 'en-cours'));

const afficherExports = () => {
  const actifs = rendusActifs();
  const derniere = e.taches.find((t) => t.type === 'rendu');
  $('fabriquer-message').textContent = !actifs.length && derniere?.etat === 'erreur' ? `La dernière fabrication a échoué : ${derniere.erreur}` : '';
  $('fabriquer-message').className = `petit${!actifs.length && derniere?.etat === 'erreur' ? ' erreur' : ''}`;
  $('liste-exports').replaceChildren(
    ...actifs.map((t) => creer('li', { 'data-tache': t.id },
      creer('div', { class: 'infos' },
        creer('div', { class: 'petit', texte: t.etat === 'attente' ? 'En attente…' : `${t.message || 'Fabrication'} (${Math.round(t.progres * 100)} %)` }),
        creer('div', { class: 'barre-progres' }, creer('div', { style: `width:${Math.round(t.progres * 100)}%` }))),
      creer('button', { class: 'bouton petit', type: 'button', texte: 'Annuler', onclick: () => api(`/api/taches/${t.id}/annuler`, { methode: 'POST' }).then(() => chargerProjet(e.id)) }))),
    ...e.exports.map((x) => creer('li', { 'data-fichier': x.nom },
      creer('div', { class: 'infos' },
        creer('div', { texte: `Vidéo du ${new Date(x.date).toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' })}` }),
        creer('div', { class: 'petit discret', texte: taille(x.taille) })),
      creer('a', { class: 'bouton petit principal', href: `/fichiers/${e.id}/exports/${x.nom}`, texte: 'Télécharger' }),
      creer('a', { class: 'bouton petit', href: `/fichiers/${e.id}/exports/${x.nom}?voir=1`, target: '_blank', rel: 'noopener', texte: 'Regarder' }),
      creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Supprimer', onclick: async () => {
        if (!confirm('Supprimer cette vidéo fabriquée ?')) return;
        await api(`/api/projets/${e.id}/exports/${x.nom}`, { methode: 'DELETE' });
        chargerProjet(e.id);
      } }))));
};

$('fabriquer').addEventListener('click', async () => {
  await enregistrer();
  try {
    await api(`/api/projets/${e.id}/rendu`, { methode: 'POST' });
    await chargerProjet(e.id);
  } catch (err) { annoncer(err.message); }
});

const supprimerMedia = async (m) => {
  if (!confirm(`Retirer « ${m.nom} » du projet ? Le fichier sera effacé du serveur.`)) return;
  await enregistrer();
  try {
    await api(`/api/projets/${e.id}/medias/${m.id}`, { methode: 'DELETE' });
    await chargerProjet(e.id);
  } catch (err) { annoncer(err.message); }
};

$('supprimer-projet').addEventListener('click', async () => {
  if (!confirm(`Supprimer le projet « ${e.projet.nom} » avec toutes ses photos, vidéos et vidéos fabriquées ?`)) return;
  await api(`/api/projets/${e.id}`, { methode: 'DELETE' });
  e.id = null;
  location.hash = '#/';
});

/* ------------------------------ Déroulé ------------------------------ */

const deplacer = (id, sens) => {
  const ordre = [...e.plan.ordre];
  const i = ordre.indexOf(id);
  const j = i + sens;
  if (i < 0 || j < 0 || j >= ordre.length) return;
  [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
  changer({ ordre });
};

const afficherDeroule = () => {
  const p = e.projet;
  const plan = e.plan;
  const parId = new Map(plan.elements.map((x) => [x.id, x]));
  const enCours = Object.values(p.medias).filter((m) => m.type !== 'musique' && m.etat !== 'pret').sort((a, b) => a.recu - b.recu);
  const cartes = plan.ordre.map((id, i) => {
    const m = p.medias[id];
    const el = parId.get(id);
    const statut = plan.etat.get(id);
    const li = creer('li', { class: `carte${statut.inclus ? '' : ' ecartee'}`, 'data-media': id });
    li.append(creer('button', {
      class: 'vignette', type: 'button', style: `background-image:url("${url('vignettes', id)}")`,
      'aria-label': `${m.type === 'video' ? 'Vidéo' : 'Photo'} ${m.nom}${el ? ', voir dans l\'aperçu' : ''}`,
      onclick: () => { if (el) allerA(el.debut + 0.01); },
    },
    m.type === 'video' ? creer('span', { class: 'badge', texte: `Vidéo ${duree(m.duree)}` }) : null,
    el ? creer('span', { class: 'badge droite', texte: duree(el.debut) }) : null));
    const corps = creer('div', { class: 'corps' });
    if (statut.inclus) {
      corps.append(creer('span', { texte: `${pluriel(el.temps, 'temps', 'temps')}${m.choix === 'garder' && plan.auto.has(id) ? `, gardée malgré tout (${RAISONS[plan.auto.get(id)]})` : ''}` }));
    } else {
      corps.append(creer('span', { class: 'raison', texte: `Mise de côté : ${RAISONS[statut.raison]}` }));
    }
    if (el && m.type === 'video') {
      const longueur = (el.f1 - el.f0) / 30;
      const max = Math.max(0, m.duree - longueur);
      if (max > 0.1) {
        const valeur = creer('span', { texte: `Passage à ${duree(el.extrait)}${el.extraitAuto ? ' (choisi seul)' : ''}` });
        const curseur = creer('input', { type: 'range', min: '0', max: max.toFixed(2), step: '0.1', value: String(el.extrait), 'aria-label': `Début du passage de ${m.nom}` });
        curseur.addEventListener('input', () => {
          valeur.textContent = `Passage à ${duree(Number(curseur.value))}`;
          m.debutExtrait = Number(curseur.value);
          recalculer();
          allerA(el.debut + 0.01);
        });
        curseur.addEventListener('change', () => changer({ medias: { [id]: { debutExtrait: Number(curseur.value) } } }));
        corps.append(valeur, curseur);
        if (!el.extraitAuto) corps.append(creer('button', { class: 'lien petit', type: 'button', texte: 'Laisser le site choisir', onclick: () => changer({ medias: { [id]: { debutExtrait: null } } }) }));
      }
    }
    const garder = !statut.inclus;
    corps.append(creer('div', { class: 'actions' },
      creer('button', { class: `bouton petit${garder ? ' principal' : ''}`, type: 'button', texte: garder ? 'Garder' : 'Retirer', onclick: () => changer({ medias: { [id]: { choix: garder ? 'garder' : 'retirer' } } }) }),
      creer('button', { class: 'bouton petit', type: 'button', texte: '←', title: 'Plus tôt', 'aria-label': `Placer ${m.nom} plus tôt`, disabled: i === 0, onclick: () => deplacer(id, -1) }),
      creer('button', { class: 'bouton petit', type: 'button', texte: '→', title: 'Plus tard', 'aria-label': `Placer ${m.nom} plus tard`, disabled: i === plan.ordre.length - 1, onclick: () => deplacer(id, 1) }),
      creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Effacer', 'aria-label': `Effacer ${m.nom}`, onclick: () => supprimerMedia(m) })));
    corps.append(creer('span', { class: 'nom-fichier', texte: m.nom }));
    li.append(corps);
    return li;
  });
  const autres = enCours.map((m) => creer('li', { class: 'carte attente', 'data-media': m.id },
    creer('div', { class: 'vignette' }),
    creer('div', { class: 'corps' },
      creer('span', { class: m.etat === 'erreur' ? 'raison' : 'discret', texte: m.etat === 'erreur' ? m.message : 'Analyse en cours…' }),
      creer('div', { class: 'actions' }, creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Effacer', onclick: () => supprimerMedia(m) })),
      creer('span', { class: 'nom-fichier', texte: m.nom }))));
  $('deroule').replaceChildren(...cartes, ...autres);
  marquerCourante();
};

/* ------------------------------ Aperçu ------------------------------ */

const audio = $('audio');
const video = $('scene-video');
const image = $('scene-image');
const a = { musique: null, courant: -1, boucle: 0 };

const tempsMontage = () => (e.plan?.musique ? audio.currentTime - e.plan.musique.decalage : 0);

const preparerApercu = () => {
  const plan = e.plan;
  const format = FORMATS[e.projet.reglages.format] ? e.projet.reglages.format : 'paysage';
  $('scene').className = `scene ${format}`;
  const pret = !plan.erreur;
  $('lire').disabled = !pret;
  $('scene-message').textContent = pret ? '' : $('resume').textContent;
  if (plan.musique && plan.musique.id !== a.musique) {
    arreterApercu();
    a.musique = plan.musique.id;
    audio.src = `/fichiers/${e.id}/originaux/${plan.musique.id}`;
    audio.currentTime = plan.musique.decalage;
  }
  if (!plan.musique) { arreterApercu(); a.musique = null; audio.removeAttribute('src'); }
  $('frise').replaceChildren(creer('div', { class: 'frise-avance' }),
    ...plan.elements.map((x) => creer('div', { class: `repere${x.type === 'video' ? ' video' : ''}`, style: `left:${(x.debut / (plan.duree || 1)) * 100}%` })));
  $('frise').setAttribute('aria-valuemax', String(Math.round(plan.duree)));
  a.courant = -1;
  montrerInstant();
};

const indexA = (t) => {
  const els = e.plan?.elements || [];
  for (let i = 0; i < els.length; i++) if (t < els[i].fin) return i;
  return els.length - 1;
};

const montrerInstant = () => {
  const plan = e.plan;
  if (!plan || plan.erreur || !plan.elements.length) { image.hidden = true; video.hidden = true; $('scene-fond').style.backgroundImage = ''; return; }
  const t = Math.min(Math.max(0, tempsMontage()), plan.duree);
  const i = indexA(t);
  const el = plan.elements[i];
  const m = e.projet.medias[el.id];
  const format = e.projet.reglages.format;
  const plein = remplit(m.largeur, m.hauteur, format);
  if (i !== a.courant) {
    a.courant = i;
    $('scene-fond').style.backgroundImage = plein ? '' : `url("${url('apercus', m.id)}")`;
    if (m.type === 'video') {
      image.hidden = true;
      video.hidden = false;
      video.classList.toggle('plein', plein);
      const source = url('proxys', m.id, 'mp4');
      if (!video.src.endsWith(source)) { video.src = source; video.dataset.echec = ''; }
      video.poster = url('apercus', m.id);
    } else {
      video.pause();
      video.hidden = true;
      image.hidden = false;
      image.classList.toggle('plein', plein);
      if (!image.src.endsWith(url('apercus', m.id))) image.src = url('apercus', m.id);
    }
    marquerCourante();
  }
  const avance = (t - el.debut) / Math.max(0.001, el.fin - el.debut);
  if (m.type === 'photo') {
    const z = el.zoom;
    image.style.transformOrigin = z ? `${z.px * 100}% ${z.py * 100}%` : '50% 50%';
    image.style.transform = z ? `scale(${z.de + (z.a - z.de) * avance})` : 'none';
  } else if (!video.dataset.echec) {
    const voulu = el.extrait + (t - el.debut);
    if (Math.abs(video.currentTime - voulu) > 0.3) { try { video.currentTime = voulu; } catch { /* pas encore chargée */ } }
    if (!audio.paused && video.paused) video.play().catch(() => {});
    if (audio.paused && !video.paused) video.pause();
  }
  $('temps').textContent = `${duree(t)} / ${duree(plan.duree)}`;
  $('frise').querySelector('.frise-avance').style.width = `${(t / (plan.duree || 1)) * 100}%`;
  $('frise').setAttribute('aria-valuenow', String(Math.round(t)));
  $('frise').setAttribute('aria-valuetext', `${duree(t)} sur ${duree(plan.duree)}`);
};
// Vidéo illisible dans ce navigateur : on montre son image fixe.
video.addEventListener('error', () => { video.dataset.echec = '1'; });

const marquerCourante = () => {
  const el = e.plan?.elements[a.courant];
  document.querySelectorAll('#deroule .carte').forEach((c) => c.classList.toggle('courante', Boolean(el) && c.dataset.media === el.id));
};

const boucle = () => {
  cancelAnimationFrame(a.boucle);
  const pas = () => {
    if (!e.plan || e.plan.erreur) return;
    if (tempsMontage() >= e.plan.duree) { audio.pause(); allerA(0); }
    montrerInstant();
    if (!audio.paused) a.boucle = requestAnimationFrame(pas);
  };
  a.boucle = requestAnimationFrame(pas);
};
audio.addEventListener('play', () => { $('lire').textContent = 'Pause'; boucle(); });
audio.addEventListener('pause', () => { $('lire').textContent = 'Lire'; video.pause(); montrerInstant(); });
audio.addEventListener('seeked', montrerInstant);

const arreterApercu = () => { audio.pause(); video.pause(); cancelAnimationFrame(a.boucle); };
const allerA = (t) => {
  if (!e.plan?.musique) return;
  audio.currentTime = e.plan.musique.decalage + Math.min(Math.max(0, t), e.plan.duree);
  montrerInstant();
};
$('lire').addEventListener('click', () => {
  if (audio.paused) {
    if (tempsMontage() >= e.plan.duree - 0.05) allerA(0);
    audio.play().catch(() => annoncer('Le navigateur refuse de jouer la musique.'));
  } else audio.pause();
});
const viserFrise = (ev) => {
  const r = $('frise').getBoundingClientRect();
  allerA(((ev.clientX - r.left) / r.width) * (e.plan?.duree || 0));
};
$('frise').addEventListener('pointerdown', (ev) => { viserFrise(ev); $('frise').setPointerCapture(ev.pointerId); });
$('frise').addEventListener('pointermove', (ev) => { if (ev.buttons) viserFrise(ev); });
$('frise').addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
  ev.preventDefault();
  const i = Math.max(0, a.courant) + (ev.key === 'ArrowRight' ? 1 : -1);
  const el = e.plan?.elements[Math.min(Math.max(0, i), (e.plan?.elements.length || 1) - 1)];
  if (el) allerA(el.debut + 0.01);
});

/* ------------------------------ Démarrage ------------------------------ */

const router = async () => {
  let session;
  try { session = await api('/api/session'); } catch { return; }
  // Site sans mot de passe : rien à déconnecter.
  document.querySelectorAll('[data-action="deconnexion"]').forEach((b) => { b.hidden = session.motDePasse === false; });
  if (!session.connecte) return montrer('vue-connexion');
  const m = location.hash.match(/^#\/projet\/([a-z0-9]{8})$/);
  if (m) return afficherProjet(m[1]);
  arreterApercu();
  e.id = null;
  clearTimeout(e.minuterieSuivi);
  afficherAccueil().catch((err) => annoncer(err.message));
};
window.addEventListener('hashchange', router);
window.addEventListener('beforeunload', (ev) => {
  if (e.enAttente || e.envoiActif) { ev.preventDefault(); ev.returnValue = ''; }
});
router();
