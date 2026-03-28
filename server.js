// ============================================================
// MEME SCANNER — Backend API Server
// Deploy on Railway (free) : railway.app
// ENV vars required : HELIUS_KEY
// ============================================================

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const PORT  = process.env.PORT || 3000;

// Override HELIUS_KEY depuis env avant d'importer scan.js
// (scan.js lit process.env.HELIUS_KEY s'il est défini)
if (process.env.HELIUS_KEY) {
  // On patchera après l'import via les exports
}

const scanner = require('./scan.js');

// Si HELIUS_KEY est fourni en env, override la clé du scan
// (permet de ne pas avoir la clé dans le code sur Railway)
const HELIUS_KEY_ENV = process.env.HELIUS_KEY;

// ── Cache résultats du scan ───────────────────────────────────
let scanCache = {
  tokens:     [],   // tokens scorés prêts pour le frontend
  pairs:      0,    // nb paires analysées
  candidates: 0,    // nb candidats évalués
  lastUpdate: 0,    // timestamp dernier scan
  error:      null,
};

// ── Logique du scan serveur (45s loop) ───────────────────────
async function doScan() {
  try {
    const ENDPOINTS = [
      'https://api.dexscreener.com/token-profiles/latest/v1',
      'https://api.dexscreener.com/token-boosts/latest/v1',
      'https://api.dexscreener.com/latest/dex/search?q=pump.fun',
      'https://api.dexscreener.com/latest/dex/search?q=pumpfun',
      'https://api.dexscreener.com/latest/dex/search?q=pump+solana',
      'https://api.dexscreener.com/latest/dex/search?q=bonk+launchlab',
      'https://api.dexscreener.com/latest/dex/search?q=launchlab+solana',
    ];

    console.log('[SERVER SCAN] Start', new Date().toISOString());

    const [dexResults, heliusPairs] = await Promise.all([
      Promise.allSettled(ENDPOINTS.map(scanner.fetchPairs)),
      scanner.fetchNewPumpTokens(),
    ]);

    const seen = new Set(), pairs = [];
    const _48H = 48 * 3600000, _now = Date.now();

    for (const r of dexResults) {
      if (r.status !== 'fulfilled') continue;
      for (const p of r.value) {
        if (!p || p.chainId !== 'solana') continue;
        const m = p.marketCap || p.fdv || 0;
        if (m > 200000 || m < 5000) continue;
        if (p.pairCreatedAt && (_now - p.pairCreatedAt) > _48H) continue;
        const addr = p.baseToken?.address || p.pairAddress || Math.random().toString();
        if (seen.has(addr)) continue;
        seen.add(addr); pairs.push(p);
      }
    }
    for (const p of (heliusPairs || [])) {
      if (!p || p.chainId !== 'solana') continue;
      const m = p.marketCap || p.fdv || 0;
      if (m > 200000 || m < 5000) continue;
      if (p.pairCreatedAt && (_now - p.pairCreatedAt) > _48H) continue;
      const addr = p.baseToken?.address || p.pairAddress || '';
      if (!addr || seen.has(addr)) continue;
      seen.add(addr); pairs.push(p);
    }

    console.log(`[SERVER SCAN] ${pairs.length} paires`);

    // Pré-score sans Helius pour filtrer les candidats
    const candidates = pairs.filter(p => {
      const ah = (_now - (p.pairCreatedAt || 0)) / 3600000;
      return ah >= 0.02 && ah <= 1;
    });
    let preScored = candidates.map(p => scanner.scoreTokenV2(p)).filter(t => t.score >= 30);
    preScored.sort((a, b) => b.score - a.score);
    preScored = preScored.slice(0, 20);

    console.log(`[SERVER SCAN] ${preScored.length} candidats`);

    const finalTokens = [];

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    for (const t of preScored) {
      try {
        await sleep(1500); // éviter flood Helius (429)
        // checkTokenSecurity (Helius — caché 10min)
        const sec = await scanner.checkTokenSecurity(t.addr, t.raw?.pairAddress || null);
        if (sec) {
          if (sec.mintAuthority !== null)   continue;
          if (sec.freezeAuthority !== null) continue;
          if (parseFloat(sec.top1Pct) > 25) continue;
          if (parseFloat(sec.top5Pct) > 55) continue;
          t.raw.security = sec;
        }

        // checkAxiomWallets (Helius — caché 30min)
        const wData = await scanner.checkAxiomWallets(t.addr, t.raw?.pairAddress || null);
        const rescored = scanner.scoreTokenV2(t.raw, wData);

        // Hard filters
        const rp   = rescored.raw;
        const rdex = (rp?.dexId || '').toLowerCase();
        const rurl = (rp?.url   || '').toLowerCase();
        const isPump = rdex.includes('pump') || rurl.includes('pump') ||
            (rp?.baseToken?.address||'').endsWith('pump') ||
            rdex.includes('bonk') || rdex.includes('launchlab') ||
            rdex.includes('bags') || rurl.includes('bags');
        if (!isPump) { console.log(`[FILTER] ${rescored.symbol} éliminé: pas pump/bonk (dex=${rdex} url=${rurl})`); continue; }

        const rmc = rescored.mcap || 0;
        if (rmc < 15000 || rmc > 100000) { console.log(`[FILTER] ${rescored.symbol} éliminé: mcap ${rmc}`); continue; }
        const ageH = (_now - (rp?.pairCreatedAt || 0)) / 3600000;
        if (ageH > 1) { console.log(`[FILTER] ${rescored.symbol} éliminé: âge ${ageH.toFixed(2)}h`); continue; }
        const wCount = rescored.walletData?.count || 0;
        if (wCount < 1) { console.log(`[FILTER] ${rescored.symbol} éliminé: 0 wallets tracker (score=${rescored.score})`); continue; }
        if (rescored.score < 80) { console.log(`[FILTER] ${rescored.symbol} éliminé: score ${rescored.score} < 80`); continue; }

        // Sauvegarder dans Firebase (même que scan.js)
        await scanner.saveCall(
          rescored.addr, rescored.mcap, _now,
          rescored.symbol, rescored.score,
          rp?.pairAddress || ''
        );

        // Enrichir pour le frontend
        rescored.security  = sec;
        rescored.pairUrl   = rp?.url || `https://dexscreener.com/solana/${rescored.addr}`;
        rescored._callTime = _now;
        rescored.debug     = {
          traderScore:   rescored.walletData?.count >= 5 ? 20 :
                         rescored.walletData?.count >= 4 ? 15 :
                         rescored.walletData?.count >= 3 ? 10 :
                         rescored.walletData?.count >= 2 ?  8 :
                         rescored.walletData?.count >= 1 ?  5 : 0,
          socialScore:   sec?.socialCount ? Math.min(26, sec.socialCount * 10) : 0,
          holderScore:   parseFloat(sec?.top10Pct || 0) <= 20 ? 10 : 5,
          platformScore: 5,
          mcapScore:     rmc <= 30000 ? 15 : rmc <= 60000 ? 10 : 5,
          ageScore:      (() => { const m=(Date.now()-(rp?.pairCreatedAt||0))/60000; return m<=5?10:m<=15?5:0; })(),
          patternScore:  0,
        };

        finalTokens.push(rescored);
      } catch(e) { console.warn(`[SERVER] ${t.symbol}:`, e.message); }
    }

    finalTokens.sort((a, b) => b.score - a.score);

    scanCache = {
      tokens:     finalTokens,
      pairs:      pairs.length,
      candidates: preScored.length,
      lastUpdate: Date.now(),
      error:      null,
    };

    console.log(`[SERVER SCAN] Done — ${finalTokens.length} tokens dans le cache`);
  } catch(e) {
    console.error('[SERVER SCAN] Erreur:', e.message);
    scanCache.error = e.message;
  }
}

// ── Boucle de scan toutes les 45s ────────────────────────────
async function scanLoop() {
  await doScan();
  setTimeout(scanLoop, 45000);
}

// ── Serveur HTTP ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS — autoriser le site GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/api/scan') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scanCache));

  } else if (url.startsWith('/api/wallets')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const addr = qs.get('addr');
    const pair = qs.get('pair') || null;
    if (!addr) { res.writeHead(400); res.end('missing addr'); return; }
    scanner.checkAxiomWallets(addr, pair).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: 0, wallets: [], clustered: false }));
    });

  } else if (url === '/api/health') {
    const age = scanCache.lastUpdate ? Math.round((Date.now() - scanCache.lastUpdate) / 1000) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      lastUpdate: scanCache.lastUpdate,
      ageSeconds: age,
      tokens: scanCache.tokens.length,
    }));

  } else if (url === '/' || url === '/index.html') {
    // Servir le frontend HTML
    const htmlPath = path.join(__dirname, 'index.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });

  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`[SERVER] Démarré sur le port ${PORT}`);
  // Lancer le premier scan immédiatement
  scanLoop();
});
