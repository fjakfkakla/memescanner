import admin from 'firebase-admin';

const FB_URL = process.env.FB_URL;

// Sur Railway : FIREBASE_CREDENTIALS_JSON = contenu du JSON de service account (pas un chemin)
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_CREDENTIALS_JSON;
  if (!raw) {
    console.error('[Firebase] ERREUR FATALE: variable FIREBASE_CREDENTIALS_JSON manquante dans Railway Variables');
    process.exit(1);
  }
  if (!FB_URL) {
    console.error('[Firebase] ERREUR FATALE: variable FB_URL manquante dans Railway Variables');
    process.exit(1);
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    console.error('[Firebase] ERREUR FATALE: FIREBASE_CREDENTIALS_JSON n\'est pas un JSON valide:', e.message);
    process.exit(1);
  }
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FB_URL,
    });
    console.log('[Firebase] Initialisé avec succès');
  } catch (e) {
    console.error('[Firebase] ERREUR FATALE initialisation:', e.message);
    process.exit(1);
  }
}

export const db = admin.database();

// Sauvegarde un call dans Firebase
export async function saveCall(token) {
  const ref = db.ref('calls').push();
  await ref.set({
    ...token,
    savedAt: Date.now(),
  });
  return ref.key;
}

// Récupère les calls récents (dernières N heures)
export async function getCalls(hoursBack = 2) {
  const since = Date.now() - hoursBack * 3600 * 1000;
  const snap = await db.ref('calls')
    .orderByChild('savedAt')
    .startAt(since)
    .once('value');
  const data = snap.val() || {};
  return Object.values(data).sort((a, b) => b.savedAt - a.savedAt);
}

// Récupère tout l'historique
export async function getHistory(limit = 200) {
  const snap = await db.ref('calls')
    .orderByChild('savedAt')
    .limitToLast(limit)
    .once('value');
  const data = snap.val() || {};
  return Object.values(data).sort((a, b) => b.savedAt - a.savedAt);
}
