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
const SYMBOLS = ['QQQ', 'SPY', 'XAU', 'BTC'];
const RSI_CALL_LO = { QQQ: 45, SPY: 45, XAU: 40, BTC: 42 };
const RSI_CALL_HI = { QQQ: 65, SPY: 65, XAU: 68, BTC: 66 }; // Gate range (rsiSweetCall) — tighter
const RSI_PUT_LO  = { QQQ: 30, SPY: 30, XAU: 28, BTC: 30 };
const RSI_PUT_HI  = { QQQ: 55, SPY: 55, XAU: 58, BTC: 56 };
const ROC_BLOWOFF = { QQQ: 0.15, SPY: 0.15, XAU: 0.20, BTC: 0.25 }; // BTC more volatile
const MAX_IND = { QQQ: 6, SPY: 6, XAU: 6, BTC: 6 };
const COOLDOWN_MS = 180000;
// FLIP_COOL_MS removed — was blocking legitimate reversal signals
const MAX_SIG = 10;
const THR = 6;
const ROC_THR = 0.018;
const EQ_ROC_GATE = 0.030; // Hard ROC gate for equities — ROC-3 must confirm direction
const XAU_ROC_THR = 0.025; // XAU needs wider ROC threshold — higher volatility
const XAU_MACD_MIN = 0.10; // XAU MACD values ~5x larger than QQQ/SPY (price ~$3300 vs $650)
const BTC_ROC_THR = 0.030; // BTC needs wider ROC threshold — most volatile asset
const BTC_MACD_MIN = 2.00; // BTC MACD values ~100x larger than QQQ/SPY (price ~$90000 vs $650)
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
    // Macro trend — 5-min snapshots for 6-hour rolling window (XAU only)
    // Sustained momentum tracking — overrides blowoff lock when trend is real
    sustainedDir: null,    // 'call' or 'put' — current sustained direction
    sustainedCount: 0,     // consecutive ticks with ROC above threshold in same direction
    sustainedTs: 0,        // when sustained streak started
    // V-Reversal detector (XAU only) — tracks recent price extremes for momentum reversal detection
    vrevSnaps: [],         // [{ts, p}] — price snapshots every 3s, last 20 min (max 400)
    vrevLastTs: 0,         // when last V-Rev signal fired (cooldown)
    macroSnaps: [],        // [{ts, p}] — every 5 min, max 72 entries = 6 hours
    macroLastSnapTs: 0,    // when last snapshot was taken
    macroEma: null,        // slow EMA on 5-min snapshots (period 36 = ~3 hours)
    macroPrevDir: null,    // 'bull' or 'bear' — last settled macro direction
    macroFlipTs: 0,        // when last macro flip signal fired (cooldown)
    superFlipTs: 0,        // when last super signal fired (cooldown)
    // Consolidation Breakout detector (XAU only) — fires on range escape, not lagging indicators
    breakRange: [],          // [{ts, hi, lo}] — 1-second snapshots for rolling 5-min window (max 300)
    breakHi: 0,              // current consolidation high
    breakLo: Infinity,       // current consolidation low
    breakCoilStart: 0,       // when consolidation started (range stayed tight)
    breakCoilActive: false,  // true when range < threshold for >= 3 min
    breakLastTs: 0,          // when last breakout signal fired (cooldown)
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

// ===== TLT STATE (Treasury bond proxy — inverse of yields, for XAU rate gate) =====
let tltPrice = 0, tltPrices = [], tltPrevEma5 = null, tltPrevEma13 = null;
let tltRoc3 = 0, tltDir = 'neutral'; // 'up' = yields falling = bullish gold, 'down' = yields rising = bearish gold
let tltPrevDir = 'neutral', tltFlipTs = 0; // Track TLT direction flips for super signal
const TLT_GATE_ROC = 0.030; // Hard gate: block XAU signal if TLT ROC-3 > 0.030% against signal direction

// ===== SLV STATE (Silver ETF — cross-metal confirmation for XAU) =====
let slvPrice = 0, slvPrices = [], slvPrevEma5 = null, slvPrevEma13 = null;
let slvRoc3 = 0, slvDir = 'neutral'; // 'up' = silver rising = confirms gold bull, 'down' = silver falling = confirms gold bear

// ===== GDX STATE (Gold Miners ETF — miners lead gold moves) =====
let gdxPrice = 0, gdxPrices = [], gdxPrevEma5 = null, gdxPrevEma13 = null;
let gdxRoc3 = 0, gdxDir = 'neutral'; // 'up' = miners rising = bullish gold, 'down' = miners falling = bearish gold

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
  const isBTC = sym === 'BTC';
  const isMT5 = isXAU || isBTC; // MT5-fed instruments (24h, no VWAP, no Finnhub WS)

  // XAU/BTC: set open on first price (MT5 feeds only when market is open)
  // Equities: set open at 9:30 AM ET (570 min)
  if (s.openPrice === null && (isMT5 || gET() >= 570)) {
    s.openPrice = price;
    if (s.prevClose !== null) {
      const gapPct = ((price - s.prevClose) / s.prevClose) * 100;
      if (Math.abs(gapPct) >= 2) { s.gapDayMode = true; s.gapDirection = gapPct > 0 ? 'up' : 'down'; log(sym, '🔥 GAP DAY: ' + gapPct.toFixed(2) + '% ' + s.gapDirection); }
    }
  }

  if (price > s.sessionHigh) s.sessionHigh = price;
  if (price < s.sessionLow) s.sessionLow = price;

  // Update rolling 5-day high/low for ATH/ATL detector
  if (isMT5 && price > 0) {
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
  if (isMT5) {
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
  const roc6 = isMT5 ? calcROC(s.prices, 6) : 0;   // medium-term momentum (MT5 instruments)
  const roc12 = isMT5 ? calcROC(s.prices, 12) : 0;  // longer-term momentum (MT5 instruments)

  // Track RSI at session high — used by Session High Reversal Detector
  if (price >= s.sessionHigh) s.rsiAtSessionHigh = rsiV;
  // Track RSI at rolling ATH/ATL — used by ATH/ATL Reversal Detector
  if (isMT5) {
    if (s.rollingHigh > 0 && price >= s.rollingHigh * 0.999) { s.rsiAtRollingHigh = rsiV; s.athApproachTs = Date.now(); }
    if (s.rollingLow < Infinity && s.rollingLow > 0 && price <= s.rollingLow * 1.001) { s.rsiAtRollingLow = rsiV; s.atlApproachTs = Date.now(); }
  }

  const e5b = s.pE5 > s.pE13, e5bear = s.pE5 < s.pE13;
  const e13b = s.pE13 > s.pE34, e13bear = s.pE13 < s.pE34;

  // XAU: use DXY inverse correlation instead of VWAP | BTC: use EMA34 as trend anchor | Equities: keep VWAP
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
  } else if (isBTC) {
    // BTC: no official VWAP, use price vs EMA34 as trend anchor (above = bullish, below = bearish)
    if (s.pE34 && s.prices.length >= 35) {
      const ema34Pct = ((price - s.pE34) / s.pE34) * 100;
      abV = ema34Pct > 0.05; blV = ema34Pct < -0.05;
    }
  } else {
    const vwapPct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
    const vwapZone = 0.1;
    abV = vwapPct > vwapZone; blV = vwapPct < -vwapZone;
  }

  // ATR for MT5 instruments — used as volatility filter (block signals when market is dead)
  const atrVal = isMT5 ? calcATR(s.highs, s.lows, s.prices, 14) : 0;
  const atrTooLow = isXAU && s.prices.length >= 30 && atrVal < 0.50; // XAU: $0.50 ATR = dead market
  const btcAtrTooLow = isBTC && s.prices.length >= 30 && atrVal < 10; // BTC: $10 ATR = dead market

  // Session detection
  const etMin = gET();
  const xauSession = isXAU ? (etMin >= 480 && etMin < 960 ? 'london_ny' : etMin >= 180 && etMin < 480 ? 'london' : 'asia') : '';
  const btcSession = isBTC ? (etMin >= 570 && etMin < 960 ? 'us' : etMin >= 480 && etMin < 570 ? 'pre_us' : etMin >= 60 && etMin < 480 ? 'europe_asia' : 'overnight') : '';
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
  const rsiScoreHi = isXAU ? 68 : isBTC ? 66 : 70;
  const rsiScoreLo = isXAU ? 40 : isBTC ? 42 : 45;
  const rBull = rsiV > rsiScoreLo && rsiV < rsiScoreHi;
  const rBear = rsiV < rsiScoreLo || rsiV > rsiScoreHi;
  // ATR-adaptive ROC threshold for XAU — scales with volatility
  // Base: 0.025%. High ATR (>$3) = raise to 0.035% (filter noise in volatile markets)
  // Low ATR (<$1) = lower to 0.018% (capture meaningful moves in quiet markets)
  let symRocThr = isBTC ? BTC_ROC_THR : sym === 'XAU' ? XAU_ROC_THR : ROC_THR;
  if (isXAU && atrVal > 0) {
    if (atrVal >= 3.0) symRocThr = 0.035;       // High volatility — need bigger move
    else if (atrVal >= 1.5) symRocThr = 0.025;   // Normal — keep default
    else if (atrVal >= 0.50) symRocThr = 0.018;   // Low but active — lower bar
    // Below 0.50 = ATR filter blocks signals anyway
  }
  if (isBTC && atrVal > 0) {
    if (atrVal >= 100) symRocThr = 0.045;       // BTC: high vol — need bigger move
    else if (atrVal >= 50) symRocThr = 0.030;    // Normal BTC vol
    else if (atrVal >= 10) symRocThr = 0.020;    // Quiet BTC market
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
  // Breakout state for /prices exposure
  if (isMT5) {
    const bRange = s.breakHi > 0 && s.breakLo < Infinity ? +(s.breakHi - s.breakLo).toFixed(2) : 0;
    const bCoilSec = s.breakCoilActive ? Math.round((Date.now() - s.breakCoilStart) / 1000) : 0;
    s._breakout = { range: bRange, hi: s.breakHi > 0 ? +s.breakHi.toFixed(2) : 0, lo: s.breakLo < Infinity ? +s.breakLo.toFixed(2) : 0, coiling: s.breakCoilActive, coilSec: bCoilSec };
  }
  s._roc6 = roc6;
  s._roc12 = roc12;
  s._vwap = isMT5 ? 0 : vwap;
  s._dxy = isXAU ? { price: dxyPrice, dir: dxyDir, roc3: dxyRoc3 } : null;
  s._tlt = isXAU ? { price: tltPrice, dir: tltDir, roc3: tltRoc3 } : null;
  s._slv = isXAU ? { price: slvPrice, dir: slvDir, roc3: slvRoc3 } : null;
  s._gdx = isXAU ? { price: gdxPrice, dir: gdxDir, roc3: gdxRoc3 } : null;
  s._btcSession = btcSession;
  s._atr = atrVal;
  s._xauSession = xauSession;

  // ===== PRICE STRUCTURE DETECTOR (XAU only) =====
  // Build 3-minute bars from vrevSnaps, detect higher-highs/higher-lows or lower-highs/lower-lows
  if (isXAU && s.vrevSnaps.length >= 30) {
    const now1 = Date.now();
    const recentSnaps = s.vrevSnaps.filter(sn => sn.ts > now1 - 900000); // last 15 min
    if (recentSnaps.length >= 20) {
      // Build 3-minute bars
      const barLen = 180000; // 3 min
      const barStart = recentSnaps[0].ts;
      const bars = [];
      let bIdx = 0;
      while (true) {
        const bS = barStart + bIdx * barLen;
        const bE = bS + barLen;
        if (bS > now1) break;
        const barSnaps = recentSnaps.filter(sn => sn.ts >= bS && sn.ts < bE);
        if (barSnaps.length >= 2) {
          bars.push({ h: Math.max(...barSnaps.map(sn => sn.p)), l: Math.min(...barSnaps.map(sn => sn.p)) });
        }
        bIdx++;
        if (bIdx > 10) break; // max 10 bars (~30 min)
      }
      if (bars.length >= 3) {
        // Check last 3-5 bars for structure
        const lb = bars.slice(-Math.min(bars.length, 5));
        let hh = 0, lh = 0, hl = 0, ll = 0;
        for (let i = 1; i < lb.length; i++) {
          if (lb[i].h > lb[i - 1].h) hh++; else if (lb[i].h < lb[i - 1].h) lh++;
          if (lb[i].l > lb[i - 1].l) hl++; else if (lb[i].l < lb[i - 1].l) ll++;
        }
        const pairs = lb.length - 1;
        // Bullish structure: majority of bars making HH + HL
        if (hh >= pairs * 0.6 && hl >= pairs * 0.6) s._priceStructure = 'bull';
        // Bearish structure: majority of bars making LH + LL
        else if (lh >= pairs * 0.6 && ll >= pairs * 0.6) s._priceStructure = 'bear';
        else s._priceStructure = 'neutral';
      } else { s._priceStructure = 'neutral'; }
    } else { s._priceStructure = 'neutral'; }
  } else if (isXAU) { s._priceStructure = 'neutral'; }

  // Check exit for active trades
  checkExit(sym, price);

  // ===== CONVICTION SCORE CALCULATOR (XAU only) =====
  // Returns { score: 0-7, label: 'HIGH'|'MOD'|'LOW', factors: [...] } for a given direction
  function convictionFor(dir) {
    if (!isXAU) return { score: 0, label: '', factors: [] };
    const isCall = dir === 'call';
    const factors = [];
    let sc = 0;
    // 1. DXY aligned (down = gold bull, up = gold bear)
    if ((isCall && dxyDir === 'down') || (!isCall && dxyDir === 'up')) { sc++; factors.push('DXY'); }
    // 2. TLT aligned (up = gold bull, down = gold bear)
    if ((isCall && tltDir === 'up') || (!isCall && tltDir === 'down')) { sc++; factors.push('TLT'); }
    // 3. Macro trend aligned
    const macroDir = s.macroEma ? (price > s.macroEma ? 'bull' : 'bear') : null;
    if ((isCall && macroDir === 'bull') || (!isCall && macroDir === 'bear')) { sc++; factors.push('MACRO'); }
    // 4. Silver aligned
    if (slvPrice > 0 && ((isCall && slvDir === 'up') || (!isCall && slvDir === 'down'))) { sc++; factors.push('SLV'); }
    // 5. Gold Miners aligned
    if (gdxPrice > 0 && ((isCall && gdxDir === 'up') || (!isCall && gdxDir === 'down'))) { sc++; factors.push('GDX'); }
    // 6. Multi-TF ROC aligned (all 3 pointing same way)
    const rocAllCall = roc3 > 0 && roc6 > 0 && roc12 > 0;
    const rocAllPut = roc3 < 0 && roc6 < 0 && roc12 < 0;
    if ((isCall && rocAllCall) || (!isCall && rocAllPut)) { sc++; factors.push('ROC×3'); }
    // 7. Price structure aligned
    if ((isCall && s._priceStructure === 'bull') || (!isCall && s._priceStructure === 'bear')) { sc++; factors.push('STRUCT'); }

    const label = sc >= 5 ? 'HIGH' : sc >= 3 ? 'MOD' : 'LOW';
    return { score: sc, label, factors };
  }
  // Enriches a signal object with conviction data (XAU only, no-op for QQQ/SPY)
  function enrichSig(sig) {
    if (!isXAU) return sig;
    const conv = convictionFor(sig.type);
    sig.conv = conv;
    return sig;
  }

  const now2 = Date.now();
  const cool = now2 - s.lastNTs > COOLDOWN_MS;

  // === SIGNAL GATES ===
  // XAU: full session 6PM-5PM ET (Sun-Fri) = nearly 23h, block 5PM-6PM ET (1020-1080 min)
  // BTC: 24/7, no block window (crypto never sleeps)
  // Equities: 9:30 AM - 3:55 PM ET (570-955 min)
  if (isXAU) {
    if (etMin >= 1020 && etMin < 1080) return; // XAU closed 5-6 PM ET
  } else if (isBTC) {
    // BTC trades 24/7 — no session block
  } else {
    if (etMin < 570 || etMin >= 955) return;
  }
  if (!isMT5 && etMin >= 945 && (cS >= THR || pS >= THR)) return;

  // ATR filter — block signals when market is dead (low volatility)
  if ((atrTooLow || btcAtrTooLow) && (cS >= THR || pS >= THR)) {
    log(sym, 'ATR filter: blocked — ATR $' + atrVal.toFixed(2) + ' (dead market)');
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
  if (!isMT5 && (cS >= minS || pS >= minS)) {
    const eqRocOk = (cS >= pS && roc3 > EQ_ROC_GATE) || (pS > cS && roc3 < -EQ_ROC_GATE);
    if (!eqRocOk) {
      log(sym, 'Equity ROC gate: blocked — ROC-3 ' + roc3.toFixed(3) + '% too weak for ' + (cS >= pS ? 'CALL' : 'PUT') + ' (need >' + EQ_ROC_GATE + '%)');
      return;
    }
  }

  // XAU TLT rate gate — interest rates must not be moving hard against signal
  // TLT up (yields falling) = bullish gold = supports CALL | TLT down (yields rising) = bearish gold = supports PUT
  // Only gate when TLT data is available and ROC is strong enough to matter
  if (isXAU && tltPrice > 0 && tltPrices.length >= 4 && (cS >= minS || pS >= minS)) {
    const sigDir = cS >= pS ? 'call' : 'put';
    // Block CALL if yields are spiking (TLT falling hard) | Block PUT if yields are crashing (TLT rising hard)
    const tltAgainst = (sigDir === 'call' && tltRoc3 < -TLT_GATE_ROC) || (sigDir === 'put' && tltRoc3 > TLT_GATE_ROC);
    if (tltAgainst) {
      // Strong gold momentum override — if gold ROC-3 > 3x threshold, rates can't keep up
      const goldRocStrong = Math.abs(roc3) > symRocThr * 3;
      if (!goldRocStrong) {
        log(sym, 'TLT rate gate: blocked ' + sigDir.toUpperCase() + ' — TLT ROC-3 ' + tltRoc3.toFixed(3) + '% (yields ' + (tltRoc3 < 0 ? 'rising' : 'falling') + ', need gold ROC >' + (symRocThr * 3).toFixed(3) + '% to override)');
        return;
      }
      log(sym, 'TLT rate gate: overridden by strong gold momentum — ROC-3 ' + roc3.toFixed(3) + '% > ' + (symRocThr * 3).toFixed(3) + '%');
    }
  }

  // Sustained momentum tracking — count consecutive ticks with ROC above threshold in same direction
  // A real trend keeps ROC elevated; a blowoff spikes once then ROC drops
  const curRocDir = roc3 > symRocThr ? 'call' : roc3 < -symRocThr ? 'put' : null;
  if (curRocDir && curRocDir === s.sustainedDir) {
    s.sustainedCount++;
  } else {
    s.sustainedDir = curRocDir;
    s.sustainedCount = curRocDir ? 1 : 0;
    s.sustainedTs = now2;
  }

  // Sustained momentum override flag — used by blowoff, RSI, and MACD exhaustion gates
  // If ROC has been directional for 10+ consecutive ticks, the move is real regardless of "exhaustion"
  const sustainedOverride = s.sustainedCount >= 10 && s.sustainedDir !== null;

  // Blowoff — with sustained momentum override
  const blowoffLock = now2 - s.blowoffTs < 300000;
  if (Math.abs(roc3) > ROC_BLOWOFF[sym] && !blowoffLock) { s.blowoffTs = now2; }
  if (blowoffLock && (cS >= minS || pS >= minS)) {
    // Sustained momentum override: if ROC has been directional for 15+ consecutive ticks
    // AND score meets threshold AND signal matches the sustained direction, let it through
    const sustainedOk = s.sustainedCount >= 15 && s.sustainedDir === (cS >= pS ? 'call' : 'put');
    if (sustainedOk) {
      log(sym, 'Blowoff override: sustained momentum — ' + s.sustainedCount + ' consecutive ' + s.sustainedDir.toUpperCase() + ' ticks, ROC ' + roc3.toFixed(3) + '%');
      // Reset blowoff to prevent rapid re-fire
      s.blowoffTs = now2;
    } else {
      return;
    }
  }

  // Flip lock
  if (now2 - s.lastReversalTs < 180000 && (cS >= minS || pS >= minS)) return;
  // Daily cap
  if (s.dailySignalCount >= MAX_SIG) return;
  // Direction-flip cooldown — REMOVED (was 480s, blocked reversal catches)

  // RSI sweet-spot — sustained momentum can override (move still going despite oversold/overbought)
  const rsiSweetCall = rsiV >= RSI_CALL_LO[sym] && rsiV <= RSI_CALL_HI[sym];
  const rsiSweetPut = rsiV >= RSI_PUT_LO[sym] && rsiV <= RSI_PUT_HI[sym];
  if (!rsiSweetCall && cS >= minS && cS >= pS) {
    if (sustainedOverride && s.sustainedDir === 'call') {
      log(sym, 'RSI gate override: sustained CALL momentum (' + s.sustainedCount + ' ticks) — RSI ' + rsiV.toFixed(1) + ' outside sweet zone');
    } else return;
  }
  if (!rsiSweetPut && pS >= minS && pS > cS) {
    if (sustainedOverride && s.sustainedDir === 'put') {
      log(sym, 'RSI gate override: sustained PUT momentum (' + s.sustainedCount + ' ticks) — RSI ' + rsiV.toFixed(1) + ' outside sweet zone');
    } else return;
  }

  // PM penalty removed — THR=6 is already strict enough (was +1 when THR=5)
  const finalMinS = minS;

  // MACD alignment
  const macdAlignCall = macdL > macdS, macdAlignPut = macdL < macdS;
  if (!macdAlignCall && cS >= finalMinS && cS >= pS) return;
  if (!macdAlignPut && pS >= finalMinS && pS > cS) return;

  // MACD minimum strength — check both histogram AND line value
  // Histogram (macdL - macdS) measures momentum divergence
  // MACD line (macdL) measures actual trend strength — near-zero = no trend
  // XAU uses higher thresholds because price (~$3300) produces ~5x larger MACD values
  const macdStr = Math.abs(macdL - macdS);
  const macdMinStr = isXAU ? XAU_MACD_MIN : isBTC ? BTC_MACD_MIN : 0.020;
  const macdLineMin = isXAU ? XAU_MACD_LINE_MIN : isBTC ? 1.50 : 0.015;
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
    // MACD LINE depth check — trend running too long (sustained momentum can override)
    if (Math.abs(macdL) > macdLineDepth) {
      if (macdL < -macdLineDepth && pS >= finalMinS && pS > cS) {
        if (sustainedOverride && s.sustainedDir === 'put') {
          log(sym, 'MACD depth override: sustained PUT (' + s.sustainedCount + ' ticks) — macdL ' + macdL.toFixed(3) + ' still dropping');
        } else {
          log(sym, 'MACD line depth: PUT blocked — macdL ' + macdL.toFixed(3) + ' deeply bearish (trend exhausted)');
          return;
        }
      }
      if (macdL > macdLineDepth && cS >= finalMinS && cS >= pS) {
        if (sustainedOverride && s.sustainedDir === 'call') {
          log(sym, 'MACD depth override: sustained CALL (' + s.sustainedCount + ' ticks) — macdL ' + macdL.toFixed(3) + ' still rising');
        } else {
          log(sym, 'MACD line depth: CALL blocked — macdL ' + macdL.toFixed(3) + ' deeply bullish (trend exhausted)');
          return;
        }
      }
    }
    // MACD HISTOGRAM exhaustion — short-term momentum spent (sustained momentum can override)
    if (macdHist < -macdExhThr) {
      if (pS >= finalMinS && pS > cS) {
        if (sustainedOverride && s.sustainedDir === 'put') {
          log(sym, 'MACD exhaustion override: sustained PUT (' + s.sustainedCount + ' ticks) — hist ' + macdHist.toFixed(3) + ' still selling');
        } else {
          log(sym, 'MACD exhaustion: PUT blocked — macdHist ' + macdHist.toFixed(3) + ' already deeply bearish (thr -' + macdExhThr + ')');
          return;
        }
      } else {
        cS++; // Boost CALL — reversal likely
        log(sym, 'MACD exhaustion: CALL boosted +1 — macdHist ' + macdHist.toFixed(3) + ' deeply bearish = bounce setup');
      }
    }
    if (macdHist > macdExhThr) {
      if (cS >= finalMinS && cS >= pS) {
        if (sustainedOverride && s.sustainedDir === 'call') {
          log(sym, 'MACD exhaustion override: sustained CALL (' + s.sustainedCount + ' ticks) — hist ' + macdHist.toFixed(3) + ' still buying');
        } else {
          log(sym, 'MACD exhaustion: CALL blocked — macdHist ' + macdHist.toFixed(3) + ' already deeply bullish (thr +' + macdExhThr + ')');
          return;
        }
      } else {
        pS++; // Boost PUT — reversal likely
        log(sym, 'MACD exhaustion: PUT boosted +1 — macdHist ' + macdHist.toFixed(3) + ' deeply bullish = pullback setup');
      }
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
  // Sustained momentum override: if move has been directional for 10+ ticks, RSI exhaustion is bypassed
  if (cS >= finalMinS && cS >= pS && rsiV > 65) {
    if (sustainedOverride && s.sustainedDir === 'call') {
      log(sym, 'RSI exhaustion override: sustained CALL (' + s.sustainedCount + ' ticks) — RSI ' + rsiV.toFixed(1) + ' overbought but move is real');
    } else {
      log(sym, 'RSI exhaustion: CALL blocked — RSI ' + rsiV.toFixed(1) + ' (overbought)'); return;
    }
  }
  if (pS >= finalMinS && pS > cS && rsiV < 35) {
    if (sustainedOverride && s.sustainedDir === 'put') {
      log(sym, 'RSI exhaustion override: sustained PUT (' + s.sustainedCount + ' ticks) — RSI ' + rsiV.toFixed(1) + ' oversold but move is real');
    } else {
      log(sym, 'RSI exhaustion: PUT blocked — RSI ' + rsiV.toFixed(1) + ' (oversold)'); return;
    }
  }

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
        enrichSig(sig); s.signals.push(sig);
        logSignal(sym, sig);
        log(sym, '🔻 SESSION HIGH REVERSAL PUT — $' + distFromHigh.toFixed(2) + ' off high $' + s.sessionHigh.toFixed(2) + ' RSI@high:' + s.rsiAtSessionHigh.toFixed(1) + ' RSInow:' + rsiV.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔻 ' + sym + ' HIGH REVERSAL PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromHigh.toFixed(2) + ' off high · RSI@high:' + s.rsiAtSessionHigh.toFixed(1), 'signal');
        s.trade = { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
        return; // Signal fired, don't continue to regular signal logic
      }
    }
  }

  // ===== CONSOLIDATION BREAKOUT DETECTOR (MT5 instruments: XAU + BTC) =====
  // Fires INSTANTLY when price escapes a tight range — no lagging indicator delay.
  // This is the fastest signal: catches moves 2-3 min before EMAs/RSI/MACD confirm.
  // The coil detection + breakout pending flag is set in processTicks (runs every 1s).
  // Here we just fire the signal if a valid breakout was detected this tick.
  if (isMT5 && s._pendingBreakout && s.dailySignalCount < MAX_SIG) {
    const bo = s._pendingBreakout;
    s._pendingBreakout = null; // consume it
    const cool2 = now2 - s.lastNTs > COOLDOWN_MS;
    const breakCool = now2 - s.breakLastTs > 300000; // 5-min cooldown

    if (cool2 && breakCool) {
      s.breakLastTs = now2;
      const dir = bo.dir;
      s.lastAT = dir; if (dir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
      if (s.lastSignalDir && s.lastSignalDir !== dir) s.lastReversalTs = now2;
      s.lastSignalDir = dir; s.lastSignalTs = now2; s.lastNTs = now2;
      s.lastSameDir = dir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
      const scoreTag = dir === 'call' ? '⬆BREAK' : '⬇BREAK';
      const sig = { type: dir, time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
      enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
      const coilMin = (bo.coilDuration / 60000).toFixed(1);
      const rangeStr = '$' + bo.coilLo.toFixed(2) + '-$' + bo.coilHi.toFixed(2);
      log(sym, '💥 BREAKOUT ' + dir.toUpperCase() + ' — coiled ' + coilMin + 'min in ' + rangeStr + ' · escaped $' + bo.escape.toFixed(2) + ' · accel ' + bo.accel.toFixed(1) + 'x [#' + s.dailySignalCount + ']');
      sendPush('💥 ' + sym + ' BREAKOUT ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · broke ' + (dir === 'call' ? 'above' : 'below') + ' ' + rangeStr + ' (' + coilMin + 'min coil)', 'signal');
      s.trade = { active: true, type: dir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
      return;
    } else {
      // Cooldown blocked — clear pending
      s._pendingBreakout = null;
    }
  }

  // ===== V-REVERSAL DETECTOR (XAU only) =====
  // Catches momentum reversals: price drops/rallies $8+ in 15 min, then ROC flips sharply
  // Different from trend-following signals — fires on the turn itself, not after EMAs catch up
  if (isXAU && s.vrevSnaps.length >= 60 && cool && s.dailySignalCount < MAX_SIG && (now2 - s.vrevLastTs > 600000)) {
    // Find the high and low in the last 15 min of snapshots
    const lookback = s.vrevSnaps.filter(sn => sn.ts > now2 - 900000); // 15 min
    if (lookback.length >= 30) {
      const lbHigh = Math.max(...lookback.map(sn => sn.p));
      const lbLow = Math.min(...lookback.map(sn => sn.p));
      const lbHighTs = lookback.find(sn => sn.p === lbHigh)?.ts || 0;
      const lbLowTs = lookback.find(sn => sn.p === lbLow)?.ts || 0;
      const range = lbHigh - lbLow;

      // V-REVERSAL CALL: price dropped to a low, then bounced back up
      // Low happened BEFORE current time, price has recovered significantly, ROC confirms upward
      const dropThenBounce = range >= 8.0 && lbLowTs < now2 - 60000 && (price - lbLow) >= range * 0.4 && lbLowTs > lbHighTs;
      // V-REVERSAL PUT: price rallied to a high, then dropped back down
      const rallyThenDrop = range >= 8.0 && lbHighTs < now2 - 60000 && (lbHigh - price) >= range * 0.4 && lbHighTs > lbLowTs;

      if (dropThenBounce && roc3 > symRocThr * 2 && rsiV > 35 && rsiV < 65) {
        // CALL reversal: was dropping, now bouncing with strong upward ROC
        s.vrevLastTs = now2;
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆VREV', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🔄 V-REVERSAL CALL — dropped $' + (lbHigh - lbLow).toFixed(2) + ' to $' + lbLow.toFixed(2) + ', bounced $' + (price - lbLow).toFixed(2) + ' · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' V-REVERSAL CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · bounced $' + (price - lbLow).toFixed(2) + ' off $' + lbLow.toFixed(2) + ' low', 'signal');
        s.trade = { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        return;
      }

      if (rallyThenDrop && roc3 < -symRocThr * 2 && rsiV > 35 && rsiV < 65) {
        // PUT reversal: was rallying, now dropping with strong downward ROC
        s.vrevLastTs = now2;
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇VREV', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🔄 V-REVERSAL PUT — rallied $' + (lbHigh - lbLow).toFixed(2) + ' to $' + lbHigh.toFixed(2) + ', dropped $' + (lbHigh - price).toFixed(2) + ' · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' V-REVERSAL PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · dropped $' + (lbHigh - price).toFixed(2) + ' off $' + lbHigh.toFixed(2) + ' high', 'signal');
        s.trade = { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        return;
      }
    }
  }

  // ===== MACRO TREND FLIP DETECTOR (XAU only) =====
  // Fires when price crosses the 3-hour EMA with momentum confirmation
  // SUPER SIGNAL: when TLT also flipped in same direction within 30 min — highest conviction
  // TLT up = yields falling = bullish gold | TLT down = yields rising = bearish gold
  if (isXAU && s.macroEma !== null && s.macroSnaps.length >= 12 && cool && s.dailySignalCount < MAX_SIG && (now2 - s.macroFlipTs > 900000)) {
    const curDir = price > s.macroEma ? 'bull' : 'bear';
    const spread = Math.abs(price - s.macroEma);
    const spreadPct = (spread / s.macroEma) * 100;
    // Only fire when direction actually flips AND price has meaningful separation from EMA (not just touching)
    if (s.macroPrevDir !== null && curDir !== s.macroPrevDir && spreadPct > 0.03) {
      // Check if TLT also flipped in aligned direction within last 30 min
      // CALL: macro bull + TLT up (yields falling) | PUT: macro bear + TLT down (yields rising)
      const tltAligned = (curDir === 'bull' && tltDir === 'up') || (curDir === 'bear' && tltDir === 'down');
      const tltRecentFlip = tltFlipTs > 0 && (now2 - tltFlipTs < 1800000); // TLT flipped within 30 min
      const isSuper = tltAligned && tltRecentFlip && (now2 - s.superFlipTs > 1800000); // 30-min super cooldown

      // MACRO FLIP CALL: was bearish, now price crossed above 3h EMA with upward ROC
      if (curDir === 'bull' && roc3 > symRocThr && rsiV > 30 && rsiV < 70) {
        s.macroFlipTs = now2;
        s.macroPrevDir = curDir;
        if (isSuper) s.superFlipTs = now2;
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const scoreTag = isSuper ? '⬆SUPER' : '⬆MFLIP';
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
        if (isSuper) {
          log(sym, '🔥 SUPER CALL — macro + TLT aligned bullish · price $' + price.toFixed(2) + ' > EMA $' + s.macroEma.toFixed(2) + ' · TLT ' + tltDir + ' (yields falling) · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
          sendPush('🔥 ' + sym + ' SUPER CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · macro + yields both turned bullish gold', 'signal');
        } else {
          log(sym, '🔀 MACRO FLIP CALL — trend turned bullish · price $' + price.toFixed(2) + ' > EMA $' + s.macroEma.toFixed(2) + ' (+' + spreadPct.toFixed(3) + '%) · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
          sendPush('🔀 ' + sym + ' MACRO FLIP CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · trend turned bullish · above 3h EMA', 'signal');
        }
        s.trade = { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        return;
      }
      // MACRO FLIP PUT: was bullish, now price crossed below 3h EMA with downward ROC
      if (curDir === 'bear' && roc3 < -symRocThr && rsiV > 30 && rsiV < 70) {
        s.macroFlipTs = now2;
        s.macroPrevDir = curDir;
        if (isSuper) s.superFlipTs = now2;
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const scoreTag = isSuper ? '⬇SUPER' : '⬇MFLIP';
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
        if (isSuper) {
          log(sym, '🔥 SUPER PUT — macro + TLT aligned bearish · price $' + price.toFixed(2) + ' < EMA $' + s.macroEma.toFixed(2) + ' · TLT ' + tltDir + ' (yields rising) · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
          sendPush('🔥 ' + sym + ' SUPER PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · macro + yields both turned bearish gold', 'signal');
        } else {
          log(sym, '🔀 MACRO FLIP PUT — trend turned bearish · price $' + price.toFixed(2) + ' < EMA $' + s.macroEma.toFixed(2) + ' (-' + spreadPct.toFixed(3) + '%) · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
          sendPush('🔀 ' + sym + ' MACRO FLIP PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · trend turned bearish · below 3h EMA', 'signal');
        }
        s.trade = { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        return;
      }
    }
    // Update prevDir even when no signal fires — track the current state
    if (s.macroPrevDir === null || (spreadPct > 0.05 && curDir !== s.macroPrevDir)) {
      s.macroPrevDir = curDir;
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
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
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
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🚀 ATL REVERSAL CALL — $' + distFromATL.toFixed(2) + ' off 5-day low $' + s.rollingLow.toFixed(2) + ' RSI@ATL:' + s.rsiAtRollingLow.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' ATL REVERSAL CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromATL.toFixed(2) + ' off ATL $' + s.rollingLow.toFixed(2), 'signal');
        s.trade = { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25 };
        return;
      }
    }
  }

  const vixOk = vixV <= 0 || vixV < 35;  // treat unknown VIX as OK (don't block calls when VIX fetch fails)
  // Sustained momentum allows RSI override in fire conditions
  const rsiOkCall = rsiSweetCall || (sustainedOverride && s.sustainedDir === 'call');
  const rsiOkPut = rsiSweetPut || (sustainedOverride && s.sustainedDir === 'put');
  const fireCall = cS >= finalMinS && vixOk && rsiOkCall && macdAlignCall;
  const firePut = pS >= finalMinS && rsiOkPut && macdAlignPut;

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
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
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
        enrichSig(sig); s.signals.push(sig); logSignal(sym, sig);
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
    enrichSig(sig); s.signals.push(sig);
    logSignal(sym, sig);
    const convLbl = sig.conv ? ' [' + sig.conv.label + ' ' + sig.conv.score + '/7]' : '';
    log(sym, '🚀 CALL ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + convLbl + ' [#' + s.dailySignalCount + ']');
    sendPush('🚀 ' + sym + ' CALL ' + sig.score + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc + (sig.conv ? ' · ' + sig.conv.label + ' ' + sig.conv.score + '/7' : ''), 'signal');
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
    enrichSig(sig); s.signals.push(sig);
    logSignal(sym, sig);
    const convLbl2 = sig.conv ? ' [' + sig.conv.label + ' ' + sig.conv.score + '/7]' : '';
    log(sym, '📉 PUT ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + convLbl2 + ' [#' + s.dailySignalCount + ']');
    sendPush('📉 ' + sym + ' PUT ' + sig.score + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc + (sig.conv ? ' · ' + sig.conv.label + ' ' + sig.conv.score + '/7' : ''), 'signal');
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

    // Macro trend snapshots — XAU only, every 5 min, 6-hour rolling window
    if (sym === 'XAU' && (Date.now() - s.macroLastSnapTs >= 300000)) {
      s.macroLastSnapTs = Date.now();
      s.macroSnaps.push({ ts: Date.now(), p: price });
      if (s.macroSnaps.length > 72) s.macroSnaps.shift(); // keep 6 hours
      // Slow EMA on snapshots (period 36 = ~3 hours of 5-min bars)
      const emaK = 2 / (36 + 1);
      s.macroEma = s.macroEma === null ? price : price * emaK + s.macroEma * (1 - emaK);
    }

    // V-Reversal snapshots — XAU only, every tick, keep 20 min (max 1200 at 1s interval)
    if (sym === 'XAU') {
      s.vrevSnaps.push({ ts: Date.now(), p: price });
      const cutoff = Date.now() - 1200000; // 20 min
      while (s.vrevSnaps.length > 0 && s.vrevSnaps[0].ts < cutoff) s.vrevSnaps.shift();
    }

    // Consolidation Breakout tracker — MT5 instruments (XAU + BTC), every tick
    // Tracks rolling 5-min high/low range. When range stays tight for 3+ min, marks "coiling".
    // Breakout fires the instant price escapes the range — no lagging indicator delay.
    // Thresholds scale per instrument:
    //   XAU (~$3300): coil < $4, escape $1
    //   BTC (~$90K):  coil < $120, escape $30
    const isBTCt = sym === 'BTC';
    const isXAUt = sym === 'XAU';
    if (isXAUt || isBTCt) {
      const coilMaxRange = isBTCt ? 120.0 : 4.0;   // max range to count as consolidation
      const escapeMin    = isBTCt ? 30.0  : 1.0;    // min distance beyond coil edge = confirmed breakout
      const bNow = Date.now();
      s.breakRange.push({ ts: bNow, p: price });
      // Trim to 5-min window
      const bCutoff = bNow - 300000;
      while (s.breakRange.length > 0 && s.breakRange[0].ts < bCutoff) s.breakRange.shift();

      if (s.breakRange.length >= 30) { // need at least 30s of data
        const bHi = Math.max(...s.breakRange.map(b => b.p));
        const bLo = Math.min(...s.breakRange.map(b => b.p));
        const bRange = bHi - bLo;
        s.breakHi = bHi;
        s.breakLo = bLo;

        // Coil detection: range < threshold = instrument is consolidating
        if (bRange < coilMaxRange) {
          if (!s.breakCoilActive) {
            s.breakCoilStart = bNow;
            s.breakCoilActive = true;
          }
        } else if (s.breakCoilActive) {
          // Range expanded — check if this is a breakout from a valid coil
          const coilDuration = bNow - s.breakCoilStart;
          const coilCoolOk = bNow - s.breakLastTs > 300000; // 5-min cooldown between breakouts

          // Valid coil: tight range held for at least 3 minutes
          if (coilDuration >= 180000 && coilCoolOk && s.dailySignalCount < MAX_SIG) {
            // Find the coil's range (the tight range before this expansion)
            const coilSnaps = s.breakRange.filter(b => b.ts < bNow - 5000); // exclude last 5s (the breakout itself)
            if (coilSnaps.length >= 20) {
              const coilHi = Math.max(...coilSnaps.map(b => b.p));
              const coilLo = Math.min(...coilSnaps.map(b => b.p));

              // Breakout direction: which side of the coil did price escape?
              const brokeUp = price > coilHi + escapeMin;
              const brokeDown = price < coilLo - escapeMin;

              if (brokeUp || brokeDown) {
                // Calculate velocity — how fast did price move in last 10 seconds vs average
                const last10 = s.breakRange.filter(b => b.ts > bNow - 10000);
                const last60 = s.breakRange.filter(b => b.ts > bNow - 60000 && b.ts <= bNow - 10000);
                if (last10.length >= 3 && last60.length >= 10) {
                  const vel10 = Math.abs(last10[last10.length - 1].p - last10[0].p) / (last10.length || 1);
                  const vel60 = Math.abs(last60[last60.length - 1].p - last60[0].p) / (last60.length || 1);
                  const accel = vel60 > 0 ? vel10 / vel60 : vel10 > 0 ? 10 : 0;

                  // Acceleration > 2x = price is accelerating out of the range (not a slow drift)
                  if (accel >= 2.0) {
                    s._pendingBreakout = {
                      dir: brokeUp ? 'call' : 'put',
                      coilHi: coilHi,
                      coilLo: coilLo,
                      coilDuration: coilDuration,
                      accel: accel,
                      escape: brokeUp ? +(price - coilHi).toFixed(2) : +(coilLo - price).toFixed(2)
                    };
                  }
                }
              }
            }
          }
          s.breakCoilActive = false; // Reset coil — range has expanded
        }
      }
    }

    } catch (e) { console.error('[' + ts() + '] processTicks ' + sym + ' error:', e.message); }
  });
}
setInterval(() => processTicks(['QQQ', 'SPY']), 3000);
setInterval(() => processTicks(['XAU', 'BTC']), 1000);

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

// Fetch TLT (20+ Year Treasury Bond ETF) every 15s — inverse proxy for interest rates
// TLT up = yields falling = bullish gold | TLT down = yields rising = bearish gold
async function fetchTLT() {
  const symbols = ['TLT', 'AMEX:TLT'];
  for (const sym of symbols) {
    try {
      const res = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + API + '&_=' + Date.now());
      const data = await res.json();
      if (data && data.c > 0) {
        tltPrice = data.c;
        tltPrices.push(tltPrice);
        if (tltPrices.length > 100) tltPrices.shift();
        // Calculate TLT EMAs and ROC
        tltPrevEma5 = ema(tltPrevEma5, tltPrice, 5);
        tltPrevEma13 = ema(tltPrevEma13, tltPrice, 13);
        if (tltPrices.length >= 4) {
          tltRoc3 = ((tltPrices[tltPrices.length - 1] - tltPrices[tltPrices.length - 4]) / tltPrices[tltPrices.length - 4]) * 100;
        }
        // TLT direction: EMA5 > EMA13 = bond prices rising = yields falling = bullish gold
        if (tltPrevEma5 !== null && tltPrevEma13 !== null) {
          const newDir = tltPrevEma5 > tltPrevEma13 ? 'up' : tltPrevEma5 < tltPrevEma13 ? 'down' : 'neutral';
          if (newDir !== 'neutral' && newDir !== tltPrevDir && tltPrevDir !== 'neutral') {
            tltFlipTs = Date.now();
            console.log('[' + ts() + '] TLT direction flipped: ' + tltPrevDir + ' → ' + newDir + ' (yields now ' + (newDir === 'up' ? 'falling' : 'rising') + ')');
          }
          tltPrevDir = newDir;
          tltDir = newDir;
        }
        return;
      }
    } catch (e) {}
  }
  console.log('[' + ts() + '] TLT fetch failed - all symbols returned 0');
}
setInterval(fetchTLT, 15000);

// Fetch SLV (Silver ETF) every 15s — cross-metal confirmation for gold
// Silver and gold are highly correlated; divergence = weaker signal, alignment = stronger
async function fetchSLV() {
  const symbols = ['SLV', 'AMEX:SLV'];
  for (const sym of symbols) {
    try {
      const res = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + API + '&_=' + Date.now());
      const data = await res.json();
      if (data && data.c > 0) {
        slvPrice = data.c;
        slvPrices.push(slvPrice);
        if (slvPrices.length > 100) slvPrices.shift();
        slvPrevEma5 = ema(slvPrevEma5, slvPrice, 5);
        slvPrevEma13 = ema(slvPrevEma13, slvPrice, 13);
        if (slvPrices.length >= 4) {
          slvRoc3 = ((slvPrices[slvPrices.length - 1] - slvPrices[slvPrices.length - 4]) / slvPrices[slvPrices.length - 4]) * 100;
        }
        if (slvPrevEma5 !== null && slvPrevEma13 !== null) {
          slvDir = slvPrevEma5 > slvPrevEma13 ? 'up' : slvPrevEma5 < slvPrevEma13 ? 'down' : 'neutral';
        }
        return;
      }
    } catch (e) {}
  }
}
setInterval(fetchSLV, 15000);

// Fetch GDX (Gold Miners ETF) every 15s — miners often lead gold moves
// GDX breaking down before gold = institutional selling, high-conviction PUT
// GDX rallying before gold = institutional accumulation, high-conviction CALL
async function fetchGDX() {
  const symbols = ['GDX', 'AMEX:GDX'];
  for (const sym of symbols) {
    try {
      const res = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + API + '&_=' + Date.now());
      const data = await res.json();
      if (data && data.c > 0) {
        gdxPrice = data.c;
        gdxPrices.push(gdxPrice);
        if (gdxPrices.length > 100) gdxPrices.shift();
        gdxPrevEma5 = ema(gdxPrevEma5, gdxPrice, 5);
        gdxPrevEma13 = ema(gdxPrevEma13, gdxPrice, 13);
        if (gdxPrices.length >= 4) {
          gdxRoc3 = ((gdxPrices[gdxPrices.length - 1] - gdxPrices[gdxPrices.length - 4]) / gdxPrices[gdxPrices.length - 4]) * 100;
        }
        if (gdxPrevEma5 !== null && gdxPrevEma13 !== null) {
          gdxDir = gdxPrevEma5 > gdxPrevEma13 ? 'up' : gdxPrevEma5 < gdxPrevEma13 ? 'down' : 'neutral';
        }
        return;
      }
    } catch (e) {}
  }
}
setInterval(fetchGDX, 15000);

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
      s.sustainedDir = null; s.sustainedCount = 0; s.sustainedTs = 0;
      s.vrevSnaps = []; s.vrevLastTs = 0;
      s.breakRange = []; s.breakHi = 0; s.breakLo = Infinity; s.breakCoilStart = 0; s.breakCoilActive = false; s.breakLastTs = 0; s._pendingBreakout = null;
      s.macroPrevDir = null; s.macroFlipTs = 0; s.superFlipTs = 0;
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
    // Reset global flip trackers
    tltFlipTs = 0; tltPrevDir = tltDir || 'neutral';
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
      pE5: s.pE5 || 0, pE13: s.pE13 || 0, pE34: s.pE34 || 0,
      macdL: s._macdL || 0,
      macdS: s._macdS || 0,
      roc3: s._roc3 || 0,
      roc6: s._roc6 || 0,
      roc12: s._roc12 || 0,
      vwap: s._vwap || 0,
      chopActive: s.chopActive,
      dailySignalCount: s.dailySignalCount,
      signals: s.signals.slice(-20),
      trade: s.trade.active ? { active: true, type: s.trade.type, ep: s.trade.ep, t1: s.trade.t1, t2: s.trade.t2, sl: s.trade.sl, rev: s.trade.rev } : { active: false },
      dxy: s._dxy || null,
      tlt: s._tlt || null,
      slv: s._slv || null,
      gdx: s._gdx || null,
      priceStructure: s._priceStructure || 'neutral',
      breakout: s._breakout || null,
      atr: s._atr || 0,
      xauSession: s._xauSession || '',
      btcSession: s._btcSession || '',
      rollingHigh: s.rollingHigh || 0,
      rollingLow: s.rollingLow === Infinity ? 0 : s.rollingLow,
      roundNum: s._roundNum || null,
      orderBlocks: s._orderBlocks || [],
      macro: sym === 'XAU' && s.macroSnaps.length >= 2 && s.lastPrice > 0 ? (() => {
        const p = s.lastPrice;
        return {
          snaps: s.macroSnaps.length,
          oldest: s.macroSnaps[0].p,
          hours: +((Date.now() - s.macroSnaps[0].ts) / 3600000).toFixed(1),
          ema: s.macroEma ? +s.macroEma.toFixed(2) : null,
          dir: p > (s.macroEma || p) ? 'bull' : 'bear',
          chg: +((p - s.macroSnaps[0].p)).toFixed(2),
          chgPct: +(((p - s.macroSnaps[0].p) / s.macroSnaps[0].p) * 100).toFixed(3),
          h1: s.macroSnaps.length >= 12 ? +((p - s.macroSnaps[Math.max(0, s.macroSnaps.length - 12)].p)).toFixed(2) : null,
          h2: s.macroSnaps.length >= 24 ? +((p - s.macroSnaps[Math.max(0, s.macroSnaps.length - 24)].p)).toFixed(2) : null,
          h4: s.macroSnaps.length >= 48 ? +((p - s.macroSnaps[Math.max(0, s.macroSnaps.length - 48)].p)).toFixed(2) : null
        };
      })() : null
    };
  });
  res.json({ vix: vixV, dxy: { price: dxyPrice, dir: dxyDir, roc3: dxyRoc3 }, tlt: { price: tltPrice, dir: tltDir, roc3: tltRoc3 }, slv: { price: slvPrice, dir: slvDir, roc3: slvRoc3 }, gdx: { price: gdxPrice, dir: gdxDir, roc3: gdxRoc3 }, wsConnected: ws && ws.readyState === 1, ts: Date.now(), symbols: data });
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
  fetchTLT();
  fetchSLV();
  fetchGDX();
});
