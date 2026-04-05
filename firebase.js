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

// Sauvegarde un call dans Firebase — clé = adresse du token (pas push key)
// Permet de retrouver le call par adresse et de ne jamais écraser calledAt/callMcap
export async function saveCall(token) {
  const key = token.addr.replace(/[.#$\/\[\]]/g, '_');
  const ref = db.ref(`calls/${key}`);
  const existing = (await ref.once('value')).val();
  if (existing) {
    // Mise à jour : garder calledAt et callMcap d'origine, update le reste
    await ref.update({
      score:    token.score,
      mcap:     token.mcap,
      liq:      token.liq,
      debug:    token.debug,
      lastSeenAt: Date.now(),
    });
    return key;
  }
  // Nouveau call
  await ref.set({
    ...token,
    callMcap: token.mcap,
    savedAt:  Date.now(),
    callTime: Date.now(),
  });
  return key;
}

// Récupère un call existant par adresse
export async function getCallByAddr(addr) {
  const key = addr.replace(/[.#$\/\[\]]/g, '_');
  const snap = await db.ref(`calls/${key}`).once('value');
  return snap.val();
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

// Codes
export async function getCodes() {
  const snap = await db.ref('codes').once('value');
  return snap.val() || [];
}
export async function saveCodes(codes) {
  await db.ref('codes').set(codes);
}

// Calls - individual
export async function getCall(key) {
  const snap = await db.ref(`calls/${key}`).once('value');
  return snap.val();
}
export async function putCall(key, data) {
  await db.ref(`calls/${key}`).set(data);
}
export async function patchCall(key, data) {
  await db.ref(`calls/${key}`).update(data);
}

// All calls
export async function getAllCalls() {
  const snap = await db.ref('calls').once('value');
  return snap.val() || {};
}

// Rugs
export async function getRugs() {
  const snap = await db.ref('rugs').once('value');
  return snap.val() || {};
}
export async function putRugs(data) {
  await db.ref('rugs').set(data);
}
export async function patchRugs(data) {
  await db.ref('rugs').update(data);
}

// Reviews
export async function getReviews() {
  const snap = await db.ref('reviews').once('value');
  return snap.val() || [];
}
export async function putReviews(data) {
  await db.ref('reviews').set(data);
}
