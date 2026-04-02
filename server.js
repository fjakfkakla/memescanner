import express from 'express';
import cors    from 'cors';
import { getCalls, getHistory } from './firebase.js';
import { runScanCycle, getLiveTokens, checkTokenSecurityExport, checkAxiomWalletsExport } from './worker.js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── ENDPOINTS ────────────────────────────────────────────────────

// Ping
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now(), uptime: process.uptime() });
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

  // Premier cycle immédiat
  runScanCycle();
  // Cycle toutes les 45s
  setInterval(runScanCycle, 45000);
});
