import fetch from 'node-fetch';

// Cache : durée 5 minutes
let _cache = { ts: 0, tokens: new Set() };
const CACHE_TTL = 5 * 60 * 1000;

// Headers qui imitent un vrai navigateur pour tenter de passer Cloudflare
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
};

// Regex adresses Solana : base58, 43-44 caractères (32 bytes encodés)
const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{43,44}/g;

function parseAddressesFromHtml(html) {
  const found = new Set();

  // 1. Extraire le JSON __NEXT_DATA__ injecté par Next.js
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]{10,})<\/script>/);
  if (m) {
    try {
      const text = m[1];
      const matches = text.match(SOL_ADDR_RE) || [];
      for (const a of matches) found.add(a);
    } catch (_) {}
  }

  // 2. Chercher toutes les adresses dans le HTML brut (fallback)
  const rawMatches = html.match(SOL_ADDR_RE) || [];
  for (const a of rawMatches) found.add(a);

  return found;
}

async function tryFetch(url) {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(12000),
    compress: true,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchKolfiTokens() {
  const now = Date.now();
  if (now - _cache.ts < CACHE_TTL) return _cache.tokens;

  const addresses = new Set();

  // Tentative 1 : page HTML principale (Next.js __NEXT_DATA__)
  try {
    const html = await tryFetch('https://www.kolfi.com/tokens');
    const found = parseAddressesFromHtml(html);
    for (const a of found) addresses.add(a);
    if (addresses.size > 0) {
      console.log(`[Kolfi] ✅ ${addresses.size} tokens chargés depuis /tokens`);
      _cache = { ts: now, tokens: addresses };
      return addresses;
    }
  } catch (e) {
    console.warn(`[Kolfi] /tokens: ${e.message}`);
  }

  // Tentative 2 : endpoint API JSON courant (Next.js data route)
  try {
    const res = await fetch('https://www.kolfi.com/api/tokens', {
      headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json();
      const text = JSON.stringify(json);
      const matches = text.match(SOL_ADDR_RE) || [];
      for (const a of matches) addresses.add(a);
      if (addresses.size > 0) {
        console.log(`[Kolfi] ✅ ${addresses.size} tokens depuis /api/tokens`);
        _cache = { ts: now, tokens: addresses };
        return addresses;
      }
    }
  } catch (_) {}

  // Si on a rien, on garde le cache précédent (évite de vider si downtime temporaire)
  if (_cache.tokens.size > 0) {
    console.warn(`[Kolfi] Fetch échoué — cache précédent conservé (${_cache.tokens.size} tokens)`);
    _cache.ts = now; // renouveler le TTL pour ne pas spam
    return _cache.tokens;
  }

  console.warn('[Kolfi] Aucune donnée disponible (site inaccessible ?)');
  return addresses;
}
