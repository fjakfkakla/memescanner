import express from 'express';
import cors    from 'cors';
import { getCalls, getHistory } from './firebase.js';
import { runScanCycle } from './worker.js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── ENDPOINTS ────────────────────────────────────────────────────

// Ping
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now(), uptime: process.uptime() });
});

// Tokens callés dans les 2 dernières heures
app.get('/live', async (_req, res) => {
  try {
    const calls = await getCalls(2);
    res.json({ ok: true, count: calls.length, data: calls });
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

// ── DÉMARRAGE ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Écoute sur port ${PORT}`);

  // Premier cycle immédiat
  runScanCycle();
  // Cycle toutes les 45s
  setInterval(runScanCycle, 45000);
});
