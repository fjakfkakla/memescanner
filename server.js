import express from 'express';
import cors    from 'cors';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import admin from 'firebase-admin';
import { getCalls, getHistory } from './firebase.js';
import { runScanCycle, getLiveTokens, checkTokenSecurityExport, checkAxiomWalletsExport, getHeliusStats } from './worker.js';
import { trackOutcomes, autoAdjust, loadWeights, getAIPanel, getWinrateStats, deepAnalyze, buildSmartFilters, loadSmartFilters, checkSmartFilters, smartFilters } from './aiEngine.js';
import { startPaperTrader, getPaperConfig, setPaperConfig, getPaperTrades, getPaperEquity, closePaperTrade, resetPaperBot } from './paperTrader.js';
import { createCheckoutSession, handleStripeWebhook, getUserSubscription } from './stripe.js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Webhook Stripe — body brut avant express.json
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'stripe-signature manquant' });
  try {
    const result = await handleStripeWebhook(req.body, sig);
    res.json(result);
  } catch (e) {
    console.error('[Stripe Webhook]', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.use(express.json());

// ── ENDPOINTS ────────────────────────────────────────────────────

// Ping + Helius usage
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now(), uptime: process.uptime(), helius: getHeliusStats() });
});

// Tokens live : qualifiés actuellement + 5min après drop
app.get('/live', (_req, res) => {
  try {
    const data = getLiveTokens();
    res.json({ ok: true, count: data.length, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Historique complet (200 derniers)
app.get('/history', async (_req, res) => {
  try {
    const calls = await getHistory(200);
    res.json({ ok: true, count: calls.length, data: calls });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Rugs (calls avec rugRisk HIGH dans les 24h)
app.get('/rugs', async (_req, res) => {
  try {
    const calls = await getHistory(500);
    const since = Date.now() - 24 * 3600 * 1000;
    const rugs  = calls.filter(c => c.rugRisk === 'HIGH' && c.calledAt > since);
    res.json({ ok: true, count: rugs.length, data: rugs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Vérification code d'accès
const ACCESS_CODES = new Set((process.env.ACCESS_CODES || '').split(',').filter(Boolean));
app.post('/verify-code', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: 'code manquant' });
  const valid = ACCESS_CODES.has(code.trim().toUpperCase());
  res.json({ ok: valid, valid });
});

// Vérification mot de passe admin — stocké dans ADMIN_PW Railway, jamais dans le frontend
app.post('/admin/verify', (req, res) => {
  const { pw } = req.body || {};
  if (!pw) return res.status(400).json({ ok: false });
  const ADMIN_PW = process.env.ADMIN_PW || '';
  if (!ADMIN_PW) return res.status(500).json({ ok: false, error: 'ADMIN_PW non configuré' });
  res.json({ ok: pw === ADMIN_PW });
});

// Changement mot de passe admin — nécessite l'ancien mot de passe pour valider
app.post('/admin/change-pw', (req, res) => {
  // Le vrai changement se fait dans Railway Variables — cet endpoint indique juste la procédure
  res.json({ ok: false, error: 'Changez ADMIN_PW directement dans Railway Variables' });
});

// ── AI PANEL (admin only) ──
app.get('/admin/ai', async (_req, res) => {
  try {
    const [panel, stats] = await Promise.all([getAIPanel(), getWinrateStats()]);
    res.json({ ok: true, ...panel, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/admin/ai/winrate', async (_req, res) => {
  try {
    const stats = await getWinrateStats();
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Force une analyse + ajustement immédiat (admin)
app.post('/admin/ai/analyze', async (_req, res) => {
  try {
    const changes = await autoAdjust();
    res.json({ ok: true, changes: changes || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Deep analyze — analyse détaillée avec tableaux bons/mauvais calls + patterns
app.post('/admin/ai/deep-analyze', async (_req, res) => {
  try {
    const result = await deepAnalyze();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Smart Filters — build/rebuild AI adaptive filters from historical data
app.post('/admin/ai/build-filters', async (_req, res) => {
  try {
    const result = await buildSmartFilters();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get current smart filters
app.get('/admin/ai/smart-filters', (_req, res) => {
  res.json({ ok: true, ...smartFilters });
});

// Check a token against smart filters (for testing)
app.post('/admin/ai/check-token', (req, res) => {
  const tokenDebug = req.body || {};
  const result = checkSmartFilters(tokenDebug);
  res.json({ ok: true, ...result });
});

// Debug CA — analyse complète d'un token à la demande (deep mode)
app.get('/debug/:addr', async (req, res) => {
  const { addr } = req.params;
  const pairAddr = req.query.pair || null;
  if (!addr || addr.length < 32) return res.status(400).json({ ok: false, error: 'adresse invalide' });
  try {
    const [sec, wData] = await Promise.all([
      checkTokenSecurityExport(addr, pairAddr),
      checkAxiomWalletsExport(addr, pairAddr, true),
    ]);
    res.json({ ok: true, addr, sec, wData });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GMGN KLINE PROXY ─────────────────────────────────────────────
// Frontend ne peut pas appeler GMGN directement (clé API côté serveur)
app.get('/api/kline/:addr', async (req, res) => {
  const { addr } = req.params;
  const resolution = req.query.res || '1m';
  const GMGN_API_KEY = process.env.GMGN_API_KEY;
  if (!GMGN_API_KEY) return res.status(503).json({ ok: false, error: 'GMGN_API_KEY non configurée' });
  if (!addr || addr.length < 32) return res.status(400).json({ ok: false, error: 'adresse invalide' });

  const timestamp = Math.floor(Date.now() / 1000);
  const client_id = randomUUID();
  const params = new URLSearchParams({ chain: 'sol', address: addr, resolution, timestamp, client_id });
  const url = `https://openapi.gmgn.ai/v1/market/token_kline?${params}`;

  try {
    const r = await fetch(url, {
      headers: { 'X-APIKEY': GMGN_API_KEY, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const json = await r.json();
    if (json.code !== 0) {
      console.warn(`[GMGN kline] code=${json.code} msg=${json.message} addr=${addr}`);
      return res.status(400).json({ ok: false, error: json.message || 'GMGN error', code: json.code });
    }
    console.log(`[GMGN kline] ${addr.slice(0,8)} → ${JSON.stringify(json.data)?.slice(0,120)}`);
    res.json({ ok: true, data: json.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PAPER BOT API ────────────────────────────────────────────────

app.get('/paper/config', async (_req, res) => {
  try { res.json({ ok: true, config: await getPaperConfig() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/paper/config', async (req, res) => {
  try {
    const { config } = req.body || {};
    if (!config) return res.status(400).json({ ok: false, error: 'config manquant' });
    await setPaperConfig(config);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/paper/trades', async (_req, res) => {
  try { res.json({ ok: true, data: await getPaperTrades() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/paper/equity', async (_req, res) => {
  try { res.json({ ok: true, data: await getPaperEquity() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/paper/close', async (req, res) => {
  try {
    const { addr } = req.body || {};
    if (!addr) return res.status(400).json({ ok: false, error: 'addr manquant' });
    const ok = await closePaperTrade(addr);
    res.json({ ok });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/paper/reset', async (_req, res) => {
  try { await resetPaperBot(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── STRIPE & AUTH ────────────────────────────────────────────────

const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean));

app.post('/create-checkout', async (req, res) => {
  const { email, password, plan, period } = req.body || {};
  if (!email || !password || !plan) return res.status(400).json({ ok: false, error: 'email, password et plan requis' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Mot de passe minimum 6 caractères' });
  try {
    const result = await createCheckoutSession({ email, password, plan, period: period || 'monthly' });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[Checkout]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/login', async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ ok: false, error: 'idToken manquant' });
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (ADMIN_EMAILS.has(decoded.email)) {
      return res.json({ ok: true, uid: decoded.uid, email: decoded.email, plan: 'elite', status: 'active', isAdmin: true });
    }
    const sub = await getUserSubscription(decoded.uid);
    if (!sub || sub.status !== 'active') return res.status(403).json({ ok: false, error: 'Abonnement inactif' });
    res.json({ ok: true, uid: decoded.uid, email: decoded.email, plan: sub.plan, status: sub.status });
  } catch (e) {
    res.status(401).json({ ok: false, error: 'Token invalide' });
  }
});

app.get('/subscription/:uid', async (req, res) => {
  try {
    const sub = await getUserSubscription(req.params.uid);
    if (!sub) return res.status(404).json({ ok: false, error: 'Utilisateur introuvable' });
    res.json({ ok: true, ...sub });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── DÉMARRAGE ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Écoute sur port ${PORT}`);

  // Charger les poids IA + smart filters depuis Firebase
  loadWeights();
  loadSmartFilters();

  // Paper bot — tourne en continu côté serveur (indépendant du navigateur)
  startPaperTrader();

  // Premier cycle immédiat
  runScanCycle();
  // Cycle toutes les 15s
  setInterval(runScanCycle, 15000);

  // AI: track outcomes toutes les 5 min (check prix des calls passés)
  setInterval(trackOutcomes, 5 * 60 * 1000);
  // AI: analyse + auto-ajustement toutes les 6h
  setInterval(autoAdjust, 6 * 3600 * 1000);
  // AI: auto-rebuild smart filters toutes les 12h
  setInterval(buildSmartFilters, 12 * 3600 * 1000);
  // Premier track après 2 min (laisser le temps au premier cycle)
  setTimeout(trackOutcomes, 120000);
  // Premier rebuild smart filters après 3 min
  setTimeout(buildSmartFilters, 180000);
});
