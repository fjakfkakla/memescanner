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
    const updates = {
      score:      token.score,
      mcap:       token.mcap,
      liq:        token.liq,
      debug:      token.debug,
      lastSeenAt: Date.now(),
    };
    // Ne jamais écraser callMcap ni callScore (score figé au moment du premier call)
    if (token.callMcap !== undefined && !existing.callMcap) updates.callMcap = token.callMcap;
    if (!existing.callScore) updates.callScore = existing.score || token.score;
    await ref.update(updates);
    return key;
  }
  // Nouveau call
  await ref.set({
    ...token,
    callMcap:  token.mcap,
    callScore: token.score,
    savedAt:   Date.now(),
    callTime:  Date.now(),
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
