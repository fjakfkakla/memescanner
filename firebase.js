import admin from 'firebase-admin';

const FB_URL = process.env.FB_URL;

// Sur Railway : FIREBASE_CREDENTIALS_JSON = contenu du JSON de service account (pas un chemin)
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_CREDENTIALS_JSON;
  if (!raw) throw new Error('Variable FIREBASE_CREDENTIALS_JSON manquante');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FB_URL,
  });
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
