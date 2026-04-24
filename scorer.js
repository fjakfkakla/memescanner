const EMOJIS = ['🐸','🚀','💎','🌙','🔥','⚡','🦊','🐶','🐱','🎰','🍌','🧸','🦍','🐻','🎯'];

// ── GMGN SCORING (signaux de risque externes, inchangé) ───────────────────
function calculateGmgnScore(g) {
  if (!g || Object.keys(g).length === 0) return { score: 0, hardReject: null };

  if (g.is_wash_trading === true)     return { score: 0, hardReject: 'gmgn_wash_trading' };
  if ((g.rug_ratio ?? 0) > 0.85)     return { score: 0, hardReject: `gmgn_rug_${Math.round((g.rug_ratio ?? 0) * 100)}%` };
  if ((g.bundler_mhr ?? 0) > 0.75)   return { score: 0, hardReject: `gmgn_bundler_${Math.round((g.bundler_mhr ?? 0) * 100)}%` };

  let score = 0;

  const rug = g.rug_ratio ?? 0;
  if      (rug > 0.5)  score -= 15;
  else if (rug > 0.3)  score -= 8;

  const bundler = g.bundler_mhr ?? 0;
  if      (bundler > 0.5)  score -= 12;
  else if (bundler > 0.3)  score -= 5;

  const insider = g.suspected_insider_hold_rate ?? 0;
  if      (insider > 0.3)  score -= 12;
  else if (insider > 0.1)  score -= 5;

  const top10 = g.top_10_holder_rate ?? 0;
  if      (top10 > 0.7)  score -= 12;
  else if (top10 > 0.5)  score -= 5;

  const fresh = g.fresh_wallet_rate ?? 0;
  if      (fresh > 0.7)  score -= 10;
  else if (fresh > 0.5)  score -= 5;

  const rat = g.rat_trader_amount_rate ?? 0;
  if      (rat > 0.4)  score -= 10;
  else if (rat > 0.2)  score -= 5;

  const entrap = g.entrapment_ratio ?? 0;
  if      (entrap > 0.5)  score -= 15;
  else if (entrap > 0.3)  score -= 8;

  const sniper70 = g.top70_sniper_hold_rate ?? 0;
  if      (sniper70 > 0.5)  score -= 10;
  else if (sniper70 > 0.3)  score -= 5;

  const devHold = g.dev_team_hold_rate ?? 0;
  if      (devHold > 0.2)  score -= 8;
  else if (devHold > 0.1)  score -= 4;

  if (g.image_dup === true) score -= 10;

  const renames = g.twitter_rename_count ?? 0;
  if      (renames > 5)  score -= 15;
  else if (renames > 2)  score -= 8;

  const openRatio = g.creator_created_open_ratio ?? null;
  if (openRatio !== null && openRatio < 0.2 && (g.creator_created_count ?? 0) > 5) score -= 8;

  if (g.cto_flag === true) score += 8;

  const tgCalls = g.tg_call_count ?? 0;
  if      (tgCalls >= 10)  score += 10;
  else if (tgCalls >= 3)   score += 5;

  const followers = g.x_user_follower ?? 0;
  if      (followers >= 5000)  score += 10;
  else if (followers >= 500)   score += 5;

  if (g.has_at_least_one_social === true) score += 3;
  if (g.dexscr_ad)                        score += 8;

  const completeCost = g.complete_cost_time ?? null;
  if (completeCost !== null && completeCost < 300) score += 5;

  const botDegen = g.bot_degen_count ?? 0;
  if      (botDegen >= 3)  score += 5;
  else if (botDegen >= 1)  score += 3;

  const netBuy = g.net_buy_24h ?? null;
  if (netBuy !== null && netBuy > 0) score += 5;

  return { score: Math.max(-50, Math.min(50, score)), hardReject: null };
}

function hardFilterV2(p) {
  const ageH = (Date.now() - (p.pairCreatedAt || 0)) / 3600000;
  const mcap  = p.marketCap || p.fdv || 0;
  if (mcap < 3000) return { pass: false, reason: `mcap $${mcap} < $3K` };
  if (ageH > 0.33) return { pass: false, reason: `trop vieux ${(ageH * 60).toFixed(0)}min` };
  return { pass: true, ageH };
}

// ── 1. WALLET TRACKER ────────────────────────────────────────────────────────
// Points par signature historique : même si le wallet a vendu, il reste compté
function calculateWalletScore(byGroup) {
  const kol    = byGroup['KOL']         || 0;
  const trader = byGroup['gros trader'] || 0;
  const farmer = byGroup['farmer']      || 0;

  let kolPts = 0;
  if      (kol >= 6) kolPts = 20;
  else if (kol === 5) kolPts = 15;
  else if (kol === 4) kolPts = 12;
  else if (kol === 3) kolPts = 8;
  else if (kol === 2) kolPts = 5;
  else if (kol === 1) kolPts = 2;

  let traderPts = 0;
  if      (trader >= 6) traderPts = 18;
  else if (trader === 5) traderPts = 14;
  else if (trader === 4) traderPts = 11;
  else if (trader === 3) traderPts = 8;
  else if (trader === 2) traderPts = 6;
  else if (trader === 1) traderPts = 4;

  let farmerPts = 0;
  if      (farmer >= 5) farmerPts = -15;
  else if (farmer === 4) farmerPts = -10;
  else if (farmer === 3) farmerPts = -5;
  else if (farmer === 2) farmerPts = -4;
  else if (farmer === 1) farmerPts = -3;

  return { kolPts, traderPts, farmerPts, total: kolPts + traderPts + farmerPts };
}

// ── 2. SOCIAL ────────────────────────────────────────────────────────────────
// Twitter +10 si < 1 min du lancement, +5 sinon (mutuellement exclusifs)
// Tous les autres sont cumulables
function calculateSocialScore(p, sec, ageMin, gmgn = {}) {
  const dexSocials = [...(p.info?.socials || []), ...(p.baseToken?.info?.socials || [])];

  const gotX = sec?.hasTwitter
    || dexSocials.some(s =>
        (s.type || '').toLowerCase().includes('twitter')
        || (s.url || '').includes('twitter.com')
        || (s.url || '').includes('x.com'));

  const gotTG = sec?.hasTelegram
    || dexSocials.some(s =>
        (s.type || '').toLowerCase().includes('telegram')
        || (s.url || '').includes('t.me'));

  const gotWEB = sec?.hasWebsite
    || !!(p.info?.websites?.length)
    || dexSocials.some(s => {
        const u = s.url || '';
        return u.length > 5
          && !u.includes('twitter') && !u.includes('x.com')
          && !u.includes('t.me')    && !u.includes('github.com')
          && !u.includes('instagram.com');
      });

  const gotGH = dexSocials.some(s =>
    (s.type || '').toLowerCase().includes('github')
    || (s.url || '').includes('github.com'));

  const gotIG = dexSocials.some(s =>
    (s.type || '').toLowerCase().includes('instagram')
    || (s.url || '').includes('instagram.com'));

  // Communauté Twitter/X (lien vers x.com/i/communities)
  const gotXCommunity = dexSocials.some(s =>
    (s.type || '').toLowerCase().includes('community')
    || (s.url || '').includes('x.com/i/communities'));

  const twitterPts     = gotX ? (ageMin <= 1 ? 10 : 5) : 0;
  const tgPts          = gotTG ? 5 : 0;
  const webPts         = gotWEB ? 5 : 0;
  const ghPts          = gotGH ? 10 : 0;
  const communityPts   = gotXCommunity ? 10 : 0;
  const igPts          = gotIG ? 8 : 0;
  const cashbackPts    = (gmgn.cashback || gmgn.is_cashback) ? 15 : 0;
  const score          = twitterPts + tgPts + webPts + ghPts + communityPts + igPts + cashbackPts;

  return { score, gotX, gotTG, gotWEB, gotGH, gotIG, gotXCommunity, twitterPts, tgPts, webPts, ghPts, communityPts, igPts, cashbackPts, twitterEarly: gotX && ageMin <= 1 };
}

// ── 3. HOLDERS ───────────────────────────────────────────────────────────────
function calculateHolderScore(sec, kolCount, traderCount) {
  const top10pct = sec ? parseFloat(sec.top10Pct || 0) : 0;

  let top10Score = 0;
  if      (top10pct >= 10 && top10pct <= 20) top10Score = 15;
  else if (top10pct >  20 && top10pct <= 30) top10Score = 15;
  else if (top10pct >  30 && top10pct <= 40) top10Score = 10;
  else if (top10pct >  40 && top10pct <= 60) top10Score = 5;
  else if (top10pct >  60)                   top10Score = -10;

  let kolTop50Pts = 0;
  if      (kolCount >= 3)  kolTop50Pts = 12;
  else if (kolCount === 2) kolTop50Pts = 10;
  else if (kolCount === 1) kolTop50Pts = 5;

  let traderTop50Pts = 0;
  if      (traderCount >= 3)  traderTop50Pts = 12;
  else if (traderCount === 2) traderTop50Pts = 10;
  else if (traderCount === 1) traderTop50Pts = 5;

  const bonusCombo = (kolCount >= 2 && traderCount >= 2) ? 20 : 0;
  const total      = top10Score + kolTop50Pts + traderTop50Pts + bonusCombo;

  return { total, top10Score, kolTop50Pts, traderTop50Pts, bonusCombo, top10pct };
}

// ── 4. MARKET CAP ────────────────────────────────────────────────────────────
function calculateMcapScore(mcap) {
  if      (mcap >= 15000 && mcap <= 20000)  return 25;
  else if (mcap >  20000 && mcap <= 60000)  return 20;
  else if (mcap >  60000 && mcap <= 120000) return 15;
  else if (mcap > 150000)                   return 5;
  else                                      return 5; // <15K
}

// ── 5. AGE ───────────────────────────────────────────────────────────────────
function calculateAgeScore(ageMin) {
  if      (ageMin >= 0.5 && ageMin <= 2)  return 15;
  else if (ageMin >  2   && ageMin <= 5)  return 15;
  else if (ageMin >  5   && ageMin <= 10) return 10;
  return 0;
}

// ── 6. PATTERN ───────────────────────────────────────────────────────────────
function calculatePatternScore(p) {
  const liq   = p.liquidity?.usd || 0;
  const c1h   = p.priceChange?.h1 || 0;
  const c5m   = p.priceChange?.m5 || 0;
  const volM5 = p.volume?.m5 || 0;

  let liqScore = 0;
  if      (liq >= 13000) liqScore = 30;
  else if (liq >= 10000) liqScore = 5;
  else if (liq > 0)      liqScore = -20;

  let c1hScore = 0;
  if      (c1h >= 70  && c1h <= 125) c1hScore = 30;
  else if (c1h >  125 && c1h <= 150) c1hScore = 15;
  else if (c1h >  150 && c1h <= 200) c1hScore = 5;
  else if (c1h >  200 && c1h <= 300) c1hScore = -20;
  else if (c1h >  300)               c1hScore = -10;
  else                               c1hScore = -20;

  let c5mScore = 0;
  if      (c5m >= 15  && c5m <= 40)  c5mScore = 40;
  else if (c5m >  40  && c5m <= 70)  c5mScore = 10;
  else if (c5m >  70  && c5m <= 120) c5mScore = 5;
  else if (c5m >  120 && c5m <= 200) c5mScore = -15;
  else if (c5m >  200)               c5mScore = -15;
  else                               c5mScore = -10;

  let volM5Score = 0;
  if      (volM5 >= 20000) volM5Score = 50;
  else if (volM5 >= 15000) volM5Score = 30;
  else if (volM5 >= 10000) volM5Score = 20;
  else if (volM5 >= 5000)  volM5Score = 10;
  else if (volM5 >= 1000)  volM5Score = -30;

  const total = liqScore + c1hScore + c5mScore + volM5Score;
  return { total, liqScore, c1hScore, c5mScore, volM5Score, liq, c1h, c5m, volM5 };
}

// ── MAIN SCORER ──────────────────────────────────────────────────────────────
export function scoreTokenV2(p, walletData = { count: 0, byGroup: { KOL: 0, 'gros trader': 0, DEV: 0, farmer: 0 }, wallets: [], clustered: false }, gmgnData = {}) {
  const ageMs  = Date.now() - (p.pairCreatedAt || 0);
  const ageH   = ageMs / 3600000;
  const ageMin = ageMs / 60000;
  const liq    = p.liquidity?.usd || (p.liquidity?.base || 0) * (p.priceNative || 0) || 0;
  const mcap   = p.marketCap || p.fdv || 0;
  const buys1  = p.txns?.h1?.buys  || 0;
  const sells1 = p.txns?.h1?.sells || 0;
  const total1 = buys1 + sells1 || 1;
  const buyR   = buys1 / total1;
  const vol1   = p.volume?.h1 || 0;
  const vol6   = p.volume?.h6 || 0;
  const c1h    = p.priceChange?.h1 || 0;
  const c6h    = p.priceChange?.h6 || 0;
  const m5     = p.priceChange?.m5 || 0;
  const m1     = p.priceChange?.m1 || 0;
  const hasSocials = !!(p.info?.socials?.length || p.info?.websites?.length || p.baseToken?.info?.socials?.length);
  const volAvgH  = (vol6 / 6) || (vol1 || 1);
  const volAccel = vol1 / volAvgH;

  const sec         = p.security || null;
  const sym_early   = (p.baseToken?.symbol || 'UNKNOWN').toUpperCase().slice(0, 12);

  // GMGN hard rejects
  const gmgn = calculateGmgnScore(gmgnData);
  if (gmgn.hardReject) {
    return {
      score: 0, _minFail: gmgn.hardReject,
      symbol: sym_early,
      addr: p.baseToken?.address || '', mcap, liq: 0,
      socials: false, rugRisk: 'HIGH', walletData,
      pairUrl: p.url || '',
      raw: p,
      debug: { gmgnHardReject: gmgn.hardReject, gmgnData }
    };
  }

  const byGroup     = walletData.byGroup || {};
  const kolCount    = byGroup['KOL']         || 0;
  const traderCount = byGroup['gros trader'] || 0;
  const devCount    = byGroup['DEV']         || 0;
  const farmerCount = byGroup['farmer']      || 0;

  // Hard filter : au moins 1 KOL et 1 gros trader obligatoires
  if (kolCount < 1 || traderCount < 1) {
    return {
      score: 0, _minFail: 'wallet',
      symbol: sym_early,
      addr: p.baseToken?.address || '', mcap, liq,
      socials: hasSocials, rugRisk: 'HIGH', walletData,
      pairUrl: p.url || '',
      raw: p,
      debug: { kolCount, traderCount, devCount, farmerCount, byGroup, buyRatio: buyR, c1h, m5, ageH }
    };
  }

  let score = 0;

  // 1. Wallet
  const walletResult  = calculateWalletScore(byGroup);
  score += walletResult.total;

  // 2. Social
  const socialResult  = calculateSocialScore(p, sec, ageMin, gmgnData);
  score += socialResult.score;

  // 3. Dex paid
  const isDexPaid = p._isPaid
    || (p.labels || []).some(l => (l.label || l || '').toLowerCase().includes('paid'))
    || !!(p.info?.imageUrl || p.profile?.icon || p.profile?.header);
  const platformScore = isDexPaid ? 15 : 0;
  score += platformScore;

  // 4. Holders
  const holderResult  = calculateHolderScore(sec, kolCount, traderCount);
  score += holderResult.total;

  // 5. Market cap
  const mcapScore     = calculateMcapScore(mcap);
  score += mcapScore;

  // 6. Age
  const ageScore      = calculateAgeScore(ageMin);
  score += ageScore;

  // 7. Pattern
  const patternResult = calculatePatternScore(p);
  score += patternResult.total;

  // 8. GMGN
  score += gmgn.score;

  const finalScore = Math.min(300, Math.max(0, Math.round(score)));

  // Rug risk
  let rugPts = 0;
  if (buyR < 0.52)    rugPts += 3;
  if (volAccel < 0.5) rugPts++;
  if (c1h < -5)       rugPts++;
  if (!hasSocials)    rugPts++;
  if (liq < 6000)     rugPts += 2;
  if (ageH < 0.5)     rugPts++;
  if (kolCount >= 1 || traderCount >= 1) rugPts = Math.max(0, rugPts - 2);
  const rugRisk = rugPts >= 5 ? 'HIGH' : rugPts >= 3 ? 'MEDIUM' : 'LOW';

  const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  const sym   = (p.baseToken?.symbol || 'UNKNOWN').toUpperCase().slice(0, 12);
  const addr  = p.baseToken?.address || '';

  return {
    score: finalScore,
    symbol: sym, emoji, addr, mcap, liq,
    socials: hasSocials, rugRisk, walletData,
    pairUrl: p.url || `https://dexscreener.com/solana/${addr}`,
    raw: p,
    debug: {
      // Scores par catégorie
      walletScore:   walletResult.total,
      socialScore:   socialResult.score,
      platformScore,
      holderScore:   holderResult.total,
      mcapScore,
      ageScore,
      patternScore:  patternResult.total,
      gmgnScore:     gmgn.score,

      // Wallet détail
      kolPts:        walletResult.kolPts,
      traderPts:     walletResult.traderPts,
      farmerPts:     walletResult.farmerPts,
      kolCount, traderCount, devCount, farmerCount, byGroup,

      // Social détail
      social: {
        twitterPts:   socialResult.twitterPts,
        tgPts:        socialResult.tgPts,
        webPts:       socialResult.webPts,
        ghPts:        socialResult.ghPts,
        communityPts: socialResult.communityPts,
        igPts:        socialResult.igPts,
        cashbackPts:  socialResult.cashbackPts,
        twitterEarly: socialResult.twitterEarly,
        gotX:         socialResult.gotX,
        gotTG:        socialResult.gotTG,
        gotWEB:       socialResult.gotWEB,
        gotGH:        socialResult.gotGH,
        gotIG:        socialResult.gotIG,
        gotXCommunity:socialResult.gotXCommunity,
      },

      // Holders détail
      holders: {
        top10Score:    holderResult.top10Score,
        kolTop50Pts:   holderResult.kolTop50Pts,
        traderTop50Pts:holderResult.traderTop50Pts,
        bonusCombo:    holderResult.bonusCombo,
        top10pct:      holderResult.top10pct,
      },

      // Pattern détail
      pattern: {
        liqScore:    patternResult.liqScore,
        c1hScore:    patternResult.c1hScore,
        c5mScore:    patternResult.c5mScore,
        volM5Score:  patternResult.volM5Score,
        liq:         patternResult.liq,
        c1h:         patternResult.c1h,
        c5m:         patternResult.c5m,
        volM5:       patternResult.volM5,
      },

      // Métriques brutes
      buyRatio: buyR, volAccel, c1h, m5, c6h, m1, ageH,
      top10pct: holderResult.top10pct,
      volM5:    p.volume?.m5 || 0,
      gmgnData,
    }
  };
}

export { hardFilterV2 };
