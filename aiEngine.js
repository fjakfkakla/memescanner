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
// Check le prix des calls passés après 1h et 6h
async function trackOutcomes() {
  try {
    const snap = await db.ref('calls').orderByChild('savedAt').limitToLast(100).once('value');
    const calls = snap.val() || {};
    const now = Date.now();
    let checked = 0;

    for (const [key, call] of Object.entries(calls)) {
      if (!call.addr || !call.callMcap) continue;

      const age = now - (call.calledAt || call.callTime || call.savedAt || 0);
      const has1h = call.outcome?.mcap1h != null;
      const has6h = call.outcome?.mcap6h != null;

      // Check 1h (entre 55min et 75min après le call)
      if (!has1h && age > 55 * 60000 && age < 75 * 60000) {
        const currentMcap = await fetchCurrentMcap(call.addr);
        if (currentMcap > 0) {
          const roi1h = ((currentMcap - call.callMcap) / call.callMcap * 100).toFixed(1);
          await db.ref(`calls/${key}/outcome`).update({
            mcap1h: currentMcap,
            roi1h: parseFloat(roi1h),
            check1hAt: now,
          });
          checked++;
        }
      }

      // Check 6h (entre 5h50 et 6h20 après le call)
      if (!has6h && age > 350 * 60000 && age < 380 * 60000) {
        const currentMcap = await fetchCurrentMcap(call.addr);
        if (currentMcap > 0) {
          const roi6h = ((currentMcap - call.callMcap) / call.callMcap * 100).toFixed(1);
          const result = currentMcap >= call.callMcap * 2 ? 'moon'
            : currentMcap >= call.callMcap * 1.2 ? 'win'
            : currentMcap >= call.callMcap * 0.7 ? 'flat'
            : 'loss';
          await db.ref(`calls/${key}/outcome`).update({
            mcap6h: currentMcap,
            roi6h: parseFloat(roi6h),
            check6hAt: now,
            result,
          });
          // Sauvegarder le snapshot features pour l'analyse
          await db.ref(`calls/${key}/outcome/features`).set({
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
            top10pct: call.debug?.top10pct || 0,
            axiomCount: call.debug?.axiomCount || 0,
          });
          checked++;
        }
      }
    }

    if (checked > 0) console.log(`[AI] Tracked ${checked} outcomes`);
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
    const features = ['traderScore', 'socialScore', 'holderScore', 'patternScore', 'buyRatio', 'volAccel', 'c1h', 'm5', 'top10pct', 'axiomCount', 'mcap', 'liq'];
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

    return {
      winrate: parseFloat((wins / withOutcome.length * 100).toFixed(1)),
      total: withOutcome.length,
      wins,
      losses,
      flats,
      moons,
      pending: calls.filter(c => !c.outcome?.result).length,
      avgRoi1h: parseFloat((withOutcome.filter(c => c.outcome.roi1h != null).reduce((s, c) => s + c.outcome.roi1h, 0) / (withOutcome.filter(c => c.outcome.roi1h != null).length || 1)).toFixed(1)),
      avgRoi6h: parseFloat((withOutcome.filter(c => c.outcome.roi6h != null).reduce((s, c) => s + c.outcome.roi6h, 0) / (withOutcome.filter(c => c.outcome.roi6h != null).length || 1)).toFixed(1)),
    };
  } catch (e) {
    return { error: e.message };
  }
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
};
