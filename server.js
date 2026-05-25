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
// ===== TRADIER SANDBOX API (added 2026-05-20) =====
// Fetches real ATM 0DTE option premium for QQQ/SPY signal outcome tracking.
// Sandbox returns 15-min delayed quotes — sufficient for retrospective outcome analysis,
// not for live execution. Set TRADIER_SANDBOX_TOKEN env var in Railway to enable.
const TRADIER_TOKEN = process.env.TRADIER_SANDBOX_TOKEN || process.env.TRADIER_TOKEN || '';
const TRADIER_BASE = 'https://sandbox.tradier.com/v1';
// Option outcome thresholds (% gain on option premium)
const OPTION_TP1_PCT = parseFloat(process.env.OPTION_TP1_PCT) || 30;
const OPTION_TP2_PCT = parseFloat(process.env.OPTION_TP2_PCT) || 60;
const OPTION_TP3_PCT = parseFloat(process.env.OPTION_TP3_PCT) || 100;
const OPTION_SL_PCT  = parseFloat(process.env.OPTION_SL_PCT)  || -50;
const SYMBOLS = ['QQQ', 'SPY', 'XAU', 'BTC', 'NAS100'];
const RSI_CALL_LO = { QQQ: 45, SPY: 45, XAU: 40, BTC: 42, NAS100: 42 };
const RSI_CALL_HI = { QQQ: 65, SPY: 65, XAU: 56, BTC: 60, NAS100: 60 }; // XAU 6/6-base tightened 2026-05-11 g: 60 → 56 (only affects 6/6 — specialists have own gates). Mirror of PUT_LO 35→40.
const RSI_PUT_LO  = { QQQ: 30, SPY: 30, XAU: 40, BTC: 35, NAS100: 35 }; // XAU 6/6-base tightened 2026-05-11 g: 35 → 40 (only affects 6/6 — specialists have own gates). Today's 6/6 PUT at RSI 38.4 was the falling-knife — would now be blocked.
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
    // Per-direction signal timestamps for cross-asset confluence (added 2026-05-16).
    // NAS conviction reads S['QQQ'].lastCallSignalTs / lastPutSignalTs to add a QQQ_SIG factor
    // when QQQ bot has fired the same direction within the last 10 min. Symmetric for QQQ
    // reading NAS. Catches the "two correlated bots independently agree" alpha.
    lastCallSignalTs: 0, lastPutSignalTs: 0,
    nC: 0, nP: 0, nBl: 0,
    chopShort: [], chopLong: [], chopCount: 0, trendCount: 0, chopActive: false,
    signals: [], tickBuf: [], lastPrice: 0,
    crossAssetDir: null, crossAssetTs: 0,
    sessionHigh: -Infinity, sessionLow: Infinity, rsiAtSessionHigh: 50, rsiAtSessionLow: 50,
    // Timestamps when session extremes were last updated (added 2026-05-14 for Session Range
    // Bias "fresh break" detection — if sessionHigh updated <5 min ago, price is making a new
    // high right now and CALL breakout signals are valid even in upper half).
    sessionHighUpdateTs: 0, sessionLowUpdateTs: 0,
    gapDayMode: false, gapDirection: null, prevClose: null,
    lastSameDir: null, lastSameDirMacd: 0, lastSameDirTs: 0, lastSameDirPrice: 0,
    // LHF/LLF (Local High/Low Fade) — fresh local-extreme reversal detector cooldowns.
    // Added 2026-05-15. PUT fires when price is $3-7 off a fresh local 60-min high (formed
    // within last 25 min) AND macro PUT-aligned AND RSI rolling over AND MACD compressing.
    // Symmetric LLF CALL at fresh local 60-min low. 30-min cooldown per direction.
    lastLhfPutTs: 0, lastLlfCallTs: 0,
    // Rolling multi-day high/low for ATH/ATL reversal detection
    // Simple: one entry per day {high, low, date}. rollingHigh/Low computed from 5 daily entries + today's session.
    dailyLevels: [],     // [{high, low, date}] — last 5 completed days
    rollingHigh: 0,      // current 5-day high (max of dailyLevels highs + today's sessionHigh)
    rollingLow: Infinity, // current 5-day low (min of dailyLevels lows + today's sessionLow)
    rollingHighUpdateTs: 0, // when rollingHigh last advanced (for ATH PUT trend-protection gate)
    rollingLowUpdateTs: 0,  // when rollingLow last advanced (for ATL CALL trend-protection gate)
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
    // Macro-alignment tracking (added 2026-05-13). Records when conv.score first reached the
    // "fully aligned" threshold (6+/7 for XAU, 6+/7-8 for BTC/NAS) for each direction. Used to
    // LOOSEN guard gates (4h range-bound bump, post-reopen settling, chop circuit breaker) when
    // ALL cross-asset factors agree — at that point the macro thesis is so strong that the
    // short-term chop/timing gates become overcautious. Added after 5/13 dashboard showed
    // 7/7 BEARISH conviction holding while price dropped $14 with no detector firing.
    fullConvSinceCall: 0,  // when conv.score first reached 6+ for CALL direction (0 = not currently)
    fullConvSincePut: 0,   // when conv.score first reached 6+ for PUT direction
    // Macro-contra block (added 2026-05-13). When conv ≥6 aligned in one direction, set a
    // sticky 45-min block on the OPPOSITE direction. While macro remains aligned, the block
    // is refreshed every tick; when alignment breaks, the block decays over 45 min. Prevents
    // counter-trend signals from sneaking through right after a fresh same-side trade, even
    // when those signals look "OK" by their own detector logic.
    macroContraBlockCallUntil: 0, // timestamp until which CALL signals are blocked (macro PUT)
    macroContraBlockPutUntil: 0,  // timestamp until which PUT signals are blocked (macro CALL)
    // Macro-flip cooldown (added 2026-05-13 after 5/13 10:32 ATL CALL SL'd 32 min after PUT
    // alignment ended). Records when alignment in each direction last ENDED (transitioned
    // from ≥6 to <6). Used to block ALL signals — including fades — when macro recently
    // flipped, on the theory that "macro is flickering" = chop, not real reversal.
    lastFullConvCallEndTs: 0,  // when CALL alignment last ended
    lastFullConvPutEndTs: 0,   // when PUT alignment last ended
    // Duration of the just-ended alignment (added 2026-05-14 after 5/14 missed $4710 peak PUT
    // when macro briefly flipped CALL during a bounce, then back). If the opposite alignment
    // was BRIEF (< 30 min), it's a flicker and cooldown shouldn't enforce. Real reversals come
    // from sustained alignment ending (> 30 min). Records duration of the alignment that just
    // ended in each direction so the cooldown gate can decide flicker vs real.
    lastFullConvCallDurationMs: 0,
    lastFullConvPutDurationMs: 0,
    // Post-signal price snapshots (added 2026-05-14). For each fired signal, capture price at
    // +5min / +15min / +30min after entry. CSV export adds price5m/delta5m/price15m/delta15m/
    // price30m/delta30m columns. Entries removed once all 3 captured. List: [{histIdx, fireTs}].
    pendingSnapshots: [],
    // Same-direction fire history (added 2026-05-14). Caps same-direction signals at 2 per
    // rolling 30-min window. Catches "trend exhaustion stacking" — when a 3rd same-direction
    // signal fires near the end of an extended move (5/14 03:58 PUT FAST: 3rd PUT in 19 min,
    // SL'd despite full conv 7/7 + STRUCT). List: [{ts, type}].
    recentFires: [],
    // Post-TP3 cooldown timestamps per direction (added 2026-05-14). When a same-direction
    // trade hits TP3 (full target captured), block new same-direction signals for 90 min —
    // the move is exhausted, chasing it leads to losers (5/14 signal #2 SL'd 32 min after
    // signal #1 hit TP3 in the same direction).
    lastTp3CallTs: 0,
    lastTp3PutTs: 0,
    // Chop circuit breaker (added 2026-05-13) — tracks direction flips over rolling 60-min window.
    // If 3+ flips happen in 60 min, suppress all opposite-direction signals for the next 30 min.
    // Behavioral chop detector — catches the death-by-1000-cuts pattern when individual indicator
    // gates each look OK in isolation but the macro behavior screams "indecisive market."
    flipHistory: [],       // [ts] of opposite-direction signal flips, last 60 min only
    chopBreakerUntil: 0,   // timestamp when circuit-breaker suppression expires
    // ===== RSI DIVERGENCE DETECTOR (added 2026-05-11) =====
    // Anticipatory reversal detector: tracks the last 4 confirmed swing extremes (alternating
    // peaks + troughs) with their RSI value at the time. Fires PUT when price makes a NEW
    // higher high but RSI prints a LOWER high (bearish divergence — momentum failing). Fires
    // CALL when price makes a NEW lower low but RSI prints a HIGHER low (bullish divergence —
    // selling pressure exhausting). This catches reversals 5-15 min BEFORE the actual flip,
    // unlike ATH/ATL which fires only after price has already pulled back from the extreme.
    divSwingDir: null,       // 'up' (tracking a potential peak) or 'down' (tracking a trough)
    divSwingPrice: 0,        // running extreme price of the current swing
    divSwingRsi: 50,         // RSI at the time of the running extreme
    divSwingTs: 0,           // when current swing extreme was set
    divPeaks: [],            // last 4 confirmed swing highs: [{ts, price, rsi}]
    divTroughs: [],          // last 4 confirmed swing lows
    divLastFireTs: 0,        // when last divergence signal fired (cooldown)
    // ===== LIQUIDITY SWEEP / STOP-HUNT DETECTOR (added 2026-05-11) =====
    // Anti-manipulation detector. Tracks the recent range high/low and watches for the classic
    // stop-hunt footprint: price wicks just above the range high (sweeping stop-loss clusters),
    // then immediately returns below within a short window. Fires a COUNTER-direction signal
    // at the return — catching the reversal at the wick rather than after the dump.
    // Example today on XAU: range $4672-$4676, spike to $4681 (sweep), reversal to $4650.
    // Bot would fire ⬇SWEEP PUT around $4675 (just as price returned below the swept high).
    sweepWatchUpStart: 0,    // when an up-sweep watcher started (0 = no active watcher)
    sweepWatchUpHigh: 0,     // running peak during the up-sweep wick
    sweepWatchUpAnchor: 0,   // the range-high level that was swept (locked when watcher starts)
    sweepWatchDownStart: 0,  // when a down-sweep watcher started
    sweepWatchDownLow: 0,    // running trough during the down-sweep wick
    sweepWatchDownAnchor: 0, // the range-low level that was swept
    sweepLastFireTs: 0,      // when last sweep signal fired (cooldown)
    // ===== SQUEEZE RELEASE DETECTOR (added 2026-05-11) =====
    // Anticipatory volatility-compression detector. Fires when price has been confined to an
    // unusually tight range (15-min range ≤ instrument threshold) AND breaks out of that
    // compression by a meaningful amount. Catches "coiled spring" patterns where stored
    // energy releases into a fast directional move — exactly the case where FAST/BREAK/DIV/
    // SWEEP all miss because the range is too tight for their normal thresholds.
    sqzLastFireTs: 0,        // when last squeeze signal fired (cooldown)
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
    coilArmedAlerted: false, // (NAS only) true after the "COIL ARMED" push alert has fired for the current coil — prevents spamming
    coilArmedAlertedTs: 0,   // when the COIL ARMED alert fired (used by EA-side pre-positioning if/when added)
    breakLastTs: 0,          // when last breakout signal fired (cooldown)
    breakLastDir: null,      // direction of last breakout signal ('call'/'put')
    breakLastPrice: 0,       // entry price of last breakout signal
    breakSameDirCount: 0,    // consecutive same-direction breakouts in current leg
    breakLegStartTs: 0,      // when current same-direction leg started (resets on direction flip OR after 2h gap)
    // Fast-move detector — catches strong directional moves when MACD lags
    fastMoveLastTs: 0,       // when last fast-move signal fired (cooldown)
    fastLastDir: null,       // direction of last FAST fire ('call'|'put'). Used by 30-min opposite-direction flip-cool — reversals belong to SQZ/ATH/ATL, NOT FAST.
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

// ===== TRUMP TWEET SENTIMENT (cross-asset conviction factor) =====
// Pipeline: external poller (Pipedream/RSS/custom) POSTs new posts to /trump/post.
// Each post is classified via Claude Haiku (if ANTHROPIC_API_KEY set) into a market-impact
// signal. Result is stored as state.trumpBias with a 60-min TTL. The convictionFor()
// function adds a TRUMP factor when a signal aligns with the active bias.
//
// State persisted to /data/trump_state.json so Railway redeploys don't lose recent context.
const TRUMP_STATE_FILE = path.join(DATA_DIR, 'trump_state.json');
const TRUMP_BIAS_TTL_MS = parseInt(process.env.TRUMP_BIAS_TTL_MS) || 3600000; // 60 min default
const TRUMP_MIN_INTENSITY = parseInt(process.env.TRUMP_MIN_INTENSITY) || 3;   // skip weak tweets
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const TRUMP_CLASSIFIER_MODEL = process.env.TRUMP_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';

// Per-instrument bias map (added 2026-05-10). Replaces the legacy single trumpBias +
// trumpInstruments combo so a single tweet can express OPPOSITE directions across symbols
// (e.g. Iran geopolitical post = bearish for SPY/QQQ/NAS100, bullish for XAU, neutral for BTC).
const TRUMP_VALID_SYMBOLS = ['SPY','QQQ','BTC','XAU','NAS100'];
let trumpBiases = { SPY: 'neutral', QQQ: 'neutral', BTC: 'neutral', XAU: 'neutral', NAS100: 'neutral' };
let trumpBiasTs = 0;                  // when biases were last set
let trumpIntensity = 0;               // 1-5 (only intensity >= TRUMP_MIN_INTENSITY counts)
let trumpLastPostId = '';             // most-recent classified post ID (kept for /trump/state)
let trumpRecentIds = new Set();       // dedupe — last 100 classified post IDs (proper Set-based)
let trumpLastPostText = '';           // for /trump/state monitoring
let trumpLastClassification = null;   // full last result for monitoring
let trumpClassifyCount = 0;           // total classifications since startup
// Notification throttle: push only on bias change OR after this gap. Stops every-minute spam
// when poll loop re-classifies the same tweets, and prevents 4 beeps when Trump posts a
// flurry of same-direction tweets. 15 min default — override via TRUMP_PUSH_THROTTLE_MIN.
const TRUMP_PUSH_THROTTLE_MS = (parseInt(process.env.TRUMP_PUSH_THROTTLE_MIN) || 15) * 60000;
const TRUMP_RECENT_IDS_MAX = 100;     // ring buffer size for ID dedup set
let trumpLastPushTs = 0;              // when last push notification went out
let trumpLastPushBias = 'neutral';    // bias of last push — used to detect changes

function loadTrumpState() {
  try {
    const data = JSON.parse(fs.readFileSync(TRUMP_STATE_FILE, 'utf8'));
    // Only restore bias if still within TTL — stale bias is worse than no bias
    if (data.trumpBiasTs && Date.now() - data.trumpBiasTs < TRUMP_BIAS_TTL_MS) {
      trumpBiasTs = data.trumpBiasTs || 0;
      trumpIntensity = data.trumpIntensity || 0;
      // Prefer new per-symbol biases map; fall back to legacy single-bias state for migration
      if (data.trumpBiases && typeof data.trumpBiases === 'object') {
        TRUMP_VALID_SYMBOLS.forEach(s => { trumpBiases[s] = data.trumpBiases[s] || 'neutral'; });
      } else if (data.trumpBias) {
        // Legacy migration: spread old bias across the symbols in old instruments list
        const legacyBias = data.trumpBias;
        const legacyInst = Array.isArray(data.trumpInstruments) ? data.trumpInstruments : [];
        const isAll = legacyInst.includes('ALL');
        TRUMP_VALID_SYMBOLS.forEach(s => {
          trumpBiases[s] = (isAll || legacyInst.includes(s)) ? legacyBias : 'neutral';
        });
      }
      const summary = TRUMP_VALID_SYMBOLS.map(s => s + ':' + (trumpBiases[s] || 'neutral')[0]).join(' ');
      console.log('[' + ts() + '] Trump state restored — i' + trumpIntensity + ', age ' + Math.round((Date.now() - trumpBiasTs) / 60000) + 'min · ' + summary);
    }
    trumpLastPostId = data.trumpLastPostId || '';
    trumpLastPostText = data.trumpLastPostText || '';
    trumpLastClassification = data.trumpLastClassification || null;
    trumpClassifyCount = data.trumpClassifyCount || 0;
    // Restore the recent-IDs dedup set + push throttle state so redeploys don't re-fire
    // notifications for posts the previous instance already classified.
    if (Array.isArray(data.trumpRecentIds)) trumpRecentIds = new Set(data.trumpRecentIds);
    else if (trumpLastPostId) trumpRecentIds = new Set([trumpLastPostId]); // backfill from old state
    trumpLastPushTs = data.trumpLastPushTs || 0;
    trumpLastPushBias = data.trumpLastPushBias || 'neutral';
  } catch (e) { console.log('[' + ts() + '] No Trump state file — starting fresh'); }
}
function saveTrumpState() {
  try {
    fs.writeFileSync(TRUMP_STATE_FILE, JSON.stringify({
      trumpBiases, trumpBiasTs, trumpIntensity,
      trumpLastPostId, trumpLastPostText, trumpLastClassification, trumpClassifyCount,
      trumpRecentIds: Array.from(trumpRecentIds), trumpLastPushTs, trumpLastPushBias
    }, null, 2));
  } catch (e) {}
}
setInterval(saveTrumpState, 60000); // save every minute

// Classifier — uses Claude Haiku via Anthropic Messages API.
// Returns { market_relevant, bias, topics, intensity, instruments_affected, confidence }
// Falls back to a quick keyword-based heuristic if no API key is configured.
async function classifyTrumpPost(text) {
  if (!text || text.trim().length < 10) {
    return { market_relevant: false, bias: 'neutral', topics: [], intensity: 0, instruments_affected: [], confidence: 0, source: 'too-short' };
  }
  // No API key — use simple keyword heuristic so the pipeline still works
  if (!ANTHROPIC_API_KEY) {
    return classifyTrumpPostHeuristic(text);
  }
  try {
    const httpsLib = require('https');
    // Per-instrument biases — a single tweet can be bullish for one symbol and bearish for another.
    // Tariff posts are bearish for stocks but bullish for gold (safe haven). Iran/geopolitical posts
    // are bearish for stocks AND BTC (risk-off) but bullish for gold. Reason about each symbol
    // INDEPENDENTLY rather than picking one direction for the whole tweet.
    const prompt = 'Analyze this Donald Trump social media post for short-term financial market impact. Return ONLY valid JSON (no prose, no markdown):\n\n' +
      '{\n' +
      '  "market_relevant": <true/false>,\n' +
      '  "biases": {\n' +
      '    "SPY":    "bullish" | "bearish" | "neutral",\n' +
      '    "QQQ":    "bullish" | "bearish" | "neutral",\n' +
      '    "BTC":    "bullish" | "bearish" | "neutral",\n' +
      '    "XAU":    "bullish" | "bearish" | "neutral",\n' +
      '    "NAS100": "bullish" | "bearish" | "neutral"\n' +
      '  },\n' +
      '  "topics": [<list of: "tariffs","china","fed","powell","tech","energy","crypto","gold","tax","trade","sanctions","oil","iran","israel","russia","ukraine","geopolitical","war","economy","jobs">],\n' +
      '  "intensity": <1-5 integer; 1=mild opinion, 5=specific actionable announcement>,\n' +
      '  "confidence": <0-1 float>\n' +
      '}\n\n' +
      'Each symbol bias should be reasoned INDEPENDENTLY. A single tweet often moves stocks one way and gold the opposite way. Geopolitical escalation (Iran, Middle East, war rhetoric) is bearish for stocks & BTC and bullish for gold. Tariff posts are bearish for stocks and bullish for gold. Fed-attack posts are bearish for stocks and bullish for gold. Pro-crypto posts are bullish for BTC only. Use "neutral" for symbols a tweet doesn\'t plausibly move.\n\n' +
      'Examples:\n' +
      '"MAGA!" → {"market_relevant":false,"biases":{"SPY":"neutral","QQQ":"neutral","BTC":"neutral","XAU":"neutral","NAS100":"neutral"},"topics":[],"intensity":1,"confidence":0.9}\n' +
      '"60% TARIFFS on China starting Monday!" → {"market_relevant":true,"biases":{"SPY":"bearish","QQQ":"bearish","BTC":"neutral","XAU":"bullish","NAS100":"bearish"},"topics":["tariffs","china"],"intensity":5,"confidence":0.95}\n' +
      '"Bitcoin will be the future, fantastic!" → {"market_relevant":true,"biases":{"SPY":"neutral","QQQ":"neutral","BTC":"bullish","XAU":"neutral","NAS100":"neutral"},"topics":["crypto"],"intensity":3,"confidence":0.7}\n' +
      '"Powell is destroying the economy" → {"market_relevant":true,"biases":{"SPY":"bearish","QQQ":"bearish","BTC":"neutral","XAU":"bullish","NAS100":"bearish"},"topics":["fed","powell"],"intensity":3,"confidence":0.7}\n' +
      '"Iran\'s response is TOTALLY UNACCEPTABLE — they will pay a heavy price!" → {"market_relevant":true,"biases":{"SPY":"bearish","QQQ":"bearish","BTC":"bearish","XAU":"bullish","NAS100":"bearish"},"topics":["iran","sanctions","geopolitical"],"intensity":4,"confidence":0.8}\n' +
      '"BIG WIN — trade deal with Japan signed today!" → {"market_relevant":true,"biases":{"SPY":"bullish","QQQ":"bullish","BTC":"neutral","XAU":"bearish","NAS100":"bullish"},"topics":["trade"],"intensity":3,"confidence":0.75}\n\n' +
      'Post:\n"' + text.replace(/"/g, '\\"').slice(0, 1000) + '"';
    const body = JSON.stringify({
      model: TRUMP_CLASSIFIER_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    const res = await new Promise((resolve, reject) => {
      const req = httpsLib.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01'
        }
      }, (resp) => {
        let chunks = '';
        resp.on('data', (c) => chunks += c);
        resp.on('end', () => resp.statusCode < 300 ? resolve(chunks) : reject(new Error('HTTP ' + resp.statusCode + ': ' + chunks.slice(0, 200))));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    const data = JSON.parse(res);
    const responseText = data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
    // Extract JSON from response (handle cases where model adds extra prose)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in classifier response: ' + responseText.slice(0, 200));
    const parsed = JSON.parse(jsonMatch[0]);
    // Normalize biases into the canonical { SPY, QQQ, BTC, XAU, NAS100 } shape.
    // Accept new per-symbol format; fall back to legacy single-bias + instruments_affected.
    const normBiases = { SPY: 'neutral', QQQ: 'neutral', BTC: 'neutral', XAU: 'neutral', NAS100: 'neutral' };
    if (parsed.biases && typeof parsed.biases === 'object') {
      TRUMP_VALID_SYMBOLS.forEach(s => {
        const v = parsed.biases[s];
        normBiases[s] = ['bullish','bearish','neutral'].includes(v) ? v : 'neutral';
      });
    } else if (parsed.bias && ['bullish','bearish','neutral'].includes(parsed.bias)) {
      // Legacy fallback: project single bias onto symbols in instruments_affected (filtered to valid set)
      const legacyInst = Array.isArray(parsed.instruments_affected) ? parsed.instruments_affected : [];
      const isAll = legacyInst.includes('ALL');
      TRUMP_VALID_SYMBOLS.forEach(s => {
        normBiases[s] = (isAll || legacyInst.includes(s)) ? parsed.bias : 'neutral';
      });
    }
    // Derive convenience fields for /trump/state and badges: "dominant" bias = most common
    // non-neutral direction across symbols (ties → bullish), and instruments_affected = list
    // of symbols that are non-neutral.
    const nonNeutral = TRUMP_VALID_SYMBOLS.filter(s => normBiases[s] !== 'neutral');
    const bullishCount = nonNeutral.filter(s => normBiases[s] === 'bullish').length;
    const bearishCount = nonNeutral.filter(s => normBiases[s] === 'bearish').length;
    const dominantBias = nonNeutral.length === 0 ? 'neutral' : (bullishCount >= bearishCount ? 'bullish' : 'bearish');
    return {
      market_relevant: !!parsed.market_relevant,
      biases: normBiases,
      bias: dominantBias,                            // legacy compat — derived
      instruments_affected: nonNeutral,              // legacy compat — derived (validated against TRUMP_VALID_SYMBOLS)
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      intensity: Math.max(0, Math.min(5, parseInt(parsed.intensity) || 0)),
      confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
      source: 'claude'
    };
  } catch (e) {
    console.error('[' + ts() + '] Trump classifier error:', e.message, '— falling back to heuristic');
    return classifyTrumpPostHeuristic(text);
  }
}

// Lightweight keyword-based classifier — used when no API key OR Claude fails.
// Much less accurate but keeps the pipeline alive during outages. Emits per-instrument biases.
function classifyTrumpPostHeuristic(text) {
  const t = text.toLowerCase();
  const topics = [];
  const biases = { SPY: 'neutral', QQQ: 'neutral', BTC: 'neutral', XAU: 'neutral', NAS100: 'neutral' };
  let intensity = 1;
  let market_relevant = false;
  // Tariff / trade — bearish for stocks/NAS, bullish for gold (safe haven)
  if (/tariff|tariffs/.test(t)) {
    topics.push('tariffs'); market_relevant = true; intensity = Math.max(intensity, 4);
    biases.SPY = 'bearish'; biases.QQQ = 'bearish'; biases.NAS100 = 'bearish'; biases.XAU = 'bullish';
  }
  if (/trade war/.test(t)) {
    topics.push('trade'); market_relevant = true; intensity = Math.max(intensity, 3);
    biases.SPY = biases.SPY === 'neutral' ? 'bearish' : biases.SPY;
    biases.QQQ = biases.QQQ === 'neutral' ? 'bearish' : biases.QQQ;
    biases.NAS100 = biases.NAS100 === 'neutral' ? 'bearish' : biases.NAS100;
    biases.XAU = biases.XAU === 'neutral' ? 'bullish' : biases.XAU;
  }
  if (/trade deal|trade agreement/.test(t)) {
    topics.push('trade'); market_relevant = true; intensity = Math.max(intensity, 3);
    biases.SPY = 'bullish'; biases.QQQ = 'bullish'; biases.NAS100 = 'bullish'; biases.XAU = 'bearish';
  }
  if (/china/.test(t)) { topics.push('china'); }
  // Fed / Powell attack — bearish stocks, bullish gold
  if (/fed|powell|interest rate|rate cut|rate hike/.test(t)) {
    topics.push('fed'); market_relevant = true; intensity = Math.max(intensity, 3);
    if (/destroy|disaster|terrible|awful|worst|incompetent/.test(t)) {
      biases.SPY = 'bearish'; biases.QQQ = 'bearish'; biases.NAS100 = 'bearish'; biases.XAU = 'bullish';
    }
  }
  // Geopolitical — Iran, war, sanctions: risk-off → bearish for stocks & BTC, bullish for gold
  if (/iran|israel|russia|ukraine|war|missile|strike|military|sanction|geopolitic/.test(t)) {
    topics.push('geopolitical'); market_relevant = true; intensity = Math.max(intensity, 3);
    if (/iran/.test(t)) topics.push('iran');
    if (/israel/.test(t)) topics.push('israel');
    if (/russia/.test(t)) topics.push('russia');
    if (/ukraine/.test(t)) topics.push('ukraine');
    if (/sanction/.test(t)) topics.push('sanctions');
    // Escalation language bumps intensity and locks in bearish-risk / bullish-gold bias
    if (/unacceptable|heavy price|will pay|consequences|destroy|attack/.test(t)) intensity = Math.max(intensity, 4);
    biases.SPY = 'bearish'; biases.QQQ = 'bearish'; biases.NAS100 = 'bearish';
    biases.BTC = 'bearish'; biases.XAU = 'bullish';
  }
  // Crypto-specific — only affects BTC
  if (/bitcoin|crypto|btc/.test(t)) {
    topics.push('crypto'); market_relevant = true; intensity = Math.max(intensity, 3);
    if (/\b(great|fantastic|tremendous|love|future|win)\b/.test(t)) biases.BTC = 'bullish';
    else if (/\b(scam|fraud|ban|terrible|disaster)\b/.test(t)) biases.BTC = 'bearish';
  }
  if (/!{2,}|\b(URGENT|BREAKING|MUST)\b/.test(text)) intensity = Math.max(intensity, 4);
  // Derive legacy convenience fields
  const nonNeutral = TRUMP_VALID_SYMBOLS.filter(s => biases[s] !== 'neutral');
  const bullishCount = nonNeutral.filter(s => biases[s] === 'bullish').length;
  const bearishCount = nonNeutral.filter(s => biases[s] === 'bearish').length;
  const dominantBias = nonNeutral.length === 0 ? 'neutral' : (bullishCount >= bearishCount ? 'bullish' : 'bearish');
  return {
    market_relevant, biases, bias: dominantBias,
    instruments_affected: nonNeutral,
    topics: [...new Set(topics)],
    intensity, confidence: market_relevant ? 0.5 : 0.3,
    source: 'heuristic'
  };
}

// Apply a classification result to the global trumpBias state.
// Only updates if the post is market_relevant AND intensity >= TRUMP_MIN_INTENSITY.
function applyTrumpClassification(postId, postText, classification) {
  trumpLastPostId = postId;
  trumpLastPostText = postText.slice(0, 280);
  trumpLastClassification = classification;
  trumpClassifyCount++;
  // Add to recent-IDs ring buffer for proper dedup. Trim to MAX size so the set doesn't grow.
  trumpRecentIds.add(postId);
  if (trumpRecentIds.size > TRUMP_RECENT_IDS_MAX) {
    const arr = Array.from(trumpRecentIds);
    trumpRecentIds = new Set(arr.slice(-TRUMP_RECENT_IDS_MAX));
  }
  if (classification.market_relevant && classification.intensity >= TRUMP_MIN_INTENSITY) {
    // Store the full per-symbol biases map. Each symbol gets its own direction — no more
    // collapsing tariff/geopolitical posts into a single bullish/bearish for everything.
    const incoming = classification.biases || {};
    TRUMP_VALID_SYMBOLS.forEach(s => {
      trumpBiases[s] = ['bullish','bearish','neutral'].includes(incoming[s]) ? incoming[s] : 'neutral';
    });
    trumpBiasTs = Date.now();
    trumpIntensity = classification.intensity;
    const biasSummary = TRUMP_VALID_SYMBOLS.map(s => s + ':' + trumpBiases[s][0].toUpperCase()).join(' ');
    log('TRUMP', '🇺🇸 ' + biasSummary + ' (i' + classification.intensity + ', topics ' + classification.topics.join(',') + ') — "' + postText.slice(0, 120) + '"');
    // Notification throttle: only push when bias CHANGES from last push, OR when throttle gap
    // has elapsed. Stops every-minute notification spam from poll-loop re-classification, and
    // limits flurries of same-direction tweets to one notification per throttle window.
    const now = Date.now();
    const biasChanged = classification.bias !== trumpLastPushBias;
    const throttleElapsed = now - trumpLastPushTs > TRUMP_PUSH_THROTTLE_MS;
    if (biasChanged || throttleElapsed) {
      sendPush('🇺🇸 Trump ' + classification.bias.toUpperCase() + ' (i' + classification.intensity + ')',
        classification.topics.join(', ') + ' · ' + postText.slice(0, 100), 'trump');
      trumpLastPushTs = now;
      trumpLastPushBias = classification.bias;
    } else {
      const remainMin = Math.ceil((TRUMP_PUSH_THROTTLE_MS - (now - trumpLastPushTs)) / 60000);
      log('TRUMP', '· push throttled — same bias, ' + remainMin + 'm until next allowed');
    }
  } else {
    log('TRUMP', '· low-impact post (relevant=' + classification.market_relevant + ', intensity=' + classification.intensity + ') — no bias update');
  }
  saveTrumpState();
}

// ===== TRUMP FEED POLLER =====
// Polls a configured feed URL on an interval, fetches new posts, dedupes by ID, and pushes
// each through the same classifyTrumpPost() + applyTrumpClassification() pipeline used by
// the /trump/post webhook. Set TRUMP_FEED_URL to enable. Disable by leaving it empty.
//
// Recommended source — RSSHub mirror of Truth Social (free, public, JSON Feed format):
//   TRUMP_FEED_URL=https://rsshub.app/truthsocial/realDonaldTrump?format=json
// Polling interval defaults to 5 minutes. Lower for fresher signal, higher to reduce load.
const TRUMP_FEED_URL = process.env.TRUMP_FEED_URL || '';
const TRUMP_POLL_INTERVAL_MS = parseInt(process.env.TRUMP_POLL_INTERVAL_MS) || 300000; // 5 min

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTrumpFeed(body) {
  // Try JSON Feed (https://www.jsonfeed.org/) first — most modern format from RSSHub
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json.items)) {
      return json.items.map(it => ({
        id: it.id || it.url || it.guid || '',
        text: decodeHtmlEntities(it.content_text || it.content_html || it.summary || it.title || '')
      })).filter(it => it.id && it.text);
    }
    if (Array.isArray(json.posts)) {
      return json.posts.map(it => ({
        id: it.id || it.url || '',
        text: decodeHtmlEntities(it.content || it.text || it.body || '')
      })).filter(it => it.id && it.text);
    }
  } catch (e) { /* not JSON — fall through to RSS XML */ }

  // RSS / Atom XML fallback — extract each <item> or <entry>
  // Strip <![CDATA[ ... ]]> wrappers BEFORE decodeHtmlEntities, otherwise its tag-stripper
  // (/<[^>]+>/g) eats `<![CDATA[<p>` but leaves an orphan `]]>` token in the text.
  const stripCdata = s => (s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
  const itemBlocks = body.match(/<(?:item|entry)[^>]*>[\s\S]*?<\/(?:item|entry)>/g) || [];
  return itemBlocks.map(blk => {
    const guid = (blk.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || '';
    const link = (blk.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
    const id = (blk.match(/<id[^>]*>([\s\S]*?)<\/id>/) || [])[1] || '';
    const title = (blk.match(/<title[^>]*(?:\s\/>|>)([\s\S]*?)<\/title>/) || [])[1] || '';
    const desc = (blk.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [])[1] || '';
    const content = (blk.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
    const summary = (blk.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '';
    return {
      id: stripCdata(guid || link || id || title).trim(),
      text: decodeHtmlEntities(stripCdata(content || desc || summary || title))
    };
  }).filter(it => it.id && it.text);
}

async function pollTrumpFeed() {
  if (!TRUMP_FEED_URL) return;
  try {
    const u = new URL(TRUMP_FEED_URL);
    const httpsLib = u.protocol === 'http:' ? require('http') : require('https');
    const body = await new Promise((resolve, reject) => {
      const req = httpsLib.get({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers: { 'User-Agent': '0DTE-Signal-Server/1.0', 'Accept': 'application/json, application/feed+json, application/rss+xml, application/atom+xml, */*' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow one redirect
          return reject(new Error('Redirect to ' + res.headers.location + ' — point TRUMP_FEED_URL there directly'));
        }
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        let chunks = '';
        res.on('data', c => chunks += c);
        res.on('end', () => resolve(chunks));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    });

    const items = parseTrumpFeed(body);
    if (items.length === 0) {
      console.error('[' + ts() + '] Trump feed poll: no items parsed (feed format may have changed)');
      return;
    }

    // Process up to 5 most recent posts, oldest-first so the LATEST post wins as final state.
    // Most feeds return newest-first; we slice the first 5 then reverse.
    // Dedup uses trumpRecentIds Set (last 100 ids) — the previous single-id check only caught
    // the absolute-last processed post, causing older posts in the slice to be re-classified
    // every poll (= notification spam every minute).
    const recent = items.slice(0, 5).reverse();
    let newCount = 0;
    for (const item of recent) {
      if (trumpRecentIds.has(item.id)) continue; // already classified — proper Set dedup
      // Classify + apply (same code path as /trump/post webhook)
      const classification = await classifyTrumpPost(item.text);
      applyTrumpClassification(item.id, item.text, classification);
      newCount++;
    }
    if (newCount > 0) {
      const summary = TRUMP_VALID_SYMBOLS.map(s => s + ':' + (trumpBiases[s] || 'n')[0].toUpperCase()).join(' ');
      log('TRUMP', '📡 Feed poll: ' + newCount + ' new post(s) classified · ' + summary + (trumpIntensity ? ' (i' + trumpIntensity + ')' : ''));
    }
  } catch (e) {
    console.error('[' + ts() + '] Trump feed poll failed:', e.message);
  }
}

if (TRUMP_FEED_URL) {
  setTimeout(pollTrumpFeed, 10000);                       // first poll 10s after startup
  setInterval(pollTrumpFeed, TRUMP_POLL_INTERVAL_MS);     // then on the configured interval
}

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
function gETDow() {
  // Day of week in ET timezone — 0 = Sunday, 6 = Saturday
  const e = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return e.getDay();
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
  // ===== BLOCKED-ATTEMPT TRACKING (added 2026-05-22) =====
  // Auto-capture any message containing "BLOCKED" or "SUPPRESSED" into S[sym].blockedAttempts
  // so the /status endpoint can surface why signals didn't fire. Useful for diagnosing
  // over-gating without needing to read Railway logs (e.g., BTC dropped from 4-5/day to
  // 0-1/day — we need to see what's getting eliminated).
  try {
    if (S && S[sym] && (msg.includes('BLOCKED') || msg.includes('SUPPRESSED'))) {
      S[sym].blockedAttempts = S[sym].blockedAttempts || [];
      S[sym].blockedAttempts.push({ ts: Date.now(), time: ts(), msg: msg.substring(0, 240) });
      if (S[sym].blockedAttempts.length > 30) S[sym].blockedAttempts.shift();
    }
  } catch (e) { /* never let blocked-tracking crash logging */ }
}

// ===== PERSISTENT SIGNAL LOGGING =====
const SIGNALS_DIR = path.join(DATA_DIR, 'signal_logs');
try { fs.mkdirSync(SIGNALS_DIR, { recursive: true }); } catch (e) {}

function todayDateET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

// ===== TRADIER OPTION CHAIN HELPERS (added 2026-05-20, updated 2026-05-20 for premium-picker) =====
// Fetch the full chain (all strikes) for a symbol+expiration+type. Used both for the
// initial premium-based strike picker AND for the real-time bid poller below.
async function fetchTradierChain(symbol, expiration, optionType) {
  if (!TRADIER_TOKEN) return null;
  const url = TRADIER_BASE + '/markets/options/chains?symbol=' + symbol +
              '&expiration=' + expiration + '&greeks=false';
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + TRADIER_TOKEN,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      console.log('[' + ts() + '] Tradier ' + symbol + ' chain ' + expiration + ' fetch failed: HTTP ' + res.status);
      return null;
    }
    const data = await res.json();
    const options = data && data.options && data.options.option ? data.options.option : null;
    if (!Array.isArray(options) || options.length === 0) return null;
    return options.filter(o => o.option_type === optionType);
  } catch (e) {
    console.log('[' + ts() + '] Tradier fetch error: ' + e.message);
    return null;
  }
}

// Fetch a specific option's current quote (bid/ask/mid). Returns null on failure.
async function fetchTradierOptionQuote(symbol, expiration, strike, optionType) {
  const chain = await fetchTradierChain(symbol, expiration, optionType);
  if (!chain) return null;
  const match = chain.find(o => Math.abs((o.strike || 0) - strike) < 0.01);
  if (!match) return null;
  const bid = parseFloat(match.bid) || 0;
  const ask = parseFloat(match.ask) || 0;
  const last = parseFloat(match.last) || 0;
  const mid = (bid > 0 && ask > 0) ? +((bid + ask) / 2).toFixed(2) : last;
  return { bid: +bid.toFixed(2), ask: +ask.toFixed(2), mid: mid, last: +last.toFixed(2) };
}

// 0DTE expiration date in YYYY-MM-DD ET (Tradier uses NY date for SPY/QQQ daily options)
function todayExpirationET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ===== OPTION PREMIUM PICKER (added 2026-05-20) =====
// User strategy: pick option whose MID is closest to a target premium (default $0.90).
// Allows the bot to systematically buy OTM options with consistent premium cost rather
// than ATM strikes (which vary in cost dramatically based on IV and time-to-expiry).
const OPTION_TARGET_PREMIUM = parseFloat(process.env.OPTION_TARGET_PREMIUM) || 0.90;
const OPTION_TP1_TRIGGER_BID = parseFloat(process.env.OPTION_TP1_TRIGGER_BID) || 1.00;
const OPTION_INITIAL_SL_BID  = parseFloat(process.env.OPTION_INITIAL_SL_BID)  || 0.80;
const OPTION_SCRATCH_SL_BID  = parseFloat(process.env.OPTION_SCRATCH_SL_BID)  || 0.90;
const OPTION_POLL_INTERVAL_MS = parseInt(process.env.OPTION_POLL_INTERVAL_MS) || 30000;
const OPTION_TRACK_TIMEOUT_MS = parseInt(process.env.OPTION_TRACK_TIMEOUT_MS) || 30 * 60 * 1000;

async function pickOptionByTargetPremium(symbol, expiration, optionType, targetPremium) {
  const chain = await fetchTradierChain(symbol, expiration, optionType);
  if (!chain || chain.length === 0) return null;
  // Find option whose mid is closest to target
  let best = null;
  let bestDistance = Infinity;
  for (const o of chain) {
    const bid = parseFloat(o.bid) || 0;
    const ask = parseFloat(o.ask) || 0;
    if (bid <= 0 || ask <= 0) continue; // skip illiquid/no-quote strikes
    const mid = (bid + ask) / 2;
    const distance = Math.abs(mid - targetPremium);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = {
        strike: parseFloat(o.strike),
        bid: +bid.toFixed(2),
        ask: +ask.toFixed(2),
        mid: +mid.toFixed(2),
        last: parseFloat(o.last) || 0,
        volume: parseInt(o.volume) || 0,
        openInterest: parseInt(o.open_interest) || 0,
        iv: parseFloat(o.iv) || 0,
        delta: parseFloat(o.delta) || 0,
        gamma: parseFloat(o.gamma) || 0,
        theta: parseFloat(o.theta) || 0
      };
    }
  }
  return best;
}

// ===== REAL-TIME OPTION TRACKER (added 2026-05-20) =====
// Active tracks polled every 30s. Each track represents a live "trade" — entry option
// picked by premium, then bid monitored until TP1 / scratch SL / initial SL / timeout.
// State machine:
//   active → (bid ≥ $1.00) → tp1Hit=true, effectiveSlBid=$0.90
//   active → (bid ≤ $0.80) → SL exit
//   tp1Hit → (bid ≤ $0.90) → SCRATCH exit (breakeven)
//   tp1Hit → (bid keeps going) → track maxBid; user exits manually
//   any → (timeout 30min) → TIMEOUT exit
let activeOptionTracks = []; // [{ histIdx, symbol, strike, type, expiry, ...state }]

// Fire-and-forget — picks option, opens a track, signal emit doesn't block.
async function trackEquityOptionEntry(entry, signalPrice, optionType) {
  if (!TRADIER_TOKEN) return;
  if (entry.symbol !== 'QQQ' && entry.symbol !== 'SPY') return;
  // Capture histIdx BEFORE awaiting Tradier — caller must call this AFTER signalHistory.push(entry)
  // so the index lines up. If we awaited first, another signal could push and shift the index.
  const histIdx = signalHistory.length - 1;
  const expiry = todayExpirationET();
  const picked = await pickOptionByTargetPremium(entry.symbol, expiry, optionType, OPTION_TARGET_PREMIUM);
  if (!picked) {
    log(entry.symbol, '⚠️ Tradier option pick failed (' + optionType + ' ~$' + OPTION_TARGET_PREMIUM + ' ' + expiry + ') — option tracking skipped');
    return;
  }
  // Store initial state on history entry
  entry.option0dte = {
    strike: picked.strike,
    expiry: expiry,
    type: optionType,
    targetPremium: OPTION_TARGET_PREMIUM,
    entryMid: picked.mid,
    entryBid: picked.bid,
    entryAsk: picked.ask,
    entryDelta: picked.delta,
    entryIv: picked.iv,
    tp1TriggerBid: OPTION_TP1_TRIGGER_BID,
    initialSlBid: OPTION_INITIAL_SL_BID,
    scratchSlBid: OPTION_SCRATCH_SL_BID,
    effectiveSlBid: OPTION_INITIAL_SL_BID,
    tp1Hit: false,
    tp1HitTs: null,
    tp1HitBid: null,
    maxBid: picked.bid,
    minBid: picked.bid,
    outcome: 'active',
    exitBid: null,
    exitTs: null,
    exitReason: null,
    polls: [{ ts: Date.now(), bid: picked.bid, ask: picked.ask }]
  };
  // Push to active tracks for polling — use the index captured before the await
  activeOptionTracks.push({
    histIdx: histIdx,
    symbol: entry.symbol,
    strike: picked.strike,
    type: optionType,
    expiry: expiry,
    startTs: Date.now()
  });
  log(entry.symbol, '📋 0DTE ' + optionType.toUpperCase() + ' $' + picked.strike + ' picked @ mid $' + picked.mid.toFixed(2) + ' (bid ' + picked.bid + ', ask ' + picked.ask + ', delta ' + picked.delta.toFixed(2) + ') — tracking for bid ≥ $' + OPTION_TP1_TRIGGER_BID);
  try { saveSignalHistory(); } catch (e) {}
}

// Process all active option tracks — called by setInterval below
async function pollActiveOptionTracks() {
  if (!TRADIER_TOKEN || activeOptionTracks.length === 0) return;
  const now = Date.now();
  const stillActive = [];
  for (const tr of activeOptionTracks) {
    const entry = signalHistory[tr.histIdx];
    if (!entry || !entry.option0dte) continue; // entry gone or no option data
    const od = entry.option0dte;

    // Timeout check first
    const elapsedMs = now - tr.startTs;
    if (elapsedMs > OPTION_TRACK_TIMEOUT_MS) {
      od.outcome = od.tp1Hit ? 'TP1_TIMEOUT' : 'TIMEOUT';
      od.exitTs = now;
      od.exitReason = 'timeout';
      log(tr.symbol, '⏱ 0DTE option ' + tr.type.toUpperCase() + ' $' + tr.strike + ' TIMEOUT after ' + (elapsedMs/60000).toFixed(1) + 'min · maxBid $' + od.maxBid.toFixed(2) + ' · TP1 ' + (od.tp1Hit ? 'hit' : 'never'));
      try { saveSignalHistory(); } catch (e) {}
      continue; // don't push to stillActive
    }

    // Fetch current quote
    const q = await fetchTradierOptionQuote(tr.symbol, tr.expiry, tr.strike, tr.type);
    if (!q) {
      stillActive.push(tr); // keep trying
      continue;
    }
    od.polls.push({ ts: now, bid: q.bid, ask: q.ask });
    if (od.polls.length > 120) od.polls.shift(); // cap memory (60 min @ 30s)
    if (q.bid > od.maxBid) od.maxBid = q.bid;
    if (q.bid < od.minBid) od.minBid = q.bid;

    // State transitions
    if (!od.tp1Hit && q.bid >= od.tp1TriggerBid) {
      od.tp1Hit = true;
      od.tp1HitTs = now;
      od.tp1HitBid = q.bid;
      od.effectiveSlBid = od.scratchSlBid; // SL → $0.90 (breakeven from $0.90 entry target)
      od.outcome = 'TP1';
      log(tr.symbol, '🎯 0DTE option TP1 HIT — ' + tr.type.toUpperCase() + ' $' + tr.strike + ' bid $' + q.bid.toFixed(2) + ' ≥ $' + od.tp1TriggerBid + ' · SL moved to $' + od.scratchSlBid + ' (breakeven) · tracking for more upside');
      try { saveSignalHistory(); } catch (e) {}
    }

    // SL check (initial OR scratch)
    if (q.bid <= od.effectiveSlBid) {
      od.exitBid = q.bid;
      od.exitTs = now;
      od.exitReason = od.tp1Hit ? 'scratch' : 'initial_sl';
      od.outcome = od.tp1Hit ? 'TP1_SCRATCH' : 'SL';
      log(tr.symbol, (od.tp1Hit ? '🛡 0DTE option SCRATCH' : '🛑 0DTE option SL') + ' — ' + tr.type.toUpperCase() + ' $' + tr.strike + ' bid $' + q.bid.toFixed(2) + ' ≤ $' + od.effectiveSlBid + ' · maxBid was $' + od.maxBid.toFixed(2));
      try { saveSignalHistory(); } catch (e) {}
      continue; // remove from active
    }

    stillActive.push(tr);
  }
  activeOptionTracks = stillActive;
}

// Kick off the polling loop (called once at server start, near other setInterval setups)
let optionPollerStarted = false;
function startOptionPoller() {
  if (optionPollerStarted) return;
  if (!TRADIER_TOKEN) {
    console.log('[STARTUP] Option tracker: TRADIER_TOKEN not set — skipping poller');
    return;
  }
  optionPollerStarted = true;
  setInterval(() => {
    pollActiveOptionTracks().catch(e => console.log('[' + ts() + '] pollActiveOptionTracks error: ' + e.message));
  }, OPTION_POLL_INTERVAL_MS);
  console.log('[STARTUP] Option tracker: polling active tracks every ' + (OPTION_POLL_INTERVAL_MS/1000) + 's · target premium $' + OPTION_TARGET_PREMIUM + ' · TP1 ≥$' + OPTION_TP1_TRIGGER_BID + ' · initial SL ≤$' + OPTION_INITIAL_SL_BID + ' · scratch SL ≤$' + OPTION_SCRATCH_SL_BID + ' · timeout ' + (OPTION_TRACK_TIMEOUT_MS/60000) + 'min');
}

// ===== 7-DAY SIGNAL HISTORY (survives daily resets + redeploys) =====
const HISTORY_FILE = path.join(DATA_DIR, 'signal_history.json');
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let signalHistory = []; // [{date, time, ts, symbol, type, price, score, rsi, macd, roc, vix, chop, num, trv2}]

function loadSignalHistory() {
  // Try primary then .bak fallback. The .bak file is the previous successful write — if a
  // crash mid-write corrupted the primary, the .bak is the last known-good state.
  const candidates = [HISTORY_FILE, HISTORY_FILE + '.bak'];
  for (const file of candidates) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      if (!txt || txt.trim().length === 0) { throw new Error('empty file'); }
      const raw = JSON.parse(txt);
      const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
      signalHistory = (raw || []).filter(h => h.ts > cutoff);
      console.log('[' + ts() + '] Signal history loaded — ' + signalHistory.length + ' signals (last 7 days) from ' + (file === HISTORY_FILE ? 'primary' : 'BACKUP (.bak)'));
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
      return; // success — done
    } catch (e) {
      console.log('[' + ts() + '] Signal history load failed from ' + file + ': ' + e.message);
    }
  }
  console.log('[' + ts() + '] No usable signal history file — starting fresh');
}

// Track save activity for visibility — log throttled at 1 per minute even when called many times.
let _lastSaveSignalHistoryLogTs = 0;
let _saveSignalHistoryCallCount = 0;
function saveSignalHistory() {
  try {
    // Prune entries older than 7 days before saving
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    signalHistory = signalHistory.filter(h => h.ts > cutoff);
    const payload = JSON.stringify(signalHistory);
    // ATOMIC WRITE + FSYNC (added 2026-05-15 after Railway container restart wiped
    // /data/signal_history.json mid-write):
    //   1. Write to a temp file (so a crash mid-write never corrupts the primary)
    //   2. fsync the temp file (force OS page cache → durable storage)
    //   3. If primary exists, copy it to .bak (last-known-good fallback for load)
    //   4. Rename temp → primary (POSIX atomic on the same filesystem)
    // This is the standard "atomic-rename" pattern. Without fsync, fs.writeFileSync()
    // returns before the OS has actually durably written the data — on a network volume
    // like Railway's, a fast container kill can lose those buffered writes.
    const tmpFile = HISTORY_FILE + '.tmp';
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Roll the previous primary to .bak before atomic rename (best-effort; ENOENT is fine)
    if (fs.existsSync(HISTORY_FILE)) {
      try { fs.copyFileSync(HISTORY_FILE, HISTORY_FILE + '.bak'); } catch (e) { /* not fatal */ }
    }
    fs.renameSync(tmpFile, HISTORY_FILE);
    _saveSignalHistoryCallCount++;
    // Throttled startup-visible log so we can see persistence is alive (1/min cap).
    const now = Date.now();
    if (now - _lastSaveSignalHistoryLogTs > 60000) {
      console.log('[' + ts() + '] 💾 saveSignalHistory — ' + signalHistory.length + ' entries persisted (atomic+fsync) to ' + HISTORY_FILE + ' (' + _saveSignalHistoryCallCount + ' saves since startup)');
      _lastSaveSignalHistoryLogTs = now;
      _saveSignalHistoryCallCount = 0;
    }
  } catch (e) {
    console.error('[' + ts() + '] ❌ Failed to save signal history:', e.message);
    // If the directory is missing (e.g. volume not mounted), recreate it once
    if (e.code === 'ENOENT') {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // Retry with same atomic pattern
        const tmpFile = HISTORY_FILE + '.tmp';
        const fd = fs.openSync(tmpFile, 'w');
        try { fs.writeSync(fd, JSON.stringify(signalHistory)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmpFile, HISTORY_FILE);
        console.log('[' + ts() + '] ✅ saveSignalHistory recovered — recreated DATA_DIR');
      } catch (e2) { console.error('[' + ts() + '] ❌ Recovery write also failed:', e2.message); }
    }
  }
}

// Periodic backup save — every 60 seconds, catches snapshot updates and outcome changes
// that may not trigger an explicit save through logSignal or updateSignalOutcome.
setInterval(() => {
  try { saveSignalHistory(); } catch (e) { /* error already logged in saveSignalHistory */ }
}, 60000);
console.log('[STARTUP] Persistence: signalHistory saves every 60s + on every emit/outcome update');

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
  // Chop circuit breaker bookkeeping (added 2026-05-13): if this signal is the opposite
  // direction of the previous one for this symbol, record the timestamp in flipHistory.
  // The breaker logic (in the detector preamble) checks if flipHistory has >=3 entries in
  // the last 60 min — if so, opposite-direction signals are suppressed for 30 min.
  // Done here (vs each detector site) so we only have one source of truth.
  try {
    const s = S[sym];
    if (s && Array.isArray(s.signals) && s.signals.length >= 2) {
      const prev = s.signals[s.signals.length - 2]; // the new sig was already pushed before logSignal
      if (prev && prev.type && sig.type && prev.type !== sig.type) {
        if (!Array.isArray(s.flipHistory)) s.flipHistory = [];
        s.flipHistory.push(Date.now());
      }
    }
  } catch (e) { /* never let chop-breaker bookkeeping crash signal emission */ }

  // Per-direction signal timestamps for cross-asset confluence (added 2026-05-16).
  // Updated centrally here (one place, covers every detector site) instead of editing every emit.
  // NAS conviction reads S['QQQ'].lastCallSignalTs / lastPutSignalTs; symmetric for QQQ→NAS.
  try {
    const s = S[sym];
    if (s && sig.type === 'call') s.lastCallSignalTs = Date.now();
    else if (s && sig.type === 'put') s.lastPutSignalTs = Date.now();
  } catch (e) { /* never crash signal emission on bookkeeping */ }

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
  // Wrap CSV write in try/catch (added 2026-05-12). Previously unhandled — if disk was full,
  // permissions wrong, or DATA_DIR/signal_logs didn't exist post-restart, the signal would
  // emit in-memory (push notif fires, mobile sees it) but the file write would silently fail
  // OR throw and break the calling code. Now we log the failure explicitly so we can see it
  // in Railway logs AND attempt to recreate the directory if it's missing.
  try {
    if (!exists) fs.writeFileSync(file, header + row);
    else fs.appendFileSync(file, row);
  } catch (e) {
    console.error('[' + ts() + '] CSV WRITE FAILED for ' + sym + ' ' + sig.type + ' @ $' + sig.price + ' — ' + e.message);
    // If directory got wiped (e.g. volume re-mounted), recreate and retry once
    if (e.code === 'ENOENT') {
      try {
        fs.mkdirSync(SIGNALS_DIR, { recursive: true });
        fs.writeFileSync(file, header + row);
        console.log('[' + ts() + '] CSV recovered — recreated ' + SIGNALS_DIR + ' and wrote signal');
      } catch (e2) {
        console.error('[' + ts() + '] CSV recovery also failed: ' + e2.message);
      }
    }
  }

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
    conv: sig.conv || null,
    // Outcome tracking (added 2026-05-12) — updated by checkExit() when trade flags flip.
    // Boolean fields stay false until TP1/TP2/TP3/SL price is touched. Used by CSV export
    // to surface trade outcome per signal.
    outcomes: {}
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

  // QQQ/SPY 0DTE option tracking — fire-and-forget Tradier fetch
  // Placed AFTER push so signalHistory.length - 1 = this entry's index inside trackEquityOptionEntry.
  if ((sym === 'QQQ' || sym === 'SPY') && (sig.type === 'call' || sig.type === 'put')) {
    trackEquityOptionEntry(histEntry, sig.price, sig.type).catch(e =>
      console.log('[' + ts() + '] trackEquityOptionEntry error for ' + sym + ': ' + e.message));
  }

  // Fast-forward previous signal's outcomes before reassigning lastHistIdx (added 2026-05-13).
  // BUG it fixes: when a same-direction signal fires while a previous trade is still active,
  // the detector overwrites s.trade with buildCfdTrade() right after logSignal. Any subsequent
  // TP2/TP3 hits are then tracked against the NEW signal's levels, leaving the previous signal
  // frozen at whatever level it had reached at handoff time. Caught 5/12 BTC row 1: PUT @ $80,786
  // marked TP1-only even though price went to $79,800 (which would have hit signal #1's TP2 and
  // TP3 levels by a wide margin). Here we check the OLD trade's bestPrice against its OWN
  // tp2/tp3 levels and mark the previous signal's outcomes accordingly.
  try {
    const sOld = S[sym];
    const oldIdx = sOld.lastHistIdx;
    const t = sOld.trade;
    if (oldIdx != null && t && t.active && t.isCfd && typeof t.bestPrice === 'number') {
      const oldEntry = signalHistory[oldIdx];
      if (oldEntry && oldEntry.symbol === sym) {
        if (!oldEntry.outcomes) oldEntry.outcomes = {};
        const iC = t.type === 'call';
        const now = Date.now();
        // TP1
        if (!oldEntry.outcomes.tp1Hit && ((iC && t.bestPrice >= t.tp1Price) || (!iC && t.bestPrice <= t.tp1Price))) {
          oldEntry.outcomes.tp1Hit = true; oldEntry.outcomes.tp1HitTs = now;
        }
        // TP2
        if (!oldEntry.outcomes.tp2Hit && ((iC && t.bestPrice >= t.tp2Price) || (!iC && t.bestPrice <= t.tp2Price))) {
          oldEntry.outcomes.tp2Hit = true; oldEntry.outcomes.tp2HitTs = now;
        }
        // TP3 (only mark if reached and SL hasn't been hit on this trade)
        if (!oldEntry.outcomes.tp3Hit && !oldEntry.outcomes.slHit
            && ((iC && t.bestPrice >= t.tp3Price) || (!iC && t.bestPrice <= t.tp3Price))) {
          oldEntry.outcomes.tp3Hit = true; oldEntry.outcomes.tp3HitTs = now;
          oldEntry.outcomes.closePrice = t.bestPrice;
        }
      }
    }
  } catch (e) { /* never let outcome fast-forward crash signal emission */ }

  // Track which signalHistory index represents the active trade for this symbol.
  // checkExit() uses this to update outcomes when t.t1/t.t2/t.sl flags flip.
  S[sym].lastHistIdx = signalHistory.length - 1;

  // Schedule post-signal price snapshots at +5m / +15m / +30m (added 2026-05-14).
  // processPrice() will check pendingSnapshots each tick and populate priceSnaps on the
  // signalHistory entry as time elapses. CSV export reads these to add price5m/delta5m/
  // price15m/delta15m/price30m/delta30m columns.
  try {
    const s = S[sym];
    if (s && Array.isArray(s.pendingSnapshots)) {
      s.pendingSnapshots.push({ histIdx: signalHistory.length - 1, fireTs: Date.now() });
    }
  } catch (e) { /* never crash signal emission on snapshot scheduling */ }

  // Record fire for same-direction cap tracking (added 2026-05-14).
  // 30-min rolling window, max 2 same-direction signals before block.
  try {
    const s = S[sym];
    if (s) {
      if (!Array.isArray(s.recentFires)) s.recentFires = [];
      s.recentFires.push({ ts: Date.now(), type: sig.type });
      // Trim entries older than 60 min (window is 30 min, keep some buffer for analysis)
      const cutoff = Date.now() - 3600000;
      s.recentFires = s.recentFires.filter(f => f.ts > cutoff);
    }
  } catch (e) { /* never crash signal emission on cap tracking */ }

  // Persist signalHistory after every emit (added 2026-05-14 to fix data loss on Railway
  // deploys). Was only saving on shutdown + daily reset — Railway deploys SIGTERM with a
  // short grace window and sometimes lost the in-memory state. Per-signal save is cheap
  // (file ~20KB at peak) and guarantees zero loss on crash/redeploy.
  try { saveSignalHistory(); } catch (e) { /* already logged */ }
}

// ===== PROCESS PRICE (same engine as mobile/desktop) =====
function processPrice(sym, price, hi, lo) {
  const s = S[sym];
  const mi = MAX_IND[sym];
  const isXAU = sym === 'XAU';
  const isBTC = sym === 'BTC';
  const isNAS = sym === 'NAS100';
  const isMT5 = isXAU || isBTC || isNAS; // MT5-fed instruments (extended hours, no VWAP, no Finnhub WS)

  // ===== SIGNAL-EMIT STATE SNAPSHOT (added 2026-05-08) =====
  // Captures all signal-emit-related state at the start of every tick. Used by enrichSig()
  // below: when the conviction gate blocks a signal, the emit code has already mutated
  // dailySignalCount, cooldown timers, and detector-specific timestamps. We restore
  // those mutations from this snapshot so blocked signals don't leave gaps in the num
  // sequence (#3 → ??? → #5) and don't burn cooldown windows for signals that didn't
  // actually fire. Indicator state (prices/EMAs/RSI/etc.) is intentionally NOT in here —
  // those are mutated continuously by tick processing, not by emit code.
  const _emitSnapshot = {
    dailySignalCount: s.dailySignalCount,
    nC: s.nC, nP: s.nP,
    lastAT: s.lastAT,
    lastSignalDir: s.lastSignalDir,
    lastSignalTs: s.lastSignalTs,
    lastNTs: s.lastNTs,
    lastSameDir: s.lastSameDir,
    lastSameDirMacd: s.lastSameDirMacd,
    lastSameDirTs: s.lastSameDirTs,
    lastSameDirPrice: s.lastSameDirPrice,
    lastReversalTs: s.lastReversalTs,
    fastMoveLastTs: s.fastMoveLastTs,
    fastLastDir: s.fastLastDir,
    sustainedMoveLastTs: s.sustainedMoveLastTs,
    vrevLastTs: s.vrevLastTs,
    divLastFireTs: s.divLastFireTs,
    sweepLastFireTs: s.sweepLastFireTs,
    sweepWatchUpStart: s.sweepWatchUpStart,
    sweepWatchDownStart: s.sweepWatchDownStart,
    sqzLastFireTs: s.sqzLastFireTs,
    breakLastTs: s.breakLastTs,
    breakLastDir: s.breakLastDir,
    breakLastPrice: s.breakLastPrice,
    breakSameDirCount: s.breakSameDirCount,
    breakLegStartTs: s.breakLegStartTs,
    macroFlipTs: s.macroFlipTs,
    macroPrevDir: s.macroPrevDir,
    superFlipTs: s.superFlipTs,
    trendRideLastTs: s.trendRideLastTs,
    trendRideSameDirCount: s.trendRideSameDirCount,
    trendRideLastDir: s.trendRideLastDir,
    trendRideLastPrice: s.trendRideLastPrice,
    athApproachTs: s.athApproachTs,
    lastAthPutTs: s.lastAthPutTs,
    lastAthPutPrice: s.lastAthPutPrice,
    atlApproachTs: s.atlApproachTs,
    lastAtlCallTs: s.lastAtlCallTs,
    lastAtlCallPrice: s.lastAtlCallPrice,
    lastHiRevTs: s.lastHiRevTs
  };

  // XAU/BTC: set open on first price (MT5 feeds only when market is open)
  // Equities: set open at 9:30 AM ET (570 min)
  if (s.openPrice === null && (isMT5 || gET() >= 570)) {
    s.openPrice = price;
    if (s.prevClose !== null) {
      const gapPct = ((price - s.prevClose) / s.prevClose) * 100;
      if (Math.abs(gapPct) >= 2) { s.gapDayMode = true; s.gapDirection = gapPct > 0 ? 'up' : 'down'; log(sym, '🔥 GAP DAY: ' + gapPct.toFixed(2) + '% ' + s.gapDirection); }
    }
  }

  if (price > s.sessionHigh) { s.sessionHigh = price; s.sessionHighUpdateTs = Date.now(); }
  if (price < s.sessionLow) { s.sessionLow = price; s.sessionLowUpdateTs = Date.now(); }

  // Update rolling 5-day high/low for ATH/ATL detector
  // Simple approach: rollingHigh = max(past 5 daily highs, today's sessionHigh)
  // rollingLow = min(past 5 daily lows, today's sessionLow)
  // Daily levels are saved at daily reset time.
  if (isMT5 && price > 0) {
    // Seed from current price if unset
    if (s.rollingHigh === 0) s.rollingHigh = price;
    if (s.rollingLow === Infinity || s.rollingLow === 0) s.rollingLow = price;
    // Update from today's session extremes + current price (real-time, every tick).
    // Stamp rollingHighUpdateTs / rollingLowUpdateTs whenever a new extreme is set —
    // ATL/ATH detectors use these to detect "trend in progress" (new extreme made
    // recently = market is making new lows/highs = NOT a reversal setup).
    const nowTs = Date.now();
    // priorRangeHigh / priorRangeLow snapshot the previous rolling level BEFORE the breakout
    // (added 2026-05-13 for big-washout override on ATL/ATH trend-block — see ATL section).
    // Only captured at the moment a new extreme is set, so it represents what the prior range
    // was right before this breakout/breakdown.
    if (price > s.rollingHigh) { s.priorRangeHigh = s.rollingHigh; s.rollingHigh = price; s.rollingHighUpdateTs = nowTs; }
    if (price < s.rollingLow)  { s.priorRangeLow  = s.rollingLow;  s.rollingLow  = price; s.rollingLowUpdateTs  = nowTs; }
    if (s.sessionHigh > -Infinity && s.sessionHigh > s.rollingHigh) { s.priorRangeHigh = s.rollingHigh; s.rollingHigh = s.sessionHigh; s.rollingHighUpdateTs = nowTs; }
    if (s.sessionLow < Infinity && s.sessionLow < s.rollingLow)     { s.priorRangeLow  = s.rollingLow;  s.rollingLow  = s.sessionLow;  s.rollingLowUpdateTs  = nowTs; }
  }

  s.prices.push(price); s.highs.push(hi || price); s.lows.push(lo || price);

  // Post-signal price snapshots (added 2026-05-14). For each pending signal entry, check if
  // we've crossed the +5min / +15min / +30min thresholds since fire and capture the price.
  // Once all 3 captured (or histEntry missing), remove from pending list.
  //
  // EQUITY OUTCOME TRACKING (updated 2026-05-20): QQQ/SPY signals are 0DTE option triggers
  // with fast theta decay — meaningful action happens in the first 5-15 min. Time-based
  // outcome model using 5/10/15 min snapshots instead of MT5's 5/15/30:
  //   TP1 at 5min:  favorable move >= $0.15  (option already at ~20-30% gain)
  //   TP2 at 10min: favorable move >= $0.30  (option at ~40-60% gain)
  //   TP3 at 15min: favorable move >= $0.50  (option at ~80-100% gain)
  //   SL at any time: $0.25 against (only if TP1 hasn't hit — TP1 means user took quick profit)
  // Stops at 15min for equities — option theta beyond 15min makes outcomes irrelevant.
  const evalEquityOutcomes = (entry, snapPrice, snapStage) => {
    if (!entry || !entry.outcomes || !entry.price) return;
    if (entry.symbol !== 'QQQ' && entry.symbol !== 'SPY') return;
    const ep = parseFloat(entry.price);
    if (!isFinite(ep)) return;
    const isCall = entry.type === 'call';
    const favMove = isCall ? (snapPrice - ep) : (ep - snapPrice);
    const advMove = -favMove;
    const now = Date.now();
    // Time-staged TP thresholds for 0DTE options
    if (snapStage === '5m'  && !entry.outcomes.tp1Hit && favMove >= 0.15) { entry.outcomes.tp1Hit = true; entry.outcomes.tp1HitTs = now; }
    if (snapStage === '10m' && !entry.outcomes.tp2Hit && favMove >= 0.30) { entry.outcomes.tp2Hit = true; entry.outcomes.tp2HitTs = now; }
    if (snapStage === '15m' && !entry.outcomes.tp3Hit && favMove >= 0.50) { entry.outcomes.tp3Hit = true; entry.outcomes.tp3HitTs = now; entry.outcomes.closePrice = snapPrice; }
    // SL: only if TP1 hasn't hit yet (TP1+scratch logic — quick profit-take protects)
    if (!entry.outcomes.tp1Hit && !entry.outcomes.slHit && advMove >= 0.25) {
      entry.outcomes.slHit = true; entry.outcomes.slHitTs = now; entry.outcomes.closePrice = snapPrice;
    }
  };

  if (Array.isArray(s.pendingSnapshots) && s.pendingSnapshots.length > 0) {
    const tNow = Date.now();
    s.pendingSnapshots = s.pendingSnapshots.filter(ps => {
      const entry = signalHistory[ps.histIdx];
      if (!entry) return false; // signalHistory entry gone — drop
      const ageS = (tNow - ps.fireTs) / 1000;
      if (!entry.priceSnaps) entry.priceSnaps = {};
      let snapWritten = false;
      const isEquity = entry.symbol === 'QQQ' || entry.symbol === 'SPY';

      // 5-min snapshot (all instruments — both MT5 and equities use this)
      if (ageS >= 5 * 60 && entry.priceSnaps.p5m == null) {
        entry.priceSnaps.p5m = +price.toFixed(2); snapWritten = true;
        if (isEquity) {
          evalEquityOutcomes(entry, price, '5m');
          // Async refetch real option premium from Tradier (fire-and-forget)
          snapshotEquityOption(entry, '5m').catch(e =>
            console.log('[' + ts() + '] snapshotEquityOption 5m error: ' + e.message));
        }
      }

      // 10-min snapshot (equities only — for TP2 at 0DTE-relevant timeframe)
      if (isEquity && ageS >= 10 * 60 && entry.priceSnaps.p10m == null) {
        entry.priceSnaps.p10m = +price.toFixed(2); snapWritten = true;
        evalEquityOutcomes(entry, price, '10m');
        snapshotEquityOption(entry, '10m').catch(e =>
          console.log('[' + ts() + '] snapshotEquityOption 10m error: ' + e.message));
      }

      // 15-min snapshot (all instruments — MT5 uses for trade-progress, equities for TP3)
      if (ageS >= 15 * 60 && entry.priceSnaps.p15m == null) {
        entry.priceSnaps.p15m = +price.toFixed(2); snapWritten = true;
        if (isEquity) {
          evalEquityOutcomes(entry, price, '15m');
          snapshotEquityOption(entry, '15m').catch(e =>
            console.log('[' + ts() + '] snapshotEquityOption 15m error: ' + e.message));
          // For equities, p15m completes the outcome window — persist + drop from pending
          try { saveSignalHistory(); } catch (e) { /* already logged */ }
          return false;
        }
      }

      // 30-min snapshot (MT5 only — equities skip this since theta makes 30-min outcomes irrelevant for 0DTE options)
      if (!isEquity && ageS >= 30 * 60 && entry.priceSnaps.p30m == null) {
        entry.priceSnaps.p30m = +price.toFixed(2);
        try { saveSignalHistory(); } catch (e) { /* already logged */ }
        return false; // all MT5 captures done
      }

      // Persist immediately when a snap is freshly captured (covers both equities and MT5 in-progress)
      if (snapWritten) { try { saveSignalHistory(); } catch (e) { /* already logged */ } }
      return true; // still pending
    });
  }
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
    // Symmetric AND + longer dwell (changed 2026-05-08, second pass):
    //   - Both activation AND deactivation use AND (both windows must agree)
    //   - Dwell increased from 3 → 10 consecutive ticks (~10s on MT5 1-tick/sec feed)
    // Why both AND:
    //   - First pass made activation AND (correct: only enter chop when truly choppy on both
    //     short and long timeframes — a 30-sec flat patch during a real trend doesn't trip it).
    //   - First pass also made deactivation OR — that was too eager. Single borderline tick
    //     where ONE window briefly exceeded its reset would flip chop off, then both windows
    //     would dip back below threshold and it'd flip back on. Rapid flicker.
    //   - Symmetric AND fixes that: chop only deactivates when both timeframes clearly resume
    //     (effS > 0.35 AND effL > 0.40 simultaneously for 10 consecutive ticks).
    // Why dwell 10:
    //   - 3 ticks (3 sec on MT5) was too easy to trip with normal price-tick noise.
    //   - 10 ticks ≈ 10s of consistent state required before flipping. Real transitions take
    //     longer than 10s anyway; this kills only the noise-driven flicker.
    const isChoppy   = effS < thrS && effL < thrL;
    const isTrending = effS > resS && effL > resL;
    const dwellTicks = 10;
    if (!s.chopActive) {
      if (isChoppy) { s.chopCount++; s.trendCount = 0; } else { s.chopCount = 0; }
      if (s.chopCount >= dwellTicks) {
        s.chopActive = true; s.chopCount = 0;
        log(sym, '🌊 CHOP MODE');
        // Push notification removed (2026-05-08, by user request) — chop transitions are
        // logged for debugging but no longer alert the phone. Reduces notification noise.
      }
    } else {
      if (isTrending) { s.trendCount++; s.chopCount = 0; } else { s.trendCount = 0; }
      if (s.trendCount >= dwellTicks) {
        s.chopActive = false; s.trendCount = 0;
        log(sym, '📈 TREND RESUMED');
        // Push notification removed (2026-05-08) — see CHOP MODE comment above.
      }
    }
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
  // FIX 2026-05-18: was snapshot-at-first-touch — if RSI was <55 at initial high touch,
  // HI signal was locked out for the rest of the session even when RSI later rose to 60+
  // at the same level. New: track the MAX RSI seen anywhere within proximity of session
  // high (XAU ±$1, BTC ±$50, NAS ±$10). Symmetric: track MIN RSI near session low for LO.
  // This unlocks HI/LO when price drifts up/down slowly with RSI catching up later.
  // sessionHigh/Low itself is updated at line ~1353 (with sessionHighUpdateTs). Here we
  // ONLY track the RSI characterization at those levels.
  const sessionLvlProximity = isBTC ? 50 : isNAS ? 10 : isXAU ? 1 : 0.10;
  if (price >= s.sessionHigh) {
    s.rsiAtSessionHigh = rsiV; // fresh high → fresh RSI snapshot
  } else if (s.sessionHigh > -Infinity && (s.sessionHigh - price) <= sessionLvlProximity) {
    // near session high (within $X) — keep the MAX RSI seen at this level
    if (rsiV > s.rsiAtSessionHigh) s.rsiAtSessionHigh = rsiV;
  }
  if (price <= s.sessionLow) {
    s.rsiAtSessionLow = rsiV;
  } else if (s.sessionLow < Infinity && (price - s.sessionLow) <= sessionLvlProximity) {
    // near session low (within $X) — keep the MIN RSI seen at this level
    if (rsiV < s.rsiAtSessionLow) s.rsiAtSessionLow = rsiV;
  }
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

  // ===== CONVICTION SCORE CALCULATOR (MT5 + QQQ) =====
  // Returns { score: 0-7, label: 'HIGH'|'MOD'|'LOW', factors: [...] } for a given direction.
  // QQQ added 2026-05-22 — uses SPY/NAS/BTC cross-asset alignment as conv factors (since
  // SPY was demoted to indicator-only, it's now an input to QQQ conv rather than a signal source).
  function convictionFor(dir) {
    if (!isMT5 && sym !== 'QQQ') return { score: 0, label: '', factors: [] };
    const isCall = dir === 'call';
    const factors = [];
    let sc = 0;
    // 3. Macro trend aligned (shared — macroEma is computed for QQQ too)
    const macroDir = s.macroEma ? (price > s.macroEma ? 'bull' : 'bear') : null;
    if ((isCall && macroDir === 'bull') || (!isCall && macroDir === 'bear')) { sc++; factors.push('MACRO'); }
    // 6. Multi-TF ROC aligned (MT5-only — roc6/roc12 are 0 on equities so the check below would always fail)
    // 7. Price structure aligned (MT5-only — _priceStructure detector is gated on isMT5)
    if (isMT5) {
      const rocAllCall = roc3 > 0 && roc6 > 0 && roc12 > 0;
      const rocAllPut = roc3 < 0 && roc6 < 0 && roc12 < 0;
      if ((isCall && rocAllCall) || (!isCall && rocAllPut)) { sc++; factors.push('ROC×3'); }
      if ((isCall && s._priceStructure === 'bull') || (!isCall && s._priceStructure === 'bear')) { sc++; factors.push('STRUCT'); }
    }

    if (isXAU) {
      // XAU-specific: DXY, TLT, SLV, GDX
      if ((isCall && dxyDir === 'down') || (!isCall && dxyDir === 'up')) { sc++; factors.push('DXY'); }
      if ((isCall && tltDir === 'up') || (!isCall && tltDir === 'down')) { sc++; factors.push('TLT'); }
      if (slvPrice > 0 && ((isCall && slvDir === 'up') || (!isCall && slvDir === 'down'))) { sc++; factors.push('SLV'); }
      if (gdxPrice > 0 && ((isCall && gdxDir === 'up') || (!isCall && gdxDir === 'down'))) { sc++; factors.push('GDX'); }
      // OB factor for XAU (added 2026-05-18): previously only in BTC/NAS conv block.
      // XAU does track obZone, and 5/18 audit showed multiple XAU FAST CALL losers
      // firing into bearish supply zones (-1 obBoost penalty was applied to base score
      // but didn't influence conv → didn't help reach the conv ≥4 threshold either way).
      // Direction-aware: bull OB unmitigated → CALL aligned; mitigated flips to PUT aligned.
      if (s.obZone && !s.obMitigated) {
        if ((isCall && s.obZone.dir === 'call') || (!isCall && s.obZone.dir === 'put')) {
          sc++; factors.push('OB');
        }
      } else if (s.obZone && s.obMitigated) {
        if ((isCall && s.obZone.dir === 'put') || (!isCall && s.obZone.dir === 'call')) {
          sc++; factors.push('OB-flip');
        }
      }
    } else if (isBTC || isNAS) {
      // BTC/NAS100-specific: SPY, QQQ, DXY (risk-on correlation), cross-asset
      const spyS = S['SPY'], qqqS = S['QQQ'];
      const spyDir2 = spyS && spyS.pE5 && spyS.pE13 ? (spyS.pE5 > spyS.pE13 ? 'up' : 'down') : null;
      const qqqDir2 = qqqS && qqqS.pE5 && qqqS.pE13 ? (qqqS.pE5 > qqqS.pE13 ? 'up' : 'down') : null;
      if ((isCall && spyDir2 === 'up') || (!isCall && spyDir2 === 'down')) { sc++; factors.push('SPY'); }
      if ((isCall && qqqDir2 === 'up') || (!isCall && qqqDir2 === 'down')) { sc++; factors.push('QQQ'); }
      // DXY inverse (dollar up = equity/crypto bear)
      if ((isCall && dxyDir === 'down') || (!isCall && dxyDir === 'up')) { sc++; factors.push('DXY'); }
      // Cross-asset SIGNAL confluence (added 2026-05-16). The QQQ factor above is just
      // QQQ's price-direction alignment — useful but noisy. This factor adds +1 ONLY when the
      // QQQ bot has independently FIRED a signal in the same direction within the last 10 min.
      // A QQQ bot signal means QQQ already cleared its own RSI/MACD/HI/LO/6-of-6 gates, so
      // that's much higher-quality info than just "QQQ price is trending up". When both bots
      // independently agree, the directional edge is meaningfully stronger.
      const CROSS_SIG_WINDOW_MS = 10 * 60 * 1000; // 10 min
      if (qqqS) {
        const lastQqqSameDirTs = isCall ? (qqqS.lastCallSignalTs || 0) : (qqqS.lastPutSignalTs || 0);
        if (lastQqqSameDirTs > 0 && (Date.now() - lastQqqSameDirTs) < CROSS_SIG_WINDOW_MS) {
          sc++; factors.push('QQQ_SIG');
        }
      }
      // Order blocks aligned — direction-aware (2026-05-14). Previously fired +1 conv if ANY
      // OB existed regardless of direction. Now: only +1 if the most recent unmitigated OB
      // direction matches the signal direction (bull OB = CALL alignment, bear OB = PUT).
      // The OB type indicates which side the smart-money interest was — aligning with it is
      // a quality marker. If price has broken THROUGH the OB ("mitigated"), the level flipped
      // — opposite direction is now aligned.
      if (s._orderBlocks && s._orderBlocks.length > 0) {
        const recentOB = s._orderBlocks[s._orderBlocks.length - 1];
        if (recentOB && !recentOB.mitigated) {
          // Unmitigated: bull OB → CALL aligned, bear OB → PUT aligned
          if ((isCall && recentOB.type === 'bull') || (!isCall && recentOB.type === 'bear')) {
            sc++; factors.push('OB');
          }
        } else if (recentOB && recentOB.mitigated) {
          // Mitigated (broken through): flip the alignment
          if ((isCall && recentOB.type === 'bear') || (!isCall && recentOB.type === 'bull')) {
            sc++; factors.push('OB-flip');
          }
        }
      }
      // NAS100: also check BTC as risk-on correlation
      if (isNAS) {
        const btcS = S['BTC'];
        const btcDir2 = btcS && btcS.pE5 && btcS.pE13 ? (btcS.pE5 > btcS.pE13 ? 'up' : 'down') : null;
        if ((isCall && btcDir2 === 'up') || (!isCall && btcDir2 === 'down')) { sc++; factors.push('BTC'); }
      }
    } else if (sym === 'QQQ') {
      // QQQ-specific cross-asset factors (added 2026-05-22 after SPY demoted to indicator).
      // Factors: SPY direction, NAS100 direction, BTC direction (risk-on), NAS_SIG (NAS bot
      // independently fired in same direction within 10min). Total available factors for QQQ:
      // MACRO (shared) + SPY + NAS + BTC + NAS_SIG + TRUMP = up to 6. Threshold conv >=3 is
      // applied in enrichSig.
      const spyS_Q = S['SPY'], nasS_Q = S['NAS100'], btcS_Q = S['BTC'];
      const spyDirQ = spyS_Q && spyS_Q.pE5 && spyS_Q.pE13 ? (spyS_Q.pE5 > spyS_Q.pE13 ? 'up' : 'down') : null;
      const nasDirQ = nasS_Q && nasS_Q.pE5 && nasS_Q.pE13 ? (nasS_Q.pE5 > nasS_Q.pE13 ? 'up' : 'down') : null;
      const btcDirQ = btcS_Q && btcS_Q.pE5 && btcS_Q.pE13 ? (btcS_Q.pE5 > btcS_Q.pE13 ? 'up' : 'down') : null;
      if ((isCall && spyDirQ === 'up') || (!isCall && spyDirQ === 'down')) { sc++; factors.push('SPY'); }
      if ((isCall && nasDirQ === 'up') || (!isCall && nasDirQ === 'down')) { sc++; factors.push('NAS'); }
      if ((isCall && btcDirQ === 'up') || (!isCall && btcDirQ === 'down')) { sc++; factors.push('BTC'); }
      // Cross-signal: NAS bot independently fired same direction within 10min — high-quality
      // confirmation (NAS already cleared its own RSI/MACD/HI/LO gates).
      const CROSS_SIG_WINDOW_MS_Q = 10 * 60 * 1000;
      if (nasS_Q) {
        const lastNasSameDirTs = isCall ? (nasS_Q.lastCallSignalTs || 0) : (nasS_Q.lastPutSignalTs || 0);
        if (lastNasSameDirTs > 0 && (Date.now() - lastNasSameDirTs) < CROSS_SIG_WINDOW_MS_Q) {
          sc++; factors.push('NAS_SIG');
        }
      }
    }

    // TRUMP factor (added 2026-05-09) — political-risk signal that boosts conviction
    // when a recent Trump tweet's market bias aligns with the signal direction.
    // Only counts when:
    //   • Bias is fresh (within TRUMP_BIAS_TTL_MS, default 60min)
    //   • Tweet was high-intensity (>= TRUMP_MIN_INTENSITY, default 3)
    //   • Tweet's instruments_affected list includes this symbol OR contains 'ALL'
    //   • Bias direction matches signal direction
    const trumpBiasFresh = trumpBiasTs && (Date.now() - trumpBiasTs < TRUMP_BIAS_TTL_MS);
    if (trumpBiasFresh && trumpIntensity >= TRUMP_MIN_INTENSITY) {
      // Per-symbol bias lookup — each instrument may have its own direction from the last
      // market-relevant tweet (e.g. tariff post = bearish for SPY/QQQ, bullish for XAU).
      const symBias = trumpBiases[sym] || 'neutral';
      const aligned = (isCall && symBias === 'bullish') || (!isCall && symBias === 'bearish');
      if (aligned) {
        sc++; factors.push('TRUMP');
      }
    }

    // ===== CONV MATURITY PENALTY (added 2026-05-22) =====
    // When a high-conv signal (sc≥5) JOINS a move that already happened (signal direction
    // matches the prior 30-min price move with magnitude above a per-symbol threshold),
    // apply -1 penalty. The rationale: ROC/MACD/cross-asset factors flip TOGETHER late in a
    // move, producing a 5-7/7 conv reading right as the move exhausts. Caught by:
    //   • 5/21 XAU afternoon stack: 3 ATL CALLs at conv 5-7 after $36 rally — 1 scratch + 2 rolls
    //   • 5/21 NAS chop cascade: every TRv2 reverse fired at conv 5-6, all flipped together
    if (sc >= 5 && s.prices && s.prices.length >= 30) {
      // MT5 ticks ~1s, equities ~3s → 30min lookback = 1800 / 600 ticks respectively
      const lookback = isMT5 ? 1800 : 600;
      const pricesAgo = s.prices[Math.max(0, s.prices.length - lookback)];
      if (pricesAgo > 0) {
        const movePct = Math.abs((price - pricesAgo) / pricesAgo) * 100;
        const meaningfulThr = isXAU ? 0.4 : isBTC ? 0.6 : isNAS ? 0.3 : 0.2;
        const meaningful = movePct >= meaningfulThr;
        const moveDir = price > pricesAgo ? 'up' : 'down';
        const joining = (isCall && moveDir === 'up') || (!isCall && moveDir === 'down');
        if (meaningful && joining) {
          sc -= 1;
          factors.push('mature-1');
        }
      }
    }

    const label = sc >= 5 ? 'HIGH' : sc >= 3 ? 'MOD' : 'LOW';
    return { score: sc, label, factors };
  }

  // ===== MACRO-ALIGN TRACKING (added 2026-05-13) =====
  // Per-tick: update fullConvSince* timestamps based on current conviction in each direction.
  // 6+/7 for XAU is "near-max" (allowing 1 factor to lag is realistic); pure 7/7 is the absolute
  // ceiling but rare enough to flicker. We use a 5-minute stability window to gate the loosen
  // logic — alignment must have held for 5+ minutes before we trust it to override other gates.
  const MACRO_ALIGN_THR = 6;  // factors aligned (out of 7 XAU / 7-8 BTC-NAS) to qualify as "aligned"
  const MACRO_STABLE_MS = 300000; // 5 minutes of stability required
  function macroAlignedFor(dir) {
    // Returns true if conv has held at >= MACRO_ALIGN_THR for at least MACRO_STABLE_MS.
    const since = dir === 'call' ? s.fullConvSinceCall : s.fullConvSincePut;
    return since > 0 && (Date.now() - since) >= MACRO_STABLE_MS;
  }
  // Contra-block duration (extended 2026-05-13 second pass: 20 → 45 min). User feedback after
  // 5/13 10:32 CALL ATL SL'd 32 min after PUT-aligned macro ended → 20 min was too short.
  const MACRO_CONTRA_BLOCK_MS = 2700000; // 45 minutes
  // Update tracker each tick — only when prices warm enough that conviction is meaningful.
  if (isMT5 && s.prices.length >= 60) {
    const convCallNow = convictionFor('call').score;
    const convPutNow = convictionFor('put').score;
    const tNow = Date.now();
    if (convCallNow >= MACRO_ALIGN_THR) {
      if (!s.fullConvSinceCall) s.fullConvSinceCall = tNow;
      // Macro is calling for CALL → block contrary PUT signals for 45 min (sticky).
      s.macroContraBlockPutUntil = tNow + MACRO_CONTRA_BLOCK_MS;
    } else {
      // Record the moment alignment ENDED + its DURATION (only on the transition)
      if (s.fullConvSinceCall) {
        s.lastFullConvCallEndTs = tNow;
        s.lastFullConvCallDurationMs = tNow - s.fullConvSinceCall;
      }
      s.fullConvSinceCall = 0;
    }
    if (convPutNow >= MACRO_ALIGN_THR) {
      if (!s.fullConvSincePut) s.fullConvSincePut = tNow;
      // Macro is calling for PUT → block contrary CALL signals for 45 min (sticky).
      s.macroContraBlockCallUntil = tNow + MACRO_CONTRA_BLOCK_MS;
    } else {
      if (s.fullConvSincePut) {
        s.lastFullConvPutEndTs = tNow;
        s.lastFullConvPutDurationMs = tNow - s.fullConvSincePut;
      }
      s.fullConvSincePut = 0;
    }
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
    // ===== MULTI-DAY REGIME GATE — ALL INSTRUMENTS (extended 2026-05-20) =====
    // Previously MT5-only inside enrichSig's MT5-conditional body. Today's QQQ/SPY data
    // (5/20) showed 6+ losing PUT signals firing into a clear intraday uptrend. The same
    // regime logic that protects MT5 from counter-trend chases should protect equities.
    //
    // Apply to ALL symbols using either dailyLevels (>=5 entries) or macroSnaps fallback
    // (>=24h history). For equities, macroSnaps spans US RTH only so the window is
    // effectively "today's session vs N hours ago" — close enough to catch obvious
    // directional regimes like today's QQQ +$5/2hr rally.
    {
      const tagEarlyRG = sig.score || '';
      let regimeNetChgPctRG = null;
      let regimeWindowLabelRG = '';
      if (price > 0) {
        if (s.dailyLevels && s.dailyLevels.length >= 5) {
          const oldestDay = s.dailyLevels[0];
          if (oldestDay && oldestDay.high > 0 && oldestDay.low > 0) {
            const oldestMid = (oldestDay.high + oldestDay.low) / 2;
            regimeNetChgPctRG = ((price - oldestMid) / oldestMid) * 100;
            regimeWindowLabelRG = '5-day';
          }
        }
        if (regimeNetChgPctRG === null && s.macroSnaps && s.macroSnaps.length > 0) {
          const oldest = s.macroSnaps[0];
          const ageHours = (Date.now() - oldest.ts) / 3600000;
          // For MT5 (24/7-ish), require ≥24h. For equities (RTH-only), require ≥2h —
          // matches "is the intraday regime clearly directional?" question.
          const minAge = (sym === 'QQQ' || sym === 'SPY') ? 2 : 24;
          if (ageHours >= minAge && oldest.p > 0) {
            regimeNetChgPctRG = ((price - oldest.p) / oldest.p) * 100;
            regimeWindowLabelRG = ageHours >= 96 ? '4-day' : ageHours >= 48 ? '2-day' : ageHours >= 24 ? '1-day' : ageHours.toFixed(1) + 'h-intraday';
          }
        }
      }
      if (regimeNetChgPctRG !== null) {
        // Per-symbol thresholds. Equities use smaller %s since the window is intraday.
        const isEq = (sym === 'QQQ' || sym === 'SPY');
        const strongThr = isXAU ? 2.0 : isBTC ? 5.0 : isNAS ? 3.0 : isEq ? 0.5 : 1.0;
        const weakThr   = isXAU ? 1.0 : isBTC ? 2.5 : isNAS ? 1.5 : isEq ? 0.25 : 0.5;
        let regimeDirRG = 'neutral', regimeStrengthRG = 0;
        if (regimeNetChgPctRG >=  strongThr) { regimeDirRG = 'bull'; regimeStrengthRG = 2; }
        else if (regimeNetChgPctRG <= -strongThr) { regimeDirRG = 'bear'; regimeStrengthRG = 2; }
        else if (regimeNetChgPctRG >=  weakThr) { regimeDirRG = 'bull'; regimeStrengthRG = 1; }
        else if (regimeNetChgPctRG <= -weakThr) { regimeDirRG = 'bear'; regimeStrengthRG = 1; }

        sig._regime = { dir: regimeDirRG, strength: regimeStrengthRG, netChgPct: +regimeNetChgPctRG.toFixed(2), window: regimeWindowLabelRG };

        const isCounterRegime = (regimeDirRG === 'bear' && sig.type === 'call') ||
                               (regimeDirRG === 'bull' && sig.type === 'put');
        if (isCounterRegime) {
          // For MT5 we use conv-based threshold. For equities (no conv), block counter-
          // regime entirely in strong regime, and during weak only if signal is a fade
          // detector (HI/LO/6/6) — those are the ones that consistently fire counter-trend.
          if (isEq) {
            const isCounterFade = /HI|LO|6\/6|7\/6/.test(tagEarlyRG);
            if (regimeStrengthRG === 2 || isCounterFade) {
              const strengthLabel = regimeStrengthRG === 2 ? 'STRONG' : 'WEAK';
              const dirLabel = regimeDirRG.toUpperCase();
              log(sym, '🌍 ' + tagEarlyRG + ' ' + sig.type.toUpperCase() + ' BLOCKED — ' + strengthLabel + ' ' + dirLabel + ' intraday regime (' + regimeWindowLabelRG + ' ' + (regimeNetChgPctRG >= 0 ? '+' : '') + regimeNetChgPctRG.toFixed(2) + '%): equity counter-trend ' + (isCounterFade ? 'fade' : 'signal') + ' blocked.');
              return false;
            }
          } else {
            // MT5 path — conv-based threshold (existing logic)
            const conv = convictionFor(sig.type);
            sig.conv = conv; // also annotate (since we may return before normal conv set below)
            const requiredConv = regimeStrengthRG === 2 ? 6 : 5;
            if (conv.score < requiredConv) {
              Object.assign(s, _emitSnapshot);
              const strengthLabel = regimeStrengthRG === 2 ? 'STRONG' : 'WEAK';
              const dirLabel = regimeDirRG.toUpperCase();
              log(sym, '🌍 ' + tagEarlyRG + ' ' + sig.type.toUpperCase() + ' BLOCKED — multi-day ' + strengthLabel + ' ' + dirLabel + ' regime (' + regimeWindowLabelRG + ' ' + (regimeNetChgPctRG >= 0 ? '+' : '') + regimeNetChgPctRG.toFixed(1) + '%): counter-direction needs conv ≥' + requiredConv + ', got ' + conv.score + '/7.');
              return false;
            }
          }
        }
      }
    }

    // ===== SPY DEMOTED TO INDICATOR-ONLY (added 2026-05-22) =====
    // Yesterday's 5/21 audit: SPY went 0/4 across all signals (3 PUT SL'd, 1 CALL SL'd)
    // while QQQ went 2/3 on identical setups (both winners were QQQ PUTs at 11:00 and 13:22).
    // SPY's signal quality dropped below useful threshold. Keep SPY data flowing
    // (price/RSI/MACD/macroSnaps) so it can serve as a confirmation source for QQQ and
    // BTC/NAS100 cross-asset factors, but stop EMITTING SPY signals entirely. Trial —
    // re-enable if quality recovers in a future audit.
    if (sym === 'SPY') {
      log(sym, '🪧 ' + (sig.score || '') + ' ' + sig.type.toUpperCase() + ' SUPPRESSED — SPY demoted to indicator-only (5/21 audit: 0/4 SL across PUT+CALL). SPY data still feeds cross-asset confirmation.');
      return false;
    }

    // ===== QQQ RSI EXHAUSTION FLOOR (added 2026-05-22) =====
    // 5/21 SPY signal #7 SL'd at entry RSI 19.6 (chasing breakdown into extreme oversold).
    // Equity PUTs at deeply oversold RSI and CALLs at deeply overbought RSI are typically
    // chasing exhaustion. Hard rule mirroring the XAU pattern (XAU uses 35/65, equities
    // run tighter at 30/70 since they're less volatile and reach extremes less often).
    // Fade signals (HI/LO/ATH/ATL/DIV/SWEEP) are exempt — those are designed to fire at
    // RSI extremes by definition.
    if (sym === 'QQQ') {
      const tagQ = sig.score || '';
      const isFadeAtExtremeQ = /HI|LO|ATH|ATL|DIV|SWEEP/.test(tagQ) && !/MFLIP|TREND|FAST|BREAK|RIDE/.test(tagQ);
      if (!isFadeAtExtremeQ) {
        if (sig.type === 'put' && typeof rsiV === 'number' && rsiV < 30) {
          log(sym, '🛑 ' + tagQ + ' PUT BLOCKED — QQQ RSI exhaustion: RSI ' + rsiV.toFixed(1) + ' < 30 (oversold). Equity PUT at deep oversold chases exhaustion.');
          return false;
        }
        if (sig.type === 'call' && typeof rsiV === 'number' && rsiV > 70) {
          log(sym, '🛑 ' + tagQ + ' CALL BLOCKED — QQQ RSI exhaustion: RSI ' + rsiV.toFixed(1) + ' > 70 (overbought). Equity CALL at deep overbought chases exhaustion.');
          return false;
        }
      }
    }

    // ===== QQQ CONVICTION GATE (added 2026-05-22) =====
    // Now that SPY is suppressed and convictionFor() returns real factors for QQQ
    // (MACRO + SPY + NAS + BTC + NAS_SIG + TRUMP — up to 6), gate QQQ signal emission
    // on conv ≥3. Mirrors the MT5 conviction-gate pattern but with equity-appropriate
    // factors. Yesterday's 5/21 QQQ losers fired with zero cross-asset confirmation —
    // requiring 3+ aligned cross-assets (or macro + 2 cross) eliminates the worst entries.
    if (sym === 'QQQ') {
      const convQ = convictionFor(sig.type);
      sig.conv = convQ;
      const MIN_CONV_QQQ = 3;
      if (convQ.score < MIN_CONV_QQQ) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🎯 ' + (sig.score || '') + ' ' + sig.type.toUpperCase() + ' BLOCKED — QQQ conv ' + convQ.score + '/' + MIN_CONV_QQQ + ' (factors: ' + (convQ.factors.join(',') || 'none') + '). Need SPY/NAS/BTC/NAS_SIG/MACRO alignment.');
        return false;
      }
      return true;
    }

    if (!isMT5) return true; // non-MT5 instruments don't have conv — let them through (regime gate above already applied)

    // XAU CALL trial disable reverted 2026-05-20: user flagged today as a bullish XAU
    // day. Letting the multi-day regime gate handle direction-bias automatically based
    // on current market action instead of hardcoded symbol+direction rule.

    // ===== XAU RSI EXHAUSTION FLOOR (added 2026-05-20) =====
    // Today's 10:12 XAU 6/6 PUT fired with conv 8/7 (MAX) at RSI 33.6 — and SL'd hard
    // as price rallied $47 within 30min. Conviction count alone can't overcome immediate
    // RSI exhaustion. Macro factors LAG the price reversal — by the time all 8 macro
    // factors confirm PUT direction, the move is mostly done and a V-bottom forms.
    //
    // Hard rule: don't fire XAU PUT at oversold RSI (<35) or XAU CALL at overbought
    // RSI (>65). Other detectors have similar checks but this enforces it at the
    // signal-emit layer for all XAU detectors uniformly. Fade signals (HI/LO/ATH/ATL/
    // DIV) which exist specifically to catch reversals at RSI extremes are exempt —
    // they need to fire AT the extremes by design.
    if (isXAU) {
      const tagX = sig.score || '';
      const isFadeAtExtreme = /HI|LO|ATH|ATL|DIV|SWEEP/.test(tagX) && !/MFLIP|TREND|FAST|BREAK|RIDE/.test(tagX);
      if (!isFadeAtExtreme) {
        if (sig.type === 'put' && typeof rsiV === 'number' && rsiV < 35) {
          log(sym, '🛑 ' + tagX + ' PUT BLOCKED — XAU RSI exhaustion: RSI ' + rsiV.toFixed(1) + ' < 35 (oversold). No PUT at the bottom regardless of conviction — macro factors lag price exhaustion.');
          return false;
        }
        if (sig.type === 'call' && typeof rsiV === 'number' && rsiV > 65) {
          log(sym, '🛑 ' + tagX + ' CALL BLOCKED — XAU RSI exhaustion: RSI ' + rsiV.toFixed(1) + ' > 65 (overbought). No CALL at the top regardless of conviction — macro factors lag price exhaustion.');
          return false;
        }
      }
    }

    const conv = convictionFor(sig.type);
    sig.conv = conv;

    const tagEarly = sig.score || '';
    const isFadeEarly = /ATH|ATL|HI|LO|DIV/.test(tagEarly) && !/MFLIP|TREND|FAST|BREAK|RIDE/.test(tagEarly);
    const macroContraNow = Date.now();

    // ===== OB PROXIMITY HARD BLOCK (added 2026-05-18) =====
    // The soft obBoost penalty (-1 on base score) wasn't strong enough to stop signals
    // firing into known opposing OB zones. 5/18 log showed XAU CALL fire while bot was
    // logging "OB penalty: CALL -1 — at bearish supply $4540.36-$4541.83" — the bot
    // recognized the resistance and still fired anyway.
    //
    // New rule: if a signal direction is INTO an opposing unmitigated OB zone within
    // proximity range (XAU $5, BTC $200, NAS $25), HARD BLOCK the signal. The OB zone
    // is a documented institutional supply/demand level — buying right below bearish
    // supply or selling right above bullish demand is structurally bad.
    //
    // "Into" means: CALL firing while price < ob.lo (approaching bearish OB from below)
    //               OR PUT firing while price > ob.hi (approaching bullish OB from above)
    // Fade signals (HI/LO/ATH/ATL/VREV/DIV/SWEEP/LHF/LLF) are EXEMPT — those are designed
    // to fire AT extremes/levels by definition.
    if (s.obZone && !s.obMitigated && !s.obDeparted) {
      const obProxRange = isBTC ? 200 : isNAS ? 25 : isXAU ? 5 : 0;
      const isFadeForOb = /VREV|ATH|ATL|HI|LO|DIV|SWEEP|LHF|LLF/.test(tagEarly);
      if (obProxRange > 0 && !isFadeForOb) {
        const ob = s.obZone;
        // CALL firing into bearish supply (ob.dir === 'put' = bearish OB above)
        if (sig.type === 'call' && ob.dir === 'put' && price < ob.lo && (ob.lo - price) <= obProxRange) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🧱 ' + tagEarly + ' CALL BLOCKED — OB proximity: bearish supply zone $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' is $' + (ob.lo - price).toFixed(2) + ' above current price (within $' + obProxRange + ' hard-block range). Wait for OB break or fade signal.');
          return false;
        }
        // PUT firing into bullish demand (ob.dir === 'call' = bullish OB below)
        if (sig.type === 'put' && ob.dir === 'call' && price > ob.hi && (price - ob.hi) <= obProxRange) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🧱 ' + tagEarly + ' PUT BLOCKED — OB proximity: bullish demand zone $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' is $' + (price - ob.hi).toFixed(2) + ' below current price (within $' + obProxRange + ' hard-block range). Wait for OB break or fade signal.');
          return false;
        }
      }
    }

    // ===== CHOP SUPPRESSION — NAS + BTC (extended 2026-05-19 to BTC) =====
    // Original 5/18: 4 of 5 NAS RIDE losses + 1 BREAK loss during NAS chop $28800-29150.
    // Extended 5/19: 3 BTC BREAK losses overnight in $76,600-77,200 chop range. Same
    // failure mode — BREAK/FAST chase false range escapes that immediately revert.
    //
    // Rule: in chop mode (for NAS or BTC), allow ONLY fade-at-extremes detectors (V-REV,
    // LHF, LLF). These are DESIGNED for the bounce-off-the-edges pattern. Block all other
    // detectors (BREAK, FAST, TREND, RIDE, ATH, ATL, HI, LO, MFLIP, 6/6, etc.).
    //
    // XAU is NOT included — XAU chop produces different patterns and its detectors have
    // separate gates (e.g., V-REV chop block at the V-REV level, FAST disabled, etc.).
    if ((isNAS || isBTC) && s.chopActive) {
      const isFadeAllowedInChop = /VREV|LHF|LLF/.test(tagEarly);
      if (!isFadeAllowedInChop) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🌊 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — ' + sym + ' chop mode active (only V-REV / LHF / LLF allowed in chop; other detectors consistently lose in flat range).');
        return false;
      }
    }

    // ===== V-REV CONVICTION FLOOR (added 2026-05-18) =====
    // XAU 5/17-18 audit: 6 of 7 XAU signals SL'd in one night. 4 of the 6 losers were V-REV
    // conv-3 (the minimum allowed for V-REV under the isMomentumCatch exemption). All four
    // had factors WITHOUT the MACRO label — meaning fewer than ~4 cross-asset factors agreed
    // on the V-REV's direction. The one V-REV winner (#2 PUT) had conv 3 BUT did include
    // the MACRO factor.
    //
    // New rule for V-REV (XAU/BTC/NAS): require conv ≥ 4 OR the MACRO label present.
    // Catches the "bottom of a borderline-aligned macro" failure mode without crippling
    // V-REV when macro is genuinely flipping (MACRO factor confirms the flip is real).
    if (/VREV/.test(tagEarly)) {
      const vrevHasMacro = conv.factors && conv.factors.indexOf('MACRO') !== -1;
      if (conv.score < 4 && !vrevHasMacro) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — V-REV conv floor: conv ' + conv.score + '/7 [' + (conv.factors || []).join(',') + '] < 4 AND no MACRO factor. V-REV needs either 4+ factors OR macro confirmation to avoid dead-cat catches.');
        return false;
      }
    }

    // ===== ATH/ATL CONVICTION FLOOR (added 2026-05-18) =====
    // ATH/ATL fade against 5-day rolling extremes — they're STRUCT-exempt by design
    // (faders against price structure). But without MACRO confirmation, fading a rolling
    // extreme during a bigger trend is exactly the "catching a falling/rising knife"
    // failure mode. 5/18 16:00 XAU ATH PUT @ $4559 SL'd: had conv 4 (ROC×3·TLT·GDX·TRUMP)
    // but no MACRO and no STRUCT — price was above macro EMA in a bigger uptrend → fade
    // failed and price continued up $4-5 against the PUT.
    //
    // New rule: ATH/ATL needs conv ≥ 5 OR MACRO factor present. Stricter than V-REV (≥4)
    // because rolling-extreme fades carry more risk than fresh-V-bottom catches.
    if (/ATH|ATL/.test(tagEarly)) {
      const fadeHasMacro = conv.factors && conv.factors.indexOf('MACRO') !== -1;
      if (conv.score < 5 && !fadeHasMacro) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — ATH/ATL conv floor: conv ' + conv.score + '/7 [' + (conv.factors || []).join(',') + '] < 5 AND no MACRO factor. Rolling-extreme fades need stronger confirmation (macro alignment or 5+ factors) to avoid fading into a bigger trend.');
        return false;
      }
    }

    // ===== BTC BREAK CONV FLOOR (added 2026-05-20) =====
    // 5/16-19 audit: BTC BREAK win rate = 28% (5 SLs out of 7 resolved). The conv 3-4
    // BREAK signals consistently fire at false range escapes in BTC's choppy regime.
    // FAST is 67% win rate on BTC — clearly the better detector. BREAK needs a higher
    // bar.
    //
    // Rule: BTC BREAK requires conv ≥ 5 (HIGH). Catches the conv 3-4 BREAK losers we saw
    // (5/19 had 4 conv-4 BREAK losses + 1 conv-3 BREAK loss). Allows the rare conv-5
    // BREAK setups where macro + structure + multiple cross-asset factors all confirm.
    if (isBTC && /BREAK/.test(tagEarly)) {
      if (conv.score < 5) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — BTC BREAK conv floor: conv ' + conv.score + '/7 [' + (conv.factors || []).join(',') + '] < 5 (HIGH). BTC BREAK has 28% win rate at conv 3-4; needs stronger confirmation to fire.');
        return false;
      }
    }

    // ===== BTC FAST CONV FLOOR (added 2026-05-20) =====
    // Pattern from data: BTC FAST conv 4-6 = TP1/TP3 winners. BTC FAST conv 3 (today's
    // 04:39 CALL @ $77,497) = SL. Raise BTC FAST minimum to conv 4 to filter out the
    // weakest setups. Conv 4 still allows reasonable opportunity since BTC FAST 67%
    // win rate is the best detector for BTC.
    if (isBTC && /FAST/.test(tagEarly)) {
      if (conv.score < 4) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — BTC FAST conv floor: conv ' + conv.score + '/7 [' + (conv.factors || []).join(',') + '] < 4 (MOD). BTC FAST at conv 3 has poor win rate; conv 4+ is the threshold for actual edge.');
        return false;
      }
    }

    // ===== TP1-SECURED SAME-DIR LOCKOUT (added 2026-05-19) =====
    // After an active trade has hit TP1, the EA moves SL to breakeven — the position is
    // already locked into "win or scratch" mode. Adding ANOTHER same-direction signal at
    // this point is pure additional risk: the original trade is protected and managing
    // itself; a new signal opens a NEW position that hits fresh SL if the bounce continues.
    //
    // Today's 5/19 10:54 XAU 6/6 PUT SL'd after the 09:30 PUT had already TP1'd. The 84min
    // gap was enough for price to bounce $9 (4477→4486), the new PUT fired into the bounce
    // and SL'd within 5 min. The first trade's TP1+scratch protection meant it was already
    // a guaranteed non-loser; the second trade turned the cluster into a net loss.
    //
    // Rule: if a same-direction trade is active AND has already hit TP1 (`s.trade.t1`),
    // suppress new same-dir signal emission. Lets the protected trade run for TP2/TP3
    // without adding new exposure. Only applies to MT5 instruments with actual EA execution.
    if (isMT5 && s.trade && s.trade.active && s.trade.type === sig.type && s.trade.t1) {
      const tradeAgeMin = Math.round((Date.now() - (s.trade.ts || Date.now())) / 60000);
      Object.assign(s, _emitSnapshot);
      log(sym, '🔒 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — active ' + sig.type.toUpperCase() + ' trade (' + tradeAgeMin + 'min) has already hit TP1 and is breakeven-protected. New same-dir signal would add fresh risk on top of a secured winner — let the protected trade run for TP2/TP3.');
      return false;
    }

    // ===== MULTI-DAY REGIME GATE (added 2026-05-19) =====
    // User insight: XAU dropped 5.4% over 2 weeks → PUT win rate 60% vs CALL 25%. The
    // bot's existing macro gates are INTRADAY (price vs macro EMA, current cross-asset
    // alignment). They don't capture the multi-day directional regime that makes one
    // direction structurally favored for days/weeks.
    //
    // This gate adds an explicit regime layer using s.dailyLevels (last 5 completed days
    // of high/low). Compare current price to the midpoint of the OLDEST day in the window:
    //   - Net change ≥ +X% over 5 days → BULL regime (counter PUT needs higher conv)
    //   - Net change ≤ -X% over 5 days → BEAR regime (counter CALL needs higher conv)
    //   - Strong regime (≥2% XAU / ≥5% BTC / ≥3% NAS) → counter direction needs conv ≥6
    //   - Weak regime   (≥1% XAU / ≥2.5% BTC / ≥1.5% NAS) → counter direction needs conv ≥5
    //   - Neutral → no change
    //
    // Effect: in a strong bearish regime like the current XAU downtrend, CALL signals
    // need rare conv ≥6 HIGH — most XAU CALLs (the consistent losers) get blocked while
    // PUT signals fire normally. Symmetric for bull regimes. The bot effectively "trades
    // with the trend" without hard-blocking the rare high-conviction counter-trend setup.
    // Compute regime via best-available data source. Two paths:
    //   PRIMARY:  s.dailyLevels (5+ completed days) — most accurate, used when persisted
    //   FALLBACK: s.macroSnaps (5-min price history) — kicks in when dailyLevels < 5 days,
    //             which happens after a fresh deploy or any state wipe. Uses the oldest
    //             macroSnap as the anchor, requires ≥24h of history to be meaningful.
    //
    // The fallback bootstrap was added 2026-05-20 after 5/19 XAU showed 3 of 4 counter-
    // regime CALL signals firing because dailyLevels hadn't accumulated yet after the
    // deploy. Without the fallback, the regime gate is silent until 5 daily resets pass.
    let regimeNetChgPct = null;
    let regimeWindowLabel = '';
    if (price > 0) {
      if (s.dailyLevels && s.dailyLevels.length >= 5) {
        const oldestDay = s.dailyLevels[0];
        if (oldestDay && oldestDay.high > 0 && oldestDay.low > 0) {
          const oldestMid = (oldestDay.high + oldestDay.low) / 2;
          regimeNetChgPct = ((price - oldestMid) / oldestMid) * 100;
          regimeWindowLabel = '5-day';
        }
      }
      // Fallback: use macroSnaps oldest entry if ≥ 24h old
      if (regimeNetChgPct === null && s.macroSnaps && s.macroSnaps.length > 0) {
        const oldest = s.macroSnaps[0];
        const ageHours = (Date.now() - oldest.ts) / 3600000;
        if (ageHours >= 24 && oldest.p > 0) {
          regimeNetChgPct = ((price - oldest.p) / oldest.p) * 100;
          regimeWindowLabel = ageHours >= 96 ? '4-day' : ageHours >= 48 ? '2-day' : '1-day';
        }
      }
    }

    if (regimeNetChgPct !== null) {
      // Per-symbol regime thresholds (% change)
      const strongThr = isXAU ? 2.0 : isBTC ? 5.0 : isNAS ? 3.0 : 1.0;
      const weakThr   = isXAU ? 1.0 : isBTC ? 2.5 : isNAS ? 1.5 : 0.5;
      let regimeDir = 'neutral', regimeStrength = 0;
      if (regimeNetChgPct >=  strongThr) { regimeDir = 'bull'; regimeStrength = 2; }
      else if (regimeNetChgPct <= -strongThr) { regimeDir = 'bear'; regimeStrength = 2; }
      else if (regimeNetChgPct >=  weakThr) { regimeDir = 'bull'; regimeStrength = 1; }
      else if (regimeNetChgPct <= -weakThr) { regimeDir = 'bear'; regimeStrength = 1; }

      // Annotate for diagnostics
      sig._regime = { dir: regimeDir, strength: regimeStrength, netChgPct: +regimeNetChgPct.toFixed(2), window: regimeWindowLabel };

      // Block counter-regime signals if conviction insufficient
      const isCounterRegime = (regimeDir === 'bear' && sig.type === 'call') ||
                             (regimeDir === 'bull' && sig.type === 'put');
      if (isCounterRegime) {
        const requiredConv = regimeStrength === 2 ? 6 : 5;
        if (conv.score < requiredConv) {
          Object.assign(s, _emitSnapshot);
          const strengthLabel = regimeStrength === 2 ? 'STRONG' : 'WEAK';
          const dirLabel = regimeDir.toUpperCase();
          log(sym, '🌍 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — multi-day ' + strengthLabel + ' ' + dirLabel + ' regime (' + regimeWindowLabel + ' ' + (regimeNetChgPct >= 0 ? '+' : '') + regimeNetChgPct.toFixed(1) + '%): counter-direction needs conv ≥' + requiredConv + ', got ' + conv.score + '/7.');
          return false;
        }
      }
    }

    // ===== ACTIVE-TRADE REVERSAL LOCKOUT (added 2026-05-16) =====
    // User reported "reversals firing too much and unnecessarily" — root cause: while an
    // MT5 trade is active in direction D, any opposite-direction signal that passes the
    // normal detector gates becomes a "reversal" from the EA's perspective (current EA
    // closes; new XAU scratch logic moves SL to entry; either way it interrupts a trade
    // that might still be working). winProtectDir already blocks opposite signals when the
    // trade is profitable above threshold ($1 XAU / $10 NAS / $50 BTC), but trades sitting
    // at breakeven or small-loss got no protection — exactly where most "reversals" fire.
    //
    // New rule (MT5 only, applies to all 3 instruments): if a trade is active in direction
    // D, the opposite direction can ONLY emit if:
    //   1. Conviction ≥ 6 (HIGH) — a real, multi-factor reversal, not just a fade detector
    //      blip
    //   2. Macro stably aligned in the OPPOSITE direction (macroAlignedFor returns true,
    //      meaning 6+/7 alignment for ≥5min) — the macro has actually flipped, not just a
    //      flicker
    // If either fails, block. The original trend signal continues to work.
    //
    // FADE signals (ATH/ATL/HI/LO/DIV/VREV/LHF/LLF) are EXEMPT from this gate — they fire
    // at extremes by design and a HI/ATH fade against an active winning CALL is the exact
    // top-reversal we WANT to catch. winProtectDir + per-detector cooldowns already gate
    // fades adequately.
    const isTrendForReversalLockout = /BREAK|FAST|TREND|MFLIP|RIDE|6\/6|SUST|SQZ/.test(tagEarly) && !/VREV|ATH|ATL|HI|LO|DIV|SWEEP|LHF|LLF/.test(tagEarly);
    if (isTrendForReversalLockout && s.trade && s.trade.active && s.trade.ep > 0 && s.trade.type && s.trade.type !== sig.type) {
      // Trade is active in opposite direction → apply stricter gate
      const tradeAgeMin = Math.round((Date.now() - (s.trade.ts || Date.now())) / 60000);
      const convOk = conv && conv.score >= 6;
      const macroOk = macroAlignedFor(sig.type);
      if (!convOk || !macroOk) {
        Object.assign(s, _emitSnapshot);
        const why = !convOk
          ? 'conviction ' + (conv ? conv.score : 0) + '/7 < 6 (HIGH required)'
          : 'macro not stably aligned ' + sig.type.toUpperCase() + ' for ≥5min';
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — active-trade reversal lockout: ' + s.trade.type.toUpperCase() + ' trade open ' + tradeAgeMin + 'min, opposite needs conv ≥6 + macro flipped (' + why + ').');
        return false;
      }
      // Both pass → genuine reversal, allow through with a log note for visibility
      log(sym, '↪️ ' + tagEarly + ' ' + sig.type.toUpperCase() + ' active-trade reversal allowed — conv ' + conv.score + '/7 + macro stably ' + sig.type.toUpperCase() + '-aligned. ' + s.trade.type.toUpperCase() + ' trade (' + tradeAgeMin + 'min) is genuinely reversing.');
    }

    // ===== BTC WEEKEND PUT-ONLY GATE (added 2026-05-16) =====
    // 52-week analysis showed BTC weekends are CALL-skewed overall (57.7% CALL) but the
    // recent 6-month regime (Nov 2025 → May 2026) is 58% PUT-favorable with bigger PUT
    // magnitudes (-1.83% vs +1.50%). Decision: allow PUT signals on weekends, block CALL
    // entirely. The hard weekend block at processTicks level was lifted; this is the
    // direction-aware enforcement. CALL signals at low-liquidity weekend chop have poor
    // risk/reward — wait until Mon open instead.
    if (isBTC && s._weekendBtcPutOnly && sig.type === 'call') {
      Object.assign(s, _emitSnapshot);
      log(sym, '🚫 ' + tagEarly + ' CALL BLOCKED — BTC weekend PUT-only mode (recent 6mo regime: 58% PUT-favorable, weekend CALL setups have poor R:R).');
      return false;
    }

    // ===== MACRO-FLIP COOLDOWN (added 2026-05-13) =====
    // Caught 5/13 10:32 ATL CALL @ conv 6 HIGH SL'd 32 min after PUT alignment ended. The
    // 20-min contra-block had just expired AND fade exemption let ATL through anyway. When
    // macro alignment recently ENDED in the opposite direction (within 60 min), the macro
    // is FLICKERING — not a clean reversal. Block ALL signals including fades.
    const MACRO_FLIP_COOLDOWN_MS = 3600000; // 60 minutes since opposite alignment ended
    const MACRO_FLICKER_THR_MS = 1800000;   // < 30 min of opposite alignment = flicker, not real
    const oppositeEndTs = sig.type === 'call' ? (s.lastFullConvPutEndTs || 0) : (s.lastFullConvCallEndTs || 0);
    const oppositeDur   = sig.type === 'call' ? (s.lastFullConvPutDurationMs || 0) : (s.lastFullConvCallDurationMs || 0);
    const oppositeFlipRecent = oppositeEndTs > 0 && (macroContraNow - oppositeEndTs) < MACRO_FLIP_COOLDOWN_MS;
    // Flicker exemption (added 2026-05-14 after 5/14 missed $4710 peak PUT): if the just-ended
    // opposite alignment lasted < 30 min, it was noise/flicker (e.g. brief CALL during a peak
    // bounce). Don't enforce the cooldown — the prior direction was the real trend and the
    // new signal is catching the resumption. Sustained opposite alignment (>30 min) still
    // enforces cooldown because that was a real reversal that may itself be ending falsely.
    const oppositeWasFlicker = oppositeDur > 0 && oppositeDur < MACRO_FLICKER_THR_MS;
    // Bypass: if macro has now been aligned WITH signal direction stably for ≥7 min, the
    // flip is real — allow the trade. Loosened 15→7min on 2026-05-14 after spike-low VREV
    // CALLs were blocked all afternoon following morning PUT trend. 7min catches genuine
    // reversals within their first leg while still filtering pure noise.
    const STABILITY_BYPASS_MS = 420000; // 7 minutes
    const newDirStable = sig.type === 'call'
      ? (s.fullConvSinceCall > 0 && (macroContraNow - s.fullConvSinceCall) >= STABILITY_BYPASS_MS)
      : (s.fullConvSincePut > 0 && (macroContraNow - s.fullConvSincePut) >= STABILITY_BYPASS_MS);
    if (oppositeFlipRecent && !newDirStable && !oppositeWasFlicker) {
      Object.assign(s, _emitSnapshot);
      const flipAgoMin = Math.round((macroContraNow - oppositeEndTs) / 60000);
      const durMin = Math.round(oppositeDur / 60000);
      log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — macro flip cooldown (opposite alignment lasted ' + durMin + 'min, ended ' + flipAgoMin + 'min ago, need 60min OR 7min stable new alignment OR opposite <30min flicker).');
      return false;
    }
    if (oppositeFlipRecent && oppositeWasFlicker) {
      const durMin = Math.round(oppositeDur / 60000);
      log(sym, '↪️ ' + tagEarly + ' ' + sig.type.toUpperCase() + ' macro-flip cooldown BYPASSED — opposite alignment was a ' + durMin + 'min flicker (< 30 min threshold). Allowing real-trend resumption.');
    }

    // ===== MACRO-CONTRA BLOCK (added 2026-05-13, extended 20→45min) =====
    // When cross-asset conv is/was ≥6 aligned against this signal's direction within the
    // last 45 min, reject the signal. Fade signals (ATH/ATL/HI/LO/DIV) are normally exempt
    // because they're designed to counter-trend at extremes — but the macro-flip cooldown
    // above already catches the chop-flicker case, so fades here pass through correctly.
    const contraBlocked =
      (sig.type === 'call' && macroContraNow < (s.macroContraBlockCallUntil || 0)) ||
      (sig.type === 'put'  && macroContraNow < (s.macroContraBlockPutUntil  || 0));
    if (contraBlocked) {
      if (isFadeEarly) {
        // Audit finding LOW-4 (added 2026-05-13): log when a fade signal proceeds despite
        // the contra-block — previously this was a silent pass-through making it confusing
        // to debug why fade signals fire when macro is strongly aligned against them.
        const remainMin = Math.round(((sig.type === 'call' ? s.macroContraBlockCallUntil : s.macroContraBlockPutUntil) - macroContraNow) / 60000);
        log(sym, '↪️ ' + tagEarly + ' ' + sig.type.toUpperCase() + ' contra-block EXEMPT (fade signal) — macro aligned ' + (sig.type === 'call' ? 'PUT' : 'CALL') + ' ' + remainMin + 'min more, but fade detectors are designed to counter-trend at extremes.');
      } else {
        Object.assign(s, _emitSnapshot);
        const remainMin = Math.round(((sig.type === 'call' ? s.macroContraBlockCallUntil : s.macroContraBlockPutUntil) - macroContraNow) / 60000);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — macro 6+/7 aligned ' + (sig.type === 'call' ? 'PUT' : 'CALL') + '. Contra-block active ' + remainMin + 'min more.');
        return false;
      }
    }

    const macroDir = s.macroEma ? (price > s.macroEma ? 'bull' : 'bear') : null;
    const isCall = sig.type === 'call';
    const isCounterTrend = macroDir && ((isCall && macroDir === 'bear') || (!isCall && macroDir === 'bull'));
    // Specialist fade tags — by design these signals fight extremes and need extra confirmation
    const tag = sig.score || '';
    const isFadeSignal = /ATH|ATL|HI|LO|LHF|LLF/.test(tag) && !/MFLIP|TREND|FAST|BREAK|RIDE/.test(tag);

    // ===== SAME-DIRECTION CAP (added 2026-05-14, max 2 per 30 min) =====
    // Caught 5/14 03:58 PUT FAST: 3rd PUT in 19 min after 2 winners, SL'd despite max conv 7/7.
    // No conviction/RSI/STRUCT filter catches "trend exhaustion stacking" — by definition all
    // those metrics scream bullish-on-trend right when the trend has the least room left.
    // Only a time/count-based filter catches it. Cap = 2 same-direction signals in 30 min.
    const SAME_DIR_CAP_MS = 1800000; // 30 minutes
    const SAME_DIR_CAP = 2;
    if (Array.isArray(s.recentFires)) {
      const tCap = Date.now();
      const sameDirRecent = s.recentFires.filter(f => f.type === sig.type && (tCap - f.ts) < SAME_DIR_CAP_MS);
      if (sameDirRecent.length >= SAME_DIR_CAP) {
        Object.assign(s, _emitSnapshot);
        const oldestAge = Math.round((tCap - sameDirRecent[0].ts) / 60000);
        log(sym, '🚫 ' + tag + ' ' + sig.type.toUpperCase() + ' BLOCKED — same-direction cap: already ' + sameDirRecent.length + ' ' + sig.type.toUpperCase() + ' fires in last ' + Math.round(SAME_DIR_CAP_MS / 60000) + 'min (oldest ' + oldestAge + 'min ago). Trend exhaustion likely — wait for retracement.');
        return false;
      }
    }

    // ===== POST-TP3 COOLDOWN (added 2026-05-14, 90 min same-direction block) =====
    // After a TP3 hit (full move captured), block new same-direction signals for 90 min.
    // The move is exhausted — chasing it leads to losers (5/14 signal #2 PUT FAST SL'd 32 min
    // after signal #1 SWEEP PUT hit TP3 in the same direction). Lets the market consolidate
    // / reverse before allowing another trend continuation entry.
    const POST_TP3_COOLDOWN_MS = 5400000; // 90 minutes
    const lastTp3Ts = sig.type === 'call' ? (s.lastTp3CallTs || 0) : (s.lastTp3PutTs || 0);
    if (lastTp3Ts > 0 && (Date.now() - lastTp3Ts) < POST_TP3_COOLDOWN_MS) {
      Object.assign(s, _emitSnapshot);
      const tp3AgoMin = Math.round((Date.now() - lastTp3Ts) / 60000);
      const remainMin = Math.round((POST_TP3_COOLDOWN_MS - (Date.now() - lastTp3Ts)) / 60000);
      log(sym, '🚫 ' + tag + ' ' + sig.type.toUpperCase() + ' BLOCKED — post-TP3 cooldown: same-direction TP3 hit ' + tp3AgoMin + 'min ago, ' + remainMin + 'min remaining of 90min lockout (move is exhausted, wait for reversal or fresh setup).');
      return false;
    }

    // ===== (A) SESSION RANGE BIAS — reject-or-break logic (added 2026-05-14) =====
    // For trend/momentum signals: don't fire in the WRONG HALF of the session range UNLESS
    // price is currently making a new session extreme (fresh break — continuation valid).
    // Fade detectors (HI/LO/ATH/ATL/VREV/DIV/SWEEP) are EXEMPT — they're designed for extremes.
    //
    // Logic:
    //   - PUT in lower half + NOT making new low → stale exhausted move, BLOCK
    //   - PUT in lower half + making new low (sessionLowUpdateTs < 5 min ago) → fresh
    //     breakdown continuation, ALLOW
    //   - CALL in upper half + making new high → fresh breakout, ALLOW
    //   - CALL in upper half + not making new high → stale, BLOCK
    //   - PUT in UPPER half (fading top) → ALLOW (correct setup)
    //   - CALL in LOWER half (fading bottom) → ALLOW (correct setup)
    //
    // Trace 5/14: blocks signals #2/3/4 (PUTs in lower half not breaking down) while keeping
    // signal #1 (PUT in upper half = fading top of range, the winner).
    const isTrendOrMomentum = /BREAK|FAST|TREND|MFLIP|RIDE|6\/6|SUST|SQZ/.test(tag) && !/VREV|ATH|ATL|HI|LO|DIV|SWEEP|LHF|LLF/.test(tag);
    if (isTrendOrMomentum && s.sessionHigh > -Infinity && s.sessionLow < Infinity && s.openPrice) {
      const sessionRange = s.sessionHigh - s.sessionLow;
      const midpoint = (s.sessionHigh + s.sessionLow) / 2;
      const minRangeForBias = isBTC ? 800 : isNAS ? 100 : 20; // XAU $20
      const FRESH_BREAK_MS = 300000; // 5 min — "fresh new extreme"
      const tNow = Date.now();
      if (sessionRange >= minRangeForBias) {
        const inUpperHalf = price > midpoint;
        const inLowerHalf = price < midpoint;
        const freshNewHigh = s.sessionHighUpdateTs > 0 && (tNow - s.sessionHighUpdateTs) < FRESH_BREAK_MS;
        const freshNewLow  = s.sessionLowUpdateTs > 0 && (tNow - s.sessionLowUpdateTs) < FRESH_BREAK_MS;

        // NOTE 2026-05-15: a "local-leg bypass" was briefly considered (allow PUT in lower half
        // if price had dropped $15+ off the 60-min high). It was rejected because by the time
        // momentum detectors (BREAK/FAST/TREND) trigger after a $15+ drop, the move is already
        // mostly done — firing $3 from the local low is exactly the chase-the-bottom failure
        // mode we just patched. Better to miss the trade than to fire late. The proper fix for
        // catching local-top reversals is a dedicated LOCAL-HIGH/LOW fade detector (top-fade
        // signal that fires only $3-7 off a fresh local extreme with R:R 1:4+) — separate work.

        // PUT in lower half + NOT making new low = stale exhausted move
        if (sig.type === 'put' && inLowerHalf && !freshNewLow) {
          Object.assign(s, _emitSnapshot);
          const pctFromHigh = ((s.sessionHigh - price) / sessionRange * 100).toFixed(0);
          log(sym, '🚫 ' + tag + ' PUT BLOCKED — session-range bias: price $' + price.toFixed(2) + ' is in lower half of session range ($' + s.sessionLow.toFixed(2) + '-$' + s.sessionHigh.toFixed(2) + ', ' + pctFromHigh + '% off high) and NOT making new low — move is stale.');
          return false;
        }
        // CALL in upper half + NOT making new high = stale
        if (sig.type === 'call' && inUpperHalf && !freshNewHigh) {
          Object.assign(s, _emitSnapshot);
          const pctFromLow = ((price - s.sessionLow) / sessionRange * 100).toFixed(0);
          log(sym, '🚫 ' + tag + ' CALL BLOCKED — session-range bias: price $' + price.toFixed(2) + ' is in upper half of session range ($' + s.sessionLow.toFixed(2) + '-$' + s.sessionHigh.toFixed(2) + ', ' + pctFromLow + '% off low) and NOT making new high — move is stale.');
          return false;
        }
        // Log the fresh-break override when allowing through
        if (sig.type === 'put' && inLowerHalf && freshNewLow) {
          const breakAgoSec = Math.round((tNow - s.sessionLowUpdateTs) / 1000);
          log(sym, '↪️ ' + tag + ' PUT session-range-bias BYPASS — fresh new session low ' + breakAgoSec + 's ago, allowing breakdown continuation.');
        }
        if (sig.type === 'call' && inUpperHalf && freshNewHigh) {
          const breakAgoSec = Math.round((tNow - s.sessionHighUpdateTs) / 1000);
          log(sym, '↪️ ' + tag + ' CALL session-range-bias BYPASS — fresh new session high ' + breakAgoSec + 's ago, allowing breakout continuation.');
        }
      }
    }

    // ===== (C) PDH/PDL PROXIMITY AWARENESS (added 2026-05-14) =====
    // Previous Day High / Low are well-known reaction levels. When price is approaching PDH/PDL
    // from the "fade direction", PUT/CALL near the level is a high-quality setup. When price
    // BREAKS through with $X buffer, the level is broken — opposite direction continuation
    // is valid. PDH/PDL are taken from s.dailyLevels (saved at each daily reset).
    //
    // Block when: price is "stuck" mid-range between PDH and PDL with a trend signal that
    // doesn't align with either level (no rejection, no break — pure chop). For now we only
    // block if BOTH session-range bias and PDH/PDL bias agree the signal is bad — kept light
    // for first deployment.
    if (isTrendOrMomentum && s.dailyLevels && s.dailyLevels.length >= 1) {
      const pdh = s.dailyLevels[s.dailyLevels.length - 1].high; // yesterday's high
      const pdl = s.dailyLevels[s.dailyLevels.length - 1].low;  // yesterday's low
      const pdhPdlBreakBuffer = isBTC ? 50 : isNAS ? 10 : 2; // XAU $2
      // Mark on the sig for downstream visibility (no block yet — soft feature for tomorrow's analysis)
      if (pdh && pdl) {
        const nearPdh = Math.abs(price - pdh) <= pdhPdlBreakBuffer;
        const nearPdl = Math.abs(price - pdl) <= pdhPdlBreakBuffer;
        const brokeAbovePdh = price > pdh + pdhPdlBreakBuffer;
        const brokeBelowPdl = price < pdl - pdhPdlBreakBuffer;
        // Annotate signal for CSV/log diagnostics, no blocking decision yet
        sig._pdhPdl = { pdh: +pdh.toFixed(2), pdl: +pdl.toFixed(2), nearPdh, nearPdl, brokeAbovePdh, brokeBelowPdl };
        if (nearPdh || nearPdl || brokeAbovePdh || brokeBelowPdl) {
          const ctx = nearPdh ? 'near PDH $' + pdh.toFixed(2) :
                     nearPdl ? 'near PDL $' + pdl.toFixed(2) :
                     brokeAbovePdh ? 'broke above PDH $' + pdh.toFixed(2) :
                     'broke below PDL $' + pdl.toFixed(2);
          log(sym, '📍 ' + tag + ' ' + sig.type.toUpperCase() + ' — PDH/PDL context: ' + ctx + ' (price $' + price.toFixed(2) + ')');
        }
      }
    }

    // ===== WINNERS-ONLY MODE GATES (added 2026-05-14 from 3-day loser audit) =====
    // 3 of 3 confirmed XAU winners had STRUCT in conv factors. 5/8 XAU losers were missing STRUCT.
    // STRUCT = price structure (EMA stack) aligned with signal direction. Without STRUCT, the
    // signal is "macro indicators think direction X" but price isn't actually doing X — high-EV
    // setups always have BOTH. Required for trend/momentum signals (BREAK / FAST / TREND / MFLIP /
    // 6/6 / SUST / SQZ / RIDE). NOT required for fade/reversal detectors (ATH / ATL / HI / LO /
    // VREV / DIV / SWEEP) because those fire AGAINST price structure by design.
    //
    // Extended to BTC on 2026-05-14c at user request — XAU has been doing well with the gate,
    // BTC needs equal treatment. Trade-off: one historical BTC winner (5/12 15:56 PUT BREAK
    // TP1) had no STRUCT and would now be blocked. Forward-looking, STRUCT-required raises
    // quality bar.
    //
    // Extended to NAS100 on 2026-05-15 after today's loss pattern: 2 NAS100 momentum
    // signals lacking STRUCT both SL'd (12:54 FAST PUT @ $29284 conv 6 HIGH → SL $29360;
    // 15:31 ATL CALL @ $29313 conv 5 HIGH — fade, STRUCT-exempt). The one NAS100 momentum
    // signal that DID have STRUCT (16:00 RIDE PUT @ $29216 conv 6) hit TP1+TP2. Consistent
    // with the XAU/BTC pattern — STRUCT separates winners from losers in momentum signals.
    const isStructureReq = (isXAU || isBTC || isNAS) && /BREAK|FAST|TREND|MFLIP|RIDE|6\/6|SUST|SQZ/.test(tag) && !/VREV|ATH|ATL|HI|LO|DIV|SWEEP|LHF|LLF/.test(tag);
    if (isStructureReq) {
      const hasStruct = conv.factors && conv.factors.indexOf('STRUCT') !== -1;
      if (!hasStruct) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tag + ' ' + sig.type.toUpperCase() + ' BLOCKED — missing STRUCT factor. Price structure not aligned with signal direction (3-day loser audit: 5/8 XAU losers missing STRUCT, 3/3 XAU winners had it).');
        return false;
      }
    }

    // 2-consecutive-same-direction history block. Fade signals exempt (counter-trend by design).
    //
    // FIX 2026-05-15 (XAU lockout bug): the previous version used s.signals (which lacks
    // outcome data + lacks ts timestamps) and counted SL'd signals as part of a valid
    // streak. Result: 2 V-REV CALLs (10:54 TP1 winner + 11:10 SL'd loser) locked the bot
    // out of PUTs for the rest of the session — even though XAU went $14 bearish after
    // the second CALL hit SL.
    //
    // New logic: pull from signalHistory (has ts + outcomes), enforce real 60-min window,
    // and STOP counting at either a same-dir signal OR an SL'd signal. A signal that SL'd
    // proves the market disagreed with that direction — so it's not a real "streak member"
    // and shouldn't keep the opposite direction locked out. Only TP-hit or still-open
    // opposite signals count toward the streak.
    if (!isFadeSignal && Array.isArray(signalHistory) && signalHistory.length >= 2) {
      const oppDir = sig.type === 'call' ? 'put' : 'call';
      const cutoffTs = Date.now() - 60 * 60 * 1000; // 60-min window
      const recentSym = signalHistory
        .filter(h => h.symbol === sym && h.ts >= cutoffTs)
        .sort((a, b) => b.ts - a.ts); // newest first
      const streak = [];
      for (const r of recentSym) {
        if (r.type === sig.type) break;                    // hit a same-dir signal → streak broken
        if (r.outcomes && r.outcomes.slHit) break;          // opposite SL'd → not a real streak member
        streak.push(r);                                     // opposite + working (TP hit or open)
      }
      if (streak.length >= 2) {
        Object.assign(s, _emitSnapshot);
        const ages = streak.map(r => Math.round((Date.now() - r.ts) / 60000) + 'min').join(', ');
        log(sym, '🚫 ' + tag + ' ' + sig.type.toUpperCase() + ' BLOCKED — direction-consistency guard: last ' + streak.length + ' working ' + oppDir.toUpperCase() + ' signals in 60min (' + ages + ' ago, no SL between). Need clear flip.');
        return false;
      }
    }
    // Momentum-catch detectors (V-REV, FAST): the price pattern is itself the primary evidence
    // (sharp drop + 40% bounce, or $5 in 3 min). Cross-asset confirmation lags the move by
    // minutes — by the time MACRO/TLT/SLV/GDX flip, the move is over. So don't apply the
    // counter-trend penalty: keep them at conv ≥ 3 regardless of macro direction.
    // Added 2026-05-08 after 5/8 morning bounce ($4711→$4733) was missed: V-REV had the right
    // pattern but conv stayed low because cross-asset hadn't flipped yet.
    const isMomentumCatch = /VREV|FAST/.test(tag);
    let minConv = isMomentumCatch
      ? 3                                        // V-REV / FAST: pattern is evidence, no counter-trend bump
      : ((isCounterTrend || isFadeSignal) ? 4    // ATH / ATL / HI / LO / counter-trend MFLIP·TREND: need 4
                                          : 3);  // trend-aligned: 3 is enough
    // Macro-aligned override (added 2026-05-13): if cross-asset conviction has been
    // ≥6/7 aligned in the signal's direction for ≥5 minutes, skip the soft-block bumps
    // below. The macro thesis is strong enough that ranged/post-reopen/chop suppression
    // becomes overcautious. The hard gates (chop circuit breaker, flipCool, RSI extremes)
    // still apply — this only removes the conv-bump that softly suppresses MOD signals.
    const macroOverride = macroAlignedFor(sig.type);

    // Post-reopen settling period (added 2026-05-13): for 15 min after the 15-min hard
    // opening-bell block expires (18:15-18:30 ET on XAU/NAS), bump conv requirement to 4.
    // Liquidity is still rebuilding; marginal MOD signals in this window have historically
    // been thin-tape noise. Caught 5/12 row 1 BREAK CALL @ 18:05:00 ET (MOD/3) which SL'd.
    if (s._postReopenSettle && minConv < 4 && !macroOverride) minConv = 4;
    // 4-hour range-bound chop bump (added 2026-05-13): when the 4-hour high-low range is
    // tight (< $30 XAU / $1500 BTC / $150 NAS), the market is in extended consolidation
    // even if the 1-hour breakout filter and the efficiency-ratio chop detector say it's fine.
    // Caught 5/13 morning: 8 signals fired in a $13 4-hour range (0.28% of price), at least
    // 3 hit SL. In this regime each "breakout" just touches the other side of the range and
    // reverses. Require HIGH conv (≥4) for trend/momentum signals to fire. Doesn't apply to
    // fade signals (ATH/ATL/HI/LO) — those are SUPPOSED to fire at range edges.
    // Skip for VREV — VREV is a chop-friendly detector and this would double-suppress it.
    // Skip when macroOverride active — full cross-asset alignment trumps short-term chop.
    if (!isFadeSignal && !/VREV/.test(tag) && !macroOverride && s.atrCandles && s.atrCandles.length >= 48) {
      const last48 = s.atrCandles.slice(-48); // 48 × 5-min = 4 hours
      let hi4h = Math.max(...last48.map(c => c.h));
      let lo4h = Math.min(...last48.map(c => c.l));
      // Include in-progress candle so live moves expand the range correctly (2026-05-13)
      if (s.atrCurCandle) {
        if (s.atrCurCandle.h > hi4h) hi4h = s.atrCurCandle.h;
        if (s.atrCurCandle.l < lo4h) lo4h = s.atrCurCandle.l;
      }
      const range4h = hi4h - lo4h;
      const tightThr = isBTC ? 1500 : isNAS ? 150 : 30;
      if (range4h < tightThr && minConv < 4) {
        minConv = 4;
        // Mark on the sig so the block log below is informative if conv falls short
        sig._rangeBoundBump = +(range4h).toFixed(2);
      }
    }

    // ===== BTC WEEKEND SUSTAINED-MOVE OVERRIDE (added 2026-05-18) =====
    // On weekends, cross-asset macro factors (DXY/TLT/SLV/GDX/SPY/QQQ) are stale → BTC
    // conviction caps at conv 2-3 even during real directional moves. The winners-only
    // conv ≥4 threshold for BREAK/FAST then blocks every PUT during a sustained drop.
    // Example: 5/18 Asian session $78K→$76.3K (-2.2% over hours) produced ZERO signals
    // because conv stayed at 3 (just ROC×3 + STRUCT, no macro/cross-asset alignment).
    //
    // Override: if BTC has dropped ≥1.5% in 2h AND STRUCT confirms PUT direction AND
    // the signal is a momentum signal (BREAK/FAST/TREND/RIDE/MFLIP), lower minConv from 4
    // to 3 for this single emission. STRUCT confirmation is the safety net — we still
    // require price structure to agree, just don't require macro that can't be measured
    // when the equity feeds are closed.
    //
    // PUT-only because BTC CALL is hard-blocked on weekends regardless (separate gate).
    // BTC-only because XAU/NAS have their own structural macro stacks.
    const dowOverride = gETDow();
    const isWeekendBtcDow = isBTC && (dowOverride === 0 || dowOverride === 6);
    if (isWeekendBtcDow && sig.type === 'put' && minConv >= 4 && conv.score < 4 && conv.score >= 3) {
      const hasStruct = conv.factors && conv.factors.indexOf('STRUCT') !== -1;
      const isMomentum = /BREAK|FAST|TREND|MFLIP|RIDE|6\/6|SUST|SQZ/.test(tag) && !/VREV|ATH|ATL|HI|LO|DIV|SWEEP|LHF|LLF/.test(tag);
      if (hasStruct && isMomentum && s.atrCandles && s.atrCandles.length >= 24) {
        const candle2hAgo = s.atrCandles[s.atrCandles.length - 24]; // 24 × 5min = 2h
        const dropPct2h = candle2hAgo && candle2hAgo.c ? ((price - candle2hAgo.c) / candle2hAgo.c) * 100 : 0;
        if (dropPct2h <= -1.5) {
          log(sym, '↪️ ' + tag + ' PUT conv-floor BYPASS — weekend sustained drop ' + dropPct2h.toFixed(2) + '% in 2h + STRUCT confirmed. Allowing conv ' + conv.score + ' (was blocked by ≥4 winners-only floor on macro-stale Sunday).');
          minConv = 3;
        }
      }
    }

    if (conv.score < minConv) {
      // Rollback emit-related state to start-of-tick snapshot. Without this, the emit
      // code's pre-gate mutations (dailySignalCount++, lastNTs = now2, fastMoveLastTs = now2,
      // breakLastTs = now2, etc.) would persist even though the signal didn't fire — leaving
      // gaps in num sequence and burning cooldowns. The snapshot was taken at the top of
      // processPrice before any emit code could mutate.
      Object.assign(s, _emitSnapshot);
      const reason = isMomentumCatch ? 'momentum-catch' : isCounterTrend ? 'counter-trend' : isFadeSignal ? 'fade' : 'trend';
      log(sym, '🚫 ' + tag + ' ' + sig.type.toUpperCase() + ' BLOCKED — conv ' + conv.score + '/7 [' + conv.label + '] < ' + minConv + ' (' + reason + ')' + (conv.factors.length ? ' factors:' + conv.factors.join(',') : ''));
      return false;
    }
    return true;
  }

  const now2 = Date.now();
  const cool = now2 - s.lastNTs > COOLDOWN_MS;

  // === OPPOSITE-DIRECTION FLIP GUARD ===
  // Prevent PUT+CALL firing within 30 min of each other (different detectors can disagree at tops/bottoms)
  // Same-direction signals still use normal 3-min cooldown. Opposite direction needs 30 min.
  // Progression: 10→15min 2026-05-13a, 15→30min 2026-05-14 from "winners only" 3-day loser audit
  // — 5/14 01:30 CALL FAST fired 15 min after a PUT BREAK and SL'd (just past 15-min wall).
  // 30 min eliminates the "barely cleared cooldown" loser pattern.
  const FLIP_COOLDOWN_MS = 1800000; // 30 minutes

  // === CHOP CIRCUIT BREAKER ===
  // Maintain flipHistory: opposite-direction signal timestamps in last 60 min.
  // If >=3 flips in 60 min, suppress all opposite-direction signals for next 30 min.
  // Doesn't block same-direction signals (a real trend can keep firing in one direction).
  if (!Array.isArray(s.flipHistory)) s.flipHistory = [];
  const FLIP_WINDOW_MS = 3600000;   // 60 min lookback
  const CHOP_SUPPRESS_MS = 1800000; // 30 min suppression
  const FLIP_BREAKER_THR = 3;       // 3+ flips in window triggers breaker
  s.flipHistory = s.flipHistory.filter(t => t > now2 - FLIP_WINDOW_MS);
  if (s.flipHistory.length >= FLIP_BREAKER_THR && now2 > (s.chopBreakerUntil || 0)) {
    s.chopBreakerUntil = now2 + CHOP_SUPPRESS_MS;
    log(sym, '🚧 CHOP CIRCUIT BREAKER engaged — ' + s.flipHistory.length + ' direction flips in last 60 min. Opposite-direction signals suppressed for next 30 min.');
  }
  const chopBreakerActive = now2 < (s.chopBreakerUntil || 0);

  const flipCool = !s.lastSignalDir || (now2 - s.lastNTs > FLIP_COOLDOWN_MS);
  // flipCoolFor(dir): returns true if firing 'dir' is allowed given the last signal's direction
  function flipCoolFor(dir) {
    if (!s.lastSignalDir) return true; // no previous signal
    if (s.lastSignalDir === dir) return cool; // same direction: normal 3-min cooldown
    // Opposite direction: must clear flip cooldown AND chop circuit breaker must be inactive.
    // Macro-aligned override (added 2026-05-13): if cross-asset conviction has been ≥6 aligned
    // with `dir` for ≥5 min, allow the flip even when the chop breaker is active. The macro
    // thesis says the prior signals were the wrong direction and we should reverse. The
    // 15-min flip cooldown still applies — only the chop breaker is bypassed.
    const macroFlipOk = (s.fullConvSinceCall && dir === 'call' && (now2 - s.fullConvSinceCall) >= 300000) ||
                         (s.fullConvSincePut && dir === 'put' && (now2 - s.fullConvSincePut) >= 300000);
    if (chopBreakerActive && !macroFlipOk) {
      if (now2 - (s.chopBreakerLogTs || 0) > 60000) {
        log(sym, 'Opposite-direction signal suppressed — chop circuit breaker active for ' + Math.round((s.chopBreakerUntil - now2) / 60000) + 'm more');
        s.chopBreakerLogTs = now2;
      }
      return false;
    }
    if (chopBreakerActive && macroFlipOk) {
      log(sym, '🔄 Chop breaker BYPASS — macro 6+/7 aligned ' + dir.toUpperCase() + ' for ' + Math.round((now2 - (dir === 'call' ? s.fullConvSinceCall : s.fullConvSincePut)) / 60000) + 'min. Allowing flip.');
    }
    return now2 - s.lastNTs > FLIP_COOLDOWN_MS; // opposite direction: 15-min cooldown
  }

  // === SIGNAL GATES ===
  // XAU: full session 6PM-5PM ET (Sun-Fri) = nearly 23h, block 5PM-6PM ET (1020-1080 min)
  // BTC: 24/7, no block window (crypto never sleeps)
  // Equities: 9:30 AM - 3:55 PM ET (570-955 min)
  //
  // Opening-bell noise filter (added 2026-05-07, extended 2026-05-13).
  // For XAU and NAS100, block all signals in the first 15 minutes of the futures session
  // reopen (6:00-6:15 PM ET = 1080-1095 min). Right after the 5-6 PM daily break, liquidity
  // is thin and the first prints can produce false directional reads before the session settles.
  //
  // Extended from 5 → 15 min after 5/12 row 1 caught: BREAK CALL at 18:05:00 ET — fired at
  // the EXACT second the old 5-min block expired. RSI 51.7 (neutral), conv 3 MOD (just barely
  // met), ROC +0.091% (modest). Classic post-reopen thin-liquidity false breakout. Hit SL.
  // 15 min gives the order book time to rebuild before the bot acts on early prints.
  if ((isXAU || isNAS) && etMin >= 1080 && etMin < 1095) {
    if (now2 - (s.openBlockLogTs || 0) > 60000) {
      log(sym, '⏸ Opening-bell block: first 15 min of 6:00 PM futures reopen — too noisy for entries');
      s.openBlockLogTs = now2;
    }
    return;
  }
  // Soft post-reopen settling period: from 18:15-18:30 ET, ONLY HIGH conviction signals fire.
  // Prevents marginal MOD signals from firing while session is still re-pricing but past the
  // hard block. Implemented via state flag checked downstream by enrichSig (conviction gate).
  s._postReopenSettle = (isXAU || isNAS) && etMin >= 1095 && etMin < 1110;
  if (isXAU) {
    if (etMin >= 1020 && etMin < 1080) return; // XAU closed 5-6 PM ET
  } else if (isBTC) {
    // BTC trades 24/7 but weekends are ultra-thin liquidity. Previously hard-blocked all
    // signals Sat/Sun. Updated 2026-05-16 after 52-week analysis showed:
    //   • Full year: 57.7% CALL weekends / 42.3% PUT (slightly CALL-biased overall)
    //   • Last 6 months (Nov 2025 → May 2026): 57.7% PUT / 42.3% CALL with -16.56%
    //     cumulative; PUT moves average -1.83% vs CALL +1.50% (bigger downside swings)
    //   • Top 5 PUT weekends ranged -3.18% to -8.5%; top 5 CALL +2.43% to +3.10%
    // Decision: allow BTC PUT signals on weekends (with normal macro/STRUCT/conviction
    // gates handling quality). Keep blocking BTC CALL signals on weekends — recent regime
    // is PUT-favorable and CALL setups would need to overcome lower frequency + smaller
    // magnitude. Sets a flag that enrichSig() reads to block CALL emits.
    const dow = gETDow();
    s._weekendBtcPutOnly = (dow === 0 || dow === 6);
    if (s._weekendBtcPutOnly && now2 - (s.weekendBlockLogTs || 0) > 600000) {
      log(sym, '⏸ Weekend mode: BTC CALL signals blocked Sat/Sun (PUT-only — last 6mo 58% PUT-favorable, low-liquidity chop on CALL setups).');
      s.weekendBlockLogTs = now2;
    }
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

  // Variables hoisted to function scope (2026-05-08 fix) so they're visible both inside the
  // base scoring block (atrBlocked === false) AND below it where Shakeout Recovery + 6/6 emit
  // logic also reference them. Previously declared inside the else{} below which made them
  // inaccessible to line ~2438+, throwing ReferenceError every tick.
  // - Booleans computed at function scope (no else-block dependencies)
  const rsiSweetCall = rsiV >= RSI_CALL_LO[sym] && rsiV <= RSI_CALL_HI[sym];
  const rsiSweetPut = rsiV >= RSI_PUT_LO[sym] && rsiV <= RSI_PUT_HI[sym];
  const sustainedOverride = s.sustainedCount >= 10 && s.sustainedDir !== null;
  const macdAlignCall = macdL > macdS;
  const macdAlignPut = macdL < macdS;
  // - Numeric thresholds — safe default of 99 (unreachable score) when atrBlocked,
  //   so 6/6 signals don't fire during low-ATR periods (the original intent).
  //   Inside the else block these get reassigned via bare `minS = ...` (no let/const).
  let minS = 99;
  let finalMinS = 99;

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
  // Reassigning the function-scope `let minS = 99` declared above the if/else (no `let` here).
  minS = Math.max(chopThr, (tightMode ? 6 : sessionThr)) + (streakActive ? s.lossStreakBoost : 0) + roundNumPenalty;

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

  // sustainedOverride is now declared at function scope above the if/else (line ~1101).
  // Kept here as a comment so the original logic intent is still readable in this section:
  //   "If ROC has been directional for 10+ consecutive ticks, the move is real regardless of exhaustion."

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
  // Note: rsiSweetCall and rsiSweetPut are now declared at function scope above (line ~1101)
  // so they're visible to Shakeout Recovery + 6/6 emit logic that runs below.
  // Extreme-RSI hard floor for sustainedOverride (added 2026-05-13): even with 10+ ticks of
  // sustained momentum, refuse PUT signals at RSI ≤ 30 and CALL signals at RSI ≥ 70. Caught
  // 5/12 row 15: 6/6 PUT @ $4679.89 fired at RSI 31.9 — sustainedOverride bypassed the
  // PUT_LO floor of 40, signal landed right at the V-bottom before a $40+ recovery.
  // The asymmetry: sustained downward momentum that has driven RSI below 30 IS, by definition,
  // an exhausted move — the bot is selling the bottom, not catching the trend.
  const rsiHardOversold = rsiV <= 30;  // no PUT bypass below 30
  const rsiHardOverbought = rsiV >= 70; // no CALL bypass above 70

  if (!rsiSweetCall && cS >= minS && cS >= pS) {
    if (sustainedOverride && s.sustainedDir === 'call' && !rsiHardOverbought) {
      log(sym, 'RSI gate override: sustained CALL momentum (' + s.sustainedCount + ' ticks) — RSI ' + rsiV.toFixed(1) + ' outside sweet zone');
    } else {
      if (rsiHardOverbought) log(sym, 'RSI hard-overbought block: RSI ' + rsiV.toFixed(1) + ' ≥ 70 — sustainedOverride disabled (chasing the top)');
      return;
    }
  }
  if (!rsiSweetPut && pS >= minS && pS > cS) {
    if (sustainedOverride && s.sustainedDir === 'put' && !rsiHardOversold) {
      log(sym, 'RSI gate override: sustained PUT momentum (' + s.sustainedCount + ' ticks) — RSI ' + rsiV.toFixed(1) + ' outside sweet zone');
    } else {
      if (rsiHardOversold) log(sym, 'RSI hard-oversold block: RSI ' + rsiV.toFixed(1) + ' ≤ 30 — sustainedOverride disabled (selling the bottom)');
      return;
    }
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
  // Reassigning function-scope `let finalMinS = 99` declared above the if/else (no `const` here).
  finalMinS = minS;

  // MACD alignment
  // macdAlignCall and macdAlignPut hoisted to function scope above (line ~1101) — kept here for reference
  // const macdAlignCall = macdL > macdS, macdAlignPut = macdL < macdS;
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
  // Time gate: equities 9:30-15:55 ET only. MT5 instruments (XAU/BTC/NAS100) trade 24h.
  // BUG FIX 2026-05-14: previously the etMin gate applied to MT5 too, blocking ⬇HI from
  // firing at the 5/14 $4716 peak (03:00 ET = etMin 180 < 570). XAU/BTC/NAS need 24h coverage.
  if (s.sessionHigh > -Infinity && s.openPrice && cool && hiLoRsiSane && flipCoolFor('put') && winProtectDir !== 'call' && (isMT5 || (s.dailySignalCount < MAX_SIG && etMin >= 570 && etMin < 955))) {
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

  // Session Low Reversal Detector — fire high-confidence CALL when price reverses from session low
  // Added 2026-05-13 (audit finding HIGH-1): mirror of HIGH REVERSAL PUT. Without this, the
  // CALL side was missing this signal class entirely. Also writes s.lastLoRevTs which is read
  // by TRv2 SHORT-blocking guards at lines ~3528 / 3617-3625 — those guards were dead code
  // until this detector existed because nothing wrote the timestamp.
  // Same 24h fix as ⬇HI above — MT5 instruments need session-low reversal detection any hour.
  if (s.sessionLow < Infinity && s.openPrice && cool && hiLoRsiSane && flipCoolFor('call') && winProtectDir !== 'put' && (isMT5 || (s.dailySignalCount < MAX_SIG && etMin >= 570 && etMin < 955))) {
    const distFromLow = price - s.sessionLow;
    const sessionRange = s.sessionHigh - s.sessionLow;
    const lowWasRecent = s.prices.length >= 10 && Math.min(...s.prices.slice(-30 > -s.prices.length ? -30 : 0)) <= s.sessionLow + 0.05;
    // Same per-instrument thresholds as HIGH reversal — symmetric setup.
    const loRevDist  = isBTC ? 80.0 : isNAS ? 50.0 : isXAU ? 5.0 : 0.50;   // min bounce from low
    const loRevRange = isBTC ? 150.0 : isNAS ? 100.0 : isXAU ? 10.0 : 1.0;  // min session range
    // RSI@low must have been oversold (< 45), and ROC OR MACD confirms upside reversal.
    const loRevRocOk  = roc3 > symRocThr;
    const loRevMacdOk = macdL > macdS;
    if (distFromLow >= loRevDist && s.rsiAtSessionLow < 45 && sessionRange >= loRevRange && lowWasRecent && (loRevRocOk || loRevMacdOk)) {
      if (s.lastSignalDir !== 'call' || (now2 - s.lastNTs > COOLDOWN_MS)) {
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆LO', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig);
        logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, 'call', price, atrVal, sym);
        s.lastLoRevTs = now2; // Track for TRv2 SHORT-entry suppression
        log(sym, '🚀 SESSION LOW REVERSAL CALL — $' + distFromLow.toFixed(2) + ' off low $' + s.sessionLow.toFixed(2) + ' RSI@low:' + s.rsiAtSessionLow.toFixed(1) + ' RSInow:' + rsiV.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' LOW REVERSAL CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromLow.toFixed(2) + ' off low · RSI@low:' + s.rsiAtSessionLow.toFixed(1), 'signal');
        s.trade = isMT5 ? buildCfdTrade('call', price, atrVal, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
        return;
      }
    }
  }

  // ===== LOCAL HIGH FADE (LHF) / LOCAL LOW FADE (LLF) — added 2026-05-15 =====
  // Top-fade detector: fires when price has just made a fresh local 60-min high (LHF PUT)
  // or low (LLF CALL) AND is showing first signs of rejection. The goal is entering NEAR
  // the local extreme ($3-8 off it), NOT after $15+ confirmation — so this is a fade
  // detector, not momentum. R:R designed at ~1:3 (tight SL above local high + buffer, TP
  // targets at 1.5x / 3x / 5x SL distance).
  //
  // Born from 5/15 XAU $4572 → $4545 drop where the bot fired nothing because:
  //  - FAST detectors confirm after RSI flips deep (RSI was 24-35 by the time price made
  //    a $15+ drop — already chasing the bottom).
  //  - BREAK needs candle break of structure — also late.
  //  - Session HI Reversal only fires at the FULL SESSION high, not local 60-min highs.
  // LHF fills the gap: fire $3-7 off a fresh LOCAL high while macro PUT-aligned.
  //
  // STRICT gates (this is fading WITH macro bias, so the macro alignment IS the trend
  // confirmation — but we still need pattern proof the local rejection is real):
  //   • Macro 6+/7 aligned in fade direction, stable ≥5 min (macroAlignedFor)
  //   • Fresh local extreme: high formed 3-25 min ago (3min min = real rejection, not 1-tick spike)
  //   • Sweet spot distance: price is $3-7 (XAU) / $100-250 (BTC) / $12-30 (NAS) off it
  //   • RSI rolled over from overbought: now 35-60 (was >65 recently for PUT)
  //   • MACD compressing in fade direction (line crossed below signal for PUT, vice versa)
  //   • Local range meaningful: localHi - localLo ≥ $6 (XAU) / $200 (BTC) / $25 (NAS) — no chop
  //   • Cooldown 30 min per direction
  //   • Standard flipCool / winProtectDir / cool guards apply (same as other detectors)
  const hasLocalCandles = s.atrCandles && s.atrCandles.length >= 6;
  if (hasLocalCandles && cool && (rsiV >= 10 && rsiV <= 90)) {
    const last6 = s.atrCandles.slice(-6); // 6 × 5-min candles = 30 min lookback
    let localHi6 = -Infinity, localHi6Idx = -1;
    let localLo6 = Infinity,  localLo6Idx = -1;
    last6.forEach((c, i) => {
      if (c && c.h > localHi6) { localHi6 = c.h; localHi6Idx = i; }
      if (c && c.l < localLo6) { localLo6 = c.l; localLo6Idx = i; }
    });
    // Approx age: oldest candle = index 0 (~30 min ago at start), newest = index 5 (~0-5 min)
    // Use midpoint of each candle: (5 - idx) * 5 - 2.5 + adjustment for last-tick recency
    const lhfHiAgeMin = Math.max(0, (last6.length - 1 - localHi6Idx) * 5 + 2.5);
    const lhfLoAgeMin = Math.max(0, (last6.length - 1 - localLo6Idx) * 5 + 2.5);
    const lhfLocalRange = localHi6 - localLo6;

    // Thresholds per instrument
    const lhfDistMin    = isBTC ? 100 : isNAS ? 12 : isXAU ? 3 : 0.25;
    const lhfDistMax    = isBTC ? 250 : isNAS ? 30 : isXAU ? 8 : 0.60;
    const lhfRangeMin   = isBTC ? 200 : isNAS ? 25 : isXAU ? 6 : 0.50;
    const lhfSlBuffer   = isBTC ? 50  : isNAS ? 8  : isXAU ? 2 : 0.20;
    const lhfMinAgeMin  = 3;
    const lhfMaxAgeMin  = 25;
    const lhfCooldownMs = 30 * 60 * 1000;

    // ---- LHF PUT (fade fresh local high) ----
    const dropFromLocalHi = localHi6 - price;
    const lhfPutTimingOk = lhfHiAgeMin >= lhfMinAgeMin && lhfHiAgeMin <= lhfMaxAgeMin;
    const lhfPutDistOk   = dropFromLocalHi >= lhfDistMin && dropFromLocalHi <= lhfDistMax;
    const lhfPutRangeOk  = lhfLocalRange >= lhfRangeMin;
    const lhfPutCoolOk   = (Date.now() - s.lastLhfPutTs) >= lhfCooldownMs;
    const lhfPutRsiOk    = rsiV < 60 && rsiV > 35;
    const lhfPutMacdOk   = macdL < macdS && macdHist < 0;
    // Relaxed LHF macro gate (2026-05-18): original macroAlignedFor required 6+/7 stable
    // for 5min — far too strict, produced 885 blocks in one session with zero fires.
    // New: accept EITHER the strict alignment OR a softer "5+/7 stable for 2min" check.
    // The softer path catches setups where macro is forming but hasn't reached full strength.
    // Other gates (RSI rolling, MACD compressing, fresh local high <25min) still gate quality.
    const SOFT_MACRO_THR = 5;
    const SOFT_MACRO_STABLE_MS = 120000; // 2 min
    const tSoftMacro = Date.now();
    const lhfPutMacroOk  = macroAlignedFor('put') ||
      (s.fullConvSincePut > 0 && (tSoftMacro - s.fullConvSincePut) >= SOFT_MACRO_STABLE_MS && convictionFor('put').score >= SOFT_MACRO_THR);
    const lhfPutFlipOk   = flipCoolFor('put');
    const lhfPutWinOk    = winProtectDir !== 'call';
    if (lhfPutTimingOk && lhfPutDistOk && lhfPutRangeOk && lhfPutCoolOk &&
        lhfPutRsiOk && lhfPutMacdOk && lhfPutMacroOk && lhfPutFlipOk && lhfPutWinOk) {
      if (s.lastSignalDir !== 'put' || (now2 - s.lastNTs > COOLDOWN_MS)) {
        s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇LHF', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig);
        logSignal(sym, sig);
        if (isMT5) {
          // Tight SL at local high + buffer; TPs scaled off that SL distance for 1:1.5/3/5 R:R.
          // Trade object uses *Price keys (slPrice/tp1Price/...); sig keys are sl/tp1/... strings.
          const lhfSlPrice = localHi6 + lhfSlBuffer;
          const slDist = lhfSlPrice - price;
          if (slDist > 0) {
            const tp1P = price - slDist * 1.5;
            const tp2P = price - slDist * 3.0;
            const tp3P = price - slDist * 5.0;
            s.trade = buildCfdTrade('put', price, atrVal, sym);
            s.trade.slPrice = +lhfSlPrice.toFixed(2);
            s.trade.tp1Price = +tp1P.toFixed(2);
            s.trade.tp2Price = +tp2P.toFixed(2);
            s.trade.tp3Price = +tp3P.toFixed(2);
            sig.sl = lhfSlPrice.toFixed(2);
            sig.tp1 = tp1P.toFixed(2);
            sig.tp2 = tp2P.toFixed(2);
            sig.tp3 = tp3P.toFixed(2);
          } else {
            // Defensive: if local high not above price (shouldn't happen — dropFromLocalHi ≥ 3),
            // fall back to standard buildCfdTrade + attachTpSl so we never have an inverted SL.
            s.trade = buildCfdTrade('put', price, atrVal, sym);
            attachTpSl(sig, 'put', price, atrVal, sym);
          }
        }
        s.lastLhfPutTs = now2;
        log(sym, '🎯 LOCAL HIGH FADE PUT — $' + dropFromLocalHi.toFixed(2) + ' off local high $' + localHi6.toFixed(2) + ' (' + Math.round(lhfHiAgeMin) + 'min ago) · RSI ' + rsiV.toFixed(1) + ' · range $' + lhfLocalRange.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🎯 ' + sym + ' LOCAL HIGH FADE PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + dropFromLocalHi.toFixed(2) + ' off local high · macro PUT-aligned', 'signal');
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
        return;
      }
    } else if (lhfPutTimingOk && lhfPutDistOk && lhfPutRangeOk && lhfPutCoolOk) {
      // Log near-misses so we can audit how often the gates block real setups
      let reason;
      if (!lhfPutMacroOk) reason = 'macro not PUT-aligned (need strict 6+/7@5min OR soft 5+/7@2min)';
      else if (!lhfPutRsiOk) reason = 'RSI ' + rsiV.toFixed(1) + ' outside 35-60';
      else if (!lhfPutMacdOk) reason = 'MACD not compressing bearish (line ' + macdL.toFixed(3) + ' vs sig ' + macdS.toFixed(3) + ', hist ' + macdHist.toFixed(3) + ')';
      else if (!lhfPutFlipOk) reason = 'flip cooldown';
      else if (!lhfPutWinOk) reason = 'protecting winning CALL';
      if (reason) log(sym, '🚫 ⬇LHF PUT BLOCKED — ' + reason + ' (was $' + dropFromLocalHi.toFixed(2) + ' off local high $' + localHi6.toFixed(2) + ', ' + Math.round(lhfHiAgeMin) + 'min ago).');
    }

    // ---- LLF CALL (fade fresh local low) — symmetric mirror ----
    const riseFromLocalLo = price - localLo6;
    const llfCallTimingOk = lhfLoAgeMin >= lhfMinAgeMin && lhfLoAgeMin <= lhfMaxAgeMin;
    const llfCallDistOk   = riseFromLocalLo >= lhfDistMin && riseFromLocalLo <= lhfDistMax;
    const llfCallRangeOk  = lhfLocalRange >= lhfRangeMin;
    const llfCallCoolOk   = (Date.now() - s.lastLlfCallTs) >= lhfCooldownMs;
    const llfCallRsiOk    = rsiV > 40 && rsiV < 65;
    const llfCallMacdOk   = macdL > macdS && macdHist > 0;
    // Same relaxed macro gate for LLF (mirror of LHF). See LHF comment above.
    const llfCallMacroOk  = macroAlignedFor('call') ||
      (s.fullConvSinceCall > 0 && (tSoftMacro - s.fullConvSinceCall) >= SOFT_MACRO_STABLE_MS && convictionFor('call').score >= SOFT_MACRO_THR);
    const llfCallFlipOk   = flipCoolFor('call');
    const llfCallWinOk    = winProtectDir !== 'put';
    if (llfCallTimingOk && llfCallDistOk && llfCallRangeOk && llfCallCoolOk &&
        llfCallRsiOk && llfCallMacdOk && llfCallMacroOk && llfCallFlipOk && llfCallWinOk) {
      if (s.lastSignalDir !== 'call' || (now2 - s.lastNTs > COOLDOWN_MS)) {
        s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆LLF', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig);
        logSignal(sym, sig);
        if (isMT5) {
          const llfSlPrice = localLo6 - lhfSlBuffer;
          const slDist = price - llfSlPrice;
          if (slDist > 0) {
            const tp1P = price + slDist * 1.5;
            const tp2P = price + slDist * 3.0;
            const tp3P = price + slDist * 5.0;
            s.trade = buildCfdTrade('call', price, atrVal, sym);
            s.trade.slPrice = +llfSlPrice.toFixed(2);
            s.trade.tp1Price = +tp1P.toFixed(2);
            s.trade.tp2Price = +tp2P.toFixed(2);
            s.trade.tp3Price = +tp3P.toFixed(2);
            sig.sl = llfSlPrice.toFixed(2);
            sig.tp1 = tp1P.toFixed(2);
            sig.tp2 = tp2P.toFixed(2);
            sig.tp3 = tp3P.toFixed(2);
          } else {
            s.trade = buildCfdTrade('call', price, atrVal, sym);
            attachTpSl(sig, 'call', price, atrVal, sym);
          }
        }
        s.lastLlfCallTs = now2;
        log(sym, '🎯 LOCAL LOW FADE CALL — $' + riseFromLocalLo.toFixed(2) + ' off local low $' + localLo6.toFixed(2) + ' (' + Math.round(lhfLoAgeMin) + 'min ago) · RSI ' + rsiV.toFixed(1) + ' · range $' + lhfLocalRange.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🎯 ' + sym + ' LOCAL LOW FADE CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + riseFromLocalLo.toFixed(2) + ' off local low · macro CALL-aligned', 'signal');
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
        return;
      }
    } else if (llfCallTimingOk && llfCallDistOk && llfCallRangeOk && llfCallCoolOk) {
      let reason;
      if (!llfCallMacroOk) reason = 'macro not CALL-aligned (need strict 6+/7@5min OR soft 5+/7@2min)';
      else if (!llfCallRsiOk) reason = 'RSI ' + rsiV.toFixed(1) + ' outside 40-65';
      else if (!llfCallMacdOk) reason = 'MACD not compressing bullish (line ' + macdL.toFixed(3) + ' vs sig ' + macdS.toFixed(3) + ', hist ' + macdHist.toFixed(3) + ')';
      else if (!llfCallFlipOk) reason = 'flip cooldown';
      else if (!llfCallWinOk) reason = 'protecting winning PUT';
      if (reason) log(sym, '🚫 ⬆LLF CALL BLOCKED — ' + reason + ' (was $' + riseFromLocalLo.toFixed(2) + ' off local low $' + localLo6.toFixed(2) + ', ' + Math.round(lhfLoAgeMin) + 'min ago).');
    }
  }

  // ===== CONSOLIDATION BREAKOUT DETECTOR (MT5 instruments: XAU + BTC + NAS100) =====
  // Fires INSTANTLY when price escapes a tight range — no lagging indicator delay.
  // This is the fastest signal: catches moves 2-3 min before EMAs/RSI/MACD confirm.
  // The coil detection + breakout pending flag is set in processTicks (runs every 1s).
  // Here we just fire the signal if a valid breakout was detected this tick.
  // BREAKOUT is NOT blocked during chop (changed 2026-05-08): a breakout BY DEFINITION fires
  // after a coil — i.e., the resolution of chop. The detector exists specifically to catch
  // chop-end transitions. Blocking it during chop kills the very pattern we want.
  // Quality is enforced by the detector's own filters (consecutive same-dir cooldown, ROC
  // confirmation, RSI exhaustion at >75 for XAU CALL, MACD-fading check).
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

      // Filter 3: RSI exhaustion gates — tightened 2026-05-11 to match new anti-late-fire
      // stance across detectors. Was XAU-CALL-only with > 75 threshold; now applied to both
      // directions on all MT5 instruments at 35/65 floor/ceiling. Prevents BREAK PUTs from
      // firing at RSI 32 (signal #5 today, late-stage entry) and BREAK CALLs at RSI 65+.
      // BTC kept its more permissive ceiling for CALLs (75) because BTC trends sustain longer.
      if (bo.dir === 'put' && rsiV < 35) {
        log(sym, '💥 BREAKOUT blocked: ⬇BREAK RSI ' + rsiV.toFixed(1) + ' < 35 — oversold, entering at exhaustion');
        s._pendingBreakout = null;
        return;
      }
      // BTC ceiling lowered 2026-05-11 c: was 75 (permissive, "crypto trends sustain longer"),
      // but BTC 5/11 data falsified that — CALL BREAK at RSI 73.6 lost -0.81%, RSI 73.4 lost
      // -0.03%. RSI 73+ is reliable top-buying zone even for BTC. Aligning with XAU/NAS at 70.
      const brkCallRsiMax = 70;
      if (bo.dir === 'call' && rsiV > brkCallRsiMax) {
        log(sym, '💥 BREAKOUT blocked: ⬆BREAK RSI ' + rsiV.toFixed(1) + ' > ' + brkCallRsiMax + ' — overbought, entering at exhaustion');
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

      // Filter 5: MACD line direction alignment (added 2026-05-09)
      // Filter 4 only checked the histogram. A PUT could still fire when macdL was POSITIVE
      // (bullish bias) if the histogram happened to be negative. Empirical: BTC 5/9 05:14
      // ⬇BREAK PUT fired at macdL +0.290 — direction misalignment slipped past filter 4.
      // Now require macdL to agree with breakout direction (≤ 0 for PUT, ≥ 0 for CALL).
      const macdLineMisaligned = (bo.dir === 'call' && macdL < 0) || (bo.dir === 'put' && macdL > 0);
      if (macdLineMisaligned) {
        log(sym, '💥 BREAKOUT blocked: MACD line ' + macdL.toFixed(3) + ' wrong side for ' + bo.dir.toUpperCase() + ' (need ' + (bo.dir === 'call' ? '≥ 0' : '≤ 0') + ')');
        s._pendingBreakout = null;
        return;
      }

      // Filter 6: 1-hour range gate (added 2026-05-09)
      // BTC 5/8–5/9 fired 16 BREAKOUTs in a $256 range over 20h — every breakout was a
      // false escape inside a tight consolidation. If the broader 1h range is too narrow,
      // a "breakout" is just noise. Use 5-min ATR candles (12 = 1 hour).
      // Per-instrument min range as % of price: BTC 0.30, XAU 0.20, NAS 0.25.
      if (s.atrCandles && s.atrCandles.length >= 12) {
        const last12 = s.atrCandles.slice(-12);
        let hi1h = Math.max(...last12.map(c => c.h));
        let lo1h = Math.min(...last12.map(c => c.l));
        // Include in-progress candle so an in-flight breakout that's expanding the range
        // isn't blocked by the prior tight closed-candle range (2026-05-13).
        if (s.atrCurCandle) {
          if (s.atrCurCandle.h > hi1h) hi1h = s.atrCurCandle.h;
          if (s.atrCurCandle.l < lo1h) lo1h = s.atrCurCandle.l;
        }
        const range1h = hi1h - lo1h;
        const rangePct = (range1h / price) * 100;
        const minRangePct = isBTC ? 0.30 : isNAS ? 0.25 : isXAU ? 0.20 : 0.20;
        if (rangePct < minRangePct) {
          log(sym, '💥 BREAKOUT blocked: 1h range too tight — ' + rangePct.toFixed(2) + '% < ' + minRangePct + '% (range $' + range1h.toFixed(2) + ' on $' + price.toFixed(2) + ')');
          s._pendingBreakout = null;
          return;
        }
      }

      // Filter 7: Same-direction breakout cap (added 2026-05-09)
      // Filter 1 only blocks consecutive same-dir within 15 min. The BTC 5/8 chain (4 CALLs
      // 18:00 → 20:33 → 21:12 → 21:31, all ⬆BREAK) spanned 3.5 hours so filter 1 missed it.
      // Hard cap: max 3 same-direction breakouts in any 2-hour rolling window. Forces the
      // detector to wait for a real direction flip before stacking again.
      const breakLegMs = 7200000; // 2 hours
      const breakMaxSameDir = 3;
      // Reset the leg counter if direction flipped OR if it's been >2h since the leg started
      if (s.breakLastDir !== bo.dir || (s.breakLegStartTs && now2 - s.breakLegStartTs > breakLegMs)) {
        s.breakSameDirCount = 0;
        s.breakLegStartTs = now2;
      }
      if (s.breakSameDirCount >= breakMaxSameDir) {
        log(sym, '💥 BREAKOUT blocked: ' + s.breakSameDirCount + ' same-direction ' + bo.dir.toUpperCase() + ' breakouts already in this 2h leg (max ' + breakMaxSameDir + ')');
        s._pendingBreakout = null;
        return;
      }
      // Filter 8: Round-number resistance/support gate (added 2026-05-12, deferred-fire 2026-05-12 b)
      // XAU $50 levels ($4700, $4750, etc.) are well-known psychological resistance.
      // When BREAK fires while price is in zone AND approaching from "wrong" side, instead
      // of dropping the breakout entirely, RE-ARM s._pendingBreakout so the filter chain
      // re-runs each subsequent tick. As price ticks up through $4700.50+, the filter passes
      // and the breakout fires at the confirmed-break price.
      // Expiry: 5 minutes of waiting → give up (coil context has moved on).
      if (isXAU && roundNumZone) {
        const breakBuffer = 0.50;
        const isCallStillBelow = bo.dir === 'call' && price < nearestRound + breakBuffer;
        const isPutStillAbove  = bo.dir === 'put'  && price > nearestRound - breakBuffer;
        if (isCallStillBelow || isPutStillAbove) {
          // First time we deferred? Stamp the start time so we can expire after 5 min.
          if (!bo.roundPendingTs) bo.roundPendingTs = now2;
          if (now2 - bo.roundPendingTs > 300000) {
            log(sym, '💥 BREAK ' + bo.dir.toUpperCase() + ' deferred-expired — round-number break not confirmed in 5min, dropping setup');
            s._pendingBreakout = null;
            return;
          }
          // Re-arm pendingBreakout so the filter chain runs again next tick.
          // Throttle the "waiting" log to once every 30s so it doesn't spam.
          if (!bo.roundLastLogTs || now2 - bo.roundLastLogTs > 30000) {
            const targetStr = bo.dir === 'call' ? '$' + (nearestRound + breakBuffer).toFixed(2) + '+' : '$' + (nearestRound - breakBuffer).toFixed(2) + '-';
            log(sym, '💥 BREAK ' + bo.dir.toUpperCase() + ' deferred — $' + price.toFixed(2) + ' near $' + nearestRound + ', waiting for confirmed break (' + targetStr + ') · ' + Math.round((300000 - (now2 - bo.roundPendingTs)) / 1000) + 's left');
            bo.roundLastLogTs = now2;
          }
          s._pendingBreakout = bo; // keep waiting — re-runs next tick
          return;
        }
        // Price has cleared the round number — confirmed break, let the signal fire.
        // (bo.roundPendingTs may be set from earlier waiting ticks; that's harmless.)
        if (bo.roundPendingTs) {
          log(sym, '💥 BREAK ' + bo.dir.toUpperCase() + ' confirmed-break — $' + price.toFixed(2) + ' cleared $' + nearestRound + ' after ' + Math.round((now2 - bo.roundPendingTs) / 1000) + 's wait');
        }
      }
      s.breakSameDirCount++;

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
      s.trade = isMT5 ? attachOTE(buildCfdTrade(dir, price, atrVal, sym), s, sym, dir) : { active: true, type: dir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
      if (isMT5 && s.trade.oteLimit) log(sym, '🎯 OTE ' + dir.toUpperCase() + ' limit set @ $' + s.trade.oteLimit.toFixed(2) + ' (BREAK retracement entry, expires in 3min)');

      // ===== NAS BREAK — override SL/TPs with coil-relative levels (added 2026-05-16) =====
      // For NAS specifically: when BREAK fires, the coil high/low are the natural structural
      // levels. SL just inside the OPPOSITE coil edge keeps risk tight (typically $15-25 vs
      // ATR-based $50). TPs scaled to the coil range (the bigger the coil, the bigger the
      // post-break expansion target — standard 1:1 to 1:N coil-to-break-expansion ratio).
      // For a $20 coil this produces SL ~$15-20, TP1 $40 (2× range), TP2 $80, TP3 $160.
      // R:R ~1:2 / 1:4 / 1:8 — far better than the previous ATR-based 1:1.5 / 1:2.5 / 1:4.
      if (isNAS && isMT5 && bo.coilHi && bo.coilLo && s.trade && s.trade.isCfd) {
        const coilRange = bo.coilHi - bo.coilLo;
        // SL = OPPOSITE side of coil + small buffer (so noise inside the coil doesn't trip it)
        // For CALL: SL = coilLo (or coilMid if you want tighter — we use coilLo for safety against
        //   the immediate-retest pattern). For PUT: SL = coilHi.
        const slBuffer = 2; // small NAS buffer
        const coilSL = dir === 'call' ? bo.coilLo - slBuffer : bo.coilHi + slBuffer;
        const slOk = dir === 'call' ? coilSL < price : coilSL > price;
        if (slOk) {
          s.trade.slPrice = +coilSL.toFixed(2);
          const tp1P = dir === 'call' ? price + coilRange * 2 : price - coilRange * 2;
          const tp2P = dir === 'call' ? price + coilRange * 4 : price - coilRange * 4;
          const tp3P = dir === 'call' ? price + coilRange * 8 : price - coilRange * 8;
          s.trade.tp1Price = +tp1P.toFixed(2);
          s.trade.tp2Price = +tp2P.toFixed(2);
          s.trade.tp3Price = +tp3P.toFixed(2);
          sig.sl = s.trade.slPrice.toFixed(2);
          sig.tp1 = s.trade.tp1Price.toFixed(2);
          sig.tp2 = s.trade.tp2Price.toFixed(2);
          sig.tp3 = s.trade.tp3Price.toFixed(2);
          const slDistDollars = Math.abs(price - coilSL).toFixed(2);
          log(sym, '🎯 NAS BREAK coil-levels: SL $' + s.trade.slPrice.toFixed(2) + ' ($' + slDistDollars + ' risk) · TPs $' + s.trade.tp1Price.toFixed(2) + ' / $' + s.trade.tp2Price.toFixed(2) + ' / $' + s.trade.tp3Price.toFixed(2) + ' (2/4/8× coil range $' + coilRange.toFixed(2) + ')');
        }
        // If slOk is false (rare: coilSL on wrong side of price), keep the default ATR-based SL.
      }
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
  // FAST is NOT blocked during chop (changed 2026-05-08): a $5 burst in 3 min during a quiet
  // range can BE the moment chop ends. The new MACD-extremity gate (XAU ±1.0, BTC ±100,
  // NAS ±25) already prevents FAST from firing into exhausted moves — chop block was redundant.
  //
  // FAST DISABLED FOR XAU (trial, 2026-05-18): 4 resolved FAST signals on XAU last 3 days
  // produced 1 TP1→SL (~+$5) and 3 full SLs (~-$30) = net -$25. The detector keeps catching
  // micro-spike tops/bottoms on XAU which then immediately mean-revert. Multiple iterations
  // of RSI/MACD/chase-the-bottom gates couldn't fix the structural mismatch between FAST's
  // "$5 momentum continuation" design and XAU's mean-reverting micro-character. Trial period:
  // few days. If win rate on remaining detectors (BREAK / TREND / ATH / ATL / HI / LO / VREV
  // chop-blocked) doesn't improve, re-enable. FAST stays active for BTC (1/1 TP3 in sample)
  // and NAS100 (small sample, structurally different — futures momentum sustains better).
  if (isXAU) {
    // Skip FAST detector entirely for XAU. Other detectors below still evaluate.
  } else
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
        // Opposite-direction flip cooldown (added 2026-05-12): after FAST fires direction X,
        // block opposite-direction FAST for 30 min. Reversals are SQZ/ATH/ATL's job — FAST is
        // continuation-only. Without this, the bot flip-flopped (XAU 5/12: CALL→PUT→PUT→CALL→PUT
        // in 50 min during chop, losing on multiple direction flips). FAST same-direction
        // cooldown stays at 10min via the outer `s.fastMoveLastTs > 600000` check.
        const fmFlipCoolMs = 1800000; // 30 min
        if (s.fastLastDir && s.fastLastDir !== fmDir && (now2 - s.fastMoveLastTs < fmFlipCoolMs)) {
          const remainMin = Math.ceil((fmFlipCoolMs - (now2 - s.fastMoveLastTs)) / 60000);
          log(sym, '⚡ FAST ' + fmDir.toUpperCase() + ' BLOCKED — flip-cool: last FAST was ' + s.fastLastDir.toUpperCase() + ' ' + ((now2 - s.fastMoveLastTs) / 60000).toFixed(1) + 'min ago (need ' + remainMin + 'min more — opposite FAST is chop, let SQZ/ATH/ATL handle reversals)');
          return; // exit FAST detector entirely
        }
        // RSI gate (tightened 2026-05-11 after XAU amateur signals): block FAST PUTs at oversold
        // RSI and FAST CALLs at overbought RSI. Previous gate (RSI < 85 for PUT, > 15 for CALL)
        // allowed PUT entries at RSI 20-23 (selling the bottom — knife-catch) and CALL entries
        // at RSI 74+ (buying the top — chase). The new gate keeps PUTs to RSI 35-85 and CALLs
        // to RSI 15-65, giving real room for the move to develop in the signal's direction.
        // RSI gate: standard 35-85 PUT / 15-65 CALL.
        // Relaxation 2026-05-12 b: when a confirmed round-number break is in play (price has
        // already moved past the round + buffer), allow lower RSI floor for PUT / higher
        // ceiling for CALL — the break itself is the high-conviction signal, RSI naturally
        // lags into "oversold" territory during sharp moves through $50 levels.
        // Floor 35 → 25 for PUT (still blocks data-corruption-tier RSI < 25).
        // Ceiling 65 → 75 for CALL.
        const fmBreakConfirmed = isXAU && roundNumZone && (
          (fmDir === 'put' && price <= nearestRound - 0.50) ||
          (fmDir === 'call' && price >= nearestRound + 0.50)
        );
        // FAST PUT floor 35→37 + CALL ceiling 65→63 on 2026-05-14: both confirmed FAST PUT
        // losers had RSI at the floor (35.7, 36.0). The one confirmed FAST CALL loser had
        // RSI 55.6 — also at its floor. By symmetry, RSI close to overbought (63-65) is
        // the equivalent danger zone for CALL. Tightened bands: PUT 37-45, CALL 57-63.
        // VREV PUT keeps its 35 floor because VREV is designed for oversold reversals —
        // 5/14 03:39 VREV PUT @ RSI 37.8 won +$15.88 in 30min.
        //
        // ROUND-NUMBER-BREAK RELAXATION (tightened 2026-05-16): the relaxed bands were
        // 25-85 PUT / 15-65→25-75 CALL — far too wide. User flagged a FAST CALL firing at
        // RSI 73 (squarely overbought) because the round-break ceiling was 75. RSI 70+ is
        // reliable exhaustion regardless of whether a round-break is in progress; the
        // break itself doesn't immunize the entry against top-buying. Tightened the
        // relaxation: CALL ceiling 75→68 (still 5 above normal 63), PUT floor 25→30
        // (still 7 below normal 37). Symmetric and well clear of true overbought/oversold.
        const fmRsiFloorPut = fmBreakConfirmed ? 30 : 37;
        const fmRsiCeilCall = fmBreakConfirmed ? 68 : 63;
        // Winners-only confirmation ceilings. Both ends tightened on 2026-05-14:
        //   PUT band: 35-45 → 37-45 (floor up to escape oversold trap)
        //   CALL band: 55-65 → 57-63 (floor up + ceiling down — symmetric to PUT)
        // Both confirmed FAST PUT losers had RSI at the floor (35.7, 36.0). The confirmed
        // FAST CALL loser (5/14 01:30) had RSI 55.6 — also at the floor. The trap is the same
        // on both sides: "RSI is in the band but TOO close to the danger zone where the move
        // is exhausted." Tightening to the middle of each band keeps the sweet spot only.
        // The fmBreakConfirmed relaxation (round-number break in progress) still bypasses these.
        const fmRsiPutMax = fmBreakConfirmed ? 85 : 45;
        const fmRsiCallMin = fmBreakConfirmed ? 15 : 57;
        const fmRsiOk = (fmDir === 'put' && rsiV > fmRsiFloorPut && rsiV < fmRsiPutMax)
                     || (fmDir === 'call' && rsiV < fmRsiCeilCall && rsiV > fmRsiCallMin);
        if (!fmRsiOk) {
          const need = (fmDir === 'put')
                      ? fmRsiFloorPut + '-' + fmRsiPutMax + (fmBreakConfirmed ? ' (round-break relaxed)' : ' (winners-only: PUT needs RSI<45)')
                      : fmRsiCallMin + '-' + fmRsiCeilCall + (fmBreakConfirmed ? ' (round-break relaxed)' : ' (winners-only: CALL needs RSI>55)');
          log(sym, '⚡ FAST ' + fmDir.toUpperCase() + ' BLOCKED — RSI ' + rsiV.toFixed(1) + ' outside ' + need);
        }
        // ROC gate (tightened 2026-05-11): require meaningful directional momentum, not just
        // any non-zero tick. Previous threshold of 0 let -0.001% ROC pass. New: ±0.02% minimum.
        const fmRocOk = (fmDir === 'put' && roc3 < -0.02) || (fmDir === 'call' && roc3 > 0.02);
        if (!fmRocOk) {
          log(sym, '⚡ FAST ' + fmDir.toUpperCase() + ' BLOCKED — ROC ' + roc3.toFixed(3) + '% weak (need |ROC| ≥ 0.02%)');
        }
        // MACD gate now enforces DIRECTION (was only extremity). XAU 5/11 signal #6 fired a PUT
        // with macdL = +0.208 (positive, bullish momentum) — direction mismatch. Now PUTs
        // require macdL < 0 (bearish line) and CALLs require macdL > 0 (bullish line).
        // Extremity check is still active to prevent firing at exhaustion.
        // Per-instrument because MACD scale differs by ~100x across XAU/BTC/NAS100.
        const fmMacdExtreme = isXAU ? 1.0 : isBTC ? 100 : isNAS ? 25 : 1.0;
        const fmMacdDir = (fmDir === 'put' && macdL < 0) || (fmDir === 'call' && macdL > 0);
        const fmMacdNotExhausted = Math.abs(macdL) < fmMacdExtreme;
        // MACD-histogram FADING check (added 2026-05-12, ported from BREAK Filter 4).
        // Catches the "end-of-move exhaustion" pattern that has been FAST's worst failure mode.
        // Histogram = macdL − macdSignal. If histogram is shrinking in the signal direction
        // (macdAccel opposes direction with histogram still on the signal side), the move is
        // running out of steam — block the entry even if line direction is technically correct.
        // XAU 5/12 #11 (FAST PUT at $4681 → price rallied $13) and #9/#12 (FAST CALLs into
        // intraday tops → reversed) all had fading histograms by the time FAST fired.
        const fmMacdFading = (fmDir === 'call' && macdAccel < 0 && macdHist > 0)
                          || (fmDir === 'put'  && macdAccel > 0 && macdHist < 0);
        const fmMacdOk = fmMacdDir && fmMacdNotExhausted && !fmMacdFading;
        if (!fmMacdOk) {
          let reason;
          if (!fmMacdDir) reason = 'wrong direction (MACD ' + macdL.toFixed(3) + ' opposite of ' + fmDir + ')';
          else if (!fmMacdNotExhausted) reason = 'beyond ±' + fmMacdExtreme + ' (exhausted)';
          else reason = 'histogram fading (hist=' + macdHist.toFixed(3) + ' accel=' + macdAccel.toFixed(3) + ', momentum running out)';
          log(sym, '⚡ FAST ' + fmDir.toUpperCase() + ' BLOCKED — MACD ' + reason);
        }
        // Same-direction price-gap guard (added 2026-05-11, raised 2026-05-11 b after another
        // falling-knife cluster slipped through by $0.06). After a FAST signal fires in
        // direction D at price P, block the next same-direction FAST until price has moved
        // a meaningful gap away from P. Was $5/$300/$40 — raised to $7/$450/$60 because the
        // earlier setting was just one "FAST move" worth of distance, allowing stacking at
        // virtually the same level.
        const fmGap = isXAU ? 7 : isBTC ? 450 : isNAS ? 60 : 7;
        let fmGapOk = true;
        // FIX 2026-05-15: time-decay the same-direction anchor after 4h. Without this, an
        // overnight TP3 winner (e.g. 01:10 PUT at $4592 settling to $4532) anchors morning
        // entries 6-8h later — blocking every fresh PUT in a new $27 local leg because the
        // gap is measured vs a price the market has already digested. Within a single session
        // the gap protection is the right behavior (prevent stacking); across sessions it's
        // not. 4h = ample buffer for a single-leg play to fully resolve.
        const fmGapAgeMs = 4 * 3600 * 1000;
        const fmGapAnchorFresh = s.lastSameDirTs > 0 && (Date.now() - s.lastSameDirTs) < fmGapAgeMs;
        if (s.lastSameDir === fmDir && s.lastSameDirPrice > 0 && fmGapAnchorFresh) {
          if (fmDir === 'put' && price > s.lastSameDirPrice - fmGap) fmGapOk = false;
          if (fmDir === 'call' && price < s.lastSameDirPrice + fmGap) fmGapOk = false;
          if (!fmGapOk) {
            log(sym, '⚡ FAST ' + fmDir.toUpperCase() + ' BLOCKED — same-dir price gap not met ($' + price.toFixed(2) + ' vs last $' + s.lastSameDirPrice.toFixed(2) + ', need $' + fmGap + ' move)');
          }
        } else if (s.lastSameDir === fmDir && s.lastSameDirPrice > 0 && !fmGapAnchorFresh) {
          const ageH = ((Date.now() - s.lastSameDirTs) / 3600000).toFixed(1);
          log(sym, '↪️ FAST ' + fmDir.toUpperCase() + ' same-dir gap BYPASSED — anchor $' + s.lastSameDirPrice.toFixed(2) + ' is ' + ageH + 'h old (>4h), allowing fresh session leg.');
        }
        // "Room to grow/sell" exhaustion gate (added 2026-05-12 after user analysis showed FAST
        // consistently fires AT THE END of the directional leg, right before mean reversion).
        // Use 1-hour candle data (12× 5-min closed candles) to find recent range. If price is
        // approaching the 1h high (for CALL) or 1h low (for PUT) FROM THE INTERIOR — i.e., it
        // hasn't broken through yet — the move is likely exhausted at support/resistance. Block.
        // Per-instrument exhaustion buffer: XAU $2, BTC $100, NAS $10.
        //
        // FIX 2026-05-13: caught 5/13 ~19:30-20:30 broker time, $10 downtrend with NO PUT
        // signals because the gate blocked every tick. Original check `price < lo1h + buffer`
        // fired even when price had broken WELL BELOW the prior closed-candle low (i.e., a
        // fresh new-low continuation, not an approach to support). New check: only block PUT
        // when price is ABOVE the closed lo1h (approaching it from above). If price < lo1h,
        // we've already broken the support → continuation trade, allow. Symmetric for CALL.
        // Use closed candles only (NOT in-progress) so a fresh breakdown lifts the gate
        // correctly — adding in-progress would re-fire the gate with the live low.
        let fmRoomOk = true;
        const fmRoomBuffer = isXAU ? 2.0 : isBTC ? 100 : isNAS ? 10 : 2.0;
        if (s.atrCandles && s.atrCandles.length >= 12) {
          const last12 = s.atrCandles.slice(-12);
          const hi1h = Math.max(...last12.map(c => c.h));
          const lo1h = Math.min(...last12.map(c => c.l));
          if (fmDir === 'call' && price < hi1h && price > hi1h - fmRoomBuffer) {
            fmRoomOk = false;
            log(sym, '⚡ FAST CALL BLOCKED — no room to grow: $' + price.toFixed(2) + ' within $' + fmRoomBuffer + ' of 1h high $' + hi1h.toFixed(2) + ' (move exhausted)');
          }
          if (fmDir === 'put' && price > lo1h && price < lo1h + fmRoomBuffer) {
            fmRoomOk = false;
            log(sym, '⚡ FAST PUT BLOCKED — no room to sell: $' + price.toFixed(2) + ' within $' + fmRoomBuffer + ' of 1h low $' + lo1h.toFixed(2) + ' (move exhausted)');
          }
        }
        // Round-number resistance/support gate (added 2026-05-12, mirrors BREAK filter 8).
        // XAU $50 levels are well-known psychological walls. Block FAST CALL approaching round
        // from below, FAST PUT approaching round from above. Wait for break confirmation.
        let fmRoundOk = true;
        if (isXAU && roundNumZone) {
          const fmBreakBuffer = 0.50;
          // FIX 2026-05-13 (audit finding MEDIUM-3): same directional-inversion bug as VREV.
          // Original `price < nearestRound + fmBreakBuffer` fired even when price had cleared
          // the round going up (e.g. price=$4700.30 > $4700, but $4700.30 < $4700.50 still
          // TRUE → block), AND the log message said "approaching from below" which is wrong.
          // Fix: only block when price is on the WRONG SIDE of the round. Once cleared, allow.
          if (fmDir === 'call' && price < nearestRound) {
            fmRoundOk = false;
            log(sym, '⚡ FAST CALL BLOCKED — $' + price.toFixed(2) + ' below $' + nearestRound + ' resistance (wait for cross)');
          }
          if (fmDir === 'put' && price > nearestRound) {
            fmRoundOk = false;
            log(sym, '⚡ FAST PUT BLOCKED — $' + price.toFixed(2) + ' above $' + nearestRound + ' support (wait for cross)');
          }
        }

        // FAST "chase-the-bottom" guard (added 2026-05-15) — XAU only for now.
        // FAST detector fires AFTER a sharp move, which puts entries at the LOCAL EXTREME of
        // the move — exactly when a $5-10 bounce/dip is most likely. If a same-direction
        // signal already hit TP or SL in the last 30 min, the chop pattern is established
        // and FAST is chasing the local low/high. Block to avoid stair-step SL losses.
        // Caught 5/15 05:16 FAST PUT (SL'd 20s after 05:07 VREV TP1) and 5/15 05:50 FAST PUT
        // (SL'd 26 min after 05:16 SL). Both had conv 6 HIGH + STRUCT, no other gate blocked.
        let fmRecentTpSlOk = true;
        if (isXAU) {
          const fmRecentTpSlMs = 1800000; // 30 minutes
          const tFm = Date.now();
          for (let hi = signalHistory.length - 1; hi >= 0; hi--) {
            const h = signalHistory[hi];
            if (!h || h.symbol !== sym || h.type !== fmDir) continue;
            const o = h.outcomes;
            if (!o) continue;
            const tpTs = o.tp1HitTs || o.tp2HitTs || o.tp3HitTs || 0;
            const slTs = o.slHitTs || 0;
            const lastTs = Math.max(tpTs, slTs);
            if (lastTs === 0) continue;
            if ((tFm - lastTs) > fmRecentTpSlMs) break; // sorted oldest→newest, this is too old, stop
            // Found a same-direction TP/SL within 30 min
            fmRecentTpSlOk = false;
            const event = (o.slHit && (!o.tp1Hit || slTs > tpTs)) ? 'SL'
                        : o.tp3Hit ? 'TP3'
                        : o.tp2Hit ? 'TP2'
                        : 'TP1';
            const ageMin = Math.round((tFm - lastTs) / 60000);
            log(sym, '⚡ FAST ' + fmDir.toUpperCase() + ' BLOCKED — same-direction ' + event + ' hit ' + ageMin + 'min ago (FAST chase-the-bottom guard, 30-min cooldown). Local extreme likely, wait for clearer setup.');
            break;
          }
        }

        if (fmRecentTpSlOk && fmRsiOk && fmRocOk && fmMacdOk && fmGapOk && fmRoomOk && fmRoundOk && flipCoolFor(fmDir) && (winProtectDir === null || winProtectDir === fmDir)) {
          s.fastMoveLastTs = now2;
          s.fastLastDir = fmDir; // for 30-min opposite-direction flip-cool
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

  // ===== RSI DIVERGENCE DETECTOR (MT5 instruments: XAU + BTC + NAS100) =====
  // Anticipatory reversal — fires BEFORE price has fully reversed. Maintains a state machine
  // that tracks each price swing (up-leg or down-leg) and confirms a swing extreme when price
  // reverses by ≥ divConfirmGap from the running extreme. On each confirmed extreme, checks
  // against the previous same-type extreme:
  //   Bearish divergence  →  PUT  →  price_new > price_old  AND  rsi_new < rsi_old − divRsiGap
  //   Bullish divergence  →  CALL →  price_new < price_old  AND  rsi_new > rsi_old + divRsiGap
  // Divergence signals require ≥ 2 confirmed extremes of the same type to compare.
  if (isMT5 && rsiV > 0 && rsiV < 100) {
    // Per-instrument swing-confirmation gap — the minimum price reversal required to call a
    // swing "done". Smaller values fire too often on noise; larger values miss real reversals.
    const divConfirmGap = isXAU ? 2 : isBTC ? 100 : isNAS ? 20 : 2;
    const divRsiGap = 4;            // min RSI delta between extremes to call it divergence (filters noise)
    const divMinDuration = 60000;   // swing must last ≥ 60s to count (no tick-spike triggers)
    const divCooldownMs = 1800000;  // 30 min between divergence signals (don't spam)
    const divMaxExtremesAge = 1800000; // peaks/troughs older than 30 min are stale — drop them

    // Initialize swing state if first valid tick
    if (s.divSwingDir === null) {
      s.divSwingDir = 'up';
      s.divSwingPrice = price;
      s.divSwingRsi = rsiV;
      s.divSwingTs = now2;
    }
    // === Swing state machine ===
    if (s.divSwingDir === 'up') {
      // Trough-invalidation guard (added 2026-05-11 d): if we recently confirmed a trough
      // but price has now broken BELOW it by confirmGap, the trough was fake — pop it from
      // history and flip back to down-tracking. Prevents the state machine from being stuck
      // when a "trough" was actually mid-descent.
      if (s.divTroughs.length > 0 && price < s.divTroughs[s.divTroughs.length - 1].price - divConfirmGap) {
        const fakeTrough = s.divTroughs.pop();
        log(sym, '🔄 DIV trough invalidated — price $' + price.toFixed(2) + ' broke below confirmed trough $' + fakeTrough.price.toFixed(2) + ' by $' + divConfirmGap + ', re-tracking');
        s.divSwingDir = 'down';
        s.divSwingPrice = price;
        s.divSwingRsi = rsiV;
        s.divSwingTs = now2;
        return;
      }
      // Tracking a potential peak — update running extreme as price rises
      if (price > s.divSwingPrice) {
        s.divSwingPrice = price;
        s.divSwingRsi = rsiV;
        s.divSwingTs = now2;
      }
      // Confirm peak when price has reversed ≥ confirmGap from the high AND swing lasted ≥ minDuration
      else if (s.divSwingPrice - price >= divConfirmGap && now2 - s.divSwingTs >= divMinDuration) {
        // Push the confirmed peak — keep last 4 for divergence comparison
        s.divPeaks.push({ ts: s.divSwingTs, price: s.divSwingPrice, rsi: s.divSwingRsi });
        if (s.divPeaks.length > 4) s.divPeaks.shift();
        // Bearish divergence check: new peak HIGHER price + LOWER RSI than previous peak.
        // Tightened 2026-05-11 d after first live DIV PUT failed: previous threshold required
        // only $1+ between peaks (confirmGap * 0.5) — too lenient, fires on RSI noise.
        // Now requires full divConfirmGap ($2 for XAU) between peaks PLUS macdHist confirmation
        // (histogram must be negative, meaning momentum is actually weakening, not just RSI).
        // Added 2026-05-11 e: current-RSI floor (>= 35) AND same-direction price gap. Today's
        // failed DIV PUT fired at RSI 32.5 — already oversold — only $1.80 below a previous
        // PUT entry. Both gates would have caught it independently.
        if (s.divPeaks.length >= 2 && now2 - s.divLastFireTs > divCooldownMs) {
          const cur = s.divPeaks[s.divPeaks.length - 1];
          const prev = s.divPeaks[s.divPeaks.length - 2];
          const priceHigherHigh = cur.price > prev.price + divConfirmGap;       // meaningfully higher (was * 0.5)
          const rsiLowerHigh = cur.rsi < prev.rsi - divRsiGap;                  // RSI failing to confirm
          const peakFresh = now2 - prev.ts < divMaxExtremesAge;
          const macdConfirms = macdHist < 0;                                    // momentum already turning bearish
          const divRsiFloor = rsiV >= 35;                                       // not already oversold at entry
          // Same-direction gap: block if previous PUT (any detector) within divSameDirGap of current price.
          // Per-instrument: $5 XAU, $250 BTC, $25 NAS — proportional to instrument's typical move size.
          const divSameDirGap = isXAU ? 5 : isBTC ? 250 : isNAS ? 25 : 5;
          const divGapOk = !(s.lastSameDir === 'put' && s.lastSameDirPrice > 0 && Math.abs(price - s.lastSameDirPrice) < divSameDirGap);
          if (priceHigherHigh && rsiLowerHigh && peakFresh && macdConfirms && divRsiFloor && divGapOk && flipCoolFor('put') && (winProtectDir === null || winProtectDir === 'put')) {
            s.divLastFireTs = now2;
            s.dailySignalCount++;
            if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
            s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
            s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
            s.nP++; s.lastAT = 'put';
            const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇DIV', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
            if (!enrichSig(sig)) {
              // Conviction blocked — keep peak in history but reset signal counters
            } else {
              s.signals.push(sig); logSignal(sym, sig);
              if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
              log(sym, '🔻 RSI BEARISH DIVERGENCE — price $' + cur.price.toFixed(2) + ' > $' + prev.price.toFixed(2) + ' but RSI ' + cur.rsi.toFixed(1) + ' < ' + prev.rsi.toFixed(1) + ' [#' + s.dailySignalCount + ']');
              sendPush('🔻 ' + sym + ' BEARISH DIV PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · RSI ' + cur.rsi.toFixed(1) + ' (prev peak ' + prev.rsi.toFixed(1) + ')', 'signal');
              s.trade = attachOTE(buildCfdTrade('put', price, atrVal, sym), s, sym, 'put');
              if (s.trade.oteLimit) log(sym, '🎯 OTE PUT limit set @ $' + s.trade.oteLimit.toFixed(2) + ' (impulse $' + s.trade.oteImpulseLo.toFixed(2) + '→$' + s.trade.oteImpulseHi.toFixed(2) + ', expires in 3min)');
              // Flip swing direction; let the next leg track the next trough
              s.divSwingDir = 'down'; s.divSwingPrice = price; s.divSwingRsi = rsiV; s.divSwingTs = now2;
              return;
            }
          }
        }
        // No divergence (or already-cooled-down) — just flip swing direction and continue tracking
        s.divSwingDir = 'down';
        s.divSwingPrice = price;
        s.divSwingRsi = rsiV;
        s.divSwingTs = now2;
      }
    } else { // divSwingDir === 'down'
      // Peak-invalidation guard (added 2026-05-11 d): if we recently confirmed a peak but
      // price has now broken ABOVE it by confirmGap, the peak was fake (premature reversal
      // detection). Pop it from history and flip back to up-tracking to find the real peak.
      // CRITICAL for cases like today's failed DIV PUT — if the bot "confirms" a peak
      // and fires PUT, but price keeps rallying, this prevents firing more PUTs into the
      // continued rally AND lets the state machine find the real top.
      if (s.divPeaks.length > 0 && price > s.divPeaks[s.divPeaks.length - 1].price + divConfirmGap) {
        const fakePeak = s.divPeaks.pop();
        log(sym, '🔄 DIV peak invalidated — price $' + price.toFixed(2) + ' broke above confirmed peak $' + fakePeak.price.toFixed(2) + ' by $' + divConfirmGap + ', re-tracking');
        s.divSwingDir = 'up';
        s.divSwingPrice = price;
        s.divSwingRsi = rsiV;
        s.divSwingTs = now2;
        return;
      }
      // Tracking a potential trough — update running extreme as price falls
      if (price < s.divSwingPrice) {
        s.divSwingPrice = price;
        s.divSwingRsi = rsiV;
        s.divSwingTs = now2;
      }
      // Confirm trough when price has reversed ≥ confirmGap from the low AND swing lasted ≥ minDuration
      else if (price - s.divSwingPrice >= divConfirmGap && now2 - s.divSwingTs >= divMinDuration) {
        s.divTroughs.push({ ts: s.divSwingTs, price: s.divSwingPrice, rsi: s.divSwingRsi });
        if (s.divTroughs.length > 4) s.divTroughs.shift();
        // Bullish divergence check: new trough LOWER price + HIGHER RSI than previous trough.
        // Same tightening as bearish — full divConfirmGap between troughs + macdHist confirmation.
        // Added 2026-05-11 e: current-RSI ceiling (<= 65) AND same-direction price gap (symmetric
        // to bearish DIV — same protection against overbought entries and stacking same-direction
        // signals at near-identical prices).
        if (s.divTroughs.length >= 2 && now2 - s.divLastFireTs > divCooldownMs) {
          const cur = s.divTroughs[s.divTroughs.length - 1];
          const prev = s.divTroughs[s.divTroughs.length - 2];
          const priceLowerLow = cur.price < prev.price - divConfirmGap;       // meaningfully lower (was * 0.5)
          const rsiHigherLow = cur.rsi > prev.rsi + divRsiGap;                // RSI refusing to confirm
          const troughFresh = now2 - prev.ts < divMaxExtremesAge;
          const macdConfirms = macdHist > 0;                                  // momentum already turning bullish
          const divRsiCeiling = rsiV <= 65;                                   // not already overbought at entry
          const divSameDirGap = isXAU ? 5 : isBTC ? 250 : isNAS ? 25 : 5;
          const divGapOk = !(s.lastSameDir === 'call' && s.lastSameDirPrice > 0 && Math.abs(price - s.lastSameDirPrice) < divSameDirGap);
          if (priceLowerLow && rsiHigherLow && troughFresh && macdConfirms && divRsiCeiling && divGapOk && flipCoolFor('call') && (winProtectDir === null || winProtectDir === 'call')) {
            s.divLastFireTs = now2;
            s.dailySignalCount++;
            if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
            s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
            s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
            s.nC++; s.lastAT = 'call';
            const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆DIV', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
            if (!enrichSig(sig)) {
              // Conviction blocked — keep trough in history but reset signal counters
            } else {
              s.signals.push(sig); logSignal(sym, sig);
              if (isMT5) attachTpSl(sig, 'call', price, atrVal, sym);
              log(sym, '🚀 RSI BULLISH DIVERGENCE — price $' + cur.price.toFixed(2) + ' < $' + prev.price.toFixed(2) + ' but RSI ' + cur.rsi.toFixed(1) + ' > ' + prev.rsi.toFixed(1) + ' [#' + s.dailySignalCount + ']');
              sendPush('🚀 ' + sym + ' BULLISH DIV CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · RSI ' + cur.rsi.toFixed(1) + ' (prev trough ' + prev.rsi.toFixed(1) + ')', 'signal');
              s.trade = attachOTE(buildCfdTrade('call', price, atrVal, sym), s, sym, 'call');
              if (s.trade.oteLimit) log(sym, '🎯 OTE CALL limit set @ $' + s.trade.oteLimit.toFixed(2) + ' (impulse $' + s.trade.oteImpulseHi.toFixed(2) + '→$' + s.trade.oteImpulseLo.toFixed(2) + ', expires in 3min)');
              s.divSwingDir = 'up'; s.divSwingPrice = price; s.divSwingRsi = rsiV; s.divSwingTs = now2;
              return;
            }
          }
        }
        s.divSwingDir = 'up';
        s.divSwingPrice = price;
        s.divSwingRsi = rsiV;
        s.divSwingTs = now2;
      }
    }
  }

  // ===== LIQUIDITY SWEEP / STOP-HUNT DETECTOR (MT5: XAU + BTC + NAS100) =====
  // Anti-manipulation detector — catches the classic stop-hunt footprint where a whale
  // pushes price just above (or below) a known stop cluster (recent range high/low), then
  // immediately reverses. Fires a COUNTER-direction signal the moment price returns through
  // the swept level. By design, fires EARLIER than ATH/ATL — at the wick, not after the dump.
  //
  // State machine:
  //   1. Track rangeHigh / rangeLow from vrevSnaps over the last 20 min (the stop-cluster zones)
  //   2. If price exceeds rangeHigh by ≥ sweepThreshold → start 5-min "watcher" with anchor locked
  //   3. While watcher active:
  //      a. price returns BELOW anchor → SWEEP CONFIRMED, fire PUT (counter the wick)
  //      b. 5 min elapse with price still above anchor → real breakout, clear watcher silently
  //   4. Symmetric for sweep-low → CALL
  if (isMT5 && s.vrevSnaps.length >= 50) {
    const sweepThreshold = isXAU ? 1.5 : isBTC ? 80 : isNAS ? 15 : 1.5;
    const sweepLookbackMs = 1200000;  // 20 min — vrevSnaps' full window
    const sweepWatchMs = 300000;       // 5 min — sweep must fail fast (real reversals are quick)
    const sweepCooldownMs = 1800000;   // 30 min between sweep signals

    const sweepLookbackStart = now2 - sweepLookbackMs;
    const sweepRelevantSnaps = s.vrevSnaps.filter(sn => sn.ts >= sweepLookbackStart);
    if (sweepRelevantSnaps.length >= 20) {
      const sweepRangeHigh = Math.max(...sweepRelevantSnaps.map(sn => sn.p));
      const sweepRangeLow = Math.min(...sweepRelevantSnaps.map(sn => sn.p));

      // === UP-SWEEP DETECTION (wicked above range high → expect dump) ===
      if (s.sweepWatchUpStart === 0) {
        // No active watcher — check for new sweep candidate
        if (price > sweepRangeHigh + sweepThreshold && now2 - s.sweepLastFireTs > sweepCooldownMs) {
          s.sweepWatchUpStart = now2;
          s.sweepWatchUpHigh = price;
          s.sweepWatchUpAnchor = sweepRangeHigh; // LOCK the anchor — don't track it after this
          log(sym, '👀 SWEEP UP candidate — price $' + price.toFixed(2) + ' exceeded recent high $' + sweepRangeHigh.toFixed(2) + ' by $' + (price - sweepRangeHigh).toFixed(2) + ', watching 5min for return below');
        }
      } else {
        // Active up-watcher
        if (price > s.sweepWatchUpHigh) s.sweepWatchUpHigh = price;
        if (now2 - s.sweepWatchUpStart > sweepWatchMs) {
          // Window expired — real breakout, clear watcher silently
          log(sym, '🟢 SWEEP UP failed — price held above swept level $' + s.sweepWatchUpAnchor.toFixed(2) + ' for 5min, treating as real breakout');
          s.sweepWatchUpStart = 0;
        } else if (price < s.sweepWatchUpAnchor && flipCoolFor('put') && (winProtectDir === null || winProtectDir === 'put')) {
          // SWEEP CONFIRMED — price wicked above and is now back below the swept level
          s.sweepLastFireTs = now2;
          s.dailySignalCount++;
          if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
          s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
          s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
          s.nP++; s.lastAT = 'put';
          const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇SWEEP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) {
            s.sweepWatchUpStart = 0;
          } else {
            s.signals.push(sig); logSignal(sym, sig);
            attachTpSl(sig, 'put', price, atrVal, sym);
            log(sym, '🪤 LIQUIDITY SWEEP UP CONFIRMED — wick to $' + s.sweepWatchUpHigh.toFixed(2) + ' then back to $' + price.toFixed(2) + ' (below swept $' + s.sweepWatchUpAnchor.toFixed(2) + ') — PUT [#' + s.dailySignalCount + ']');
            sendPush('🪤 ' + sym + ' SWEEP PUT #' + s.dailySignalCount, 'Wicked $' + s.sweepWatchUpHigh.toFixed(2) + ', back to $' + price.toFixed(2), 'signal');
            s.trade = buildCfdTrade('put', price, atrVal, sym);
            s.sweepWatchUpStart = 0;
            return;
          }
        }
      }

      // === DOWN-SWEEP DETECTION (wicked below range low → expect rally) ===
      if (s.sweepWatchDownStart === 0) {
        if (price < sweepRangeLow - sweepThreshold && now2 - s.sweepLastFireTs > sweepCooldownMs) {
          s.sweepWatchDownStart = now2;
          s.sweepWatchDownLow = price;
          s.sweepWatchDownAnchor = sweepRangeLow;
          log(sym, '👀 SWEEP DOWN candidate — price $' + price.toFixed(2) + ' broke recent low $' + sweepRangeLow.toFixed(2) + ' by $' + (sweepRangeLow - price).toFixed(2) + ', watching 5min for return above');
        }
      } else {
        if (price < s.sweepWatchDownLow) s.sweepWatchDownLow = price;
        if (now2 - s.sweepWatchDownStart > sweepWatchMs) {
          log(sym, '🔴 SWEEP DOWN failed — price held below swept level $' + s.sweepWatchDownAnchor.toFixed(2) + ' for 5min, treating as real breakdown');
          s.sweepWatchDownStart = 0;
        } else if (price > s.sweepWatchDownAnchor && flipCoolFor('call') && (winProtectDir === null || winProtectDir === 'call')) {
          s.sweepLastFireTs = now2;
          s.dailySignalCount++;
          if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
          s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
          s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
          s.nC++; s.lastAT = 'call';
          const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆SWEEP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) {
            s.sweepWatchDownStart = 0;
          } else {
            s.signals.push(sig); logSignal(sym, sig);
            attachTpSl(sig, 'call', price, atrVal, sym);
            log(sym, '🪤 LIQUIDITY SWEEP DOWN CONFIRMED — wick to $' + s.sweepWatchDownLow.toFixed(2) + ' then back to $' + price.toFixed(2) + ' (above swept $' + s.sweepWatchDownAnchor.toFixed(2) + ') — CALL [#' + s.dailySignalCount + ']');
            sendPush('🪤 ' + sym + ' SWEEP CALL #' + s.dailySignalCount, 'Wicked $' + s.sweepWatchDownLow.toFixed(2) + ', back to $' + price.toFixed(2), 'signal');
            s.trade = buildCfdTrade('call', price, atrVal, sym);
            s.sweepWatchDownStart = 0;
            return;
          }
        }
      }
    }
  }

  // ===== SQUEEZE RELEASE DETECTOR (MT5: XAU + BTC + NAS100) =====
  // Anticipatory compression-break detector. When price has been confined to an unusually
  // tight 15-min range (volatility compression / "coiled spring") and price breaks out of
  // that range by a meaningful amount, fire a directional signal at the BREAK — before
  // FAST/BREAK/etc. confirm the move via their wider-range thresholds.
  //
  // Real-world case (XAU 2026-05-11 15:07-15:19): price compressed in $4667-$4670 range
  // for 8 min ($3.60 range — well below $5 compression threshold for XAU), then exploded
  // $14 in 4 min. Existing detectors missed it — FAST required $5 move that took too long
  // to develop, BREAK was blocked by its 1-hour-range gate (range was too tight), V-REV
  // needed $8 range, DIV/SWEEP patterns never formed. SQZ would fire ⬆SQZ CALL the moment
  // price exceeded $4670 + $1 = $4671, capturing ~$12 of the move.
  // Indicator-readiness guard added 2026-05-11 f after Railway logged
  // "processTicks BTC error: Cannot read properties of undefined (reading 'toFixed')" —
  // SQZ block-log tried to format macdHist/rsiV/roc3 before they were computed for early ticks.
  if (isMT5 && s.vrevSnaps.length >= 100 && typeof rsiV === 'number' && typeof roc3 === 'number' && typeof macdHist === 'number') {
    // Per-instrument compression thresholds — max range that qualifies as "tight enough"
    const sqzMaxRange = isXAU ? 5 : isBTC ? 250 : isNAS ? 50 : 5;
    // Break trigger — price must exceed compression edge by this much to count as a break
    const sqzBreakTrigger = isXAU ? 1.0 : isBTC ? 50 : isNAS ? 10 : 1.0;
    const sqzLookbackMs = 900000;   // 15-min compression window
    const sqzCooldownMs = 1200000;  // 20-min cooldown between SQZ signals

    if (now2 - s.sqzLastFireTs > sqzCooldownMs) {
      const sqzLookbackStart = now2 - sqzLookbackMs;
      const sqzSnaps = s.vrevSnaps.filter(sn => sn.ts >= sqzLookbackStart);
      // Need at least 30 samples (~1.5 min of 3s snapshots) for meaningful compression measurement
      if (sqzSnaps.length >= 30) {
        const sqzHigh = Math.max(...sqzSnaps.map(sn => sn.p));
        const sqzLow = Math.min(...sqzSnaps.map(sn => sn.p));
        const sqzRange = sqzHigh - sqzLow;

        // Only proceed if the 15-min window IS compressed
        if (sqzRange <= sqzMaxRange) {
          // === UP-BREAK from compression ===
          if (price > sqzHigh + sqzBreakTrigger) {
            // Quality gates:
            //   - RSI in 35-65 (anticipatory zone — not entering at exhaustion)
            //   - ROC confirms direction (real acceleration, not noise)
            //   - macdHist agrees with direction (histogram leads line for early reversals)
            const sqzRsiOk = rsiV >= 35 && rsiV <= 65;
            const sqzRocOk = roc3 > 0.02;
            const sqzMacdOk = macdHist > 0;
            if (sqzRsiOk && sqzRocOk && sqzMacdOk && flipCoolFor('call') && (winProtectDir === null || winProtectDir === 'call')) {
              s.sqzLastFireTs = now2;
              s.dailySignalCount++;
              if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
              s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
              s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
              s.nC++; s.lastAT = 'call';
              const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆SQZ', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
              if (enrichSig(sig)) {
                s.signals.push(sig); logSignal(sym, sig);
                attachTpSl(sig, 'call', price, atrVal, sym);
                log(sym, '🎯 SQUEEZE BREAKOUT CALL — 15-min range $' + sqzRange.toFixed(2) + ' (≤ $' + sqzMaxRange + ') · broke above $' + sqzHigh.toFixed(2) + ' to $' + price.toFixed(2) + ' [#' + s.dailySignalCount + ']');
                sendPush('🎯 ' + sym + ' SQUEEZE CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · broke $' + sqzHigh.toFixed(2) + ' from $' + sqzRange.toFixed(2) + ' range', 'signal');
                s.trade = buildCfdTrade('call', price, atrVal, sym);
                return;
              }
            } else {
              // Log why a candidate squeeze break didn't fire — useful for tuning
              const reasons = [];
              if (!sqzRsiOk) reasons.push('RSI ' + rsiV.toFixed(1) + ' outside 35-65');
              if (!sqzRocOk) reasons.push('ROC ' + roc3.toFixed(3) + '% < 0.02%');
              if (!sqzMacdOk) reasons.push('macdHist ' + macdHist.toFixed(3) + ' ≤ 0');
              if (reasons.length > 0 && now2 - (s.sqzBlockLogTs || 0) > 60000) {
                log(sym, '🎯 SQZ UP candidate blocked — ' + reasons.join(', '));
                s.sqzBlockLogTs = now2;
              }
            }
          }
          // === DOWN-BREAK from compression ===
          else if (price < sqzLow - sqzBreakTrigger) {
            const sqzRsiOk = rsiV >= 35 && rsiV <= 65;
            const sqzRocOk = roc3 < -0.02;
            const sqzMacdOk = macdHist < 0;
            if (sqzRsiOk && sqzRocOk && sqzMacdOk && flipCoolFor('put') && (winProtectDir === null || winProtectDir === 'put')) {
              s.sqzLastFireTs = now2;
              s.dailySignalCount++;
              if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
              s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
              s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
              s.nP++; s.lastAT = 'put';
              const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇SQZ', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
              if (enrichSig(sig)) {
                s.signals.push(sig); logSignal(sym, sig);
                attachTpSl(sig, 'put', price, atrVal, sym);
                log(sym, '🎯 SQUEEZE BREAKDOWN PUT — 15-min range $' + sqzRange.toFixed(2) + ' (≤ $' + sqzMaxRange + ') · broke below $' + sqzLow.toFixed(2) + ' to $' + price.toFixed(2) + ' [#' + s.dailySignalCount + ']');
                sendPush('🎯 ' + sym + ' SQUEEZE PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · broke $' + sqzLow.toFixed(2) + ' from $' + sqzRange.toFixed(2) + ' range', 'signal');
                s.trade = buildCfdTrade('put', price, atrVal, sym);
                return;
              }
            } else {
              const reasons = [];
              if (!sqzRsiOk) reasons.push('RSI ' + rsiV.toFixed(1) + ' outside 35-65');
              if (!sqzRocOk) reasons.push('ROC ' + roc3.toFixed(3) + '% > -0.02%');
              if (!sqzMacdOk) reasons.push('macdHist ' + macdHist.toFixed(3) + ' ≥ 0');
              if (reasons.length > 0 && now2 - (s.sqzBlockLogTs || 0) > 60000) {
                log(sym, '🎯 SQZ DOWN candidate blocked — ' + reasons.join(', '));
                s.sqzBlockLogTs = now2;
              }
            }
          }
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
  //
  // CHOP BLOCK (added 2026-05-18 after 5/17-18 XAU audit: 4 of 6 losers were V-REV during
  // a clearly choppy XAU range): V-REV is RE-BLOCKED during chopActive. The earlier removal
  // (task #26) reasoned "V-REV is designed for the sharp drop+bounce pattern that often
  // happens during chop." But empirically that's wrong — in chop, every wobble LOOKS like a
  // sharp drop+bounce but the bounce is just the next wobble, not a real reversal. V-REV
  // works in DIRECTIONAL markets where a deep washout actually reverses. In chop, V-REV
  // fires both directions repeatedly (catalogued tonight 22:07 PUT + 22:37 CALL both SL'd).
  // Cooldown raised 2026-05-11 b: 10 → 15 min. Earlier 10-min was too short — two VREVs
  // fired 10 min apart at $4726.51 and $4726.97 (same direction, virtually same price).
  // VREV-specific opposite-direction cooldown — stricter than the global 10-min flipCool.
  // Added 2026-05-13 after CSV 5/12 row 6: VREV PUT @ $4691.85 fired exactly 13 min after a
  // BREAK CALL @ $4689.53 that had already hit TP1 (trend was clearly UP). VREV PUT went to SL.
  // VREV is a counter-trend fade — needs much more room than 10 min from a fresh opposite-side
  // signal. 25 min lets the prior signal's TP/SL fully resolve before VREV is allowed to fade it.
  const VREV_FLIP_COOLDOWN_MS = 1500000; // 25 minutes
  const vrevFlipOk = (dir) => !s.lastSignalDir || s.lastSignalDir === dir || (now2 - s.lastNTs > VREV_FLIP_COOLDOWN_MS);

  // VREV now runs for XAU AND BTC (BTC added 2026-05-13 after 5/12 V-bottom miss at $79,800
  // → $80,700 in 2hr — a $900 V that nothing caught because BTC had no V-REV detector).
  // All thresholds are scaled by symbol — BTC values are ~40× XAU.
  const vrevEnabled = isXAU || isBTC;

  // Chop block (2026-05-18): if chopActive, suppress V-REV but continue to other detectors
  // below (ATH/ATL, MFLIP, TREND RIDE still need to evaluate). Throttled log every 10 min so
  // we don't spam each tick.
  const vrevChopBlocked = vrevEnabled && s.chopActive;
  if (vrevChopBlocked && now2 - (s.vrevChopBlockLogTs || 0) > 600000) {
    log(sym, '🌊 V-REV suppressed — chop mode active (V-REV fires too often in chop, each wobble looks like a reversal).');
    s.vrevChopBlockLogTs = now2;
  }

  if (vrevEnabled && !vrevChopBlocked && s.vrevSnaps.length >= 60 && cool && (now2 - s.vrevLastTs > 900000)) {
    // Find the high and low in the last 15 min of snapshots
    const lookback = s.vrevSnaps.filter(sn => sn.ts > now2 - 900000); // 15 min
    if (lookback.length >= 30) {
      const lbHigh = Math.max(...lookback.map(sn => sn.p));
      const lbLow = Math.min(...lookback.map(sn => sn.p));
      const lbHighTs = lookback.find(sn => sn.p === lbHigh)?.ts || 0;
      const lbLowTs = lookback.find(sn => sn.p === lbLow)?.ts || 0;
      const range = lbHigh - lbLow;

      // Symbol-scaled thresholds. BTC numbers tuned to scale with BTC ATR (~$300/min vs XAU $1/min).
      const vrevMinRange = isBTC ? 300 : 8;
      const vrevBounceCap = isBTC ? 250 : 10;
      const vrevGap = isBTC ? 250 : 5;
      const vrevRoomBuffer = isBTC ? 100 : 2.0;
      const vrevBreakBuffer = isBTC ? 50 : 0.50;

      // V-REVERSAL CALL: price dropped to a low, then bounced back up
      // Low happened BEFORE current time, price has recovered significantly, ROC confirms upward
      //
      // Bounce-magnitude gate: was `range * 0.4` (40% of full range) — that worked for $10-15
      // V's but missed deep washouts. Example: 5/12 chart, ~17:45 broker time, range $4700→$4630
      // ≈ $70. 40% = $28 required before VREV could fire, by which point the move was 60% spent
      // AND RSI was back near 40 (also gating it elsewhere). Now: 30% bounce OR cap absolute,
      // whichever is SMALLER — so a deep V fires after a short recovery, while a shallow V
      // still needs 30%. Asymmetric in the right direction (catches more deep V's, doesn't
      // make shallow V's noisier than they already were).
      const minBounce = Math.min(range * 0.30, vrevBounceCap);
      const dropThenBounce = range >= vrevMinRange && lbLowTs < now2 - 60000 && (price - lbLow) >= minBounce && lbLowTs > lbHighTs;
      // V-REVERSAL PUT: price rallied to a high, then dropped back down
      const rallyThenDrop = range >= vrevMinRange && lbHighTs < now2 - 60000 && (lbHigh - price) >= minBounce && lbHighTs > lbLowTs;

      // Same-direction price-gap guard (added 2026-05-11 b): block VREV signals that fire
      // in the same direction as the last signal without meaningful price separation. Stops
      // the "two VREVs 10 min apart at the same price" pattern.
      const vrevGapOkCall = !(s.lastSameDir === 'call' && s.lastSameDirPrice > 0 && price < s.lastSameDirPrice + vrevGap);
      const vrevGapOkPut  = !(s.lastSameDir === 'put'  && s.lastSameDirPrice > 0 && price > s.lastSameDirPrice - vrevGap);

      // Round-number gate — XAU has $50 levels; BTC's round numbers ($1000 levels) are less
      // structurally relevant, so the gate is XAU-only. For BTC vrevRound* defaults to true.
      //
      // FIX 2026-05-13 (audit finding HIGH-2): same directional-inversion bug as the
      // room-to-grow gate. Original check `price < nearestRound + buffer` fired even when
      // price had cleared the round going up (e.g. price=$4700.30, round=$4700, $4700.30 <
      // $4700.50 still TRUE → block). But once price crosses above, that's a CONFIRMED BREAK
      // and the VREV CALL should fire. Fix: only block when price is on the WRONG SIDE of
      // the round (below for CALL, above for PUT). Once price clears the round, allow.
      const vrevRoundOkCall = isBTC ? true : !(roundNumZone && price < nearestRound);
      const vrevRoundOkPut  = isBTC ? true : !(roundNumZone && price > nearestRound);

      // Room-to-grow / room-to-sell gate. Block VREV CALL if price is approaching the 1h high
      // FROM BELOW (within buffer, no upside left). Block VREV PUT if approaching 1h low from
      // above. Same fix as FAST 2026-05-13: only block when price hasn't broken through —
      // if price > hi1h or < lo1h the breakout already happened, allow the trade.
      let vrevRoomOkCall = true;
      let vrevRoomOkPut = true;
      if (s.atrCandles && s.atrCandles.length >= 12) {
        const last12 = s.atrCandles.slice(-12);
        const hi1h = Math.max(...last12.map(c => c.h));
        const lo1h = Math.min(...last12.map(c => c.l));
        if (price < hi1h && price > hi1h - vrevRoomBuffer) vrevRoomOkCall = false;
        if (price > lo1h && price < lo1h + vrevRoomBuffer) vrevRoomOkPut = false;
      }

      // RECENT-MACRO-OPPOSITE GUARD (added 2026-05-15 after 5/15 08:47 XAU V-REV CALL @
      // $4550 SL'd). V-REV is exempt from the live macro contra-block in enrichSig (the
      // fade regex doesn't include VREV). And the macro-flip cooldown gives a flicker
      // bypass for opposite alignment <30 min. The combined effect: if macro was strongly
      // PUT-aligned during a downtrend, then the V-bottom bounce momentarily eases macro
      // back below 6/7, V-REV CALL fires AGAINST the still-prevailing trend and SLs as
      // a dead-cat. Symmetric for V-REV PUT after a CALL-aligned uptrend.
      //
      // Fix: independent of the live contra-block, check whether macro was 6+/7 aligned
      // OPPOSITE the V-REV direction within the last 45 min for ≥5 min stable. If yes,
      // we're catching a counter-trend pop — block. Allow the V-REV to fire only when the
      // opposite alignment was a brief flicker (<5 min) OR ended >45 min ago.
      const VREV_RECENT_MACRO_MS = 45 * 60 * 1000;   // look back 45 min
      const VREV_RECENT_STABLE_MS = 5 * 60 * 1000;   // opposite must have been stable ≥5 min
      const tVR = Date.now();
      let vrevMacroOppOkCall = true;
      let vrevMacroOppOkPut = true;
      // V-REV CALL: opposite = PUT-aligned. Check lastFullConvPutEndTs + duration, OR still active.
      const putEnd = s.lastFullConvPutEndTs || 0;
      const putDur = s.lastFullConvPutDurationMs || 0;
      const putStillActive = s.fullConvSincePut > 0;
      const putRecentlyActive = putEnd > 0 && (tVR - putEnd) < VREV_RECENT_MACRO_MS;
      if (putStillActive || (putRecentlyActive && putDur >= VREV_RECENT_STABLE_MS)) {
        vrevMacroOppOkCall = false;
      }
      // V-REV PUT: opposite = CALL-aligned.
      const callEnd = s.lastFullConvCallEndTs || 0;
      const callDur = s.lastFullConvCallDurationMs || 0;
      const callStillActive = s.fullConvSinceCall > 0;
      const callRecentlyActive = callEnd > 0 && (tVR - callEnd) < VREV_RECENT_MACRO_MS;
      if (callStillActive || (callRecentlyActive && callDur >= VREV_RECENT_STABLE_MS)) {
        vrevMacroOppOkPut = false;
      }

      // RSI band widened 2026-05-13: CALL lower bound 35 → 28, PUT upper bound 65 → 72.
      // The 35-65 band rejected exactly the trades VREV exists to catch — deep washouts where
      // RSI is still oversold at the turn. Asymmetric: keep the *opposite* side tight (CALL
      // still capped at 65 because if RSI is >65 you're catching the bounce too late and the
      // setup is more BREAK than VREV; same logic reversed for PUT).
      //
      // FIX 2026-05-18 (XAU 5/17-18 audit: 4 of 6 losers were V-REV conv-3 catching falling-
      // knife at RSI 32.9): the RSI 28 floor was too aggressive — V-REV CALL at RSI 32.9
      // SL'd as price kept dropping. Floor raised back from 28 → 32. Symmetric: PUT ceiling
      // 72 → 68. Keeps V-REV's deep-washout edge but blocks the most-extreme entries where
      // the "bounce" was just a dead-cat.
      if (dropThenBounce && !vrevMacroOppOkCall) {
        const which = putStillActive ? 'still active' : 'ended ' + Math.round((tVR - putEnd) / 60000) + 'min ago after ' + Math.round(putDur / 60000) + 'min';
        log(sym, '🚫 ⬆VREV CALL BLOCKED — macro PUT recently aligned (' + which + '). Bounce is dead-cat in PUT trend, not real reversal.');
      }
      if (dropThenBounce && roc3 > symRocThr * 2 && rsiV > 32 && rsiV < 65 && vrevGapOkCall && vrevRoundOkCall && vrevRoomOkCall && vrevMacroOppOkCall && flipCoolFor('call') && vrevFlipOk('call') && winProtectDir !== 'put') {
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

      if (rallyThenDrop && !vrevMacroOppOkPut) {
        const which = callStillActive ? 'still active' : 'ended ' + Math.round((tVR - callEnd) / 60000) + 'min ago after ' + Math.round(callDur / 60000) + 'min';
        log(sym, '🚫 ⬇VREV PUT BLOCKED — macro CALL recently aligned (' + which + '). Drop is profit-taking in CALL trend, not real reversal.');
      }
      if (rallyThenDrop && roc3 < -symRocThr * 2 && rsiV > 35 && rsiV < 68 && vrevGapOkPut && vrevRoundOkPut && vrevRoomOkPut && vrevMacroOppOkPut && flipCoolFor('put') && vrevFlipOk('put') && winProtectDir !== 'call') {
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
          // Record SL for cascade-limit and EMA-spread dedupe gates (added 2026-05-22)
          s.trv2SlHistory = s.trv2SlHistory || [];
          s.trv2SlHistory.push({ ts: now3, dir: t.dir, price: price, ema: tEma || 0, spreadPct: spreadPct });
          if (s.trv2SlHistory.length > 10) s.trv2SlHistory.shift();
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
          // Record SL for cascade-limit and EMA-spread dedupe gates (added 2026-05-22)
          s.trv2SlHistory = s.trv2SlHistory || [];
          s.trv2SlHistory.push({ ts: now3, dir: t.dir, price: price, ema: tEma || 0, spreadPct: spreadPct });
          if (s.trv2SlHistory.length > 10) s.trv2SlHistory.shift();
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
          // ===== TRv2 AUTO-REVERSE GUARDS (added 2026-05-22) =====
          // 5/21 NAS chop disaster: 3 back-to-back auto-reverses produced 1 scratch + 2 SLs
          // in 80min. Auto-reverse calls enrichSig() but ignores its return value (line 5210
          // pattern: enrichSig(revSig); s.signals.push(...); logSignal(...)), so the chop
          // block at enrichSig line 2488 was bypassed. Three new gates:
          //   (1) chop check  — block auto-reverse when chopActive is true
          //   (2) cascade limit — 2+ TRv2 SLs in last 60min triggers 30min cooldown
          //   (3) EMA-spread dedupe — current spread must exceed last SL's spread by 1.5×
          s.trv2SlHistory = s.trv2SlHistory || [];
          const slHistRecent_R = s.trv2SlHistory.filter(h => now3 - h.ts < 3600000);
          const cascadeActive_R = slHistRecent_R.length >= 2 && (now3 - slHistRecent_R[slHistRecent_R.length - 1].ts < 1800000);
          const lastSlSpread_R = slHistRecent_R.length > 0 ? slHistRecent_R[slHistRecent_R.length - 1].spreadPct : 0;
          const spreadFreshEnough_R = lastSlSpread_R === 0 ? true : spreadPct >= lastSlSpread_R * 1.5;

          if (revHiBlock || revLoBlock) {
            log(sym, '🏔️ TRv2 auto-reverse ' + revDir.toUpperCase() + ' blocked — session extreme reversal signal active');
          } else if (s.chopActive) {
            log(sym, '🌊 TRv2 auto-reverse ' + revDir.toUpperCase() + ' BLOCKED — chop mode active (5/21 NAS: 3 chop auto-reverses → 1 scratch + 2 SLs).');
          } else if (cascadeActive_R) {
            const minsSinceLast_R = Math.round((now3 - slHistRecent_R[slHistRecent_R.length - 1].ts) / 60000);
            log(sym, '⛔ TRv2 auto-reverse ' + revDir.toUpperCase() + ' BLOCKED — cascade cooldown (' + slHistRecent_R.length + ' SLs in last 60min, last ' + minsSinceLast_R + 'min ago). 30min cooldown.');
          } else if (!spreadFreshEnough_R) {
            log(sym, '🔁 TRv2 auto-reverse ' + revDir.toUpperCase() + ' BLOCKED — EMA-spread dedupe: current spread ' + spreadPct.toFixed(3) + '% < 1.5× last SL spread ' + lastSlSpread_R.toFixed(3) + '%. Avoid same-level flip.');
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

    // ===== TRv2 ENTRY GUARDS (added 2026-05-22) — cascade limit + EMA-spread dedupe =====
    // Mirror the auto-reverse guards. Chop check intentionally NOT applied here — past
    // analysis showed NAS chop detector overfires on staircase trends. But after a TRv2 SL,
    // re-entering at the same EMA level is the known whipsaw pattern (5/21 cascade).
    s.trv2SlHistory = s.trv2SlHistory || [];
    const slHistRecent_E = s.trv2SlHistory.filter(h => now3 - h.ts < 3600000);
    const cascadeActive_E = slHistRecent_E.length >= 2 && (now3 - slHistRecent_E[slHistRecent_E.length - 1].ts < 1800000);
    const lastSlSpread_E = slHistRecent_E.length > 0 ? slHistRecent_E[slHistRecent_E.length - 1].spreadPct : 0;
    const spreadFreshEnough_E = lastSlSpread_E === 0 ? true : spreadPct >= lastSlSpread_E * 1.5;

    if (!s.trv2Trade && entryReady && spreadPct >= minSpreadPct && trendAgeMature && cascadeActive_E) {
      if (!s._trv2CascadeLogTs || now3 - s._trv2CascadeLogTs > 60000) {
        const minsSinceLast_E = Math.round((now3 - slHistRecent_E[slHistRecent_E.length - 1].ts) / 60000);
        log(sym, '⛔ TRv2 entry blocked — cascade cooldown (' + slHistRecent_E.length + ' SLs in last 60min, last ' + minsSinceLast_E + 'min ago).');
        s._trv2CascadeLogTs = now3;
      }
    }
    if (!s.trv2Trade && entryReady && spreadPct >= minSpreadPct && trendAgeMature && !cascadeActive_E && !spreadFreshEnough_E) {
      if (!s._trv2DedupLogTs || now3 - s._trv2DedupLogTs > 60000) {
        log(sym, '🔁 TRv2 entry blocked — EMA-spread dedupe: current spread ' + spreadPct.toFixed(3) + '% < 1.5× last SL spread ' + lastSlSpread_E.toFixed(3) + '%.');
        s._trv2DedupLogTs = now3;
      }
    }

    if (!s.trv2Trade && entryReady && spreadPct >= minSpreadPct && trendAgeMature && !cascadeActive_E && spreadFreshEnough_E) {
      // ATR-SCALED ROC FILTER: on low-vol days, raise ROC threshold to filter noise
      // When ATR is below baseline, multiply ROC requirement by (baseline/ATR) capped at 2x
      const baselineAtr = 30; // NAS100 only now
      const atrRatio = trv2Atr > 0 ? Math.min(baselineAtr / trv2Atr, 2.0) : 1.0;
      const entryRocBase = NAS_ROC_THR * 0.5;
      const entryRocMin = entryRocBase * atrRatio;
      // RSI bands tightened 2026-05-14 after 5/14 15:21 NAS100 RIDE LONG @ RSI 73.3 SL'd
      // (-$30 in 30min). RSI 73 was "in the band" with old <75 cap but is overbought entry
      // for trend-continuation CALL. Aligned with XAU/BTC BREAK ceiling pattern (~70).
      // Symmetric tightening on SHORT side: RSI > 30 (was > 25) — same as BREAK PUT floor.
      let longOk = priceAbove && roc3 > entryRocMin && rsiV > 30 && rsiV < 68;
      let shortOk = priceBelow && roc3 < -entryRocMin && rsiV > 32 && rsiV < 70;

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
        // Fix 2026-05-11 f: `withMacro` was referenced but never declared, causing a
        // ReferenceError every time TRv2 tried to fire (Railway logs:
        // "processTicks NAS100 error: withMacro is not defined"). Was a leftover from an
        // older macro-alignment feature that got partially removed. Compute it now: macro
        // is "aligned" when DXY direction matches the inverse-correlation expectation
        // (DXY down + LONG = aligned; DXY up + SHORT = aligned). Used for label only.
        const withMacro = (s._dxy && s._dxy.dir)
          ? ((dir === 'long' && s._dxy.dir === 'down') || (dir === 'short' && s._dxy.dir === 'up'))
          : false;
        const macroTag = withMacro ? '+MACRO' : '';
        const sig = { type: sigType, time: ts(), price: price.toFixed(2), score: (dir === 'long' ? '⬆' : '⬇') + 'RIDE' + macroTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount, tp1: tp1.toFixed(2), tp2: tp2.toFixed(2), tp3: tp3.toFixed(2), sl: sl.toFixed(2) };
        // ===== TRv2 NOTIFICATION + TRADE MONITOR — always fire when TRv2 enters (added 2026-05-25) =====
        // Previously: `if (!enrichSig(sig)) return;` blocked the notification + s.trade activation
        // when enrichSig returned false (e.g., RIDE blocked by chop suppression at line 2524).
        // The trade still ran in the background (s.trv2Trade was set above) but the user got no
        // entry notification and the EA's trade monitor never picked it up — only the TP1/TP2/TP3
        // alerts fired later. 5/24-25 case: NAS TRv2 won a full TP3 sweep silently in chop mode.
        //
        // Fix: TRv2's own gates (EMA spread, ATR, cascade limit #154, EMA dedupe #155, conv
        // maturity #156, RSI bands #79) are stricter than enrichSig's general checks. If TRv2
        // decided to enter, we trust it — ALWAYS notify + activate s.trade. enrichSig still runs
        // for analytics (signalHistory inclusion), but it can no longer suppress the entry alert
        // or trade monitor handoff.
        log(sym, '🚀 TRv2 ENTRY ' + dir.toUpperCase() + (withMacro ? ' +MACRO' : '') + ' — $' + price.toFixed(2) + ' > EMA $' + tEma.toFixed(2) + ' (+' + spreadPct.toFixed(3) + '%) · ATR $' + trv2Atr.toFixed(2) + ' · TP1 $' + tp1.toFixed(2) + ' · TP2 $' + tp2.toFixed(2) + ' · TP3 $' + tp3.toFixed(2) + ' · SL $' + sl.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · TP1 $' + tp1.toFixed(2) + ' · TP2 $' + tp2.toFixed(2) + ' · TP3 $' + tp3.toFixed(2) + ' · SL $' + sl.toFixed(2), 'signal');
        s.trade = { active: true, type: sigType, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, ts: Date.now(), pt1: 30, pt2: 60, sl2: 25, isTrend: true, isCfd: true, slPrice: sl, tp1Price: tp1, tp2Price: tp2, tp3Price: tp3, atr: trv2Atr, bestPrice: price, trailSl: 0 };
        // Run enrichSig for analytics — if it blocks, signal won't be added to signalHistory
        // but the trade still runs and the user already got the notification.
        if (enrichSig(sig)) {
          s.signals.push(sig);
          logSignal(sym, sig);
        } else {
          log(sym, '📊 TRv2 entry not added to signalHistory (blocked by enrichSig — analytics only, trade still active)');
        }
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
  if (isXAU && isMT5 && s.macroEma !== null && s.macroSnaps.length >= 4 && cool && (now2 - s.trendRideLastTs > trCoolMs) && !s.chopActive) {
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
      // RSI cap: 60 (lowered 70→60 on 2026-05-14 for winners-only mode). Caught 5/13 06:09
      // TREND CALL @ RSI 63.6 which had STRUCT + good conv but still SL'd — entered too
      // overbought. RSI 60-70 is "exhaustion entry" territory for trend continuation; the
      // safer ride begins when RSI pulls back below 60 and re-confirms.
      const trCallRsiMax = 60;
      if (trDir === 'bull' && rsiV > 30 && rsiV < trCallRsiMax && trCallMacdOk && flipCoolFor('call') && winProtectDir !== 'put') {
        // (Removed 2026-05-08): hard cap at 2 same-direction signals was too aggressive — it
        // could lock out the entire direction for hours when overnight signals had already
        // pushed the count to 2 and no opposite TREND had fired to reset it. The existing
        // progress-check at line ~2196 (allows up to 6 same-dir IF price progresses 0.02%+
        // between each) is smarter, and the MACD-extremity gate above catches the actual
        // failure case (3rd ⬆TREND CALL at MACD +1.447 on 5/7 was blocked there).
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
        // (Removed 2026-05-08): see CALL block above for rationale. Existing progress-check
        // + MACD-extremity gate handle this without locking out the direction.
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
    // MACD skip — was an unconditional bypass once distFromATH >= athAtlMacdSkip ($3 XAU).
    // Problem (caught 5/12 row 4): on 5/12 at 13:59 the rolling high was $4707 but current price
    // was $4678 — distFromATH = $28, way past the $3 skip threshold, so the MACD bullish check
    // was bypassed even though MACD line was +0.059 (clearly bullish, still in uptrend). Signal
    // fired PUT and SL'd. Cap the skip to a tight "fresh rejection" zone: skip only if pullback
    // is $3-12 (XAU), $40-150 (BTC), $15-60 (NAS). Beyond that, the price is no longer rejecting
    // the high — it's just trading below it, and MACD lag isn't a valid excuse anymore.
    const athMacdSkipMax = isBTC ? 150 : isNAS ? 60 : 12;
    const athMacdOk = macdL < macdS || (distFromATH >= athAtlMacdSkip && distFromATH <= athMacdSkipMax);
    const athRocStrong = roc3 < -0.02; // minimum selling pressure — kills -0.009, -0.011 noise signals
    // RSI threshold (lowered 2026-05-13 for XAU 60→55 after CSV 5/12 row 4: PUT ATH fired
    // at RSI 58.6 with MACD +0.059, just $1.4 under the old 60 floor). NAS was already 55.
    // BTC kept at 60 — no losing signal observed yet, don't over-tighten.
    const athBullRsiThr = isBTC ? 60 : 55;
    const athBullBlock = rsiV > athBullRsiThr && macdHist > 0; // RSI high + MACD bullish = still in uptrend, not a real reversal
    // Minimum conviction: require at least 2 cross-asset factors (same as ATL CALL)
    const athConv = convictionFor('put');
    const athConvOk = athConv.score >= 2;
    // Trend-protection gate (symmetric to ATL CALL): if rolling high advanced within 30 min,
    // price is still making new highs — ATH PUT is fading an active uptrend. Block.
    //
    // EXCEPTION (added 2026-05-13, mirror of ATL big-washout override): if the spike that
    // set the new rolling high was unusually large (price gapped well past prior range), the
    // spike IS the blow-off-top opportunity, not continuation. Allow ATH PUT once price has
    // pulled back at least 30% of the spike magnitude.
    const athSpikeSize = isBTC ? 200 : isNAS ? 30 : 5;
    const athSpikeDepth = s.rollingHigh - (s.priorRangeHigh || s.rollingHigh);
    const athBigSpike = athSpikeDepth >= athSpikeSize;
    const athPostSpikePullback = distFromATH >= athSpikeSize * 0.30;
    const athTrendBlockRaw = s.rollingHighUpdateTs && (now2 - s.rollingHighUpdateTs < 1800000);
    const athTrendBlock = athTrendBlockRaw && !(athBigSpike && athPostSpikePullback);
    if (athTrendBlockRaw && !athTrendBlock) {
      log(sym, 'ATH PUT trend-block OVERRIDE — big spike ($' + athSpikeDepth.toFixed(2) + ' past prior range, pulled back $' + distFromATH.toFixed(2) + ' off new high). Allowing ATH PUT.');
    } else if (athTrendBlock) {
      if (now2 - (s.athTrendBlockLogTs || 0) > 300000) {
        log(sym, 'ATH PUT trend-block — rolling high updated ' + Math.round((now2 - s.rollingHighUpdateTs) / 60000) + 'm ago (uptrend in progress)');
        s.athTrendBlockLogTs = now2;
      }
    }
    // Current-RSI oversold guard (added 2026-05-11 after XAU signal #4 fired ATH PUT at RSI 23.2
    // — selling at the bottom of an already-completed move). The detector previously only checked
    // rsiAtRollingHigh > 55 (RSI at the prior peak) without verifying CURRENT RSI is in a sane
    // PUT zone. Now require current RSI ≥ 35 to avoid bottom-fishing.
    const athOversoldBlock = rsiV < 35;
    if (athOversoldBlock && athApproachRecent) {
      if (now2 - (s.athOversoldLogTs || 0) > 300000) {
        log(sym, 'ATH PUT oversold-block — current RSI ' + rsiV.toFixed(1) + ' < 35 (already oversold, no room to fall)');
        s.athOversoldLogTs = now2;
      }
    }
    // Big-spike-pullback override (added 2026-05-13 — same case as the trend-block override).
    // Caught from 5/13 18:49-19:00 logs: ATH PUT trend-block OVERRIDE messages firing EVERY
    // tick saying "Allowing ATH PUT" with $15-22 pullback off new high, but signal never
    // actually emitting because athApproachRecent was FALSE (price had pulled back far enough
    // that it's no longer within 0.1% of the rolling high → athApproachTs stale).
    // When the big-spike override is active, the spike+pullback pattern IS the rejection —
    // doesn't need a fresh price-zone touch. Bypass athApproachRecent in that case.
    const athApproachOk = athApproachRecent || (athBigSpike && athPostSpikePullback);
    if (!athTrendBlock && !athOversoldBlock && athApproachOk && distFromATH >= athAtlPullback && s.rsiAtRollingHigh > 55 && athMacdOk && athRocStrong && !athBullBlock && athConvOk && flipCoolFor('put') && winProtectDir !== 'call') {
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
        s.trade = isMT5 ? attachOTE(buildCfdTrade('put', price, atrVal, sym), s, sym, 'put') : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        if (isMT5 && s.trade.oteLimit) log(sym, '🎯 OTE PUT limit set @ $' + s.trade.oteLimit.toFixed(2) + ' (ATH retracement entry, expires in 3min)');
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
    // Mirror of ATH MACD-skip cap (see comment at line ~3633): only skip MACD check when the
    // bounce is "fresh-rejection sized" ($3-12 XAU / $40-150 BTC / $15-60 NAS). Beyond that,
    // price is just trading above the rolling low — not a rejection — and MACD-lag isn't a
    // valid reason to skip the bullish-cross requirement.
    const atlMacdOk = macdL > macdS || (distFromATL >= athAtlMacdSkip && distFromATL <= athMacdSkipMax);
    const atlConv = convictionFor('call');
    const atlConvOk = atlConv.score >= 2;
    const atlRocMin = roc3 > 0.01; // require real positive momentum, not just > 0
    const atlBounceFailed = s.lastAtlCallTs && (now2 - s.lastAtlCallTs < 3600000) && price <= s.lastAtlCallPrice;
    // Trend-protection gate (added 2026-05-10 after BTC 5/7 morning ATL CALL streak — 6 consecutive
    // ATL CALLs while price kept making new 5-day lows, all losers). If the rolling low advanced
    // (= new low set) within the last 30 min, the market is in active downtrend — ATL is trend
    // continuation, NOT reversal. Block the CALL.
    //
    // EXCEPTION (added 2026-05-13 after 5/12 BTC V-bottom miss): if the washout that set the
    // new rolling low was unusually large — meaning price fell sharply past the prior range —
    // the washout IS the reversal opportunity, not a continuation. Allow ATL CALL despite the
    // recent rolling-low update IF price has bounced meaningfully off the new low.
    // Washout thresholds (% of athAtlMinRange): XAU $5/$15=33%, BTC $200/$500=40%, NAS $30/$100=30%.
    // Bounce requirement: price has recovered at least 30% of the washout magnitude.
    const washoutSize = isBTC ? 200 : isNAS ? 30 : 5;          // size of the "big washout" that justifies override
    const atlWashoutDepth = (s.priorRangeLow || s.rollingLow) - s.rollingLow; // how far past prior range the new low went
    const atlBigWashout = atlWashoutDepth >= washoutSize;
    const atlPostWashoutBounce = distFromATL >= washoutSize * 0.30; // bounced 30% of washout off the new low
    const atlTrendBlockRaw = s.rollingLowUpdateTs && (now2 - s.rollingLowUpdateTs < 1800000);
    const atlTrendBlock = atlTrendBlockRaw && !(atlBigWashout && atlPostWashoutBounce);
    if (atlTrendBlockRaw && !atlTrendBlock) {
      log(sym, 'ATL CALL trend-block OVERRIDE — big washout ($' + atlWashoutDepth.toFixed(2) + ' past prior range, bounced $' + distFromATL.toFixed(2) + ' off new low). Allowing ATL CALL.');
    } else if (atlTrendBlock) {
      if (now2 - (s.atlTrendBlockLogTs || 0) > 300000) {
        log(sym, 'ATL CALL trend-block — rolling low updated ' + Math.round((now2 - s.rollingLowUpdateTs) / 60000) + 'm ago (downtrend in progress)');
        s.atlTrendBlockLogTs = now2;
      }
    }
    // Current-RSI overbought guard (added 2026-05-11, symmetric to ATH PUT oversold guard).
    // Existing logic already had rsiV < 75 ceiling; tightening to 65 to match the new
    // anti-late-fire stance — buying at RSI 65+ on a bounce is chasing the top.
    const atlOverboughtBlock = rsiV > 65;
    if (atlOverboughtBlock && atlApproachRecent) {
      if (now2 - (s.atlOverboughtLogTs || 0) > 300000) {
        log(sym, 'ATL CALL overbought-block — current RSI ' + rsiV.toFixed(1) + ' > 65 (already overbought, no room to rise)');
        s.atlOverboughtLogTs = now2;
      }
    }
    // Mirror of ATH PUT fix: bypass atlApproachRecent when big-washout override is active
    // (added 2026-05-13). After a deep washout, price is no longer within 0.1% of rolling low
    // → atlApproachTs stale → atlApproachRecent FALSE → signal silently doesn't fire.
    const atlApproachOk = atlApproachRecent || (atlBigWashout && atlPostWashoutBounce);
    if (!atlTrendBlock && !atlOverboughtBlock && atlApproachOk && distFromATL >= athAtlPullback && s.rsiAtRollingLow < 45 && rsiV < 75 && atlMacdOk && atlRocMin && !atlBounceFailed && atlConvOk && flipCoolFor('call') && winProtectDir !== 'put') {
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
        s.trade = isMT5 ? attachOTE(buildCfdTrade('call', price, atrVal, sym), s, sym, 'call') : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        if (isMT5 && s.trade.oteLimit) log(sym, '🎯 OTE CALL limit set @ $' + s.trade.oteLimit.toFixed(2) + ' (ATL retracement entry, expires in 3min)');
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
  // fireCall/firePut declared as `let` because the gate code below (session-high blocker,
  // overbought CALL blocker, MT5 ROC gate, BTC overconfirmation block) sets them to false
  // when their respective filters trip.
  let fireCall = cS >= finalMinS && vixOk && rsiOkCall && macdAlignCall;
  let firePut = pS >= finalMinS && rsiOkPut && macdAlignPut;

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
  // Cross-asset confluence annotation (added 2026-05-16). When QQQ/SPY base-scoring fires
  // and NAS100 bot has independently fired the same direction within the last 10 min, mark
  // the signal as confirmed-by-NAS. Shown in log + push notification so the user knows two
  // correlated bots agree — much higher-quality confirmation than the base score alone.
  const CROSS_SIG_WINDOW = 10 * 60 * 1000;
  const tCrossNow = Date.now();
  const nasS = S['NAS100'];
  const nasCallRecent = nasS && nasS.lastCallSignalTs > 0 && (tCrossNow - nasS.lastCallSignalTs) < CROSS_SIG_WINDOW;
  const nasPutRecent = nasS && nasS.lastPutSignalTs > 0 && (tCrossNow - nasS.lastPutSignalTs) < CROSS_SIG_WINDOW;
  const eligibleForCross = (sym === 'QQQ' || sym === 'SPY');

  if (fireCall && cool && flipCoolFor('call')) {
    s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
    if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
    s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
    s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
    const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: cS + '/' + mi, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
    const nasConfirm = eligibleForCross && nasCallRecent;
    if (nasConfirm) {
      sig.nasConfirm = true;
      const nasAgoMin = Math.round((tCrossNow - nasS.lastCallSignalTs) / 60000);
      sig.nasConfirmAgoMin = nasAgoMin;
    }
    if (!enrichSig(sig)) return; s.signals.push(sig);
    logSignal(sym, sig);
    const convLbl = sig.conv ? ' [' + sig.conv.label + ' ' + sig.conv.score + '/7]' : '';
    const nasTag = nasConfirm ? ' ✓NAS_SIG (' + sig.nasConfirmAgoMin + 'min ago)' : '';
    log(sym, '🚀 CALL ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + convLbl + nasTag + ' [#' + s.dailySignalCount + ']');
    sendPush('🚀 ' + sym + ' CALL ' + sig.score + (nasConfirm ? ' ✓NAS' : '') + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc + (sig.conv ? ' · ' + sig.conv.label + ' ' + sig.conv.score + '/7' : '') + (nasConfirm ? ' · NAS CALL ' + sig.nasConfirmAgoMin + 'min ago' : ''), 'signal');
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
    const nasConfirm2 = eligibleForCross && nasPutRecent;
    if (nasConfirm2) {
      sig.nasConfirm = true;
      sig.nasConfirmAgoMin = Math.round((tCrossNow - nasS.lastPutSignalTs) / 60000);
    }
    if (!enrichSig(sig)) return; s.signals.push(sig);
    logSignal(sym, sig);
    const convLbl2 = sig.conv ? ' [' + sig.conv.label + ' ' + sig.conv.score + '/7]' : '';
    const nasTag2 = nasConfirm2 ? ' ✓NAS_SIG (' + sig.nasConfirmAgoMin + 'min ago)' : '';
    log(sym, '📉 PUT ' + sig.score + ' RSI:' + sig.rsi + ' $' + sig.price + convLbl2 + nasTag2 + ' [#' + s.dailySignalCount + ']');
    sendPush('📉 ' + sym + ' PUT ' + sig.score + (nasConfirm2 ? ' ✓NAS' : '') + ' #' + s.dailySignalCount, '$' + sig.price + ' · RSI:' + sig.rsi + ' · ROC:' + sig.roc + (sig.conv ? ' · ' + sig.conv.label + ' ' + sig.conv.score + '/7' : '') + (nasConfirm2 ? ' · NAS PUT ' + sig.nasConfirmAgoMin + 'min ago' : ''), 'signal');
    if (isMT5) attachTpSl(sig, 'put', price, atrVal, sym);
    // Activate trade monitor for this signal
    s.trade = isMT5 ? buildCfdTrade('put', price, atrVal, sym) : { active: true, type: 'put', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
    SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
  }
}

// ===== ATR-BASED TRADE BUILDER (XAU/BTC/NAS100 — CFD signals) =====
// Creates trade object with price-based TP/SL levels from ATR
// TP1=1x ATR, TP2=2x ATR, TP3=3x ATR, SL=1.5x ATR
// ===== OTE (OPTIMAL TRADE ENTRY) COMPUTATION =====
// Added 2026-05-11 f. For supported detectors (DIV/ATH/ATL/BREAK), compute the 70.5%
// Fibonacci retracement level of the most recent 15-min impulse leg. EA uses this as a
// LIMIT entry price (better fill than market) with fallback to Option A delayed-market entry
// if price doesn't retrace to the OTE level within 3 minutes.
//
// Returns null when:
//   - Insufficient price history
//   - Impulse range too small to be meaningful (XAU < $3, BTC < $150, NAS < $15)
//   - Impulse direction doesn't match the signal direction
//     (PUT needs UP-impulse to fade — high more recent than low)
//     (CALL needs DOWN-impulse — low more recent than high)
function computeOTE(s, sym, dir) {
  if (!s.vrevSnaps || s.vrevSnaps.length < 30) return null;
  const lookbackMs = 900000; // 15 min
  const lookbackStart = Date.now() - lookbackMs;
  const snaps = s.vrevSnaps.filter(sn => sn.ts >= lookbackStart);
  if (snaps.length < 30) return null;
  let hiP = -Infinity, hiTs = 0;
  let loP = Infinity, loTs = 0;
  snaps.forEach(sn => {
    if (sn.p > hiP) { hiP = sn.p; hiTs = sn.ts; }
    if (sn.p < loP) { loP = sn.p; loTs = sn.ts; }
  });
  const range = hiP - loP;
  const minRange = sym === 'XAU' ? 3 : sym === 'BTC' ? 150 : sym === 'NAS100' ? 15 : 3;
  if (range < minRange) return null;
  // 70.5% retracement (golden mean of OTE zone)
  let oteLimit;
  if (dir === 'put') {
    // Need UP-impulse to fade — high must be more recent than low
    if (hiTs <= loTs) return null;
    oteLimit = hiP - range * 0.705;
  } else {
    // CALL — need DOWN-impulse to ride from — low must be more recent than high
    if (loTs <= hiTs) return null;
    oteLimit = loP + range * 0.705;
  }
  return {
    limit: +oteLimit.toFixed(2),
    expiry: Date.now() + 180000, // 3-min EA wait window
    impulseHi: +hiP.toFixed(2),
    impulseLo: +loP.toFixed(2)
  };
}

// Helper to attach OTE to a built CFD trade. No-op if computeOTE returns null.
function attachOTE(trade, s, sym, dir) {
  const ote = computeOTE(s, sym, dir);
  if (ote) {
    trade.oteLimit = ote.limit;
    trade.oteExpiry = ote.expiry;
    trade.oteImpulseHi = ote.impulseHi;
    trade.oteImpulseLo = ote.impulseLo;
  }
  return trade;
}

function buildCfdTrade(type, price, atr, sym) {
  const iC = type === 'call';
  const isXAU = sym === 'XAU';
  const isNAS = sym === 'NAS100';
  // Per-instrument TP/SL policy (multiples of ATR).
  // Default (XAU, BTC): SL=2×, TP1=1.5×, TP2=2.5×, TP3=4×.
  // NAS (updated 2026-05-16): NAS futures show much cleaner directional legs than XAU/BTC
  // — e.g., 5/15 $29400→$29000 was a clean $400 leg with minimal counter-spikes. Old TPs cut
  // winners at ~$38/$75/$120 (with ATR~25). New TPs at 3/6/12× ATR capture the full leg.
  // SL stays tight at 2× ATR — NAS doesn't spike against you the way XAU/BTC do, so wider
  // SLs aren't needed for survival, and tight SLs keep the per-trade risk small.
  const mults = isNAS
    ? { sl: 2, t1: 3, t2: 6, t3: 12 }
    : { sl: 2, t1: 1.5, t2: 2.5, t3: 4 };
  // Minimum $5 for SL and TP1 — prevents noise-level levels during low-ATR periods
  // XAU max $10 cap — keeps risk tight on gold's typical ATR range
  const slDist = isXAU ? Math.min(Math.max(atr * mults.sl, 5), 10) : Math.max(atr * mults.sl, 5);
  // XAU TP1 hard-capped at $5 (added 2026-05-19): user wants fast profit-secure on XAU
  // since the SL→breakeven scratch logic depends on TP1 hitting. Smaller TP1 = higher hit
  // rate = more trades locked at breakeven instead of full SL. TP2/TP3 stay ATR-based to
  // capture larger runners.
  const tp1Dist = isXAU ? 5.0 : Math.max(atr * mults.t1, 5);
  const tp2Dist = atr * mults.t2;
  const tp3Dist = atr * mults.t3;
  const sl = iC ? price - slDist : price + slDist;
  const tp1 = iC ? price + tp1Dist : price - tp1Dist;
  const tp2 = iC ? price + tp2Dist : price - tp2Dist;
  const tp3 = iC ? price + tp3Dist : price - tp3Dist;

  // ===== SAME-DIRECTION CONTINUATION — LOCK TP1 (added 2026-05-14) =====
  // When a new same-direction signal fires while the existing trade is still active and
  // hasn't hit TP1 yet, KEEP the original entry + the existing (closer-to-current-price) TP1.
  // Locks in the partial-close gain we're already partway to instead of resetting TP1 further.
  // TP2/TP3 still update to new (further) levels — fine, they're stretch targets.
  // SL also kept from original entry (the original risk budget already determined that).
  const oldTrade = sym && S[sym] ? S[sym].trade : null;
  const sameDirContinuation =
    oldTrade && oldTrade.active && oldTrade.isCfd &&
    oldTrade.type === type && !oldTrade.t1;
  if (sameDirContinuation) {
    // For PUT: TP1 below entry. The HIGHER tp1 price is closer to current price → easier to hit
    // For CALL: TP1 above entry. The LOWER tp1 price is closer to current price → easier to hit
    const lockedTp1 = iC
      ? Math.min(oldTrade.tp1Price, tp1)
      : Math.max(oldTrade.tp1Price, tp1);
    log(sym, '🔒 SAME-DIR CONTINUATION — keeping original entry $' + oldTrade.ep.toFixed(2) + ' + TP1 $' + lockedTp1.toFixed(2) + ' (was $' + oldTrade.tp1Price.toFixed(2) + ', new signal would have made it $' + tp1.toFixed(2) + '). TP2/TP3 use new levels.');
    return {
      active: true, type: type,
      ep: oldTrade.ep,                  // keep ORIGINAL entry — locks accounting / partial-close math
      t1: false, t2: oldTrade.t2 || false, sl: oldTrade.sl || false, rev: false,
      lastETs: oldTrade.lastETs || 0,
      ts: oldTrade.ts,                  // keep original entry timestamp
      slPrice: oldTrade.slPrice,        // keep original SL — the risk budget was set at entry
      tp1Price: lockedTp1,              // the EASIER TP1 → take partial profit sooner
      tp2Price: tp2,                    // new (further) — stretch target OK to extend
      tp3Price: tp3,                    // new (further) — stretch target OK to extend
      atr: atr,
      bestPrice: oldTrade.bestPrice || price,  // keep best-price tracking
      trailSl: oldTrade.trailSl || 0,
      isCfd: true
    };
  }

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
  const isXAU = sym === 'XAU';
  const isNAS = sym === 'NAS100';
  // Per-instrument TP/SL policy (mirror buildCfdTrade). NAS gets bigger TPs to capture
  // its cleaner directional legs (updated 2026-05-16).
  const mults = isNAS
    ? { sl: 2, t1: 3, t2: 6, t3: 12 }
    : { sl: 2, t1: 1.5, t2: 2.5, t3: 4 };
  // XAU TP1 hard-capped at $5 (mirrors buildCfdTrade — added 2026-05-19)
  const tp1D = isXAU ? 5.0 : Math.max(atr * mults.t1, 5);
  const slD = isXAU ? Math.min(Math.max(atr * mults.sl, 5), 10) : Math.max(atr * mults.sl, 5);
  sig.tp1 = (iC ? price + tp1D : price - tp1D).toFixed(2);
  sig.tp2 = (iC ? price + atr * mults.t2 : price - atr * mults.t2).toFixed(2);
  sig.tp3 = (iC ? price + atr * mults.t3 : price - atr * mults.t3).toFixed(2);
  sig.sl = (iC ? price - slD : price + slD).toFixed(2);
  return sig;
}

// ===== EXIT MONITOR =====
// Update outcome tracking on signalHistory entry corresponding to the active trade.
// Called by checkExit() after flag transitions. Stores tp1Hit/tp2Hit/tp3Hit/slHit + timestamps.
// TP3 is distinguished from real SL by checking whether t.t2 was already true at trigger time
// (TP3 path: TP1 hit → TP2 hit → TP3 hit sets t.sl=true; real SL: just t.sl=true with no prior TP2).
function updateSignalOutcome(sym, finalPrice) {
  const s = S[sym];
  if (s.lastHistIdx == null) return;
  const entry = signalHistory[s.lastHistIdx];
  if (!entry || entry.symbol !== sym) return;
  if (!entry.outcomes) entry.outcomes = {};
  const t = s.trade;
  if (!t) return;
  const now = Date.now();
  if (t.t1 && !entry.outcomes.tp1Hit) {
    entry.outcomes.tp1Hit = true; entry.outcomes.tp1HitTs = now;
  }
  if (t.t2 && !entry.outcomes.tp2Hit) {
    entry.outcomes.tp2Hit = true; entry.outcomes.tp2HitTs = now;
  }
  if (t.sl && !entry.outcomes.slHit && !entry.outcomes.tp3Hit) {
    if (t.t2) {
      // t.sl was set via the TP3 path (line ~4005) — TP2 already hit, then TP3
      entry.outcomes.tp3Hit = true; entry.outcomes.tp3HitTs = now;
      entry.outcomes.closePrice = finalPrice;
      // Mark post-TP3 cooldown for this direction (added 2026-05-14). 90 min block on
      // same-direction signals — the move is exhausted, chasing it leads to losers
      // (5/14 signal #2 SL'd 32 min after signal #1 hit TP3 in same direction).
      if (t.type === 'call') s.lastTp3CallTs = now;
      else if (t.type === 'put') s.lastTp3PutTs = now;
    } else {
      // Real stop loss (before TP2)
      entry.outcomes.slHit = true; entry.outcomes.slHitTs = now;
      entry.outcomes.closePrice = finalPrice;
    }
  }
  // Persist after outcome update (added 2026-05-14). Outcomes are critical for audit —
  // every TP/SL hit must survive a restart.
  try { saveSignalHistory(); } catch (e) { /* already logged */ }
}

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
      updateSignalOutcome(sym, price);
    }
    // TP2 hit → trail SL to TP1
    if (!t.t2 && ((iC && price >= t.tp2Price) || (!iC && price <= t.tp2Price))) {
      t.t2 = true; t.trailSl = t.tp1Price; t.lastETs = now;
      log(sym, '🎯 TP2 HIT — $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2) + ' · SL → TP1 $' + t.tp1Price.toFixed(2));
      sendPush('🎯 ' + sym + ' TP2 HIT', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · SL → TP1', 'signal');
      updateSignalOutcome(sym, price);
    }
    // TP3 hit → full exit
    if (!t.sl && ((iC && price >= t.tp3Price) || (!iC && price <= t.tp3Price))) {
      t.sl = true; t.lastETs = now;
      log(sym, '🏆 TP3 FULL TARGET — $' + price.toFixed(2) + ' · P&L $' + pnl.toFixed(2));
      sendPush('🏆 ' + sym + ' TP3 — FULL TARGET', '$' + price.toFixed(2) + ' · +$' + pnl.toFixed(2) + ' · close trade', 'signal');
      updateSignalOutcome(sym, price); // capture TP3 outcome BEFORE clearing trade
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
        updateSignalOutcome(sym, price);
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
        updateSignalOutcome(sym, price);
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
      // Compute pullback from peak favorable price. Trade is "reversing meaningfully"
      // only when price has given back ≥ threshold from the best level reached.
      // Tightened 2026-05-12: previous check was just pnl > 0 (any positive P&L),
      // which fired on $0.50 noise. Now require both:
      //   1. pnl > 0 (still profitable — don't close at a loss)
      //   2. pullback ≥ instrument-specific threshold (real reversal, not noise)
      // Thresholds proportional to instrument move size: XAU $5, BTC $250, NAS $25.
      const bestPnl = iC ? t.bestPrice - t.ep : t.ep - t.bestPrice;
      const pullback = bestPnl - pnl; // how much we've given back from peak
      const revMinPullback = (sym === 'XAU') ? 5 : (sym === 'BTC') ? 250 : (sym === 'NAS100') ? 25 : 5;
      if (pnl > 0 && pullback >= revMinPullback) {
        // Meaningful reversal + still profitable → set t.rev=true and log only.
        // Push notification removed (2026-05-08, by user request) — reversal warnings used
        // to ping the phone, but only the user should close trades (via ✕ Clear button,
        // popup accept, or new signal). Log stays so we can correlate post-hoc.
        t.rev = true; t.lastETs = now;
        log(sym, '🎯 REVERSAL EXIT (log-only) — pulled back $' + pullback.toFixed(2) + ' from peak $' + bestPnl.toFixed(2) + ' · current +$' + pnl.toFixed(2) + ' · ' + fl + '/3 indicators flipped · age ' + Math.round((now - t.ts) / 60000) + 'min');
      } else if (pnl > 0 && pullback < revMinPullback) {
        // Indicators flipped + profitable BUT pullback too small — noise, not a real reversal.
        // Wait for either more pullback (real reversal) or recovery (trade continues).
        if (now - (t.lastRevHoldLog || 0) > 60000) {
          log(sym, '⏸ Reversal indicators flipped but pullback $' + pullback.toFixed(2) + ' < $' + revMinPullback + ' (noise — holding) · peak +$' + bestPnl.toFixed(2) + ' · current +$' + pnl.toFixed(2));
          t.lastRevHoldLog = now;
        }
      } else {
        // Not profitable yet — don't auto-close. Trade either recovers or hits SL.
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
      // Log-only — push notification removed (see CFD path comment for rationale)
      t.rev = true; t.lastETs = now;
      log(sym, '🎯 REVERSAL EXIT (log-only) — +' + dm.toFixed(2) + '% · ' + fl + '/4 flipped · age ' + Math.round((now - t.ts) / 60000) + 'min');
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
          // Cap raised 20 → 60 candles (5 hours) on 2026-05-13 to support the 4-hour
          // range-bound chop detector in enrichSig that needs 48 candles. 5 hours of
          // 5-min OHLC ≈ 60 floats × 4 fields = trivial memory.
          if (s.atrCandles.length > 60) s.atrCandles.shift();
          s.atrCurCandle = { o: price, h: price, l: price, c: price, startTs: bNow5 };
        }
      }
    }

    // Macro trend snapshots — all instruments (XAU, BTC, NAS100, QQQ, SPY), every 5 min,
    // 6-hour rolling window (extended from MT5-only on 2026-05-20 so the multi-day regime
    // gate works for equities too).
    if ((sym === 'XAU' || sym === 'BTC' || sym === 'NAS100' || sym === 'QQQ' || sym === 'SPY') && (Date.now() - s.macroLastSnapTs >= 300000)) {
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

      // ===== MARKET-GAP RESET (added 2026-05-16) =====
      // Coil state must NOT survive a market closure. NAS futures pause Fri 5PM → Sun 6PM ET
      // (49h) and also break daily 5-6PM ET (1h). XAU pauses 5-6PM ET. If a coil was active
      // before the close, the FROZEN boundaries from Friday/yesterday persist while the
      // server keeps running. When the market reopens with a price gap, the breakout check
      // compares NEW price against STALE boundaries — any reopen gap registers as a false
      // breakout (e.g., NAS coiling $29100-$29115 Friday close → Sunday open $29200 = "BREAK
      // CALL!" but the move is just the weekend re-pricing, not real momentum).
      //
      // Detection: if no tick was received for >30 minutes (much longer than any normal
      // tick gap during open markets, but shorter than any genuine market break), assume a
      // closure happened and clear all coil state. The breakRange buffer's own 5-min trim
      // would clean stale ticks, but the FROZEN boundaries + breakCoilActive flag + coil
      // start time + coilArmedAlerted flag persist independently and need explicit reset.
      const TICK_GAP_RESET_MS = 30 * 60 * 1000; // 30 minutes
      const lastTickTs = s.breakRange.length > 0 ? s.breakRange[s.breakRange.length - 1].ts : 0;
      if (lastTickTs > 0 && (bNow - lastTickTs) > TICK_GAP_RESET_MS) {
        const gapMin = Math.round((bNow - lastTickTs) / 60000);
        log(sym, '⏸ Market-gap reset — ' + gapMin + 'min since last tick. Clearing coil state (breakRange + breakCoilActive + frozen boundaries + alert flag) to prevent stale-coil false breakouts on reopen.');
        s.breakRange = [];
        s.breakCoilActive = false;
        s.breakFrozenHi = 0;
        s.breakFrozenLo = Infinity;
        s.breakCoilStart = 0;
        s.coilArmedAlerted = false;
        s.breakHi = 0;
        s.breakLo = Infinity;
      }

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
          s.coilArmedAlerted = false; // reset for the new coil
        } else if (s.breakCoilActive && bRange < coilMaxRange) {
          // STILL COILING — boundaries stay FROZEN. Do not update.
          // If we widen them, the breakout detection drifts with price (the original bug).
        }

        // COIL ARMED ALERT (NAS only, added 2026-05-16): fire a one-time push notification
        // once the coil has been stable for ≥3 minutes. Goal: pre-position before BREAK fires.
        // The BREAK detector still needs accel + ROC confirmation to fire the actual trade,
        // which means the trade entry is ~10-30 seconds AFTER the spike starts. This alert
        // tells you a coil is mature so you can place a manual limit just inside the edges
        // (e.g., buy stop $5 above coilHi, sell stop $5 below coilLo) and get filled at the
        // optimal level on the break, regardless of when the bot's BREAK signal lands.
        // NAS-only because XAU coils often produce false breaks and BTC has weekend chop.
        //
        // FIX 2026-05-16: require minimum coil range to suppress false alerts on flat
        // (market-closed) ticks where breakFrozenHi == breakFrozenLo gives a $0 "coil".
        if (isNASt && s.breakCoilActive && !s.coilArmedAlerted) {
          const coilAge = bNow - s.breakCoilStart;
          const coilRange = s.breakFrozenHi - s.breakFrozenLo;
          const coilMinRangeForAlert = 8; // NAS: need ≥$8 spread to be a real coil (not flat ticks)
          // FIX 2026-05-19: suppress COIL ARMED when chop is active OR outside RTH.
          // Reasoning: user reported "many mobile pings, no actual signals on PC". The
          // subsequent BREAK trade signal gets blocked by NAS chop mode + winners-only
          // gates, so alerting about a coil whose breakout won't trade is pure noise.
          // RTH-only because NAS overnight coils have thinner liquidity and more false
          // breaks. Combined effect: drops alert frequency 60-80% while preserving
          // the alerts that actually correspond to high-quality breakout setups.
          const etMinForCoilArm = gET();
          const inRthForCoil = etMinForCoilArm >= 570 && etMinForCoilArm < 960; // 9:30-16:00 ET
          if (s.chopActive) {
            // silent skip — chop block will reject any BREAK that follows anyway
          } else if (!inRthForCoil) {
            // silent skip — overnight NAS coils are too noisy for the alert to be useful
          } else if (coilAge >= 180000 && coilRange >= coilMinRangeForAlert) { // 3 minutes + real range
            const coilMid = (s.breakFrozenHi + s.breakFrozenLo) / 2;
            const upperBreak = (s.breakFrozenHi + escapeMin).toFixed(2);
            const lowerBreak = (s.breakFrozenLo - escapeMin).toFixed(2);
            const ageMin = (coilAge / 60000).toFixed(1);
            log(sym, '🎯 COIL ARMED — coiled ' + ageMin + 'min in $' + s.breakFrozenLo.toFixed(2) + '-$' + s.breakFrozenHi.toFixed(2) + ' (range $' + coilRange.toFixed(2) + ', mid $' + coilMid.toFixed(2) + '). Watch break ↑$' + upperBreak + ' or ↓$' + lowerBreak + '.');
            sendPush('🎯 ' + sym + ' COIL ARMED', 'Coiled ' + ageMin + 'min @ $' + s.breakFrozenLo.toFixed(2) + '-$' + s.breakFrozenHi.toFixed(2) + ' (mid $' + coilMid.toFixed(2) + ') · Place limit ↑$' + upperBreak + ' or ↓$' + lowerBreak, 'coil-armed');
            s.coilArmedAlerted = true;
            s.coilArmedAlertedTs = bNow;

            // QQQ MIRROR (added 2026-05-16): during RTH (9:30-16:00 ET), also emit a QQQ COIL
            // ARMED alert with the proportional break levels. QQQ tracks NAS at ratio ~41×
            // (NAS $29200 ≈ QQQ $711). This lets you pre-position QQQ 0DTE options against the
            // same coil — a NAS $20 coil = QQQ $0.49 range, easy to set limits around.
            // RTH-only because QQQ is thinly liquid pre/post market.
            try {
              const qqqState = S['QQQ'];
              const etMinCoil = gET();
              if (qqqState && qqqState.lastPrice > 0 && etMinCoil >= 570 && etMinCoil < 960) {
                const ratio = qqqState.lastPrice / price; // QQQ price per 1pt NAS
                const qqqCoilHi = (s.breakFrozenHi * ratio).toFixed(2);
                const qqqCoilLo = (s.breakFrozenLo * ratio).toFixed(2);
                const qqqCoilMid = (coilMid * ratio).toFixed(2);
                const qqqUpper = ((s.breakFrozenHi + escapeMin) * ratio).toFixed(2);
                const qqqLower = ((s.breakFrozenLo - escapeMin) * ratio).toFixed(2);
                const qqqRange = (coilRange * ratio).toFixed(2);
                log('QQQ', '🎯 COIL ARMED (mirrored from NAS100) — projected $' + qqqCoilLo + '-$' + qqqCoilHi + ' (range $' + qqqRange + ', mid $' + qqqCoilMid + '). Watch break ↑$' + qqqUpper + ' or ↓$' + qqqLower + '.');
                sendPush('🎯 QQQ COIL ARMED (NAS mirror)', 'Projected $' + qqqCoilLo + '-$' + qqqCoilHi + ' (mid $' + qqqCoilMid + ') · Watch ↑$' + qqqUpper + ' or ↓$' + qqqLower, 'coil-armed');
              }
            } catch (e) { /* never crash on mirror; the primary NAS alert already fired */ }
          }
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
      s.sessionHigh = -Infinity; s.sessionLow = Infinity; s.rsiAtSessionHigh = 50; s.rsiAtSessionLow = 50;
      s.sessionHighUpdateTs = 0; s.sessionLowUpdateTs = 0;
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

// ===== /state/:sym — gate diagnostic endpoint (added 2026-05-20) =====
// Returns the state vars that the gates read from, so we can debug why a gate
// fired or didn't fire without parsing logs. Especially useful for the multi-day
// regime gate (dailyLevels + macroSnaps + computed netChgPct).
app.get('/state/:sym', (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const s = S[sym];
  if (!s) return res.status(404).json({ error: 'Unknown symbol: ' + sym });

  // Compute live regime classification using the same logic as enrichSig
  const price = s.lastPrice || 0;
  const isXAU = sym === 'XAU';
  const isBTC = sym === 'BTC';
  const isNAS = sym === 'NAS100';
  let regimeWindow = null, regimeNetChgPct = null, regimeDir = 'neutral', regimeStrength = 0;
  if (price > 0) {
    if (s.dailyLevels && s.dailyLevels.length >= 5) {
      const oldestDay = s.dailyLevels[0];
      if (oldestDay && oldestDay.high > 0 && oldestDay.low > 0) {
        const oldestMid = (oldestDay.high + oldestDay.low) / 2;
        regimeNetChgPct = ((price - oldestMid) / oldestMid) * 100;
        regimeWindow = '5-day (dailyLevels)';
      }
    }
    if (regimeNetChgPct === null && s.macroSnaps && s.macroSnaps.length > 0) {
      const oldest = s.macroSnaps[0];
      const ageHours = (Date.now() - oldest.ts) / 3600000;
      if (ageHours >= 24 && oldest.p > 0) {
        regimeNetChgPct = ((price - oldest.p) / oldest.p) * 100;
        regimeWindow = (ageHours >= 96 ? '4-day' : ageHours >= 48 ? '2-day' : '1-day') + ' (macroSnaps fallback, ' + ageHours.toFixed(1) + 'h)';
      }
    }
    if (regimeNetChgPct !== null) {
      const strongThr = isXAU ? 2.0 : isBTC ? 5.0 : isNAS ? 3.0 : 1.0;
      const weakThr   = isXAU ? 1.0 : isBTC ? 2.5 : isNAS ? 1.5 : 0.5;
      if (regimeNetChgPct >=  strongThr) { regimeDir = 'bull'; regimeStrength = 2; }
      else if (regimeNetChgPct <= -strongThr) { regimeDir = 'bear'; regimeStrength = 2; }
      else if (regimeNetChgPct >=  weakThr) { regimeDir = 'bull'; regimeStrength = 1; }
      else if (regimeNetChgPct <= -weakThr) { regimeDir = 'bear'; regimeStrength = 1; }
    }
  }

  res.json({
    symbol: sym,
    lastPrice: price,
    sessionHigh: s.sessionHigh === -Infinity ? null : s.sessionHigh,
    sessionLow: s.sessionLow === Infinity ? null : s.sessionLow,
    rsiAtSessionHigh: s.rsiAtSessionHigh,
    rsiAtSessionLow: s.rsiAtSessionLow,
    rollingHigh: s.rollingHigh || 0,
    rollingLow: s.rollingLow === Infinity ? null : s.rollingLow,
    chopActive: !!s.chopActive,
    weekendBtcPutOnly: !!s._weekendBtcPutOnly,
    breakCoilActive: !!s.breakCoilActive,
    breakFrozenHi: s.breakFrozenHi || null,
    breakFrozenLo: s.breakFrozenLo === Infinity ? null : s.breakFrozenLo,
    obZone: s.obZone || null,
    obMitigated: !!s.obMitigated,
    obDeparted: !!s.obDeparted,
    trade: s.trade && s.trade.active ? {
      type: s.trade.type, ep: s.trade.ep,
      t1: s.trade.t1, t2: s.trade.t2,
      slPrice: s.trade.slPrice, tp1Price: s.trade.tp1Price,
      tp2Price: s.trade.tp2Price, tp3Price: s.trade.tp3Price,
      ageMin: s.trade.ts ? Math.round((Date.now() - s.trade.ts) / 60000) : null
    } : null,
    dailyLevels: {
      count: (s.dailyLevels || []).length,
      data: s.dailyLevels || []
    },
    macroSnaps: {
      count: (s.macroSnaps || []).length,
      oldest: s.macroSnaps && s.macroSnaps.length > 0 ? {
        price: s.macroSnaps[0].p,
        ageHours: +((Date.now() - s.macroSnaps[0].ts) / 3600000).toFixed(2)
      } : null
    },
    regime: regimeNetChgPct !== null ? {
      window: regimeWindow,
      netChgPct: +regimeNetChgPct.toFixed(3),
      direction: regimeDir,
      strength: regimeStrength === 2 ? 'STRONG' : regimeStrength === 1 ? 'WEAK' : 'NEUTRAL',
      callBlockedBelow: regimeStrength > 0 && regimeDir === 'bear' ? (regimeStrength === 2 ? 6 : 5) : null,
      putBlockedBelow: regimeStrength > 0 && regimeDir === 'bull' ? (regimeStrength === 2 ? 6 : 5) : null
    } : { status: 'insufficient data (need 5 daily levels or 24h+ macroSnaps)' },
    macroAlignment: {
      callStableSinceMin: s.fullConvSinceCall > 0 ? Math.round((Date.now() - s.fullConvSinceCall) / 60000) : null,
      putStableSinceMin: s.fullConvSincePut > 0 ? Math.round((Date.now() - s.fullConvSincePut) / 60000) : null,
      callContraBlockMin: s.macroContraBlockCallUntil > Date.now() ? Math.round((s.macroContraBlockCallUntil - Date.now()) / 60000) : null,
      putContraBlockMin: s.macroContraBlockPutUntil > Date.now() ? Math.round((s.macroContraBlockPutUntil - Date.now()) / 60000) : null
    },
    lastSignalDir: s.lastSignalDir,
    lastSignalAgeMin: s.lastSignalTs > 0 ? Math.round((Date.now() - s.lastSignalTs) / 60000) : null,
    dailySignalCount: s.dailySignalCount || 0
  });
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
        // OTE (Optimal Trade Entry) fields — EA uses oteLimit as limit-order price with
        // fallback to delayed-market entry if oteExpiry passes without fill. Only set for
        // DIV/ATH/ATL/BREAK signals (the "patient" detectors where waiting for retracement
        // gives meaningfully better fills). Null on FAST/SQZ/SWEEP/VREV/TREND/MFLIP.
        oteLimit: s.trade.oteLimit || null,
        oteExpiry: s.trade.oteExpiry || null,
        oteImpulseHi: s.trade.oteImpulseHi || null,
        oteImpulseLo: s.trade.oteImpulseLo || null,
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
      recentSignals: s.signals.slice(-5),
      // Blocked-attempt visibility (added 2026-05-22) — surfaces enrichSig gates that
      // suppressed signal emission. Useful for diagnosing over-gating, especially BTC.
      blocked: (s.blockedAttempts || []).length,
      recentBlocks: (s.blockedAttempts || []).slice(-5)
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
  // Enrich CSV with outcome columns (added 2026-05-12) by merging in outcomes from
  // signalHistory. The base file is write-once (header + per-fire rows); outcomes are
  // tracked separately in signalHistory and joined here at export time. Columns added:
  //   tp1Hit, tp2Hit, tp3Hit, slHit  — Y/blank
  //   finalOutcome — TP3 / TP2 / TP1-only / SL-after-TP1 / SL / Open
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    if (lines.length < 2) {
      res.header('Content-Type', 'text/csv');
      return res.send(raw);
    }
    // Header: original signal columns + outcome columns + post-signal price snapshots.
    // Snapshot columns added 2026-05-14: price5m/delta5m/price15m/delta15m/price30m/delta30m.
    // delta is signed by signal direction: positive = price moved IN signal direction (profit),
    // negative = adverse. Makes win/loss obvious at a glance independent of TP/SL hits.
    const enrichedHeader = lines[0].trim() + ',tp1Hit,tp2Hit,tp3Hit,slHit,finalOutcome,price5m,delta5m,price15m,delta15m,price30m,delta30m';
    const enrichedRows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',');
      const date = cols[0], time = cols[1], symbol = cols[2], type = cols[3], price = cols[4];
      // Match by (date,time,symbol,type,price) — unique per signal
      const entry = signalHistory.find(h =>
        h.date === date && h.time === time && h.symbol === symbol && h.type === type && String(h.price) === price
      );
      const o = entry && entry.outcomes ? entry.outcomes : {};
      const tp1 = o.tp1Hit ? 'Y' : '';
      const tp2 = o.tp2Hit ? 'Y' : '';
      const tp3 = o.tp3Hit ? 'Y' : '';
      const sl  = o.slHit  ? 'Y' : '';
      let final;
      if (o.tp3Hit)      final = 'TP3';
      else if (o.slHit)  final = o.tp1Hit ? 'SL-after-TP1' : 'SL';
      else if (o.tp2Hit) final = 'TP2';
      else if (o.tp1Hit) final = 'TP1-only';
      else               final = 'Open';
      // Post-signal price snapshots. Delta is positive = profitable (price moved in signal direction).
      // For CALL: delta = priceN - entryPrice. For PUT: delta = entryPrice - priceN.
      const snaps = entry && entry.priceSnaps ? entry.priceSnaps : {};
      const entryPx = parseFloat(price);
      const sign = (type === 'call') ? 1 : -1;
      const fmtPx = (v) => (v == null ? '' : v.toFixed(2));
      const fmtDelta = (v) => (v == null || !isFinite(entryPx) ? '' : ((v - entryPx) * sign).toFixed(2));
      const p5  = fmtPx(snaps.p5m),  d5  = fmtDelta(snaps.p5m);
      const p15 = fmtPx(snaps.p15m), d15 = fmtDelta(snaps.p15m);
      const p30 = fmtPx(snaps.p30m), d30 = fmtDelta(snaps.p30m);
      enrichedRows.push(line + ',' + tp1 + ',' + tp2 + ',' + tp3 + ',' + sl + ',' + final + ',' + p5 + ',' + d5 + ',' + p15 + ',' + d15 + ',' + p30 + ',' + d30);
    }
    res.header('Content-Type', 'text/csv');
    res.send(enrichedHeader + '\n' + enrichedRows.join('\n') + (enrichedRows.length ? '\n' : ''));
  } catch (e) {
    console.error('[' + ts() + '] CSV export error for ' + dateStr + ': ' + e.message);
    res.status(500).json({ error: 'Failed to read/enrich CSV: ' + e.message });
  }
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

// ===== TRUMP TWEET INGESTION =====
// POST /trump/post — feed in new tweets. Token-protected via ADMIN_TOKEN env var.
// Body: { id: "post-id", text: "tweet body", ts?: timestamp_ms }
// The id is used for deduplication — if you POST the same id twice, the second is ignored.
//
// Recommended setup: Pipedream/Zapier/your-own-poller subscribes to a Truth Social or X
// feed, then POSTs each new post to this endpoint. Server runs sentiment analysis and
// updates the global trumpBias state, which feeds into convictionFor() as the TRUMP factor.
app.post('/trump/post', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN not configured — endpoint disabled' });
  if (req.query.token !== adminToken) return res.status(401).json({ error: 'Invalid or missing token' });
  const { id, text, ts: postTs } = req.body || {};
  if (!id || !text) return res.status(400).json({ error: 'Missing id or text' });
  // Dedupe — same post arriving twice is a no-op
  if (id === trumpLastPostId) {
    return res.json({ ok: true, deduped: true, lastClassification: trumpLastClassification });
  }
  try {
    const classification = await classifyTrumpPost(text);
    applyTrumpClassification(id, text, classification);
    res.json({
      ok: true,
      classification,
      currentBias: { biases: { ...trumpBiases }, intensity: trumpIntensity, ageMs: Date.now() - trumpBiasTs }
    });
  } catch (e) {
    res.status(500).json({ error: 'Classify failed: ' + e.message });
  }
});

// GET /trump/state — monitor what bias is currently active and last classified post
app.get('/trump/state', (req, res) => {
  const ageMs = trumpBiasTs ? Date.now() - trumpBiasTs : null;
  const fresh = ageMs !== null && ageMs < TRUMP_BIAS_TTL_MS;
  // Build per-symbol view that bot badges + convictionFor consumers can read directly.
  const freshBiases = {};
  TRUMP_VALID_SYMBOLS.forEach(s => {
    freshBiases[s] = fresh ? (trumpBiases[s] || 'neutral') : 'neutral';
  });
  // Derive legacy fields so the previous /trump/state consumers keep working during rollout.
  const nonNeutral = TRUMP_VALID_SYMBOLS.filter(s => freshBiases[s] !== 'neutral');
  const bullishCount = nonNeutral.filter(s => freshBiases[s] === 'bullish').length;
  const bearishCount = nonNeutral.filter(s => freshBiases[s] === 'bearish').length;
  const derivedBias = nonNeutral.length === 0 ? 'neutral' : (bullishCount >= bearishCount ? 'bullish' : 'bearish');
  res.json({
    biases: freshBiases,                 // new — per-symbol direction map
    bias: derivedBias,                   // legacy — dominant direction across symbols
    instruments: nonNeutral,             // legacy — symbols with non-neutral bias
    intensity: fresh ? trumpIntensity : 0,
    biasAgeMin: ageMs !== null ? Math.round(ageMs / 60000) : null,
    biasTtlMin: Math.round(TRUMP_BIAS_TTL_MS / 60000),
    minIntensity: TRUMP_MIN_INTENSITY,
    classifierEnabled: !!ANTHROPIC_API_KEY,
    classifierModel: ANTHROPIC_API_KEY ? TRUMP_CLASSIFIER_MODEL : 'heuristic-fallback',
    classifyCount: trumpClassifyCount,
    lastPostId: trumpLastPostId,
    lastPostText: trumpLastPostText,
    lastClassification: trumpLastClassification
  });
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
  loadTrumpState();
  console.log('[' + ts() + '] Trump factor: ' + (ANTHROPIC_API_KEY ? 'enabled (' + TRUMP_CLASSIFIER_MODEL + ')' : 'enabled (heuristic-only — set ANTHROPIC_API_KEY for accurate classification)') + ', TTL ' + Math.round(TRUMP_BIAS_TTL_MS / 60000) + 'min, min-intensity ' + TRUMP_MIN_INTENSITY);
  console.log('[' + ts() + '] Trump feed poller: ' + (TRUMP_FEED_URL ? 'enabled, every ' + Math.round(TRUMP_POLL_INTERVAL_MS / 60000) + 'min from ' + TRUMP_FEED_URL : 'disabled (set TRUMP_FEED_URL to enable auto-polling, or POST manually to /trump/post)'));
  connectFinnhub();
  fetchVIX();
  fetchDXY();
  fetchTLT();
  fetchSLV();
  fetchGDX();

  // Start real-time 0DTE option premium tracker (QQQ/SPY)
  startOptionPoller();

  // Save state on shutdown (deploy/restart) so TRv2 trades survive
  process.on('SIGTERM', () => { console.log('[' + ts() + '] SIGTERM — saving state...'); saveTrv2State(); saveRollingLevels(); process.exit(0); });
  process.on('SIGINT', () => { console.log('[' + ts() + '] SIGINT — saving state...'); saveTrv2State(); saveRollingLevels(); process.exit(0); });
});
