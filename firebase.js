import admin from 'firebase-admin';

const FB_URL = process.env.FB_URL;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
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
