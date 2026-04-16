// 0DTE Signal Server — runs the full signal engine server-side
// Connects to Finnhub WebSocket and sends web push notifications
// Deploy to any Node.js host (Railway, Render, Fly.io, etc.)

try { require('dotenv').config(); } catch(e) { /* dotenv not needed on Railway */ }
const express = require('express');
const webpush = require('web-push');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// CORS — allow requests from any origin (Netlify PWA → Railway)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===== CONFIG =====
const API = process.env.FINNHUB_API_KEY;
const PORT = process.env.PORT || 3000;
const SYMBOLS = ['QQQ', 'SPY'];
const RSI_CALL_LO = { QQQ: 45, SPY: 45 };
const RSI_CALL_HI = { QQQ: 65, SPY: 65 };
const RSI_PUT_LO  = { QQQ: 30, SPY: 30 };
const RSI_PUT_HI  = { QQQ: 55, SPY: 55 };
const ROC_BLOWOFF = { QQQ: 0.15, SPY: 0.15 };
const MAX_IND = { QQQ: 6, SPY: 6 };
const COOLDOWN_MS = 180000;
// FLIP_COOL_MS removed — was blocking legitimate reversal signals
const MAX_SIG = 10;
const THR = 5;
const ROC_THR = 0.018;

// VAPID setup
webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:jean.fiani@ktstravel.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Subscription storage (in-memory, persisted to file)
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
let subscriptions = [];
try { subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) {}
function saveSubs() { fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2)); }

// ===== PER-SYMBOL STATE =====
const S = {};
SYMBOLS.forEach(sym => {
  S[sym] = {
    prices: [], highs: [], lows: [],
    pE5: null, pE13: null, pE34: null, pMF: null, pMS: null, pMSig: null,
    vwapSum: 0, vwapCount: 0, prevMacdHist: null,
    openPrice: null, blowoffTs: 0,
    lossStreak: 0, lossStreakBoost: 0, lossStreakUntil: 0,
    lastAT: '', lastNTs: 0, lastReversalTs: 0,
    dailySignalCount: 0, lastSignalDir: null, lastSignalTs: 0,
    nC: 0, nP: 0, nBl: 0,
    chopShort: [], chopLong: [], chopCount: 0, trendCount: 0, chopActive: false,
    signals: [], tickBuf: [], lastPrice: 0,
    crossAssetDir: null, crossAssetTs: 0,
    sessionHigh: -Infinity, sessionLow: Infinity,
    gapDayMode: false, gapDirection: null, prevClose: null,
    lastSameDir: null, lastSameDirMacd: 0, lastSameDirTs: 0,
    // Trade monitor
    trade: { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 }
  };
});
let vixV = 0;

// ===== MATH HELPERS =====
function ema(prev, val, period) { return prev === null ? val : val * (2 / (period + 1)) + prev * (1 - 2 / (period + 1)); }
function calcRSI(arr) {
  if (arr.length < 15) return 50;
  let g = 0, l = 0; const len = Math.min(arr.length, 14);
  for (let i = arr.length - len; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= len; l /= len;
  return l === 0 ? 100 : +(100 - 100 / (1 + g / l)).toFixed(1);
}
function calcROC(arr, p) { if (arr.length < p + 1) return 0; return +((arr[arr.length - 1] - arr[arr.length - 1 - p]) / arr[arr.length - 1 - p] * 100).toFixed(4); }
function calcEfficiency(arr) {
  if (arr.length < 10) return 1;
  const hi = Math.max(...arr), lo = Math.min(...arr), net = hi - lo;
  let travel = 0; for (let i = 1; i < arr.length; i++) travel += Math.abs(arr[i] - arr[i - 1]);
  return travel > 0 ? net / travel : 1;
}
function gET() {
  const e = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return e.getHours() * 60 + e.getMinutes();
}
function ts() { return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' }); }

// ===== PUSH TO ALL SUBSCRIBERS =====
function sendPush(title, body, tag) {
  const payload = JSON.stringify({ title, body, tag: tag || 'signal-' + Date.now() });
  const dead = [];
  subscriptions.forEach((sub, i) => {
    webpush.sendNotification(sub, payload).catch(err => {
      if (err.statusCode === 410 || err.statusCode === 404) dead.push(i);
      else console.error('Push error:', err.statusCode || err.message);
    });
  });
  // Clean up dead subscriptions
  if (dead.length > 0) {
    dead.reverse().forEach(i => subscriptions.splice(i, 1));
    saveSubs();
  }
}

function log(sym, msg) {
  console.log(`[${ts()}] ${sym}: ${msg}`);
}

// ===== PERSISTENT SIGNAL LOGGING =====
const SIGNALS_DIR = path.join(__dirname, 'signal_logs');
try { fs.mkdirSync(SIGNALS_DIR, { recursive: true }); } catch (e) {}

function todayDateET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

function logSignal(sym, sig) {
  const dateStr = todayDateET();
  const file = path.join(SIGNALS_DIR, dateStr + '.csv');
  const exists = fs.existsSync(file);
  const header = 'date,time,symbol,type,price,score,rsi,macd,roc,vix,chop,dailyNum\n';
  const row = [dateStr, sig.time, sym, sig.type, sig.price, sig.score, sig.rsi, sig.macd, sig.roc, vixV.toFixed(1), S[sym].chopActive ? 1 : 0, sig.num].join(',') + '\n';
  if (!exists) fs.writeFileSync(file, header + row);
  else fs.appendFileSync(file, row);
}

// ===== PROCESS PRICE (same engine as mobile/desktop) =====
function processPrice(sym, price, hi, lo) {
  const s = S[sym];
  const mi = MAX_IND[sym];

  if (s.openPrice === null && gET() >= 570) {
    s.openPrice = price;
    if (s.prevClose !== null) {
      const gapPct = ((price - s.prevClose) / s.prevClose) * 100;
      if (Math.abs(gapPct) >= 2) { s.gapDayMode = true; s.gapDirection = gapPct > 0 ? 'up' : 'down'; log(sym, '🔥 GAP DAY: ' + gapPct.toFixed(2) + '% ' + s.gapDirection); }
    }
  }

  if (price > s.sessionHigh) s.sessionHigh = price;
  if (price < s.sessionLow) s.sessionLow = price;

  s.prices.push(price); s.highs.push(hi || price); s.lows.push(lo || price);
  if (s.prices.length > 200) { s.prices.shift(); s.highs.shift(); s.lows.shift(); }

  // Chop detector
  s.chopShort.push(price); if (s.chopShort.length > 30) s.chopShort.shift();
  s.chopLong.push(price); if (s.chopLong.length > 150) s.chopLong.shift();
  if (s.chopShort.length >= 10) {
    const effS = calcEfficiency(s.chopShort);
    const effL = s.chopLong.length >= 30 ? calcEfficiency(s.chopLong) : 1;
    const thrS = 0.30, thrL = 0.35, resS = 0.35, resL = 0.40;
    const isChoppy = effS < thrS || effL < thrL;
    const isTrending = effS > resS && effL > resL;
    if (!s.chopActive) { if (isChoppy) { s.chopCount++; s.trendCount = 0; } else s.chopCount = 0; if (s.chopCount >= 3) { s.chopActive = true; s.chopCount = 0; log(sym, '🌊 CHOP MODE'); sendPush('🌊 ' + sym + ' CHOP MODE', 'Efficiency low — signals paused'); } }
    else { if (isTrending) { s.trendCount++; s.chopCount = 0; } else s.trendCount = 0; if (s.trendCount >= 3) { s.chopActive = false; s.trendCount = 0; log(sym, '📈 TREND RESUMED'); sendPush('📈 ' + sym + ' TREND BACK', 'Signals active'); } }
  }

  const n = s.prices.length;
  if (n < 10) return;

  // EMAs + indicators
  s.pE5 = ema(s.pE5, price, 9); s.pE13 = ema(s.pE13, price, 21); s.pE34 = ema(s.pE34, price, 34);
  s.pMF = ema(s.pMF, price, 12); s.pMS = ema(s.pMS, price, 26); s.pMSig = ema(s.pMSig, s.pMF - s.pMS, 9);
  s.vwapSum += price; s.vwapCount++;
  const vwap = s.vwapSum / s.vwapCount;
  const macdL = +(s.pMF - s.pMS).toFixed(3), macdS = +(s.pMSig || 0).toFixed(3);
  const rsiV = calcRSI(s.prices);
  const roc3 = calcROC(s.prices, 3);

  const e5b = s.pE5 > s.pE13, e5bear = s.pE5 < s.pE13;
  const e13b = s.pE13 > s.pE34, e13bear = s.pE13 < s.pE34;
  const vwapPct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
  const vwapZone = 0.1;
  const abV = vwapPct > vwapZone, blV = vwapPct < -vwapZone;
  const macdHist = macdL - macdS;
  const macdAccel = typeof s.prevMacdHist === 'number' ? macdHist - s.prevMacdHist : 0;
  s.prevMacdHist = macdHist;
  const mBull = macdL > macdS && macdAccel >= 0, mBear = macdL < macdS && macdAccel <= 0;
  const rBull = rsiV >= RSI_CALL_LO[sym] && rsiV <= RSI_CALL_HI[sym];
  const rBear = rsiV >= RSI_PUT_LO[sym] && rsiV <= RSI_PUT_HI[sym];
  const rocBull = roc3 > ROC_THR, rocBear = roc3 < -ROC_THR;

  // Score
  let cS = 0, pS = 0;
  if (e5b) cS++; if (e5bear) pS++;
  if (e13b) cS++; if (e13bear) pS++;
  if (abV) cS++; if (blV) pS++;
  if (rBull) cS++; if (rsiV < 45 || rsiV > 70) pS++;
  if (mBull) cS++; if (mBear) pS++;
  if (rocBull) cS++; if (rocBear) pS++;
  if (s.crossAssetDir === 'call' && Date.now() - s.crossAssetTs < 300000) cS++;
  if (s.crossAssetDir === 'put' && Date.now() - s.crossAssetTs < 300000) pS++;

  // Store indicator state for /prices endpoint
  const dom = Math.max(cS, pS);
  s._ind = { e5b, e5bear, e13b, e13bear, abV, blV, mBull, mBear, rBull, rBear: rsiV < 35 || rsiV > 65, rocBull, rocBear };
  s._rsi = rsiV;
  s._dom = dom;
  s._macdL = macdL;
  s._macdS = macdS;
  s._roc3 = roc3;
  s._vwap = vwap;

  // Check exit for active trades
  checkExit(sym, price);

  const now2 = Date.now();
  const cool = now2 - s.lastNTs > COOLDOWN_MS;

  // === SIGNAL GATES ===
  const etMin = gET();
  if (etMin < 570 || etMin >= 955) return;
  if (etMin >= 945 && (cS >= THR || pS >= THR)) return;

  // Chop with override — strengthened: require score >= 6 + RSI + ROC (was: any score + RSI + ROC)
  const domT = cS >= pS ? 'call' : 'put';
  if (s.chopActive && (cS >= THR || pS >= THR)) {
    const chopScore = domT === 'call' ? cS : pS;
    const chopRsiOk = (domT === 'call' && rsiV >= RSI_CALL_LO[sym] && rsiV <= RSI_CALL_HI[sym]) || (domT === 'put' && rsiV >= RSI_PUT_LO[sym] && rsiV <= RSI_PUT_HI[sym]);
    const chopRocOk = (domT === 'call' && roc3 > ROC_THR) || (domT === 'put' && roc3 < -ROC_THR);
    if (!(chopScore >= 6 && chopRsiOk && chopRocOk)) return;
  }

  // Dynamic threshold
  const refPrice = s.openPrice || 0;
  const dayMv = refPrice > 0 ? Math.abs(((price - refPrice) / refPrice) * 100) : 0;
  const tightMode = dayMv >= 1;
  const streakActive = now2 < s.lossStreakUntil;
  let minS = (tightMode ? 6 : THR) + (streakActive ? s.lossStreakBoost : 0);

  // Blowoff
  const blowoffLock = now2 - s.blowoffTs < 300000;
  if (Math.abs(roc3) > ROC_BLOWOFF[sym] && !blowoffLock) { s.blowoffTs = now2; }
  if (blowoffLock && (cS >= minS || pS >= minS)) return;

  // Flip lock
  if (now2 - s.lastReversalTs < 180000 && (cS >= minS || pS >= minS)) return;
  // Daily cap
  if (s.dailySignalCount >= MAX_SIG) return;
  // Direction-flip cooldown — REMOVED (was 480s, blocked reversal catches)

  // RSI sweet-spot
  const rsiSweetCall = rsiV >= RSI_CALL_LO[sym] && rsiV <= RSI_CALL_HI[sym];
  const rsiSweetPut = rsiV >= RSI_PUT_LO[sym] && rsiV <= RSI_PUT_HI[sym];
  if (!rsiSweetCall && cS >= minS && cS >= pS) return;
  if (!rsiSweetPut && pS >= minS && pS > cS) return;

  // PM penalty
  const pmPenalty = etMin >= 780 ? 1 : 0;
  const finalMinS = minS + pmPenalty;
  if (pmPenalty && cS >= minS && cS < finalMinS) return;
  if (pmPenalty && pS >= minS && pS < finalMinS) return;

  // MACD alignment
  const macdAlignCall = macdL > macdS, macdAlignPut = macdL < macdS;
  if (!macdAlignCall && cS >= finalMinS && cS >= pS) return;
  if (!macdAlignPut && pS >= finalMinS && pS > cS) return;

  // MACD minimum strength (raised from 0.010 — weak MACD = noise signals)
  const macdStr = Math.abs(macdL - macdS);
  if (macdStr < 0.020 && (cS >= finalMinS || pS >= finalMinS)) return;

  // Session High/Low Proximity
  if (s.sessionHigh > -Infinity && s.openPrice) {
    const sessExt = ((price - s.openPrice) / s.openPrice) * 100;
    const hiProx = s.sessionHigh > 0 ? ((s.sessionHigh - price) / s.sessionHigh) * 100 : 99;
    const loProx = s.sessionLow > 0 ? ((price - s.sessionLow) / s.sessionLow) * 100 : 99;
    if (cS >= finalMinS && cS >= pS && sessExt >= 0.15 && hiProx < 0.05 && macdStr < 0.015) return;
    if (pS >= finalMinS && pS > cS && sessExt <= -0.15 && loProx < 0.05 && macdStr < 0.015) return;
  }

  // MACD Fade
  { const cDir = cS >= pS ? 'call' : 'put'; const cMacdStr = Math.abs(macdL - macdS);
    if (s.lastSameDir === cDir && (now2 - s.lastSameDirTs < 900000) && s.lastSameDirMacd > 0) {
      const mDrop = 1 - (cMacdStr / s.lastSameDirMacd);
      if (mDrop >= 0.60 && ((cDir === 'call' && cS >= finalMinS) || (cDir === 'put' && pS >= finalMinS))) return;
    }
  }

  // Consecutive Cooldown
  { const cDir2 = cS >= pS ? 'call' : 'put';
    if (s.lastSameDir === cDir2 && (now2 - s.lastSameDirTs < 600000)) {
      const mH = macdL - macdS; const mAOk = (cDir2 === 'call' && mH > 0 && s.prevMacdHist !== null && mH > s.prevMacdHist) || (cDir2 === 'put' && mH < 0 && s.prevMacdHist !== null && mH < s.prevMacdHist);
      if (!mAOk && ((cDir2 === 'call' && cS >= finalMinS) || (cDir2 === 'put' && pS >= finalMinS))) return;
    }
  }

  // Gap Day Mode
  if (s.gapDayMode && etMin >= 810) {
    if (s.gapDirection === 'up' && cS >= finalMinS && cS >= pS && rsiV >= 50) return;
    if (s.gapDirection === 'down' && pS >= finalMinS && pS > cS && rsiV <= 50) return;
  }

  // Retrace filter — block dead-cat-bounce signals
  // If price dropped >$0.50 in last 30 ticks, require 50% retrace before CALL (and vice versa for PUT)
  if (s.prices.length >= 30) {
    const recent = s.prices.slice(-30);
    const recentHi = Math.max(...recent), recentLo = Math.min(...recent);
    const moveSize = recentHi - recentLo;
    if (moveSize >= 0.50) {
      const retracePct = recentHi > recentLo ? (price - recentLo) / (recentHi - recentLo) : 0.5;
      // For CALL: price should be above 50% retrace (not bouncing off the bottom)
      if (cS >= finalMinS && cS >= pS && retracePct < 0.50) { log(sym, 'Retrace filter: CALL blocked — only ' + (retracePct * 100).toFixed(0) + '% retrace of $' + moveSize.toFixed(2) + ' drop'); return; }
      // For PUT: price should be below 50% retrace (not selling off the top)
      if (pS >= finalMinS && pS > cS && retracePct > 0.50) { log(sym, 'Retrace filter: PUT blocked — price at ' + (retracePct * 100).toFixed(0) + '% of $' + moveSize.toFixed(2) + ' range'); return; }
    }
  }

  // RSI exhaustion check — don't short at oversold, don't buy at overbought
  if (cS >= finalMinS && cS >= pS && rsiV > 65) { log(sym, 'RSI exhaustion: CALL blocked — RSI ' + rsiV.toFixed(1) + ' (overbought)'); return; }
  if (pS >= finalMinS && pS > cS && rsiV < 35) { log(sym, 'RSI exhaustion: PUT blocked — RSI ' + rsiV.toFixed(1) + ' (oversold)'); return; }

  const vixOk = vixV <= 0 || vixV < 35;  // treat unknown VIX as OK (don't block calls when VIX fetch fails)
  const fireCall = cS >= finalMinS && vixOk && rsiSweetCall && macdAlignCall;
  const firePut = pS >= finalMinS && rsiSweetPut && macdAlignPut;

  // === FIRE SIGNALS ===
  if (fireCall && cool) {
    s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
    if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
    s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
    s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2;
    const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: cS + '/' + mi, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
    s.signals.push(sig);
    logSignal(sym, sig);
    log(sym, '🚀 CALL ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + ' [#' + s.dailySignalCount + ']');
    sendPush('🚀 ' + sym + ' CALL ' + sig.score + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc, 'signal');
    // Activate trade monitor for this signal
    s.trade = { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
    // Cross-asset
    SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
  } else if (firePut && cool) {
    s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
    if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
    s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
    s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2;
    const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: pS + '/' + mi, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
    s.signals.push(sig);
    logSignal(sym, sig);
    log(sym, '📉 PUT ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + ' [#' + s.dailySignalCount + ']');
    sendPush('📉 ' + sym + ' PUT ' + sig.score + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc, 'signal');
    // Activate trade monitor for this signal
    s.trade = { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
    SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
  }
}

// ===== EXIT MONITOR =====
function checkExit(sym, price) {
  const s = S[sym], t = s.trade;
  if (!t.active || !t.ep || price <= 0) return;
  const iC = t.type === 'call', raw = ((price - t.ep) / t.ep) * 100, dm = iC ? raw : -raw;
  // Reversal detection
  const e5b = s.pE5 > s.pE13, e13b = s.pE13 > s.pE34;
  const mb = s.pMF && s.pMS && s.pMSig ? (s.pMF - s.pMS) > s.pMSig : false;
  const roc3Now = s.prices.length >= 4 ? calcROC(s.prices, 3) : 0;
  let fl = 0;
  if (iC) { if (!e5b) fl++; if (!e13b) fl++; if (roc3Now < 0) fl++; if (!mb) fl++; }
  else { if (e5b) fl++; if (e13b) fl++; if (roc3Now > 0) fl++; if (mb) fl++; }
  const now = Date.now(), cd = now - t.lastETs > 120000;
  if (!t.sl && dm <= -t.sl2) {
    t.sl = true; t.lastETs = now;
    log(sym, '🛑 STOP LOSS — ' + t.type.toUpperCase() + ' ' + dm.toFixed(2) + '%');
    sendPush('🛑 STOP LOSS ' + sym, t.type.toUpperCase() + ' ' + dm.toFixed(2) + '% — exit now', 'exit');
  } else if (!t.t2 && dm >= t.pt2) {
    t.t2 = true; t.lastETs = now;
    log(sym, '💰 PT2 +' + dm.toFixed(2) + '% — FULL EXIT');
    sendPush('💰 PT2 ' + sym, '+' + dm.toFixed(2) + '% — close full position', 'exit');
  } else if (!t.t1 && dm >= t.pt1) {
    t.t1 = true; t.lastETs = now;
    log(sym, '💰 PT1 +' + dm.toFixed(2) + '% — PARTIAL EXIT');
    sendPush('💰 PT1 ' + sym, '+' + dm.toFixed(2) + '% — close 50%', 'exit');
  } else if (fl >= 3 && cd && !t.sl) {
    t.rev = true; t.lastETs = now;
    log(sym, '⚠️ REVERSAL — ' + fl + '/4 flipped · ' + dm.toFixed(2) + '%');
    sendPush('⚠️ REVERSAL ' + sym, fl + '/4 indicators flipped — exit zone', 'exit');
  }
}

// ===== FINNHUB WEBSOCKET =====
let ws = null, wsReconnects = 0, wsBackoff = 1000;
function connectFinnhub() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try {
    ws = new WebSocket('wss://ws.finnhub.io?token=' + API);
    ws.on('open', () => {
      wsReconnects = 0; wsBackoff = 1000;
      console.log('[' + ts() + '] Finnhub WebSocket connected');
      SYMBOLS.forEach(s => ws.send(JSON.stringify({ type: 'subscribe', symbol: s })));
    });
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'trade' && msg.data) {
          msg.data.forEach(t => {
            const sym = t.s; if (!SYMBOLS.includes(sym)) return;
            S[sym].lastPrice = t.p;
            S[sym].tickBuf.push({ p: t.p });
          });
        }
      } catch (e) {}
    });
    ws.on('error', () => console.error('[' + ts() + '] WS error'));
    ws.on('close', () => {
      console.log('[' + ts() + '] WS closed, reconnecting in ' + wsBackoff + 'ms');
      wsReconnects++;
      setTimeout(connectFinnhub, wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, 30000);
    });
  } catch (e) {
    setTimeout(connectFinnhub, wsBackoff);
  }
}

// Process ticks every 3 seconds
setInterval(() => {
  SYMBOLS.forEach(sym => {
    const s = S[sym];
    if (s.tickBuf.length === 0) return;
    const price = s.tickBuf[s.tickBuf.length - 1].p;
    const hi = Math.max(...s.tickBuf.map(t => t.p));
    const lo = Math.min(...s.tickBuf.map(t => t.p));
    s.tickBuf = [];
    processPrice(sym, price, hi, lo);
  });
}, 3000);

// Fetch VIX every 30 seconds (try multiple symbol formats)
async function fetchVIX() {
  const symbols = ['CBOE:VIX', 'VIX', '^VIX'];
  for (const sym of symbols) {
    try {
      const res = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + API + '&_=' + Date.now());
      const data = await res.json();
      if (data && data.c > 0) { vixV = data.c; return; }
    } catch (e) {}
  }
  console.log('[' + ts() + '] VIX fetch failed - all symbols returned 0');
}
setInterval(fetchVIX, 30000);

// Daily reset — date-based (resets as soon as ET date changes, not at a fixed minute)
let _lastResetDate = todayDateET();
setInterval(() => {
  const today = todayDateET();
  if (today !== _lastResetDate) {
    _lastResetDate = today;
    console.log('[' + ts() + '] Daily reset — new date: ' + today);
    SYMBOLS.forEach(sym => {
      const s = S[sym];
      s.prices = []; s.highs = []; s.lows = [];
      s.pE5 = null; s.pE13 = null; s.pE34 = null; s.pMF = null; s.pMS = null; s.pMSig = null;
      s.vwapSum = 0; s.vwapCount = 0; s.prevMacdHist = null; s.openPrice = null;
      s.blowoffTs = 0; s.lossStreak = 0; s.lossStreakBoost = 0; s.lossStreakUntil = 0;
      s.lastAT = ''; s.lastNTs = 0; s.lastReversalTs = 0;
      s.dailySignalCount = 0; s.lastSignalDir = null; s.lastSignalTs = 0;
      s.nC = 0; s.nP = 0; s.nBl = 0;
      s.chopShort = []; s.chopLong = []; s.chopCount = 0; s.trendCount = 0; s.chopActive = false;
      s.signals = []; s.tickBuf = [];
      s.crossAssetDir = null; s.crossAssetTs = 0;
      s.sessionHigh = -Infinity; s.sessionLow = Infinity;
      s.gapDayMode = false; s.gapDirection = null;
      s.lastSameDir = null; s.lastSameDirMacd = 0; s.lastSameDirTs = 0;
      s.trade = { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
    });
  }
}, 30000);

// ===== API ROUTES =====

// Serve VAPID public key
app.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Subscribe endpoint
app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  // Avoid duplicates
  const exists = subscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) { subscriptions.push(sub); saveSubs(); }
  console.log('[' + ts() + '] New push subscription (' + subscriptions.length + ' total)');
  res.json({ ok: true });
});

// Unsubscribe
app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveSubs();
  res.json({ ok: true });
});

// Activate trade monitor via API
app.post('/trade', (req, res) => {
  const { sym, type, price } = req.body;
  if (!sym || !type || !price) return res.status(400).json({ error: 'Missing sym, type, or price' });
  if (!S[sym]) return res.status(400).json({ error: 'Unknown symbol' });
  S[sym].trade = { active: true, type, ep: parseFloat(price), t1: false, t2: false, sl: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
  log(sym, '📍 Trade monitor ON — ' + type.toUpperCase() + ' @ $' + parseFloat(price).toFixed(2));
  res.json({ ok: true });
});

// Clear trade monitor
app.post('/trade/clear', (req, res) => {
  const { sym } = req.body;
  if (S[sym]) S[sym].trade = { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
  res.json({ ok: true });
});

// Full prices + indicators endpoint for mobile PWA polling
app.get('/prices', (req, res) => {
  const data = {};
  SYMBOLS.forEach(sym => {
    const s = S[sym];
    data[sym] = {
      price: s.lastPrice,
      ind: s._ind || null,
      rsi: s._rsi || 0,
      dom: s._dom || 0,
      macdL: s._macdL || 0,
      macdS: s._macdS || 0,
      roc3: s._roc3 || 0,
      vwap: s._vwap || 0,
      chopActive: s.chopActive,
      dailySignalCount: s.dailySignalCount,
      signals: s.signals.slice(-20),
      trade: s.trade.active ? { active: true, type: s.trade.type, ep: s.trade.ep, t1: s.trade.t1, t2: s.trade.t2, sl: s.trade.sl, rev: s.trade.rev } : { active: false }
    };
  });
  res.json({ vix: vixV, wsConnected: ws && ws.readyState === 1, ts: Date.now(), symbols: data });
});

// Status endpoint
app.get('/status', (req, res) => {
  const status = {};
  SYMBOLS.forEach(sym => {
    const s = S[sym];
    status[sym] = {
      price: s.lastPrice,
      signals: s.dailySignalCount,
      chopActive: s.chopActive,
      trade: s.trade.active ? { type: s.trade.type, ep: s.trade.ep, t1: s.trade.t1, t2: s.trade.t2, sl: s.trade.sl } : null,
      recentSignals: s.signals.slice(-5)
    };
  });
  res.json({ running: ws && ws.readyState === 1, vix: vixV, subscribers: subscriptions.length, symbols: status });
});

// Signal log — today's signals as CSV
app.get('/signals/today', (req, res) => {
  const file = path.join(SIGNALS_DIR, todayDateET() + '.csv');
  if (!fs.existsSync(file)) return res.status(200).send('date,time,symbol,type,price,score,rsi,macd,roc,vix,chop,dailyNum\n');
  res.header('Content-Type', 'text/csv');
  res.sendFile(file);
});

// Signal log — specific date (e.g. /signals/2026-04-11)
app.get('/signals/:date', (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'Use YYYY-MM-DD format' });
  const file = path.join(SIGNALS_DIR, dateStr + '.csv');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No signals for ' + dateStr });
  res.header('Content-Type', 'text/csv');
  res.sendFile(file);
});

// Signal log — list all available dates
app.get('/signals', (req, res) => {
  try {
    const files = fs.readdirSync(SIGNALS_DIR).filter(f => f.endsWith('.csv')).map(f => f.replace('.csv', '')).sort();
    res.json({ dates: files, count: files.length });
  } catch (e) { res.json({ dates: [], count: 0 }); }
});

// Health check
app.get('/', (req, res) => {
  res.send('0DTE Signal Server running. ' + subscriptions.length + ' subscribers. WS: ' + (ws && ws.readyState === 1 ? 'connected' : 'disconnected'));
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`[${ts()}] Signal server running on port ${PORT}`);
  connectFinnhub();
  fetchVIX();
});
