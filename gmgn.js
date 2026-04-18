import { randomUUID } from 'crypto';
import fetch from 'node-fetch';

const GMGN_HOST    = 'https://openapi.gmgn.ai';
const GMGN_API_KEY = process.env.GMGN_API_KEY;

const SOL_PLATFORMS = [
  "Pump.fun", "pump_mayhem", "pump_mayhem_agent", "pump_agent",
  "letsbonk", "bonkers", "bags", "moonshot_app",
  "Moonshot", "boop", "ray_launchpad", "meteora_virtual_curve",
];

let _trenchesCache = { ts: 0, data: [] };
const CACHE_TTL = 45000; // 45s — aligned with scan cycle

function buildUrl(base, query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, item);
    } else {
      params.set(k, String(v));
    }
  }
  return `${base}?${params.toString()}`;
}

// Returns array of token objects from GMGN trenches.
// Each item has: address (or token_address), renowned_count, smart_degen_count,
// usd_market_cap, rug_ratio, bundler_rate, insider_ratio, created_timestamp, etc.
export async function gmgnFetchTrenches() {
  if (!GMGN_API_KEY) {
    console.warn('[GMGN] GMGN_API_KEY non définie — trenches désactivé');
    return [];
  }

  const now = Date.now();
  if (now - _trenchesCache.ts < CACHE_TTL) {
    return _trenchesCache.data;
  }

  const timestamp = Math.floor(now / 1000);
  const client_id = randomUUID();
  const url = buildUrl(`${GMGN_HOST}/v1/trenches`, { chain: 'sol', timestamp, client_id });

  const section = {
    filters: ["offchain", "onchain"],
    launchpad_platform: SOL_PLATFORMS,
    launchpad_platform_v2: true,
    quote_address_type: [4, 5, 3, 1, 13, 0],
    limit: 80,
    min_renowned_count: 1,
    min_smart_degen_count: 1,
    max_rug_ratio: 0.5,
    max_bundler_rate: 0.5,
    max_marketcap: 200000,
    max_created: "30m",
  };

  const body = {
    version: "v2",
    new_creation:   { ...section },
    near_completion: { ...section },
    completed:      { ...section },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-APIKEY': GMGN_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[GMGN] trenches HTTP ${res.status}: ${text.slice(0, 120)}`);
      return _trenchesCache.data;
    }

    const json = await res.json();
    if (json.code !== 0) {
      console.warn(`[GMGN] trenches API error: code=${json.code} msg=${json.message}`);
      return _trenchesCache.data;
    }

    const sections = json.data || {};
    const tokens = [];
    const seen = new Set();
    for (const key of ['new_creation', 'near_completion', 'completed']) {
      const list = sections[key];
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        const addr = t.address || t.token_address;
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        tokens.push(t);
      }
    }

    console.log(`[GMGN] ${tokens.length} tokens trenches (renowned≥1 + smart_degen≥1)`);
    _trenchesCache = { ts: now, data: tokens };
    return tokens;
  } catch (e) {
    console.warn(`[GMGN] trenches error: ${e.message}`);
    return _trenchesCache.data;
  }
}

// Build a wData object from GMGN token data (replaces Helius checkAxiomWallets).
// renowned = KOL, smart_degen = gros trader
export function gmgnToWalletData(t) {
  const kol     = Math.max(0, parseInt(t.renowned_count    || 0, 10));
  const trader  = Math.max(0, parseInt(t.smart_degen_count || 0, 10));
  return {
    count:     kol + trader,
    byGroup:   { KOL: kol, 'gros trader': trader, DEV: 0, farmer: 0 },
    wallets:   [],
    clustered: kol + trader >= 2,
    source:    'gmgn',
  };
}
