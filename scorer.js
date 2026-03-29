const EMOJIS = ['🐸','🚀','💎','🌙','🔥','⚡','🦊','🐶','🐱','🎰','🍌','🧸','🦍','🐻','🎯'];

function hardFilterV2(p) {
  const ageH = (Date.now() - (p.pairCreatedAt || 0)) / 3600000;
  const mcap = p.marketCap || p.fdv || 0;
  if (mcap < 3000) return { pass: false, reason: `mcap $${mcap} < $3K` };
  if (ageH > 48)   return { pass: false, reason: `trop vieux ${ageH.toFixed(0)}h` };
  return { pass: true, ageH };
}

function calculatePatternScore(p) {
  const c5m        = p.priceChange?.m5  || 0;
  const c1h        = p.priceChange?.h1  || 0;
  const c6h        = p.priceChange?.h6  || 0;
  const buysM5     = p.txns?.m5?.buys   || 0;
  const sellsM5    = p.txns?.m5?.sells  || 0;
  const buysH1     = p.txns?.h1?.buys   || 0;
  const sellsH1    = p.txns?.h1?.sells  || 0;
  const volH1      = p.volume?.h1       || 0;
  const mcap       = p.marketCap || p.fdv || 0;

  const totalM5       = buysM5 + sellsM5 || 1;
  const totalH1       = buysH1 + sellsH1 || 1;
  const sellRatioM5   = sellsM5 / totalM5;
  const sellRatioH1   = sellsH1 / totalH1;
  const volPerBuyH1   = volH1 / Math.max(buysH1, 1);
  const c1hC5mRatio   = c1h / Math.max(Math.abs(c5m), 0.5);

  let score = 0;

  if (c5m >= 3 && c5m <= 20 && sellRatioM5 < 0.35 && buysM5 >= 10) score += 20;
  if (buysH1 >= 20 && sellRatioH1 < 0.45) score += 15;
  if (c1h >= 20 && c1h <= 100 && c5m > 0 && c5m <= 25) score += 12;
  if (volPerBuyH1 < 1500 && buysH1 >= 12) score += 10;
  if (buysM5 >= 2 && buysM5 / Math.max(sellsM5, 1) >= 3.0) score += 8;

  if (c1hC5mRatio > 12 && c1h > 80) score -= 30;
  if (buysH1 < 15) score -= 25;
  if (volPerBuyH1 > 3000) score -= 20;
  if (sellRatioM5 > 0.50) score -= 20;
  if (sellRatioH1 > 0.55) score -= 15;
  if (c5m > 50) score -= 20;
  if (c5m < -5 && c1h > 50) score -= 15;

  return Math.max(0, Math.min(45, Math.round(score)));
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
  const hasSocials = !!(p.info?.socials?.length || p.info?.websites?.length || p.baseToken?.info?.socials?.length);
  const volAvgH  = (vol6 / 6) || (vol1 || 1);
  const volAccel = vol1 / volAvgH;
  const dexId    = (p.dexId || p.dex || '').toLowerCase();

  const sec        = p.security || null;
  const top10pct   = sec ? parseFloat(sec.top10Pct || 0) : 0;
  const holderCount = sec?.holderCount || 0;

  let score = 0;

  // TRADERS AXIOM
  let traderScore = 0;
  const axiomCount = walletData.count || 0;
  if      (axiomCount >= 5) traderScore = 20;
  else if (axiomCount === 4) traderScore = 15;
  else if (axiomCount === 3) traderScore = 10;
  else if (axiomCount === 2) traderScore =  8;
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
  let socialScore = 0;
  if (gotX)  socialScore += ageH < 1 ? 10 : 5;
  if (gotTG || gotWEB) socialScore += 8;
  if (gotX && (gotTG || gotWEB)) socialScore += 8;
  if (socialScore === 0) {
    if      (ageMin < 5 && buys1 >= 5)  socialScore += 8;
    else if (holderCount >= 300)         socialScore += 10;
    else if (holderCount >= 150)         socialScore += 5;
  }
  score += socialScore;

  // HOLDERS
  const top5pct = sec ? parseFloat(sec.top5Pct || 0) : 0;
  let holderScore = 0;
  if (top10pct > 0) {
    if      (top10pct <= 20) holderScore += 10;
    else if (top10pct <= 35) holderScore +=  8;
    else if (top10pct <= 50) holderScore +=  5;
    else if (top10pct <= 65) holderScore +=  0;
    else                     holderScore -=  5;
  }
  const totalTxns = (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0) + (p.txns?.h6?.buys || 0) + (p.txns?.h6?.sells || 0);
  const hasProTraders = axiomCount >= 3 || (totalTxns >= 100 && top10pct <= 60) || (totalTxns >= 50 && top10pct <= 30);
  if (hasProTraders) holderScore += 10;
  score += holderScore;

  // PLATFORM
  let platformScore = 0;
  const pairUrl    = (p.url || '').toLowerCase();
  const isPumpFun  = dexId.includes('pump') || pairUrl.includes('pump');
  const isBonk     = dexId.includes('bonk') || dexId.includes('launchlab') || pairUrl.includes('bonk');
  const isRaydium  = dexId.includes('raydium') || dexId.includes('cpmm') || dexId.includes('clmm');
  if (isPumpFun || isBonk || isRaydium) platformScore += 5;
  if ((p.labels || []).some(l => (l.label || l || '').toLowerCase().includes('paid'))) platformScore += 10;
  score += platformScore;

  // MCAP
  let mcapScore = 0;
  if      (mcap >= 15000 && mcap <= 30000)  mcapScore = 15;
  else if (mcap >  30000 && mcap <= 60000)  mcapScore = 10;
  else if (mcap >  60000 && mcap <= 120000) mcapScore =  5;
  else if (mcap > 150000)                   mcapScore = -5;
  score += mcapScore;

  // AGE
  let ageScore = 0;
  if      (ageMin >= 1  && ageMin <= 5)  ageScore = 10;
  else if (ageMin >  5  && ageMin <= 15) ageScore =  5;
  score += ageScore;

  // PATTERN
  const patternScore = calculatePatternScore(p);
  score += patternScore;

  const finalScore = Math.min(150, Math.max(0, Math.round(score)));

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
      buyRatio: buyR, volAccel, c1h, m5, ageH,
      top10pct, axiomCount
    }
  };
}

export { hardFilterV2 };
