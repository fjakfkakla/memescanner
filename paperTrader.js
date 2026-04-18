import fetch from 'node-fetch';
import { db } from './firebase.js';
import { getLiveTokens } from './worker.js';

const DEFAULT_CFG = {
  enabled: true,
  capital: 400,
  posSize: 50,
  tp1: 1.3, tp2: 1.5, tp3: 2.0, tp4: 3.0, tp5: 5.0, tp6: 10.0, tp7: 15.0, tp8: 20.0,
  sl: 20,
  minScore: 0,
};

const TP_LEVELS = [
  { n: 1, key: 'tp1', frac: 0.30 },
  { n: 2, key: 'tp2', frac: 0.30 },
  { n: 3, key: 'tp3', frac: 0.20 },
  { n: 4, key: 'tp4', frac: 0.60 },
  { n: 5, key: 'tp5', frac: 0.25 },
  { n: 6, key: 'tp6', frac: 0.50 },
  { n: 7, key: 'tp7', frac: 0.50 },
  { n: 8, key: 'tp8', frac: 1.00 },
];

function sanitizeAddr(addr) {
  return addr.replace(/[.#$\/\[\]]/g, '_');
}

let lastKnownAddrs = new Set();
let scanInterval = null;

// ── Config ──
export async function getPaperConfig() {
  const snap = await db.ref('paperBot/config').once('value');
  return { ...DEFAULT_CFG, ...(snap.val() || {}) };
}

export async function setPaperConfig(cfg) {
  await db.ref('paperBot/config').set({ ...DEFAULT_CFG, ...cfg });
}

// ── Trades ──
export async function getPaperTrades(limitClosed = 100) {
  const snap = await db.ref('paperBot/trades').once('value');
  const all = snap.val() || {};
  const open = [], closed = [];
  for (const t of Object.values(all)) {
    // Normalise sells (Firebase object → array)
    t.sells = t.sells ? Object.values(t.sells) : [];
    if (t.status === 'open') open.push(t);
    else closed.push(t);
  }
  closed.sort((a, b) => (b.exitTime || b.entryTime) - (a.exitTime || a.entryTime));
  return [...open, ...closed.slice(0, limitClosed)];
}

export async function closePaperTrade(addr) {
  const key = sanitizeAddr(addr);
  const ref = db.ref(`paperBot/trades/${key}`);
  const snap = await ref.once('value');
  const t = snap.val();
  if (!t || t.status !== 'open') return false;
  await ref.update({ status: 'closed', exitTime: Date.now(), exitReason: 'MANUAL' });
  return true;
}

export async function resetPaperBot() {
  await db.ref('paperBot/trades').remove();
  await db.ref('paperBot/equity').remove();
}

// ── Equity ──
export async function getPaperEquity() {
  const snap = await db.ref('paperBot/equity').orderByChild('ts').once('value');
  return snap.val() ? Object.values(snap.val()) : [];
}

// ── Prix batch ──
async function getBatchPrices(tradeList) {
  const priceMap = {};

  // 1. Live tokens en mémoire (0 appel API)
  getLiveTokens().forEach(t => { if (t.mcap > 0) priceMap[t.addr] = t.mcap; });

  // 2. DexScreener batch pour les manquants (max 30)
  const missing = tradeList.filter(t => !priceMap[t.addr]).map(t => t.addr).slice(0, 30);
  if (missing.length) {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${missing.join(',')}`,
        { signal: AbortSignal.timeout(7000) }
      );
      const data = await res.json();
      const best = {};
      (data.pairs || []).forEach(p => {
        const a = p.baseToken?.address;
        if (!a) return;
        if (!best[a] || (p.volume?.h24 || 0) > (best[a].volume?.h24 || 0)) best[a] = p;
      });
      Object.entries(best).forEach(([a, p]) => {
        priceMap[a] = parseFloat(p.marketCap || p.fdv || 0);
      });
    } catch (e) {}
  }

  return priceMap;
}

// ── Ouvrir un trade ──
async function openTrade(token, cfg) {
  const key = sanitizeAddr(token.addr);
  const existing = (await db.ref(`paperBot/trades/${key}`).once('value')).val();
  if (existing?.status === 'open') return;

  const rawEntryMcap = token._callMcap || token.mcap || 0;
  const entryMcap = rawEntryMcap * 1.01; // slippage achat simulé +1%
  if (!entryMcap) return;

  await db.ref(`paperBot/trades/${key}`).set({
    id: `pt_${Date.now()}`,
    addr: token.addr,
    symbol: (token.symbol || '?').toUpperCase(),
    score: token.score || 0,
    axiom: token.debug?.axiomCount || 0,
    entryMcap,
    entryTime: Date.now(),
    posSize: cfg.posSize,
    status: 'open',
    athX: 1.0,
    remainFraction: 1.0,
    sells: {},
    totalPnlUsd: 0,
    exitMcap: null,
    exitTime: null,
    exitReason: null,
    pairUrl: token.pairUrl || '',
    pairAddr: token.raw?.pairAddress || '',
  });

  console.log(`[PaperBot] 📝 Open $${(token.symbol || '?').toUpperCase()} entry $${Math.round(entryMcap / 1000)}K`);
}

// ── Vérifier les positions ──
async function checkPositions(cfg) {
  const snap = await db.ref('paperBot/trades').orderByChild('status').equalTo('open').once('value');
  const trades = snap.val() || {};
  const tradeList = Object.entries(trades);
  if (!tradeList.length) return;

  const priceMap = await getBatchPrices(tradeList.map(([, t]) => t));
  const now = Date.now();

  for (const [key, t] of tradeList) {
    const curMcap = priceMap[t.addr] || 0;
    if (!curMcap || !t.entryMcap) continue;

    const xNow = curMcap / t.entryMcap;
    const updates = { currentX: xNow };
    if (xNow > (t.athX || 1)) updates.athX = xNow;

    const existingSells = t.sells ? Object.values(t.sells) : [];
    const hitReasons = existingSells.map(s => s.reason);
    let remainFraction = t.remainFraction || 1;
    let totalPnlUsd = t.totalPnlUsd || 0;
    let closed = false;
    let exitReason = null;

    const doSell = (reason, fracOfRemain) => {
      const realFrac = remainFraction * fracOfRemain;
      if (realFrac < 0.001) return;
      const xEffective = xNow * 0.985; // slippage vente simulé -1.5%
      const pnlUsd = (t.posSize || 50) * realFrac * (xEffective - 1);
      const sellKey = `s${now}_${reason}`;
      updates[`sells/${sellKey}`] = { reason, xAt: xNow, fraction: realFrac, pnlUsd, time: now };
      remainFraction = Math.max(0, remainFraction - realFrac);
      totalPnlUsd += pnlUsd;
      hitReasons.push(reason);
    };

    // SL
    if (xNow <= 1 - (cfg.sl || 20) / 100) {
      doSell('SL', 1.0);
      closed = true;
      exitReason = 'SL';
    } else {
      // TPs séquentiels
      for (const tp of TP_LEVELS) {
        const reason = `TP${tp.n}`;
        if (!hitReasons.includes(reason) && xNow >= cfg[tp.key] && remainFraction > 0.001) {
          doSell(reason, tp.frac);
        }
      }
      if (remainFraction <= 0.001) {
        closed = true;
        exitReason = hitReasons[hitReasons.length - 1] || 'DONE';
      }
    }

    updates.remainFraction = remainFraction;
    updates.totalPnlUsd = totalPnlUsd;

    if (closed) {
      updates.status = 'closed';
      updates.exitReason = exitReason;
      updates.exitMcap = curMcap;
      updates.exitTime = now;

      // Courbe equity
      const eqSnap = await db.ref('paperBot/equity').orderByChild('ts').limitToLast(1).once('value');
      const lastEq = eqSnap.val() ? Object.values(eqSnap.val())[0] : null;
      const lastVal = lastEq ? lastEq.val : cfg.capital;
      await db.ref('paperBot/equity').push({ ts: now, val: Math.round((lastVal + totalPnlUsd) * 100) / 100 });

      const sign = totalPnlUsd >= 0 ? '+' : '';
      console.log(`[PaperBot] ${exitReason} $${t.symbol} @${xNow.toFixed(2)}x — ${sign}$${totalPnlUsd.toFixed(1)}`);
    }

    await db.ref(`paperBot/trades/${key}`).update(updates);
  }
}

// ── Boucle principale ──
async function scanLoop() {
  try {
    const cfg = await getPaperConfig();
    if (!cfg.enabled) return;

    const live = getLiveTokens();
    const curAddrs = new Set(live.map(t => t.addr));

    for (const token of live) {
      if (!lastKnownAddrs.has(token.addr) && (token.score || 0) >= (cfg.minScore || 0)) {
        await openTrade(token, cfg);
      }
    }
    lastKnownAddrs = curAddrs;

    await checkPositions(cfg);
  } catch (e) {
    console.error('[PaperBot] scanLoop error:', e.message);
  }
}

// ── Start / Stop ──
export function startPaperTrader() {
  if (scanInterval) return;
  console.log('[PaperBot] 📝 Paper trading bot démarré (cycle 7s)');
  scanLoop();
  scanInterval = setInterval(scanLoop, 7000);
}

export function stopPaperTrader() {
  if (!scanInterval) return;
  clearInterval(scanInterval);
  scanInterval = null;
  console.log('[PaperBot] Arrêté');
}
