/**
 * AI Engine — Apprend des calls passés pour optimiser le scoring
 *
 * Flow:
 * 1. Outcome tracker: check prix 1h/6h après chaque call (DexScreener gratuit)
 * 2. Analyse winners vs losers: corrélations features → résultat
 * 3. Auto-ajuste les poids du scoring
 * 4. Log chaque décision pour le panel admin
 */

import { db } from './firebase.js';

// ── POIDS DYNAMIQUES (modifiés par l'IA) ──
// Valeurs par défaut = scoring actuel codé en dur dans scorer.js
let dynamicWeights = {
  // Pattern thresholds
  staircaseMinC1h: 35,
  staircaseMaxC5m: 20,
  staircaseBonus: 15,
  correctionMin: -20,
  correctionMax: -5,
  correctionBonus: 10,
  multiPumpC1h: 35,
  multiPumpC6h: 55,
  multiPumpBonus: 10,
  consolidationMaxC5m: 7,
  consolidationMinC1h: 22,
  consolidationBonus: 8,
  noDumpBonus: 5,
  organicVolumeMultiplier: 1.55,
  organicVolumeBonus: 7,
  buyRatioGood: 0.58,
  buyRatioBad: 0.45,
  buyRatioBonus: 5,
  buyRatioPenalty: -5,
  volMcapGoodMin: 1,
  volMcapGoodMax: 7,
  volMcapBadMin: 12,
  volMcapBonus: 5,
  volMcapPenalty: -8,
  avgTxGood: 80,
  avgTxBad: 40,
  avgTxBonus: 5,
  avgTxPenalty: -5,
  liqMinBonus: 5000,
  liqBonus: 5,
  // Anti-rug penalties
  rugPumpC1h: 90,
  rugPumpC5m: -28,
  rugPumpPenalty: -18,
  fadedC6h: 140,
  fadedC1h: 20,
  fadedPenalty: -15,
  sellWallMultiplier: 1.7,
  sellWallPenalty: -12,
  lateDumpC1h: 60,
  lateDumpC5m: -20,
  lateDumpPenalty: -10,
  violentDumpC5m: -35,
  violentDumpPenalty: -8,
  // Category max weights
  traderMax: 20,
  socialMax: 26,
  holderMax: 20,
  platformMax: 15,
  mcapMax: 15,
  ageMax: 10,
  patternMax: 45,
};

// ── LOG DES AJUSTEMENTS ──
const adjustmentLog = []; // { ts, changes: [{param, old, new, reason}], winrateBefore, winrateAfter, sampleSize }

// ── OUTCOME TRACKING ──
// Check le prix toutes les 5 min pendant 6h, track le ATH (mcap max atteint)
// Le résultat final est basé sur le ATH, pas le prix à un instant T
async function trackOutcomes() {
  try {
    const snap = await db.ref('calls').orderByChild('savedAt').limitToLast(100).once('value');
    const calls = snap.val() || {};
    const now = Date.now();
    let checked = 0;

    for (const [key, call] of Object.entries(calls)) {
      if (!call.addr || !call.callMcap) continue;

      const callTime = call.calledAt || call.callTime || call.savedAt || 0;
      const age = now - callTime;

      // Skip si trop vieux (> 8h) et déjà finalisé
      if (age > 8 * 3600000 && call.outcome?.finalized) continue;
      // Skip si trop récent (< 5 min)
      if (age < 5 * 60000) continue;

      const currentMcap = await fetchCurrentMcap(call.addr);
      if (currentMcap <= 0) continue;
      checked++;

      const athMcap = Math.max(currentMcap, call.outcome?.athMcap || 0, call.athMcap || 0);
      const athX = parseFloat((athMcap / call.callMcap).toFixed(2));
      const currentX = parseFloat((currentMcap / call.callMcap).toFixed(2));
      const roi = parseFloat(((currentMcap - call.callMcap) / call.callMcap * 100).toFixed(1));

      // Résultat basé sur le ATH (pas le prix actuel)
      const result = athX >= 2 ? 'moon'
        : athX >= 1.3 ? 'win'
        : athX >= 0.8 ? 'flat'
        : 'loss';

      const update = {
        athMcap,
        athX,
        currentMcap,
        currentX,
        roi,
        result,
        lastCheckAt: now,
        checkCount: (call.outcome?.checkCount || 0) + 1,
      };

      // Marquer les checks 1h et 6h quand on passe ces seuils
      if (!call.outcome?.mcap1h && age >= 55 * 60000) {
        update.mcap1h = currentMcap;
        update.roi1h = roi;
      }
      if (!call.outcome?.mcap6h && age >= 350 * 60000) {
        update.mcap6h = currentMcap;
        update.roi6h = roi;
      }

      // Finaliser après 6h
      if (age >= 6 * 3600000 && !call.outcome?.finalized) {
        update.finalized = true;
        // Sauvegarder le snapshot features pour l'analyse
        update.features = {
          score: call.score,
          mcap: call.callMcap,
          liq: call.liq,
          traderScore: call.debug?.traderScore || 0,
          socialScore: call.debug?.socialScore || 0,
          holderScore: call.debug?.holderScore || 0,
          patternScore: call.debug?.patternScore || 0,
          platformScore: call.debug?.platformScore || 0,
          mcapScore: call.debug?.mcapScore || 0,
          ageScore: call.debug?.ageScore || 0,
          buyRatio: call.debug?.buyRatio || 0,
          volAccel: call.debug?.volAccel || 0,
          c1h: call.debug?.c1h || 0,
          m5: call.debug?.m5 || 0,
          c6h: call.debug?.c6h || 0,
          m1: call.debug?.m1 || 0,
          top10pct: call.debug?.top10pct || 0,
          axiomCount: call.debug?.axiomCount || 0,
          volMcapH1: call.debug?.volMcapH1 || 0,
          sellBuyRatio: call.debug?.sellBuyRatio || 0,
        };
      }

      await db.ref(`calls/${key}/outcome`).update(update);
      // Aussi mettre à jour athMcap au niveau du call (pour le frontend)
      if (athMcap > (call.athMcap || 0)) {
        await db.ref(`calls/${key}/athMcap`).set(athMcap);
      }

      // Rate limit DexScreener : pas trop de calls d'un coup
      if (checked % 5 === 0) await new Promise(r => setTimeout(r, 1000));
    }

    if (checked > 0) console.log(`[AI] Tracked ${checked} outcomes (ATH-based)`);
  } catch (e) {
    console.warn('[AI] trackOutcomes error:', e.message);
  }
}

// Fetch mcap actuel via DexScreener (gratuit)
async function fetchCurrentMcap(addr) {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    const pairs = (data.pairs || []).filter(p => p.chainId === 'solana');
    if (pairs.length === 0) return 0;
    // Prendre la paire avec le plus de volume
    pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
    return pairs[0].marketCap || pairs[0].fdv || 0;
  } catch (e) {
    return 0;
  }
}

// ── ANALYSE PATTERNS ──
// Compare les features des winners vs losers pour trouver les corrélations
async function analyzePatterns() {
  try {
    const snap = await db.ref('calls').orderByChild('savedAt').limitToLast(200).once('value');
    const calls = Object.values(snap.val() || {});

    // Filtrer ceux qui ont un outcome complet
    const withOutcome = calls.filter(c => c.outcome?.result);
    if (withOutcome.length < 10) {
      console.log(`[AI] Pas assez de données (${withOutcome.length}/10 min). Skip analyse.`);
      return null;
    }

    const winners = withOutcome.filter(c => c.outcome.result === 'moon' || c.outcome.result === 'win');
    const losers = withOutcome.filter(c => c.outcome.result === 'loss');
    const total = withOutcome.length;

    const winrate = (winners.length / total * 100).toFixed(1);
    console.log(`[AI] Analyse: ${total} calls, ${winners.length} wins, ${losers.length} losses, winrate=${winrate}%`);

    // Calculer les moyennes par feature pour winners vs losers
    const features = ['traderScore', 'socialScore', 'holderScore', 'patternScore', 'buyRatio', 'volAccel', 'c1h', 'm5', 'c6h', 'top10pct', 'axiomCount', 'mcap', 'liq', 'volMcapH1', 'sellBuyRatio'];
    const analysis = {};

    for (const feat of features) {
      const winVals = winners.map(c => c.outcome?.features?.[feat] || c.debug?.[feat] || 0).filter(v => v !== 0);
      const loseVals = losers.map(c => c.outcome?.features?.[feat] || c.debug?.[feat] || 0).filter(v => v !== 0);

      const winAvg = winVals.length > 0 ? winVals.reduce((a, b) => a + b, 0) / winVals.length : 0;
      const loseAvg = loseVals.length > 0 ? loseVals.reduce((a, b) => a + b, 0) / loseVals.length : 0;

      analysis[feat] = {
        winAvg: parseFloat(winAvg.toFixed(2)),
        loseAvg: parseFloat(loseAvg.toFixed(2)),
        diff: parseFloat((winAvg - loseAvg).toFixed(2)),
        winSamples: winVals.length,
        loseSamples: loseVals.length,
      };
    }

    // Sauvegarder l'analyse
    const report = {
      ts: Date.now(),
      totalCalls: total,
      winners: winners.length,
      losers: losers.length,
      flats: withOutcome.filter(c => c.outcome.result === 'flat').length,
      moons: withOutcome.filter(c => c.outcome.result === 'moon').length,
      winrate: parseFloat(winrate),
      analysis,
    };

    await db.ref('ai/lastAnalysis').set(report);

    return report;
  } catch (e) {
    console.warn('[AI] analyzePatterns error:', e.message);
    return null;
  }
}

// ── AUTO-AJUSTEMENT DES POIDS ──
async function autoAdjust() {
  const report = await analyzePatterns();
  if (!report || report.totalCalls < 15) return;

  const changes = [];
  const a = report.analysis;

  // Règle 1: Si les losers ont un buyRatio moyen plus bas → durcir le seuil
  if (a.buyRatio && a.buyRatio.diff > 0.05 && a.buyRatio.loseSamples >= 5) {
    const newThreshold = parseFloat((a.buyRatio.loseAvg + 0.03).toFixed(2));
    if (newThreshold !== dynamicWeights.buyRatioBad && newThreshold > 0.35 && newThreshold < 0.60) {
      changes.push({
        param: 'buyRatioBad',
        old: dynamicWeights.buyRatioBad,
        new: newThreshold,
        reason: `Losers avg buyRatio=${a.buyRatio.loseAvg}, winners=${a.buyRatio.winAvg}. Seuil relevé pour filtrer les mauvais patterns.`,
      });
      dynamicWeights.buyRatioBad = newThreshold;
    }
  }

  // Règle 2: Si les losers ont un c1h moyen très haut → augmenter la pénalité pump
  if (a.c1h && a.c1h.loseAvg > a.c1h.winAvg * 1.5 && a.c1h.loseSamples >= 5) {
    const newThreshold = Math.round(a.c1h.loseAvg * 0.8);
    if (newThreshold !== dynamicWeights.rugPumpC1h && newThreshold > 40 && newThreshold < 200) {
      changes.push({
        param: 'rugPumpC1h',
        old: dynamicWeights.rugPumpC1h,
        new: newThreshold,
        reason: `Losers avg c1h=${a.c1h.loseAvg}% vs winners=${a.c1h.winAvg}%. Seuil rug pump ajusté.`,
      });
      dynamicWeights.rugPumpC1h = newThreshold;
    }
  }

  // Règle 3: Si les winners ont plus de traders Axiom → augmenter le poids trader
  if (a.axiomCount && a.axiomCount.diff > 0.5 && a.axiomCount.winSamples >= 5) {
    const currentMax = dynamicWeights.traderMax;
    if (currentMax < 25 && a.axiomCount.winAvg > a.axiomCount.loseAvg * 1.3) {
      changes.push({
        param: 'traderMax',
        old: currentMax,
        new: currentMax + 2,
        reason: `Winners avg axiom=${a.axiomCount.winAvg} vs losers=${a.axiomCount.loseAvg}. Axiom wallets = fort prédicteur.`,
      });
      dynamicWeights.traderMax = currentMax + 2;
    }
  }

  // Règle 4: Si les losers ont top10pct élevé → durcir la pénalité holders
  if (a.top10pct && a.top10pct.loseAvg > a.top10pct.winAvg + 5 && a.top10pct.loseSamples >= 5) {
    changes.push({
      param: 'holderConcentrationNote',
      old: 'N/A',
      new: `losers top10=${a.top10pct.loseAvg}% vs winners=${a.top10pct.winAvg}%`,
      reason: `Forte concentration holders chez les losers. Les tokens avec top10 > ${Math.round(a.top10pct.loseAvg)}% performent mal.`,
    });
  }

  // Règle 5: Si patternScore moyen des winners est significativement plus haut
  if (a.patternScore && a.patternScore.diff > 5 && a.patternScore.winSamples >= 5) {
    const newMax = Math.min(50, dynamicWeights.patternMax + 2);
    if (newMax !== dynamicWeights.patternMax) {
      changes.push({
        param: 'patternMax',
        old: dynamicWeights.patternMax,
        new: newMax,
        reason: `Pattern score fortement corrélé aux wins (avg win=${a.patternScore.winAvg} vs loss=${a.patternScore.loseAvg}). Poids augmenté.`,
      });
      dynamicWeights.patternMax = newMax;
    }
  }

  // Règle 6: Si volAccel des losers est plus bas → signal faible = danger
  if (a.volAccel && a.volAccel.diff > 0.3 && a.volAccel.loseSamples >= 5) {
    changes.push({
      param: 'volAccelNote',
      old: 'N/A',
      new: `winners volAccel=${a.volAccel.winAvg} vs losers=${a.volAccel.loseAvg}`,
      reason: `Volume en décélération = signal de vente. Tokens avec volAccel < ${a.volAccel.loseAvg.toFixed(1)} performent mal.`,
    });
  }

  // Règle 7: Si social score ne corrèle pas avec les wins → réduire le poids
  if (a.socialScore && Math.abs(a.socialScore.diff) < 1 && a.socialScore.winSamples >= 8) {
    if (dynamicWeights.socialMax > 18) {
      changes.push({
        param: 'socialMax',
        old: dynamicWeights.socialMax,
        new: dynamicWeights.socialMax - 2,
        reason: `Social score ne prédit pas les wins (avg win=${a.socialScore.winAvg} vs loss=${a.socialScore.loseAvg}). Poids réduit.`,
      });
      dynamicWeights.socialMax -= 2;
    }
  }

  // Règle 8: Volume/Mcap ratio — losers ont souvent vol/mcap élevé (pump-dump cycles)
  if (a.volMcapH1 && a.volMcapH1.loseAvg > a.volMcapH1.winAvg * 1.4 && a.volMcapH1.loseSamples >= 5) {
    const newThreshold = Math.round(a.volMcapH1.loseAvg * 0.7);
    if (newThreshold > 3 && newThreshold < 20) {
      changes.push({
        param: 'volMcapDangerThreshold',
        old: dynamicWeights.volMcapDangerThreshold || 12,
        new: newThreshold,
        reason: `PATTERN PUMP-DUMP : losers vol/mcap=${a.volMcapH1.loseAvg.toFixed(1)} vs winners=${a.volMcapH1.winAvg.toFixed(1)}. Volume excessif = manipulation en boucle.`,
      });
      dynamicWeights.volMcapDangerThreshold = newThreshold;
    }
  }

  // Règle 9: Sell/Buy ratio — losers ont plus de sells relatifs (distribution/dump)
  if (a.sellBuyRatio && a.sellBuyRatio.loseAvg > a.sellBuyRatio.winAvg * 1.2 && a.sellBuyRatio.loseSamples >= 5) {
    changes.push({
      param: 'sellBuyDangerNote',
      old: dynamicWeights.sellBuyDangerNote || 'N/A',
      new: `losers=${a.sellBuyRatio.loseAvg.toFixed(2)} vs winners=${a.sellBuyRatio.winAvg.toFixed(2)}`,
      reason: `PATTERN GROSSE BOUGIE + DUMP : losers ont ratio sells/buys=${a.sellBuyRatio.loseAvg.toFixed(2)} vs winners=${a.sellBuyRatio.winAvg.toFixed(2)}. Trop de ventes = distribution.`,
    });
  }

  if (changes.length > 0) {
    const logEntry = {
      ts: Date.now(),
      changes,
      winrateBefore: report.winrate,
      sampleSize: report.totalCalls,
      winners: report.winners,
      losers: report.losers,
    };
    adjustmentLog.push(logEntry);
    // Garder les 50 derniers ajustements en mémoire
    if (adjustmentLog.length > 50) adjustmentLog.shift();

    // Sauvegarder dans Firebase
    await db.ref('ai/adjustments').push(logEntry);
    await db.ref('ai/currentWeights').set(dynamicWeights);

    console.log(`[AI] ${changes.length} ajustements appliqués:`, changes.map(c => `${c.param}: ${c.old}→${c.new}`).join(', '));
  } else {
    console.log(`[AI] Analyse OK, aucun ajustement nécessaire. Winrate=${report.winrate}%`);
  }

  return changes;
}

// ── CHARGEMENT DES POIDS DEPUIS FIREBASE (au démarrage) ──
async function loadWeights() {
  try {
    const snap = await db.ref('ai/currentWeights').once('value');
    const saved = snap.val();
    if (saved && typeof saved === 'object') {
      Object.assign(dynamicWeights, saved);
      console.log('[AI] Poids chargés depuis Firebase');
    }
  } catch (e) {
    console.warn('[AI] loadWeights error:', e.message);
  }
}

// ── DONNÉES POUR LE PANEL ADMIN ──
async function getAIPanel() {
  try {
    const [weightsSnap, analysisSnap, adjustSnap] = await Promise.all([
      db.ref('ai/currentWeights').once('value'),
      db.ref('ai/lastAnalysis').once('value'),
      db.ref('ai/adjustments').orderByChild('ts').limitToLast(20).once('value'),
    ]);

    const adjustments = adjustSnap.val() ? Object.values(adjustSnap.val()).sort((a, b) => b.ts - a.ts) : [];

    return {
      currentWeights: weightsSnap.val() || dynamicWeights,
      lastAnalysis: analysisSnap.val() || null,
      adjustments,
      inMemoryLog: adjustmentLog.slice(-20),
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── STATS WINRATE RAPIDE ──
async function getWinrateStats() {
  try {
    const snap = await db.ref('calls').orderByChild('savedAt').limitToLast(100).once('value');
    const calls = Object.values(snap.val() || {});
    const withOutcome = calls.filter(c => c.outcome?.result);
    if (withOutcome.length === 0) return { winrate: 0, total: 0, pending: calls.length };

    const wins = withOutcome.filter(c => c.outcome.result === 'win' || c.outcome.result === 'moon').length;
    const losses = withOutcome.filter(c => c.outcome.result === 'loss').length;
    const flats = withOutcome.filter(c => c.outcome.result === 'flat').length;
    const moons = withOutcome.filter(c => c.outcome.result === 'moon').length;

    // Calcul ATH moyen (xATH) — la vraie métrique
    const withAth = withOutcome.filter(c => c.outcome.athX != null);
    const avgAthX = withAth.length > 0 ? parseFloat((withAth.reduce((s, c) => s + c.outcome.athX, 0) / withAth.length).toFixed(2)) : 0;

    return {
      winrate: parseFloat((wins / withOutcome.length * 100).toFixed(1)),
      total: withOutcome.length,
      wins,
      losses,
      flats,
      moons,
      pending: calls.filter(c => !c.outcome?.result).length,
      avgAthX,
      avgRoi1h: parseFloat((withOutcome.filter(c => c.outcome.roi1h != null).reduce((s, c) => s + c.outcome.roi1h, 0) / (withOutcome.filter(c => c.outcome.roi1h != null).length || 1)).toFixed(1)),
      avgRoi6h: parseFloat((withOutcome.filter(c => c.outcome.roi6h != null).reduce((s, c) => s + c.outcome.roi6h, 0) / (withOutcome.filter(c => c.outcome.roi6h != null).length || 1)).toFixed(1)),
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── DEEP ANALYZE — Résultats détaillés pour le panel admin ──
// Retourne les tableaux de calls bons/mauvais, les patterns trouvés, et les changements
async function deepAnalyze() {
  try {
    const snap = await db.ref('calls').orderByChild('savedAt').limitToLast(200).once('value');
    const allCalls = snap.val() || {};
    const calls = Object.entries(allCalls)
      .map(([key, c]) => ({ key, ...c }))
      .filter(c => c.outcome?.result && c.outcome?.features);

    if (calls.length < 5) {
      return { ok: false, reason: `Pas assez de calls avec outcome (${calls.length}/5 min)` };
    }

    // Séparer bons (x1.2+) et mauvais (< x1.2)
    const threshold = 1.2;
    const badCalls = calls.filter(c => (c.outcome.athX || 0) < threshold);
    const goodCalls = calls.filter(c => (c.outcome.athX || 0) >= threshold);

    // Formatter les calls pour le frontend
    const formatCall = (c) => ({
      sym: c.sym || c.name || '???',
      addr: c.addr,
      score: c.score || 0,
      callMcap: c.callMcap || 0,
      athMcap: c.outcome.athMcap || c.athMcap || 0,
      athX: c.outcome.athX || 0,
      currentX: c.outcome.currentX || 0,
      result: c.outcome.result,
      calledAt: c.calledAt || c.callTime || c.savedAt || 0,
      features: c.outcome.features || {},
      axiomCount: c.outcome.features?.axiomCount || c.debug?.axiomCount || 0,
      buyRatio: c.outcome.features?.buyRatio || c.debug?.buyRatio || 0,
      top10pct: c.outcome.features?.top10pct || c.debug?.top10pct || 0,
      traderScore: c.outcome.features?.traderScore || c.debug?.traderScore || 0,
      socialScore: c.outcome.features?.socialScore || c.debug?.socialScore || 0,
      holderScore: c.outcome.features?.holderScore || c.debug?.holderScore || 0,
      patternScore: c.outcome.features?.patternScore || c.debug?.patternScore || 0,
      liq: c.outcome.features?.liq || c.liq || 0,
      c1h: c.outcome.features?.c1h || c.debug?.c1h || 0,
      m5: c.outcome.features?.m5 || c.debug?.m5 || 0,
      c6h: c.outcome.features?.c6h || c.debug?.c6h || 0,
      volMcapH1: c.outcome.features?.volMcapH1 || c.debug?.volMcapH1 || 0,
      sellBuyRatio: c.outcome.features?.sellBuyRatio || c.debug?.sellBuyRatio || 0,
    });

    const badFormatted = badCalls.map(formatCall).sort((a, b) => a.athX - b.athX);
    const goodFormatted = goodCalls.map(formatCall).sort((a, b) => b.athX - a.athX);

    // ── PATTERNS : ce que l'IA trouve comme différences ──
    const features = ['traderScore', 'socialScore', 'holderScore', 'patternScore', 'buyRatio', 'c1h', 'm5', 'c6h', 'top10pct', 'axiomCount', 'mcap', 'liq', 'volMcapH1', 'sellBuyRatio'];
    const insights = [];

    for (const feat of features) {
      const goodVals = goodCalls.map(c => c.outcome?.features?.[feat] || c.debug?.[feat] || 0).filter(v => v !== 0);
      const badVals = badCalls.map(c => c.outcome?.features?.[feat] || c.debug?.[feat] || 0).filter(v => v !== 0);
      if (goodVals.length < 3 || badVals.length < 3) continue;

      const goodAvg = goodVals.reduce((a, b) => a + b, 0) / goodVals.length;
      const badAvg = badVals.reduce((a, b) => a + b, 0) / badVals.length;
      const diff = goodAvg - badAvg;
      const pctDiff = badAvg !== 0 ? Math.abs(diff / badAvg * 100) : 0;

      if (pctDiff > 15 || Math.abs(diff) > 3) {
        const featureNames = {
          traderScore: 'Score Traders Axiom', socialScore: 'Score Social', holderScore: 'Score Holders',
          patternScore: 'Score Pattern', buyRatio: 'Buy Ratio', c1h: 'Variation 1h (%)',
          m5: 'Variation 5m (%)', c6h: 'Variation 6h (%)', top10pct: 'Top 10 holders (%)', axiomCount: 'Nb wallets Axiom',
          mcap: 'Market Cap au call', liq: 'Liquidité',
          volMcapH1: 'Volume/Mcap ratio (manipulation)', sellBuyRatio: 'Ratio Sells/Buys (dump)'
        };
        insights.push({
          feature: featureNames[feat] || feat,
          featureKey: feat,
          goodAvg: parseFloat(goodAvg.toFixed(2)),
          badAvg: parseFloat(badAvg.toFixed(2)),
          diff: parseFloat(diff.toFixed(2)),
          direction: diff > 0 ? 'up' : 'down',
          explanation: diff > 0
            ? `Les bons calls ont en moyenne ${featureNames[feat] || feat} plus élevé (${goodAvg.toFixed(1)} vs ${badAvg.toFixed(1)})`
            : `Les mauvais calls ont en moyenne ${featureNames[feat] || feat} plus élevé (${badAvg.toFixed(1)} vs ${goodAvg.toFixed(1)})`
        });
      }
    }

    // Trier insights par importance (plus gros écart d'abord)
    insights.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    // ── CHANGEMENTS proposés par l'IA ──
    const changes = await autoAdjust();

    return {
      ok: true,
      ts: Date.now(),
      totalCalls: calls.length,
      goodCalls: goodFormatted,
      badCalls: badFormatted,
      goodCount: goodCalls.length,
      badCount: badCalls.length,
      winrate: parseFloat((goodCalls.length / calls.length * 100).toFixed(1)),
      insights,
      changes: changes || [],
      currentWeights: { ...dynamicWeights },
    };
  } catch (e) {
    console.warn('[AI] deepAnalyze error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
// ── SMART FILTERS — IA ADAPTATIVE ──
// ══════════════════════════════════════════════════════════════
// SMART FILTERS v2 — Soft & Adaptatif
// ══════════════════════════════════════════════════════════════
// Principes :
//   1. JAMAIS de hard reject sauf cas extrême (>90% loss + 15 samples)
//   2. Tout est un score continu : pénalité ∝ lossRate × confiance
//   3. Minimum 8 samples pour activer une règle
//   4. Les calls récents comptent 2x plus (decay temporel)
//   5. Cap de pénalité par règle (-12 max single, -8 max combo)
//   6. Auto-rebuild toutes les 12h
// ══════════════════════════════════════════════════════════════

let smartFilters = { singleRules: [], comboRules: [], generatedAt: 0, version: 2 };

async function loadSmartFilters() {
  try {
    const snap = await db.ref('ai/smartFilters').once('value');
    const saved = snap.val();
    if (saved && saved.singleRules) {
      smartFilters = saved;
      console.log(`[AI] Smart filters v${saved.version || 1} chargés: ${saved.singleRules.length} règles, ${saved.comboRules.length} combos`);
    }
  } catch (e) {
    console.warn('[AI] loadSmartFilters error:', e.message);
  }
}

// ── ANALYSE STATISTIQUE v2 — Seuils optimaux avec confiance ──
function findOptimalThreshold(goodCalls, badCalls, featureKey, direction) {
  const allVals = [
    ...goodCalls.map(c => ({ val: c[featureKey] || 0, win: true, ts: c._ts || 0 })),
    ...badCalls.map(c => ({ val: c[featureKey] || 0, win: false, ts: c._ts || 0 })),
  ].filter(v => v.val !== 0 && v.val !== undefined);

  if (allVals.length < 15) return null;

  allVals.sort((a, b) => a.val - b.val);

  let bestThreshold = null;
  let bestScore = 0;
  const now = Date.now();
  const DAY_MS = 86400000;

  const step = Math.max(1, Math.floor(allVals.length / 25));
  for (let i = step; i < allVals.length - step; i += step) {
    const threshold = allVals[i].val;

    let aboveWinW = 0, aboveLoseW = 0, belowWinW = 0, belowLoseW = 0;
    let aboveCount = 0, belowCount = 0;

    for (const v of allVals) {
      // Decay temporel : calls < 3j = poids 2, < 7j = 1.5, sinon 1
      const ageD = (now - (v.ts || 0)) / DAY_MS;
      const weight = ageD < 3 ? 2 : ageD < 7 ? 1.5 : 1;

      if (v.val >= threshold) {
        aboveCount++;
        if (v.win) aboveWinW += weight; else aboveLoseW += weight;
      } else {
        belowCount++;
        if (v.win) belowWinW += weight; else belowLoseW += weight;
      }
    }

    if (direction === 'high_is_bad') {
      if (aboveCount < 8) continue; // MIN 8 samples
      const totalW = aboveWinW + aboveLoseW;
      const lossRate = aboveLoseW / totalW;
      // Confiance = lossRate × sqrt(samples) — favorise les règles avec beaucoup de données
      const confidence = lossRate * Math.sqrt(aboveCount);
      if (lossRate >= 0.55 && confidence > bestScore) {
        bestScore = confidence;
        bestThreshold = { threshold, lossRate: Math.round(lossRate * 100), samples: aboveCount, direction, confidence: parseFloat(confidence.toFixed(2)) };
      }
    } else {
      if (belowCount < 8) continue;
      const totalW = belowWinW + belowLoseW;
      const lossRate = belowLoseW / totalW;
      const confidence = lossRate * Math.sqrt(belowCount);
      if (lossRate >= 0.55 && confidence > bestScore) {
        bestScore = confidence;
        bestThreshold = { threshold, lossRate: Math.round(lossRate * 100), samples: belowCount, direction, confidence: parseFloat(confidence.toFixed(2)) };
      }
    }
  }

  return bestThreshold;
}

// ── DÉTECTION DE COMBOS TOXIQUES v2 ──
function findToxicCombos(goodCalls, badCalls) {
  const combos = [];
  const featurePairs = [
    ['c5m', 'c1h'], ['m5', 'c1h'], ['c5m', 'volMcapH1'],
    ['c6h', 'c1h'], ['sellBuyRatio', 'volMcapH1'], ['sellBuyRatio', 'c1h'],
    ['top10pct', 'sellBuyRatio'], ['buyRatio', 'volMcapH1'],
    ['c5m', 'sellBuyRatio'], ['c1h', 'volMcapH1'],
    ['patternScore', 'buyRatio'], ['patternScore', 'c1h'],
    ['score', 'c1h'], ['score', 'buyRatio'],
    ['traderScore', 'patternScore'], ['socialScore', 'patternScore'],
    ['top10pct', 'buyRatio'], ['top10pct', 'c1h'],
    ['holderScore', 'c1h'], ['c1h', 'buyRatio'],
    ['callMcap', 'c1h'], ['callMcap', 'patternScore'],
  ];

  for (const [f1, f2] of featurePairs) {
    const badF1 = badCalls.map(c => c[f1] || 0).filter(v => v !== 0).sort((a, b) => a - b);
    const badF2 = badCalls.map(c => c[f2] || 0).filter(v => v !== 0).sort((a, b) => a - b);
    if (badF1.length < 8 || badF2.length < 8) continue; // MIN 8 au lieu de 5

    const medF1 = badF1[Math.floor(badF1.length / 2)];
    const medF2 = badF2[Math.floor(badF2.length / 2)];

    // Test AND_ABOVE
    const matchGood = goodCalls.filter(c => (c[f1] || 0) >= medF1 && (c[f2] || 0) >= medF2).length;
    const matchBad = badCalls.filter(c => (c[f1] || 0) >= medF1 && (c[f2] || 0) >= medF2).length;
    const total = matchGood + matchBad;
    if (total >= 8) { // MIN 8 au lieu de 4
      const lossRate = matchBad / total;
      if (lossRate >= 0.60) { // 60% au lieu de 65%
        combos.push({
          features: [f1, f2],
          thresholds: [parseFloat(medF1.toFixed(2)), parseFloat(medF2.toFixed(2))],
          operator: 'AND_ABOVE',
          lossRate: Math.round(lossRate * 100),
          samples: total,
          confidence: parseFloat((lossRate * Math.sqrt(total)).toFixed(2)),
          description: `${f1} >= ${medF1.toFixed(1)} ET ${f2} >= ${medF2.toFixed(1)} → ${Math.round(lossRate * 100)}% loss (${total} samples)`,
        });
      }
    }

    // Test ABOVE_BELOW
    const matchGood2 = goodCalls.filter(c => (c[f1] || 0) >= medF1 && (c[f2] || 0) < medF2).length;
    const matchBad2 = badCalls.filter(c => (c[f1] || 0) >= medF1 && (c[f2] || 0) < medF2).length;
    const total2 = matchGood2 + matchBad2;
    if (total2 >= 8) {
      const lossRate2 = matchBad2 / total2;
      if (lossRate2 >= 0.60) {
        combos.push({
          features: [f1, f2],
          thresholds: [parseFloat(medF1.toFixed(2)), parseFloat(medF2.toFixed(2))],
          operator: 'ABOVE_BELOW',
          lossRate: Math.round(lossRate2 * 100),
          samples: total2,
          confidence: parseFloat((lossRate2 * Math.sqrt(total2)).toFixed(2)),
          description: `${f1} >= ${medF1.toFixed(1)} ET ${f2} < ${medF2.toFixed(1)} → ${Math.round(lossRate2 * 100)}% loss (${total2} samples)`,
        });
      }
    }
  }

  combos.sort((a, b) => b.confidence - a.confidence || b.lossRate - a.lossRate);
  return combos.slice(0, 12);
}

// ── BUILD SMART FILTERS v2 ──
async function buildSmartFilters() {
  try {
    const snap = await db.ref('calls').orderByChild('savedAt').limitToLast(400).once('value');
    const allCalls = snap.val() || {};
    const calls = Object.entries(allCalls)
      .map(([key, c]) => ({ key, ...c }))
      .filter(c => c.outcome?.result && (c.outcome?.features || c.debug));

    if (calls.length < 20) {
      return { ok: false, reason: `Pas assez de calls (${calls.length}/20 min)` };
    }

    const extractFeatures = (c) => ({
      _ts: c.savedAt || c.calledAt || 0,
      score: c.score || 0,
      callMcap: c.callMcap || 0,
      athX: c.outcome.athX || 0,
      traderScore: c.outcome.features?.traderScore || c.debug?.traderScore || 0,
      socialScore: c.outcome.features?.socialScore || c.debug?.socialScore || 0,
      holderScore: c.outcome.features?.holderScore || c.debug?.holderScore || 0,
      patternScore: c.outcome.features?.patternScore || c.debug?.patternScore || 0,
      buyRatio: c.outcome.features?.buyRatio || c.debug?.buyRatio || 0,
      volAccel: c.outcome.features?.volAccel || c.debug?.volAccel || 0,
      c1h: c.outcome.features?.c1h || c.debug?.c1h || 0,
      m5: c.outcome.features?.m5 || c.debug?.m5 || 0,
      c6h: c.outcome.features?.c6h || c.debug?.c6h || 0,
      top10pct: c.outcome.features?.top10pct || c.debug?.top10pct || 0,
      axiomCount: c.outcome.features?.axiomCount || c.debug?.axiomCount || 0,
      mcap: c.outcome.features?.mcap || c.callMcap || 0,
      liq: c.outcome.features?.liq || c.liq || 0,
      volMcapH1: c.outcome.features?.volMcapH1 || c.debug?.volMcapH1 || 0,
      sellBuyRatio: c.outcome.features?.sellBuyRatio || c.debug?.sellBuyRatio || 0,
    });

    const threshold = 1.2;
    const goodCalls = calls.filter(c => (c.outcome.athX || 0) >= threshold).map(extractFeatures);
    const badCalls = calls.filter(c => (c.outcome.athX || 0) < threshold).map(extractFeatures);

    console.log(`[AI] Building smart filters v2: ${goodCalls.length} good, ${badCalls.length} bad (total ${calls.length})`);

    // ── 1. Seuils par feature ──
    const featureConfigs = [
      { key: 'volMcapH1', direction: 'high_is_bad', name: 'Volume/Mcap ratio' },
      { key: 'sellBuyRatio', direction: 'high_is_bad', name: 'Ratio Sells/Buys' },
      { key: 'c5m', direction: 'high_is_bad', name: 'Variation 5min (%)' },
      { key: 'c1h', direction: 'high_is_bad', name: 'Variation 1h (%)' },
      { key: 'top10pct', direction: 'high_is_bad', name: 'Top 10 holders (%)' },
      { key: 'buyRatio', direction: 'low_is_bad', name: 'Buy Ratio' },
      { key: 'patternScore', direction: 'low_is_bad', name: 'Score Pattern' },
      { key: 'c6h', direction: 'high_is_bad', name: 'Variation 6h (%)' },
      { key: 'liq', direction: 'low_is_bad', name: 'Liquidite' },
    ];

    const singleRules = [];
    for (const fc of featureConfigs) {
      const result = findOptimalThreshold(goodCalls, badCalls, fc.key, fc.direction);
      if (result) {
        // v2: Pénalité proportionnelle, cappée à -12 max
        // Formule: -round(lossRate/100 * confidence * 3), cap -12
        const rawPenalty = -Math.round((result.lossRate / 100) * Math.min(result.confidence, 4) * 3);
        const penalty = Math.max(-12, rawPenalty);
        // Hard reject SEULEMENT si >= 90% loss ET >= 15 samples
        const isHardReject = result.lossRate >= 90 && result.samples >= 15;
        singleRules.push({
          feature: fc.key,
          name: fc.name,
          ...result,
          action: isHardReject ? 'HARD_REJECT' : 'PENALTY',
          penalty: isHardReject ? -999 : penalty,
        });
      }
    }

    // ── 2. Combos toxiques ──
    const comboRules = findToxicCombos(goodCalls, badCalls);

    // ── 3. Sauvegarder ──
    smartFilters = {
      singleRules,
      comboRules,
      generatedAt: Date.now(),
      version: 2,
      sampleSize: calls.length,
      goodCount: goodCalls.length,
      badCount: badCalls.length,
      winrate: parseFloat((goodCalls.length / calls.length * 100).toFixed(1)),
    };

    await db.ref('ai/smartFilters').set(smartFilters);
    console.log(`[AI] Smart filters v2 saved: ${singleRules.length} rules, ${comboRules.length} combos`);

    return { ok: true, ...smartFilters };
  } catch (e) {
    console.warn('[AI] buildSmartFilters error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ── CHECK SMART FILTERS v2 — Soft scoring, presque jamais de hard reject ──
function checkSmartFilters(tokenDebug) {
  if (!smartFilters.singleRules.length && !smartFilters.comboRules.length) {
    return { pass: true, penalty: 0, reasons: [] };
  }

  const reasons = [];
  let totalPenalty = 0;

  // ── Single rules → pénalité proportionnelle ──
  for (const rule of smartFilters.singleRules) {
    const val = tokenDebug[rule.feature];
    if (val === undefined || val === null || val === 0) continue;

    let triggered = false;
    if (rule.direction === 'high_is_bad' && val >= rule.threshold) triggered = true;
    if (rule.direction === 'low_is_bad' && val <= rule.threshold) triggered = true;

    if (triggered) {
      // v2: Hard reject seulement si >= 90% loss ET >= 15 samples
      if (rule.action === 'HARD_REJECT' && rule.lossRate >= 90 && rule.samples >= 15) {
        return {
          pass: false,
          reasons: [`🚫 IA: ${rule.name} = ${typeof val === 'number' ? val.toFixed(2) : val} (${rule.lossRate}% loss, ${rule.samples} samples)`],
        };
      }
      // Sinon: pénalité douce, cap -12
      const pen = Math.max(-12, rule.penalty);
      totalPenalty += pen;
      reasons.push(`⚠️ ${rule.name} = ${typeof val === 'number' ? val.toFixed(2) : val} → ${pen} pts (${rule.lossRate}% loss, ${rule.samples}s)`);
    }
  }

  // ── Combo rules → pénalité proportionnelle ──
  for (const combo of smartFilters.comboRules) {
    const [f1, f2] = combo.features;
    const [t1, t2] = combo.thresholds;
    const v1 = tokenDebug[f1];
    const v2 = tokenDebug[f2];
    if ((v1 === undefined || v1 === 0) && (v2 === undefined || v2 === 0)) continue;

    let triggered = false;
    if (combo.operator === 'AND_ABOVE' && (v1 || 0) >= t1 && (v2 || 0) >= t2) triggered = true;
    if (combo.operator === 'ABOVE_BELOW' && (v1 || 0) >= t1 && (v2 || 0) < t2) triggered = true;

    if (triggered) {
      // v2: Hard reject combo seulement si >= 90% loss ET >= 15 samples
      if (combo.lossRate >= 90 && combo.samples >= 15) {
        return {
          pass: false,
          reasons: [`🚫 COMBO: ${combo.description}`],
        };
      }
      // Pénalité douce: max -8 par combo
      const pen = Math.max(-8, -Math.round((combo.lossRate / 100) * Math.min(combo.confidence || 2, 3) * 2.5));
      totalPenalty += pen;
      reasons.push(`⚠️ COMBO: ${combo.description} → ${pen} pts`);
    }
  }

  // v2: Rejet cumulé seulement si penalty très forte (-40 au lieu de -30)
  if (totalPenalty <= -40) {
    return { pass: false, reasons: [...reasons, `💀 Pénalités IA cumulées: ${totalPenalty} pts → REJET`] };
  }

  return { pass: true, penalty: totalPenalty, reasons };
}

// ── EXPORT ──
export {
  dynamicWeights,
  trackOutcomes,
  analyzePatterns,
  autoAdjust,
  loadWeights,
  getAIPanel,
  getWinrateStats,
  deepAnalyze,
  buildSmartFilters,
  loadSmartFilters,
  checkSmartFilters,
  smartFilters,
};
