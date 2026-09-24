// File d'attente des travaux lourds : analyse des fichiers, rendu.
// Un seul à la fois, pour ne pas étouffer le serveur qui héberge aussi
// d'autres sites. Les tâches vivent en mémoire : un redémarrage les oublie.
import { randomBytes } from 'node:crypto';

const taches = new Map();
const file = [];
let enCours = null;

const publique = (t) => ({
  id: t.id, type: t.type, projetId: t.projetId, libelle: t.libelle,
  etat: t.etat, progres: t.progres, message: t.message, erreur: t.erreur,
  creee: t.creee, finie: t.finie, resultat: t.resultat ?? null,
});

const suivante = async () => {
  if (enCours || !file.length) return;
  const t = file.shift();
  if (t.etat !== 'attente') return suivante();
  enCours = t;
  t.etat = 'en-cours';
  t.demarree = Date.now();
  try {
    t.resultat = await t.travail({
      progres: (p, message) => {
        if (Number.isFinite(p)) t.progres = Math.max(0, Math.min(1, p));
        if (message) t.message = message;
      },
      signal: t.controle.signal,
    });
    t.etat = 'finie';
    t.progres = 1;
  } catch (e) {
    t.etat = t.controle.signal.aborted ? 'annulee' : 'erreur';
    t.erreur = t.controle.signal.aborted ? 'Annulée.' : (e?.message || String(e));
    try { await t.surEchec?.(t.erreur); } catch { /* rien de plus à faire */ }
  } finally {
    t.finie = Date.now();
    enCours = null;
    nettoyer();
    setImmediate(suivante);
  }
};

// Oublie les tâches terminées depuis plus d'un jour.
const nettoyer = () => {
  const limite = Date.now() - 24 * 3600 * 1000;
  for (const [id, t] of taches) if (t.finie && t.finie < limite) taches.delete(id);
};

export const ajouter = ({ type, projetId, libelle, travail, surEchec }) => {
  const t = {
    id: randomBytes(6).toString('hex'), type, projetId, libelle,
    etat: 'attente', progres: 0, message: '', erreur: null,
    creee: Date.now(), finie: null, travail, surEchec, controle: new AbortController(),
  };
  taches.set(t.id, t);
  file.push(t);
  setImmediate(suivante);
  return publique(t);
};

export const lister = (projetId) => [...taches.values()]
  .filter((t) => !projetId || t.projetId === projetId)
  .sort((a, b) => b.creee - a.creee)
  .slice(0, 100)
  .map(publique);

export const trouver = (id) => (taches.has(id) ? publique(taches.get(id)) : null);

export const annuler = (id) => {
  const t = taches.get(id);
  if (!t || t.finie) return false;
  if (t.etat === 'attente') {
    t.etat = 'annulee';
    t.erreur = 'Annulée.';
    t.finie = Date.now();
    Promise.resolve(t.surEchec?.(t.erreur)).catch(() => {});
  }
  t.controle.abort();
  return true;
};

export const annulerPourProjet = (projetId) => {
  for (const t of taches.values()) if (t.projetId === projetId && !t.finie) annuler(t.id);
};

export const active = (projetId) => [...taches.values()].find((t) => t.projetId === projetId && !t.finie) ?? null;
export const activePublique = (projetId) => { const t = active(projetId); return t ? publique(t) : null; };

// Attend la fin de toutes les tâches (utile aux tests).
export const attendreTout = async () => {
  while (enCours || file.some((t) => t.etat === 'attente')) await new Promise((r) => setTimeout(r, 50));
};
