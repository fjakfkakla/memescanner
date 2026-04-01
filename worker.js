import fetch from 'node-fetch';
import { AXIOM_WALLETS } from './axiomWallets.js';
import { scoreTokenV2, hardFilterV2 } from './scorer.js';
import { saveCall } from './firebase.js';

const HELIUS_KEY  = process.env.HELIUS_KEY;
const HELIUS_RPC  = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API  = `https://api.helius.xyz`;

const AXIOM_SET   = new Set(AXIOM_WALLETS);

// Cache mémoire : tokens déjà callés (évite les doublons)
const calledTokens  = new Map(); // addr → timestamp
const swCache       = new Map(); // addr → { ts, result }
const heliusCache   = new Map(); // addr → { ts, data }
const scoreHistory  = new Map(); // addr → { maxAxiom }

// Appels DexScreener en parallèle (12 endpoints)
async function fetchRetry(url, options = {}, retries = 2, delayMs = 800) {
  for (let i = 0; i <= retries; i++) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;
    if (i < retries) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
  }
  return fetch(url, options);
}

async function fetchDexScreener() {
  const pairMap = new Map();

  function addPairs(pairs, source) {
    let count = 0;
    for (const p of (Array.isArray(pairs) ? pairs : [])) {
      if (!p?.baseToken?.address) continue;
      if ((p.chainId || p.chain || '') !== 'solana') continue;
      const addr = p.baseToken.address;
      if (!pairMap.has(addr)) { pairMap.set(addr, p); count++; }
    }
    if (count > 0) console.log(`[DexScreener] ${source}: +${count} paires`);
  }

  // ── ÉTAPE 1 : Token profiles & boosts → récolter les adresses Solana ──
  const profileUrls = [
    'https://api.dexscreener.com/token-profiles/latest/v1',
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-boosts/top/v1',
  ];
  const profileResults = await Promise.allSettled(
    profileUrls.map(url =>
      fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => null)
    )
  );
  const tokenAddrs = new Set();
  for (const res of profileResults) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const item of res.value) {
      if (item.chainId === 'solana' && item.tokenAddress) tokenAddrs.add(item.tokenAddress);
    }
  }
  console.log(`[DexScreener] Profiles/boosts: ${tokenAddrs.size} adresses Solana`);

  // ── ÉTAPE 2 : Fetch pair data pour ces tokens (batch de 30 max) ──
  const addrList = [...tokenAddrs];
  for (let i = 0; i < addrList.length; i += 30) {
    const batch = addrList.slice(i, i + 30).join(',');
    try {
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch}`,
        { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      addPairs(data.pairs, `tokens-batch-${Math.floor(i/30)}`);
    } catch (e) { console.warn(`[DexScreener] tokens-batch error: ${e.message}`); }
    if (i + 30 < addrList.length) await new Promise(r => setTimeout(r, 300));
  }

  // ── ÉTAPE 3 : Search trending (requêtes variées) ──
  const searchQueries = ['pump.fun solana', 'pumpswap', 'bonk solana new', 'solana memecoin'];
  for (const q of searchQueries) {
    try {
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { signal: AbortSignal.timeout(8000) });
      const data = await resp.json();
      addPairs(data.pairs, `search "${q}"`);
    } catch (e) { console.warn(`[DexScreener] search error: ${e.message}`); }
  }

  console.log(`[DexScreener] Total unique: ${pairMap.size}`);
  return [...pairMap.values()];
}

async function checkTokenSecurity(tokenAddr, pairAddr = null) {
  const cached = heliusCache.get(tokenAddr);
  if (cached && Date.now() - cached.ts < 120000) return cached.data;

  try {
    const [assetRes, holdersRes] = await Promise.allSettled([
      fetchRetry(HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'asset', method: 'getAsset', params: { id: tokenAddr } }),
        signal: AbortSignal.timeout(8000)
      }).then(r => r.json()),
      fetchRetry(HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'holders', method: 'getTokenLargestAccounts', params: [tokenAddr] }),
        signal: AbortSignal.timeout(8000)
      }).then(r => r.json()),
    ]);

    let hasTwitter = false, hasTelegram = false, hasWebsite = false;
    let mintAuthority = null, freezeAuthority = null;

    if (assetRes.status === 'fulfilled') {
      const asset = assetRes.value?.result;
      const links = asset?.content?.links || {};
      const socials = asset?.content?.metadata?.socials || [];
      hasTwitter  = !!(links.twitter  || links.x || socials.find(s => s.type === 'twitter'));
      hasTelegram = !!(links.telegram || socials.find(s => s.type === 'telegram'));
      hasWebsite  = !!(links.website  || asset?.content?.links?.website);
      mintAuthority   = asset?.mint_extensions?.mint_close_authority || null;
      freezeAuthority = asset?.mint_extensions?.permanent_delegate   || null;
    }

    let top1Pct = 0, top5Pct = 0, top10Pct = 0, holderCount = 0;
    if (holdersRes.status === 'fulfilled') {
      const accounts = holdersRes.value?.result?.value || [];
      const supply = accounts.reduce((s, a) => s + (a.uiAmount || 0), 0) || 1;
      const exclude = new Set([pairAddr].filter(Boolean));
      const filtered = accounts.filter(a => !exclude.has(a.address));
      const sorted   = [...filtered].sort((a, b) => (b.uiAmount || 0) - (a.uiAmount || 0));
      // Exclure le #1 holder (LP pool / bonding curve) — toujours le plus gros
      // Scorer uniquement les vrais wallets [2..11]
      const real   = sorted.slice(1, 11);
      holderCount  = real.length;
      const pct = (n) => real.slice(0, n).reduce((s, a) => s + (a.uiAmount || 0), 0) / supply * 100;
      top1Pct  = pct(1);
      top5Pct  = pct(5);
      top10Pct = pct(10);
    }

    const data = { mintAuthority, freezeAuthority, top1Pct: top1Pct.toFixed(1), top5Pct: top5Pct.toFixed(1), top10Pct: top10Pct.toFixed(1), holderCount, hasTwitter, hasTelegram, hasWebsite };
    heliusCache.set(tokenAddr, { ts: Date.now(), data });
    return data;
  } catch (e) {
    return null;
  }
}

async function checkAxiomWallets(tokenAddr, pairAddr = null, deep = false) {
  const cached = swCache.get(tokenAddr);
  if (cached && Date.now() - cached.ts < 1800000) return cached.result;

  const sigAddr  = pairAddr || tokenAddr;
  const sigLimit = deep ? 500 : 100;

  try {
    const [sigPairRes, sigMintRes, dasRes] = await Promise.allSettled([
      fetchRetry(HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'sigs1', method: 'getSignaturesForAddress', params: [sigAddr, { limit: sigLimit }] }),
        signal: AbortSignal.timeout(20000)
      }).then(r => r.json()),
      fetchRetry(HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'sigs2', method: 'getSignaturesForAddress', params: [tokenAddr, { limit: sigLimit }] }),
        signal: AbortSignal.timeout(20000)
      }).then(r => r.json()),
      fetchRetry(HELIUS_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'das', method: 'getTokenAccounts', params: { mint: tokenAddr, limit: 1000, displayOptions: {} } }),
        signal: AbortSignal.timeout(12000)
      }).then(r => r.json()),
    ]);

    const sigSetNew = new Set();
    const sigSetOld = new Set();
    [sigPairRes, sigMintRes].forEach(r => {
      if (r.status === 'fulfilled') {
        const sigs = r.value?.result || [];
        sigs.slice(0, 50).forEach(s => { if (s?.signature) sigSetNew.add(s.signature); });
        sigs.slice(-50).forEach(s => { if (s?.signature) sigSetOld.add(s.signature); });
        if (deep) sigs.forEach(s => { if (s?.signature) sigSetNew.add(s.signature); });
      }
    });
    const sigList = deep
      ? [...new Set([...sigSetNew, ...sigSetOld])]
      : [...new Set([...sigSetNew, ...sigSetOld])].slice(0, 100);
    const allOwners = new Set();

    if (sigList.length > 0) {
      const parseBatches = [];
      for (let i = 0; i < sigList.length; i += 100) parseBatches.push(sigList.slice(i, i + 100));
      for (const batch of parseBatches) {
      try {
        const parseResp = await fetchRetry(
          `${HELIUS_API}/v0/transactions?api-key=${HELIUS_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions: batch }), signal: AbortSignal.timeout(20000) },
          3, 1000
        );
        const parsedTxs = await parseResp.json();
        if (Array.isArray(parsedTxs)) {
          parsedTxs.forEach(tx => {
            const relevantTTs = Array.isArray(tx?.tokenTransfers)
              ? tx.tokenTransfers.filter(tt => tt?.mint === tokenAddr)
              : [];
            if (relevantTTs.length > 0 && tx?.feePayer?.length >= 32) allOwners.add(tx.feePayer);
            relevantTTs.forEach(tt => {
              if (tt?.fromUserAccount?.length >= 32) allOwners.add(tt.fromUserAccount);
              if (tt?.toUserAccount?.length >= 32)   allOwners.add(tt.toUserAccount);
            });
          });
        }
      } catch (e) {}
      } // fin parseBatches loop
    }

    if (dasRes.status === 'fulfilled') {
      (dasRes.value?.result?.token_accounts || []).forEach(a => { if (a.owner) allOwners.add(a.owner); });
    }

    const KNOWN_PROGRAMS = new Set([
      '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'So11111111111111111111111111111111111111112', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bXP', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'ComputeBudget111111111111111111111111111111', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      'SysvarRent111111111111111111111111111111111', 'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV',
    ]);
    if (pairAddr) KNOWN_PROGRAMS.add(pairAddr);

    const ownersList    = [...allOwners].filter(o => !KNOWN_PROGRAMS.has(o));
    const matchingOwners = ownersList.filter(o => AXIOM_SET.has(o));
    const newCount      = matchingOwners.length;
    const newWallets    = matchingOwners.slice(0, 4).map(w => w.slice(0, 8) + '…');

    const prev      = swCache.get(tokenAddr)?.result;
    const prevCount = prev?.count || 0;
    const count     = Math.max(newCount, prevCount);
    const wallets   = count > newCount && prev?.wallets?.length ? prev.wallets : newWallets;

    const result = { count, wallets, clustered: count >= 2 };
    swCache.set(tokenAddr, { ts: Date.now(), result, maxEver: count });
    return result;
  } catch (e) {
    return { count: 0, wallets: [], clustered: false };
  }
}

// Pipeline principal — tourne toutes les 45s
export async function runScanCycle() {
  console.log(`[Worker] Cycle démarré ${new Date().toISOString()}`);
  const rejected = {};

  try {
    // 1. Collecte DexScreener
    const allPairs = await fetchDexScreener();
    console.log(`[Worker] ${allPairs.length} paires collectées`);

    // 2. Pré-filtre rapide
    const preFiltered = allPairs.filter(p => {
      const f = hardFilterV2(p);
      if (!f.pass) { rejected[f.reason] = (rejected[f.reason] || 0) + 1; return false; }
      const mcap = p.marketCap || p.fdv || 0;
      const addr = p.baseToken?.address || '';
      if (mcap < 5000 || mcap > 200000) { rejected['mcap hors range'] = (rejected['mcap hors range'] || 0) + 1; return false; }
      if (!addr || addr.length < 32) return false;
      if (calledTokens.has(addr) && Date.now() - calledTokens.get(addr) < 7200000) {
        rejected['déjà callé'] = (rejected['déjà callé'] || 0) + 1; return false;
      }
      return true;
    });

    console.log(`[Worker] ${preFiltered.length} après pré-filtre`);

    // 3. Vérifications Helius en batch de 3 (rate limiting)
    const parallelResults = [];
    for (let i = 0; i < preFiltered.length; i += 3) {
      const batch = preFiltered.slice(i, i + 3);
      const batchRes = await Promise.allSettled(
        batch.map(async p => {
          const addr     = p.baseToken.address;
          const pairAddr = p.pairAddress || null;
          const [sec, wData] = await Promise.allSettled([
            checkTokenSecurity(addr, pairAddr),
            checkAxiomWallets(addr, pairAddr),
          ]);
          return {
            p,
            sec:   sec.status   === 'fulfilled' ? sec.value   : null,
            wData: wData.status === 'fulfilled' ? wData.value : { count: 0, wallets: [], clustered: false },
          };
        })
      );
      parallelResults.push(...batchRes);
      if (i + 3 < preFiltered.length) await new Promise(r => setTimeout(r, 600));
    }

    // 4. Score + hard filters
    const finalScored = [];
    for (const res of parallelResults) {
      if (res.status !== 'fulfilled') continue;
      const { p, sec, wData } = res.value;
      try {
        // Filtres sécurité
        if (sec) {
          if (sec.mintAuthority   !== null) { rejected['mint authority']   = (rejected['mint authority']   || 0) + 1; continue; }
          if (sec.freezeAuthority !== null) { rejected['freeze authority'] = (rejected['freeze authority'] || 0) + 1; continue; }
          if (parseFloat(sec.top1Pct)  > 20) { rejected[`top1 ${sec.top1Pct}%`]  = (rejected[`top1 ${sec.top1Pct}%`]  || 0) + 1; continue; }
          if (parseFloat(sec.top5Pct)  > 55) { rejected[`top5 ${sec.top5Pct}%`]  = (rejected[`top5 ${sec.top5Pct}%`]  || 0) + 1; continue; }
          p.security = sec;
        }

        const scored = scoreTokenV2(p, wData);

        // Sticky Axiom
        const hist      = scoreHistory.get(scored.addr) || {};
        const stickyAxiom = Math.max(scored.debug.traderScore, hist.maxAxiom || 0);
        if (stickyAxiom > scored.debug.traderScore) {
          scored.score += stickyAxiom - scored.debug.traderScore;
          scored.debug.traderScore = stickyAxiom;
        }
        scoreHistory.set(scored.addr, { maxAxiom: Math.max(hist.maxAxiom || 0, scored.debug.axiomCount) });

        // HARD FILTER 0 — Axiom obligatoire
        if ((wData.count || 0) < 1) { rejected['no_axiom'] = (rejected['no_axiom'] || 0) + 1; continue; }

        // HARD FILTER 1 — Platform Pump/Bonk/Raydium
        const dexId  = (p.dexId || '').toLowerCase();
        const pairUrl = (p.url  || '').toLowerCase();
        const isPump  = dexId.includes('pump') || pairUrl.includes('pump');
        const isBonk  = dexId.includes('bonk') || dexId.includes('launchlab');
        const isRay   = dexId.includes('raydium') || dexId.includes('cpmm');
        if (!isPump && !isBonk && !isRay) { rejected['platform'] = (rejected['platform'] || 0) + 1; continue; }

        // HARD FILTER 2 — Mcap min
        if (scored.mcap < 15000) { rejected['mcap<15K'] = (rejected['mcap<15K'] || 0) + 1; continue; }

        // Seuil dynamique : 65 pts si ≥5 Axiom wallets, 80 sinon
        const callThreshold = (wData.count || 0) >= 5 ? 65 : 80;
        if (scored.score >= callThreshold) {
          finalScored.push(scored);
        } else {
          rejected[`score<${callThreshold} (${scored.score})`] = (rejected[`score<${callThreshold} (${scored.score})`] || 0) + 1;
        }
      } catch (e) {
        console.warn('[Worker] Scoring error:', e.message);
      }
    }

    finalScored.sort((a, b) => b.score - a.score);
    console.log(`[Worker] ${finalScored.length} calls | rejected:`, JSON.stringify(rejected));

    // 5. Save calls
    for (const token of finalScored) {
      if (calledTokens.has(token.addr)) continue;
      calledTokens.set(token.addr, Date.now());
      try {
        await saveCall({
          addr:     token.addr,
          symbol:   token.symbol,
          score:    token.score,
          mcap:     token.mcap,
          liq:      token.liq,
          rugRisk:  token.rugRisk,
          socials:  token.socials,
          pairUrl:  token.pairUrl,
          debug:    token.debug,
          calledAt: Date.now(),
        });
        console.log(`[Worker] CALL: ${token.symbol} score=${token.score} mcap=$${token.mcap}`);
      } catch (e) {
        console.warn('[Worker] saveCall error:', e.message);
      }
    }
  } catch (e) {
    console.error('[Worker] Cycle error:', e.message);
  }
}

// Exports pour server.js (Debug CA endpoint)
export { checkTokenSecurity as checkTokenSecurityExport, checkAxiomWallets as checkAxiomWalletsExport };
