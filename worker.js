import fetch from 'node-fetch';
import { AXIOM_WALLETS } from './axiomWallets.js';
import { scoreTokenV2, hardFilterV2 } from './scorer.js';
import { saveCall, getCallByAddr } from './firebase.js';
import { checkSmartFilters } from './aiEngine.js';

const HELIUS_KEY  = process.env.HELIUS_KEY;
const HELIUS_RPC  = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API  = `https://api.helius.xyz`;

const AXIOM_SET   = new Set(AXIOM_WALLETS);

// Cache mémoire : tokens déjà callés (évite les doublons)
const calledTokens  = new Map(); // addr → timestamp
const swCache       = new Map(); // addr → { ts, result }
const heliusCache   = new Map(); // addr → { ts, data }
const scoreHistory  = new Map(); // addr → { maxAxiom }
const liveTokens    = new Map(); // addr → { token data, calledAt, lastSeenAt, droppedAt }

// Compteur d'appels Helius + hard limit journalier
const HELIUS_DAILY_LIMIT = parseInt(process.env.HELIUS_DAILY_LIMIT || '300000'); // 300k crédits/jour par défaut
let heliusCalls = { total: 0, today: 0, dayStart: Date.now(), blocked: 0 };
function trackHelius(n = 1) {
  if (Date.now() - heliusCalls.dayStart > 86400000) {
    console.log(`[Helius] Daily reset. Yesterday: ${heliusCalls.today} calls, ${heliusCalls.blocked} blocked`);
    heliusCalls.today = 0; heliusCalls.blocked = 0; heliusCalls.dayStart = Date.now();
  }
  heliusCalls.total += n; heliusCalls.today += n;
}
function canCallHelius() {
  if (Date.now() - heliusCalls.dayStart > 86400000) {
    heliusCalls.today = 0; heliusCalls.blocked = 0; heliusCalls.dayStart = Date.now();
  }
  if (heliusCalls.today >= HELIUS_DAILY_LIMIT) {
    heliusCalls.blocked++;
    if (heliusCalls.blocked % 100 === 1) console.warn(`[Helius] ⛔ DAILY LIMIT HIT (${HELIUS_DAILY_LIMIT}). ${heliusCalls.blocked} calls blocked.`);
    return false;
  }
  return true;
}

// Appels DexScreener en parallèle (12 endpoints)
async function fetchRetry(url, options = {}, retries = 2, delayMs = 800) {
  for (let i = 0; i <= retries; i++) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;
    if (i < retries) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
  }
  return fetch(url, options);
}

// ── Découverte de tokens via Helius : surveiller les achats récents des top Axiom wallets ──
const DISCOVERY_WALLETS = AXIOM_WALLETS.slice(0, 25); // Top 25 wallets pour couvrir plus de traders
const discoveryCache = new Map(); // wallet → { ts, tokens }

async function discoverTokensFromAxiom() {
  if (!canCallHelius()) return [];
  const discovered = new Set();
  const now = Date.now();

  // Batch de 5 wallets en parallèle
  for (let i = 0; i < DISCOVERY_WALLETS.length; i += 5) {
    const batch = DISCOVERY_WALLETS.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async wallet => {
        // Cache 90s par wallet — refresh rapide pour capter les achats tôt
        const cached = discoveryCache.get(wallet);
        if (cached && now - cached.ts < 90000) {
          cached.tokens.forEach(t => discovered.add(t));
          return;
        }
        try {
          // Récupérer les dernières signatures du wallet
          const sigResp = await fetchRetry(HELIUS_RPC, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'disc', method: 'getSignaturesForAddress', params: [wallet, { limit: 10 }] }),
            signal: AbortSignal.timeout(8000)
          });
          trackHelius();
          const sigData = await sigResp.json();
          const sigs = (sigData?.result || [])
            .filter(s => s?.signature && (!s.blockTime || (now/1000 - s.blockTime) < 600)) // dernières 10 min
            .map(s => s.signature);

          if (sigs.length === 0) { discoveryCache.set(wallet, { ts: now, tokens: [] }); return; }

          // Parser les transactions pour extraire les token mints
          const parseResp = await fetchRetry(
            `${HELIUS_API}/v0/transactions?api-key=${HELIUS_KEY}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions: sigs }), signal: AbortSignal.timeout(10000) }
          );
          trackHelius();
          const parsed = await parseResp.json();
          const tokens = new Set();
          if (Array.isArray(parsed)) {
            for (const tx of parsed) {
              // Chercher les token transfers (achats = le wallet reçoit des tokens)
              if (!Array.isArray(tx?.tokenTransfers)) continue;
              for (const tt of tx.tokenTransfers) {
                if (tt?.toUserAccount === wallet && tt?.mint && tt.mint.length >= 32) {
                  // Exclure SOL et tokens connus
                  if (tt.mint === 'So11111111111111111111111111111111111111112') continue;
                  tokens.add(tt.mint);
                }
              }
            }
          }
          discoveryCache.set(wallet, { ts: now, tokens: [...tokens] });
          tokens.forEach(t => discovered.add(t));
        } catch (e) { /* skip wallet */ }
      })
    );
    if (i + 5 < DISCOVERY_WALLETS.length) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[Discovery] ${discovered.size} tokens trouvés via ${DISCOVERY_WALLETS.length} Axiom wallets`);
  return [...discovered];
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
  const paidTokens = new Set(); // tokens qui ont payé profil ou boost
  for (const res of profileResults) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const item of res.value) {
      if (item.chainId === 'solana' && item.tokenAddress) {
        tokenAddrs.add(item.tokenAddress);
        paidTokens.add(item.tokenAddress);
      }
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

  // ── ÉTAPE 3 : Search trending (requêtes variées — max de tokens frais) ──
  const searchQueries = [
    'pumpfun',              // 24 fresh tokens — meilleure source
    'SOL pump',             // 7 fresh
    'pump.fun',             // 2 fresh + différents de pumpfun
    'pump.fun solana',      // variantes
    'pumpswap',             // tokens migrés
    'bonk solana new',      // launchlab
    'solana memecoin',      // memecoins généraux
    'solana new token',     // nouveaux tokens
  ];
  for (const q of searchQueries) {
    try {
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { signal: AbortSignal.timeout(8000) });
      const data = await resp.json();
      addPairs(data.pairs, `search "${q}"`);
    } catch (e) { console.warn(`[DexScreener] search error: ${e.message}`); }
  }

  console.log(`[DexScreener] Total unique: ${pairMap.size}, paid: ${paidTokens.size}`);
  return { pairs: [...pairMap.values()], paidTokens };
}

async function checkTokenSecurity(tokenAddr, pairAddr = null) {
  const cached = heliusCache.get(tokenAddr);
  if (cached && Date.now() - cached.ts < 300000) return cached.data;
  if (!canCallHelius()) return null;

  try {
    trackHelius(2); // getAsset + getTokenLargestAccounts
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
      const meta  = asset?.content?.metadata || {};
      const ext   = meta.extensions || {};
      const socials = meta.socials || [];
      // pump.fun stocke twitter/telegram/website directement dans metadata ou extensions
      let twitter  = links.twitter || links.x || meta.twitter || meta.x || ext.twitter || socials.find(s => s.type === 'twitter')?.url || '';
      let telegram = links.telegram || meta.telegram || ext.telegram || socials.find(s => s.type === 'telegram')?.url || '';
      let website  = links.website || links.external_url || meta.website || meta.external_url || ext.website || '';
      // Vérifier aussi les attributes (certains tokens les utilisent)
      for (const attr of (meta.attributes || [])) {
        if (!twitter  && (attr.trait_type === 'twitter' || attr.trait_type === 'Twitter'))   twitter  = attr.value;
        if (!telegram && (attr.trait_type === 'telegram' || attr.trait_type === 'Telegram')) telegram = attr.value;
        if (!website  && (attr.trait_type === 'website' || attr.trait_type === 'Website'))   website  = attr.value;
      }
      // Fallback: fetch JSON URI (pump.fun metadata on-chain)
      if (!twitter && !telegram) {
        const jsonUri = asset?.content?.json_uri;
        if (jsonUri && jsonUri.startsWith('http')) {
          try {
            const mj = await fetch(jsonUri, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
            twitter  = twitter  || mj?.twitter  || mj?.extensions?.twitter  || '';
            telegram = telegram || mj?.telegram || mj?.extensions?.telegram || '';
            website  = website  || mj?.website  || mj?.extensions?.website  || mj?.external_url || '';
          } catch(e) { /* optionnel */ }
        }
      }
      hasTwitter  = !!twitter;
      hasTelegram = !!telegram;
      hasWebsite  = !!website;
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
  if (!canCallHelius()) return { count: 0, wallets: [], clustered: false };

  const sigAddr  = pairAddr || tokenAddr;
  const sigLimit = deep ? 200 : 80; // Augmenté pour capter plus d'Axiom wallets sur tokens actifs

  try {
    trackHelius(3); // 2x getSignaturesForAddress + getTokenAccounts
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
        body: JSON.stringify({ jsonrpc: '2.0', id: 'das', method: 'getTokenAccounts', params: { mint: tokenAddr, limit: 200, displayOptions: {} } }),
        signal: AbortSignal.timeout(12000)
      }).then(r => r.json()),
    ]);

    const sigSet = new Set();
    [sigPairRes, sigMintRes].forEach(r => {
      if (r.status === 'fulfilled') {
        const sigs = r.value?.result || [];
        // Newest : traders récents + Oldest : early buyers (wallets qui ont vendu depuis)
        sigs.slice(0, deep ? 150 : 40).forEach(s => { if (s?.signature) sigSet.add(s.signature); });
        sigs.slice(-(deep ? 150 : 40)).forEach(s => { if (s?.signature) sigSet.add(s.signature); });
        if (deep) sigs.forEach(s => { if (s?.signature) sigSet.add(s.signature); });
      }
    });
    const sigList = [...sigSet].slice(0, deep ? 300 : 100); // Max 100 sigs en normal, 300 en deep
    const allOwners = new Set();

    if (sigList.length > 0) {
      const parseBatches = [];
      for (let i = 0; i < sigList.length; i += 100) parseBatches.push(sigList.slice(i, i + 100));
      for (const batch of parseBatches) {
      try {
        trackHelius();
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
    // 1a. Collecte DexScreener
    const dexResult = await fetchDexScreener();
    const allPairs = dexResult.pairs;
    const paidTokens = dexResult.paidTokens;

    // 1b. Découverte Helius : tokens achetés par les top Axiom wallets
    try {
      const axiomTokens = await discoverTokensFromAxiom();
      // Filtrer les tokens déjà dans allPairs
      const existingAddrs = new Set(allPairs.map(p => p.baseToken?.address).filter(Boolean));
      const newTokens = axiomTokens.filter(t => !existingAddrs.has(t));
      if (newTokens.length > 0) {
        // Fetch pair data depuis DexScreener pour ces tokens
        for (let i = 0; i < newTokens.length; i += 30) {
          const batch = newTokens.slice(i, i + 30).join(',');
          try {
            const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch}`,
              { signal: AbortSignal.timeout(10000) });
            const data = await resp.json();
            const newPairs = (data.pairs || []).filter(p => p.chainId === 'solana' && p.baseToken?.address);
            for (const p of newPairs) {
              if (!existingAddrs.has(p.baseToken.address)) {
                allPairs.push(p);
                existingAddrs.add(p.baseToken.address);
              }
            }
            if (newPairs.length > 0) console.log(`[Discovery] +${newPairs.length} paires Axiom ajoutées`);
          } catch (e) {}
        }
      }
    } catch (e) { console.warn('[Discovery] Error:', e.message); }
    console.log(`[Worker] ${allPairs.length} paires collectées`);

    // 2. Pré-filtre rapide
    const preFiltered = allPairs.filter(p => {
      const f = hardFilterV2(p);
      if (!f.pass) { rejected[f.reason] = (rejected[f.reason] || 0) + 1; return false; }
      const mcap = p.marketCap || p.fdv || 0;
      const addr = p.baseToken?.address || '';
      if (mcap < 15000 || mcap > 200000) { rejected['mcap hors range'] = (rejected['mcap hors range'] || 0) + 1; return false; }
      if (!addr || addr.length < 32) return false;
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

        // Marquer les tokens dex paid (profil ou boost payé sur DexScreener)
        const tokenAddr = p.baseToken?.address || '';
        if (paidTokens.has(tokenAddr)) p._isPaid = true;
        // Aussi checker info.imageUrl et profile (indicateurs de profil payé)
        if (p.info?.imageUrl || p.profile?.icon || p.profile?.header) p._isPaid = true;

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

        // HARD FILTER 1 — Platform Pump/Bonk/Raydium/Bags
        const dexId  = (p.dexId || '').toLowerCase();
        const pairUrl = (p.url  || '').toLowerCase();
        const isPump  = dexId.includes('pump') || pairUrl.includes('pump');
        const isBonk  = dexId.includes('bonk') || dexId.includes('launchlab');
        const isRay   = dexId.includes('raydium') || dexId.includes('cpmm') || dexId.includes('clmm');
        const isPumpSwap = dexId.includes('pumpswap') || pairUrl.includes('pumpswap');
        const isBags  = dexId.includes('bags');
        if (!isPump && !isBonk && !isRay && !isPumpSwap && !isBags) { rejected['platform'] = (rejected['platform'] || 0) + 1; continue; }

        // HARD FILTER 2 — Mcap min
        if (scored.mcap < 15000) { rejected['mcap<15K'] = (rejected['mcap<15K'] || 0) + 1; continue; }

        // SMART FILTER IA — filtres adaptatifs appris des données
        const smartCheck = checkSmartFilters(scored.debug || {});
        if (!smartCheck.pass) {
          rejected[`AI_reject`] = (rejected[`AI_reject`] || 0) + 1;
          console.log(`[AI] Rejeté ${scored.symbol}: ${smartCheck.reasons[0]}`);
          continue;
        }
        // Appliquer pénalité IA au score si pas reject
        if (smartCheck.penalty) {
          scored.score = Math.max(0, scored.score + smartCheck.penalty);
          scored.debug.aiPenalty = smartCheck.penalty;
          scored.debug.aiReasons = smartCheck.reasons;
        }

        if (scored.score >= 90) {
          finalScored.push(scored);
        } else {
          rejected[`score<90 (${scored.score})`] = (rejected[`score<90 (${scored.score})`] || 0) + 1;
        }
      } catch (e) {
        console.warn('[Worker] Scoring error:', e.message);
      }
    }

    finalScored.sort((a, b) => b.score - a.score);
    console.log(`[Worker] ${finalScored.length} calls | helius today: ${heliusCalls.today} | rejected:`, JSON.stringify(rejected));

    // 5. Save calls + update liveTokens
    const now = Date.now();
    const qualifyingAddrs = new Set(finalScored.map(t => t.addr));

    for (const token of finalScored) {
      let existing = liveTokens.get(token.addr);

      // Si pas en mémoire, vérifier Firebase (survit aux redémarrages)
      if (!existing) {
        try {
          const fbCall = await getCallByAddr(token.addr);
          if (fbCall) {
            existing = { calledAt: fbCall.calledAt || fbCall.callTime || fbCall.savedAt, callMcap: fbCall.callMcap || fbCall.mcap };
          }
        } catch (e) { /* pas grave */ }
      }

      // Mettre à jour liveTokens
      liveTokens.set(token.addr, {
        addr:      token.addr,
        symbol:    token.symbol,
        score:     token.score,
        mcap:      token.mcap,
        liq:       token.liq,
        rugRisk:   token.rugRisk,
        socials:   token.socials,
        pairUrl:   token.pairUrl,
        debug:     token.debug,
        walletData: token.walletData,
        emoji:     token.emoji,
        raw:       token.raw,
        callMcap:  existing?.callMcap || token.mcap,
        calledAt:  existing?.calledAt || now,
        lastSeenAt: now,
        droppedAt: null,
      });

      // Sauvegarder dans Firebase (saveCall gère le dedup)
      if (!calledTokens.has(token.addr)) {
        calledTokens.set(token.addr, now);
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
            calledAt: now,
          });
          console.log(`[Worker] CALL: ${token.symbol} score=${token.score} mcap=$${token.mcap}`);
        } catch (e) {
          console.warn('[Worker] saveCall error:', e.message);
        }
      } else {
        // Mettre à jour le score/mcap dans Firebase sans toucher calledAt
        try { await saveCall({ addr: token.addr, score: token.score, mcap: token.mcap, liq: token.liq, debug: token.debug }); } catch(e) {}
      }
    }

    // Marquer les tokens qui ne qualifient plus + purger après 5 min
    for (const [addr, data] of liveTokens) {
      if (!qualifyingAddrs.has(addr)) {
        if (!data.droppedAt) {
          data.droppedAt = now;
          console.log(`[Worker] ${data.symbol} dropped (score was ${data.score}), 5min countdown`);
        }
        if (now - data.droppedAt > 300000) {
          liveTokens.delete(addr);
          console.log(`[Worker] ${data.symbol} removed from live (5min expired)`);
        }
      }
    }

    console.log(`[Worker] Live tokens: ${liveTokens.size}`);
  } catch (e) {
    console.error('[Worker] Cycle error:', e.message);
  }
}

// ── FAST DISCOVERY CYCLE — toutes les 15s, uniquement Axiom discovery ──
// Détecte les tokens achetés par les top wallets et les qualifie immédiatement
// sans attendre le cycle principal DexScreener (45s)
export async function runFastDiscovery() {
  try {
    const axiomTokens = await discoverTokensFromAxiom();
    if (!axiomTokens.length) return;

    // Fetch pair data depuis DexScreener pour ces tokens
    const existingAddrs = new Set([...liveTokens.keys()]);
    const newTokens = axiomTokens.filter(t => !existingAddrs.has(t));
    if (!newTokens.length) return;

    const allPairs = [];
    for (let i = 0; i < newTokens.length; i += 30) {
      try {
        const batch = newTokens.slice(i, i + 30).join(',');
        const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch}`, { signal: AbortSignal.timeout(10000) });
        const data = await resp.json();
        if (data.pairs) allPairs.push(...data.pairs.filter(p => p.chainId === 'solana'));
      } catch (e) {}
    }
    if (!allPairs.length) return;

    // Quick filter + score + qualify
    const now = Date.now();
    let fastCalls = 0;
    for (const p of allPairs) {
      const addr = p.baseToken?.address;
      if (!addr || existingAddrs.has(addr)) continue;
      const mcap = p.marketCap || p.fdv || 0;
      if (mcap < 15000 || mcap > 200000) continue;
      const ageH = (now - (p.pairCreatedAt || 0)) / 3600000;
      if (ageH > 1 || ageH < 0.005) continue;

      // Platform check
      const dexId = (p.dexId || '').toLowerCase();
      const pairUrl = (p.url || '').toLowerCase();
      const isPump = dexId.includes('pump') || pairUrl.includes('pump');
      const isBonk = dexId.includes('bonk') || dexId.includes('launchlab');
      const isRay = dexId.includes('raydium') || dexId.includes('cpmm') || dexId.includes('clmm');
      const isBags = dexId.includes('bags');
      if (!isPump && !isBonk && !isRay && !isBags) continue;

      // Check security + axiom
      try {
        const [sec, wData] = await Promise.all([
          checkTokenSecurity(addr, p.pairAddress || null),
          checkAxiomWallets(addr, p.pairAddress || null),
        ]);
        if (!sec || sec.mintAuthority !== null || sec.freezeAuthority !== null) continue;
        if (parseFloat(sec.top1Pct) > 20) continue;
        if (parseFloat(sec.top5Pct) > 55) continue;
        if ((wData?.count || 0) < 1) continue;

        p.security = sec;
        if (p.info?.imageUrl || p.profile?.icon || p.profile?.header) p._isPaid = true;

        const scored = scoreTokenV2(p, wData);
        if (scored.score < 90) continue;

        // Qualifié ! Ajouter en live
        const token = { ...scored, calledAt: now, lastSeenAt: now, droppedAt: null };
        liveTokens.set(scored.addr, token);
        existingAddrs.add(scored.addr);
        fastCalls++;

        try { await saveCall({ addr: scored.addr, symbol: scored.symbol, score: scored.score, mcap: scored.mcap, liq: scored.liq, rugRisk: scored.rugRisk, socials: scored.socials, pairUrl: scored.pairUrl, debug: scored.debug, calledAt: now }); } catch(e) {}
        console.log(`[FastDisc] 🚀 EARLY CALL: ${scored.symbol} score=${scored.score} mcap=$${scored.mcap} (${Math.round(ageH*60)}min old)`);
      } catch (e) {}
    }
    if (fastCalls > 0) console.log(`[FastDisc] ${fastCalls} nouveaux calls via discovery rapide`);
  } catch (e) {
    console.warn('[FastDisc] Error:', e.message);
  }
}

// Exports pour server.js
export function getLiveTokens() { return [...liveTokens.values()]; }
export function getHeliusStats() {
  return { ...heliusCalls, limit: HELIUS_DAILY_LIMIT, remaining: Math.max(0, HELIUS_DAILY_LIMIT - heliusCalls.today), limitReached: heliusCalls.today >= HELIUS_DAILY_LIMIT };
}
export { checkTokenSecurity as checkTokenSecurityExport, checkAxiomWallets as checkAxiomWalletsExport };
