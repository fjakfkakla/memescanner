import fetch from 'node-fetch';
import { WALLET_TRACKER, AXIOM_WALLETS } from './axiomWallets.js';
import { scoreTokenV2, hardFilterV2 } from './scorer.js';
import { saveCall, getCallByAddr } from './firebase.js';
import { checkSmartFilters } from './aiEngine.js';
import { gmgnFetchTrenches, gmgnToWalletData } from './gmgn.js';

const HELIUS_KEY  = process.env.HELIUS_KEY;
const HELIUS_RPC  = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API  = `https://api.helius.xyz`;

const AXIOM_SET   = new Set(AXIOM_WALLETS); // flat Set pour lookups rapides

// ── Discord Webhook ──
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1493544718380957776/VykJRVOdAwPLd5jIJ2ODAFhZRSgdX5DKO6nf0AzYXr7HGQZxfI66e7AlOmYkLM4AbGE5";

async function sendDiscordCall(token) {
  const mcapStr = token.mcap >= 1000
    ? `$${(token.mcap / 1000).toFixed(1)}K`
    : `$${token.mcap}`;

  const axiomCount = token.walletData?.count || token.debug?.axiomCount || 0;
  const rugEmoji   = token.rugRisk === 'LOW' ? '🟢' : token.rugRisk === 'MEDIUM' ? '🟡' : '🔴';

  const message = {
    username: "MemeScanner 🔬",
    embeds: [{
      title: `${token.emoji || '🚨'} NEW CALL — ${token.symbol}`,
      color: 0x00ff99,
      fields: [
        { name: "📊 Score",       value: `**${token.score}/170**`,         inline: true },
        { name: "💰 Mcap",        value: mcapStr,                           inline: true },
        { name: `${rugEmoji} Rug Risk`, value: token.rugRisk,              inline: true },
        { name: "👛 Axiom Wallets", value: `${axiomCount} wallet${axiomCount > 1 ? 's' : ''}`, inline: true },
        { name: "📋 CA",          value: `\`${token.addr}\``,              inline: false },
        { name: "🔗 DexScreener", value: `[Voir le chart](${token.pairUrl})`, inline: true },
        { name: "💊 Pump.fun",    value: `[Voir sur Pump](https://pump.fun/${token.addr})`, inline: true },
      ],
      footer: { text: "MemeScanner • Solana" },
      timestamp: new Date().toISOString()
    }]
  };

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    });
    if (res.ok) {
      console.log(`[Discord] ✅ Call envoyé: ${token.symbol}`);
    } else {
      console.warn(`[Discord] ⚠️ Erreur ${res.status} pour ${token.symbol}`);
    }
  } catch (e) {
    console.error(`[Discord] ❌ Webhook error: ${e.message}`);
  }
}

// Cache mémoire : tokens déjà callés (évite les doublons)
const calledTokens  = new Map(); // addr → timestamp
const swCache       = new Map(); // addr → { ts, result }
const heliusCache   = new Map(); // addr → { ts, data }
const scoreHistory  = new Map(); // addr → { maxAxiom }
const liveTokens    = new Map(); // addr → { token data, calledAt, lastSeenAt, droppedAt }

// Compteur d'appels Helius + hard limit journalier
const HELIUS_DAILY_LIMIT = parseInt(process.env.HELIUS_DAILY_LIMIT || '200000'); // 200k crédits/jour par défaut
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
const DISCOVERY_WALLETS = AXIOM_WALLETS.slice(0, 10); // Top 10 wallets (réduit conso Helius)
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
        // Cache 5 min par wallet (réduit conso Helius)
        const cached = discoveryCache.get(wallet);
        if (cached && now - cached.ts < 300000) {
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
            .filter(s => s?.signature && (!s.blockTime || (now/1000 - s.blockTime) < 1800)) // dernières 30 min (was 10min)
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
  // Toutes les requêtes search en parallèle (was: séquentiel → ~12s de latence)
  const searchResults = await Promise.allSettled(
    searchQueries.map(q =>
      fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { signal: AbortSignal.timeout(8000) }).then(r => r.json())
    )
  );
  for (let i = 0; i < searchResults.length; i++) {
    const res = searchResults[i];
    if (res.status === 'fulfilled') addPairs(res.value?.pairs, `search "${searchQueries[i]}"`);
    else console.warn(`[DexScreener] search error "${searchQueries[i]}": ${res.reason?.message}`);
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
  if (cached) {
    // 0-count entries expire après 60s (wallet pas encore arrivé → retenter vite)
    // Entries avec wallets → 30min (données stables)
    const ttl = (cached.result?.count || 0) === 0 ? 60000 : 1800000;
    if (Date.now() - cached.ts < ttl) return cached.result;
  }
  if (!canCallHelius()) {
    // Helius bloqué → utiliser le cache même périmé plutôt que retourner 0
    if (cached) return cached.result;
    return { count: 0, wallets: [], clustered: false, byGroup: { KOL: 0, 'gros trader': 0, DEV: 0, farmer: 0 } };
  }

  const sigAddr  = pairAddr || tokenAddr;
  const sigLimit = deep ? 100 : 50; // 50 en normal (was 30), meilleure détection KOL wallets

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
        // Prendre les plus récentes uniquement (suffisant pour détecter Axiom wallets)
        sigs.slice(0, deep ? 50 : 35).forEach(s => { if (s?.signature) sigSet.add(s.signature); });
      }
    });
    const sigList = [...sigSet].slice(0, deep ? 80 : 50); // Max 50 sigs en normal (was 30), 80 en deep
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

    const ownersList     = [...allOwners].filter(o => !KNOWN_PROGRAMS.has(o));
    const matchingOwners = ownersList.filter(o => AXIOM_SET.has(o));
    const newCount       = matchingOwners.length;
    const newWallets     = matchingOwners.slice(0, 4).map(w => w.slice(0, 8) + '…');

    // byGroup : compter par catégorie
    const newByGroup = { KOL: 0, 'gros trader': 0, DEV: 0, farmer: 0 };
    for (const addr of matchingOwners) {
      const grp = WALLET_TRACKER.get(addr);
      if (grp && newByGroup[grp] !== undefined) newByGroup[grp]++;
    }

    const prev       = swCache.get(tokenAddr)?.result;
    const prevCount  = prev?.count || 0;
    const prevByGroup = prev?.byGroup || { KOL: 0, 'gros trader': 0, DEV: 0, farmer: 0 };
    const count      = Math.max(newCount, prevCount);
    const wallets    = count > newCount && prev?.wallets?.length ? prev.wallets : newWallets;
    // byGroup : prendre le max par groupe (sticky)
    const byGroup = {
      KOL:          Math.max(newByGroup.KOL,          prevByGroup.KOL || 0),
      'gros trader':Math.max(newByGroup['gros trader'],prevByGroup['gros trader'] || 0),
      DEV:          Math.max(newByGroup.DEV,           prevByGroup.DEV || 0),
      farmer:       Math.max(newByGroup.farmer,        prevByGroup.farmer || 0),
    };

    const result = { count, wallets, clustered: count >= 2, byGroup };
    swCache.set(tokenAddr, { ts: Date.now(), result, maxEver: count });
    return result;
  } catch (e) {
    return { count: 0, wallets: [], clustered: false, byGroup: { KOL: 0, 'gros trader': 0, DEV: 0, farmer: 0 } };
  }
}

// Pipeline principal — tourne toutes les 45s
let _scanRunning = false;
export async function runScanCycle() {
  if (_scanRunning) { console.log('[Worker] Cycle skipped — précédent encore en cours'); return; }
  _scanRunning = true;
  console.log(`[Worker] Cycle démarré ${new Date().toISOString()}`);
  const rejected = {};

  try {
    // 1a. Collecte DexScreener
    const dexResult = await fetchDexScreener();
    const allPairs = dexResult.pairs;
    const paidTokens = dexResult.paidTokens;

    // 1b. Découverte GMGN trenches (renowned≥1 + smart_degen≥1)
    // Construit aussi une Map addr→wData pour éviter les appels Helius sur ces tokens
    const gmgnWalletMap = new Map(); // addr → wData synthétique depuis GMGN
    try {
      const gmgnTokens = await gmgnFetchTrenches();
      const existingAddrs = new Set(allPairs.map(p => p.baseToken?.address).filter(Boolean));
      const newGmgnAddrs = [];
      for (const t of gmgnTokens) {
        const addr = t.address || t.token_address;
        if (!addr) continue;
        gmgnWalletMap.set(addr, gmgnToWalletData(t));
        if (!existingAddrs.has(addr)) newGmgnAddrs.push(addr);
      }
      if (newGmgnAddrs.length > 0) {
        for (let i = 0; i < newGmgnAddrs.length; i += 30) {
          const batch = newGmgnAddrs.slice(i, i + 30).join(',');
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
            if (newPairs.length > 0) console.log(`[GMGN] +${newPairs.length} paires GMGN ajoutées`);
          } catch (e) {}
        }
      }
    } catch (e) { console.warn('[GMGN] Discovery error:', e.message); }

    // 1c. Découverte Helius : tokens achetés par les top Axiom wallets
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
    console.log(`[Worker] ${allPairs.length} paires collectées (gmgn: ${gmgnWalletMap.size})`);

    // 2. Pré-filtre rapide
    const preFiltered = allPairs.filter(p => {
      const f = hardFilterV2(p);
      if (!f.pass) { rejected[f.reason] = (rejected[f.reason] || 0) + 1; return false; }
      const mcap = p.marketCap || p.fdv || 0;
      const addr = p.baseToken?.address || '';
      if (mcap < 5000 || mcap > 200000) { rejected['mcap hors range'] = (rejected['mcap hors range'] || 0) + 1; return false; }
      if (!addr || addr.length < 32) return false;
      return true;
    });

    console.log(`[Worker] ${preFiltered.length} après pré-filtre`);

    // 3. Vérifications Helius en batch de 3 (rate limiting)
    // Si le token est déjà dans gmgnWalletMap (renowned≥1 + smart_degen≥1),
    // on skip checkAxiomWallets → économie Helius
    const parallelResults = [];
    for (let i = 0; i < preFiltered.length; i += 3) {
      const batch = preFiltered.slice(i, i + 3);
      const batchRes = await Promise.allSettled(
        batch.map(async p => {
          const addr     = p.baseToken.address;
          const pairAddr = p.pairAddress || null;
          const gmgnWData = gmgnWalletMap.get(addr) || null;
          const [sec, wData] = await Promise.allSettled([
            checkTokenSecurity(addr, pairAddr),
            gmgnWData ? Promise.resolve(gmgnWData) : checkAxiomWallets(addr, pairAddr),
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
        if (scored.mcap < 13000) { rejected['mcap<13K'] = (rejected['mcap<13K'] || 0) + 1; continue; }

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

        if (scored.score >= 80) {
          finalScored.push(scored);
        } else {
          rejected[`score<80 (${scored.score})`] = (rejected[`score<80 (${scored.score})`] || 0) + 1;
        }
      } catch (e) {
        console.warn('[Worker] Scoring error:', e.message);
      }
    }

    finalScored.sort((a, b) => b.score - a.score);
    const gmgnHits = [...gmgnWalletMap.keys()].filter(a => preFiltered.some(p => p.baseToken?.address === a)).length;
    console.log(`[Worker] ${finalScored.length} calls | helius today: ${heliusCalls.today} | gmgn hits: ${gmgnHits} | rejected:`, JSON.stringify(rejected));

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
          // 1. Sauvegarder + notifier Discord immédiatement avec le mcap du scan
          await saveCall({
            addr:       token.addr,
            symbol:     token.symbol,
            score:      token.score,
            mcap:       token.mcap,
            liq:        token.liq,
            rugRisk:    token.rugRisk,
            socials:    token.socials,
            pairUrl:    token.pairUrl,
            debug:      token.debug,
            walletData: token.walletData,
            security:   token.raw?.security || null,
            calledAt:   now,
          });
          console.log(`[Worker] CALL: ${token.symbol} score=${token.score} mcap=$${token.mcap}`);
          // Discord en premier — pas de fetch mcap frais qui bloque
          await sendDiscordCall(token);

          // 2. Mcap frais en arrière-plan (ne bloque plus le Discord)
          fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.addr}`,
            { signal: AbortSignal.timeout(5000) })
            .then(r => r.json())
            .then(freshData => {
              const freshPair = (freshData.pairs || []).find(p => p.chainId === 'solana');
              const freshMcap = freshPair?.marketCap || freshPair?.fdv || 0;
              if (freshMcap > 0) saveCall({ addr: token.addr, mcap: freshMcap, callMcap: freshMcap }).catch(() => {});
            })
            .catch(() => {});
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
  } finally {
    _scanRunning = false;
  }
}

// Exports pour server.js
export function getLiveTokens() { return [...liveTokens.values()]; }
export function getHeliusStats() {
  return { ...heliusCalls, limit: HELIUS_DAILY_LIMIT, remaining: Math.max(0, HELIUS_DAILY_LIMIT - heliusCalls.today), limitReached: heliusCalls.today >= HELIUS_DAILY_LIMIT };
}
export { checkTokenSecurity as checkTokenSecurityExport, checkAxiomWallets as checkAxiomWalletsExport };
