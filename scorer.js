const EMOJIS = ['🐸','🚀','💎','🌙','🔥','⚡','🦊','🐶','🐱','🎰','🍌','🧸','🦍','🐻','🎯'];

function hardFilterV2(p) {
  const ageH = (Date.now() - (p.pairCreatedAt || 0)) / 3600000;
  const mcap = p.marketCap || p.fdv || 0;
  if (mcap < 3000) return { pass: false, reason: `mcap $${mcap} < $3K` };
  if (ageH > 0.33) return { pass: false, reason: `trop vieux ${(ageH*60).toFixed(0)}min` };
  return { pass: true, ageH };
}

function calculatePatternScore(p) {
  let score = 0;
  const c5m = p.priceChange?.m5 || 0;
  const c1h = p.priceChange?.h1 || 0;
  const c6h = p.priceChange?.h6 || 0;
  const m1  = p.priceChange?.m1 || 0;
  const buysM5  = p.txns?.m5?.buys  || 0;
  const sellsM5 = p.txns?.m5?.sells || 0;
  const buysH1  = p.txns?.h1?.buys  || 0;
  const sellsH1 = p.txns?.h1?.sells || 0;
  const mcap    = p.marketCap || p.fdv || 1;
  const volH1   = p.volume?.h1 || 0;
  const volM5   = p.volume?.m5 || 0;
  const liq     = p.liquidity?.usd || 0;
  const totalTxH1 = buysH1 + sellsH1 || 1;
  const buyRatioM5 = buysM5 / ((buysM5 + sellsM5) || 1);
  const volMcapH1  = volH1 / mcap;
  const avgTxSize  = volH1 / totalTxH1;

  // 1. Montée douce / Staircase : c1h fort mais c5m modéré = croissance régulière
  if (c1h > 35 && c5m > 0 && c5m < 20 && c1h > c5m * 3) score += 15;
  // 2. Correction saine (pas trop violente)
  if (c1h >= -20 && c1h <= -5) score += 10;
  // 3. Gros pump avec structure (multi-pumps)
  if (c1h > 35 && c6h > 55) score += 10;
  if (c6h > 75) score += 5;
  // 4. Consolidation propre (stabilisation après pump)
  if (Math.abs(c5m) < 7 && c1h > 22) score += 8;
  // 5. Pas de dump violent
  if (c5m > -25 && m1 > -16) score += 5;
  // 6. Volume organique — buys dominent les sells
  if (buysM5 > sellsM5 * 1.55) score += 7;

  // 7. NEW — Buy ratio m5 élevé (bon: >0.55, mauvais: <0.50)
  if (buyRatioM5 >= 0.58) score += 5;
  else if (buyRatioM5 < 0.45) score -= 5;

  // 8. NEW — Vol/Mcap ratio (bon: 1-6, mauvais: >10 = manipulation)
  if (volMcapH1 >= 1 && volMcapH1 <= 7) score += 5;
  else if (volMcapH1 > 12) score -= 8;

  // 9. NEW — Taille moyenne des tx (bon: >$60 = smart money, mauvais: <$50 = bots)
  if (avgTxSize >= 80) score += 5;
  else if (avgTxSize < 40 && totalTxH1 > 100) score -= 5;

  // 10. NEW — Liquidité > 0 = migré de bonding curve (signal fort)
  if (liq > 5000) score += 5;

  // === BONUS EARLY TOKEN (<5 min) — seulement si le prix tient ===
  const ageMinP = (Date.now() - (p.pairCreatedAt || 0)) / 60000;
  if (ageMinP < 5 && m1 >= -5 && c5m > -10) {
    // Bonus seulement si m1 pas en chute et c5m pas en dump
    if (buysM5 >= 8 && buyRatioM5 >= 0.6 && sellsM5 < buysM5) score += 10;
    else if (buysM5 >= 5 && buyRatioM5 >= 0.55) score += 6;
    else if (buysM5 >= 3) score += 3;
    if (c5m > 5 && c5m < 40) score += 6;
    if (sellsM5 <= 1 && buysM5 >= 3) score += 4;
  } else if (ageMinP < 10 && m1 >= -8) {
    if (buysM5 >= 5 && buyRatioM5 >= 0.58) score += 6;
    if (c5m > 0 && c5m < 30 && buysM5 > sellsM5) score += 4;
  }

  // === PÉNALITÉS SPIKE INITIAL (grosse bougie launch → dump) ===
  if (ageMinP < 5 && m1 < -8) score -= 15;               // prix en chute libre sur token frais
  if (ageMinP < 10 && c5m > 80) score -= 18;              // spike >80% en 5min = achat bundle
  if (ageMinP < 10 && c1h > 150) score -= 15;             // pump >150% token jeune = artificiel
  if (c5m < -15 && sellsM5 > buysM5) score -= 12;         // dump + sells > buys = exit en cours
  if (m1 < -10) score -= 10;                               // m1 très négatif = dump actif

  // === PÉNALITÉS ANTI-RUG / FAUX PUMP ===
  if (c1h > 90 && c5m < -28) score -= 18;
  if (c6h > 140 && c1h < 20) score -= 15;
  if (sellsM5 > buysM5 * 1.7 && c1h > 30) score -= 12;
  if (c1h > 60 && c5m < -20) score -= 10;
  if (c5m < -35) score -= 8;

  return Math.max(0, Math.min(30, Math.round(score)));
}

export function scoreTokenV2(p, walletData = { count: 0, wallets: [], clustered: false }) {
  const ageMs  = Date.now() - (p.pairCreatedAt || 0);
  const ageH   = ageMs / 3600000;
  const ageMin = ageMs / 60000;
  const liq    = p.liquidity?.usd || (p.liquidity?.base || 0) * (p.priceNative || 0) || 0;
  const mcap   = p.marketCap || p.fdv || 0;
  const buys1  = p.txns?.h1?.buys || 0;
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
  const dexId    = (p.dexId || p.dex || '').toLowerCase();

  const sec        = p.security || null;
  const top10pct   = sec ? parseFloat(sec.top10Pct || 0) : 0;
  const holderCount = sec?.holderCount || 0;

  let score = 0;

  // AXIOM CONSENSUS (max 35)
  let traderScore = 0;
  const axiomCount = walletData.count || 0;
  if      (axiomCount >= 6) traderScore = 35;
  else if (axiomCount >= 5) traderScore = 30;
  else if (axiomCount === 4) traderScore = 25;
  else if (axiomCount === 3) traderScore = 18;
  else if (axiomCount === 2) traderScore = 10;
  else if (axiomCount === 1) traderScore =  5;
  score += traderScore;

  // SOCIAL
  const hasX   = sec?.hasTwitter  || false;
  const hasTG  = sec?.hasTelegram || false;
  const hasWEB = sec?.hasWebsite  || false;
  const dexSocials = [...(p.info?.socials || []), ...(p.baseToken?.info?.socials || [])];
  const dexX   = dexSocials.some(s => (s.type || '').toLowerCase().includes('twitter') || (s.url || '').includes('twitter.com') || (s.url || '').includes('x.com'));
  const dexTG  = dexSocials.some(s => (s.type || '').toLowerCase().includes('telegram') || (s.url || '').includes('t.me'));
  const dexWEB = !!(p.info?.websites?.length) || dexSocials.some(s => { const u = s.url || ''; return u.length > 5 && !u.includes('twitter') && !u.includes('x.com') && !u.includes('t.me'); });
  const gotX   = hasX || dexX;
  const gotTG  = hasTG || dexTG;
  const gotWEB = hasWEB || dexWEB;
  const gotGH  = dexSocials.some(s => (s.type || '').toLowerCase().includes('github') || (s.url || '').includes('github.com'));
  const hasCashback = !!(p.profile?.icon || p.profile?.banner || p.info?.imageUrl);
  let socialScore = 0;
  // LÉGITIMITÉ (max 25) — Twitter: minute +8, heure +4, sinon +2
  if (gotX) {
    if (ageMin <= 1) socialScore += 8;
    else if (ageH < 1) socialScore += 4;
    else socialScore += 2;
  }
  if (gotTG || gotWEB) socialScore += 6;
  if (gotX && (gotTG || gotWEB)) socialScore += 6;
  if (gotGH || hasCashback) socialScore += 5;
  if (socialScore === 0) {
    if      (ageMin < 5 && buys1 >= 5)  socialScore += 8;
    else if (holderCount >= 300)         socialScore += 10;
    else if (holderCount >= 150)         socialScore += 5;
  }
  score += socialScore;

  // DISTRIBUTION (max 25)
  const top5pct = sec ? parseFloat(sec.top5Pct || 0) : 0;
  let holderScore = 0;
  if (top10pct > 0) {
    if      (top10pct <= 15) holderScore += 15;
    else if (top10pct <= 25) holderScore += 12;
    else if (top10pct <= 35) holderScore +=  8;
    else if (top10pct <= 50) holderScore +=  3;
  }
  const totalTxns = (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0) + (p.txns?.h6?.buys || 0) + (p.txns?.h6?.sells || 0);
  const hasProTraders = axiomCount >= 3 || (totalTxns >= 100 && top10pct <= 60) || (totalTxns >= 50 && top10pct <= 30);
  if (hasProTraders) holderScore += 10;
  score += holderScore;

  // DEX PAID (max 10)
  let platformScore = 0;
  const isDexPaid = p._isPaid
    || (p.labels || []).some(l => (l.label || l || '').toLowerCase().includes('paid'))
    || !!(p.info?.imageUrl || p.profile?.icon || p.profile?.header);
  if (isDexPaid) platformScore += 10;
  score += platformScore;

  // MCAP SWEET SPOT (max 15)
  let mcapScore = 0;
  if      (mcap >= 15000 && mcap <= 20000)  mcapScore = 15;
  else if (mcap >  20000 && mcap <= 40000)  mcapScore = 12;
  else if (mcap >  40000 && mcap <= 80000)  mcapScore =  8;
  else if (mcap >  80000 && mcap <= 120000) mcapScore =  4;
  else if (mcap > 150000)                   mcapScore = -5;
  score += mcapScore;

  // TIMING (max 10)
  let ageScore = 0;
  if      (ageMin >= 0.5 && ageMin <= 2)  ageScore = 10;
  else if (ageMin >  2  && ageMin <= 5)  ageScore =  7;
  else if (ageMin >  5  && ageMin <= 10) ageScore =  3;
  score += ageScore;

  // PATTERN
  const patternScore = calculatePatternScore(p);
  score += patternScore;

  // MINIMUMS OBLIGATOIRES par catégorie — rejet si pas atteint
  if (traderScore < 5)  return { score: 0, _minFail: 'axiom', _realScore: Math.min(140, Math.max(0, Math.round(score))), symbol: (p.baseToken?.symbol || 'UNKNOWN').toUpperCase().slice(0, 12), addr: p.baseToken?.address || '', mcap, liq, socials: hasSocials, rugRisk: 'HIGH', walletData, pairUrl: p.url || '', raw: p, debug: { traderScore, socialScore, holderScore, platformScore, mcapScore, ageScore, patternScore, axiomCount, buyRatio: buyR, volAccel, c1h, m5, c6h, m1, ageH, top10pct, volMcapH1: vol1/mcap, sellBuyRatio: sells1/(buys1||1) } };
  if (patternScore < 3 && ageMin > 3) return { score: 0, _minFail: 'chart', symbol: (p.baseToken?.symbol || 'UNKNOWN').toUpperCase().slice(0, 12), addr: p.baseToken?.address || '', mcap, liq, socials: hasSocials, rugRisk: 'HIGH', walletData, pairUrl: p.url || '', raw: p, debug: { traderScore, socialScore, holderScore, platformScore, mcapScore, ageScore, patternScore, axiomCount, buyRatio: buyR, volAccel, c1h, m5, c6h, m1, ageH, top10pct, volMcapH1: vol1/mcap, sellBuyRatio: sells1/(buys1||1) } };
  if (holderScore < 3)  return { score: 0, _minFail: 'distrib', symbol: (p.baseToken?.symbol || 'UNKNOWN').toUpperCase().slice(0, 12), addr: p.baseToken?.address || '', mcap, liq, socials: hasSocials, rugRisk: 'HIGH', walletData, pairUrl: p.url || '', raw: p, debug: { traderScore, socialScore, holderScore, platformScore, mcapScore, ageScore, patternScore, axiomCount, buyRatio: buyR, volAccel, c1h, m5, c6h, m1, ageH, top10pct, volMcapH1: vol1/mcap, sellBuyRatio: sells1/(buys1||1) } };

  const finalScore = Math.min(140, Math.max(0, Math.round(score)));

  // RUG RISK
  let rugPts = 0;
  if (buyR < 0.52)      rugPts += 3;
  if (volAccel < 0.5)   rugPts++;
  if (c1h < -5)         rugPts++;
  if (!hasSocials)      rugPts++;
  if (liq < 6000)       rugPts += 2;
  if (ageH < 0.5)       rugPts++;
  if (axiomCount >= 1)  rugPts = Math.max(0, rugPts - 2);
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
      traderScore, socialScore, holderScore, platformScore,
      mcapScore, ageScore, patternScore,
      walletCount: axiomCount, clustered: walletData.clustered,
      buyRatio: buyR, volAccel, c1h, m5, c6h, m1, ageH,
      top10pct, axiomCount,
      volMcapH1: vol1/mcap,
      sellBuyRatio: sells1/(buys1||1)
    }
  };
}

export { hardFilterV2 };
