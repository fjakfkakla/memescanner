import express from 'express';
import cors    from 'cors';
import { getCalls, getHistory, getCodes, saveCodes, getCall, putCall, patchCall, getAllCalls, getRugs, putRugs, patchRugs, getReviews, putReviews } from './firebase.js';
import { runScanCycle, getLiveTokens, checkTokenSecurityExport, checkAxiomWalletsExport, getHeliusStats } from './worker.js';
import { trackOutcomes, autoAdjust, loadWeights, getAIPanel, getWinrateStats, deepAnalyze, buildSmartFilters, loadSmartFilters, checkSmartFilters, smartFilters } from './aiEngine.js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
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

// ── FIREBASE PROXY — protège l'URL Firebase du frontend ──────────
app.get('/fb/codes', async (_req, res) => {
  try { res.json(await getCodes()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/fb/codes', async (req, res) => {
  try { await saveCodes(req.body); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/fb/calls', async (_req, res) => {
  try { res.json(await getAllCalls()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/fb/calls/:key', async (req, res) => {
  try { res.json(await getCall(req.params.key)); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/fb/calls/:key', async (req, res) => {
  try { await putCall(req.params.key, req.body); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/fb/calls/:key', async (req, res) => {
  try { await patchCall(req.params.key, req.body); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/fb/rugs', async (_req, res) => {
  try { res.json(await getRugs()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/fb/rugs', async (req, res) => {
  try { await putRugs(req.body); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/fb/rugs', async (req, res) => {
  try { await patchRugs(req.body); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/fb/reviews', async (_req, res) => {
  try { res.json(await getReviews()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/fb/reviews', async (req, res) => {
  try { await putReviews(req.body); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// Batch analyze — proxy pour le frontend scanner
app.post('/analyze-batch', async (req, res) => {
  const { tokens } = req.body || {};
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ ok: false, error: 'tokens array required' });
  try {
    const results = await Promise.allSettled(
      tokens.slice(0, 10).map(async ({ addr, pair }) => {
        const [sec, wData] = await Promise.all([
          checkTokenSecurityExport(addr, pair || null),
          checkAxiomWalletsExport(addr, pair || null),
        ]);
        return { addr, sec, wData };
      })
    );
    const data = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ── DÉMARRAGE ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Écoute sur port ${PORT}`);

  // Charger les poids IA + smart filters depuis Firebase
  loadWeights();
  loadSmartFilters();

  // Premier cycle immédiat
  runScanCycle();
  // Cycle toutes les 45s
  setInterval(runScanCycle, 45000);

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
