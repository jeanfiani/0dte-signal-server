// 0DTE Signal Server — runs the full signal engine server-side
// Connects to Finnhub WebSocket and sends web push notifications
// Deploy to any Node.js host (Railway, Render, Fly.io, etc.)

try { require('dotenv').config(); } catch(e) { /* dotenv not needed on Railway */ }
const express = require('express');
const webpush = require('web-push');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Global crash protection — log errors instead of killing the process
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[CRASH] Unhandled rejection:', err && err.message ? err.message : err);
});

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
const SYMBOLS = ['QQQ', 'SPY', 'XAU'];
const RSI_CALL_LO = { QQQ: 45, SPY: 45, XAU: 40 };
const RSI_CALL_HI = { QQQ: 65, SPY: 65, XAU: 68 }; // Gate range (rsiSweetCall) — tighter
const RSI_PUT_LO  = { QQQ: 30, SPY: 30, XAU: 28 };
const RSI_PUT_HI  = { QQQ: 55, SPY: 55, XAU: 58 };
const ROC_BLOWOFF = { QQQ: 0.15, SPY: 0.15, XAU: 0.20 };
const MAX_IND = { QQQ: 6, SPY: 6, XAU: 6 };
const COOLDOWN_MS = 180000;
// FLIP_COOL_MS removed — was blocking legitimate reversal signals
const MAX_SIG = 10;
const THR = 6;
const ROC_THR = 0.018;
const EQ_ROC_GATE = 0.030; // Hard ROC gate for equities — ROC-3 must confirm direction
const XAU_ROC_THR = 0.025; // XAU needs wider ROC threshold — higher volatility
const XAU_MACD_MIN = 0.10; // XAU MACD values ~5x larger than QQQ/SPY (price ~$3300 vs $650)
const XAU_MACD_LINE_MIN = 0.08; // XAU MACD line minimum strength

// VAPID setup
try {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:jean.fiani@ktstravel.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} catch (e) {
  console.error('[STARTUP] VAPID setup failed:', e.message, '— push notifications disabled');
}

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
    sessionHigh: -Infinity, sessionLow: Infinity, rsiAtSessionHigh: 50,
    gapDayMode: false, gapDirection: null, prevClose: null,
    lastSameDir: null, lastSameDirMacd: 0, lastSameDirTs: 0, lastSameDirPrice: 0,
    // Rolling multi-day high/low for ATH/ATL reversal detection
    rollingHighs: [],   // [{price, ts}] — last 5 days of session highs
    rollingLows: [],    // [{price, ts}] — last 5 days of session lows
    rollingHigh: 0,     // current 5-day high
    rollingLow: Infinity, // current 5-day low
    rsiAtRollingHigh: 50, // RSI when rolling high was touched
    rsiAtRollingLow: 50,  // RSI when rolling low was touched
    athApproachTs: 0,   // when price last entered ATH zone
    atlApproachTs: 0,   // when price last entered ATL zone
    // Shakeout recovery — tracks SL events for re-entry detection
    shakeoutDir: null,     // direction that got stopped ('call' or 'put')
    shakeoutTs: 0,         // when SL was hit
    shakeoutPrice: 0,      // price at SL
    shakeoutEp: 0,         // original entry price
    // Order Block detection — 1-min candle aggregation + OB zones
    obCandles: [],       // [{o, h, l, c, ts}] — completed 1-min candles (last 60)
    obCurCandle: null,   // current building candle {o, h, l, c, startTs, ticks}
    orderBlocks: [],     // [{type:'bull'|'bear', hi, lo, ts, mitigated:false}] — active OB zones
    // Trade monitor
    trade: { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 }
  };
});
let vixV = 0;

// ===== ROLLING HIGH/LOW PERSISTENCE (ATH/ATL detector) =====
const ROLLING_FILE = path.join(__dirname, 'rolling_levels.json');
function loadRollingLevels() {
  try {
    const data = JSON.parse(fs.readFileSync(ROLLING_FILE, 'utf8'));
    SYMBOLS.forEach(sym => {
      if (data[sym]) {
        const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
        S[sym].rollingHighs = (data[sym].rollingHighs || []).filter(h => h.ts > fiveDaysAgo);
        S[sym].rollingLows = (data[sym].rollingLows || []).filter(l => l.ts > fiveDaysAgo);
        if (S[sym].rollingHighs.length > 0) S[sym].rollingHigh = Math.max(...S[sym].rollingHighs.map(h => h.price));
        if (S[sym].rollingLows.length > 0) S[sym].rollingLow = Math.min(...S[sym].rollingLows.map(l => l.price));
      }
    });
    console.log('[' + ts() + '] Rolling levels loaded — XAU high:$' + (S.XAU.rollingHigh || 0).toFixed(2) + ' low:$' + (S.XAU.rollingLow === Infinity ? 0 : S.XAU.rollingLow).toFixed(2));
  } catch (e) {}
}
function saveRollingLevels() {
  const data = {};
  SYMBOLS.forEach(sym => {
    data[sym] = { rollingHighs: S[sym].rollingHighs, rollingLows: S[sym].rollingLows };
  });
  try { fs.writeFileSync(ROLLING_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}
// Save rolling levels every 5 minutes
setInterval(saveRollingLevels, 300000);

// ===== DXY STATE (for XAU inverse correlation) =====
let dxyPrice = 0, dxyPrices = [], dxyPrevEma5 = null, dxyPrevEma13 = null;
let dxyRoc3 = 0, dxyDir = 'neutral'; // 'up' = bearish gold, 'down' = bullish gold

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
function calcATR(highs, lows, closes, period) {
  if (highs.length < period + 1) return 0;
  let atr = 0;
  for (let i = highs.length - period; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    atr += tr;
  }
  return atr / period;
}
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
  if (subscriptions.length === 0) {
    console.log('[' + ts() + '] Push skipped — no subscribers. Title: ' + title);
    return;
  }
  const payload = JSON.stringify({ title, body, tag: tag || 'signal-' + Date.now() });
  console.log('[' + ts() + '] Pushing to ' + subscriptions.length + ' sub(s): ' + title);
  const dead = [];
  subscriptions.forEach((sub, i) => {
    try {
      webpush.sendNotification(sub, payload)
        .then(() => { console.log('[' + ts() + '] Push delivered to sub #' + i); })
        .catch(err => {
          console.error('[' + ts() + '] Push failed sub #' + i + ': ' + (err.statusCode || err.message));
          if (err.statusCode === 410 || err.statusCode === 404) dead.push(i);
        });
    } catch (e) {
      console.error('[' + ts() + '] Push error sub #' + i + ': ' + e.message);
    }
  });
  // Clean up dead subscriptions (async — runs after promises settle)
  setTimeout(() => {
    if (dead.length > 0) {
      console.log('[' + ts() + '] Removing ' + dead.length + ' dead subscription(s)');
      dead.sort((a, b) => b - a).forEach(i => subscriptions.splice(i, 1));
      saveSubs();
    }
  }, 5000);
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
  const isXAU = sym === 'XAU';

  // XAU: set open on first price (MT5 feeds only when market is open)
  // Equities: set open at 9:30 AM ET (570 min)
  if (s.openPrice === null && (sym === 'XAU' || gET() >= 570)) {
    s.openPrice = price;
    if (s.prevClose !== null) {
      const gapPct = ((price - s.prevClose) / s.prevClose) * 100;
      if (Math.abs(gapPct) >= 2) { s.gapDayMode = true; s.gapDirection = gapPct > 0 ? 'up' : 'down'; log(sym, '🔥 GAP DAY: ' + gapPct.toFixed(2) + '% ' + s.gapDirection); }
    }
  }

  if (price > s.sessionHigh) s.sessionHigh = price;
  if (price < s.sessionLow) s.sessionLow = price;

  // Update rolling 5-day high/low for ATH/ATL detector
  if (isXAU && price > 0) {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    // Add current session extremes periodically (every ~60 ticks)
    if (s.prices.length % 60 === 0 && s.sessionHigh > -Infinity) {
      s.rollingHighs.push({ price: s.sessionHigh, ts: Date.now() });
      if (s.sessionLow < Infinity) s.rollingLows.push({ price: s.sessionLow, ts: Date.now() });
      // Prune older than 5 days
      s.rollingHighs = s.rollingHighs.filter(h => h.ts > fiveDaysAgo);
      s.rollingLows = s.rollingLows.filter(l => l.ts > fiveDaysAgo);
      if (s.rollingHighs.length > 0) s.rollingHigh = Math.max(...s.rollingHighs.map(h => h.price));
      if (s.rollingLows.length > 0) s.rollingLow = Math.min(...s.rollingLows.map(l => l.price));
    }
  }

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

  // === ORDER BLOCK — 1-min candle builder + OB zone detection ===
  if (isXAU) {
    if (!s.obCurCandle) {
      s.obCurCandle = { o: price, h: price, l: price, c: price, startTs: Date.now(), ticks: 1 };
    } else {
      s.obCurCandle.h = Math.max(s.obCurCandle.h, price);
      s.obCurCandle.l = Math.min(s.obCurCandle.l, price);
      s.obCurCandle.c = price;
      s.obCurCandle.ticks++;
      // Close candle every 60 ticks (~1 min with 1s feed)
      if (s.obCurCandle.ticks >= 60) {
        const cc = { o: s.obCurCandle.o, h: s.obCurCandle.h, l: s.obCurCandle.l, c: s.obCurCandle.c, ts: s.obCurCandle.startTs };
        s.obCandles.push(cc);
        if (s.obCandles.length > 60) s.obCandles.shift(); // keep 60 candles (~1 hour)
        // Detect displacement + mark OB zones
        if (s.obCandles.length >= 3) {
          const prev = s.obCandles[s.obCandles.length - 2]; // candle before displacement
          const disp = cc; // just-closed candle (potential displacement)
          const candleRange = disp.h - disp.l;
          const atrNow = calcATR(s.highs, s.lows, s.prices, 14);
          const isDisplacement = atrNow > 0 && candleRange > atrNow * 2;
          if (isDisplacement) {
            const bullDisp = disp.c > disp.o; // bullish displacement (big green candle)
            const bearDisp = disp.c < disp.o; // bearish displacement (big red candle)
            // Bullish displacement → last bearish candle before it = demand zone (bullish OB)
            if (bullDisp && prev.c < prev.o) {
              s.orderBlocks.push({ type: 'bull', hi: prev.h, lo: prev.l, ts: prev.ts, mitigated: false });
              log(sym, '🟩 BULLISH OB formed: $' + prev.lo.toFixed(2) + ' - $' + prev.hi.toFixed(2) + ' (demand zone)');
            }
            // Bearish displacement → last bullish candle before it = supply zone (bearish OB)
            if (bearDisp && prev.c > prev.o) {
              s.orderBlocks.push({ type: 'bear', hi: prev.h, lo: prev.l, ts: prev.ts, mitigated: false });
              log(sym, '🟥 BEARISH OB formed: $' + prev.lo.toFixed(2) + ' - $' + prev.hi.toFixed(2) + ' (supply zone)');
            }
          }
        }
        // Mitigate OBs — if price passes through an OB zone completely, it's spent
        s.orderBlocks.forEach(ob => {
          if (!ob.mitigated) {
            if (ob.type === 'bull' && price < ob.lo) ob.mitigated = true; // demand broken
            if (ob.type === 'bear' && price > ob.hi) ob.mitigated = true; // supply broken
          }
        });
        // Prune — remove mitigated OBs and anything older than 4 hours
        const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
        s.orderBlocks = s.orderBlocks.filter(ob => !ob.mitigated && ob.ts > fourHoursAgo);
        // Start new candle
        s.obCurCandle = null;
      }
    }
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

  // Track RSI at session high — used by Session High Reversal Detector
  if (price >= s.sessionHigh) s.rsiAtSessionHigh = rsiV;
  // Track RSI at rolling ATH/ATL — used by ATH/ATL Reversal Detector
  if (isXAU) {
    if (s.rollingHigh > 0 && price >= s.rollingHigh * 0.999) { s.rsiAtRollingHigh = rsiV; s.athApproachTs = Date.now(); }
    if (s.rollingLow < Infinity && s.rollingLow > 0 && price <= s.rollingLow * 1.001) { s.rsiAtRollingLow = rsiV; s.atlApproachTs = Date.now(); }
  }

  const e5b = s.pE5 > s.pE13, e5bear = s.pE5 < s.pE13;
  const e13b = s.pE13 > s.pE34, e13bear = s.pE13 < s.pE34;

  // XAU: use DXY inverse correlation instead of VWAP | Equities: keep VWAP
  let abV = false, blV = false;
  let dxyBullGold = false, dxyBearGold = false;
  if (isXAU) {
    // DXY down (dollar weak) = bullish gold = CALL point
    // DXY up (dollar strong) = bearish gold = PUT point
    dxyBullGold = dxyDir === 'down' && dxyRoc3 < -0.01;
    dxyBearGold = dxyDir === 'up' && dxyRoc3 > 0.01;
    // Strong momentum override: if gold ROC-3 > 3x threshold, the move speaks for itself
    // DXY polls every 15s — too slow for fast gold spikes, auto-grant DXY point
    const goldRoc3 = calcROC(s.prices, 3);
    const rocStrong = Math.abs(goldRoc3) > XAU_ROC_THR * 3; // 3x base threshold = 0.075%
    if (rocStrong && !dxyBullGold && !dxyBearGold) {
      if (goldRoc3 > 0) dxyBullGold = true;  // Strong gold up = treat as DXY weak
      else dxyBearGold = true;                 // Strong gold down = treat as DXY strong
    }
    abV = dxyBullGold; blV = dxyBearGold;
  } else {
    const vwapPct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
    const vwapZone = 0.1;
    abV = vwapPct > vwapZone; blV = vwapPct < -vwapZone;
  }

  // ATR for XAU — used as volatility filter (block signals when market is dead)
  const atrVal = isXAU ? calcATR(s.highs, s.lows, s.prices, 14) : 0;
  const atrTooLow = isXAU && s.prices.length >= 30 && atrVal < 0.50; // $0.50 ATR = dead market

  // XAU session detection
  const etMin = gET();
  const xauSession = isXAU ? (etMin >= 480 && etMin < 960 ? 'london_ny' : etMin >= 180 && etMin < 480 ? 'london' : 'asia') : '';
  // Round-number gravity for XAU — gold stalls/reverses at $50 levels ($3300, $3350, $3400...)
  // Detect proximity to nearest $50 round number and store for signal filtering
  let roundNumDist = 99, nearestRound = 0, roundNumZone = false;
  if (isXAU && price > 0) {
    nearestRound = Math.round(price / 50) * 50;
    roundNumDist = Math.abs(price - nearestRound);
    roundNumZone = roundNumDist <= 3.0; // Within $3 of a $50 level
  }
  s._roundNum = isXAU ? { nearest: nearestRound, dist: roundNumDist, inZone: roundNumZone } : null;

  const macdHist = macdL - macdS;
  const macdAccel = typeof s.prevMacdHist === 'number' ? macdHist - s.prevMacdHist : 0;
  s.prevMacdHist = macdHist;
  const mBull = macdL > macdS && macdAccel >= 0, mBear = macdL < macdS && macdAccel <= 0;
  // RSI scoring: rBull/rBear for the 6-indicator SCORE (wider zone than the gate)
  // Scoring zone: QQQ/SPY 45-70, XAU 40-68 — matches bot pages exactly
  // Gate zone (rsiSweetCall/Put below): QQQ/SPY 45-65/30-55, XAU 40-68/28-58 — tighter
  const rsiScoreHi = isXAU ? 68 : 70;
  const rsiScoreLo = isXAU ? 40 : 45;
  const rBull = rsiV > rsiScoreLo && rsiV < rsiScoreHi;
  const rBear = rsiV < rsiScoreLo || rsiV > rsiScoreHi;
  // ATR-adaptive ROC threshold for XAU — scales with volatility
  // Base: 0.025%. High ATR (>$3) = raise to 0.035% (filter noise in volatile markets)
  // Low ATR (<$1) = lower to 0.018% (capture meaningful moves in quiet markets)
  let symRocThr = sym === 'XAU' ? XAU_ROC_THR : ROC_THR;
  if (isXAU && atrVal > 0) {
    if (atrVal >= 3.0) symRocThr = 0.035;       // High volatility — need bigger move
    else if (atrVal >= 1.5) symRocThr = 0.025;   // Normal — keep default
    else if (atrVal >= 0.50) symRocThr = 0.018;   // Low but active — lower bar
    // Below 0.50 = ATR filter blocks signals anyway
  }
  s._symRocThr = symRocThr; // Store for /prices endpoint
  const rocBull = roc3 > symRocThr, rocBear = roc3 < -symRocThr;

  // Score
  let cS = 0, pS = 0;
  if (e5b) cS++; if (e5bear) pS++;
  if (e13b) cS++; if (e13bear) pS++;
  if (abV) cS++; if (blV) pS++;
  if (rBull) cS++; if (rBear) pS++;
  if (mBull) cS++; if (mBear) pS++;
  if (rocBull) cS++; if (rocBear) pS++;
  if (s.crossAssetDir === 'call' && Date.now() - s.crossAssetTs < 300000) cS++;
  if (s.crossAssetDir === 'put' && Date.now() - s.crossAssetTs < 300000) pS++;

  // Store indicator state for /prices endpoint
  const dom = Math.max(cS, pS);
  s._ind = { e5b, e5bear, e13b, e13bear, abV, blV, mBull, mBear, rBull, rBear, rocBull, rocBear, dxyBullGold, dxyBearGold };
  s._rsi = rsiV;
  s._dom = dom;
  s._macdL = macdL;
  s._macdS = macdS;
  s._roc3 = roc3;
  s._vwap = isXAU ? 0 : vwap;
  s._dxy = isXAU ? { price: dxyPrice, dir: dxyDir, roc3: dxyRoc3 } : null;
  s._atr = atrVal;
  s._xauSession = xauSession;

  // Check exit for active trades
  checkExit(sym, price);

  const now2 = Date.now();
  const cool = now2 - s.lastNTs > COOLDOWN_MS;

  // === SIGNAL GATES ===
  // etMin already defined above (used by xauSession)
  // isXAU already defined above
  // XAU: full session 6PM-5PM ET (Sun-Fri) = nearly 23h, block 5PM-6PM ET (1020-1080 min)
  // Equities: 9:30 AM - 3:55 PM ET (570-955 min)
  if (isXAU) {
    if (etMin >= 1020 && etMin < 1080) return; // XAU closed 5-6 PM ET
  } else {
    if (etMin < 570 || etMin >= 955) return;
  }
  if (!isXAU && etMin >= 945 && (cS >= THR || pS >= THR)) return;

  // XAU ATR filter — block signals when market is dead (low volatility)
  if (atrTooLow && (cS >= THR || pS >= THR)) {
    log(sym, 'ATR filter: blocked — ATR $' + atrVal.toFixed(2) + ' < $0.50 (dead market)');
    return;
  }

  // Round-number gravity (XAU) — tighten threshold near $50 levels instead of hard block
  // These levels act as support/resistance; require stronger conviction to push through
  let roundNumPenalty = 0;
  if (isXAU && roundNumZone) {
    const approaching = (price < nearestRound && cS >= pS) || (price > nearestRound && pS >= cS);
    if (approaching) {
      roundNumPenalty = 1; // Require 6/6 instead of 5/6 near round numbers
      log(sym, 'Round-number caution: $' + roundNumDist.toFixed(2) + ' from $' + nearestRound + ' — threshold +1');
    }
  }

  // Chop override — require 5/6 + RSI sweet zone + ROC confirmation for all symbols
  // 3 conditions is stricter than normal mode but doesn't kill real breakouts
  const domT = cS >= pS ? 'call' : 'put';
  if (s.chopActive && (cS >= THR || pS >= THR)) {
    const chopScore = domT === 'call' ? cS : pS;
    const chopRsiOk = (domT === 'call' && rsiV >= RSI_CALL_LO[sym] && rsiV <= RSI_CALL_HI[sym]) || (domT === 'put' && rsiV >= RSI_PUT_LO[sym] && rsiV <= RSI_PUT_HI[sym]);
    const chopRocOk = (domT === 'call' && roc3 > symRocThr) || (domT === 'put' && roc3 < -symRocThr);
    if (!(chopScore >= THR && chopRsiOk && chopRocOk)) return;
  }

  // Dynamic threshold
  const refPrice = s.openPrice || 0;
  const dayMv = refPrice > 0 ? Math.abs(((price - refPrice) / refPrice) * 100) : 0;
  const tightMode = dayMv >= 1;
  const streakActive = now2 < s.lossStreakUntil;
  // XAU session-specific threshold: Asia = 6/6 (choppy, low volume), London/NY = 5/6 (cleaner trends)
  const sessionThr = isXAU && xauSession === 'asia' ? 6 : THR;
  let minS = (tightMode ? 6 : sessionThr) + (streakActive ? s.lossStreakBoost : 0) + roundNumPenalty;

  // XAU Asia session: HARD ROC gate — no signal without actual momentum
  // Asia is choppy and low volume, EMAs/MACD can drift into alignment without real moves
  // ROC-3 must confirm direction (even if score is 6/6 from boosts)
  if (isXAU && xauSession === 'asia' && (cS >= minS || pS >= minS)) {
    const asiaRocOk = (cS >= pS && roc3 > symRocThr) || (pS > cS && roc3 < -symRocThr);
    if (!asiaRocOk) {
      log(sym, 'Asia ROC gate: blocked — ROC-3 ' + roc3.toFixed(3) + '% too weak for ' + (cS >= pS ? 'CALL' : 'PUT') + ' (need >' + symRocThr + '%)');
      return;
    }
  }

  // Equities hard ROC gate — ROC-3 must confirm direction, kills flat-momentum noise
  if (!isXAU && (cS >= minS || pS >= minS)) {
    const eqRocOk = (cS >= pS && roc3 > EQ_ROC_GATE) || (pS > cS && roc3 < -EQ_ROC_GATE);
    if (!eqRocOk) {
      log(sym, 'Equity ROC gate: blocked — ROC-3 ' + roc3.toFixed(3) + '% too weak for ' + (cS >= pS ? 'CALL' : 'PUT') + ' (need >' + EQ_ROC_GATE + '%)');
      return;
    }
  }

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

  // PM penalty — equities only (XAU trades 24h, no PM concept)
  const pmPenalty = (!isXAU && etMin >= 780) ? 1 : 0;
  const finalMinS = minS + pmPenalty;
  if (pmPenalty && cS >= minS && cS < finalMinS) return;
  if (pmPenalty && pS >= minS && pS < finalMinS) return;

  // MACD alignment
  const macdAlignCall = macdL > macdS, macdAlignPut = macdL < macdS;
  if (!macdAlignCall && cS >= finalMinS && cS >= pS) return;
  if (!macdAlignPut && pS >= finalMinS && pS > cS) return;

  // MACD minimum strength — check both histogram AND line value
  // Histogram (macdL - macdS) measures momentum divergence
  // MACD line (macdL) measures actual trend strength — near-zero = no trend
  // XAU uses higher thresholds because price (~$3300) produces ~5x larger MACD values
  const macdStr = Math.abs(macdL - macdS);
  const macdMinStr = isXAU ? XAU_MACD_MIN : 0.020;
  const macdLineMin = isXAU ? XAU_MACD_LINE_MIN : 0.015;
  if (macdStr < macdMinStr && (cS >= finalMinS || pS >= finalMinS)) return;
  if (Math.abs(macdL) < macdLineMin && (cS >= finalMinS || pS >= finalMinS)) {
    log(sym, 'MACD line filter: blocked — |macdL| = ' + Math.abs(macdL).toFixed(3) + ' < ' + macdLineMin);
    return;
  }

  // MACD Exhaustion Filter — XAU only, block signals chasing an already-extended move
  // Check BOTH histogram (short-term momentum) AND line (trend depth)
  // Histogram deeply extended → immediate momentum spent
  // Line deeply extended → trend has been running too long, reversal likely
  if (isXAU) {
    const macdExhThr = 0.80;       // histogram exhaustion threshold
    const macdLineDepth = 1.00;    // line depth exhaustion threshold (e.g. -1.154 on bad PUT)
    // MACD LINE depth check — trend running too long
    if (Math.abs(macdL) > macdLineDepth) {
      if (macdL < -macdLineDepth && pS >= finalMinS && pS > cS) {
        log(sym, 'MACD line depth: PUT blocked — macdL ' + macdL.toFixed(3) + ' deeply bearish (trend exhausted)');
        return;
      }
      if (macdL > macdLineDepth && cS >= finalMinS && cS >= pS) {
        log(sym, 'MACD line depth: CALL blocked — macdL ' + macdL.toFixed(3) + ' deeply bullish (trend exhausted)');
        return;
      }
    }
    // MACD HISTOGRAM exhaustion — short-term momentum spent
    if (macdHist < -macdExhThr) {
      // Deeply bearish MACD → selling exhausted
      if (pS >= finalMinS && pS > cS) {
        log(sym, 'MACD exhaustion: PUT blocked — macdHist ' + macdHist.toFixed(3) + ' already deeply bearish (thr -' + macdExhThr + ')');
        return;
      }
      cS++; // Boost CALL — reversal likely
      log(sym, 'MACD exhaustion: CALL boosted +1 — macdHist ' + macdHist.toFixed(3) + ' deeply bearish = bounce setup');
    }
    if (macdHist > macdExhThr) {
      // Deeply bullish MACD → buying exhausted
      if (cS >= finalMinS && cS >= pS) {
        log(sym, 'MACD exhaustion: CALL blocked — macdHist ' + macdHist.toFixed(3) + ' already deeply bullish (thr +' + macdExhThr + ')');
        return;
      }
      pS++; // Boost PUT — reversal likely
      log(sym, 'MACD exhaustion: PUT boosted +1 — macdHist ' + macdHist.toFixed(3) + ' deeply bullish = pullback setup');
    }
  }

  // Order Block Zone Filter — soft +1/-1 based on proximity to OB zones
  // CALL near bullish OB (demand) = +1, CALL into bearish OB (supply overhead) = -1
  // PUT near bearish OB (supply) = +1, PUT into bullish OB (demand below) = -1
  if (isXAU && s.orderBlocks.length > 0) {
    let obBoost = 0;
    const obProximity = isXAU ? 5.0 : 1.0; // within $5 of OB zone for XAU
    for (const ob of s.orderBlocks) {
      const inZone = price >= ob.lo - obProximity && price <= ob.hi + obProximity;
      if (!inZone) continue;
      if (ob.type === 'bull') {
        // Price at bullish OB (demand zone) — good for CALL, bad for PUT
        if (cS >= pS) { obBoost = 1; log(sym, '🟩 OB boost: CALL +1 — at bullish demand $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2)); }
        else { obBoost = -1; log(sym, '🟩 OB penalty: PUT -1 — at bullish demand $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2)); }
      }
      if (ob.type === 'bear') {
        // Price at bearish OB (supply zone) — good for PUT, bad for CALL
        if (pS > cS) { obBoost = 1; log(sym, '🟥 OB boost: PUT +1 — at bearish supply $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2)); }
        else { obBoost = -1; log(sym, '🟥 OB penalty: CALL -1 — at bearish supply $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2)); }
      }
      break; // use closest/most recent OB only
    }
    if (obBoost > 0) { if (cS >= pS) cS++; else pS++; }
    if (obBoost < 0) { if (cS >= pS) cS--; else pS--; }
  }
  s._orderBlocks = isXAU ? s.orderBlocks.filter(ob => !ob.mitigated) : [];

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

  // Short-term trend direction filter (equities) — don't fire CALL if price is actively dropping, or PUT if rising
  // Uses ROC-10 (medium-term momentum) to confirm the signal direction matches actual price movement
  // XAU excluded — already has MACD exhaustion + shakeout recovery for this
  if (!isXAU && s.prices.length >= 12) {
    const roc10 = calcROC(s.prices, 10);
    // CALL but price trending down over last 10 ticks → block
    if (cS >= finalMinS && cS >= pS && roc10 < -0.02) {
      log(sym, 'Trend direction: CALL blocked — ROC-10 ' + roc10.toFixed(3) + '% (price dropping)');
      return;
    }
    // PUT but price trending up over last 10 ticks → block
    if (pS >= finalMinS && pS > cS && roc10 > 0.02) {
      log(sym, 'Trend direction: PUT blocked — ROC-10 +' + roc10.toFixed(3) + '% (price rising)');
      return;
    }
  }

  // Retrace filter — block dead-cat-bounce signals
  // If price dropped >$0.50 in last 30 ticks, require 50% retrace before CALL (and vice versa for PUT)
  if (s.prices.length >= 30) {
    const recent = s.prices.slice(-30);
    const recentHi = Math.max(...recent), recentLo = Math.min(...recent);
    const moveSize = recentHi - recentLo;
    const retraceMin = isXAU ? 5.0 : 0.50; // XAU ~$3300 needs $5 min move vs $0.50 for equities
    if (moveSize >= retraceMin) {
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

  // Price-distance deduplication — suppress same-direction signal if price hasn't moved enough since last signal
  // Prevents clustered signals at similar prices while allowing signals after real moves
  // XAU: 0.15% (~$7 at $4700). Equities: 0.25% (~$1.25 at $500) — tighter to prevent clustering
  { const cDir3 = cS >= pS ? 'call' : 'put';
    const minPctMove = isXAU ? 0.15 : 0.25;
    if (s.lastSameDir === cDir3 && s.lastSameDirPrice > 0) {
      const pctMove = Math.abs((price - s.lastSameDirPrice) / s.lastSameDirPrice) * 100;
      if (pctMove < minPctMove && ((cDir3 === 'call' && cS >= finalMinS) || (cDir3 === 'put' && pS >= finalMinS))) {
        log(sym, 'Price-distance filter: ' + cDir3.toUpperCase() + ' blocked — only ' + pctMove.toFixed(3) + '% from last ' + cDir3 + ' @ $' + s.lastSameDirPrice.toFixed(2) + ' (need ' + minPctMove + '%)');
        return;
      }
    }
  }

  // Post-move exhaustion filter — after a big move in one direction, require stronger MACD for same-direction signals
  // XAU: $20+ move / MACD > 0.20, Equities: $2+ move / MACD > 0.040
  if (s.openPrice && s.openPrice > 0) {
    const dayMove = price - s.openPrice;
    const absDayMove = Math.abs(dayMove);
    const postMoveThr = isXAU ? 20.0 : 2.0;
    const postMoveMacd = isXAU ? 0.20 : 0.040;
    if (absDayMove >= postMoveThr) {
      const macdStrNow = Math.abs(macdL - macdS);
      if (dayMove >= postMoveThr && cS >= finalMinS && cS >= pS && macdStrNow < postMoveMacd) {
        log(sym, 'Post-move exhaustion: CALL blocked — $' + dayMove.toFixed(2) + ' up move, MACD str ' + macdStrNow.toFixed(3) + ' < ' + postMoveMacd);
        return;
      }
      if (dayMove <= -postMoveThr && pS >= finalMinS && pS > cS && macdStrNow < postMoveMacd) {
        log(sym, 'Post-move exhaustion: PUT blocked — $' + Math.abs(dayMove).toFixed(2) + ' down move, MACD str ' + macdStrNow.toFixed(3) + ' < ' + postMoveMacd);
        return;
      }
    }
  }

  // Session High Reversal Detector — fire high-confidence PUT when price reverses from session high
  // Conditions: hit session high, reversed >$1 from it, RSI > 60 (was overbought), MACD turning bearish
  if (s.sessionHigh > -Infinity && s.openPrice && cool && s.dailySignalCount < MAX_SIG && etMin >= 570 && etMin < 955) {
    const distFromHigh = s.sessionHigh - price;
    const sessionRange = s.sessionHigh - s.sessionLow;
    const highWasRecent = s.prices.length >= 10 && Math.max(...s.prices.slice(-30 > -s.prices.length ? -30 : 0)) >= s.sessionHigh - 0.05;
    // XAU session high reversal needs larger move ($10+ vs $1+) — gold price is ~5x SPY/QQQ
    const hiRevDist = isXAU ? 10.0 : 1.0, hiRevRange = isXAU ? 15.0 : 1.5;
    if (distFromHigh >= hiRevDist && s.rsiAtSessionHigh > 60 && sessionRange >= hiRevRange && highWasRecent && macdL < macdS && roc3 < -symRocThr) {
      // Don't fire if we already fired a PUT recently (use cooldown)
      if (s.lastSignalDir !== 'put' || (now2 - s.lastNTs > COOLDOWN_MS)) {
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇HI', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        s.signals.push(sig);
        logSignal(sym, sig);
        log(sym, '🔻 SESSION HIGH REVERSAL PUT — $' + distFromHigh.toFixed(2) + ' off high $' + s.sessionHigh.toFixed(2) + ' RSI@high:' + s.rsiAtSessionHigh.toFixed(1) + ' RSInow:' + rsiV.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔻 ' + sym + ' HIGH REVERSAL PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromHigh.toFixed(2) + ' off high · RSI@high:' + s.rsiAtSessionHigh.toFixed(1), 'signal');
        s.trade = { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
        return; // Signal fired, don't continue to regular signal logic
      }
    }
  }

  // ===== ATH/ATL REVERSAL DETECTOR (XAU only) =====
  // Gold tends to reverse hard at multi-day highs/lows — institutional profit-taking, algo levels
  // Fires high-confidence reversal signals when price touches 5-day extreme then pulls back
  if (isXAU && s.rollingHigh > 0 && s.rollingLow < Infinity && cool && s.dailySignalCount < MAX_SIG) {
    const distFromATH = s.rollingHigh - price;
    const distFromATL = price - s.rollingLow;
    const athApproachRecent = now2 - s.athApproachTs < 600000; // touched ATH zone in last 10 min
    const atlApproachRecent = now2 - s.atlApproachTs < 600000;

    // ATH REVERSAL → PUT: price was near 5-day high, now pulling back $10+, RSI was overbought, MACD turning bearish
    if (athApproachRecent && distFromATH >= 10.0 && s.rsiAtRollingHigh > 62 && macdL < macdS && roc3 < -symRocThr) {
      if (s.lastSignalDir !== 'put' || (now2 - s.lastNTs > COOLDOWN_MS)) {
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇ATH', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🔻 ATH REVERSAL PUT — $' + distFromATH.toFixed(2) + ' off 5-day high $' + s.rollingHigh.toFixed(2) + ' RSI@ATH:' + s.rsiAtRollingHigh.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔻 ' + sym + ' ATH REVERSAL PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromATH.toFixed(2) + ' off ATH $' + s.rollingHigh.toFixed(2), 'signal');
        s.trade = { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        return;
      }
    }

    // ATL REVERSAL → CALL: price was near 5-day low, now bouncing $10+, RSI was oversold, MACD turning bullish
    if (atlApproachRecent && distFromATL >= 10.0 && s.rsiAtRollingLow < 38 && macdL > macdS && roc3 > symRocThr) {
      if (s.lastSignalDir !== 'call' || (now2 - s.lastNTs > COOLDOWN_MS)) {
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆ATL', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🚀 ATL REVERSAL CALL — $' + distFromATL.toFixed(2) + ' off 5-day low $' + s.rollingLow.toFixed(2) + ' RSI@ATL:' + s.rsiAtRollingLow.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' ATL REVERSAL CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromATL.toFixed(2) + ' off ATL $' + s.rollingLow.toFixed(2), 'signal');
        s.trade = { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        return;
      }
    }
  }

  const vixOk = vixV <= 0 || vixV < 35;  // treat unknown VIX as OK (don't block calls when VIX fetch fails)
  const fireCall = cS >= finalMinS && vixOk && rsiSweetCall && macdAlignCall;
  const firePut = pS >= finalMinS && rsiSweetPut && macdAlignPut;

  // === SHAKEOUT RECOVERY DETECTOR ===
  // If a signal got stopped out and price recovers past the original entry in the same direction,
  // fire a re-entry signal with reduced cooldown (bypasses 3-min cooldown).
  // This catches V-reversals / stop-hunt patterns common in XAU.
  // Window: 10 minutes after SL. Requires: score >= THR, RSI OK, MACD aligned, ROC confirming direction.
  if (isXAU && s.shakeoutDir && now2 - s.shakeoutTs < 600000 && now2 - s.shakeoutTs > 30000) {
    const shakeoutCool = now2 - s.lastNTs > 60000; // Reduced cooldown: 60s instead of 180s
    if (shakeoutCool && s.dailySignalCount < MAX_SIG) {
      const isCallRecovery = s.shakeoutDir === 'call' && price > s.shakeoutEp && fireCall && roc3 > symRocThr;
      const isPutRecovery = s.shakeoutDir === 'put' && price < s.shakeoutEp && firePut && roc3 < -symRocThr;
      if (isCallRecovery) {
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆REC', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🔄 SHAKEOUT RECOVERY CALL — price $' + price.toFixed(2) + ' recovered past entry $' + s.shakeoutEp.toFixed(2) + ' after SL @ $' + s.shakeoutPrice.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' RECOVERY CALL #' + s.dailySignalCount, '$' + sig.price + ' · Recovered from SL @ $' + s.shakeoutPrice.toFixed(2), 'signal');
        s.trade = { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        s.shakeoutDir = null; // Clear shakeout state
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
        return;
      }
      if (isPutRecovery) {
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇REC', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🔄 SHAKEOUT RECOVERY PUT — price $' + price.toFixed(2) + ' recovered past entry $' + s.shakeoutEp.toFixed(2) + ' after SL @ $' + s.shakeoutPrice.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' RECOVERY PUT #' + s.dailySignalCount, '$' + sig.price + ' · Recovered from SL @ $' + s.shakeoutPrice.toFixed(2), 'signal');
        s.trade = { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        s.shakeoutDir = null;
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
        return;
      }
    }
  }

  // === FIRE SIGNALS ===
  if (fireCall && cool) {
    s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
    if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
    s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
    s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
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
    s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
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
    // Track shakeout — store SL details for recovery detector
    s.shakeoutDir = t.type;        // 'call' or 'put' — the direction that got stopped
    s.shakeoutTs = now;            // when SL was hit
    s.shakeoutPrice = price;       // price at SL
    s.shakeoutEp = t.ep;           // original entry price
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
  } else if (fl >= 3 && cd && !t.sl && !t.rev) {
    t.rev = true; t.lastETs = now;
    log(sym, '⚠️ REVERSAL — ' + fl + '/4 flipped · ' + dm.toFixed(2) + '%');
    sendPush('⚠️ REVERSAL ' + sym, fl + '/4 indicators flipped — exit zone', 'exit');
  }
}

// ===== FINNHUB WEBSOCKET =====
let ws = null, wsReconnects = 0, wsBackoff = 5000;
const wsEvents = [];
function wsLog(msg) { wsEvents.push({ t: ts(), msg }); if (wsEvents.length > 50) wsEvents.shift(); }
let wsOpenedAt = 0, wsStableAt = 0, wsPingInterval = null, wsLastPong = 0;
let wsConnectedMs = 0, wsDisconnectedMs = 0, wsLastStateChange = Date.now();
let wsReconnectTs = 0; // Track last reconnect time for signal warmup
let wsLastCloseCode = 0, wsLastCloseReason = '', wsLastSessionDuration = 0; // Debug tracking

function wsUptime() {
  const total = wsConnectedMs + wsDisconnectedMs;
  return total > 0 ? ((wsConnectedMs / total) * 100).toFixed(1) + '%' : 'N/A';
}

function cleanupWS() {
  if (wsPingInterval) { clearInterval(wsPingInterval); wsPingInterval = null; }
  if (ws) {
    try { ws.removeAllListeners(); ws.terminate(); } catch (e) {}
    ws = null;
  }
}

function isMarketWindow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = now.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  // Pre-market 8:00 (480) to after-hours 18:00 (1080) — covers data availability
  return mins >= 480 && mins <= 1080;
}

function connectFinnhub() {
  // Don't connect outside market hours — saves Finnhub quota, avoids reconnect spam
  if (!isMarketWindow()) {
    const retryMs = 120000; // Check again in 2 minutes
    console.log('[' + ts() + '] Market closed — skipping WS connect, retry in 2m');
    wsLog('SKIP market closed');
    setTimeout(connectFinnhub, retryMs);
    return;
  }

  // Don't reconnect if we already have a live connection
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  // Clean up any zombie connection
  cleanupWS();

  try {
    ws = new WebSocket('wss://ws.finnhub.io?token=' + API, {
      perMessageDeflate: false,
      handshakeTimeout: 10000
    });
    wsOpenedAt = Date.now();

    ws.on('open', () => {
      const now = Date.now();
      // Track uptime
      wsDisconnectedMs += now - wsLastStateChange;
      wsLastStateChange = now;
      wsReconnectTs = now;
      wsLastPong = now;

      console.log('[' + ts() + '] Finnhub WS connected (attempt #' + wsReconnects + ', backoff was ' + wsBackoff + 'ms, uptime: ' + wsUptime() + ')');
      wsLog('OPEN attempt=#' + wsReconnects + ' backoff=' + wsBackoff + 'ms');

      // Reset backoff on successful connect — keep 5s minimum to respect Finnhub rate limits
      wsBackoff = 5000;

      // Subscribe with stagger — large data burst on QQQ+SPY can overwhelm connection
      try {
        ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOLS[0] }));
        console.log('[' + ts() + '] Subscribed to: ' + SYMBOLS[0]);
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN && SYMBOLS.length > 1) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOLS[1] }));
            console.log('[' + ts() + '] Subscribed to: ' + SYMBOLS[1]);
          }
        }, 3000);
      } catch (e) {
        console.error('[' + ts() + '] Subscribe error: ' + e.message);
      }

      // Start ping/pong heartbeat every 20s + Finnhub-level keepalive
      wsPingInterval = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // Check if we got a pong recently (within 45s)
        if (wsLastPong > 0 && Date.now() - wsLastPong > 45000) {
          console.log('[' + ts() + '] WS no pong in 45s — forcing reconnect');
          cleanupWS();
          wsBackoff = 5000;
          setTimeout(connectFinnhub, wsBackoff);
          return;
        }
        try {
          ws.ping();
          // Also send Finnhub-level subscribe as application-layer keepalive
          // This generates real WS data frames that proxies (Railway) recognize as activity
          ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOLS[0] }));
        } catch (e) {}
      }, 20000);
    });

    ws.on('pong', () => {
      wsLastPong = Date.now();
      // Connection has been stable for 60s+ — safe to reduce backoff and reset counter
      if (wsOpenedAt > 0 && Date.now() - wsOpenedAt > 60000) {
        if (wsBackoff > 5000) {
          wsBackoff = 5000;
          wsReconnects = 0;
        }
      }
    });

    ws.on('message', data => {
      wsLastPong = Date.now(); // Any message counts as alive
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

    ws.on('unexpected-response', (req, res) => {
      console.error('[' + ts() + '] WS upgrade rejected: HTTP ' + res.statusCode);
      wsLog('REJECTED HTTP ' + res.statusCode);
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        console.error('[' + ts() + '] Rejection body: ' + body.substring(0, 200));
        cleanupWS();
        // 429 = rate limited — wait 60s before retry
        const wait = res.statusCode === 429 ? 60000 : 10000;
        wsLog('Waiting ' + (wait/1000) + 's after ' + res.statusCode);
        setTimeout(connectFinnhub, wait);
      });
    });

    ws.on('error', (err) => {
      console.error('[' + ts() + '] WS error: ' + (err.message || err.code || 'unknown'));
      wsLog('ERROR: ' + (err.message || err.code || 'unknown'));
    });

    ws.on('close', (code, reason) => {
      const now = Date.now();
      const sessionDuration = wsOpenedAt > 0 ? ((now - wsOpenedAt) / 1000).toFixed(1) : '?';
      const reasonStr = reason ? reason.toString() : '';

      // Track uptime
      wsConnectedMs += now - wsLastStateChange;
      wsLastStateChange = now;

      // Clean up ping interval
      if (wsPingInterval) { clearInterval(wsPingInterval); wsPingInterval = null; }

      // Log close details — code tells us WHY
      console.log('[' + ts() + '] WS closed: code=' + code + ' reason="' + reasonStr + '" session=' + sessionDuration + 's reconnects=' + wsReconnects + ' uptime=' + wsUptime());
      wsLog('CLOSED code=' + code + ' reason="' + reasonStr + '" session=' + sessionDuration + 's');

      // Finnhub-specific close codes:
      // 1000 = normal, 1001 = going away, 1006 = abnormal (no close frame)
      // 1008 = policy violation (likely rate limit), 1011 = server error
      // 4000+ = custom Finnhub codes (usually auth/rate limit)

      wsReconnects++;
      wsOpenedAt = 0;
      wsLastCloseCode = code;
      wsLastCloseReason = reasonStr;
      wsLastSessionDuration = parseFloat(sessionDuration) || 0;

      // Backoff logic — minimum 5s to respect Finnhub rate limits
      const lasted = parseFloat(sessionDuration);
      if (lasted < 5) {
        // Quick death — increase backoff, but cap at 60s
        wsBackoff = Math.min(Math.max(wsBackoff * 2, 5000), 60000);
      } else if (lasted < 30) {
        wsBackoff = Math.min(Math.max(wsBackoff * 1.5, 5000), 60000);
      } else if (lasted >= 60) {
        // Connection was stable — reset to minimum
        wsBackoff = 5000;
      }

      console.log('[' + ts() + '] Reconnecting in ' + (wsBackoff / 1000).toFixed(1) + 's...');
      setTimeout(connectFinnhub, wsBackoff);
    });
  } catch (e) {
    console.error('[' + ts() + '] WS create error: ' + e.message);
    setTimeout(connectFinnhub, wsBackoff);
  }
}

// Process ticks — QQQ/SPY every 3s, XAU every 1s (MT5 feeds at 1s)
function processTicks(symbols) {
  symbols.forEach(sym => {
    try {
    const s = S[sym];
    if (s.tickBuf.length === 0) return;
    const price = s.tickBuf[s.tickBuf.length - 1].p;
    if (!price || isNaN(price) || price <= 0) { s.tickBuf = []; return; } // Guard bad data
    const hi = Math.max(...s.tickBuf.map(t => t.p));
    const lo = Math.min(...s.tickBuf.map(t => t.p));
    s.tickBuf = [];
    processPrice(sym, price, hi, lo);
    } catch (e) { console.error('[' + ts() + '] processTicks ' + sym + ' error:', e.message); }
  });
}
setInterval(() => processTicks(['QQQ', 'SPY']), 3000);
setInterval(() => processTicks(['XAU']), 1000);

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
setInterval(fetchVIX, 60000); // 60s instead of 30s — reduce API rate pressure

// Fetch DXY (US Dollar Index) every 15s — used for XAU inverse correlation
async function fetchDXY() {
  const symbols = ['TVC:DXY', 'DXY', 'UUP']; // UUP is dollar bull ETF as fallback
  for (const sym of symbols) {
    try {
      const res = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + API + '&_=' + Date.now());
      const data = await res.json();
      if (data && data.c > 0) {
        dxyPrice = data.c;
        dxyPrices.push(dxyPrice);
        if (dxyPrices.length > 100) dxyPrices.shift();
        // Calculate DXY EMAs and ROC
        dxyPrevEma5 = ema(dxyPrevEma5, dxyPrice, 5);
        dxyPrevEma13 = ema(dxyPrevEma13, dxyPrice, 13);
        if (dxyPrices.length >= 4) {
          dxyRoc3 = ((dxyPrices[dxyPrices.length - 1] - dxyPrices[dxyPrices.length - 4]) / dxyPrices[dxyPrices.length - 4]) * 100;
        }
        // DXY direction: EMA5 < EMA13 = dollar weakening = bullish gold
        if (dxyPrevEma5 !== null && dxyPrevEma13 !== null) {
          dxyDir = dxyPrevEma5 < dxyPrevEma13 ? 'down' : dxyPrevEma5 > dxyPrevEma13 ? 'up' : 'neutral';
        }
        return;
      }
    } catch (e) {}
  }
}
setInterval(fetchDXY, 15000);

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
      s.sessionHigh = -Infinity; s.sessionLow = Infinity; s.rsiAtSessionHigh = 50;
      // Rolling ATH/ATL: keep data (persists across days), just reset approach timestamps
      s.athApproachTs = 0; s.atlApproachTs = 0;
      s.gapDayMode = false; s.gapDirection = null;
      s.lastSameDir = null; s.lastSameDirMacd = 0; s.lastSameDirTs = 0; s.lastSameDirPrice = 0;
      s.shakeoutDir = null; s.shakeoutTs = 0; s.shakeoutPrice = 0; s.shakeoutEp = 0;
      s.obCandles = []; s.obCurCandle = null; s.orderBlocks = [];
      s.trade = { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
    });
    saveRollingLevels(); // Persist rolling ATH/ATL data across restarts
    // Reset WS uptime counters daily
    wsConnectedMs = 0; wsDisconnectedMs = 0; wsLastStateChange = Date.now();
    wsReconnects = 0;
  }
}, 30000);

// ===== API ROUTES =====

// Serve VAPID public key
app.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Subscribe endpoint — always upsert (handles Railway ephemeral filesystem)
app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  // Replace existing sub with same endpoint (keys may have rotated) or add new
  const idx = subscriptions.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    subscriptions[idx] = sub;
    console.log('[' + ts() + '] Push subscription updated (' + subscriptions.length + ' total)');
  } else {
    subscriptions.push(sub);
    console.log('[' + ts() + '] New push subscription (' + subscriptions.length + ' total)');
  }
  saveSubs();
  res.json({ ok: true, count: subscriptions.length });
});

// Unsubscribe
app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveSubs();
  res.json({ ok: true });
});

// Test push — send a test notification to all subscribers
app.get('/test-push', (req, res) => {
  if (subscriptions.length === 0) {
    return res.json({ ok: false, error: 'No subscribers registered. Open the PWA first to subscribe.', count: 0 });
  }
  sendPush('🔔 Test Notification', 'Push notifications are working! ' + subscriptions.length + ' subscriber(s).', 'test');
  console.log('[' + ts() + '] Test push sent to ' + subscriptions.length + ' subscriber(s)');
  res.json({ ok: true, count: subscriptions.length });
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

// ===== EXTERNAL PRICE FEED (MT5 → Railway) =====
// POST /feed — accepts price data from MT5 EA or any external source
// Body: { sym: "XAU", price: 3315.42, high: 3316.10, low: 3314.80 }
app.post('/feed', (req, res) => {
  const { sym, price, high, low } = req.body;
  if (!sym || !price) return res.status(400).json({ error: 'Missing sym or price' });
  if (!S[sym]) return res.status(400).json({ error: 'Unknown symbol: ' + sym });
  const p = parseFloat(price), h = parseFloat(high) || p, l = parseFloat(low) || p;
  if (isNaN(p) || p <= 0) return res.status(400).json({ error: 'Invalid price' });
  S[sym].lastPrice = p;
  S[sym].tickBuf.push({ p });
  res.json({ ok: true, sym, price: p, samples: S[sym].prices.length });
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
      trade: s.trade.active ? { active: true, type: s.trade.type, ep: s.trade.ep, t1: s.trade.t1, t2: s.trade.t2, sl: s.trade.sl, rev: s.trade.rev } : { active: false },
      dxy: s._dxy || null,
      atr: s._atr || 0,
      xauSession: s._xauSession || '',
      rollingHigh: s.rollingHigh || 0,
      rollingLow: s.rollingLow === Infinity ? 0 : s.rollingLow,
      roundNum: s._roundNum || null,
      orderBlocks: s._orderBlocks || []
    };
  });
  res.json({ vix: vixV, dxy: { price: dxyPrice, dir: dxyDir, roc3: dxyRoc3 }, wsConnected: ws && ws.readyState === 1, ts: Date.now(), symbols: data });
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
  const wsState = ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] : 'NULL';
  const sinceLastPong = wsLastPong > 0 ? ((Date.now() - wsLastPong) / 1000).toFixed(0) + 's' : 'never';
  const wsInfo = { state: wsState, reconnects: wsReconnects, backoff: wsBackoff, uptime: wsUptime(), lastPong: sinceLastPong, sessionAge: wsOpenedAt > 0 ? ((Date.now() - wsOpenedAt) / 1000).toFixed(0) + 's' : 'disconnected', lastClose: { code: wsLastCloseCode, reason: wsLastCloseReason, sessionSec: wsLastSessionDuration } };
  res.json({ running: ws && ws.readyState === 1, vix: vixV, subscribers: subscriptions.length, ws: wsInfo, symbols: status });
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

// Debug endpoint — recent WS events (wsEvents + wsLog defined near WS vars at top)
app.get('/debug', (req, res) => {
  res.json({ events: wsEvents, apiKey: API ? API.substring(0, 4) + '***' : 'NOT SET', nodeVersion: process.version });
});

// Health check
app.get('/', (req, res) => {
  res.send('0DTE Signal Server running. ' + subscriptions.length + ' subscribers. WS: ' + (ws && ws.readyState === 1 ? 'connected' : 'disconnected'));
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`[${ts()}] Signal server running on port ${PORT}`);
  console.log(`[${ts()}] FINNHUB_API_KEY: ${API ? API.substring(0, 4) + '...' + API.substring(API.length - 4) : 'NOT SET'}`);
  console.log(`[${ts()}] VAPID keys: ${process.env.VAPID_PUBLIC_KEY ? 'set' : 'NOT SET'}`);
  loadRollingLevels();
  connectFinnhub();
  fetchVIX();
  fetchDXY();
});
