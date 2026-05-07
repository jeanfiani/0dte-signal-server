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

// Graceful shutdown — save persistent state before Railway kills the process
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received — saving state...');
  try { saveSignalHistory(); } catch (e) {}
  try { saveRollingLevels(); } catch (e) {}
  try { saveTrv2State(); } catch (e) {}
  process.exit(0);
});

// ===== PERSISTENT DATA DIRECTORY =====
// On Railway, attach a Volume and set DATA_DIR=/data so signal_history,
// subscriptions, rolling levels, TRv2 state and per-day CSVs survive redeploys.
// Locally / when DATA_DIR is unset, we fall back to __dirname (old behaviour).
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
console.log('[STARTUP] DATA_DIR:', DATA_DIR, DATA_DIR === __dirname ? '(ephemeral — set DATA_DIR env var to a Railway volume mount)' : '(persistent)');

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
const SYMBOLS = ['QQQ', 'SPY', 'XAU', 'BTC', 'NAS100'];
const RSI_CALL_LO = { QQQ: 45, SPY: 45, XAU: 40, BTC: 42, NAS100: 42 };
const RSI_CALL_HI = { QQQ: 65, SPY: 65, XAU: 68, BTC: 66, NAS100: 66 }; // Gate range (rsiSweetCall) — tighter
const RSI_PUT_LO  = { QQQ: 30, SPY: 30, XAU: 28, BTC: 30, NAS100: 30 };
const RSI_PUT_HI  = { QQQ: 55, SPY: 55, XAU: 58, BTC: 56, NAS100: 56 };
const ROC_BLOWOFF = { QQQ: 0.15, SPY: 0.15, XAU: 0.35, BTC: 0.25, NAS100: 0.20 }; // XAU raised from 0.20 — was catching real trends as blowoffs
const MAX_IND = { QQQ: 6, SPY: 6, XAU: 6, BTC: 6, NAS100: 6 };
const COOLDOWN_MS = 180000;
// FLIP_COOL_MS removed — was blocking legitimate reversal signals
// Minimum hold period after entry before a reversal warning can fire — prevents the popup
// from firing on the same tick as the entry signal because lastETs is still 0 then.
// 3 minutes — short enough to catch genuine fast reversals, long enough that the entry
// signal doesn't get killed before it has any chance to develop.
const REV_MIN_HOLD_MS = 180000;
const MAX_SIG = 10;
const THR = 6;
const ROC_THR = 0.018;
const EQ_ROC_GATE = 0.030; // Hard ROC gate for equities — ROC-3 must confirm direction
const XAU_ROC_THR = 0.025; // XAU needs wider ROC threshold — higher volatility
const XAU_MACD_MIN = 0.10; // XAU MACD values ~5x larger than QQQ/SPY (price ~$3300 vs $650)
const BTC_ROC_THR = 0.030; // BTC needs wider ROC threshold — most volatile asset
const BTC_MACD_MIN = 2.00; // BTC MACD values ~100x larger than QQQ/SPY (price ~$90000 vs $650)
const XAU_MACD_LINE_MIN = 0.08; // XAU MACD line minimum strength
const NAS_ROC_THR = 0.025; // NAS100 at ~20000 — similar volatility profile to XAU
const NAS_MACD_MIN = 1.00; // NAS100 MACD values ~30x larger than QQQ (price ~20000 vs ~$480)

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
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
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
    // Simple: one entry per day {high, low, date}. rollingHigh/Low computed from 5 daily entries + today's session.
    dailyLevels: [],     // [{high, low, date}] — last 5 completed days
    rollingHigh: 0,      // current 5-day high (max of dailyLevels highs + today's sessionHigh)
    rollingLow: Infinity, // current 5-day low (min of dailyLevels lows + today's sessionLow)
    rsiAtRollingHigh: 50, // RSI when rolling high was touched
    rsiAtRollingLow: 50,  // RSI when rolling low was touched
    athApproachTs: 0,   // when price last entered ATH zone
    athBreakLastTs: 0,  // when last ATH/ATL breakout signal fired
    athApproachPrice: 0, // price when ATH zone was touched
    atlApproachTs: 0,   // when price last entered ATL zone
    atlApproachPrice: 0, // price when ATL zone was touched
    lastAtlCallTs: 0,    // when last ATL CALL fired (for failed bounce guard)
    lastAtlCallPrice: 0, // price of last ATL CALL (if current price <= this, bounce failed)
    lastAthPutTs: 0,     // when last ATH PUT fired (for failed pullback guard)
    lastAthPutPrice: 0,  // price of last ATH PUT
    // Shakeout recovery — tracks SL events for re-entry detection
    shakeoutDir: null,     // direction that got stopped ('call' or 'put')
    shakeoutTs: 0,         // when SL was hit
    shakeoutPrice: 0,      // price at SL
    shakeoutEp: 0,         // original entry price
    // Session extreme reversal tracking — suppresses TRv2 entries at tops/bottoms
    lastHiRevTs: 0,        // when ⬇HI fired (PUT signal at session high)
    lastLoRevTs: 0,        // when ⬆LO fired (CALL signal at session low)
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
    // 5-minute candles for proper ATR calculation (MT5 instruments get 1 tick/sec, so tick-level hi/lo is useless)
    atrCandles: [],          // [{o, h, l, c, ts}] — completed 5-min candles (last 20)
    atrCurCandle: null,      // current building 5-min candle {o, h, l, c, startTs}
    // Consolidation Breakout detector (XAU only) — fires on range escape, not lagging indicators
    breakRange: [],          // [{ts, hi, lo}] — 1-second snapshots for rolling 5-min window (max 300)
    breakHi: 0,              // current consolidation high
    breakLo: Infinity,       // current consolidation low
    breakCoilStart: 0,       // when consolidation started (range stayed tight)
    breakCoilActive: false,  // true when range < threshold for >= 3 min
    breakFrozenHi: 0,       // locked coil high at moment coil started (doesn't drift with rolling window)
    breakFrozenLo: Infinity, // locked coil low at moment coil started
    breakLastTs: 0,          // when last breakout signal fired (cooldown)
    breakLastDir: null,      // direction of last breakout signal ('call'/'put')
    breakLastPrice: 0,       // entry price of last breakout signal
    // Fast-move detector — catches strong directional moves when MACD lags
    fastMoveLastTs: 0,       // when last fast-move signal fired (cooldown)
    sustainedMoveLastTs: 0,  // when last sustained-move signal fired (cooldown)
    trendRideLastTs: 0,      // when last trend-ride signal fired (cooldown)
    trendRideLastDir: null,   // last trend-ride direction ('call'/'put')
    trendRideSameDirCount: 0, // consecutive same-direction trend-ride signals
    trendRideLastPrice: 0,    // price at last trend-ride signal
    // Order Block (SMC) — institutional supply/demand zone from breakout coil
    obZone: null,            // { dir, hi, lo, mid, coilHi, coilLo, ts, breakPrice } — active OB after breakout
    obDeparted: false,       // price left the OB zone (must leave before retest counts)
    obFired: false,          // retest signal already fired (one per OB)
    obMitigated: false,      // OB was fully penetrated (breakout failed)
    // === TREND RIDE V2 (NAS100 only) — trend-following with averaged EMA ===
    // Replaces TREND + MFLIP for NAS100. XAU keeps the old system. BTC removed (0/6 -$872 in chop).
    trv2Candles: [],           // [{o, h, l, c, ts}] — completed 1-min candles (last 60)
    trv2CurCandle: null,       // current building candle {o, h, l, c, startTs, ticks}
    trv2Ema15: null,           // 15-minute EMA on 1-min closes
    trv2Ema20: null,           // 20-minute EMA on 1-min closes
    trv2Ema30: null,           // 30-minute EMA on 1-min closes
    trv2TrendEma: null,        // average of (ema15 + ema20 + ema30) / 3
    trv2Dir: null,             // current trend direction: 'long' or 'short' or null
    trv2DirTs: 0,              // when current direction was established
    trv2LastSignalTs: 0,       // cooldown: when last entry/reverse signal fired
    trv2Trade: null,           // active trade: { dir:'long'|'short', ep, ts, sl, tp1, tp2, tp3, tp1Hit, tp2Hit, tp3Hit, bestPrice, atr, trailSl }
    trv2CrossCount: 0,         // consecutive candle closes on wrong side of EMA (for exit confirmation)
    // Trade monitor
    trade: { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() }
  };
});
let vixV = 0;

// ===== ROLLING HIGH/LOW PERSISTENCE (ATH/ATL detector) =====
const ROLLING_FILE = path.join(DATA_DIR, 'rolling_levels.json');
function loadRollingLevels() {
  try {
    const data = JSON.parse(fs.readFileSync(ROLLING_FILE, 'utf8'));
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    SYMBOLS.forEach(sym => {
      if (!data[sym]) return;
      // New format: dailyLevels [{high, low, date}]
      if (data[sym].dailyLevels) {
        S[sym].dailyLevels = data[sym].dailyLevels.filter(d => new Date(d.date).getTime() > fiveDaysAgo);
        if (S[sym].dailyLevels.length > 0) {
          S[sym].rollingHigh = Math.max(...S[sym].dailyLevels.map(d => d.high));
          S[sym].rollingLow = Math.min(...S[sym].dailyLevels.map(d => d.low));
        }
      }
      // Migration: if old format (rollingHighs/rollingLows arrays), discard — will rebuild from today's session
    });
    console.log('[' + ts() + '] Rolling levels loaded — XAU: ' + S.XAU.dailyLevels.length + ' days, high:$' + (S.XAU.rollingHigh || 0).toFixed(2) + ' low:$' + (S.XAU.rollingLow === Infinity ? 0 : S.XAU.rollingLow).toFixed(2));
  } catch (e) {
    console.log('[' + ts() + '] Rolling levels: no data file (will build from scratch)');
  }
}
function saveRollingLevels() {
  const data = {};
  SYMBOLS.forEach(sym => {
    data[sym] = { dailyLevels: S[sym].dailyLevels || [] };
  });
  try { fs.writeFileSync(ROLLING_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}
// Save rolling levels every 5 minutes
setInterval(saveRollingLevels, 300000);

// ===== TRv2 STATE PERSISTENCE (survives server restarts / deploys) =====
const TRV2_FILE = path.join(DATA_DIR, 'trv2_state.json');
function loadTrv2State() {
  try {
    const data = JSON.parse(fs.readFileSync(TRV2_FILE, 'utf8'));
    ['NAS100'].forEach(sym => {
      if (data[sym] && S[sym]) {
        const d = data[sym];
        // Only restore if data is fresh (< 2 hours old)
        if (d.savedAt && Date.now() - d.savedAt < 7200000) {
          S[sym].trv2Candles = d.candles || [];
          S[sym].trv2Ema15 = d.ema15;
          S[sym].trv2Ema20 = d.ema20;
          S[sym].trv2Ema30 = d.ema30;
          S[sym].trv2TrendEma = d.trendEma;
          S[sym].trv2Dir = d.dir;
          S[sym].trv2DirTs = d.dirTs || 0;
          S[sym].trv2Trade = d.trade;
          S[sym].trv2CrossCount = d.crossCount || 0;
          S[sym].trv2LastSignalTs = d.lastSignalTs || 0;
          console.log('[' + ts() + '] TRv2 ' + sym + ' state restored — EMA:' + (d.trendEma ? '$' + d.trendEma.toFixed(2) : 'null') + ' dir:' + (d.dir || 'none') + ' trade:' + (d.trade ? d.trade.dir + ' @$' + d.trade.ep.toFixed(2) : 'none') + ' candles:' + (d.candles ? d.candles.length : 0));
        } else {
          console.log('[' + ts() + '] TRv2 ' + sym + ' state too old (' + ((Date.now() - (d.savedAt || 0)) / 3600000).toFixed(1) + 'h) — starting fresh');
        }
      }
    });
  } catch (e) { console.log('[' + ts() + '] No TRv2 state file — starting fresh'); }
}
function saveTrv2State() {
  const data = {};
  ['NAS100'].forEach(sym => {
    const s = S[sym];
    if (!s) return;
    data[sym] = {
      savedAt: Date.now(),
      candles: s.trv2Candles,
      ema15: s.trv2Ema15,
      ema20: s.trv2Ema20,
      ema30: s.trv2Ema30,
      trendEma: s.trv2TrendEma,
      dir: s.trv2Dir,
      dirTs: s.trv2DirTs,
      trade: s.trv2Trade,
      crossCount: s.trv2CrossCount,
      lastSignalTs: s.trv2LastSignalTs
    };
  });
  try { fs.writeFileSync(TRV2_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}
// Save TRv2 state every 60 seconds
setInterval(saveTrv2State, 60000);

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
const SIGNALS_DIR = path.join(DATA_DIR, 'signal_logs');
try { fs.mkdirSync(SIGNALS_DIR, { recursive: true }); } catch (e) {}

function todayDateET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

// ===== 7-DAY SIGNAL HISTORY (survives daily resets + redeploys) =====
const HISTORY_FILE = path.join(DATA_DIR, 'signal_history.json');
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let signalHistory = []; // [{date, time, ts, symbol, type, price, score, rsi, macd, roc, vix, chop, num, trv2}]

function loadSignalHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    signalHistory = (raw || []).filter(h => h.ts > cutoff);
    console.log('[' + ts() + '] Signal history loaded — ' + signalHistory.length + ' signals (last 7 days)');
    // Also restore per-symbol s.signals for today
    const today = todayDateET();
    SYMBOLS.forEach(sym => {
      const todaySignals = signalHistory.filter(h => h.date === today && h.symbol === sym);
      if (todaySignals.length > 0) {
        S[sym].signals = todaySignals.map(h => ({
          type: h.type, time: h.time, price: h.price, score: h.score,
          rsi: h.rsi, macd: h.macd, roc: h.roc, num: h.num, conv: h.conv || null
        }));
        S[sym].dailySignalCount = todaySignals.length;
        console.log('[' + ts() + '] ' + sym + ' — restored ' + todaySignals.length + ' signals for today');
      }
    });
  } catch (e) { console.log('[' + ts() + '] No signal history file — starting fresh'); }
}

function saveSignalHistory() {
  try {
    // Prune entries older than 7 days before saving
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    signalHistory = signalHistory.filter(h => h.ts > cutoff);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(signalHistory));
  } catch (e) { console.error('[' + ts() + '] Failed to save signal history:', e.message); }
}

// Save signal history every 5 minutes
setInterval(saveSignalHistory, 300000);

// ===== DAILY CSV BACKUP =====
// Posts the previous day's CSV to BACKUP_WEBHOOK_URL so we have an off-server copy
// even if the Railway volume is wiped. Auto-detects Discord webhook URLs and sends
// the CSV as a multipart file attachment; otherwise sends a JSON POST with
// { date, filename, totalSignals, csv } so any generic catcher (Pipedream, n8n,
// Cloudflare Worker, your own endpoint) can store it.
const BACKUP_URL = process.env.BACKUP_WEBHOOK_URL || '';
let lastBackupDate = '';

function postDiscordCsv(url, filename, csv) {
  return new Promise((resolve, reject) => {
    try {
      const httpsLib = require('https');
      const u = new URL(url);
      const boundary = '----signalbackup' + Date.now();
      const payloadJson = JSON.stringify({ content: '📊 Daily signal backup — ' + filename });
      const parts = [];
      parts.push(Buffer.from('--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="payload_json"\r\n' +
        'Content-Type: application/json\r\n\r\n' +
        payloadJson + '\r\n'));
      parts.push(Buffer.from('--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="files[0]"; filename="' + filename + '"\r\n' +
        'Content-Type: text/csv\r\n\r\n'));
      parts.push(Buffer.from(csv));
      parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
      const body = Buffer.concat(parts);
      const req = httpsLib.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
      }, (res) => {
        let resp = '';
        res.on('data', (c) => resp += c);
        res.on('end', () => res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error('HTTP ' + res.statusCode + ' ' + resp.slice(0, 200))));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

function postJsonCsv(url, filename, csv, totalSignals, dateStr) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const httpsLib = u.protocol === 'http:' ? require('http') : require('https');
      const body = JSON.stringify({ date: dateStr, filename, totalSignals, csv });
      const req = httpsLib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let resp = '';
        res.on('data', (c) => resp += c);
        res.on('end', () => res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error('HTTP ' + res.statusCode + ' ' + resp.slice(0, 200))));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

async function backupCsvForDate(dateStr) {
  if (!BACKUP_URL) return { ok: false, reason: 'BACKUP_WEBHOOK_URL not set' };
  const file = path.join(SIGNALS_DIR, dateStr + '.csv');
  if (!fs.existsSync(file)) return { ok: false, reason: 'no CSV for ' + dateStr };
  let csv;
  try { csv = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: 'read failed: ' + e.message }; }
  const lineCount = csv.split('\n').filter(Boolean).length;
  const totalSignals = Math.max(0, lineCount - 1); // minus header
  const filename = 'signals_' + dateStr + '.csv';
  const isDiscord = /discord(app)?\.com\/api\/webhooks\//.test(BACKUP_URL);
  try {
    const status = isDiscord
      ? await postDiscordCsv(BACKUP_URL, filename, csv)
      : await postJsonCsv(BACKUP_URL, filename, csv, totalSignals, dateStr);
    console.log('[' + ts() + '] Backup OK — ' + filename + ' (' + totalSignals + ' signals) → HTTP ' + status);
    return { ok: true, status, totalSignals, filename };
  } catch (e) {
    console.error('[' + ts() + '] Backup FAILED — ' + filename + ': ' + e.message);
    return { ok: false, reason: e.message };
  }
}

// Daily check: at 00:05 ET, back up yesterday's CSV (once per day, idempotent via lastBackupDate)
setInterval(() => {
  if (!BACKUP_URL) return;
  const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const minOfDay = nowEt.getHours() * 60 + nowEt.getMinutes();
  if (minOfDay < 5) return; // wait until 00:05 ET so the daily CSV is settled
  const today = todayDateET();
  if (lastBackupDate === today) return; // already ran today
  // Compute yesterday in ET
  const y = new Date(nowEt.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = y.toISOString().slice(0, 10);
  lastBackupDate = today;
  backupCsvForDate(yesterday);
}, 60000); // check once a minute

function logSignal(sym, sig) {
  const dateStr = todayDateET();
  // CSV log (legacy)
  const file = path.join(SIGNALS_DIR, dateStr + '.csv');
  const exists = fs.existsSync(file);
  // Conviction columns added 2026-05-07 — convScore (1-5), convLabel (HIGH/MED/LOW),
  // convFactors (pipe-separated list of factor names). All blank if engine didn't compute.
  const header = 'date,time,symbol,type,price,score,rsi,macd,roc,vix,chop,dailyNum,convScore,convLabel,convFactors\n';
  const convScore = sig.conv && sig.conv.score != null ? sig.conv.score : '';
  const convLabel = sig.conv && sig.conv.label ? sig.conv.label : '';
  // Wrap factors in quotes because the field uses commas-as-separators internally would break CSV;
  // we use pipe (|) inside the field, but quote the cell anyway to be explicit/safe.
  const convFactors = sig.conv && Array.isArray(sig.conv.factors)
    ? '"' + sig.conv.factors.join('|') + '"'
    : '';
  const row = [
    dateStr, sig.time, sym, sig.type, sig.price, sig.score,
    sig.rsi, sig.macd, sig.roc, vixV.toFixed(1),
    S[sym].chopActive ? 1 : 0, sig.num,
    convScore, convLabel, convFactors
  ].join(',') + '\n';
  if (!exists) fs.writeFileSync(file, header + row);
  else fs.appendFileSync(file, row);

  // JSON history (7-day persistent store)
  const histEntry = {
    date: dateStr,
    time: sig.time,
    ts: Date.now(),
    symbol: sym,
    type: sig.type,
    price: sig.price,
    score: sig.score,
    rsi: sig.rsi,
    macd: sig.macd,
    roc: sig.roc,
    vix: vixV.toFixed(1),
    chop: S[sym].chopActive ? 1 : 0,
    num: sig.num,
    conv: sig.conv || null
  };
  // Add TRv2 trade context if active (BTC/NAS100)
  if (S[sym].trv2Trade) {
    histEntry.trv2 = {
      dir: S[sym].trv2Trade.dir,
      ep: S[sym].trv2Trade.ep,
      sl: +S[sym].trv2Trade.sl.toFixed(2),
      tp1: +S[sym].trv2Trade.tp1.toFixed(2),
      tp2: +S[sym].trv2Trade.tp2.toFixed(2),
      tp3: +S[sym].trv2Trade.tp3.toFixed(2),
      atr: S[sym].trv2Trade.atr ? +S[sym].trv2Trade.atr.toFixed(2) : null
    };
  }
  signalHistory.push(histEntry);
}

// ===== PROCESS PRICE (same engine as mobile/desktop) =====
function processPrice(sym, price, hi, lo) {
  const s = S[sym];
  const mi = MAX_IND[sym];
  const isXAU = sym === 'XAU';
  const isBTC = sym === 'BTC';
  const isNAS = sym === 'NAS100';
  const isMT5 = isXAU || isBTC || isNAS; // MT5-fed instruments (extended hours, no VWAP, no Finnhub WS)

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
  // Simple approach: rollingHigh = max(past 5 daily highs, today's sessionHigh)
  // rollingLow = min(past 5 daily lows, today's sessionLow)
  // Daily levels are saved at daily reset time.
  if (isMT5 && price > 0) {
    // Seed from current price if unset
    if (s.rollingHigh === 0) s.rollingHigh = price;
    if (s.rollingLow === Infinity || s.rollingLow === 0) s.rollingLow = price;
    // Update from today's session extremes + current price (real-time, every tick)
    if (price > s.rollingHigh) s.rollingHigh = price;
    if (price < s.rollingLow) s.rollingLow = price;
    if (s.sessionHigh > -Infinity && s.sessionHigh > s.rollingHigh) s.rollingHigh = s.sessionHigh;
    if (s.sessionLow < Infinity && s.sessionLow < s.rollingLow) s.rollingLow = s.sessionLow;
  }

  s.prices.push(price); s.highs.push(hi || price); s.lows.push(lo || price);
  // MT5 needs 720+ entries for 12-min ROC (1 tick/sec), equities need 200
  const maxPrices = isMT5 ? 800 : 200;
  if (s.prices.length > maxPrices) { s.prices.shift(); s.highs.shift(); s.lows.shift(); }

  // Chop detector
  s.chopShort.push(price); if (s.chopShort.length > 30) s.chopShort.shift();
  s.chopLong.push(price); if (s.chopLong.length > 150) s.chopLong.shift();
  if (s.chopShort.length >= 10) {
    const effS = calcEfficiency(s.chopShort);
    const effL = s.chopLong.length >= 30 ? calcEfficiency(s.chopLong) : 1;
    const thrS = 0.30, thrL = 0.35, resS = 0.35, resL = 0.40;
    const isChoppy = effS < thrS || effL < thrL;
    const isTrending = effS > resS && effL > resL;
    if (!s.chopActive) { if (isChoppy) { s.chopCount++; s.trendCount = 0; } else s.chopCount = 0; if (s.chopCount >= 3) { s.chopActive = true; s.chopCount = 0; log(sym, '🌊 CHOP MODE'); sendPush('🌊 ' + sym + ' CHOP MODE', 'Efficiency low — 6/6 only'); } }
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
          let atrNow = 0;
          if (s.atrCandles && s.atrCandles.length >= 3) {
            const acOb = s.atrCandles, pOb = Math.min(14, acOb.length);
            let aSum = 0;
            for (let ai = acOb.length - pOb; ai < acOb.length; ai++) { aSum += Math.max(acOb[ai].h - acOb[ai].l, ai > 0 ? Math.abs(acOb[ai].h - acOb[ai-1].c) : acOb[ai].h - acOb[ai].l, ai > 0 ? Math.abs(acOb[ai].l - acOb[ai-1].c) : acOb[ai].h - acOb[ai].l); }
            atrNow = aSum / pOb;
          } else { atrNow = calcATR(s.highs, s.lows, s.prices, 14); }
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

  // === TREND RIDE V2 — 1-min candle builder + 15/20/30 EMA (NAS100 only) ===
  // Removed from BTC: TRv2 went 0/6 -$872 on 5/6 in chop, chop detector overfires,
  // and BTC's volatile micro-structure doesn't suit the averaged-EMA trend approach.
  if (isNAS) {
    if (!s.trv2CurCandle) {
      s.trv2CurCandle = { o: price, h: price, l: price, c: price, startTs: Date.now(), ticks: 1 };
    } else {
      s.trv2CurCandle.h = Math.max(s.trv2CurCandle.h, price);
      s.trv2CurCandle.l = Math.min(s.trv2CurCandle.l, price);
      s.trv2CurCandle.c = price;
      s.trv2CurCandle.ticks++;
      if (s.trv2CurCandle.ticks >= 60) {
        const cc = { o: s.trv2CurCandle.o, h: s.trv2CurCandle.h, l: s.trv2CurCandle.l, c: s.trv2CurCandle.c, ts: s.trv2CurCandle.startTs };
        s.trv2Candles.push(cc);
        if (s.trv2Candles.length > 60) s.trv2Candles.shift();
        const cp = cc.c;
        const k15 = 2 / (15 + 1);
        const k20 = 2 / (20 + 1);
        const k30 = 2 / (30 + 1);
        s.trv2Ema15 = s.trv2Ema15 === null ? cp : cp * k15 + s.trv2Ema15 * (1 - k15);
        s.trv2Ema20 = s.trv2Ema20 === null ? cp : cp * k20 + s.trv2Ema20 * (1 - k20);
        s.trv2Ema30 = s.trv2Ema30 === null ? cp : cp * k30 + s.trv2Ema30 * (1 - k30);
        s.trv2TrendEma = (s.trv2Ema15 + s.trv2Ema20 + s.trv2Ema30) / 3;
        // Track consecutive candle closes on wrong side of EMA for exit confirmation
        if (s.trv2Trade) {
          const wrongSide = (s.trv2Trade.dir === 'long' && cp < s.trv2TrendEma) || (s.trv2Trade.dir === 'short' && cp > s.trv2TrendEma);
          if (wrongSide) { s.trv2CrossCount++; } else { s.trv2CrossCount = 0; }
        } else { s.trv2CrossCount = 0; }
        s.trv2CurCandle = null;
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
  // MT5 ticks arrive every 1s — use minute-based lookback (180/360/720 ticks = 3/6/12 min)
  // Equities tick every 3s — keep short lookback (3/6/12 ticks = 9/18/36 sec)
  const roc3 = isMT5 ? calcROC(s.prices, 180) : calcROC(s.prices, 3);
  const roc6 = isMT5 ? calcROC(s.prices, 360) : 0;
  const roc12 = isMT5 ? calcROC(s.prices, 720) : 0;

  // Track RSI at session high — used by Session High Reversal Detector
  if (price >= s.sessionHigh) s.rsiAtSessionHigh = rsiV;
  // Track RSI at rolling ATH/ATL — used by ATH/ATL Reversal Detector
  if (isMT5) {
    if (s.rollingHigh > 0 && price >= s.rollingHigh * 0.999) { s.rsiAtRollingHigh = rsiV; s.athApproachTs = Date.now(); s.athApproachPrice = price; }
    if (s.rollingLow < Infinity && s.rollingLow > 0 && price <= s.rollingLow * 1.001) { s.rsiAtRollingLow = rsiV; s.atlApproachTs = Date.now(); s.atlApproachPrice = price; }
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
  } else if (isBTC || isNAS) {
    // BTC/NAS100: no official VWAP, use price vs EMA34 as trend anchor (above = bullish, below = bearish)
    if (s.pE34 && s.prices.length >= 35) {
      const ema34Pct = ((price - s.pE34) / s.pE34) * 100;
      abV = ema34Pct > 0.05; blV = ema34Pct < -0.05;
    }
  } else {
    const vwapPct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
    const vwapZone = 0.1;
    abV = vwapPct > vwapZone; blV = vwapPct < -vwapZone;
  }

  // ATR for MT5 instruments — use proper 5-min candles when available
  // Also include current building candle for faster warmup and more responsive ATR
  let atrVal = 0;
  if (isMT5 && s.atrCandles && s.atrCandles.length >= 1) {
    // Combine completed candles + current building candle for ATR
    const ac = [...s.atrCandles];
    if (s.atrCurCandle && s.atrCurCandle.h > s.atrCurCandle.l) {
      ac.push(s.atrCurCandle); // include partial candle for faster response
    }
    const period = Math.min(14, ac.length);
    let atrSum = 0;
    for (let ai = ac.length - period; ai < ac.length; ai++) {
      const tr = Math.max(ac[ai].h - ac[ai].l, ai > 0 ? Math.abs(ac[ai].h - ac[ai - 1].c) : ac[ai].h - ac[ai].l, ai > 0 ? Math.abs(ac[ai].l - ac[ai - 1].c) : ac[ai].h - ac[ai].l);
      atrSum += tr;
    }
    atrVal = atrSum / period;
  } else if (isMT5) {
    // Fallback: use session range / time elapsed as rough ATR estimate during first 5 min
    if (s.sessionHigh > -Infinity && s.sessionLow < Infinity && s.sessionHigh > s.sessionLow) {
      atrVal = s.sessionHigh - s.sessionLow;
    } else {
      atrVal = calcATR(s.highs, s.lows, s.prices, 14);
    }
  }
  const atrTooLow = isXAU && s.prices.length >= 30 && atrVal < 0.50; // XAU: $0.50 ATR = dead market
  const btcAtrTooLow = isBTC && s.prices.length >= 30 && atrVal < 10; // BTC: $10 ATR = dead market
  const nasAtrTooLow = isNAS && s.prices.length >= 30 && atrVal < 5; // NAS100: $5 ATR = dead market (~20000 price)

  // Session detection
  const etMin = gET();
  const xauSession = isXAU ? (etMin >= 480 && etMin < 960 ? 'london_ny' : etMin >= 180 && etMin < 480 ? 'london' : 'asia') : '';
  const btcSession = isBTC ? (etMin >= 570 && etMin < 960 ? 'us' : etMin >= 480 && etMin < 570 ? 'pre_us' : etMin >= 60 && etMin < 480 ? 'europe_asia' : 'overnight') : '';
  // NAS100 futures: Sun 6PM - Fri 5PM ET, daily break 5-6PM ET
  // Sessions: us (09:30-16:00), pre_us (08:00-09:30), europe (03:00-08:00), overnight (18:00-03:00)
  const nasSession = isNAS ? (etMin >= 570 && etMin < 960 ? 'us' : etMin >= 480 && etMin < 570 ? 'pre_us' : etMin >= 180 && etMin < 480 ? 'europe' : 'overnight') : '';
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
  const rsiScoreHi = isXAU ? 68 : (isBTC || isNAS) ? 66 : 70;
  const rsiScoreLo = isXAU ? 40 : (isBTC || isNAS) ? 42 : 45;
  const rBull = rsiV > rsiScoreLo && rsiV < rsiScoreHi;
  const rBear = rsiV < rsiScoreLo || rsiV > rsiScoreHi;
  // ATR-adaptive ROC threshold for XAU — scales with volatility
  // Base: 0.025%. High ATR (>$3) = raise to 0.035% (filter noise in volatile markets)
  // Low ATR (<$1) = lower to 0.018% (capture meaningful moves in quiet markets)
  let symRocThr = isBTC ? BTC_ROC_THR : isNAS ? NAS_ROC_THR : sym === 'XAU' ? XAU_ROC_THR : ROC_THR;
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
  if (isNAS && atrVal > 0) {
    if (atrVal >= 30) symRocThr = 0.040;         // NAS100: high vol — need bigger move
    else if (atrVal >= 15) symRocThr = 0.025;    // Normal NAS100 vol
    else if (atrVal >= 5) symRocThr = 0.018;     // Quiet NAS100 market
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
    s._breakout = { range: bRange, hi: s.breakHi > 0 ? +s.breakHi.toFixed(2) : 0, lo: s.breakLo < Infinity ? +s.breakLo.toFixed(2) : 0, coiling: s.breakCoilActive, coilSec: bCoilSec, firedTs: s.breakLastTs || 0, firedDir: s.breakLastDir || null, firedPrice: s.breakLastPrice || 0 };
  }
  s._roc6 = roc6;
  s._roc12 = roc12;
  s._vwap = isMT5 ? 0 : vwap;
  s._dxy = isXAU ? { price: dxyPrice, dir: dxyDir, roc3: dxyRoc3 } : null;
  s._tlt = isXAU ? { price: tltPrice, dir: tltDir, roc3: tltRoc3 } : null;
  s._slv = isXAU ? { price: slvPrice, dir: slvDir, roc3: slvRoc3 } : null;
  s._gdx = isXAU ? { price: gdxPrice, dir: gdxDir, roc3: gdxRoc3 } : null;
  s._btcSession = btcSession;
  s._nasSession = nasSession;
  s._atr = atrVal;
  s._xauSession = xauSession;

  // ===== PRICE STRUCTURE DETECTOR (XAU only) =====
  // Build 3-minute bars from vrevSnaps, detect higher-highs/higher-lows or lower-highs/lower-lows
  if (isMT5 && s.vrevSnaps.length >= 30) {
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
  } else if (isMT5) { s._priceStructure = 'neutral'; }

  // Check exit for active trades
  checkExit(sym, price);

  // ===== CONVICTION SCORE CALCULATOR (MT5 instruments: XAU + BTC) =====
  // Returns { score: 0-7, label: 'HIGH'|'MOD'|'LOW', factors: [...] } for a given direction
  function convictionFor(dir) {
    if (!isMT5) return { score: 0, label: '', factors: [] };
    const isCall = dir === 'call';
    const factors = [];
    let sc = 0;
    // 3. Macro trend aligned (shared)
    const macroDir = s.macroEma ? (price > s.macroEma ? 'bull' : 'bear') : null;
    if ((isCall && macroDir === 'bull') || (!isCall && macroDir === 'bear')) { sc++; factors.push('MACRO'); }
    // 6. Multi-TF ROC aligned (shared)
    const rocAllCall = roc3 > 0 && roc6 > 0 && roc12 > 0;
    const rocAllPut = roc3 < 0 && roc6 < 0 && roc12 < 0;
    if ((isCall && rocAllCall) || (!isCall && rocAllPut)) { sc++; factors.push('ROC×3'); }
    // 7. Price structure aligned (shared)
    if ((isCall && s._priceStructure === 'bull') || (!isCall && s._priceStructure === 'bear')) { sc++; factors.push('STRUCT'); }

    if (isXAU) {
      // XAU-specific: DXY, TLT, SLV, GDX
      if ((isCall && dxyDir === 'down') || (!isCall && dxyDir === 'up')) { sc++; factors.push('DXY'); }
      if ((isCall && tltDir === 'up') || (!isCall && tltDir === 'down')) { sc++; factors.push('TLT'); }
      if (slvPrice > 0 && ((isCall && slvDir === 'up') || (!isCall && slvDir === 'down'))) { sc++; factors.push('SLV'); }
      if (gdxPrice > 0 && ((isCall && gdxDir === 'up') || (!isCall && gdxDir === 'down'))) { sc++; factors.push('GDX'); }
    } else if (isBTC || isNAS) {
      // BTC/NAS100-specific: SPY, QQQ, DXY (risk-on correlation), cross-asset
      const spyS = S['SPY'], qqqS = S['QQQ'];
      const spyDir2 = spyS && spyS.pE5 && spyS.pE13 ? (spyS.pE5 > spyS.pE13 ? 'up' : 'down') : null;
      const qqqDir2 = qqqS && qqqS.pE5 && qqqS.pE13 ? (qqqS.pE5 > qqqS.pE13 ? 'up' : 'down') : null;
      if ((isCall && spyDir2 === 'up') || (!isCall && spyDir2 === 'down')) { sc++; factors.push('SPY'); }
      if ((isCall && qqqDir2 === 'up') || (!isCall && qqqDir2 === 'down')) { sc++; factors.push('QQQ'); }
      // DXY inverse (dollar up = equity/crypto bear)
      if ((isCall && dxyDir === 'down') || (!isCall && dxyDir === 'up')) { sc++; factors.push('DXY'); }
      // Order blocks aligned
      if (s._orderBlocks && s._orderBlocks.length > 0) { sc++; factors.push('OB'); }
      // NAS100: also check BTC as risk-on correlation
      if (isNAS) {
        const btcS = S['BTC'];
        const btcDir2 = btcS && btcS.pE5 && btcS.pE13 ? (btcS.pE5 > btcS.pE13 ? 'up' : 'down') : null;
        if ((isCall && btcDir2 === 'up') || (!isCall && btcDir2 === 'down')) { sc++; factors.push('BTC'); }
      }
    }

    const label = sc >= 5 ? 'HIGH' : sc >= 3 ? 'MOD' : 'LOW';
    return { score: sc, label, factors };
  }
  // Enriches a signal object with conviction data and applies the conviction gate.
  // Returns true if the signal should emit, false if it must be blocked.
  // QQQ/SPY (non-MT5) skip both enrichment and gate — they don't have cross-asset factors.
  //
  // Conviction gate (added 2026-05-07, after XAU 5/7 retro):
  //   - Trend-aligned signals require conv.score >= 3 (out of 7) — blocks "LOW" conviction
  //   - Counter-trend OR specialist fades (ATH PUT, ATL CALL) require conv.score >= 4
  //     because fighting the macro trend needs strong confirmation
  // The thresholds are deliberately moderate for the first deployment; tune after a week
  // of conv-logged data shows what wins / loses.
  function enrichSig(sig) {
    if (!isMT5) return true; // non-MT5 instruments don't have conv — let them through
    const conv = convictionFor(sig.type);
    sig.conv = conv;

    const macroDir = s.macroEma ? (price > s.macroEma ? 'bull' : 'bear') : null;
    const isCall = sig.type === 'call';
    const isCounterTrend = macroDir && ((isCall && macroDir === 'bear') || (!isCall && macroDir === 'bull'));
    // Specialist fade tags — by design these signals fight extremes and need extra confirmation
    const tag = sig.score || '';
    const isFadeSignal = /ATH|ATL|HI|LO/.test(tag) && !/MFLIP|TREND|FAST|BREAK|RIDE/.test(tag);
    const minConv = (isCounterTrend || isFadeSignal) ? 4 : 3;
    if (conv.score < minConv) {
      const reason = isCounterTrend ? 'counter-trend' : isFadeSignal ? 'fade' : 'trend';
      log(sym, '🚫 ' + tag + ' ' + sig.type.toUpperCase() + ' BLOCKED — conv ' + conv.score + '/7 [' + conv.label + '] < ' + minConv + ' (' + reason + ')' + (conv.factors.length ? ' factors:' + conv.factors.join(',') : ''));
      return false;
    }
    return true;
  }

  const now2 = Date.now();
  const cool = now2 - s.lastNTs > COOLDOWN_MS;

  // === OPPOSITE-DIRECTION FLIP GUARD ===
  // Prevent PUT+CALL firing within 10 min of each other (different detectors can disagree at tops/bottoms)
  // Same-direction signals still use normal 3-min cooldown. Opposite direction needs 10 min.
  const FLIP_COOLDOWN_MS = 600000; // 10 minutes
  const flipCool = !s.lastSignalDir || (now2 - s.lastNTs > FLIP_COOLDOWN_MS);
  // flipCoolFor(dir): returns true if firing 'dir' is allowed given the last signal's direction
  function flipCoolFor(dir) {
    if (!s.lastSignalDir) return true; // no previous signal
    if (s.lastSignalDir === dir) return cool; // same direction: normal 3-min cooldown
    return now2 - s.lastNTs > FLIP_COOLDOWN_MS; // opposite direction: 10-min cooldown
  }

  // === SIGNAL GATES ===
  // XAU: full session 6PM-5PM ET (Sun-Fri) = nearly 23h, block 5PM-6PM ET (1020-1080 min)
  // BTC: 24/7, no block window (crypto never sleeps)
  // Equities: 9:30 AM - 3:55 PM ET (570-955 min)
  if (isXAU) {
    if (etMin >= 1020 && etMin < 1080) return; // XAU closed 5-6 PM ET
  } else if (isBTC) {
    // BTC trades 24/7 — no session block
  } else if (isNAS) {
    // NAS100 futures: Sun 6PM - Fri 5PM ET, daily break 5-6PM ET (1020-1080 min)
    if (etMin >= 1020 && etMin < 1080) return; // NAS100 closed 5-6 PM ET
  } else {
    if (etMin < 570 || etMin >= 955) return;
    // Midday dead zone — 12:00-14:00 ET (720-840 min). QQQ: 43% win, SPY: 42% win.
    // Lunch chop kills both instruments. Block regular signals during this window.
    if (etMin >= 720 && etMin < 840 && (cS >= THR || pS >= THR)) {
      log(sym, 'Midday block: ' + etMin + ' min ET — lunch chop zone (12:00-14:00)');
      return;
    }
  }
  if (!isMT5 && etMin >= 945 && (cS >= THR || pS >= THR)) return;

  // Global dedup guard: no two signals within 30 seconds of each other
  // Server restarts can burst multiple price ticks at once, causing duplicate signals at the same timestamp.
  // This catches that by enforcing a minimum gap between ANY signals (all cooldowns above only apply to specific directions).
  const GLOBAL_DEDUP_MS = 30000; // 30 seconds
  if (s.lastNTs && now2 - s.lastNTs < GLOBAL_DEDUP_MS) {
    // Allow same-direction signals through if the 3-min cooldown already passed (handled elsewhere)
    // But block rapid-fire different-type signals from restart bursts
    if (now2 - s.lastNTs < 5000) { // hard 5-second dedup — nothing gets through
      return;
    }
  }

  // ATR filter — block BASE scoring signals when market is dead (low volatility)
  // NOTE: This is a FLAG, not a return. Specialized detectors (fast-move, breakout, session high
  // reversal, ATH/ATL, V-reversal, TRv2) must still run — a "dead" market can wake up suddenly
  // and those detectors are designed to catch exactly that scenario.
  const atrBlocked = (atrTooLow || btcAtrTooLow || nasAtrTooLow) && (cS >= THR || pS >= THR);
  if (atrBlocked) {
    log(sym, 'ATR filter: base scoring skipped — ATR $' + atrVal.toFixed(2) + ' (dead market, specialized detectors still active)');
  }

  // ===== BASE SCORING ENGINE =====
  // When atrBlocked, skip the entire base scoring chain and jump to specialized detectors.
  // The specialized detectors (session high reversal, breakout, fast-move, V-reversal, TRv2,
  // MFLIP, TREND, ATH/ATL, shakeout) must always run — they catch exactly the sudden moves
  // that happen when a "dead" market wakes up.
  if (atrBlocked) { /* skip base scoring — fall through to specialized detectors below */ }
  else {

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
  // Chop mode: forces 6/6 minimum for base scoring (tighter filter, not a block).
  // Specialized detectors (TREND, BREAKOUT, FAST, ATH/ATL, V-REV, MFLIP) always run regardless.
  const domT = cS >= pS ? 'call' : 'put';

  // Dynamic threshold
  const refPrice = s.openPrice || 0;
  const dayMv = refPrice > 0 ? Math.abs(((price - refPrice) / refPrice) * 100) : 0;
  const tightMode = dayMv >= 1;
  const streakActive = now2 < s.lossStreakUntil;
  // XAU session-specific threshold: Asia = 6/6 (choppy, low volume), London/NY = 5/6 (cleaner trends)
  const sessionThr = isXAU && xauSession === 'asia' ? 6 : THR;
  // Chop mode forces 6/6 minimum — only perfect-score signals pass through choppy markets
  const chopThr = s.chopActive ? 6 : 0;
  let minS = Math.max(chopThr, (tightMode ? 6 : sessionThr)) + (streakActive ? s.lossStreakBoost : 0) + roundNumPenalty;

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

  // Blowoff lock REMOVED — was blocking signals during real momentum moves (missed $26 XAU rally 2025-05-06).
  // Other guards (cooldown, flipCool, winProtect, RSI/MACD exhaustion) already prevent bad entries.
  // Kept for equities only (5-min lock) where 0DTE chasing after spikes is genuinely dangerous.
  if (!isMT5) {
    const blowoffLock = now2 - s.blowoffTs < 300000;
    if (Math.abs(roc3) > ROC_BLOWOFF[sym] && !blowoffLock) { s.blowoffTs = now2; }
    if (blowoffLock && (cS >= minS || pS >= minS)) {
      const sustainedOk = sustainedOverride && s.sustainedDir === (cS >= pS ? 'call' : 'put');
      if (sustainedOk) {
        log(sym, 'Blowoff override: sustained momentum — ' + s.sustainedCount + ' consecutive ' + s.sustainedDir.toUpperCase() + ' ticks');
        s.blowoffTs = 0;
      } else {
        return;
      }
    }
  }

  // Flip lock — 10 min for MT5 (prevents whipsaw clusters), 3 min for equities
  const flipLockMs = isMT5 ? 600000 : 180000;
  if (now2 - s.lastReversalTs < flipLockMs && (cS >= minS || pS >= minS)) {
    log(sym, 'Flip lock: blocked — last reversal ' + ((now2 - s.lastReversalTs) / 60000).toFixed(1) + 'min ago (need ' + (flipLockMs / 60000) + 'min)');
    return;
  }
  // Daily cap — XAU/BTC uncapped (24h markets need freedom), equities keep cap
  if (!isMT5 && s.dailySignalCount >= MAX_SIG) return;

  // FIX 1: Minimum ROC gate — no momentum = no trade
  // MT5: 0.015% (38% XAU, 0% BTC below this). Equities: 0.01% (33% QQQ below this).
  const minRocGate = isBTC ? 0.015 : isNAS ? 0.015 : isXAU ? 0.015 : 0.010;
  if (Math.abs(roc3) < minRocGate && (cS >= minS || pS >= minS)) {
    if (sustainedOverride) {
      log(sym, 'ROC gate override: sustained momentum (' + s.sustainedCount + ' ticks) — ROC ' + roc3.toFixed(3) + '% below ' + minRocGate + '%');
    } else {
      log(sym, 'ROC gate: blocked — |ROC| ' + Math.abs(roc3).toFixed(3) + '% < ' + minRocGate + '% (no momentum)');
      return;
    }
  }

  // FIX 4: BTC ROC exhaustion cap — signals with ROC > 0.08% are chasing (33% win rate)
  if (isBTC && Math.abs(roc3) > 0.08 && (cS >= minS || pS >= minS)) {
    if (sustainedOverride) {
      log(sym, 'BTC ROC exhaustion override: sustained (' + s.sustainedCount + ' ticks) — ROC ' + roc3.toFixed(3) + '% but move still going');
    } else {
      log(sym, 'BTC ROC exhaustion: blocked — |ROC| ' + Math.abs(roc3).toFixed(3) + '% > 0.08% (move already over)');
      return;
    }
  }

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

  // FIX 3: RSI 30-45 PUT confirmation — "weak bearish" band is a trap (35% XAU, 20% BTC)
  // PUTs in this range need stronger momentum confirmation: ROC > 0.03% OR MACD < -0.20 (XAU) / -3.0 (BTC)
  if (isMT5 && rsiV >= 30 && rsiV < 45 && pS >= minS && pS > cS) {
    const weakPutRocMin = isBTC ? 0.030 : 0.030;
    const weakPutMacdMin = isBTC ? -3.0 : -0.20;
    const rocConfirmed = roc3 < -weakPutRocMin;
    const macdConfirmed = macdL < weakPutMacdMin;
    if (!rocConfirmed && !macdConfirmed) {
      if (sustainedOverride && s.sustainedDir === 'put') {
        log(sym, 'RSI 30-45 PUT override: sustained PUT (' + s.sustainedCount + ' ticks) — weak bearish but move is real');
      } else {
        log(sym, 'RSI 30-45 PUT blocked: weak bearish trap — RSI ' + rsiV.toFixed(1) + ' ROC ' + roc3.toFixed(3) + '% MACD ' + macdL.toFixed(3) + ' (need ROC<-' + weakPutRocMin + '% or MACD<' + weakPutMacdMin + ')');
        return;
      }
    }
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
  const macdMinStr = isXAU ? XAU_MACD_MIN : isBTC ? BTC_MACD_MIN : isNAS ? 0.50 : 0.020;
  const macdLineMin = isXAU ? XAU_MACD_LINE_MIN : isBTC ? 1.50 : isNAS ? 0.50 : 0.015;
  if (macdStr < macdMinStr && (cS >= finalMinS || pS >= finalMinS)) return;
  if (Math.abs(macdL) < macdLineMin && (cS >= finalMinS || pS >= finalMinS)) {
    log(sym, 'MACD line filter: blocked — |macdL| = ' + Math.abs(macdL).toFixed(3) + ' < ' + macdLineMin);
    return;
  }

  // MACD Exhaustion Filter — MT5 instruments (XAU + BTC), block signals chasing an already-extended move
  // Check BOTH histogram (short-term momentum) AND line (trend depth)
  // Histogram deeply extended → immediate momentum spent
  // Line deeply extended → trend has been running too long, reversal likely
  if (isMT5) {
    const macdExhThr = isBTC ? 12.0 : isNAS ? 5.0 : 0.80;       // histogram exhaustion threshold (BTC ~$77k, NAS ~$27k, XAU ~$4600)
    const macdLineDepth = isBTC ? 15.0 : isNAS ? 6.0 : 1.00;    // line depth exhaustion threshold
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
    const retraceMin = isBTC ? 80.0 : isNAS ? 30.0 : isXAU ? 5.0 : 0.50; // BTC ~$77k needs $80, NAS ~$27k needs $30, XAU ~$4600 needs $5, equities $0.50
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
    const minPctMove = isBTC ? 0.12 : isNAS ? 0.12 : isXAU ? 0.15 : 0.25;
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
    const postMoveThr = isBTC ? 300.0 : isNAS ? 100.0 : isXAU ? 20.0 : 2.0;
    const postMoveMacd = isBTC ? 3.0 : isNAS ? 1.0 : isXAU ? 0.20 : 0.040;
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

  } // end else (!atrBlocked) — base scoring engine

  // ===== SPECIALIZED DETECTORS — always run regardless of ATR =====
  // These catch sudden moves, reversals, breakouts that happen when a "dead" market wakes up

  // === GLOBAL WINNING TRADE GUARD — protect profitable trades from ALL detectors ===
  // If a CFD trade is active and in profit, block opposite-direction signals from ALL detectors.
  // Previously only blocked regular 5/6 signals — specialized detectors (Session High Rev, ATH Rev)
  // could fire PUTs against a profitable CALL, wrecking a winning trade.
  // Same-direction signals are still allowed (e.g., trend continuation CALL when CALL trade is running).
  let winProtectDir = null; // set to 'call'|'put' = direction being protected (block opposite)
  if (isMT5 && s.trade.active && s.trade.ep > 0) {
    const wpDir = s.trade.type;
    const wpPnl = wpDir === 'call' ? price - s.trade.ep : s.trade.ep - price;
    const wpMin = isBTC ? 50 : isNAS ? 10 : isXAU ? 1 : 0.20; // XAU lowered from $2 to $1 — $1.76 profit PUT wasn't protected, allowed false TREND CALL
    if (wpPnl >= wpMin) {
      winProtectDir = wpDir; // protect this direction — block opposite
    }
  }

  // Session High Reversal Detector — fire high-confidence PUT when price reverses from session high
  // Conditions: hit session high, reversed >$1 from it, RSI > 60 (was overbought), MACD turning bearish
  // RSI sanity: skip when RSI is corrupted from reconnection gaps (RSI 13.8, 99.2 artifacts)
  const hiLoRsiSane = rsiV >= 10 && rsiV <= 90;
  if (s.sessionHigh > -Infinity && s.openPrice && cool && hiLoRsiSane && flipCoolFor('put') && winProtectDir !== 'call' && (isMT5 || s.dailySignalCount < MAX_SIG) && etMin >= 570 && etMin < 955) {
    const distFromHigh = s.sessionHigh - price;
    const sessionRange = s.sessionHigh - s.sessionLow;
    const highWasRecent = s.prices.length >= 10 && Math.max(...s.prices.slice(-30 > -s.prices.length ? -30 : 0)) >= s.sessionHigh - 0.05;
    // XAU/BTC session high reversal needs larger move — gold/btc prices produce bigger absolute moves
    const hiRevDist = isBTC ? 80.0 : isNAS ? 50.0 : isXAU ? 5.0 : 0.50;   // min pullback from high
    const hiRevRange = isBTC ? 150.0 : isNAS ? 100.0 : isXAU ? 10.0 : 1.0;  // min session range to confirm real move
    // Loosened: RSI at high only needs > 55 (was 60), and ROC OR MACD confirms (was AND)
    const hiRevRocOk = roc3 < -symRocThr;
    const hiRevMacdOk = macdL < macdS;
    if (distFromHigh >= hiRevDist && s.rsiAtSessionHigh > 55 && sessionRange >= hiRevRange && highWasRecent && (hiRevRocOk || hiRevMacdOk)) {
      // Don't fire if we already fired a PUT recently (use cooldown)
      if (s.lastSignalDir !== 'put' || (now2 - s.lastNTs > COOLDOWN_MS)) {
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇HI', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig);
        logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
        s.lastHiRevTs = now2; // Track for TRv2 entry suppression
        log(sym, '🔻 SESSION HIGH REVERSAL PUT — $' + distFromHigh.toFixed(2) + ' off high $' + s.sessionHigh.toFixed(2) + ' RSI@high:' + s.rsiAtSessionHigh.toFixed(1) + ' RSInow:' + rsiV.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔻 ' + sym + ' HIGH REVERSAL PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromHigh.toFixed(2) + ' off high · RSI@high:' + s.rsiAtSessionHigh.toFixed(1), 'signal');
        s.trade = isMT5 ? buildCfdTrade('put', price, atrVal, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
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
  if (isMT5 && s._pendingBreakout) {
    const bo = s._pendingBreakout;
    s._pendingBreakout = null; // consume it
    const cool2 = now2 - s.lastNTs > COOLDOWN_MS;
    const breakCool = now2 - s.breakLastTs > 300000; // 5-min cooldown

    // RSI sanity: block breakout signals when RSI is corrupted (reconnection gap artifact)
    // BTC had RSI 99.2 and 5.4 on BREAK signals; NAS100 had RSI 13.8 on ATH after reconnection
    const breakRsiSane = rsiV >= 10 && rsiV <= 90;
    if (cool2 && breakCool && breakRsiSane && flipCoolFor(bo.dir) && (winProtectDir === null || winProtectDir === bo.dir)) {
      // === BREAKOUT QUALITY FILTERS ===

      // Filter 1: No consecutive same-direction breakouts (first catches the move, second stacks into exhaustion)
      // Same-dir breakout needs 15-min cooldown instead of 5-min
      if (s.breakLastDir === bo.dir && now2 - s.breakLastTs < 900000) {
        log(sym, '💥 BREAKOUT blocked: consecutive ' + bo.dir.toUpperCase() + ' — last breakout was same direction ' + ((now2 - s.breakLastTs) / 60000).toFixed(1) + 'min ago (need 15min)');
        s._pendingBreakout = null;
        return;
      }

      // Filter 2: Minimum ROC confirmation — breakout needs momentum in the right direction
      const breakMinRoc = isBTC ? 0.020 : isXAU ? 0.020 : 0.030; // % threshold
      const rocAligned = (bo.dir === 'call' && roc3 >= breakMinRoc) || (bo.dir === 'put' && roc3 <= -breakMinRoc);
      if (!rocAligned) {
        log(sym, '💥 BREAKOUT blocked: ROC not confirming — ' + bo.dir.toUpperCase() + ' needs ROC ' + (bo.dir === 'call' ? '>' : '<') + (bo.dir === 'call' ? '+' : '-') + breakMinRoc + '% but ROC=' + (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%');
        s._pendingBreakout = null;
        return;
      }

      // Filter 3: RSI exhaustion on CALL breakouts — XAU only (4/7 ⬆BREAK with RSI>75 lost)
      // BTC excluded: Row 30 RSI 93.6 was a +0.38% winner — BTC momentum sustains longer runs
      if (isXAU && bo.dir === 'call' && rsiV > 75) {
        log(sym, '💥 BREAKOUT blocked: ⬆BREAK RSI ' + rsiV.toFixed(1) + ' > 75 — overbought, entering at exhaustion');
        s._pendingBreakout = null;
        return;
      }

      // Filter 4: MACD not fading — histogram must be growing in breakout direction (not losing steam)
      // macdAccel > 0 = histogram expanding, < 0 = shrinking
      const macdFading = (bo.dir === 'call' && macdAccel < 0 && macdHist > 0) || (bo.dir === 'put' && macdAccel > 0 && macdHist < 0);
      if (macdFading) {
        log(sym, '💥 BREAKOUT blocked: MACD fading — histogram shrinking in ' + bo.dir.toUpperCase() + ' direction (accel=' + macdAccel.toFixed(3) + ', hist=' + macdHist.toFixed(3) + ')');
        s._pendingBreakout = null;
        return;
      }

      s.breakLastTs = now2;
      s.breakLastDir = bo.dir;
      s.breakLastPrice = price;

      // === ORDER BLOCK ZONE — mark institutional supply/demand zone from the coil ===
      const coilMid = (bo.coilHi + bo.coilLo) / 2;
      if (bo.dir === 'call') {
        // Bullish OB = demand zone at bottom half of coil (where buyers accumulated)
        s.obZone = { dir: 'call', hi: coilMid, lo: bo.coilLo, mid: (coilMid + bo.coilLo) / 2, coilHi: bo.coilHi, coilLo: bo.coilLo, ts: now2, breakPrice: price };
      } else {
        // Bearish OB = supply zone at top half of coil (where sellers accumulated)
        s.obZone = { dir: 'put', hi: bo.coilHi, lo: coilMid, mid: (bo.coilHi + coilMid) / 2, coilHi: bo.coilHi, coilLo: bo.coilLo, ts: now2, breakPrice: price };
      }
      s.obDeparted = false; s.obFired = false; s.obMitigated = false;
      log(sym, '🧱 OB zone set: ' + bo.dir.toUpperCase() + ' $' + s.obZone.lo.toFixed(2) + '-$' + s.obZone.hi.toFixed(2) + ' (coil mid $' + coilMid.toFixed(2) + ')');

      const dir = bo.dir;
      s.lastAT = dir; if (dir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
      if (s.lastSignalDir && s.lastSignalDir !== dir) s.lastReversalTs = now2;
      s.lastSignalDir = dir; s.lastSignalTs = now2; s.lastNTs = now2;
      s.lastSameDir = dir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
      const scoreTag = dir === 'call' ? '⬆BREAK' : '⬇BREAK';
      const sig = { type: dir, time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
      if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
      if (isMT5) attachTpSl(sig, dir, price, atrVal, sym);
      const coilMin = (bo.coilDuration / 60000).toFixed(1);
      const rangeStr = '$' + bo.coilLo.toFixed(2) + '-$' + bo.coilHi.toFixed(2);
      log(sym, '💥 BREAKOUT ' + dir.toUpperCase() + ' — coiled ' + coilMin + 'min in ' + rangeStr + ' · escaped $' + bo.escape.toFixed(2) + ' · accel ' + bo.accel.toFixed(1) + 'x [#' + s.dailySignalCount + ']');
      sendPush('💥 ' + sym + ' BREAKOUT ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · broke ' + (dir === 'call' ? 'above' : 'below') + ' ' + rangeStr + ' (' + coilMin + 'min coil)', 'signal');
      s.trade = isMT5 ? buildCfdTrade(dir, price, atrVal, sym) : { active: true, type: dir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
      return;
    } else {
      // Cooldown blocked — clear pending
      s._pendingBreakout = null;
    }
  }

  // ===== ORDER BLOCK RETEST / MITIGATION SIGNALS (MT5 only) =====
  // DISABLED as standalone signals — 0% win rate across all samples (4/30 + 5/1)
  // OB zone tracking still active for scoring factor (+1/-1 boost in scoring section)
  // Keeping detection logic commented for future re-evaluation with better confirmation
  if (false && isMT5 && s.obZone && cool) {
    const ob = s.obZone;
    const obAge = now2 - ob.ts;
    const obTolerance = isBTC ? 15.0 : 0.50;
    const obCool = now2 - s.lastNTs > COOLDOWN_MS;

    // --- OB RETEST: price departed, then returned to OB zone → re-entry in breakout direction ---
    if (s.obDeparted && !s.obFired && !s.obMitigated && obAge <= 1800000 && obCool && flipCoolFor(ob.dir) && (winProtectDir === null || winProtectDir === ob.dir)) {
      const inZone = price >= (ob.lo - obTolerance) && price <= (ob.hi + obTolerance);
      if (inZone) {
        const rsiOk = rsiV >= 30 && rsiV <= 70;
        const obMinRoc = 0.015;
        const rocOk = (ob.dir === 'call' && roc3 > obMinRoc) || (ob.dir === 'put' && roc3 < -obMinRoc);
        const macdOk = (ob.dir === 'call' && macdHist > 0) || (ob.dir === 'put' && macdHist < 0);
        const obConfirmed = ob.dir === 'call' ? (rocOk && macdOk) : (rocOk || macdOk);

        if (rsiOk && obConfirmed) {
          s.obFired = true;
          const dir = ob.dir;
          s.lastAT = dir; if (dir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
          if (s.lastSignalDir && s.lastSignalDir !== dir) s.lastReversalTs = now2;
          s.lastSignalDir = dir; s.lastSignalTs = now2; s.lastNTs = now2;
          s.lastSameDir = dir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
          const scoreTag = dir === 'call' ? '⬆OB' : '⬇OB';
          const sig = { type: dir, time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
          if (isMT5) attachTpSl(sig, dir, price, atrVal, sym);
          log(sym, '🧱 OB RETEST ' + dir.toUpperCase() + ' — price $' + price.toFixed(2) + ' retested OB zone $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' (age ' + (obAge / 60000).toFixed(1) + 'min) [#' + s.dailySignalCount + ']');
          sendPush('🧱 ' + sym + ' OB RETEST ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · retested OB $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2), 'signal');
          s.trade = isMT5 ? buildCfdTrade(dir, price, atrVal, sym) : { active: true, type: dir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
          return;
        }
      }
    }

    // --- OB MITIGATION: price broke through OB → breakout failed → reversal signal ---
    if (s.obMitigated && !s.obFired && obAge <= 1800000 && obCool) {
      const revDir = ob.dir === 'call' ? 'put' : 'call';
      if (!flipCoolFor(revDir) || (winProtectDir !== null && winProtectDir !== revDir)) {
        // blocked by flip cooldown or winning trade protection — skip
      } else {
      const revRocOk = (revDir === 'call' && roc3 > 0) || (revDir === 'put' && roc3 < 0);
      const revMacdOk = (revDir === 'call' && macdHist > 0) || (revDir === 'put' && macdHist < 0);

      if (revRocOk || revMacdOk) {
        s.obFired = true;
        const dir = revDir;
        s.lastAT = dir; if (dir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir && s.lastSignalDir !== dir) s.lastReversalTs = now2;
        s.lastSignalDir = dir; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = dir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const scoreTag = dir === 'call' ? '⬆OBFAIL' : '⬇OBFAIL';
        const sig = { type: dir, time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, dir, price, atrVal, sym);
        log(sym, '🧱 OB MITIGATION ' + dir.toUpperCase() + ' — breakout FAILED, price $' + price.toFixed(2) + ' broke through OB $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🧱 ' + sym + ' OB FAIL ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · breakout failed through OB $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2), 'signal');
        s.trade = isMT5 ? buildCfdTrade(dir, price, atrVal, sym) : { active: true, type: dir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        s.obZone = null;
        return;
      }
      } // end else (flipCool/winProtect ok)
    }
  }

  // ===== FAST-MOVE DETECTOR (MT5 instruments: XAU + BTC) =====
  // Catches strong directional moves that MACD is too slow to confirm.
  // Uses raw price-action from vrevSnaps: if price drops/rallies significantly in < 3 min,
  // fire a signal BYPASSING MACD alignment. MACD is a lagging indicator and won't cross
  // during fast directional moves — this detector fills that gap.
  // XAU threshold: $10 in 3 min | BTC threshold: $200 in 3 min
  if (isMT5 && s.vrevSnaps.length >= 20 && cool && (now2 - s.fastMoveLastTs > 600000)) {
    const fmWindow = 180000; // 3-minute lookback
    const fmSnaps = s.vrevSnaps.filter(sn => sn.ts > now2 - fmWindow);
    if (fmSnaps.length >= 10) {
      const fmFirst = fmSnaps[0].p;
      const fmLast = price;
      const fmDelta = fmLast - fmFirst;
      const fmAbsDelta = Math.abs(fmDelta);
      const fmThreshold = isBTC ? 200 : isNAS ? 50 : 5; // $200 BTC, $50 NAS100, $5 XAU (was $10 — missed $40 rallies during Asia)

      // Also check velocity is accelerating: last 1-min move > first 1-min move
      const fmMid = fmSnaps.filter(sn => sn.ts > now2 - 60000); // last 1 min
      const fmEarly = fmSnaps.filter(sn => sn.ts <= now2 - 120000); // first 1 min
      const fmMidDelta = fmMid.length >= 3 ? Math.abs(price - fmMid[0].p) : 0;
      const fmEarlyDelta = fmEarly.length >= 3 ? Math.abs(fmEarly[fmEarly.length - 1].p - fmEarly[0].p) : 0;
      const accelerating = fmMidDelta >= fmEarlyDelta * 0.8; // recent move at least 80% of early move

      if (fmAbsDelta >= fmThreshold && accelerating) {
        const fmDir = fmDelta < 0 ? 'put' : 'call';
        // Require RSI to not be extreme against us (don't short at RSI 10, don't buy at RSI 95)
        const fmRsiOk = (fmDir === 'put' && rsiV < 85) || (fmDir === 'call' && rsiV > 15);
        // Require ROC to confirm direction (even slightly)
        const fmRocOk = (fmDir === 'put' && roc3 < 0) || (fmDir === 'call' && roc3 > 0);
        // MACD-extremity gate (added 2026-05-07) — don't fire FAST when MACD line is already
        // at exhaustion in the move's direction. Empirical from 5/7 XAU: a FAST PUT at MACD
        // -1.225 (way past XAU's typical ±1.0 range) lost -0.20% as the move had already
        // played out. The winning FAST CALL the same day had MACD +0.422, well inside range.
        // Per-instrument because MACD scale differs by ~100x across XAU/BTC/NAS100.
        const fmMacdExtreme = isXAU ? 1.0 : isBTC ? 100 : isNAS ? 25 : 1.0;
        const fmMacdOk = (fmDir === 'put' && macdL > -fmMacdExtreme) || (fmDir === 'call' && macdL < fmMacdExtreme);
        if (!fmMacdOk) {
          log(sym, '⚡ FAST ' + fmDir.toUpperCase() + ' BLOCKED — MACD ' + macdL.toFixed(3) + ' beyond ±' + fmMacdExtreme + ' (move exhausted)');
        }

        if (fmRsiOk && fmRocOk && fmMacdOk && flipCoolFor(fmDir) && (winProtectDir === null || winProtectDir === fmDir)) {
          s.fastMoveLastTs = now2;
          s.lastAT = fmDir; if (fmDir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
          if (s.lastSignalDir && s.lastSignalDir !== fmDir) s.lastReversalTs = now2;
          s.lastSignalDir = fmDir; s.lastSignalTs = now2; s.lastNTs = now2;
          s.lastSameDir = fmDir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
          const fmTag = fmDir === 'call' ? '⬆FAST' : '⬇FAST';
          const sig = { type: fmDir, time: ts(), price: price.toFixed(2), score: fmTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
          if (isMT5) attachTpSl(sig, fmDir, price, atrVal, sym);
          log(sym, '⚡ FAST-MOVE ' + fmDir.toUpperCase() + ' — $' + fmAbsDelta.toFixed(2) + ' move in ' + (fmWindow / 60000).toFixed(0) + 'min · price $' + price.toFixed(2) + ' from $' + fmFirst.toFixed(2) + ' [#' + s.dailySignalCount + ']');
          sendPush('⚡ ' + sym + ' FAST ' + fmDir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + fmAbsDelta.toFixed(2) + ' move in 3min', 'signal');
          s.trade = isMT5 ? buildCfdTrade(fmDir, price, atrVal, sym) : { active: true, type: fmDir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
          return;
        }
      }
    }
  }

  // ===== SUSTAINED MOVE DETECTOR (DISABLED — replaced by ATH/ATL reversal for all MT5) =====
  // Was catching gradual moves but entering too late (at exhaustion). ATH/ATL reversal
  // fires on confirmed pullback from extremes instead, which has better timing.
  if (false && isMT5 && s.vrevSnaps.length >= 120 && cool && (now2 - (s.sustainedMoveLastTs || 0) > 1200000)) {
    // Multi-window check: [{window ms, min snaps, thresholds per instrument}]
    const smWindows = [
      { ms: 600000,  minSnaps: 60,  thr: isBTC ? 400 : isNAS ? 80 : 15 },  // 10 min: $15 XAU, $400 BTC, $80 NAS
      { ms: 1200000, minSnaps: 120, thr: isBTC ? 600 : isNAS ? 120 : 18 }, // 20 min: $18 XAU, $600 BTC, $120 NAS
    ];
    let smFired = false;
    for (const w of smWindows) {
      if (smFired) break;
      const smSnaps = s.vrevSnaps.filter(sn => sn.ts > now2 - w.ms);
      if (smSnaps.length < w.minSnaps) continue;
      const smFirst = smSnaps[0].p;
      const smDelta = price - smFirst;
      const smAbsDelta = Math.abs(smDelta);
      if (smAbsDelta < w.thr) continue;

      const smDir = smDelta > 0 ? 'call' : 'put';
      // Direction must be consistent: check price at 1/3 and 2/3 through the window
      // to confirm it's a sustained trend, not a V-shape that happened to end higher
      const smOneThird = smSnaps[Math.floor(smSnaps.length / 3)].p;
      const smTwoThird = smSnaps[Math.floor(smSnaps.length * 2 / 3)].p;
      const progressOk = smDir === 'call'
        ? (smOneThird > smFirst && smTwoThird > smOneThird)
        : (smOneThird < smFirst && smTwoThird < smOneThird);
      if (!progressOk) continue;

      // ROC3 must confirm direction
      const smRocOk = (smDir === 'call' && roc3 > 0) || (smDir === 'put' && roc3 < 0);
      if (!smRocOk) continue;
      // RSI not at extreme
      const smRsiOk = (smDir === 'call' && rsiV > 20 && rsiV < 80) || (smDir === 'put' && rsiV > 20 && rsiV < 80);
      if (!smRsiOk) continue;
      // MACD confirms direction (even slightly)
      const smMacdOk = (smDir === 'call' && macdL > macdS) || (smDir === 'put' && macdL < macdS);
      if (!smMacdOk) continue;

      // All checks pass — fire signal
      smFired = true;
      s.sustainedMoveLastTs = now2;
      s.lastAT = smDir; if (smDir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
      if (s.lastSignalDir && s.lastSignalDir !== smDir) s.lastReversalTs = now2;
      s.lastSignalDir = smDir; s.lastSignalTs = now2; s.lastNTs = now2;
      s.lastSameDir = smDir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
      const smMinutes = Math.round(w.ms / 60000);
      const smTag = smDir === 'call' ? '⬆SUST' : '⬇SUST';
      const sig = { type: smDir, time: ts(), price: price.toFixed(2), score: smTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
      if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
      if (isMT5) attachTpSl(sig, smDir, price, atrVal, sym);
      log(sym, '🔥 SUSTAINED MOVE ' + smDir.toUpperCase() + ' — $' + smAbsDelta.toFixed(2) + ' move in ' + smMinutes + 'min · price $' + price.toFixed(2) + ' from $' + smFirst.toFixed(2) + ' [#' + s.dailySignalCount + ']');
      sendPush('🔥 ' + sym + ' SUSTAINED ' + smDir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + smAbsDelta.toFixed(2) + ' move in ' + smMinutes + 'min', 'signal');
      s.trade = isMT5 ? buildCfdTrade(smDir, price, atrVal, sym) : { active: true, type: smDir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
      return;
    }
  }

  // ===== V-REVERSAL DETECTOR (XAU only) =====
  // Catches momentum reversals: price drops/rallies $8+ in 15 min, then ROC flips sharply
  // Different from trend-following signals — fires on the turn itself, not after EMAs catch up
  if (isXAU && s.vrevSnaps.length >= 60 && cool && (now2 - s.vrevLastTs > 600000)) {
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

      if (dropThenBounce && roc3 > symRocThr * 2 && rsiV > 35 && rsiV < 65 && flipCoolFor('call') && winProtectDir !== 'put') {
        // CALL reversal: was dropping, now bouncing with strong upward ROC
        s.vrevLastTs = now2;
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆VREV', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'call', price, atrVal, sym);
        log(sym, '🔄 V-REVERSAL CALL — dropped $' + (lbHigh - lbLow).toFixed(2) + ' to $' + lbLow.toFixed(2) + ', bounced $' + (price - lbLow).toFixed(2) + ' · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' V-REVERSAL CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · bounced $' + (price - lbLow).toFixed(2) + ' off $' + lbLow.toFixed(2) + ' low', 'signal');
        s.trade = isMT5 ? buildCfdTrade('call', price, atrVal, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        return;
      }

      if (rallyThenDrop && roc3 < -symRocThr * 2 && rsiV > 35 && rsiV < 65 && flipCoolFor('put') && winProtectDir !== 'call') {
        // PUT reversal: was rallying, now dropping with strong downward ROC
        s.vrevLastTs = now2;
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇VREV', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
        log(sym, '🔄 V-REVERSAL PUT — rallied $' + (lbHigh - lbLow).toFixed(2) + ' to $' + lbHigh.toFixed(2) + ', dropped $' + (lbHigh - price).toFixed(2) + ' · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' V-REVERSAL PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · dropped $' + (lbHigh - price).toFixed(2) + ' off $' + lbHigh.toFixed(2) + ' high', 'signal');
        s.trade = isMT5 ? buildCfdTrade('put', price, atrVal, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        return;
      }
    }
  }

  // ===== TREND RIDE V2 — TREND-FOLLOWING SYSTEM (NAS100 only) =====
  // Replaces TREND + MFLIP for NAS100. One entry per trend leg, hold until reversal.
  // Uses averaged 15/20/30-min EMA as trend line. Fires entry with TP1/TP2/TP3, manages trade,
  // exits on EMA cross-back, optionally reverses.
  // Removed from BTC: 0/6 -$872 on 5/6 in chop, volatile micro-structure doesn't suit averaged-EMA.
  if (isNAS && s.trv2TrendEma !== null && s.trv2Candles.length >= 30) {
    const tEma = s.trv2TrendEma;
    const spread = Math.abs(price - tEma);
    const spreadPct = (spread / tEma) * 100;
    const minSpreadPct = isBTC ? 0.08 : 0.06;
    const priceAbove = price > tEma;
    const priceBelow = price < tEma;
    const now3 = Date.now();

    // --- Calculate ATR from recent 1-min candles ---
    let trv2Atr = isBTC ? 120 : 30;
    if (s.trv2Candles.length >= 10) {
      const recentC = s.trv2Candles.slice(-10);
      const ranges = recentC.map(c => c.h - c.l);
      trv2Atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    }

    // --- TRADE MANAGEMENT (if trade is open) ---
    if (s.trv2Trade) {
      const t = s.trv2Trade;
      const isLong = t.dir === 'long';
      const pnl = isLong ? price - t.ep : t.ep - price;
      const pnlPct = (pnl / t.ep) * 100;

      // Track best price for trailing stop
      if (isLong && price > t.bestPrice) t.bestPrice = price;
      if (!isLong && price < t.bestPrice) t.bestPrice = price;

      // TP1 hit — move SL to breakeven
      if (!t.tp1Hit && ((isLong && price >= t.tp1) || (!isLong && price <= t.tp1))) {
        t.tp1Hit = true;
        t.trailSl = t.ep;
        log(sym, '🎯 TRv2 TP1 HIT — $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2) + ' (' + pnlPct.toFixed(2) + '%) · SL moved to breakeven $' + t.ep.toFixed(2));
        sendPush('🎯 ' + sym + ' TP1 HIT', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · SL → breakeven', 'signal');
      }

      // TP2 hit — trail SL to TP1
      if (!t.tp2Hit && ((isLong && price >= t.tp2) || (!isLong && price <= t.tp2))) {
        t.tp2Hit = true;
        t.trailSl = t.tp1;
        log(sym, '🎯 TRv2 TP2 HIT — $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2) + ' (' + pnlPct.toFixed(2) + '%) · SL trailed to TP1 $' + t.tp1.toFixed(2));
        sendPush('🎯 ' + sym + ' TP2 HIT', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · SL → TP1', 'signal');
      }

      // TP3 hit — close trade (full target)
      if (!t.tp3Hit && ((isLong && price >= t.tp3) || (!isLong && price <= t.tp3))) {
        t.tp3Hit = true;
        log(sym, '🏆 TRv2 TP3 HIT — FULL TARGET · $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2) + ' (' + pnlPct.toFixed(2) + '%)');
        sendPush('🏆 ' + sym + ' TP3 — FULL TARGET', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · close trade', 'signal');
        s.trv2Trade = null; s.trv2LastSignalTs = now3;
        s.trv2Dir = null; s.trv2DirTs = 0;
      }

      // Trailing SL hit — close trade
      if (s.trv2Trade && t.trailSl > 0) {
        const slHit = isLong ? price <= t.trailSl : price >= t.trailSl;
        if (slHit) {
          const slPnl = isLong ? t.trailSl - t.ep : t.ep - t.trailSl;
          log(sym, '🛑 TRv2 TRAIL SL HIT — $' + price.toFixed(2) + ' · SL was $' + t.trailSl.toFixed(2) + ' · P&L $' + slPnl.toFixed(2));
          sendPush('🛑 ' + sym + ' TRAIL SL', '$' + price.toFixed(2) + ' · P&L $' + slPnl.toFixed(2), 'signal');
          s.trv2Trade = null; s.trv2LastSignalTs = now3;
        }
      }

      // Initial SL hit (before TP1) — close trade
      if (s.trv2Trade && !t.tp1Hit) {
        const initSlHit = isLong ? price <= t.sl : price >= t.sl;
        if (initSlHit) {
          const slPnl = isLong ? t.sl - t.ep : t.ep - t.sl;
          log(sym, '🛑 TRv2 INITIAL SL HIT — $' + price.toFixed(2) + ' · SL $' + t.sl.toFixed(2) + ' · P&L $' + slPnl.toFixed(2));
          sendPush('🛑 ' + sym + ' SL HIT', '$' + price.toFixed(2) + ' · loss $' + slPnl.toFixed(2), 'signal');
          s.trv2Trade = null; s.trv2LastSignalTs = now3;
        }
      }

      // EXIT on EMA cross-back — requires sustained crossback (candle confirmations), not just a single tick
      // With macro trend: need 3 candle closes on wrong side (strong conviction to hold)
      // Against macro: need 2 candle closes (quicker exit when fighting the big trend)
      if (s.trv2Trade) {
        const tradeWithMacro = s.macroEma ? ((isLong && t.ep > s.macroEma) || (!isLong && t.ep < s.macroEma)) : false;
        const exitSpreadMin = isBTC ? 0.15 : 0.10; // wider than entry — need more evidence to close a trade
        const crossOnWrongSide = (isLong && priceBelow && spreadPct > exitSpreadMin) ||
                                  (!isLong && priceAbove && spreadPct > exitSpreadMin);
        const requiredCrosses = tradeWithMacro ? 3 : 2; // 3 candles (~3 min) with macro, 2 against

        if (crossOnWrongSide && s.trv2CrossCount >= requiredCrosses) {
          const exitPnl = isLong ? price - t.ep : t.ep - price;
          const exitPnlPct = (exitPnl / t.ep) * 100;
          log(sym, '🔄 TRv2 TREND REVERSED — closing ' + t.dir.toUpperCase() + ' · $' + price.toFixed(2) + ' crossed EMA $' + tEma.toFixed(2) + ' · ' + s.trv2CrossCount + ' candle confirmations · ' + (tradeWithMacro ? 'WITH' : 'AGAINST') + ' macro · P&L $' + exitPnl.toFixed(2) + ' (' + exitPnlPct.toFixed(2) + '%)');
          sendPush('🔄 ' + sym + ' TREND REVERSED', 'Close ' + t.dir.toUpperCase() + ' · $' + price.toFixed(2) + ' · P&L $' + exitPnl.toFixed(2), 'signal');

          // Log as exit signal + update cooldown timestamp to prevent rapid re-entry
          s.trv2LastSignalTs = now3;
          s.trv2CrossCount = 0;
          const exitDir = t.dir === 'long' ? 'call' : 'put';
          const exitSig = { type: 'exit-' + exitDir, time: ts(), price: price.toFixed(2), score: '🔄EXIT', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount, pnl: exitPnl.toFixed(2) };
          enrichSig(exitSig); s.signals.push(exitSig); logSignal(sym, exitSig);
          s.trv2Trade = null;
          s.trv2Dir = null; s.trv2DirTs = 0;

          // Auto-reverse: only if reversing INTO the macro trend (don't reverse against macro)
          // e.g. was LONG against macro, now reversing SHORT into macro = ok
          // was LONG WITH macro, now reversing SHORT against macro = DON'T
          const revDir = priceAbove ? 'long' : 'short';
          const revWithMacro = s.macroEma ? ((revDir === 'long' && price > s.macroEma) || (revDir === 'short' && price < s.macroEma)) : true;
          // ATR-scaled ROC for reverse (same logic as entry) — NAS100 only
          const revBaselineAtr = 30;
          const revAtrRatio = trv2Atr > 0 ? Math.min(revBaselineAtr / trv2Atr, 2.0) : 1.0;
          const revRocMin = NAS_ROC_THR * 0.5 * revAtrRatio;
          const revRocOk = (priceAbove && roc3 > revRocMin) || (priceBelow && roc3 < -revRocMin);
          // Session extreme gate for reverse too
          const revHiBlock = s.lastHiRevTs && (now3 - s.lastHiRevTs < 1800000) && revDir === 'long';
          const revLoBlock = s.lastLoRevTs && (now3 - s.lastLoRevTs < 1800000) && revDir === 'short';
          if (revHiBlock || revLoBlock) {
            log(sym, '🏔️ TRv2 auto-reverse ' + revDir.toUpperCase() + ' blocked — session extreme reversal signal active');
          } else if (revRocOk && revWithMacro) {
            // Unified TP/SL policy: SL=2×ATR, TP1=1.5×, TP2=2.5×, TP3=4× (min $5 for SL/TP1)
            const revMults = { sl: 2, t1: 1.5, t2: 2.5, t3: 4 };
            const revSl = revDir === 'long' ? price - Math.max(trv2Atr * revMults.sl, 5) : price + Math.max(trv2Atr * revMults.sl, 5);
            const revTp1 = revDir === 'long' ? price + Math.max(trv2Atr * revMults.t1, 5) : price - Math.max(trv2Atr * revMults.t1, 5);
            const revTp2 = revDir === 'long' ? price + trv2Atr * revMults.t2 : price - trv2Atr * revMults.t2;
            const revTp3 = revDir === 'long' ? price + trv2Atr * revMults.t3 : price - trv2Atr * revMults.t3;

            s.trv2Trade = { dir: revDir, ep: price, ts: now3, sl: revSl, tp1: revTp1, tp2: revTp2, tp3: revTp3, tp1Hit: false, tp2Hit: false, tp3Hit: false, bestPrice: price, atr: trv2Atr, trailSl: 0, isCfd: true };
            s.trv2Dir = revDir;
            s.trv2DirTs = now3;
            s.trv2LastSignalTs = now3;
            s.dailySignalCount++;
            const revType = revDir === 'long' ? 'call' : 'put';
            s.lastAT = revType; if (revType === 'call') s.nC++; else s.nP++;
            s.lastSignalDir = revType; s.lastSignalTs = now3; s.lastNTs = now3;
            const macroTag = revWithMacro ? '+MACRO' : '';
            const revSig = { type: revType, time: ts(), price: price.toFixed(2), score: (revDir === 'long' ? '⬆' : '⬇') + 'RIDE' + macroTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount, tp1: revTp1.toFixed(2), tp2: revTp2.toFixed(2), tp3: revTp3.toFixed(2), sl: revSl.toFixed(2) };
            enrichSig(revSig); s.signals.push(revSig); logSignal(sym, revSig);
            log(sym, '🔄 TRv2 AUTO-REVERSE ' + revDir.toUpperCase() + ' +MACRO — $' + price.toFixed(2) + ' · TP1 $' + revTp1.toFixed(2) + ' · TP2 $' + revTp2.toFixed(2) + ' · TP3 $' + revTp3.toFixed(2) + ' · SL $' + revSl.toFixed(2) + ' [#' + s.dailySignalCount + ']');
            sendPush('🔄 ' + sym + ' REVERSE ' + revDir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · TP1 $' + revTp1.toFixed(2) + ' · SL $' + revSl.toFixed(2), 'signal');
            s.trade = { active: true, type: revType, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, ts: Date.now(), pt1: 30, pt2: 60, sl2: 25, isTrend: true, isCfd: true, slPrice: revSl, tp1Price: revTp1, tp2Price: revTp2, tp3Price: revTp3, atr: trv2Atr, bestPrice: price, trailSl: 0 };
          } else {
            log(sym, '⏭️ TRv2 no auto-reverse — ' + (revWithMacro ? 'ROC too weak' : 'would reverse AGAINST macro (' + (s.macroEma ? '$' + s.macroEma.toFixed(2) : 'null') + ')'));
          }
          return;
        } else if (crossOnWrongSide) {
          // Price is on wrong side but not enough candle confirmations yet — log warning
          if (s.trv2CrossCount === 1) {
            log(sym, '⚠️ TRv2 ' + t.dir.toUpperCase() + ' — price crossed EMA ($' + tEma.toFixed(2) + ') · ' + s.trv2CrossCount + '/' + requiredCrosses + ' candle confirmations · holding...');
          }
        }
      }

      // If trade is still open, skip all other signal detectors — one trade at a time
      if (s.trv2Trade) return;
    }

    // --- ENTRY DETECTION (no trade open) ---
    // Fire when price separates from trend EMA with ROC confirming direction
    // Macro EMA (3h) as confidence filter: with macro = wider TP, against = tighter SL
    const macroDir = s.macroEma ? (price > s.macroEma ? 'bull' : 'bear') : null;

    // MINIMUM TREND AGE: after exit/reverse, require trend direction to hold 15+ min before new entry
    // Prevents rapid re-entry whipsaws on range-bound days where price oscillates around EMA
    const trendAgeMs = s.trv2DirTs ? now3 - s.trv2DirTs : Infinity;
    const minTrendAgeMs = 900000; // 15 minutes
    const trendAgeMature = trendAgeMs >= minTrendAgeMs;

    // TRv2 is now NAS100-only. No chop gating — NAS chop detector overfires on staircase trends
    // (94% chop=1 on +185pt day, 5/6). NAS TRv2 went 6/6 TP1 hit during "chop".
    // BTC was removed entirely from TRv2 due to 0/6 -$872 performance in chop.
    const entryReady = now3 - s.trv2LastSignalTs > 300000; // 5 min cooldown

    if (!s.trv2Trade && entryReady && spreadPct >= minSpreadPct && !trendAgeMature) {
      // Log once per minute when trend age is blocking
      if (!s._trendAgeLogTs || now3 - s._trendAgeLogTs > 60000) {
        log(sym, '⏳ TRv2 entry blocked — trend dir ' + (s.trv2Dir || '?') + ' only ' + Math.round(trendAgeMs / 1000) + 's old (need ' + Math.round(minTrendAgeMs / 1000) + 's)');
        s._trendAgeLogTs = now3;
      }
    }

    if (!s.trv2Trade && entryReady && spreadPct >= minSpreadPct && trendAgeMature) {
      // ATR-SCALED ROC FILTER: on low-vol days, raise ROC threshold to filter noise
      // When ATR is below baseline, multiply ROC requirement by (baseline/ATR) capped at 2x
      const baselineAtr = 30; // NAS100 only now
      const atrRatio = trv2Atr > 0 ? Math.min(baselineAtr / trv2Atr, 2.0) : 1.0;
      const entryRocBase = NAS_ROC_THR * 0.5;
      const entryRocMin = entryRocBase * atrRatio;
      let longOk = priceAbove && roc3 > entryRocMin && rsiV > 30 && rsiV < 75;
      let shortOk = priceBelow && roc3 < -entryRocMin && rsiV > 25 && rsiV < 70;

      // MACRO GATE: only enter in the direction of the macro (3h) trend
      // If macro is bull → only LONG. If macro is bear → only SHORT.
      // This prevents counter-trend entries that get chopped up in pullbacks.
      if (macroDir === 'bull' && shortOk) {
        log(sym, '⏭️ TRv2 SHORT blocked — macro is BULLISH (3h EMA $' + (s.macroEma ? s.macroEma.toFixed(2) : '?') + ')');
        shortOk = false;
      }
      if (macroDir === 'bear' && longOk) {
        log(sym, '⏭️ TRv2 LONG blocked — macro is BEARISH (3h EMA $' + (s.macroEma ? s.macroEma.toFixed(2) : '?') + ')');
        longOk = false;
      }

      // SESSION EXTREME GATE: block entries in same direction as recent HI/LO reversal
      // If ⬇HI fired in last 30 min → block LONG (don't buy the top)
      // If ⬆LO fired in last 30 min → block SHORT (don't sell the bottom)
      const hiRevRecent = s.lastHiRevTs && (now3 - s.lastHiRevTs < 1800000);
      const loRevRecent = s.lastLoRevTs && (now3 - s.lastLoRevTs < 1800000);
      if (hiRevRecent && longOk) {
        log(sym, '🏔️ TRv2 LONG blocked — ⬇HI reversal fired ' + Math.round((now3 - s.lastHiRevTs) / 60000) + 'm ago (suppress 30m)');
        longOk = false;
      }
      if (loRevRecent && shortOk) {
        log(sym, '🏔️ TRv2 SHORT blocked — ⬆LO reversal fired ' + Math.round((now3 - s.lastLoRevTs) / 60000) + 'm ago (suppress 30m)');
        shortOk = false;
      }

      if (longOk || shortOk) {
        const dir = longOk ? 'long' : 'short';
        // Unified TP/SL policy: SL=2×ATR, TP1=1.5×, TP2=2.5×, TP3=4× (min $5 for SL/TP1)
        const entMults = { sl: 2, t1: 1.5, t2: 2.5, t3: 4 };
        const sl = dir === 'long' ? price - Math.max(trv2Atr * entMults.sl, 5) : price + Math.max(trv2Atr * entMults.sl, 5);
        const tp1 = dir === 'long' ? price + Math.max(trv2Atr * entMults.t1, 5) : price - Math.max(trv2Atr * entMults.t1, 5);
        const tp2 = dir === 'long' ? price + trv2Atr * entMults.t2 : price - trv2Atr * entMults.t2;
        const tp3 = dir === 'long' ? price + trv2Atr * entMults.t3 : price - trv2Atr * entMults.t3;

        s.trv2Trade = { dir: dir, ep: price, ts: now3, sl: sl, tp1: tp1, tp2: tp2, tp3: tp3, tp1Hit: false, tp2Hit: false, tp3Hit: false, bestPrice: price, atr: trv2Atr, trailSl: 0, isCfd: true };
        s.trv2Dir = dir;
        s.trv2DirTs = now3;
        s.trv2LastSignalTs = now3;
        s.dailySignalCount++;
        const sigType = dir === 'long' ? 'call' : 'put';
        s.lastAT = sigType; if (sigType === 'call') s.nC++; else s.nP++;
        s.lastSignalDir = sigType; s.lastSignalTs = now3; s.lastNTs = now3;
        const macroTag = withMacro ? '+MACRO' : '';
        const sig = { type: sigType, time: ts(), price: price.toFixed(2), score: (dir === 'long' ? '⬆' : '⬇') + 'RIDE' + macroTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount, tp1: tp1.toFixed(2), tp2: tp2.toFixed(2), tp3: tp3.toFixed(2), sl: sl.toFixed(2) };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        log(sym, '🚀 TRv2 ENTRY ' + dir.toUpperCase() + (withMacro ? ' +MACRO' : '') + ' — $' + price.toFixed(2) + ' > EMA $' + tEma.toFixed(2) + ' (+' + spreadPct.toFixed(3) + '%) · ATR $' + trv2Atr.toFixed(2) + ' · TP1 $' + tp1.toFixed(2) + ' · TP2 $' + tp2.toFixed(2) + ' · TP3 $' + tp3.toFixed(2) + ' · SL $' + sl.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · TP1 $' + tp1.toFixed(2) + ' · TP2 $' + tp2.toFixed(2) + ' · TP3 $' + tp3.toFixed(2) + ' · SL $' + sl.toFixed(2), 'signal');
        s.trade = { active: true, type: sigType, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, ts: Date.now(), pt1: 30, pt2: 60, sl2: 25, isTrend: true, isCfd: true, slPrice: sl, tp1Price: tp1, tp2Price: tp2, tp3Price: tp3, atr: trv2Atr, bestPrice: price, trailSl: 0 };
        return;
      }
    }
  }

  // ===== MACRO TREND FLIP DETECTOR (XAU only — BTC/NAS100 use TRv2 trend-following system) =====
  // Fires when price crosses the 3-hour EMA with momentum confirmation
  // XAU SUPER SIGNAL: when TLT also flipped in same direction within 30 min — highest conviction
  // BTC/NAS100: handled by TRv2 above (15/20/30 averaged EMA with TP management)
  // MFLIP blocked during chop — macro flips during chop are unreliable (XAU 5/7: MFLIP CALL at top before sell-off, chop=1)
  if (isXAU && isMT5 && s.macroEma !== null && s.macroSnaps.length >= 4 && cool && (now2 - s.macroFlipTs > 900000) && !s.chopActive) {
    const curDir = price > s.macroEma ? 'bull' : 'bear';
    const spread = Math.abs(price - s.macroEma);
    const spreadPct = (spread / s.macroEma) * 100;
    const spreadMinPct = isBTC ? 0.05 : 0.03; // BTC needs wider separation (higher volatility)
    // Only fire when direction actually flips AND price has meaningful separation from EMA (not just touching)
    if (s.macroPrevDir !== null && curDir !== s.macroPrevDir && spreadPct > spreadMinPct) {
      // XAU: Check if TLT flipped in same direction within 30 min
      // BTC: Check if SPY is trending in same direction (risk-on/risk-off)
      let isSuper = false;
      if (isXAU) {
        const tltAligned = (curDir === 'bull' && tltDir === 'up') || (curDir === 'bear' && tltDir === 'down');
        const tltRecentFlip = tltFlipTs > 0 && (now2 - tltFlipTs < 1800000);
        isSuper = tltAligned && tltRecentFlip && (now2 - s.superFlipTs > 1800000);
      } else if (isBTC) {
        // BTC super: SPY trending in same direction (risk-on correlation)
        const spyState = S['SPY'];
        const spyDir = spyState && spyState.lastPrice > 0 && spyState.pE5 && spyState.pE13
          ? (spyState.pE5 > spyState.pE13 ? 'bull' : 'bear') : null;
        isSuper = spyDir === curDir && (now2 - s.superFlipTs > 1800000);
      }

      // SUPER FILTER: when TLT/SPY correlation confirms, the move is typically EXHAUSTED — skip signal
      // Data: SUPER 14.3% win rate vs MFLIP 61.5%. Correlation agreement = crowded trade = tops/bottoms
      if (isSuper) {
        s.superFlipTs = now2;
        log(sym, '⏭️ MACRO FLIP skipped — correlation confirmed (SUPER condition) · historically 14.3% win rate · move likely exhausted');
        s.macroPrevDir = curDir;
        // Don't fire — but do update prevDir so next real flip can detect properly
      }
      // MACRO FLIP CALL: was bearish, now price crossed above 3h EMA with upward ROC
      // RSI cap 60 for CALL (not 70): EMA is lagging — if RSI is already 65+ the rally is exhausted
      else if (curDir === 'bull' && roc3 > symRocThr && rsiV > 30 && rsiV < 60 && flipCoolFor('call') && winProtectDir !== 'put') {
        s.macroFlipTs = now2;
        s.macroPrevDir = curDir;
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆MFLIP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'call', price, atrVal, sym);
        log(sym, '🔀 MACRO FLIP CALL — trend turned bullish · price $' + price.toFixed(2) + ' > EMA $' + s.macroEma.toFixed(2) + ' (+' + spreadPct.toFixed(3) + '%) · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
        sendPush('🔀 ' + sym + ' MACRO FLIP CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · trend turned bullish · above 3h EMA', 'signal');
        s.trade = isMT5 ? buildCfdTrade('call', price, atrVal, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        return;
      }
      // MACRO FLIP PUT: was bullish, now price crossed below 3h EMA with downward ROC
      else if (curDir === 'bear' && roc3 < -symRocThr && rsiV > 30 && rsiV < 70 && flipCoolFor('put') && winProtectDir !== 'call') {
        s.macroFlipTs = now2;
        s.macroPrevDir = curDir;
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇MFLIP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
        log(sym, '🔀 MACRO FLIP PUT — trend turned bearish · price $' + price.toFixed(2) + ' < EMA $' + s.macroEma.toFixed(2) + ' (-' + spreadPct.toFixed(3) + '%) · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
        sendPush('🔀 ' + sym + ' MACRO FLIP PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · trend turned bearish · below 3h EMA', 'signal');
        s.trade = isMT5 ? buildCfdTrade('put', price, atrVal, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        return;
      }
    }
    // Update prevDir even when no signal fires — track the current state
    if (s.macroPrevDir === null || (spreadPct > 0.05 && curDir !== s.macroPrevDir)) {
      s.macroPrevDir = curDir;
    }
  }

  // ===== TREND RIDE DETECTOR (XAU only — BTC/NAS100 use TRv2 trend-following system) =====
  // Catches sustained directional moves where macro EMA confirms trend but short-term EMAs lag behind.
  // The macro EMA (3-hour) shows clear direction, price has meaningful separation, and multi-timeframe
  // ROC confirms momentum — fire a signal even when 5/13/34 EMAs haven't crossed yet.
  // Data: XAU $4577→$4594 ($17 rally) with macro EMA bullish at $4571 — 0 signals fired because EMAs lagged.
  // Trend Ride cooldown: 40 min for XAU
  const trCoolMs = 2400000;
  if (isXAU && isMT5 && s.macroEma !== null && s.macroSnaps.length >= 4 && cool && (now2 - s.trendRideLastTs > trCoolMs)) {
    const trDir = price > s.macroEma ? 'bull' : 'bear';
    const trSpread = Math.abs(price - s.macroEma);
    const trSpreadPct = (trSpread / s.macroEma) * 100;
    const trMinSpread = isBTC ? 0.35 : isNAS ? 0.20 : 0.15; // BTC raised from 0.25% — range-bound drift above EMA causes false CALLs
    // Minimum ROC: BTC 0.75x (0.0225), NAS 0.6x (0.015), XAU 0.5x (0.0125)
    // Full 1x blocks too many winners. 0.5x lets through noise (0.004%). Sweet spot in between.
    const trMinRoc = isBTC ? BTC_ROC_THR * 0.75 : isNAS ? NAS_ROC_THR * 0.6 : XAU_ROC_THR * 0.5;
    const roc6 = s._roc6 || 0;
    const trRoc3Ok = (trDir === 'bull' && roc3 > trMinRoc) || (trDir === 'bear' && roc3 < -trMinRoc);
    const trRoc6Ok = (trDir === 'bull' && roc6 > 0) || (trDir === 'bear' && roc6 < 0);
    // MACD must confirm trend direction — prevents firing against momentum
    const trMacdOk = (trDir === 'bull' && macdL > macdS) || (trDir === 'bear' && macdL < macdS);

    // Same-direction limiter: after 2 consecutive same-direction TRENDs, require price to have
    // moved meaningfully in the trend direction since last TREND (proves the trend is real, not range-bound)
    const trSigDir = trDir === 'bull' ? 'call' : 'put';
    let trSameDirOk = true;
    if (s.trendRideLastDir === trSigDir && s.trendRideSameDirCount >= 2 && s.trendRideLastPrice > 0) {
      const moveSinceLast = trSigDir === 'call' ? (price - s.trendRideLastPrice) / s.trendRideLastPrice * 100
                                                 : (s.trendRideLastPrice - price) / s.trendRideLastPrice * 100;
      const minMovePct = isBTC ? 0.15 : isNAS ? 0.10 : 0.02; // XAU lowered from 0.08% — data shows it blocks winners in slow downtrends
      const maxSameDir = isBTC ? 4 : isNAS ? 4 : 6; // hard cap: XAU allows more continuation (slow-grinding trends), BTC/NAS tighter
      if (s.trendRideSameDirCount >= maxSameDir) {
        trSameDirOk = false;
        log(sym, 'TREND RIDE blocked — hit max ' + maxSameDir + ' consecutive ' + trSigDir.toUpperCase() + 's');
      } else if (moveSinceLast < minMovePct) {
        trSameDirOk = false;
        log(sym, 'TREND RIDE blocked — ' + s.trendRideSameDirCount + ' consecutive ' + trSigDir.toUpperCase() + 's, only ' + moveSinceLast.toFixed(3) + '% move (need ' + minMovePct + '%)');
      }
    }

    // TREND RIDE extended flip guard: if the last signal was opposite-direction and fired within 30 min,
    // block TREND RIDE. The macro EMA (3-hour) lags badly at turning points — a FAST PUT at 4710 followed
    // by a TREND CALL at 4708 (13 min later) means the EMA hasn't caught up to the reversal yet.
    // The normal 10-min flipCool isn't enough for TREND RIDE because the macro EMA can stay wrong for hours.
    const trFlipGuardMs = 1800000; // 30 min
    const trFlipBlocked = s.lastSignalDir && s.lastSignalDir !== trSigDir && (now2 - s.lastNTs < trFlipGuardMs);
    if (trFlipBlocked) {
      log(sym, 'TREND RIDE blocked — last signal was ' + s.lastSignalDir.toUpperCase() + ' ' + Math.round((now2 - s.lastNTs) / 60000) + 'm ago (need 30m for opposite TREND)');
    }

    if (trSpreadPct >= trMinSpread && trRoc3Ok && trRoc6Ok && trMacdOk && trSameDirOk && !trFlipBlocked) {
      // Calculate 1-min ATR from vrevSnaps for dynamic stop loss
      // ATR = average of per-minute high-low ranges over last 10 minutes
      let trAtr = isBTC ? 50 : isNAS ? 15 : 3; // fallback defaults
      if (s.vrevSnaps.length >= 60) {
        const atrSnaps = s.vrevSnaps.filter(sn => sn.ts > now2 - 600000); // last 10 min
        if (atrSnaps.length >= 30) {
          const bucketSize = 60000; // 1-minute buckets
          const buckets = {};
          atrSnaps.forEach(sn => {
            const bk = Math.floor(sn.ts / bucketSize);
            if (!buckets[bk]) buckets[bk] = { hi: sn.p, lo: sn.p };
            if (sn.p > buckets[bk].hi) buckets[bk].hi = sn.p;
            if (sn.p < buckets[bk].lo) buckets[bk].lo = sn.p;
          });
          const ranges = Object.values(buckets).map(b => b.hi - b.lo);
          if (ranges.length >= 3) trAtr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
        }
      }
      const trSlMult = 2.5; // stop loss = 2.5x ATR — wide enough to survive noise
      const trSlDist = trAtr * trSlMult;
      const trMinSl = isBTC ? 80 : isNAS ? 25 : 4; // absolute minimum stop distance ($4 XAU, $25 NAS100, $80 BTC)
      const trSlFinal = Math.max(trSlDist, trMinSl);

      // MACD extremity gate (added 2026-05-07) — mirror of the FAST gate. Don't fire TREND
      // when MACD line is already at exhaustion in the trade direction. Empirical: 5/7 16:03 ET
      // ⬆TREND CALL at MACD +1.447 (way past XAU's typical ±1.0) lost — move had played out
      // by the time the TREND detector saw the directional bias. Per-instrument thresholds
      // because MACD scale differs ~100x across XAU/BTC/NAS100.
      const trMacdExtreme = isXAU ? 1.0 : isBTC ? 100 : isNAS ? 25 : 1.0;
      const trCallMacdOk = macdL < trMacdExtreme;   // CALL blocked when MACD already > +threshold
      const trPutMacdOk  = macdL > -trMacdExtreme;  // PUT  blocked when MACD already < -threshold
      // Throttled log when this gate blocks an otherwise-eligible TREND signal
      if (trDir === 'bull' && !trCallMacdOk && (now2 - (s.trendMacdBlockLogTs || 0) > 60000)) {
        log(sym, '📈 TREND CALL BLOCKED — MACD ' + macdL.toFixed(3) + ' >= +' + trMacdExtreme + ' (uptrend exhausted)');
        s.trendMacdBlockLogTs = now2;
      } else if (trDir === 'bear' && !trPutMacdOk && (now2 - (s.trendMacdBlockLogTs || 0) > 60000)) {
        log(sym, '📉 TREND PUT BLOCKED — MACD ' + macdL.toFixed(3) + ' <= -' + trMacdExtreme + ' (downtrend exhausted)');
        s.trendMacdBlockLogTs = now2;
      }

      // TREND RIDE CALL: macro bullish, price well above EMA, short+medium ROC both up
      // RSI cap: 75 for all — data shows RSI 74 CALLs win during genuine trends (5/1 23:16 BTC +0.72%)
      const trCallRsiMax = 75;
      if (trDir === 'bull' && rsiV > 30 && rsiV < trCallRsiMax && trCallMacdOk && flipCoolFor('call') && winProtectDir !== 'put') {
        const slPrice = price - trSlFinal;
        s.trendRideLastTs = now2;
        s.trendRideSameDirCount = (s.trendRideLastDir === 'call') ? s.trendRideSameDirCount + 1 : 1;
        s.trendRideLastDir = 'call'; s.trendRideLastPrice = price;
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆TREND', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        log(sym, '📈 TREND RIDE CALL — macro bullish · price $' + price.toFixed(2) + ' > EMA $' + s.macroEma.toFixed(2) + ' (+' + trSpreadPct.toFixed(2) + '%) · ATR $' + trAtr.toFixed(2) + ' · SL $' + slPrice.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('📈 ' + sym + ' TREND CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · SL $' + slPrice.toFixed(2) + ' · riding macro uptrend', 'signal');
        if (isMT5) attachTpSl(sig, 'call', price, trAtr, sym);
        s.trade = isMT5 ? buildCfdTrade('call', price, trAtr, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        s.trade.isTrend = true;
        return;
      }
      // TREND RIDE PUT: macro bearish, price well below EMA, short+medium ROC both down
      // RSI 35-70: floor raised from 25 — RSI 29.5 fired PUT at absolute bottom, bounced $5.65 (5/6 12:58)
      if (trDir === 'bear' && rsiV > 35 && rsiV < 70 && trPutMacdOk && flipCoolFor('put') && winProtectDir !== 'call') {
        const slPrice = price + trSlFinal;
        s.trendRideLastTs = now2;
        s.trendRideSameDirCount = (s.trendRideLastDir === 'put') ? s.trendRideSameDirCount + 1 : 1;
        s.trendRideLastDir = 'put'; s.trendRideLastPrice = price;
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇TREND', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        log(sym, '📉 TREND RIDE PUT — macro bearish · price $' + price.toFixed(2) + ' < EMA $' + s.macroEma.toFixed(2) + ' (-' + trSpreadPct.toFixed(2) + '%) · ATR $' + trAtr.toFixed(2) + ' · SL $' + slPrice.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('📉 ' + sym + ' TREND PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · SL $' + slPrice.toFixed(2) + ' · riding macro downtrend', 'signal');
        if (isMT5) attachTpSl(sig, 'put', price, trAtr, sym);
        s.trade = isMT5 ? buildCfdTrade('put', price, trAtr, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        s.trade.isTrend = true;
        return;
      }
    }
  }

  // ===== ATH/ATL REVERSAL DETECTOR (all MT5: XAU, BTC, NAS100) =====
  // Price reverses hard at multi-day highs/lows — institutional profit-taking, algo levels
  // Fires ONE high-confidence reversal signal when price touches 5-day extreme then pulls back
  // Once fired, won't re-fire until price re-approaches the extreme (resets the approach timestamp)
  // Per-instrument pullback thresholds: XAU $1, BTC $80, NAS100 $15
  const athAtlCooldown = 1200000; // 20 min cooldown between ATH/ATL signals
  const athAtlPullback = isBTC ? 80 : isNAS ? 15 : 1;       // min pullback to confirm rejection
  const athAtlMacdSkip = isBTC ? 200 : isNAS ? 40 : 3;      // skip MACD check for large pullbacks
  // Minimum rolling range: ATH/ATL is meaningless if the 5-day range is too tight
  // XAU needs >$15 range, BTC >$500, NAS >$100 for reversal signals to be meaningful
  const athAtlMinRange = isBTC ? 500 : isNAS ? 100 : 15;
  const athAtlRange = s.rollingHigh - (s.rollingLow === Infinity ? 0 : s.rollingLow);
  // Warmup guard: need at least 120 price samples (~2 min) for RSI to stabilize after restart
  // RSI sanity: if RSI < 10 or > 90, indicators are corrupted (reconnection gap, price spike).
  // NAS100 signal #15 on 5/6 had RSI 13.8, MACD -12.088 after what looks like a reconnection.
  const athAtlWarm = s.prices.length >= 120;
  const athAtlRsiSane = rsiV >= 10 && rsiV <= 90;
  if (isMT5 && s.rollingHigh > 0 && s.rollingLow < Infinity && cool && athAtlRange >= athAtlMinRange && athAtlWarm && athAtlRsiSane) {
    const distFromATH = s.rollingHigh - price;
    const distFromATL = price - s.rollingLow;
    const athApproachRecent = now2 - s.athApproachTs < 600000; // touched ATH zone in last 10 min
    const atlApproachRecent = now2 - s.atlApproachTs < 600000;

    // ATH REVERSAL → PUT: price was near 5-day high, now pulling back
    // Quality filters (backtested on 39 ATH PUT signals, 4/24–5/6):
    //   ROC3 < -0.02: kills weak pullbacks (false reversal noise). Blocked 3 marginal "wins" (+0.06%), caught 2 big losers.
    //   RSI > 60 AND MACD > 0: price still in bullish territory, "pullback" is just a dip in an uptrend.
    //   Combined: 25W/10L=71% → 21W/7L=75%, and the 3 blocked losers were the biggest (-0.66%, -0.45%, -0.33%).
    const athMacdOk = macdL < macdS || distFromATH >= athAtlMacdSkip;
    const athRocStrong = roc3 < -0.02; // minimum selling pressure — kills -0.009, -0.011 noise signals
    // NAS100: lower RSI threshold from 60→55. On 5/6, ATH PUT went 0/4 — signals #8 and #12 had RSI 56-57
    // with MACD>0, clearly still in uptrend. XAU/BTC keep 60 (backtested on XAU).
    const athBullRsiThr = isNAS ? 55 : 60;
    const athBullBlock = rsiV > athBullRsiThr && macdHist > 0; // RSI high + MACD bullish = still in uptrend, not a real reversal
    // Minimum conviction: require at least 2 cross-asset factors (same as ATL CALL)
    const athConv = convictionFor('put');
    const athConvOk = athConv.score >= 2;
    if (athApproachRecent && distFromATH >= athAtlPullback && s.rsiAtRollingHigh > 55 && athMacdOk && athRocStrong && !athBullBlock && athConvOk && flipCoolFor('put') && winProtectDir !== 'call') {
      if (s.lastSignalDir !== 'put' || (now2 - s.lastNTs > athAtlCooldown)) {
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇ATH', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
        log(sym, '🔻 ATH REVERSAL PUT — $' + distFromATH.toFixed(2) + ' off 5-day high $' + s.rollingHigh.toFixed(2) + ' RSI@ATH:' + s.rsiAtRollingHigh.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔻 ' + sym + ' ATH REVERSAL PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromATH.toFixed(2) + ' off ATH $' + s.rollingHigh.toFixed(2), 'signal');
        s.trade = isMT5 ? buildCfdTrade('put', price, atrVal, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        s.athApproachTs = 0; // clear so it won't re-fire until price re-touches ATH
        s.lastAthPutTs = now2; s.lastAthPutPrice = price; // track for failed pullback guard
        return;
      }
    }

    // ATL REVERSAL → CALL: price was near 5-day low, now bouncing
    // Lighter filters than ATH PUT — ATL bounces naturally start with small ROC, so tight ROC gate kills real signals.
    // Backtested: ROC>0.02 + bearBlock dropped ATL from 63% to 54% (blocked too many winners).
    // Minimum conviction: require at least 2 cross-asset factors.
    // Minimum ROC > 0.01: kills ROC 0.000% falling-knife signals (XAU 5/7: ATL CALL at ROC +0.000% in downtrend).
    // Failed bounce guard: if last ATL CALL was within 60 min and price is at/below that entry, the bounce
    // failed — don't fire another one into the same falling knife (XAU 5/7: two ATL CALLs $1 apart in 20 min).
    const atlMacdOk = macdL > macdS || distFromATL >= athAtlMacdSkip;
    const atlConv = convictionFor('call');
    const atlConvOk = atlConv.score >= 2;
    const atlRocMin = roc3 > 0.01; // require real positive momentum, not just > 0
    const atlBounceFailed = s.lastAtlCallTs && (now2 - s.lastAtlCallTs < 3600000) && price <= s.lastAtlCallPrice;
    if (atlApproachRecent && distFromATL >= athAtlPullback && s.rsiAtRollingLow < 45 && rsiV < 75 && atlMacdOk && atlRocMin && !atlBounceFailed && atlConvOk && flipCoolFor('call') && winProtectDir !== 'put') {
      if (s.lastSignalDir !== 'call' || (now2 - s.lastNTs > athAtlCooldown)) {
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆ATL', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'call', price, atrVal, sym);
        log(sym, '🚀 ATL REVERSAL CALL — $' + distFromATL.toFixed(2) + ' off 5-day low $' + s.rollingLow.toFixed(2) + ' RSI@ATL:' + s.rsiAtRollingLow.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' ATL REVERSAL CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromATL.toFixed(2) + ' off ATL $' + s.rollingLow.toFixed(2), 'signal');
        s.trade = isMT5 ? buildCfdTrade('call', price, atrVal, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        s.atlApproachTs = 0; // clear so it won't re-fire until price re-touches ATL
        s.lastAtlCallTs = now2; s.lastAtlCallPrice = price; // track for failed bounce guard
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
    if (shakeoutCool && (isXAU || s.dailySignalCount < MAX_SIG)) {
      const isCallRecovery = s.shakeoutDir === 'call' && price > s.shakeoutEp && fireCall && roc3 > symRocThr;
      const isPutRecovery = s.shakeoutDir === 'put' && price < s.shakeoutEp && firePut && roc3 < -symRocThr;
      if (isCallRecovery) {
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆REC', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'call', price, atrVal, sym);
        log(sym, '🔄 SHAKEOUT RECOVERY CALL — price $' + price.toFixed(2) + ' recovered past entry $' + s.shakeoutEp.toFixed(2) + ' after SL @ $' + s.shakeoutPrice.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' RECOVERY CALL #' + s.dailySignalCount, '$' + sig.price + ' · Recovered from SL @ $' + s.shakeoutPrice.toFixed(2), 'signal');
        s.trade = isMT5 ? buildCfdTrade('call', price, atrVal, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        s.shakeoutDir = null; // Clear shakeout state
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
        return;
      }
      if (isPutRecovery) {
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇REC', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
        log(sym, '🔄 SHAKEOUT RECOVERY PUT — price $' + price.toFixed(2) + ' recovered past entry $' + s.shakeoutEp.toFixed(2) + ' after SL @ $' + s.shakeoutPrice.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' RECOVERY PUT #' + s.dailySignalCount, '$' + sig.price + ' · Recovered from SL @ $' + s.shakeoutPrice.toFixed(2), 'signal');
        s.trade = isMT5 ? buildCfdTrade('put', price, atrVal, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        s.shakeoutDir = null;
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
        return;
      }
    }
  }

  // === WINNING TRADE PROTECTION (regular signals — backup for global guard above) ===
  // Global winProtectDir guard blocks all specialized detectors already.
  // This is a safety net for regular 5/6, 6/6 signals + provides a log message.
  if (isMT5 && s.trade.active) {
    const tDir = s.trade.type; // current trade direction
    const tPnl = tDir === 'call' ? price - s.trade.ep : s.trade.ep - price; // current P&L in $
    const minProfit = isBTC ? 50 : isNAS ? 10 : isXAU ? 2 : 0.20; // minimum profit to protect ($2 for XAU, $50 for BTC, $10 for NAS100)
    if (tPnl >= minProfit) {
      // Trade is in profit — block opposite-direction regular signal
      if ((tDir === 'call' && firePut && pS >= minS) || (tDir === 'put' && fireCall && cS >= minS)) {
        log(sym, '🛡️ Winning trade protected: ' + tDir.toUpperCase() + ' +$' + tPnl.toFixed(2) + ' — blocking opposite ' + (tDir === 'call' ? 'PUT' : 'CALL') + ' signal');
        return;
      }
    }
  }

  // === SESSION HIGH CALL BLOCKER ===
  // Data shows 14 QQQ + 10 SPY bad CALLs fired right at session high — almost all losers.
  // Block CALL signals when price is within 0.05% of session high (for equities + XAU/BTC).
  // The move has peaked — a CALL here is chasing the top.
  if (s.sessionHigh > 0 && s.sessionLow < Infinity && fireCall && cS >= minS) {
    const distFromSessHigh = s.sessionHigh - price;
    const sessRange = s.sessionHigh - s.sessionLow;
    const pctFromHigh = sessRange > 0 ? (distFromSessHigh / s.sessionHigh) * 100 : 99;
    // Block if within 0.05% of session high AND session has meaningful range (not first few ticks)
    if (pctFromHigh < 0.05 && sessRange > (isBTC ? 50 : isNAS ? 20 : isXAU ? 2 : 0.30)) {
      log(sym, '🛑 CALL blocked at session high — $' + price.toFixed(2) + ' is ' + pctFromHigh.toFixed(3) + '% from high $' + s.sessionHigh.toFixed(2) + ' (range $' + sessRange.toFixed(2) + ')');
      fireCall = false;
    }
  }

  // Overbought RSI CALL blocker — equities only (QQQ 31% win, SPY 43% win when RSI>70)
  if (!isMT5 && fireCall && cS >= minS && rsiV > 70) {
    log(sym, '🛑 CALL blocked: overbought RSI ' + rsiV.toFixed(1) + ' > 70 — chasing momentum');
    fireCall = false;
  }

  // === MT5 SESSION GATE — block 6/6 regular signals during low-trend sessions ===
  // XAU: allowed ALL sessions (Asia still requires 6/6 via sessionThr, plus Asia ROC gate)
  // BTC: only fire 6/6 during US session (09:30-16:00 ET) and pre-US (08:00-09:30 ET)
  // NAS100: US + pre-US + Europe
  if (isMT5 && !isXAU && (cS >= minS || pS >= minS)) {
    const mt5SessionOk = isBTC ? (btcSession === 'us' || btcSession === 'pre_us') : isNAS ? (nasSession === 'us' || nasSession === 'pre_us' || nasSession === 'europe') : true;
    if (!mt5SessionOk) {
      log(sym, '🕐 6/6 regular blocked: off-session (' + (isBTC ? btcSession : nasSession) + ') — only special detectors fire');
      return;
    }
  }

  // === MT5 MINIMUM ROC GATE — block 6/6 regular signals when ROC is noise ===
  // Data: XAU CALL at 09:38 with ROC +0.010% lost -0.49% — ROC was just noise during a strong downtrend
  // Require |ROC-3| >= 0.015% for MT5 6/6 signals to confirm actual directional momentum
  if (isMT5) {
    const absRoc = Math.abs(roc3);
    const mt5MinRoc = 0.015; // % threshold — below this, ROC is noise
    if (fireCall && cS >= minS && absRoc < mt5MinRoc) {
      log(sym, '🛑 CALL blocked: ROC ' + roc3.toFixed(3) + '% too weak (need ±' + mt5MinRoc + '%) — noise, not momentum');
      fireCall = false;
    }
    if (firePut && pS >= finalMinS && absRoc < mt5MinRoc) {
      log(sym, '🛑 PUT blocked: ROC ' + roc3.toFixed(3) + '% too weak (need ±' + mt5MinRoc + '%) — noise, not momentum');
      firePut = false;
    }
  }

  // === BTC OVERCONFIRMATION BLOCK — 7/6 means move is already exhausted ===
  // Data: BTC 7/6 = 0/2 wins, both big losers (-0.32%, -0.72%). When every indicator confirms, the move is done.
  if (isBTC) {
    if (fireCall && cS > mi) {
      log(sym, '🛑 CALL blocked: overconfirmation ' + cS + '/' + mi + ' — all indicators agree = move exhausted');
      fireCall = false;
    }
    if (firePut && pS > mi) {
      log(sym, '🛑 PUT blocked: overconfirmation ' + pS + '/' + mi + ' — all indicators agree = move exhausted');
      firePut = false;
    }
  }

  // === FIRE SIGNALS (0DTE indicator engine — QQQ/SPY/XAU/LABU only) ===
  // BTC/NAS100 use TRv2 trend-following system exclusively — block base engine
  if (isBTC || isNAS) {
    // Don't fire 6/6 indicator signals for BTC/NAS100 — TRv2 handles them
    return;
  }
  if (fireCall && cool && flipCoolFor('call')) {
    s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
    if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
    s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
    s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
    const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: cS + '/' + mi, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
    if (!enrichSig(sig)) return; s.signals.push(sig);
    logSignal(sym, sig);
    const convLbl = sig.conv ? ' [' + sig.conv.label + ' ' + sig.conv.score + '/7]' : '';
    log(sym, '🚀 CALL ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + convLbl + ' [#' + s.dailySignalCount + ']');
    sendPush('🚀 ' + sym + ' CALL ' + sig.score + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc + (sig.conv ? ' · ' + sig.conv.label + ' ' + sig.conv.score + '/7' : ''), 'signal');
    if (isMT5) attachTpSl(sig, 'call', price, atrVal, sym);
    // Activate trade monitor for this signal
    s.trade = isMT5 ? buildCfdTrade('call', price, atrVal, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
    // Cross-asset
    SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
  } else if (firePut && cool && flipCoolFor('put')) {
    s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
    if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
    s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
    s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
    const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: pS + '/' + mi, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
    if (!enrichSig(sig)) return; s.signals.push(sig);
    logSignal(sym, sig);
    const convLbl2 = sig.conv ? ' [' + sig.conv.label + ' ' + sig.conv.score + '/7]' : '';
    log(sym, '📉 PUT ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + convLbl2 + ' [#' + s.dailySignalCount + ']');
    sendPush('📉 ' + sym + ' PUT ' + sig.score + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc + (sig.conv ? ' · ' + sig.conv.label + ' ' + sig.conv.score + '/7' : ''), 'signal');
    if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
    // Activate trade monitor for this signal
    s.trade = isMT5 ? buildCfdTrade('put', price, atrVal, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
    SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
  }
}

// ===== ATR-BASED TRADE BUILDER (XAU/BTC/NAS100 — CFD signals) =====
// Creates trade object with price-based TP/SL levels from ATR
// TP1=1x ATR, TP2=2x ATR, TP3=3x ATR, SL=1.5x ATR
function buildCfdTrade(type, price, atr, sym) {
  const iC = type === 'call';
  // Unified TP/SL policy: SL=2×ATR, TP1=1.5×, TP2=2.5×, TP3=4×
  const mults = { sl: 2, t1: 1.5, t2: 2.5, t3: 4 };
  // Minimum $5 for SL and TP1 — prevents noise-level levels during low-ATR periods
  // XAU max $10 cap — keeps risk tight on gold's typical ATR range
  const isXAU = sym === 'XAU';
  const slDist = isXAU ? Math.min(Math.max(atr * mults.sl, 5), 10) : Math.max(atr * mults.sl, 5);
  const tp1Dist = isXAU ? Math.min(Math.max(atr * mults.t1, 5), 10) : Math.max(atr * mults.t1, 5);
  const tp2Dist = atr * mults.t2;
  const tp3Dist = atr * mults.t3;
  const sl = iC ? price - slDist : price + slDist;
  const tp1 = iC ? price + tp1Dist : price - tp1Dist;
  const tp2 = iC ? price + tp2Dist : price - tp2Dist;
  const tp3 = iC ? price + tp3Dist : price - tp3Dist;
  return {
    active: true, type: type, ep: price,
    t1: false, t2: false, sl: false, rev: false,
    lastETs: 0,
    ts: Date.now(),  // entry timestamp — used by reversal-warning hold gate
    slPrice: sl, tp1Price: tp1, tp2Price: tp2, tp3Price: tp3,
    atr: atr, bestPrice: price, trailSl: 0,
    isCfd: true
  };
}

// Attaches TP/SL levels to a signal object (for display in bots/mobile)
function attachTpSl(sig, type, price, atr, sym) {
  const iC = type === 'call';
  // Unified TP/SL policy: SL=2×ATR, TP1=1.5×, TP2=2.5×, TP3=4×
  // XAU: SL and TP1 clamped to $5–$10 range
  const mults = { sl: 2, t1: 1.5, t2: 2.5, t3: 4 };
  const isXAU = sym === 'XAU';
  const tp1D = isXAU ? Math.min(Math.max(atr * mults.t1, 5), 10) : Math.max(atr * mults.t1, 5);
  const slD = isXAU ? Math.min(Math.max(atr * mults.sl, 5), 10) : Math.max(atr * mults.sl, 5);
  sig.tp1 = (iC ? price + tp1D : price - tp1D).toFixed(2);
  sig.tp2 = (iC ? price + atr * mults.t2 : price - atr * mults.t2).toFixed(2);
  sig.tp3 = (iC ? price + atr * mults.t3 : price - atr * mults.t3).toFixed(2);
  sig.sl = (iC ? price - slD : price + slD).toFixed(2);
  return sig;
}

// ===== EXIT MONITOR =====
function checkExit(sym, price) {
  const s = S[sym], t = s.trade;
  if (!t.active || !t.ep || price <= 0) return;
  const iC = t.type === 'call';
  const pnl = iC ? price - t.ep : t.ep - price;

  // --- CFD trades (XAU/BTC/NAS100) — ATR-based price levels ---
  if (t.isCfd && t.slPrice) {
    const now = Date.now();
    // Track best price for trailing
    if (iC && price > t.bestPrice) t.bestPrice = price;
    if (!iC && price < t.bestPrice) t.bestPrice = price;

    // TP1 hit → move SL to breakeven
    if (!t.t1 && ((iC && price >= t.tp1Price) || (!iC && price <= t.tp1Price))) {
      t.t1 = true; t.trailSl = t.ep; t.lastETs = now;
      log(sym, '🎯 TP1 HIT — $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2) + ' · SL → breakeven $' + t.ep.toFixed(2));
      sendPush('🎯 ' + sym + ' TP1 HIT', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · SL → breakeven', 'signal');
    }
    // TP2 hit → trail SL to TP1
    if (!t.t2 && ((iC && price >= t.tp2Price) || (!iC && price <= t.tp2Price))) {
      t.t2 = true; t.trailSl = t.tp1Price; t.lastETs = now;
      log(sym, '🎯 TP2 HIT — $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2) + ' · SL → TP1 $' + t.tp1Price.toFixed(2));
      sendPush('🎯 ' + sym + ' TP2 HIT', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · SL → TP1', 'signal');
    }
    // TP3 hit → full exit
    if (!t.sl && ((iC && price >= t.tp3Price) || (!iC && price <= t.tp3Price))) {
      t.sl = true; t.lastETs = now;
      log(sym, '🏆 TP3 FULL TARGET — $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2));
      sendPush('🏆 ' + sym + ' TP3 — FULL TARGET', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · close trade', 'signal');
      s.trade = { active: false };
      return;
    }
    // Trail SL hit (after TP1)
    if (t.trailSl > 0) {
      const tsHit = iC ? price <= t.trailSl : price >= t.trailSl;
      if (tsHit) {
        const tsPnl = iC ? t.trailSl - t.ep : t.ep - t.trailSl;
        t.sl = true; t.lastETs = now;
        log(sym, '🛑 TRAIL SL — $' + price.toFixed(2) + ' · SL was $' + t.trailSl.toFixed(2) + ' · P&L $' + tsPnl.toFixed(2));
        sendPush('🛑 ' + sym + ' TRAIL SL', '$' + price.toFixed(2) + ' · P&L $' + tsPnl.toFixed(2), 'exit');
        s.trade = { active: false };
        return;
      }
    }
    // Initial SL hit (before TP1)
    if (!t.t1) {
      const slHit = iC ? price <= t.slPrice : price >= t.slPrice;
      if (slHit) {
        t.sl = true; t.lastETs = now;
        s.shakeoutDir = t.type; s.shakeoutTs = now; s.shakeoutPrice = price; s.shakeoutEp = t.ep;
        const slPnl = iC ? t.slPrice - t.ep : t.ep - t.slPrice;
        log(sym, '🛑 SL HIT — ' + t.type.toUpperCase() + ' $' + price.toFixed(2) + ' · SL $' + t.slPrice.toFixed(2) + ' · P&L $' + slPnl.toFixed(2));
        sendPush('🛑 ' + sym + ' SL HIT', t.type.toUpperCase() + ' · loss $' + slPnl.toFixed(2) + ' — exit now', 'exit');
        s.trade = { active: false };
        return;
      }
    }
    // Reversal detection (indicator-based, for early warning)
    const e5b = s.pE5 > s.pE13, e13b = s.pE13 > s.pE34;
    const roc3Now = s.prices.length >= 4 ? calcROC(s.prices, 3) : 0;
    let fl = 0;
    if (iC) { if (!e5b) fl++; if (!e13b) fl++; if (roc3Now < 0) fl++; }
    else { if (e5b) fl++; if (e13b) fl++; if (roc3Now > 0) fl++; }
    // Reversal gates: 3/3 indicators flipped + 2 min since last exit event + trade open at least REV_MIN_HOLD_MS.
    // The hold gate (added 2026-05-07) stops reversal warnings firing immediately after entry —
    // lastETs starts at 0 so the cooldown alone never protects fresh trades.
    // Profitability gate (added 2026-05-07): only auto-close on reversal when P&L is positive
    // (lock in the win). Losing trades stay open — let them work toward the ATR-based SL or recover.
    const heldLongEnough = t.ts && (now - t.ts > REV_MIN_HOLD_MS);
    if (fl >= 3 && !t.rev && now - t.lastETs > 120000 && heldLongEnough) {
      if (pnl > 0) {
        // Profitable + indicators flipped → exit now to lock in the win
        t.rev = true; t.lastETs = now;
        log(sym, '🎯 REVERSAL EXIT — locking +$' + pnl.toFixed(2) + ' · ' + fl + '/3 indicators flipped · age ' + Math.round((now - t.ts) / 60000) + 'min');
        sendPush('🎯 ' + sym + ' REVERSAL EXIT', '+$' + pnl.toFixed(2) + ' locked · ' + fl + '/3 flipped — close now', 'exit');
      } else {
        // Not profitable yet — don't auto-close. Trade either recovers or hits SL.
        // Log once per minute (no push) so the user can see in logs without notification spam.
        if (now - (t.lastRevHoldLog || 0) > 60000) {
          log(sym, '⏸ Reversal detected but trade negative ($' + pnl.toFixed(2) + ') — holding for recovery or SL');
          t.lastRevHoldLog = now;
        }
        // Note: t.rev stays false here, so this branch can re-evaluate later if P&L flips positive.
      }
    } else if (fl >= 3 && !t.rev && t.ts && !heldLongEnough) {
      // Suppressed — log once per minute so the user can see it in logs but no spam
      const ageMin = Math.round((now - t.ts) / 60000);
      const holdMin = Math.round(REV_MIN_HOLD_MS / 60000);
      if (now - (t.lastRevSuppressLog || 0) > 60000) {
        log(sym, '… REVERSAL suppressed — trade age ' + ageMin + 'min < ' + holdMin + 'min hold (signal needs time to play out)');
        t.lastRevSuppressLog = now;
      }
    }
    return;
  }

  // --- Legacy 0DTE trades (QQQ/SPY/LABU) — percentage-based ---
  const raw = ((price - t.ep) / t.ep) * 100, dm = iC ? raw : -raw;
  const e5b = s.pE5 > s.pE13, e13b = s.pE13 > s.pE34;
  const mb = s.pMF && s.pMS && s.pMSig ? (s.pMF - s.pMS) > s.pMSig : false;
  const roc3Now = s.prices.length >= 4 ? calcROC(s.prices, 3) : 0;
  let fl = 0;
  if (iC) { if (!e5b) fl++; if (!e13b) fl++; if (roc3Now < 0) fl++; if (!mb) fl++; }
  else { if (e5b) fl++; if (e13b) fl++; if (roc3Now > 0) fl++; if (mb) fl++; }
  const now = Date.now(), cd = now - t.lastETs > 120000;
  const pt1 = t.pt1 || 30, pt2 = t.pt2 || 60, sl2 = t.sl2 || 25;
  if (!t.sl && dm <= -sl2) {
    t.sl = true; t.lastETs = now;
    s.shakeoutDir = t.type; s.shakeoutTs = now; s.shakeoutPrice = price; s.shakeoutEp = t.ep;
    log(sym, '🛑 STOP LOSS — ' + t.type.toUpperCase() + ' ' + dm.toFixed(2) + '%');
    sendPush('🛑 STOP LOSS ' + sym, t.type.toUpperCase() + ' ' + dm.toFixed(2) + '% — exit now', 'exit');
  } else if (!t.t2 && dm >= pt2) {
    t.t2 = true; t.lastETs = now;
    log(sym, '💰 PT2 +' + dm.toFixed(2) + '% — FULL EXIT');
    sendPush('💰 PT2 ' + sym, '+' + dm.toFixed(2) + '% — close full position', 'exit');
  } else if (!t.t1 && dm >= pt1) {
    t.t1 = true; t.lastETs = now;
    log(sym, '💰 PT1 +' + dm.toFixed(2) + '% — PARTIAL EXIT');
    sendPush('💰 PT1 ' + sym, '+' + dm.toFixed(2) + '% — close 50%', 'exit');
  } else if (fl >= 3 && cd && !t.sl && !t.rev && t.ts && (now - t.ts > REV_MIN_HOLD_MS)) {
    // Same hold gate + profitability gate as CFD path: only auto-exit if trade is positive.
    if (dm > 0) {
      t.rev = true; t.lastETs = now;
      log(sym, '🎯 REVERSAL EXIT — locking +' + dm.toFixed(2) + '% · ' + fl + '/4 flipped · age ' + Math.round((now - t.ts) / 60000) + 'min');
      sendPush('🎯 REVERSAL EXIT ' + sym, '+' + dm.toFixed(2) + '% locked · ' + fl + '/4 flipped — close now', 'exit');
    } else if (now - (t.lastRevHoldLog || 0) > 60000) {
      log(sym, '⏸ Reversal detected but trade negative (' + dm.toFixed(2) + '%) — holding for recovery or SL');
      t.lastRevHoldLog = now;
    }
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
    const hi = Math.max(...s.tickBuf.map(t => t.h || t.p));
    const lo = Math.min(...s.tickBuf.map(t => t.l || t.p));
    s.tickBuf = [];
    processPrice(sym, price, hi, lo);

    // 5-minute candle aggregation for proper ATR (MT5 instruments send 1 tick/sec — tick-level hi≈lo gives ATR≈0)
    if (sym === 'XAU' || sym === 'BTC' || sym === 'NAS100') {
      const bNow5 = Date.now();
      if (!s.atrCurCandle) {
        s.atrCurCandle = { o: price, h: hi, l: lo, c: price, startTs: bNow5 };
      } else {
        if (hi > s.atrCurCandle.h) s.atrCurCandle.h = hi;
        if (lo < s.atrCurCandle.l) s.atrCurCandle.l = lo;
        s.atrCurCandle.c = price;
        // Close candle after 5 minutes
        if (bNow5 - s.atrCurCandle.startTs >= 300000) {
          s.atrCandles.push({ o: s.atrCurCandle.o, h: s.atrCurCandle.h, l: s.atrCurCandle.l, c: s.atrCurCandle.c, ts: s.atrCurCandle.startTs });
          if (s.atrCandles.length > 20) s.atrCandles.shift();
          s.atrCurCandle = { o: price, h: price, l: price, c: price, startTs: bNow5 };
        }
      }
    }

    // Macro trend snapshots — MT5 instruments (XAU + BTC), every 5 min, 6-hour rolling window
    if ((sym === 'XAU' || sym === 'BTC' || sym === 'NAS100') && (Date.now() - s.macroLastSnapTs >= 300000)) {
      s.macroLastSnapTs = Date.now();
      s.macroSnaps.push({ ts: Date.now(), p: price });
      if (s.macroSnaps.length > 72) s.macroSnaps.shift(); // keep 6 hours
      // Slow EMA on snapshots (period 36 = ~3 hours of 5-min bars)
      const emaK = 2 / (36 + 1);
      s.macroEma = s.macroEma === null ? price : price * emaK + s.macroEma * (1 - emaK);
    }

    // Symbol type flags (used by all tick-level trackers below)
    const isXAUt = sym === 'XAU';
    const isBTCt = sym === 'BTC';
    const isNASt = sym === 'NAS100';

    // V-Reversal snapshots — MT5 instruments, every tick, keep 20 min (max 1200 at 1s interval)
    if (isXAUt || isBTCt || isNASt) {
      s.vrevSnaps.push({ ts: Date.now(), p: price });
      const cutoff = Date.now() - 1200000; // 20 min
      while (s.vrevSnaps.length > 0 && s.vrevSnaps[0].ts < cutoff) s.vrevSnaps.shift();
    }

    // === TREND RIDE TRAILING STOP — monitor every tick for TREND signals ===
    // Dynamic ATR-based stop with trailing: breakeven at 1x ATR profit, trail at 1x ATR after 2x ATR profit
    if ((isXAUt || isBTCt || isNASt) && s.trade.active && s.trade.isTrend) {
      const t = s.trade;
      const tPnl = t.type === 'call' ? price - t.ep : t.ep - price;
      const atr = t.atr || (isBTCt ? 50 : sym === 'NAS100' ? 15 : 3);

      // Track best price for trailing
      if (t.type === 'call' && price > t.bestPrice) t.bestPrice = price;
      if (t.type === 'put' && price < t.bestPrice) t.bestPrice = price;

      // Trailing stop logic — ratchet up as profit grows
      const bestPnl = t.type === 'call' ? t.bestPrice - t.ep : t.ep - t.bestPrice;
      let newSl = t.slPrice;

      if (bestPnl >= atr * 2) {
        // 2x ATR profit reached → trail at bestPrice - 1x ATR (lock in 1x ATR profit)
        newSl = t.type === 'call' ? t.bestPrice - atr : t.bestPrice + atr;
      } else if (bestPnl >= atr) {
        // 1x ATR profit reached → move stop to breakeven (entry price)
        newSl = t.ep;
      }

      // Only ratchet stop in profitable direction (never widen)
      if (t.type === 'call' && newSl > t.slPrice) t.slPrice = newSl;
      if (t.type === 'put' && newSl < t.slPrice) t.slPrice = newSl;

      // Check if stop is hit
      const stopped = (t.type === 'call' && price <= t.slPrice) || (t.type === 'put' && price >= t.slPrice);
      if (stopped) {
        const slPnl = t.type === 'call' ? t.slPrice - t.ep : t.ep - t.slPrice;
        const slResult = slPnl >= 0 ? 'BREAKEVEN' : 'STOPPED';
        log(sym, '🛑 TREND ' + t.type.toUpperCase() + ' ' + slResult + ' — SL hit $' + t.slPrice.toFixed(2) + ' · entry $' + t.ep.toFixed(2) + ' · P&L $' + slPnl.toFixed(2) + ' · best $' + t.bestPrice.toFixed(2));
        sendPush('🛑 ' + sym + ' TREND ' + slResult, 'SL $' + t.slPrice.toFixed(2) + ' hit · entry $' + t.ep.toFixed(2) + ' · P&L $' + slPnl.toFixed(2), 'alert');
        s.trade = { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
      }
    }

    // Consolidation Breakout tracker — MT5 instruments (XAU + BTC), every tick
    // Tracks rolling 5-min high/low range. When range stays tight for 3+ min, marks "coiling".
    // Breakout fires the instant price escapes the range — no lagging indicator delay.
    // Thresholds scale per instrument:
    //   XAU (~$3300): coil < $4, escape $1
    //   BTC (~$90K):  coil < $120, escape $30
    if (isXAUt || isBTCt || isNASt) {
      const coilMaxRange = isBTCt ? 120.0 : isNASt ? 30.0 : 10.0;  // max range to count as consolidation (XAU was $6 — too tight, missed $9-range coils)
      const escapeMin    = isBTCt ? 30.0  : isNASt ? 8.0  : 1.5;   // min distance beyond coil edge = confirmed breakout (XAU raised to $1.50)
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
        if (bRange < coilMaxRange && !s.breakCoilActive) {
          // NEW COIL — freeze the boundaries at this moment
          s.breakCoilStart = bNow;
          s.breakCoilActive = true;
          s.breakFrozenHi = bHi;  // locked coil high — won't move with rolling window
          s.breakFrozenLo = bLo;  // locked coil low
        } else if (s.breakCoilActive && bRange < coilMaxRange) {
          // STILL COILING — boundaries stay FROZEN. Do not update.
          // If we widen them, the breakout detection drifts with price (the original bug).
        }

        // BREAKOUT CHECK — every tick while coil is active, compare price to FROZEN boundaries
        if (s.breakCoilActive) {
          const coilDuration = bNow - s.breakCoilStart;
          const coilCoolOk = bNow - s.breakLastTs > 300000; // 5-min cooldown between breakouts
          const brokeUp = price > s.breakFrozenHi + escapeMin;
          const brokeDown = price < s.breakFrozenLo - escapeMin;

          if ((brokeUp || brokeDown) && coilDuration >= 180000 && coilCoolOk) {
            // Calculate velocity — how fast did price move in last 10s vs prior 60s
            const last10 = s.breakRange.filter(b => b.ts > bNow - 10000);
            const last60 = s.breakRange.filter(b => b.ts > bNow - 60000 && b.ts <= bNow - 10000);
            const vel10 = last10.length >= 2 ? Math.abs(last10[last10.length - 1].p - last10[0].p) / (last10.length || 1) : 0;
            const vel60 = last60.length >= 5 ? Math.abs(last60[last60.length - 1].p - last60[0].p) / (last60.length || 1) : 0;
            const accel = vel60 > 0 ? vel10 / vel60 : vel10 > 0 ? 10 : 0;

            // Fire if accelerating (>= 1.5x) OR if escape distance is large enough (2x escapeMin)
            const bigEscape = brokeUp ? (price - s.breakFrozenHi) >= escapeMin * 2 : (s.breakFrozenLo - price) >= escapeMin * 2;
            if (accel >= 1.5 || bigEscape) {
              s._pendingBreakout = {
                dir: brokeUp ? 'call' : 'put',
                coilHi: s.breakFrozenHi,
                coilLo: s.breakFrozenLo,
                coilDuration: coilDuration,
                accel: accel,
                escape: brokeUp ? +(price - s.breakFrozenHi).toFixed(2) : +(s.breakFrozenLo - price).toFixed(2)
              };
              s.breakCoilActive = false; // breakout found — end coil
            }
          }

          // If range expanded way beyond coil without triggering breakout, end the coil
          // (e.g., slow grind without acceleration — not a real breakout, just wider ranging)
          if (s.breakCoilActive && bRange > coilMaxRange * 2.5) {
            s.breakCoilActive = false;
          }
        }
      }
    }

    // === ORDER BLOCK TRACKING — detect departure and retest each tick ===
    if ((isXAUt || isBTCt || isNASt) && s.obZone && !s.obMitigated) {
      const ob = s.obZone;
      const obAge = Date.now() - ob.ts;
      const obTolerance = isBTCt ? 15.0 : isNASt ? 5.0 : 0.50; // zone edge tolerance

      // Expire stale OBs (30 min)
      if (obAge > 1800000) {
        log(sym, '🧱 OB expired after 30min — clearing');
        s.obZone = null; s.obDeparted = false; s.obFired = false;
      } else {
        // Track departure: price moved away from OB in breakout direction
        if (!s.obDeparted) {
          if (ob.dir === 'call' && price > ob.hi + obTolerance) {
            s.obDeparted = true;
            log(sym, '🧱 OB departed: price $' + price.toFixed(2) + ' moved above OB zone $' + ob.hi.toFixed(2));
          } else if (ob.dir === 'put' && price < ob.lo - obTolerance) {
            s.obDeparted = true;
            log(sym, '🧱 OB departed: price $' + price.toFixed(2) + ' moved below OB zone $' + ob.lo.toFixed(2));
          }
        }

        // Detect OB mitigation: price sliced through entire OB (breakout failed)
        if (ob.dir === 'call' && price < ob.lo - obTolerance) {
          s.obMitigated = true;
          log(sym, '🧱 OB MITIGATED: price $' + price.toFixed(2) + ' broke below OB low $' + ob.lo.toFixed(2) + ' — breakout failed');
        } else if (ob.dir === 'put' && price > ob.hi + obTolerance) {
          s.obMitigated = true;
          log(sym, '🧱 OB MITIGATED: price $' + price.toFixed(2) + ' broke above OB high $' + ob.hi.toFixed(2) + ' — breakout failed');
        }
      }
    }

    } catch (e) { console.error('[' + ts() + '] processTicks ' + sym + ' error:', e.message); }
  });
}
setInterval(() => processTicks(['QQQ', 'SPY']), 3000);
setInterval(() => processTicks(['XAU', 'BTC', 'NAS100']), 1000);

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
      s.breakRange = []; s.breakHi = 0; s.breakLo = Infinity; s.breakCoilStart = 0; s.breakCoilActive = false; s.breakFrozenHi = 0; s.breakFrozenLo = Infinity; s.breakLastTs = 0; s.breakLastDir = null; s.breakLastPrice = 0; s._pendingBreakout = null;
      s.macroPrevDir = null; s.macroFlipTs = 0; s.superFlipTs = 0;
      s.lastAT = ''; s.lastNTs = 0; s.lastReversalTs = 0;
      s.lastPrice = 0; // Reset so first price after daily gap is always accepted by /feed sanity check
      s.dailySignalCount = 0; s.lastSignalDir = null; s.lastSignalTs = 0;
      s.nC = 0; s.nP = 0; s.nBl = 0;
      s.chopShort = []; s.chopLong = []; s.chopCount = 0; s.trendCount = 0; s.chopActive = false;
      s.signals = []; s.tickBuf = []; // in-memory today array cleared — full history persisted in signalHistory[]
      s.crossAssetDir = null; s.crossAssetTs = 0;
      s.sessionHigh = -Infinity; s.sessionLow = Infinity; s.rsiAtSessionHigh = 50;
      s.lastHiRevTs = 0; s.lastLoRevTs = 0; // reset session extreme tracking
      // Rolling ATH/ATL: save today's high/low before resetting, keep 5 days
      if (s.sessionHigh > -Infinity && s.sessionLow < Infinity) {
        const today = new Date().toISOString().slice(0, 10);
        // Don't duplicate if already saved for today
        if (!s.dailyLevels.find(d => d.date === today)) {
          s.dailyLevels.push({ high: s.sessionHigh, low: s.sessionLow, date: today });
        }
        // Keep only last 5 days
        if (s.dailyLevels.length > 5) s.dailyLevels = s.dailyLevels.slice(-5);
        // Recompute rolling from daily levels (today's session about to reset)
        if (s.dailyLevels.length > 0) {
          s.rollingHigh = Math.max(...s.dailyLevels.map(d => d.high));
          s.rollingLow = Math.min(...s.dailyLevels.map(d => d.low));
        }
        log(sym, 'Daily levels saved — today H:$' + s.sessionHigh.toFixed(2) + ' L:$' + s.sessionLow.toFixed(2) + ' · 5-day H:$' + s.rollingHigh.toFixed(2) + ' L:$' + s.rollingLow.toFixed(2) + ' (' + s.dailyLevels.length + ' days)');
      }
      s.athApproachTs = 0; s.athApproachPrice = 0; s.atlApproachTs = 0; s.atlApproachPrice = 0;
      s.lastAtlCallTs = 0; s.lastAtlCallPrice = 0; s.lastAthPutTs = 0; s.lastAthPutPrice = 0;
      s.athBreakLastTs = 0;
      s.gapDayMode = false; s.gapDirection = null;
      s.lastSameDir = null; s.lastSameDirMacd = 0; s.lastSameDirTs = 0; s.lastSameDirPrice = 0;
      s.shakeoutDir = null; s.shakeoutTs = 0; s.shakeoutPrice = 0; s.shakeoutEp = 0;
      s.obCandles = []; s.obCurCandle = null; s.orderBlocks = [];
      s.atrCandles = []; s.atrCurCandle = null;
      s.obZone = null; s.obDeparted = false; s.obFired = false; s.obMitigated = false;
      s.fastMoveLastTs = 0;
      s.sustainedMoveLastTs = 0;
      s.trendRideLastTs = 0; s.trendRideLastDir = null; s.trendRideSameDirCount = 0; s.trendRideLastPrice = 0;
      // TRv2 trend-following state reset
      // BTC is 24/7 — preserve candles, EMAs, and active trade across daily reset
      // NAS100/XAU have market hours — full reset so stale overnight data doesn't pollute
      if (sym !== 'BTC') {
        s.trv2Candles = []; s.trv2CurCandle = null;
        s.trv2Ema15 = null; s.trv2Ema20 = null; s.trv2Ema30 = null; s.trv2TrendEma = null;
        s.trv2Dir = null; s.trv2DirTs = 0; s.trv2Trade = null; s.trv2CrossCount = 0;
        // Reset macro EMA + snapshots — overnight gap would distort the 3h moving average
        s.macroEma = null; s.macroSnaps = [];
      }
      // Always reset cooldown so first signal of new day isn't blocked by yesterday's timestamp
      s.trv2LastSignalTs = 0;
      s.trade = { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
    });
    saveRollingLevels(); // Persist rolling ATH/ATL data across restarts
    saveSignalHistory(); // Flush signal history before daily reset
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
  S[sym].trade = { active: true, type, ep: parseFloat(price), t1: false, t2: false, sl: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
  log(sym, '📍 Trade monitor ON — ' + type.toUpperCase() + ' @ $' + parseFloat(price).toFixed(2));
  res.json({ ok: true });
});

// Clear trade monitor
app.post('/trade/clear', (req, res) => {
  const { sym } = req.body;
  if (S[sym]) S[sym].trade = { active: false, type: '', ep: 0, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
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
  // Price sanity check — reject prices wildly outside expected range (catches cross-symbol feed leaks)
  const PRICE_RANGES = { XAU: [1000, 10000], BTC: [10000, 500000], NAS100: [10000, 50000], QQQ: [100, 1000], SPY: [100, 1000] };
  const range = PRICE_RANGES[sym];
  if (range && (p < range[0] || p > range[1])) {
    console.log('[FEED] REJECTED ' + sym + ' price $' + p + ' — outside range $' + range[0] + '-$' + range[1]);
    return res.status(400).json({ error: 'Price ' + p + ' outside expected range for ' + sym });
  }
  // Also reject if price jumps too far from last known price (unless first price)
  // MT5 instruments (XAU/BTC/NAS100): 10% threshold — weekend gaps, daily resets cause legitimate large jumps
  // Equities (SPY/QQQ): 5% threshold — less volatile, tighter check
  if (S[sym].lastPrice > 0) {
    const isMT5sym = sym === 'XAU' || sym === 'BTC' || sym === 'NAS100';
    const maxJump = isMT5sym ? 10 : 5;
    const pctChange = Math.abs(p - S[sym].lastPrice) / S[sym].lastPrice * 100;
    if (pctChange > maxJump) {
      console.log('[FEED] REJECTED ' + sym + ' price $' + p + ' — ' + pctChange.toFixed(1) + '% jump from $' + S[sym].lastPrice + ' (limit ' + maxJump + '%)');
      return res.status(400).json({ error: 'Price jump too large: ' + pctChange.toFixed(1) + '%' });
    }
  }
  S[sym].lastPrice = p;
  S[sym].tickBuf.push({ p, h, l });
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
      trade: s.trade.active ? {
        active: true, type: s.trade.type, ep: s.trade.ep,
        t1: s.trade.t1, t2: s.trade.t2, sl: s.trade.sl, rev: s.trade.rev,
        isTrend: s.trade.isTrend || false,
        isCfd: s.trade.isCfd || false,
        slPrice: s.trade.slPrice || null,
        tp1Price: s.trade.tp1Price || null,
        tp2Price: s.trade.tp2Price || null,
        tp3Price: s.trade.tp3Price || null,
        trailSl: s.trade.trailSl || null,
        atr: s.trade.atr || null,
        bestPrice: s.trade.bestPrice || null,
        pnl: s.trade.isCfd && s.lastPrice > 0 ? +(((s.trade.type === 'call' ? s.lastPrice - s.trade.ep : s.trade.ep - s.lastPrice) / s.trade.ep) * 100).toFixed(3) : null
      } : { active: false },
      dxy: s._dxy || null,
      tlt: s._tlt || null,
      slv: s._slv || null,
      gdx: s._gdx || null,
      spyCorr: (sym === 'BTC' || sym === 'NAS100') ? (() => { const sp = S['SPY']; if (!sp || !sp.lastPrice) return null; return { price: sp.lastPrice, dir: sp.pE5 && sp.pE13 ? (sp.pE5 > sp.pE13 ? 'up' : 'down') : 'flat', roc3: sp._roc3 || 0 }; })() : null,
      qqqCorr: (sym === 'BTC' || sym === 'NAS100') ? (() => { const qp = S['QQQ']; if (!qp || !qp.lastPrice) return null; return { price: qp.lastPrice, dir: qp.pE5 && qp.pE13 ? (qp.pE5 > qp.pE13 ? 'up' : 'down') : 'flat', roc3: qp._roc3 || 0 }; })() : null,
      dxyCorr: (sym === 'BTC' || sym === 'NAS100') ? (() => { return dxyPrice > 0 ? { price: dxyPrice, dir: dxyDir, roc3: dxyRoc3 } : null; })() : null,
      btcCorr: sym === 'NAS100' ? (() => { const bp = S['BTC']; if (!bp || !bp.lastPrice) return null; return { price: bp.lastPrice, dir: bp.pE5 && bp.pE13 ? (bp.pE5 > bp.pE13 ? 'up' : 'down') : 'flat', roc3: bp._roc3 || 0 }; })() : null,
      priceStructure: s._priceStructure || 'neutral',
      breakout: s._breakout || null,
      atr: s._atr || 0,
      xauSession: s._xauSession || '',
      btcSession: s._btcSession || '',
      nasSession: s._nasSession || '',
      rollingHigh: s.rollingHigh || 0,
      rollingLow: s.rollingLow === Infinity ? 0 : s.rollingLow,
      roundNum: s._roundNum || null,
      orderBlocks: s._orderBlocks || [],
      obBreakout: s.obZone ? { dir: s.obZone.dir, hi: +s.obZone.hi.toFixed(2), lo: +s.obZone.lo.toFixed(2), coilHi: +s.obZone.coilHi.toFixed(2), coilLo: +s.obZone.coilLo.toFixed(2), age: Math.round((Date.now() - s.obZone.ts) / 1000), departed: s.obDeparted, fired: s.obFired, mitigated: s.obMitigated } : null,
      macro: (sym === 'XAU' || sym === 'BTC' || sym === 'NAS100') && s.macroSnaps.length >= 2 && s.lastPrice > 0 ? (() => {
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
      })() : null,
      // TRv2 trend-following data (BTC/NAS100 only)
      trv2: (sym === 'BTC' || sym === 'NAS100') ? {
        trendEma: s.trv2TrendEma ? +s.trv2TrendEma.toFixed(2) : null,
        ema15: s.trv2Ema15 ? +s.trv2Ema15.toFixed(2) : null,
        ema20: s.trv2Ema20 ? +s.trv2Ema20.toFixed(2) : null,
        ema30: s.trv2Ema30 ? +s.trv2Ema30.toFixed(2) : null,
        dir: s.trv2Dir,
        dirAge: s.trv2DirTs ? Math.round((Date.now() - s.trv2DirTs) / 1000) : null,
        candles: s.trv2Candles.length,
        trade: s.trv2Trade ? {
          dir: s.trv2Trade.dir,
          ep: s.trv2Trade.ep,
          ts: s.trv2Trade.ts,
          age: Math.round((Date.now() - s.trv2Trade.ts) / 1000),
          sl: +s.trv2Trade.sl.toFixed(2),
          tp1: +s.trv2Trade.tp1.toFixed(2),
          tp2: +s.trv2Trade.tp2.toFixed(2),
          tp3: +s.trv2Trade.tp3.toFixed(2),
          tp1Hit: s.trv2Trade.tp1Hit,
          tp2Hit: s.trv2Trade.tp2Hit,
          tp3Hit: s.trv2Trade.tp3Hit,
          trailSl: s.trv2Trade.trailSl ? +s.trv2Trade.trailSl.toFixed(2) : null,
          bestPrice: s.trv2Trade.bestPrice ? +s.trv2Trade.bestPrice.toFixed(2) : null,
          atr: s.trv2Trade.atr ? +s.trv2Trade.atr.toFixed(2) : null,
          pnl: s.lastPrice > 0 ? +(((s.trv2Trade.dir === 'long' ? s.lastPrice - s.trv2Trade.ep : s.trv2Trade.ep - s.lastPrice) / s.trv2Trade.ep) * 100).toFixed(3) : 0
        } : null
      } : null
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

// Signal history — today shortcut (JSON) — must be before /:date to avoid matching "today" as date param
app.get('/signals/today', (req, res) => {
  const today = todayDateET();
  const todaySignals = signalHistory.filter(h => h.date === today);
  const bySymbol = {};
  SYMBOLS.forEach(sym => {
    const symSigs = todaySignals.filter(h => h.symbol === sym);
    if (symSigs.length > 0) bySymbol[sym] = symSigs.length;
  });
  res.json({ date: today, total: todaySignals.length, bySymbol: bySymbol, signals: todaySignals });
});

// CSV export — legacy endpoint (must be before /:date)
app.get('/signals/csv/:date', (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'Use YYYY-MM-DD format' });
  const file = path.join(SIGNALS_DIR, dateStr + '.csv');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No CSV for ' + dateStr });
  res.header('Content-Type', 'text/csv');
  res.sendFile(file);
});

// Manual CSV backup trigger — POST yesterday's (or any date's) CSV to BACKUP_WEBHOOK_URL on demand
// Lightly protected: requires the ADMIN_TOKEN env var to be supplied via ?token= query param.
// If ADMIN_TOKEN is unset the endpoint is disabled.
app.post('/admin/backup/:date', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN not configured — endpoint disabled' });
  if (req.query.token !== adminToken) return res.status(401).json({ error: 'Invalid or missing token' });
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'Use YYYY-MM-DD format' });
  const result = await backupCsvForDate(dateStr);
  if (result.ok) res.json({ ok: true, ...result });
  else res.status(500).json({ ok: false, ...result });
});

// Signal history — specific date (JSON)
app.get('/signals/:date', (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'Use YYYY-MM-DD format' });
  const dateSigs = signalHistory.filter(h => h.date === dateStr);
  if (dateSigs.length === 0) return res.status(404).json({ error: 'No signals for ' + dateStr, hint: 'History covers last 7 days only' });
  const bySymbol = {};
  SYMBOLS.forEach(sym => {
    const symSigs = dateSigs.filter(h => h.symbol === sym);
    if (symSigs.length > 0) bySymbol[sym] = symSigs.length;
  });
  res.json({ date: dateStr, total: dateSigs.length, bySymbol: bySymbol, signals: dateSigs });
});

// Signal history — full JSON API (7-day persistent store) — must be LAST (catch-all for /signals)
// GET /signals?symbol=BTC&date=2026-05-03&days=3&type=call
app.get('/signals', (req, res) => {
  let filtered = signalHistory;
  // Filter by symbol
  if (req.query.symbol) {
    const sym = req.query.symbol.toUpperCase();
    filtered = filtered.filter(h => h.symbol === sym);
  }
  // Filter by date (exact)
  if (req.query.date) {
    filtered = filtered.filter(h => h.date === req.query.date);
  }
  // Filter by last N days
  if (req.query.days) {
    const daysMs = parseInt(req.query.days) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - daysMs;
    filtered = filtered.filter(h => h.ts > cutoff);
  }
  // Filter by signal type (call/put)
  if (req.query.type) {
    filtered = filtered.filter(h => h.type === req.query.type.toLowerCase());
  }
  // Filter by score (e.g. RIDE, MFLIP, TREND, 6/6, ⬇HI, etc.)
  if (req.query.score) {
    const scoreQ = req.query.score.toUpperCase();
    filtered = filtered.filter(h => h.score && h.score.toUpperCase().includes(scoreQ));
  }
  // Summary stats
  const dates = [...new Set(filtered.map(h => h.date))].sort();
  const symbols = [...new Set(filtered.map(h => h.symbol))].sort();
  const bySymbol = {};
  symbols.forEach(sym => { bySymbol[sym] = filtered.filter(h => h.symbol === sym).length; });

  res.json({
    total: filtered.length,
    dates: dates,
    bySymbol: bySymbol,
    signals: filtered,
    historyAge: signalHistory.length > 0 ? signalHistory[0].date : null,
    totalStored: signalHistory.length
  });
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
  loadTrv2State();
  loadSignalHistory();
  connectFinnhub();
  fetchVIX();
  fetchDXY();
  fetchTLT();
  fetchSLV();
  fetchGDX();

  // Save state on shutdown (deploy/restart) so TRv2 trades survive
  process.on('SIGTERM', () => { console.log('[' + ts() + '] SIGTERM — saving state...'); saveTrv2State(); saveRollingLevels(); process.exit(0); });
  process.on('SIGINT', () => { console.log('[' + ts() + '] SIGINT — saving state...'); saveTrv2State(); saveRollingLevels(); process.exit(0); });
});
