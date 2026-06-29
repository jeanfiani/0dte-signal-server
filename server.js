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
// MT5 safety valve (added 2026-06-11, audit v2 A1). MT5 stays deliberately loose —
// 24h markets need freedom — but a runaway day no longer gets unlimited signals.
// Raised 20→35 on 2026-06-19 (Phase 3.19) — XAU hit the 20 cap by 10:00 ET on a
// moderately active day, missed entire $4150→$4183 spike. 35 still trips on
// genuinely runaway days but leaves headroom for STRUCT_LIQ_GRAB + RIDE + OBREJ
// to all fire across XAU/BTC/NAS during US session. Override via env MAX_SIG_MT5.
const MAX_SIG_MT5 = parseInt(process.env.MAX_SIG_MT5 || '35', 10);

// ===== PHASE 3.61 — BTC FINNHUB CRYPTO SYMBOL (2026-06-27, task #250) =====
// Finnhub's standard format for crypto is 'EXCHANGE:PAIR'. Defaults to Binance BTCUSDT
// (highest volume globally). Coinbase/Kraken alternatives selectable via env. Used by
// the WS subscribe loop + message handler. BTC PRICE remains sourced from MT5 — Finnhub
// crypto is consumed for VOLUME ONLY (populates S.BTC.volBuckets for VOL× conviction).
const BTC_FH_SYMBOL = process.env.BTC_FH_SYMBOL || 'BINANCE:BTCUSDT';

// ===== PHASE 3.64 + 3.65 — FMP (FinancialModelingPrep) INTEGRATION (2026-06-28) =====
// Free tier: ~250 calls/day. Treasury polls every 6h (4 calls/day). BTC news polls
// every 30min (~48 calls/day). Total ~52/day << 250 quota.
const FMP_API_KEY = process.env.FMP_API_KEY || '';
let fmpTreasury = null;
let fmpBtcNews = null;
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
    // price30m/delta30m columns. Entries removed once all 3 captured. List: [{entry, fireTs}]
    // (entry = direct signalHistory entry reference — index-based refs removed 2026-06-11).
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
    // ===== PHASE 1 INFRASTRUCTURE — STRUCTURAL AWARENESS STATE (added 2026-06-17) =====
    // No behavior change yet — these fields are populated each tick by Phase 1 code
    // and consumed by Phase 2 gates / Phase 3 structure-first detectors.
    // Asian Session H/L Tracker (task #181): 19:00 ET prev day → 02:00 ET today
    asianH: null,              // highest tick price during current Asian session
    asianL: null,              // lowest tick price during current Asian session
    asianRange: 0,             // asianH - asianL (filled at session end)
    asianH_locked: null,       // locked at session end — used by Phase 3 sweep detection
    asianL_locked: null,       // locked at session end
    asianStartTs: 0,           // when current Asian window opened (resets daily)
    asianLockedDate: null,     // YYYY-MM-DD when locked values were saved (per-day stability)
    // Killzone Clock (task #182): tagged every tick
    session: null,             // 'asian' | 'londonKZ' | 'londonOpen' | 'nyAM' | 'nyLunch' | 'nyPM' | 'overnight'
    inKillzone: false,         // true during londonKZ or nyAM (high-volatility windows)
    sessionStartTs: 0,         // when current session started
    // HTF Bias Module (task #183): 1h and 4h trend direction from macroSnaps
    htf1h_dir: null,           // 'up' | 'down' | 'flat' — 1-hour trend bias
    htf4h_dir: null,           // 'up' | 'down' | 'flat' — 4-hour trend bias
    htf1h_strength: 0,         // % change over 1h window
    htf4h_strength: 0,         // % change over 4h window
    // VWAP per symbol (task #184): session VWAP, resets at 18:00 ET (new trading day)
    vwap: null,                // session-anchored VWAP
    vwapNum: 0,                // numerator: Σ(price × volume_proxy)
    vwapDen: 0,                // denominator: Σ(volume_proxy)
    vwapDistPct: 0,            // % distance from VWAP (positive = above, negative = below)
    vwapDir: null,             // 'above' | 'below' | 'at'
    vwapAnchorTs: 0,           // when current VWAP session anchored
    // Liquidity Pool Detector (task #185): equal H/L within 0.1% = stop pool
    liqPoolsAbove: [],         // [{price, touches, ageMin}] sorted nearest-first
    liqPoolsBelow: [],         // [{price, touches, ageMin}] sorted nearest-first
    liqPoolsTs: 0,             // last computation timestamp (rate-limited)
    // Premium/Discount Zone Tracker (task #186)
    rangeZone: null,           // 'premium' (top 30%) | 'equilibrium' (middle 40%) | 'discount' (bottom 30%)
    rangePosPct: null,         // 0-100, position within active range
    rangeRef: null,            // 'asian' | 'rolling' — which range was used
    rangeRefHi: null,          // the high used for the calc
    rangeRefLo: null,          // the low used for the calc
    // Economic Calendar / News Blackout (task #187): set globally by pollEconomicCalendar
    newsBlackout: { active: false, eventName: null, minutesUntil: null, impact: null, eventTs: 0 },
    // Round Number Tracker enhancement (task #188)
    roundNumLevel: null,       // nearest round number ($50 XAU, $1000 BTC, $100 NAS)
    roundNumDist: null,        // absolute distance from current price
    nearRoundNumber: false,    // within proximity threshold (instrument-specific)
    // ===== PHASE 3 — STRUCTURE-FIRST DETECTORS (added 2026-06-17, tasks #196-#199) =====
    // STRUCT_SWEEP (Judas Swing) — Asian H/L sweep + reversal
    asianSweptHigh: false,        // price has breached asianH_locked + buffer
    asianSweptLow: false,         // price has breached asianL_locked - buffer
    asianSweepHighTs: 0,          // when high was first swept (used for cooldown after fire)
    asianSweepLowTs: 0,
    asianSweepHighPeak: 0,        // peak price reached above asianH during sweep
    asianSweepLowTrough: 0,       // lowest price reached below asianL during sweep
    structSweepLastTs: 0,         // cooldown after STRUCT_SWEEP fires (per side)
    structSweepLastDir: null,
    // Phase 3.9 (task #205) — Session lock tracking
    // Track when price first went above/below Asian range — if it stays there >30 min
    // without returning inside, the Asian setup is invalidated for the rest of the session.
    asianAboveSince: 0,           // timestamp when price first went above asianH (continuous)
    asianBelowSince: 0,           // timestamp when price first went below asianL (continuous)
    asianSweepInvalidated: false, // session lock — set true on clean break, reset at new Asian
    // STRUCT_OB_FILL — deep OB retracement with confirmation
    structOBFillLastTs: 0,        // cooldown after fire
    structOBFillLastObTs: 0,      // ID of last OB we fired on (don't double-fire same OB)
    // STRUCT_LIQ_GRAB — liquidity pool sweep + reversal
    structLiqGrabLastTs: 0,
    liqSweptAbovePrice: 0,        // most recently swept pool price (above)
    liqSweptBelowPrice: 0,
    liqSweptAboveTs: 0,
    liqSweptBelowTs: 0,
    // STRUCT_VWAP_BOUNCE — VWAP rejection in HTF direction
    structVwapLastTs: 0,
    vwapTouchedTs: 0,             // when price last touched VWAP (within 0.05%)
    vwapTouchedSide: null,        // 'above' if touched from above (rejection rally), 'below' if from below
    // ===== PHASE 3.5 — INVERSAL_BREAK (task #200) — replaces BREAK detector =====
    // Universal failed-breakout detector. Watches multiple level types simultaneously and
    // fires opposite-direction on sweep+reversal pattern (Judas swing / stop hunt).
    sweptLevels: {                // Track sweep state for each level type
      rolling5dHi: { swept: false, ts: 0, extreme: 0, level: 0 },
      rolling5dLo: { swept: false, ts: 0, extreme: 0, level: 0 },
      pdh:         { swept: false, ts: 0, extreme: 0, level: 0 },
      pdl:         { swept: false, ts: 0, extreme: 0, level: 0 },
      roundNumAbv: { swept: false, ts: 0, extreme: 0, level: 0 },
      roundNumBlw: { swept: false, ts: 0, extreme: 0, level: 0 },
      localHi60:   { swept: false, ts: 0, extreme: 0, level: 0 },
      localLo60:   { swept: false, ts: 0, extreme: 0, level: 0 },
      obHi:        { swept: false, ts: 0, extreme: 0, level: 0 },
      obLo:        { swept: false, ts: 0, extreme: 0, level: 0 }
    },
    inversalLastTs: 0,            // cooldown
    inversalLastDir: null,        // last fire direction (anti-flip)
    localHi60min: 0,              // computed from recent macroSnaps (12 = 60 min)
    localLo60min: 0,
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
      // F1 (2026-06-12): restore macroSnaps (keep entries < 6h old — the rolling window)
      if (Array.isArray(data[sym].macroSnaps)) {
        const snapCutoff = Date.now() - 6 * 3600000;
        S[sym].macroSnaps = data[sym].macroSnaps.filter(sn => sn && sn.ts > snapCutoff && sn.p > 0);
      }
      // Migration: if old format (rollingHighs/rollingLows arrays), discard — will rebuild from today's session
    });
    // ===== ASIAN H/L RESTORATION (task #207, added 2026-06-17) =====
    SYMBOLS.forEach(sym => {
      if (!data[sym]) return;
      if (data[sym].asianH_locked !== undefined && data[sym].asianH_locked !== null) {
        S[sym].asianH_locked = data[sym].asianH_locked;
      }
      if (data[sym].asianL_locked !== undefined && data[sym].asianL_locked !== null) {
        S[sym].asianL_locked = data[sym].asianL_locked;
      }
      if (data[sym].asianLockedDate) S[sym].asianLockedDate = data[sym].asianLockedDate;
      if (typeof data[sym].asianSweepInvalidated === 'boolean') S[sym].asianSweepInvalidated = data[sym].asianSweepInvalidated;
      if (data[sym].asianAboveSince) S[sym].asianAboveSince = data[sym].asianAboveSince;
      if (data[sym].asianBelowSince) S[sym].asianBelowSince = data[sym].asianBelowSince;
    });
    console.log('[' + ts() + '] Rolling levels loaded — XAU: ' + S.XAU.dailyLevels.length + ' days, high:$' + (S.XAU.rollingHigh || 0).toFixed(2) + ' low:$' + (S.XAU.rollingLow === Infinity ? 0 : S.XAU.rollingLow).toFixed(2));
    SYMBOLS.forEach(sym => {
      if (S[sym].asianH_locked) {
        console.log('[' + ts() + '] Asian H/L restored — ' + sym + ': H=$' + S[sym].asianH_locked.toFixed(2) + ' L=$' + S[sym].asianL_locked.toFixed(2) + ' (locked ' + S[sym].asianLockedDate + ')');
      }
    });
  } catch (e) {
    console.log('[' + ts() + '] Rolling levels: no data file (will build from scratch)');
  }

  // ===== MANUAL ASIAN H/L SEED FOR 2026-06-17 (task #208, one-time bootstrap) =====
  // Today's Asian H/L was wiped by mid-day deploys. User-provided values from
  // their charting platform (chart confirmed Asian range $4318 - $4348 for XAU).
  // Only applies if no value is currently locked for today (idempotent — if
  // already restored from disk OR locked normally, this is a no-op).
  const todayET = todayDateET();
  const seedValues = {
    XAU:    { h: 4348,  l: 4318  },
    BTC:    { h: 66050, l: 65400 },
    NAS100: { h: 30150, l: 29960 }
  };
  Object.keys(seedValues).forEach(sym => {
    const s = S[sym];
    if (!s) return;
    if (s.asianLockedDate === todayET) return; // already locked for today, leave alone
    const seed = seedValues[sym];
    s.asianH_locked = seed.h;
    s.asianL_locked = seed.l;
    s.asianLockedDate = todayET;
    s.asianSweepInvalidated = false;
    s.asianAboveSince = 0;
    s.asianBelowSince = 0;
    console.log('[' + ts() + '] 🌱 Asian H/L SEEDED for ' + sym + ': H=$' + seed.h.toFixed(2) + ' L=$' + seed.l.toFixed(2) + ' (date ' + todayET + ', manual override)');
  });
  // Save immediately so the seed persists across the next restart
  try { saveRollingLevels(); } catch (e) {}
}
// ===== PHASE 3.68 — MANUAL DAILY LEVELS SEED (2026-06-29, task #255) =====
// One-time bootstrap of dailyLevels for symbols missing 5 days of history.
// Sourced from FMP free-tier (GCUSD for XAU proxy, BTCUSD direct). NAS100 omitted —
// no free-tier source; will self-populate via Phase 3.67 over 5 days. Idempotent:
// only seeds if a symbol's dailyLevels is currently empty. Saves immediately so
// the seed persists across the next restart.
function seedDailyLevels() {
  const DAILY_SEED_VALUES = {
    XAU: [
      { date: '2026-06-24', high: 4132.40, low: 3975.70 },
      { date: '2026-06-25', high: 4060.00, low: 3976.30 },
      { date: '2026-06-26', high: 4111.50, low: 3998.10 },
      { date: '2026-06-27', high: 4102.90, low: 4062.60 },
      { date: '2026-06-28', high: 4102.90, low: 4062.60 }
    ],
    BTC: [
      { date: '2026-06-24', high: 63156.34, low: 59010.74 },
      { date: '2026-06-25', high: 61868.39, low: 58000.00 },
      { date: '2026-06-26', high: 60660.00, low: 58243.36 },
      { date: '2026-06-27', high: 60838.92, low: 59765.10 },
      { date: '2026-06-28', high: 60455.00, low: 58810.11 }
    ]
  };
  let seededCount = 0;
  Object.keys(DAILY_SEED_VALUES).forEach(sym => {
    const s = S[sym];
    if (!s) return;
    s.dailyLevels = Array.isArray(s.dailyLevels) ? s.dailyLevels : [];
    // PHASE 3.68c — MERGE missing historical entries instead of overwriting.
    // Phase 3.67 self-populating adds today's entry; we only want to add the
    // HISTORICAL days that aren't already present. Match by date.
    const existingDates = new Set(s.dailyLevels.map(d => d.date));
    const toAdd = DAILY_SEED_VALUES[sym].filter(d => !existingDates.has(d.date));
    if (toAdd.length === 0) {
      console.log('[' + ts() + '] 📅 ' + sym + ' dailyLevels already has all seed dates (' + s.dailyLevels.length + ' entries) — no merge needed');
      return;
    }
    s.dailyLevels = s.dailyLevels.concat(toAdd);
    // Sort by date ascending, then keep last 5 (most recent)
    s.dailyLevels.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (s.dailyLevels.length > 5) s.dailyLevels = s.dailyLevels.slice(-5);
    s.rollingHigh = Math.max(...s.dailyLevels.map(d => d.high));
    s.rollingLow  = Math.min(...s.dailyLevels.map(d => d.low));
    seededCount++;
    console.log('[' + ts() + '] 🌱 ' + sym + ' dailyLevels MERGED: +' + toAdd.length + ' historical, total ' + s.dailyLevels.length + ' days, rolling H:$' + s.rollingHigh.toFixed(2) + ' L:$' + s.rollingLow.toFixed(2));
  });
  if (seededCount > 0) {
    try { saveRollingLevels(); console.log('[' + ts() + '] 💾 Seed persisted to disk'); } catch (e) {}
  }
}

function saveRollingLevels() {
  const data = {};
  SYMBOLS.forEach(sym => {
    data[sym] = {
      dailyLevels: S[sym].dailyLevels || [],
      // F1 (2026-06-12): persist macroSnaps so the multi-day/intraday regime gate survives
      // redeploys. In-memory-only snaps meant every deploy blinded the gate for 2h — on
      // 6/12 a ~09:10 deploy let 4 counter-trend QQQ PUTs through on a +1.5% call day.
      macroSnaps: S[sym].macroSnaps || [],
      // ===== ASIAN H/L PERSISTENCE (task #207, added 2026-06-17) =====
      // Without this, every server restart wipes Asian H/L tracking until the next
      // 19:00 ET Asian session begins. 6/17 case: deploys throughout the day left
      // STRUCT_SWEEP non-functional because asianH_locked/asianL_locked were null.
      asianH_locked:         S[sym].asianH_locked,
      asianL_locked:         S[sym].asianL_locked,
      asianLockedDate:       S[sym].asianLockedDate,
      asianSweepInvalidated: !!S[sym].asianSweepInvalidated,
      asianAboveSince:       S[sym].asianAboveSince || 0,
      asianBelowSince:       S[sym].asianBelowSince || 0
    };
  });
  try { fs.writeFileSync(ROLLING_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}
// Save rolling levels every 5 minutes
setInterval(saveRollingLevels, 300000);

// ===== PHASE 3.68b — PERIODIC SAFETY RE-SEED (2026-06-29, task #256) =====
// Brute-force: every 5 min, check if XAU/BTC dailyLevels is still empty. If yes,
// re-run seed. This handles the case where startup seed didn't fire for any reason
// (deploy issue, load order, persistence file overwrite, etc.). Idempotent — once
// dailyLevels has data, this becomes a no-op.
setInterval(() => {
  try {
    // PHASE 3.68c — periodic check now triggers when dailyLevels has fewer than 5 entries
    // (missing historical days). Phase 3.67 adds today, so length 1-4 means historical missing.
    const needsSeed = ['XAU', 'BTC'].some(sym => S[sym] && (!Array.isArray(S[sym].dailyLevels) || S[sym].dailyLevels.length < 5));
    if (needsSeed) {
      console.log('[' + ts() + '] 🔁 Phase 3.68c safety re-seed triggered (dailyLevels < 5 days)');
      seedDailyLevels();
    }
  } catch (e) {
    console.error('[' + ts() + '] Safety re-seed error: ' + e.message);
  }
}, 300000);

// F1 (2026-06-12): seed the equity regime at boot. macroSnaps are now persisted, but on a
// cold start (or after >6h offline, e.g. overnight) the regime gate would still be blind
// for 2h. Seed QQQ/SPY with the previous close from Finnhub, backdated 2.5h, so the gate
// computes a regime within minutes of boot instead of hours.
async function seedEquityRegime() {
  for (const sym of ['QQQ', 'SPY']) {
    try {
      const s = S[sym];
      if (!s) continue;
      const oldestTs = (s.macroSnaps && s.macroSnaps.length > 0) ? s.macroSnaps[0].ts : 0;
      if (oldestTs > 0 && (Date.now() - oldestTs) >= 2 * 3600000) continue; // window already deep enough
      const res = await fetch('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + API + '&_=' + Date.now());
      const d = await res.json();
      if (d && d.pc > 0) {
        s.macroSnaps = s.macroSnaps || [];
        s.macroSnaps.unshift({ ts: Date.now() - Math.round(2.5 * 3600000), p: d.pc });
        console.log('[' + ts() + '] ' + sym + ' regime seeded from prev close $' + d.pc.toFixed(2) + ' (backdated 2.5h) — regime gate live from boot.');
      }
    } catch (e) { console.log('[' + ts() + '] ' + sym + ' regime seed failed: ' + e.message); }
  }
}

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
  setTimeout(pollTrumpFeed, 10000);
  setInterval(pollTrumpFeed, TRUMP_POLL_INTERVAL_MS);
}

// ===== PHASE 3.64 — FMP TREASURY RATES POLLER (2026-06-28, task #252) =====
async function pollFmpTreasury() {
  if (!FMP_API_KEY) return;
  try {
    const today = new Date();
    const fromDate = new Date(today.getTime() - 10 * 86400000);
    const toStr = today.toISOString().slice(0, 10);
    const fromStr = fromDate.toISOString().slice(0, 10);
    const url = 'https://financialmodelingprep.com/api/v4/treasury?from=' + fromStr + '&to=' + toStr + '&apikey=' + FMP_API_KEY;
    const https = require('https');
    const body = await new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        let chunks = '';
        res.on('data', c => chunks += c);
        res.on('end', () => resolve(chunks));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    });
    const arr = JSON.parse(body);
    if (!Array.isArray(arr) || arr.length === 0) return;
    arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const history = arr.slice(0, 7).map(r => ({ date: r.date, y2: r.year2, y10: r.year10, y30: r.year30 }));
    let y10_chg_3d = null;
    if (history.length >= 3 && history[0].y10 != null && history[2].y10 != null) {
      y10_chg_3d = history[0].y10 - history[2].y10;
    }
    fmpTreasury = { history: history, lastPollTs: Date.now(), y10_chg_3d: y10_chg_3d };
    log('XAU', '💰 FMP Treasury: y10 ' + (history[0].y10 != null ? history[0].y10.toFixed(2) : '?') + '% (3d chg ' + (y10_chg_3d != null ? (y10_chg_3d >= 0 ? '+' : '') + y10_chg_3d.toFixed(3) : '?') + ')');
  } catch (e) {
    console.error('[' + ts() + '] FMP treasury poll failed:', e.message);
  }
}

// ===== PHASE 3.65 — FMP BTC NEWS SENTIMENT POLLER (2026-06-28, task #252) =====
const FMP_NEWS_BULL_KW = /\b(rally|rallies|rallied|surge|surged|breakout|breaks out|ATH|all-time high|accumulation|bullish|gains|rises|jumps|soars|skyrocket|moonshot|uptrend|bull run)\b/i;
const FMP_NEWS_BEAR_KW = /\b(crash|crashes|crashed|dump|dumped|dumping|sell-off|selloff|liquidation|bearish|plunge|tumble|tanks|correction|drop|drops|falls|slide|slumps|downtrend|capitulation)\b/i;
async function pollFmpBtcNews() {
  if (!FMP_API_KEY) return;
  try {
    const url = 'https://financialmodelingprep.com/api/v4/crypto_news?limit=20&apikey=' + FMP_API_KEY;
    const https = require('https');
    const body = await new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        let chunks = '';
        res.on('data', c => chunks += c);
        res.on('end', () => resolve(chunks));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    });
    const arr = JSON.parse(body);
    if (!Array.isArray(arr) || arr.length === 0) return;
    const btcItems = arr.filter(it => {
      const sym = (it.symbol || '').toUpperCase();
      const title = (it.title || '') + ' ' + (it.text || '').slice(0, 200);
      return sym.indexOf('BTC') === 0 || /\bbitcoin\b|\bBTC\b/i.test(title);
    }).slice(0, 15);
    if (btcItems.length === 0) {
      log('BTC', '📰 FMP news: no BTC items');
      return;
    }
    let bullScore = 0, bearScore = 0;
    btcItems.forEach(it => {
      const txtBody = (it.title || '') + ' ' + (it.text || '').slice(0, 500);
      if (FMP_NEWS_BULL_KW.test(txtBody)) bullScore++;
      if (FMP_NEWS_BEAR_KW.test(txtBody)) bearScore++;
    });
    const net = bullScore + bearScore > 0 ? (bullScore - bearScore) / (bullScore + bearScore) : 0;
    fmpBtcNews = { sentiment: net, bullScore: bullScore, bearScore: bearScore, itemCount: btcItems.length, headlines: btcItems.slice(0, 3).map(it => it.title), lastPollTs: Date.now() };
    log('BTC', '📰 FMP News: sentiment ' + (net >= 0 ? '+' : '') + net.toFixed(2) + ' (bull ' + bullScore + ' / bear ' + bearScore + ' / ' + btcItems.length + ' items)');
  } catch (e) {
    console.error('[' + ts() + '] FMP BTC news poll failed:', e.message);
  }
}

if (FMP_API_KEY) {
  setTimeout(pollFmpTreasury, 15000);
  setInterval(pollFmpTreasury, 6 * 3600 * 1000);
  setTimeout(pollFmpBtcNews, 20000);
  setInterval(pollFmpBtcNews, 30 * 60 * 1000);
  console.log('[STARTUP] FMP pollers scheduled (treasury 6hr, BTC news 30min)');
} else {
  console.log('[STARTUP] FMP_API_KEY not set — Phase 3.64/3.65 disabled');
}

// ===== PHASE 1.7 — ECONOMIC CALENDAR FEED (added 2026-06-17, task #187) =====
// Polls Finnhub's economic calendar for high-impact USD events (NFP, CPI, FOMC, Fed
// Chair speeches). Tracks the next event's time and current blackout status. Phase 2
// gates will read s.newsBlackout.active to block entries 15min before/30min after.
// Finnhub endpoint: /calendar/economic?from=YYYY-MM-DD&to=YYYY-MM-DD (free tier OK)
const NEWS_BLACKOUT_BEFORE_MIN = 15;   // block entries this many min BEFORE event
const NEWS_BLACKOUT_AFTER_MIN  = 30;   // block entries this many min AFTER event
let _econCalCache = { events: [], lastFetchTs: 0 };
async function pollEconomicCalendar() {
  try {
    const today    = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const url = 'https://finnhub.io/api/v1/calendar/economic?from=' + today + '&to=' + tomorrow + '&token=' + API;
    const r = await fetch(url);
    if (!r.ok) {
      // 403 likely means free tier doesn't include this endpoint — fail silently
      if (r.status === 403 || r.status === 401) {
        console.log('[' + ts() + '] Economic calendar: Finnhub access denied (' + r.status + '). Endpoint may require paid tier.');
      }
      return;
    }
    const d = await r.json();
    if (!d || !d.economicCalendar) return;
    // Keep only US events with high impact OR keyword match for known market-movers
    const keywords = ['nfp', 'non-farm', 'cpi', 'fomc', 'fed funds', 'fed rate', 'interest rate decision', 'powell', 'jerome powell', 'ppi', 'gdp', 'unemployment', 'retail sales'];
    const usdEvents = (d.economicCalendar || [])
      .filter(e => e && (e.country === 'US' || e.country === 'USD'))
      .filter(e => {
        const hi = (e.impact || '').toLowerCase() === 'high';
        const ev = (e.event || '').toLowerCase();
        const kw = keywords.some(k => ev.includes(k));
        return hi || kw;
      })
      .map(e => {
        // Finnhub returns time as "YYYY-MM-DD HH:MM:SS" — assume UTC
        const tStr = (e.time || '').replace(' ', 'T') + 'Z';
        const eventTs = new Date(tStr).getTime();
        return { event: e.event, time: e.time, impact: e.impact, ts: isNaN(eventTs) ? 0 : eventTs };
      })
      .filter(e => e.ts > 0 && e.ts > (Date.now() - NEWS_BLACKOUT_AFTER_MIN * 60000)) // keep recent past too (still in blackout)
      .sort((a, b) => a.ts - b.ts);
    _econCalCache = { events: usdEvents, lastFetchTs: Date.now() };
    if (usdEvents.length > 0) {
      const next = usdEvents[0];
      const minsUntil = Math.round((next.ts - Date.now()) / 60000);
      console.log('[' + ts() + '] Economic calendar: ' + usdEvents.length + ' events tracked. Next: ' + next.event + ' in ' + minsUntil + 'min (' + (next.impact || 'unknown') + ' impact).');
    }
  } catch (e) {
    console.log('[' + ts() + '] Economic calendar poll failed: ' + e.message);
  }
}
// Apply blackout state to all symbols based on cached events. Runs every 30 sec.
function applyEconomicCalendarBlackout() {
  const now = Date.now();
  const events = _econCalCache.events || [];
  // Find the most relevant event: nearest one within blackout window, or the next future event
  let active = false, eventName = null, minutesUntil = null, impact = null, eventTs = 0;
  for (const e of events) {
    const minsUntil = (e.ts - now) / 60000;
    if (minsUntil >= -NEWS_BLACKOUT_AFTER_MIN && minsUntil <= NEWS_BLACKOUT_BEFORE_MIN) {
      active = true; eventName = e.event; minutesUntil = Math.round(minsUntil); impact = e.impact; eventTs = e.ts;
      break;
    }
  }
  // If no event in blackout, report next future event for visibility
  if (!active) {
    for (const e of events) {
      if (e.ts > now) {
        eventName = e.event;
        minutesUntil = Math.round((e.ts - now) / 60000);
        impact = e.impact;
        eventTs = e.ts;
        break;
      }
    }
  }
  SYMBOLS.forEach(sym => {
    const s = S[sym];
    if (!s) return;
    s.newsBlackout = { active, eventName, minutesUntil, impact, eventTs };
  });
}
// Initial fetch and recurring schedule
setTimeout(pollEconomicCalendar, 5000);                  // first fetch 5s after startup
setInterval(pollEconomicCalendar, 10 * 60 * 1000);       // refresh full calendar every 10 min
setInterval(applyEconomicCalendarBlackout, 30 * 1000);   // recompute blackout state every 30 sec

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
// ===== PHASE 3.66 — RECENCY OVERRIDE HELPER (2026-06-28, task #253) =====
// Multi-day regime gates lock to BULL/BEAR direction once dailyLevels updates at
// midnight UTC. They can't see today's intraday action. This helper checks last
// 24h move via macroSnaps and downgrades regime to neutral when today contradicts.
// Example: Friday rally sets BULL; Saturday/Sunday drift down should downgrade
// regime to neutral so PUT signals can fire instead of being blocked all weekend.
function applyRecencyOverride(s, sym, regimeDir, regimeStrength) {
  try {
    if (!regimeDir || regimeDir === 'neutral') return { dir: regimeDir, strength: regimeStrength };
    if (!s.macroSnaps || s.macroSnaps.length < 12) return { dir: regimeDir, strength: regimeStrength };
    // Use ~24h window if available, fall back to 6h window. macroSnaps are 5-min apart.
    let snapIdx;
    if (s.macroSnaps.length >= 288) snapIdx = s.macroSnaps.length - 288; // 24h
    else if (s.macroSnaps.length >= 72) snapIdx = s.macroSnaps.length - 72; // 6h
    else snapIdx = 0;
    const oldestSn = s.macroSnaps[snapIdx];
    if (!oldestSn || !oldestSn.p || oldestSn.p <= 0) return { dir: regimeDir, strength: regimeStrength };
    const curPrice = (s.lastPrice && s.lastPrice > 0) ? s.lastPrice : oldestSn.p;
    const recentPct = ((curPrice - oldestSn.p) / oldestSn.p) * 100;
    // Per-symbol recency threshold
    const recThr = sym === 'XAU' ? 0.8 : sym === 'BTC' ? 1.0 : sym === 'NAS100' ? 0.8 : 0.5;
    if (regimeDir === 'bull' && recentPct <= -recThr) {
      return { dir: 'neutral', strength: 0, downgrade: 'bull→neutral recent ' + recentPct.toFixed(2) + '%' };
    }
    if (regimeDir === 'bear' && recentPct >= recThr) {
      return { dir: 'neutral', strength: 0, downgrade: 'bear→neutral recent +' + recentPct.toFixed(2) + '%' };
    }
  } catch (e) {}
  return { dir: regimeDir, strength: regimeStrength };
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
// TLT/SLV/GDX are RTH-only ETFs — outside US market hours Finnhub keeps returning the
// last close, so their EMA directions freeze and keep awarding stale conviction points
// all night (R1 fix, 2026-06-11: the 6/8–6/9 overnight XAU LHFP losers all carried
// conv 4 on frozen [TLT,SLV,GDX]). Fresh window: weekdays 09:30–16:30 ET (30-min grace).
function rthEtfFresh() {
  const dow = gETDow();
  if (dow === 0 || dow === 6) return false;
  const m = gET();
  return m >= 570 && m < 990;
}
function ts() { return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' }); }

// ===== PHASE 1 INFRASTRUCTURE — STRUCTURAL AWARENESS HELPERS (added 2026-06-17) =====
// These add data only (no behavior change yet). Phase 2 gates will read this state.
// Roadmap doc: /docs/signal_system_roadmap.xlsx

// Killzone classifier. Tags every tick with a session label. London KZ (02:00-05:00 ET) and
// NY AM (08:00-11:00 ET) print 60-70% of intraday range historically. Asian (19:00-02:00 ET)
// is consolidation. Used by Phase 2 timing gates.
function getSession(etMin) {
  // etMin is minutes since midnight ET (0-1439)
  if (etMin >= 120 && etMin < 300)  return 'londonKZ';     // 02:00-05:00
  if (etMin >= 300 && etMin < 480)  return 'londonOpen';   // 05:00-08:00
  if (etMin >= 480 && etMin < 660)  return 'nyAM';         // 08:00-11:00
  if (etMin >= 660 && etMin < 780)  return 'nyLunch';      // 11:00-13:00
  if (etMin >= 780 && etMin < 960)  return 'nyPM';         // 13:00-16:00
  if (etMin >= 960 && etMin < 1140) return 'overnight';    // 16:00-19:00 (post-NY close)
  return 'asian';                                          // 19:00-02:00 (wraps midnight)
}
function isKillzone(etMin) {
  // True during the two highest-volatility windows of the day
  return (etMin >= 120 && etMin < 300) || (etMin >= 480 && etMin < 660);
}
function isAsianSession(etMin) {
  // Asian session wraps midnight: 19:00 prev day → 02:00 today
  return etMin >= 1140 || etMin < 120;
}
function nearestRoundLevel(price, increment) {
  // Returns nearest $50 or $100 level depending on instrument scale
  return Math.round(price / increment) * increment;
}

// Liquidity Pool Detector (task #185).
// Scans macroSnaps (5-min price history) for local peaks and troughs, then groups
// near-equal levels (within thresholdPct%) into "pools". A pool of 2+ touches at a
// similar price is where retail stops cluster — those levels get swept frequently.
// Returns { above: [...], below: [...] } sorted nearest-first.
function detectLiquidityPools(macroSnaps, currentPrice, thresholdPct) {
  if (!macroSnaps || macroSnaps.length < 7) return { above: [], below: [] };
  const ws = 3; // window: 3 snaps each side = 15 min — defines a local peak/trough
  const peaks = [];
  const troughs = [];
  for (let i = ws; i < macroSnaps.length - ws; i++) {
    const p = macroSnaps[i].p;
    if (!p) continue;
    let isPeak = true, isTrough = true;
    for (let j = i - ws; j <= i + ws; j++) {
      if (j === i) continue;
      if (macroSnaps[j].p > p) isPeak = false;
      if (macroSnaps[j].p < p) isTrough = false;
      if (!isPeak && !isTrough) break;
    }
    if (isPeak)  peaks.push({ price: p, ts: macroSnaps[i].ts });
    if (isTrough) troughs.push({ price: p, ts: macroSnaps[i].ts });
  }
  const threshold = currentPrice * (thresholdPct / 100); // e.g. 0.1% → currentPrice * 0.001
  const pools = [];
  // Cluster all extremes (peaks + troughs) by price proximity
  const all = peaks.concat(troughs).sort((a, b) => a.price - b.price);
  let cluster = [];
  function flush() {
    if (cluster.length >= 2) {
      const avgPrice = cluster.reduce((s, x) => s + x.price, 0) / cluster.length;
      const maxTs = Math.max.apply(null, cluster.map(x => x.ts));
      pools.push({
        price: +avgPrice.toFixed(2),
        touches: cluster.length,
        ageMin: Math.round((Date.now() - maxTs) / 60000)
      });
    }
  }
  for (const ex of all) {
    if (cluster.length === 0 || ex.price - cluster[cluster.length - 1].price <= threshold) {
      cluster.push(ex);
    } else {
      flush();
      cluster = [ex];
    }
  }
  flush();
  const above = pools.filter(p => p.price > currentPrice).sort((a, b) => a.price - b.price);
  const below = pools.filter(p => p.price < currentPrice).sort((a, b) => b.price - a.price);
  return { above: above.slice(0, 3), below: below.slice(0, 3) };
}

// Premium/Discount Zone (task #186). Given a range [lo..hi] and current price, returns
// which third the price is in. Used by Phase 2 timing gates ("don't long the premium").
function computeRangeZone(price, hi, lo) {
  if (!hi || !lo || hi <= lo || !price) return { zone: null, posPct: null };
  const pos = (price - lo) / (hi - lo);
  const posPct = +(pos * 100).toFixed(1);
  let zone = 'equilibrium';
  if (pos < 0.3) zone = 'discount';
  else if (pos > 0.7) zone = 'premium';
  return { zone, posPct };
}

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
      // Shadow-fire outcome tracking (added 2026-05-25, rate-limited)
      trackBlockedOutcome(sym, msg);
    }
  } catch (e) { /* never let blocked-tracking crash logging */ }
}

// ===== SHADOW-FIRE BLOCKED OUTCOME TRACKER (added 2026-05-25) =====
// Records virtual TP1/SL outcomes for blocked signals to gather evidence on whether
// our gates are correctly filtering losers vs over-blocking winners. PURE DATA COLLECTION —
// does NOT affect signal-firing behavior, conviction scoring, or the 0-losers policy.
//
// Rate-limited to 1 tracked entry per symbol per 35min. Bot blocks 500-600 signals/session;
// tracking all of them would create unmanageable noise. Sampling one per 35min gives
// ~10-15 entries per symbol per session — enough to spot patterns without spam.
//
// Use GET /blocked-outcomes/:sym to review. After 1-2 weeks of data, we can decide on
// targeted tuning (e.g., "chop block on ATH PUT correctly avoided 12 losers and only
// missed 2 winners — keep it" or "trend-block on ATH avoided 1 loser and missed 8
// winners — relax it").
const BLOCK_TRACK_COOLDOWN_MS = 35 * 60 * 1000;

function trackBlockedOutcome(sym, msg) {
  const s = S[sym];
  if (!s) return;
  if (!Array.isArray(s.prices) || s.prices.length === 0) return;
  const now = Date.now();
  s.lastBlockTrackedTs = s.lastBlockTrackedTs || 0;
  if (now - s.lastBlockTrackedTs < BLOCK_TRACK_COOLDOWN_MS) return;
  // Parse direction from message (most block logs contain "CALL" or "PUT")
  const typeMatch = msg.match(/\b(CALL|PUT)\b/);
  if (!typeMatch) return; // can't determine direction — skip
  const type = typeMatch[1].toLowerCase();
  // Parse detector tag — try common patterns
  let detector = 'unknown';
  const tagMatch = msg.match(/[⬆⬇]?(RIDE|BREAK|BREAKOUT|LHF|LLF|FAST|ATH|ATL|VREV|MFLIP|HI|LO|DIV|SWEEP|TREND)/);
  if (tagMatch) detector = tagMatch[1];
  else if (/V-REV/.test(msg)) detector = 'VREV';
  else if (/RSI hard/.test(msg)) detector = 'RSI-FLOOR';
  const price = s.prices[s.prices.length - 1];
  if (!isFinite(price) || price <= 0) return;
  // Per-symbol virtual TP1/SL distances — match real-signal scales
  let tp1Dist;
  if (sym === 'XAU') tp1Dist = 5;
  else if (sym === 'BTC') tp1Dist = 50;
  else if (sym === 'NAS100') tp1Dist = 10;
  else if (sym === 'QQQ' || sym === 'SPY') tp1Dist = 0.3;
  else tp1Dist = 5;
  const slDist = tp1Dist; // 1:1 for measurement purposes
  const virtualTp1 = type === 'call' ? price + tp1Dist : price - tp1Dist;
  const virtualSl  = type === 'call' ? price - slDist  : price + slDist;
  s.blockedOutcomes = s.blockedOutcomes || [];
  s.blockedOutcomes.push({
    ts: now,
    time: ts(),
    symbol: sym,
    detector: detector,
    type: type,
    price: +price.toFixed(2),
    virtualTp1: +virtualTp1.toFixed(2),
    virtualSl: +virtualSl.toFixed(2),
    blockReason: msg.substring(0, 200),
    snaps: { p5m: null, p15m: null, p30m: null, p60m: null },
    tp1Hit: false, tp1HitTs: null,
    slHit: false, slHitTs: null,
    closed: false, closedTs: null,
    outcome: null  // 'win' | 'loss' | 'scratch' | 'no_resolve'
  });
  s.lastBlockTrackedTs = now;
  // Cap rolling buffer at 50 entries per symbol (~3-5 sessions of data)
  if (s.blockedOutcomes.length > 50) s.blockedOutcomes.shift();
}

// Update tracked block outcomes on each tick — snapshots + TP1/SL hit detection.
// Called from the tick processor for each symbol. Mirrors the BE-trail logic of real
// signals: TP1 hit → SL trails to entry → if reversed, outcome = 'scratch' (BE, no loss).
function updateBlockedOutcomes(sym, price) {
  const s = S[sym];
  if (!s || !Array.isArray(s.blockedOutcomes) || s.blockedOutcomes.length === 0) return;
  const now = Date.now();
  for (const b of s.blockedOutcomes) {
    if (b.closed) continue;
    const elapsedMin = (now - b.ts) / 60000;
    // Take snapshots at 5/15/30/60 min
    if (b.snaps.p5m == null && elapsedMin >= 5) b.snaps.p5m = +price.toFixed(2);
    if (b.snaps.p15m == null && elapsedMin >= 15) b.snaps.p15m = +price.toFixed(2);
    if (b.snaps.p30m == null && elapsedMin >= 30) b.snaps.p30m = +price.toFixed(2);
    if (b.snaps.p60m == null && elapsedMin >= 60) b.snaps.p60m = +price.toFixed(2);
    // TP1/SL hit detection
    if (!b.tp1Hit && !b.slHit) {
      const tp1Reached = b.type === 'call' ? price >= b.virtualTp1 : price <= b.virtualTp1;
      const slReached  = b.type === 'call' ? price <= b.virtualSl  : price >= b.virtualSl;
      if (tp1Reached) { b.tp1Hit = true; b.tp1HitTs = now; }
      else if (slReached) { b.slHit = true; b.slHitTs = now; }
    } else if (b.tp1Hit && !b.slHit) {
      // After TP1: SL trails to entry (matches real signal BE-trail behavior). If price
      // reverses back to entry, outcome is 'scratch' (BE, not a loss).
      const beReached = b.type === 'call' ? price <= b.price : price >= b.price;
      if (beReached) { b.slHit = true; b.slHitTs = now; }
    }
    // Close conditions: 60min elapsed OR resolved (TP1+SL=scratch, SL only=loss, etc.)
    const resolved = (b.tp1Hit && b.slHit) || (b.slHit && !b.tp1Hit);
    if (elapsedMin >= 60 || resolved) {
      if (b.tp1Hit && b.slHit) b.outcome = 'scratch';
      else if (b.tp1Hit && !b.slHit) b.outcome = 'win';
      else if (b.slHit && !b.tp1Hit) b.outcome = 'loss';
      else b.outcome = 'no_resolve';
      b.closed = true;
      b.closedTs = now;
    }
  }
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
let activeOptionTracks = []; // [{ entry (direct signalHistory entry ref), symbol, strike, type, expiry, ...state }]

// Fire-and-forget — picks option, opens a track, signal emit doesn't block.
async function trackEquityOptionEntry(entry, signalPrice, optionType) {
  if (!TRADIER_TOKEN) return;
  if (entry.symbol !== 'QQQ' && entry.symbol !== 'SPY') return;
  // FIXED 2026-06-11 (telemetry corruption bug): previously captured histIdx = signalHistory.length-1,
  // but saveSignalHistory()/loadSignalHistory() reassign-filter the array, shifting every index and
  // causing snapshots/outcomes to be written onto OTHER symbols' entries (observed: QQQ entries with
  // NAS100 closePrices). We now hold a direct reference to the entry object instead — array pruning
  // doesn't invalidate object references.
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
  // Push to active tracks for polling — direct entry reference (index-safe)
  activeOptionTracks.push({
    entry: entry,
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
    const entry = tr.entry; // direct reference (fixed 2026-06-11 — was stale signalHistory[histIdx])
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
      // ===== PHASE 3.21 RESTORATION FIX (added 2026-06-19, task #221) =====
      // Previously: dailySignalCount = todaySignals.length — but signalHistory contains
      // BLOCKED TRv2 entries (per task #176 "Always store TRv2 entries regardless of
      // enrichSig block"). Every Railway redeploy inflated the count by the number of
      // blocked attempts, eventually tripping the daily cap on perfectly fine days.
      //
      // 6/19 case: XAU had ~4 real fires + many blocked RIDE attempts. Each redeploy
      // restored count = ~20 even though actual fires were ~4. Cap tripped, bot went
      // silent for the rest of the day.
      //
      // Fix: count only entries that actually FIRED (no enrichBlocked flag). The
      // s.signals array still contains everything (for analytics + UI), but the cap-
      // counter reflects reality.
      const today = todayDateET();
      SYMBOLS.forEach(sym => {
        const todaySignals = signalHistory.filter(h => h.date === today && h.symbol === sym);
        if (todaySignals.length > 0) {
          S[sym].signals = todaySignals.map(h => ({
            type: h.type, time: h.time, price: h.price, score: h.score,
            rsi: h.rsi, macd: h.macd, roc: h.roc, num: h.num, conv: h.conv || null
          }));
          // Count only signals that actually fired — exclude enrichBlocked entries.
          // Blocked TRv2 entries have conv.enrichBlocked = true OR conv.label = 'BLOCKED'.
          const firedCount = todaySignals.filter(h =>
            !(h.conv && (h.conv.enrichBlocked === true || h.conv.label === 'BLOCKED'))
          ).length;
          const blockedCount = todaySignals.length - firedCount;
          S[sym].dailySignalCount = firedCount;
          console.log('[' + ts() + '] ' + sym + ' — restored ' + firedCount + ' fired + ' + blockedCount + ' blocked = ' + todaySignals.length + ' total for today');
        }
      });
      // ===== DETECTOR COOLDOWN RESTORATION (task #209, added 2026-06-17) =====
      // Without this, every restart resets every cooldown timestamp to 0, allowing
      // rapid re-fires. 6/17 case: 4 NAS STRUCT_LIQ_GRAB signals fired in 62 min
      // (45-min cooldown) because multiple mid-day deploys kept zeroing the timer.
      //
      // Scan signalHistory and set each detector's LastTs to the most recent fire
      // within the last 24h. After restart, in-memory cooldowns match disk reality.
      const day24Ago = Date.now() - 24 * 60 * 60 * 1000;
      SYMBOLS.forEach(sym => {
        const s = S[sym];
        if (!s) return;
        const recentSigs = signalHistory.filter(h => h.symbol === sym && h.ts > day24Ago);
        if (recentSigs.length === 0) return;
        // Map from signal score → state field that tracks its cooldown
        const mapping = [
          { match: /STRUCT_SWEEP/,    field: 'structSweepLastTs',   alsoDir: 'structSweepLastDir' },
          { match: /STRUCT_OB_FILL/,  field: 'structOBFillLastTs' },
          { match: /STRUCT_LIQ_GRAB/, field: 'structLiqGrabLastTs' },
          { match: /STRUCT_VWAP/,     field: 'structVwapLastTs' },
          { match: /INVERSAL_BREAK/,  field: 'inversalLastTs',      alsoDir: 'inversalLastDir' },
          { match: /BREAK(?!OUT)/,    field: 'breakLastTs',         alsoDir: 'breakLastDir' },
          { match: /FAST/,            field: 'fastMoveLastTs',      alsoDir: 'fastLastDir' },
          { match: /VREV/,            field: 'vrevLastTs' },
          { match: /TREND|RIDE/,      field: 'trendRideLastTs',     alsoDir: 'trendRideLastDir' },
          { match: /MFLIP/,           field: 'macroFlipTs' },
          { match: /SUPER/,           field: 'superFlipTs' },
          { match: /SQZ/,             field: 'sqzLastFireTs' },
          { match: /DIV/,             field: 'divLastFireTs' }
        ];
        let restored = 0;
        mapping.forEach(m => {
          const last = recentSigs.filter(h => m.match.test(h.score || '')).sort((a, b) => b.ts - a.ts)[0];
          if (last && typeof s[m.field] !== 'undefined') {
            s[m.field] = last.ts;
            if (m.alsoDir && last.type) s[m.alsoDir] = last.type;
            restored++;
          }
        });
        if (restored > 0) {
          console.log('[' + ts() + '] ' + sym + ' — restored ' + restored + ' detector cooldown timestamps from history');
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

// ===== BLOCKED-OUTCOMES PERSISTENCE (added 2026-05-25) =====
// Persists shadow-fire blocked-outcome tracking to /data/blocked_outcomes.json so the
// evidence-collection survives Railway redeploys. Same atomic+fsync pattern as
// signalHistory. Stored per-symbol with 30-day retention (longer than signalHistory
// because we need multi-week samples to make confident tuning decisions).
const BLOCKED_OUTCOMES_FILE = path.join(DATA_DIR, 'blocked_outcomes.json');
const BLOCKED_OUTCOMES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadBlockedOutcomes() {
  const candidates = [BLOCKED_OUTCOMES_FILE, BLOCKED_OUTCOMES_FILE + '.bak'];
  for (const file of candidates) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      if (!txt || txt.trim().length === 0) { throw new Error('empty file'); }
      const raw = JSON.parse(txt);
      const cutoff = Date.now() - BLOCKED_OUTCOMES_MAX_AGE_MS;
      let totalLoaded = 0;
      SYMBOLS.forEach(sym => {
        if (!S[sym]) return;
        const symData = raw[sym] || {};
        const outcomes = Array.isArray(symData.outcomes) ? symData.outcomes : [];
        // Drop entries older than 30 days
        S[sym].blockedOutcomes = outcomes.filter(o => o.ts && o.ts > cutoff);
        S[sym].lastBlockTrackedTs = symData.lastBlockTrackedTs || 0;
        totalLoaded += S[sym].blockedOutcomes.length;
      });
      console.log('[' + ts() + '] Blocked-outcomes loaded — ' + totalLoaded + ' tracked entries (last 30 days) from ' + (file === BLOCKED_OUTCOMES_FILE ? 'primary' : 'BACKUP (.bak)'));
      return;
    } catch (e) {
      console.log('[' + ts() + '] Blocked-outcomes load failed from ' + file + ': ' + e.message);
    }
  }
  console.log('[' + ts() + '] No usable blocked-outcomes file — starting fresh');
}

let _lastSaveBlockedOutcomesLogTs = 0;
let _saveBlockedOutcomesCallCount = 0;
function saveBlockedOutcomes() {
  try {
    const cutoff = Date.now() - BLOCKED_OUTCOMES_MAX_AGE_MS;
    const payload = {};
    SYMBOLS.forEach(sym => {
      if (!S[sym]) return;
      const outcomes = Array.isArray(S[sym].blockedOutcomes) ? S[sym].blockedOutcomes : [];
      payload[sym] = {
        outcomes: outcomes.filter(o => o.ts && o.ts > cutoff),
        lastBlockTrackedTs: S[sym].lastBlockTrackedTs || 0
      };
    });
    const tmpFile = BLOCKED_OUTCOMES_FILE + '.tmp';
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(payload));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(BLOCKED_OUTCOMES_FILE)) {
      try { fs.copyFileSync(BLOCKED_OUTCOMES_FILE, BLOCKED_OUTCOMES_FILE + '.bak'); } catch (e) { /* not fatal */ }
    }
    fs.renameSync(tmpFile, BLOCKED_OUTCOMES_FILE);
    _saveBlockedOutcomesCallCount++;
    const now = Date.now();
    if (now - _lastSaveBlockedOutcomesLogTs > 300000) { // log once per 5min
      const totalEntries = SYMBOLS.reduce((a, sym) => a + (S[sym] && S[sym].blockedOutcomes ? S[sym].blockedOutcomes.length : 0), 0);
      console.log('[' + ts() + '] 💾 saveBlockedOutcomes — ' + totalEntries + ' tracked entries persisted (' + _saveBlockedOutcomesCallCount + ' saves since last log)');
      _lastSaveBlockedOutcomesLogTs = now;
      _saveBlockedOutcomesCallCount = 0;
    }
  } catch (e) {
    console.error('[' + ts() + '] ❌ Failed to save blocked outcomes:', e.message);
    if (e.code === 'ENOENT') {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmpFile = BLOCKED_OUTCOMES_FILE + '.tmp';
        const fd = fs.openSync(tmpFile, 'w');
        try { fs.writeSync(fd, JSON.stringify({})); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmpFile, BLOCKED_OUTCOMES_FILE);
        console.log('[' + ts() + '] ✅ saveBlockedOutcomes recovered — recreated DATA_DIR');
      } catch (e2) { console.error('[' + ts() + '] ❌ Recovery write also failed:', e2.message); }
    }
  }
}

// ===== PHASE 3.32 + 3.33 — LOAD ALL PERSISTENCE FILES ON STARTUP (added 2026-06-22, tasks #232/#233) =====
// CRITICAL BUG FIX: All these load functions were defined but never invoked. Every
// server restart began with empty state, then the autosaves (60s later) wrote that
// empty state to disk — destroying ALL prior data on every Railway redeploy.
//
// The Railway volume was working correctly the whole time — the code just never asked
// it for data on boot. Now we load everything in the correct order.
//
// Order matters:
//   1. loadRollingLevels — restores Asian H/L, daily ATH/ATL, macroSnaps (regime data)
//   2. loadTrv2State — restores any active TRv2 trade so it's not orphaned
//   3. loadTrumpState — restores Trump factor cache (avoid re-classifying old tweets)
//   4. loadSignalHistory — restores signals + per-symbol s.signals + cooldown timestamps
//   5. loadBlockedOutcomes — restores shadow-fire analytics
try {
  loadRollingLevels();   // Asian H/L, ATH/ATL, daily levels, macroSnaps (6h of 5-min data)
  // PHASE 3.68 — seed dailyLevels if missing (idempotent)
  try { seedDailyLevels(); } catch (e) { console.error('[STARTUP] seedDailyLevels error: ' + e.message); }
} catch (e) {
  console.error('[STARTUP] loadRollingLevels threw — starting fresh:', e.message);
}
try {
  loadTrv2State();       // Active TRv2 trades + EMA candle buffers
} catch (e) {
  console.error('[STARTUP] loadTrv2State threw — starting fresh:', e.message);
}
try {
  loadTrumpState();      // Trump factor cache
} catch (e) {
  console.error('[STARTUP] loadTrumpState threw — starting fresh:', e.message);
}
try {
  loadSignalHistory();   // 7-day signal store + per-symbol s.signals + detector cooldowns
} catch (e) {
  console.error('[STARTUP] loadSignalHistory threw — starting fresh:', e.message);
}
try {
  loadBlockedOutcomes(); // Shadow-fire analytics (30-day window)
} catch (e) {
  console.error('[STARTUP] loadBlockedOutcomes threw — starting fresh:', e.message);
}

// Periodic backup save — every 60 seconds, catches snapshot updates and outcome changes
// that may not trigger an explicit save through logSignal or updateSignalOutcome.
setInterval(() => {
  try { saveSignalHistory(); } catch (e) { /* error already logged in saveSignalHistory */ }
}, 60000);
console.log('[STARTUP] Persistence: signalHistory saves every 60s + on every emit/outcome update');

// Save signal history every 5 minutes
setInterval(saveSignalHistory, 300000);

// Save blocked-outcomes every 5 minutes (added 2026-05-25) — survives Railway redeploys
setInterval(saveBlockedOutcomes, 300000);

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
  // Defensive number guards added 2026-06-12: a trv2Trade restored from an older saved
  // state can lack fields, and sl/tp1/tp2/tp3 called .toFixed unguarded (atr was already
  // guarded — this failure mode has happened before). Suspected source of the 6/12
  // "processTicks NAS100 error: Cannot read properties of undefined (reading 'toFixed')".
  if (S[sym].trv2Trade) {
    const _t2 = S[sym].trv2Trade;
    const _n2 = (v) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(2) : null);
    histEntry.trv2 = {
      dir: _t2.dir,
      ep: _t2.ep,
      sl: _n2(_t2.sl),
      tp1: _n2(_t2.tp1),
      tp2: _n2(_t2.tp2),
      tp3: _n2(_t2.tp3),
      atr: _n2(_t2.atr)
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
    const oldEntry = sOld.lastHistEntry; // direct reference (fixed 2026-06-11 — was stale signalHistory[lastHistIdx])
    const t = sOld.trade;
    if (oldEntry != null && t && t.active && t.isCfd && typeof t.bestPrice === 'number') {
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

  // Track which signalHistory entry represents the active trade for this symbol.
  // checkExit() uses this to update outcomes when t.t1/t.t2/t.sl flags flip.
  // Direct reference (fixed 2026-06-11) — index-based tracking broke whenever
  // saveSignalHistory() pruned old entries and shifted the array.
  S[sym].lastHistEntry = histEntry;

  // Schedule post-signal price snapshots at +5m / +15m / +30m (added 2026-05-14).
  // processPrice() will check pendingSnapshots each tick and populate priceSnaps on the
  // signalHistory entry as time elapses. CSV export reads these to add price5m/delta5m/
  // price15m/delta15m/price30m/delta30m columns.
  try {
    const s = S[sym];
    if (s && Array.isArray(s.pendingSnapshots)) {
      s.pendingSnapshots.push({ entry: histEntry, fireTs: Date.now() }); // direct ref (fixed 2026-06-11)
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
    // F4 fix (2026-06-12): once SL has hit, the 0DTE trade is dead — later favorable
    // snapshots must not stamp TP2/TP3 (6/12 10:08 QQQ PUT SL'd at the 720.37 spike, then
    // the 15-min snapshot saw 718.09 and marked tp3Hit → exported as "TP3" despite being
    // a stopped-out loss). MT5 already guards TP3 behind !slHit; equities now match.
    if (snapStage === '5m'  && !entry.outcomes.tp1Hit && favMove >= 0.15) { entry.outcomes.tp1Hit = true; entry.outcomes.tp1HitTs = now; }
    if (snapStage === '10m' && !entry.outcomes.slHit && !entry.outcomes.tp2Hit && favMove >= 0.30) { entry.outcomes.tp2Hit = true; entry.outcomes.tp2HitTs = now; }
    if (snapStage === '15m' && !entry.outcomes.slHit && !entry.outcomes.tp3Hit && favMove >= 0.50) { entry.outcomes.tp3Hit = true; entry.outcomes.tp3HitTs = now; entry.outcomes.closePrice = snapPrice; }
    // SL: only if TP1 hasn't hit yet (TP1+scratch logic — quick profit-take protects)
    if (!entry.outcomes.tp1Hit && !entry.outcomes.slHit && advMove >= 0.25) {
      entry.outcomes.slHit = true; entry.outcomes.slHitTs = now; entry.outcomes.closePrice = snapPrice;
    }
  };

  if (Array.isArray(s.pendingSnapshots) && s.pendingSnapshots.length > 0) {
    const tNow = Date.now();
    s.pendingSnapshots = s.pendingSnapshots.filter(ps => {
      // Direct reference (fixed 2026-06-11 — signalHistory[ps.histIdx] went stale whenever
      // saveSignalHistory() pruned the array, writing snapshots onto other symbols' entries).
      const entry = ps.entry;
      if (!entry || entry.symbol !== sym) return false; // entry gone or mismatched — drop
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
  // Shadow-fire blocked-outcome tracking (added 2026-05-25) — read-only data collection
  // for evidence-based future tuning. Does not affect signal-firing path.
  try { updateBlockedOutcomes(sym, price); } catch (e) { /* never crash tick loop */ }
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
    // ===== PHASE 3.57 — DIRECTIONAL MOVEMENT OVERRIDE (2026-06-26, task #249) =====
    // Research: pro traders use ADX(7-10) for intraday with threshold 20-25 — single
    // EMA-efficiency method misses directional V-day patterns. Implementing ADX from
    // tick data is complex; instead use macroSnaps (5-min snapshots, 12 = 1h, 6 = 30min).
    // Net directional move over 30min above per-symbol threshold => override chop to
    // false. This catches days like 06-26 NAS where chopActive stayed true despite a
    // clean $230 morning rally (29080 → 29433 = 1.2%) and PM drop (-1.5%).
    try {
      if (s.chopActive && s.macroSnaps && s.macroSnaps.length >= 6) {
        const snap30 = s.macroSnaps[Math.max(0, s.macroSnaps.length - 6)];
        if (snap30 && snap30.p > 0) {
          const dirMovePct = Math.abs(price - snap30.p) / snap30.p * 100;
          // PHASE 3.62 — BTC threshold lowered 1.0 → 0.7 (2026-06-27, task #251).
          // On 06-26 BTC rallied $1,300 / +2.2% in a day (~0.55% per 30min on average).
          // 1.0% threshold missed most of those windows. 0.7% catches more legitimate
          // trend periods without firing on every minor wiggle.
          const dirThr = (sym === 'XAU') ? 0.5 : (sym === 'BTC') ? 0.7 : (sym === 'NAS100') ? 0.6 : 0.4;
          if (dirMovePct > dirThr) {
            s.chopActive = false;
            s.trendCount = 0;
            log(sym, '📈 TREND OVERRIDE (Phase 3.57) — 30min directional move ' + dirMovePct.toFixed(2) + '% > ' + dirThr + '% threshold. chopActive forced OFF.');
          }
        }
      }
    } catch (e) {}
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
              // BUGFIX (2026-06-28): candles use prev.l/prev.h, not prev.lo/prev.hi.
              log(sym, '🟩 BULLISH OB formed: $' + prev.l.toFixed(2) + ' - $' + prev.h.toFixed(2) + ' (demand zone)');
            }
            // Bearish displacement → last bullish candle before it = supply zone (bearish OB)
            if (bearDisp && prev.c > prev.o) {
              s.orderBlocks.push({ type: 'bear', hi: prev.h, lo: prev.l, ts: prev.ts, mitigated: false });
              log(sym, '🟥 BEARISH OB formed: $' + prev.l.toFixed(2) + ' - $' + prev.h.toFixed(2) + ' (supply zone)');
            }
          }
        }
        // Mitigate OBs — if price passes through an OB zone completely, it's spent.
        // Fresh-mitigation flag (added 2026-05-25): when an OB transitions to mitigated, mark
        // it for the continuation detector. Bull OB mitigated = demand broken = bearish
        // continuation; Bear OB mitigated = supply broken = bullish continuation.
        s.orderBlocks.forEach(ob => {
          if (!ob.mitigated) {
            const becameMit = (ob.type === 'bull' && price < ob.lo) || (ob.type === 'bear' && price > ob.hi);
            if (becameMit) {
              ob.mitigated = true;
              s.lastObMitTs = Date.now();
              s.lastObMitType = ob.type;          // 'bull' or 'bear'
              s.lastObMitLevel = (ob.hi + ob.lo) / 2;
              s.obMitFired = false;                // reset so the continuation detector can fire
              log(sym, '⚡ OB freshly MITIGATED: ' + ob.type.toUpperCase() + ' $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' broken — watching for ' + (ob.type === 'bull' ? 'PUT' : 'CALL') + ' continuation');
            }
            // Note: ob.mitigated may also be set by the simpler price-cross check below for backward compat
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

  // === TREND RIDE V2 — 1-min candle builder + 15/20/30 EMA (NAS100 + BTC) ===
  // History: Removed from BTC after 0/6 -$872 on 5/6 in chop. Re-enabled 2026-05-25 — the
  // protection layer added since then (cascade limit #154, EMA dedupe #155, conv maturity
  // factor #156, TP1 BE-trail scratch protection) addresses the original loss-cascade pattern.
  // User judgment: TRv2's averaged-EMA + ATR-sized targets fit BTC's clean directional legs
  // better than fragmented BREAKOUT/FAST/TREND entries.
  // TRv2 candle building — extended to XAU 2026-06-18 (task #213) to address
  // the structural gap where XAU had no trend-continuation detector. The drop
  // from $4310 → $4268 on 6/18 morning fired ZERO signals because all XAU
  // detectors are fade/reversal-only. TRv2's averaged-EMA + ATR trend rider
  // is the right tool for sustained directional moves on XAU's $4000 scale.
  if (isNAS || isBTC || isXAU) {
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

  // ===== PHASE 1 INFRASTRUCTURE — STRUCTURAL AWARENESS UPDATES (added 2026-06-17) =====
  // Runs every tick. Populates s.session, s.asianH/L, s.htf1h_dir, s.vwap. No behavior
  // change yet — Phase 2 gates will consume these. Roadmap: /docs/signal_system_roadmap.xlsx
  // Skip for QQQ/SPY for now — focus on MT5 instruments (XAU/BTC/NAS) where this matters most.
  if (isMT5 && price > 0) {
    const _now = Date.now();
    // ── Phase 1.2: Killzone Clock — tag every tick
    const newSession = getSession(etMin);
    if (newSession !== s.session) {
      s.session = newSession;
      s.sessionStartTs = _now;
    }
    s.inKillzone = isKillzone(etMin);

    // ── Phase 1.1: Asian Session H/L Tracker (19:00 ET → 02:00 ET wraps midnight)
    const inAsian = isAsianSession(etMin);
    if (inAsian) {
      // Inside Asian window — update running H/L
      if (s.asianH === null || price > s.asianH) s.asianH = price;
      if (s.asianL === null || price < s.asianL) s.asianL = price;
      s.asianRange = s.asianH - s.asianL;
      if (s.asianStartTs === 0) s.asianStartTs = _now;
    } else {
      // Outside Asian window — lock the values if we just exited
      // (Asian ends at 02:00 ET; lock once and store with today's date)
      const todayStr = todayDateET();
      if (s.asianH !== null && s.asianLockedDate !== todayStr) {
        s.asianH_locked = s.asianH;
        s.asianL_locked = s.asianL;
        s.asianLockedDate = todayStr;
        // Reset session lock for the new Asian session (Phase 3.9, task #205)
        s.asianSweepInvalidated = false;
        s.asianAboveSince = 0;
        s.asianBelowSince = 0;
      }
      // After 02:00 ET, start prepping for next Asian window (resets at 19:00 ET)
      if (etMin >= 120 && etMin < 1140) {
        // Daytime — clear current asianH/L tracking so new Asian session starts fresh at 19:00
        if (s.asianStartTs > 0) {
          s.asianH = null;
          s.asianL = null;
          s.asianRange = 0;
          s.asianStartTs = 0;
        }
      }
    }

    // ── Phase 1.3: HTF Bias Module — compute 1h/4h trend from macroSnaps
    // macroSnaps stores price every 5 min, max 72 entries (6 hours). 12 snaps = 1h, 48 = 4h.
    if (s.macroSnaps && s.macroSnaps.length >= 12) {
      const snap1hAgo = s.macroSnaps[Math.max(0, s.macroSnaps.length - 12)];
      const pct1h = ((price - snap1hAgo.p) / snap1hAgo.p) * 100;
      s.htf1h_strength = pct1h;
      // Threshold: 0.1% for XAU (~$4 on $4300), 0.15% for BTC, 0.2% for NAS
      const htf1hThresh = isXAU ? 0.1 : isBTC ? 0.15 : 0.2;
      s.htf1h_dir = pct1h > htf1hThresh ? 'up' : pct1h < -htf1hThresh ? 'down' : 'flat';
    }
    if (s.macroSnaps && s.macroSnaps.length >= 48) {
      const snap4hAgo = s.macroSnaps[Math.max(0, s.macroSnaps.length - 48)];
      const pct4h = ((price - snap4hAgo.p) / snap4hAgo.p) * 100;
      s.htf4h_strength = pct4h;
      const htf4hThresh = isXAU ? 0.2 : isBTC ? 0.3 : 0.4;
      s.htf4h_dir = pct4h > htf4hThresh ? 'up' : pct4h < -htf4hThresh ? 'down' : 'flat';
    }

    // ── Phase 1.4: Session VWAP — anchored at 18:00 ET (CME daily reset)
    // For MT5 instruments we don't have true volume, so use tick-frequency as a proxy (each
    // tick = 1 unit of weight). This is a "tick-VWAP" — close enough for bias detection.
    // Reset at 18:00 ET each day (new CME trading day).
    const sessionAnchorHour = 18 * 60; // 18:00 ET in minutes
    const hoursSinceAnchor = etMin >= sessionAnchorHour
      ? (etMin - sessionAnchorHour)
      : (etMin + (1440 - sessionAnchorHour));
    const anchorMs = _now - (hoursSinceAnchor * 60 * 1000);
    // If we've crossed the anchor since last update, reset accumulator
    if (s.vwapAnchorTs === 0 || s.vwapAnchorTs < anchorMs - 60000) {
      s.vwapNum = 0;
      s.vwapDen = 0;
      s.vwapAnchorTs = anchorMs;
    }
    s.vwapNum += price * 1; // weight = 1 tick
    s.vwapDen += 1;
    if (s.vwapDen > 0) {
      s.vwap = s.vwapNum / s.vwapDen;
      s.vwapDistPct = ((price - s.vwap) / s.vwap) * 100;
      s.vwapDir = s.vwapDistPct > 0.02 ? 'above' : s.vwapDistPct < -0.02 ? 'below' : 'at';
    }

    // ── Phase 1.5: Liquidity Pool Detector — rate-limited (every 60 sec, expensive scan)
    // 0.1% threshold for XAU (~$4 on $4300), 0.08% BTC (~$50 on $66k), 0.05% NAS (~$15 on $30k).
    if (_now - s.liqPoolsTs > 60000 && s.macroSnaps && s.macroSnaps.length >= 7) {
      const thresholdPct = isXAU ? 0.1 : isBTC ? 0.08 : 0.05;
      const pools = detectLiquidityPools(s.macroSnaps, price, thresholdPct);
      s.liqPoolsAbove = pools.above;
      s.liqPoolsBelow = pools.below;
      s.liqPoolsTs = _now;
    }

    // ── Phase 1.6: Premium/Discount Zone — prefer Asian range, fall back to rolling
    // Asian locked H/L is most respected by gold traders. After Asian: use today's range.
    let zoneHi = null, zoneLo = null, zoneRef = null;
    if (s.asianH_locked && s.asianL_locked && s.asianRange > 0) {
      zoneHi = s.asianH_locked;
      zoneLo = s.asianL_locked;
      zoneRef = 'asian';
    } else if (s.asianH && s.asianL && s.asianRange > 0) {
      // Asian session in progress
      zoneHi = s.asianH;
      zoneLo = s.asianL;
      zoneRef = 'asian_live';
    } else if (s.rollingHigh > 0 && s.rollingLow > 0 && s.rollingLow !== Infinity) {
      zoneHi = s.rollingHigh;
      zoneLo = s.rollingLow;
      zoneRef = 'rolling';
    }
    if (zoneHi && zoneLo) {
      const zoneCalc = computeRangeZone(price, zoneHi, zoneLo);
      s.rangeZone = zoneCalc.zone;
      s.rangePosPct = zoneCalc.posPct;
      s.rangeRef = zoneRef;
      s.rangeRefHi = zoneHi;
      s.rangeRefLo = zoneLo;
    }

    // ── Phase 1.8: Round Number Tracker (extended from XAU-only to all MT5)
    // XAU: $50 levels with $5 proximity (~0.12%)
    // BTC: $1000 levels with $100 proximity (~0.15%)
    // NAS: $100 levels with $10 proximity (~0.03%)
    const roundIncr  = isXAU ? 50 : isBTC ? 1000 : 100;
    const roundProx  = isXAU ? 5  : isBTC ? 100  : 10;
    const nearestRn  = nearestRoundLevel(price, roundIncr);
    s.roundNumLevel = nearestRn;
    s.roundNumDist  = Math.abs(price - nearestRn);
    s.nearRoundNumber = s.roundNumDist <= roundProx;

    // ── Phase 3 sweep-state tracking (used by STRUCT_SWEEP / STRUCT_LIQ_GRAB detectors below)
    // Asian H/L sweep tracking: detect when price has breached the locked Asian range
    // with a buffer. The detector itself fires only when price COMES BACK through —
    // this state just records the breach.
    //
    // ===== ADAPTIVE BUFFER (task #206, added 2026-06-17) =====
    // Original fixed 0.05% of price ($2.16 on XAU $4318) was too strict for TIGHT Asian
    // ranges. 6/17 11:44 GMT+2 case: Asian range was only $6.20, sweep buffer would have
    // been 35% of the whole range — never triggers. Now we use the SMALLER of:
    //   - 0.03% of price (~$1.30 XAU, ~$20 BTC, ~$9 NAS)
    //   - 10% of Asian range
    // For wide Asian ranges, percent-of-price wins (catches macro-significant sweeps).
    // For tight Asian ranges, percent-of-range wins (catches structurally-relevant sweeps).
    if (s.asianH_locked && s.asianL_locked) {
      const bufByPrice = s.asianL_locked * 0.0003;            // 0.03% of price
      const bufByRange = (s.asianRange || s.asianH_locked - s.asianL_locked) * 0.10; // 10% of Asian range
      const buf = Math.min(bufByPrice, bufByRange);
      // Sweep up: price has gone above asianH + buffer
      if (price > s.asianH_locked + buf) {
        if (!s.asianSweptHigh) {
          s.asianSweptHigh = true;
          s.asianSweepHighTs = _now;
        }
        if (price > s.asianSweepHighPeak) s.asianSweepHighPeak = price;
      }
      // Sweep down
      if (price < s.asianL_locked - buf) {
        if (!s.asianSweptLow) {
          s.asianSweptLow = true;
          s.asianSweepLowTs = _now;
        }
        if (s.asianSweepLowTrough === 0 || price < s.asianSweepLowTrough) s.asianSweepLowTrough = price;
      }
      // Reset sweep flags when locked Asian date changes (new trading day)
      // (Already handled by asianLockedDate change in main Asian block above)

      // === Phase 3.9 — Session lock tracking (task #205) ===
      // Track continuous time outside Asian range. If price stays above asianH (or below
      // asianL) for >30 min WITHOUT reverting back inside, the Asian setup is "invalidated"
      // — clean breakout, not a Judas swing — and STRUCT_SWEEP is locked for the session.
      // The flag resets when a new Asian session begins (handled in main block above).
      if (price > s.asianH_locked) {
        if (s.asianAboveSince === 0) s.asianAboveSince = _now;
        s.asianBelowSince = 0;
      } else if (price < s.asianL_locked) {
        if (s.asianBelowSince === 0) s.asianBelowSince = _now;
        s.asianAboveSince = 0;
      } else {
        // Price back inside range — reset both "since" timestamps
        s.asianAboveSince = 0;
        s.asianBelowSince = 0;
      }
      // Trigger session lock if either above/below time exceeds 30 min
      const SESSION_LOCK_MS = 30 * 60 * 1000;
      if (!s.asianSweepInvalidated) {
        if (s.asianAboveSince > 0 && (_now - s.asianAboveSince) >= SESSION_LOCK_MS) {
          s.asianSweepInvalidated = true;
          log(sym, '🔒 STRUCT_SWEEP session-locked — Asian H $' + s.asianH_locked.toFixed(2) + ' broken cleanly (price held above 30+ min). No more Judas plays this session.');
        } else if (s.asianBelowSince > 0 && (_now - s.asianBelowSince) >= SESSION_LOCK_MS) {
          s.asianSweepInvalidated = true;
          log(sym, '🔒 STRUCT_SWEEP session-locked — Asian L $' + s.asianL_locked.toFixed(2) + ' broken cleanly (price held below 30+ min). No more Judas plays this session.');
        }
      }
    }
    // Liquidity pool sweep tracking: detect when nearest pool above/below has been pierced
    if (s.liqPoolsAbove && s.liqPoolsAbove.length > 0) {
      const nearestAbove = s.liqPoolsAbove[0];
      // If we've now risen past it, mark as swept
      if (price > nearestAbove.price && s.liqSweptAbovePrice !== nearestAbove.price) {
        s.liqSweptAbovePrice = nearestAbove.price;
        s.liqSweptAboveTs = _now;
      }
    }
    if (s.liqPoolsBelow && s.liqPoolsBelow.length > 0) {
      const nearestBelow = s.liqPoolsBelow[0];
      if (price < nearestBelow.price && s.liqSweptBelowPrice !== nearestBelow.price) {
        s.liqSweptBelowPrice = nearestBelow.price;
        s.liqSweptBelowTs = _now;
      }
    }
    // VWAP touch detection: within 0.05% of VWAP counts as a touch
    if (s.vwap) {
      const vwapDist = Math.abs(price - s.vwap);
      const vwapTouchThr = s.vwap * 0.0005;
      if (vwapDist <= vwapTouchThr && _now - s.vwapTouchedTs > 60000) {
        s.vwapTouchedTs = _now;
        s.vwapTouchedSide = price >= s.vwap ? 'above' : 'below';
      }
    }

    // ===== INVERSAL_BREAK level-sweep tracking (task #200) =====
    // For each of 10 level types, track whether price has BREACHED the level
    // (with a buffer) and capture the extreme reached. The detector below fires
    // when ANY swept level sees price come back INSIDE.
    // Local 60-min H/L: computed from last 12 macroSnaps (5-min each = 60 min)
    if (s.macroSnaps && s.macroSnaps.length >= 6) {
      const lookback = Math.min(12, s.macroSnaps.length);
      let hi60 = 0, lo60 = Infinity;
      for (let i = s.macroSnaps.length - lookback; i < s.macroSnaps.length; i++) {
        if (s.macroSnaps[i].p > hi60) hi60 = s.macroSnaps[i].p;
        if (s.macroSnaps[i].p < lo60) lo60 = s.macroSnaps[i].p;
      }
      s.localHi60min = hi60;
      s.localLo60min = lo60 === Infinity ? 0 : lo60;
    }
    // Level definitions (collect into a map so we can iterate uniformly)
    // ===== ADAPTIVE LEVEL-TYPE BUFFER (task #211, added 2026-06-17) =====
    // 6/17 05:09 XAU OBMIT PUT case: obLo at $4,323.28, price went to $4,322.27 (only $1
    // below). Old fixed 0.05% buffer = $2.16 → sweep didn't qualify → INVERSAL_BREAK couldn't
    // catch the failed breakdown. The fix: use TIGHTER buffer for tight intraday levels
    // (obHi/obLo, localHi/Lo) and WIDER buffer for broad daily/multi-day levels.
    //
    // Tight levels (intraday structure): obHi/obLo, localHi60/localLo60 → 0.02% buffer
    // Broad levels (daily/multi-day):    rolling5d, pdh/pdl, roundNum             → 0.03% buffer
    // BTC gets wider in both cases due to higher volatility (multiply by 1.5x).
    const tightBufPct = isBTC ? 0.0003 : 0.0002;   // 0.02% / 0.03% — for OB and local 60min
    const broadBufPct = isBTC ? 0.0005 : 0.0003;   // 0.03% / 0.05% — for daily levels
    const pdh = (s.dailyLevels && s.dailyLevels.length >= 2) ? s.dailyLevels[s.dailyLevels.length - 1].high : 0;
    const pdl = (s.dailyLevels && s.dailyLevels.length >= 2) ? s.dailyLevels[s.dailyLevels.length - 1].low : 0;
    // Per-level definitions: [key, price, direction, isTightLevel]
    const lvlDefs = [
      ['rolling5dHi', s.rollingHigh,                'above', false],
      ['rolling5dLo', s.rollingLow !== Infinity ? s.rollingLow : 0, 'below', false],
      ['pdh',         pdh,                          'above', false],
      ['pdl',         pdl,                          'below', false],
      ['roundNumAbv', s.roundNumLevel ? s.roundNumLevel + (isXAU ? 50 : isBTC ? 1000 : 100) : 0, 'above', false],
      ['roundNumBlw', s.roundNumLevel ? s.roundNumLevel : 0,                                     'below', false],
      ['localHi60',   s.localHi60min,               'above', true],
      ['localLo60',   s.localLo60min,               'below', true],
      ['obHi',        s.obZone ? s.obZone.hi : 0,   'above', true],
      ['obLo',        s.obZone ? s.obZone.lo : 0,   'below', true]
    ];
    for (const [key, levelPrice, side, isTight] of lvlDefs) {
      if (!levelPrice || levelPrice <= 0) continue;
      const lv = s.sweptLevels[key];
      const bufPct = isTight ? tightBufPct : broadBufPct;
      const buf = levelPrice * bufPct;
      if (side === 'above') {
        // Sweep up: price > level + buffer
        if (price > levelPrice + buf) {
          if (!lv.swept) {
            lv.swept = true; lv.ts = _now; lv.extreme = price; lv.level = levelPrice;
          } else if (price > lv.extreme) {
            lv.extreme = price;
          }
        }
      } else {
        // Sweep down
        if (price < levelPrice - buf) {
          if (!lv.swept) {
            lv.swept = true; lv.ts = _now; lv.extreme = price; lv.level = levelPrice;
          } else if (price < lv.extreme) {
            lv.extreme = price;
          }
        }
      }
      // Auto-expire sweep flag after 60 minutes of no extension (no longer "recent")
      if (lv.swept && (_now - lv.ts) > 60 * 60 * 1000) {
        lv.swept = false; lv.ts = 0; lv.extreme = 0; lv.level = 0;
      }
    }
  }
  // ===== END PHASE 1 INFRASTRUCTURE =====

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
      // ===== PHASE 3.64 — XAU TREASURY RATE FACTOR (2026-06-28, task #252) =====
      // 10y yield 3-day delta: falling rates = gold bullish (CALL); rising = bearish (PUT).
      // Threshold: 5bps over 3 days. fmpTreasury polled by Phase 3.64 background task.
      try {
        if (fmpTreasury && fmpTreasury.y10_chg_3d != null) {
          const y10ChgBps = fmpTreasury.y10_chg_3d * 100;
          if (isCall && y10ChgBps <= -5) { sc++; factors.push('RATES_DROP'); }
          else if (!isCall && y10ChgBps >= 5) { sc++; factors.push('RATES_RISE'); }
        }
      } catch (e) {}
      // XAU-specific: DXY (24h FX — always live); TLT/SLV/GDX only count while US RTH is
      // open (R1 fix 2026-06-11 — frozen overnight directions were inflating conviction).
      // This also propagates to macroAlignedFor()/contra-blocks, which read conv scores.
      //
      // ===== DXY RE-WEIGHTING for XAU (added 2026-06-17, task #195, Phase 2.7) =====
      // Per XAU trader consensus research: "DXY correlation is real but unreliable intraday.
      // Best practice: use DXY as confluence/confirmation, never as a standalone trigger."
      // Previously DXY was a discrete +1 factor like any other. This let conv stack like
      // [MACRO + ROC×3 + DXY] = 3 conv where DXY did 1/3 of the work — too much weight on
      // a notoriously drift-prone correlation. Now DXY only counts when at least 2 OTHER
      // XAU-specific factors already agree — making it confluence, not trigger.
      const xauOtherFactors = ['MACRO','STRUCT','ROC×3','SLV','GDX','TLT','OB','OB-flip','NAS_SIG','BTC_SIG'];
      const dxyAgree = (isCall && dxyDir === 'down') || (!isCall && dxyDir === 'up');
      if (dxyAgree) {
        // Count current XAU-specific factors already in the stack
        const currentOtherCount = factors.filter(f => xauOtherFactors.indexOf(f) !== -1).length;
        if (currentOtherCount >= 2) {
          sc++; factors.push('DXY');
        }
        // else: silently dropped — DXY alone isn't enough conviction for XAU
      }
      if (rthEtfFresh()) {
        if ((isCall && tltDir === 'up') || (!isCall && tltDir === 'down')) { sc++; factors.push('TLT'); }
        if (slvPrice > 0 && ((isCall && slvDir === 'up') || (!isCall && slvDir === 'down'))) { sc++; factors.push('SLV'); }
        if (gdxPrice > 0 && ((isCall && gdxDir === 'up') || (!isCall && gdxDir === 'down'))) { sc++; factors.push('GDX'); }
      }
      // ===== XAU CROSS-ASSET SIGNAL CONFLUENCE (added 2026-05-28, Option B) =====
      // When NAS or BTC has fired a same-direction signal in the last 10 min, XAU's CALL/PUT
      // gets +1 conv. This is independent confirmation from another asset — much stronger than
      // just "BTC is rising right now". 5/28 case: NAS TRv2 LONG hit TP1 (+$78) at 10:13 ET
      // while XAU was in a rally setup but blocked. NAS_SIG / BTC_SIG would have helped XAU
      // CALL signals reach HIGH conv tier and clear conv-floor gates.
      const CROSS_SIG_WINDOW_MS_XAU = 10 * 60 * 1000;
      const nowXauCross = Date.now();
      const nasS_X = S['NAS100'], btcS_X = S['BTC'];
      if (nasS_X) {
        const lastNasSameDirTs = isCall ? (nasS_X.lastCallSignalTs || 0) : (nasS_X.lastPutSignalTs || 0);
        if (lastNasSameDirTs > 0 && (nowXauCross - lastNasSameDirTs) < CROSS_SIG_WINDOW_MS_XAU) {
          sc++; factors.push('NAS_SIG');
        }
      }
      if (btcS_X) {
        const lastBtcSameDirTs = isCall ? (btcS_X.lastCallSignalTs || 0) : (btcS_X.lastPutSignalTs || 0);
        if (lastBtcSameDirTs > 0 && (nowXauCross - lastBtcSameDirTs) < CROSS_SIG_WINDOW_MS_XAU) {
          sc++; factors.push('BTC_SIG');
        }
      }
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
      // B1 fix (2026-06-11): SPY/QQQ EMAs freeze when US equities close, so these factors
      // kept paying +1 all night — 4 of 7 BTC SL losses (Jun 4–11) cleared conv 4 on frozen
      // equity points. Only count them while RTH is fresh (same rule as XAU's TLT/SLV/GDX).
      // QQQ_SIG below needs no gate — the QQQ bot can't fire outside RTH.
      if (rthEtfFresh()) {
        if ((isCall && spyDir2 === 'up') || (!isCall && spyDir2 === 'down')) { sc++; factors.push('SPY'); }
        if ((isCall && qqqDir2 === 'up') || (!isCall && qqqDir2 === 'down')) { sc++; factors.push('QQQ'); }
      }
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
      // BTC: NAS100 direction as risk-on correlate (B1 fix 2026-06-11). NAS100 futures trade
      // nearly 24h, so unlike SPY/QQQ this factor stays honest overnight — keeps legitimate
      // conviction reachable after the equity factors stop counting (see rthEtfFresh gate above).
      if (isBTC) {
        const nasS_B = S['NAS100'];
        const nasDir2 = nasS_B && nasS_B.pE5 && nasS_B.pE13 ? (nasS_B.pE5 > nasS_B.pE13 ? 'up' : 'down') : null;
        if ((isCall && nasDir2 === 'up') || (!isCall && nasDir2 === 'down')) { sc++; factors.push('NAS'); }
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

    // ===== CONV MATURITY PENALTY (added 2026-05-22, threshold lowered 2026-05-26) =====
    // When a signal (sc≥3) JOINS a move that already happened (signal direction matches
    // the prior 30-min price move with magnitude above a per-symbol threshold), apply -1
    // penalty. The rationale: ROC/MACD/cross-asset factors flip TOGETHER late in a move,
    // producing a 5-7/7 conv reading right as the move exhausts. Threshold lowered from
    // sc≥5 to sc≥3 on 2026-05-26 because TRv2 RIDE entries typically run conv 3-4 and were
    // missing this penalty entirely. Today's BTC TRv2 SHORT at $76,778 fired at conv 3
    // (MACRO+ROC×3+STRUCT) right at the bottom of a sweep — the penalty would have flagged
    // it as 'mature' but the old threshold ignored it. Caught by:
    //   • 5/21 XAU afternoon stack: 3 ATL CALLs at conv 5-7 after $36 rally — 1 scratch + 2 rolls
    //   • 5/21 NAS chop cascade: every TRv2 reverse fired at conv 5-6, all flipped together
    //   • 5/26 BTC TRv2 SHORT at $76,778 fresh trough — conv 3 (would now get -1 → 2)
    if (sc >= 3 && s.prices && s.prices.length >= 30) {
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

    // ===== PHASE 3.41 — VOLUME CONFIRMATION FACTOR (added 2026-06-24, task #243) =====
    // SMC trader research: volume is the #1 filter for distinguishing real vs fake
    // breakouts/reversals. Spike = current 1-min bucket > 1.5x avg of last 20 buckets.
    //
    // Coverage per symbol:
    //   • QQQ/SPY: direct volume from Finnhub WebSocket (real exchange volume)
    //   • NAS100: uses QQQ volume as proxy (99% correlation, NAS CFD has no real vol)
    //   • XAU/BTC: skipped (need separate Finnhub subscription — added in future phase)
    //
    // When spike detected, +1 conv factor 'VOL×<ratio>'. This converts the bot's
    // implicit "rely on cross-asset" conviction into "cross-asset + real volume",
    // matching how professional traders confirm setups.
    function getVolSpike(syState) {
      if (!syState || !Array.isArray(syState.volBuckets) || syState.volBuckets.length < 10) return 0;
      const avg = syState.volBuckets.reduce((a, b) => a + b, 0) / syState.volBuckets.length;
      if (avg <= 0) return 0;
      return (syState.volCurBucket || 0) / avg;
    }
    const volRef = (sym === 'NAS100' && S.QQQ) ? S.QQQ : s;
    const volSpike = getVolSpike(volRef);
    if (volSpike >= 1.5) {
      sc++;
      factors.push('VOL×' + volSpike.toFixed(1));
    }

    // ===== PHASE 3.65 — BTC NEWS SENTIMENT FACTOR (2026-06-28, task #252) =====
    // BTC_NEWS_POS when sentiment > +0.3 and signal is CALL; BTC_NEWS_NEG when < -0.3 and PUT.
    if (sym === 'BTC') {
      try {
        if (fmpBtcNews && typeof fmpBtcNews.sentiment === 'number' && fmpBtcNews.itemCount >= 3) {
          const senti = fmpBtcNews.sentiment;
          if (isCall && senti >= 0.3) { sc++; factors.push('BTC_NEWS_POS'); }
          else if (!isCall && senti <= -0.3) { sc++; factors.push('BTC_NEWS_NEG'); }
        }
      } catch (e) {}
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
    // ===== MT5 DAILY SIGNAL SAFETY VALVE (added 2026-06-11, audit v2 A1) =====
    // Equities are capped at MAX_SIG in the main path; MT5 specialists bypassed every cap.
    // Loose valve, not a tight cap — only a runaway day trips it. Sits here (not as an
    // early return in processPrice) so TRv2 trade management and exits keep running after
    // the cap. Exit signals are never blocked. dailySignalCount is usually incremented
    // pre-gate, so `>` (not `>=`) and the _emitSnapshot rollback keeps the count latched.
    // ===== PHASE 3.52 — MT5 DAILY SIGNAL CAP REMOVED (2026-06-26, task #248) =====
    // Removed: previously `if (s.dailySignalCount > MAX_SIG_MT5) return false;`
    // (with Phase 3.46 strong-regime bypass). Problem: dailySignalCount increments
    // for shadow-blocked signals too, so routine chop activity burns budget and
    // blocks real trades. 06-26 example: by 08:00 ET XAU was at num:36 from shadow
    // blocks, then blocked 7 legitimate reversal PUTs as XAU rolled over from $4094
    // to $4065. Five of those PUTs went the correct direction at 30min.
    // New design: per-symbol gates (chop, regime, conv tier, killzone, same-dir
    // cooldown, fresh-extreme guard, OB proximity, range-extremity) are sufficient
    // to prevent runaway. The daily cap is a redundant safety net that punishes
    // legitimate trend continuation and reversal trades. If a runaway emerges, the
    // chop circuit breaker and same-dir cooldowns will catch it. MAX_SIG_MT5 env
    // variable preserved for potential future re-introduction.

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
        // BTC thresholds tightened 5.0/2.5 → 3.0/1.5 (B3, 2026-06-11): the 6/8–6/10 grind
        // (-3% over 3 days, ~-1%/day windows) scored "neutral" the whole way down, letting
        // counter-trend LLFP CALLs fire at conv 4 into a falling market.
        const strongThr = isXAU ? 2.0 : isBTC ? 3.0 : isNAS ? 3.0 : isEq ? 0.5 : 1.0;
        const weakThr   = isXAU ? 1.0 : isBTC ? 1.5 : isNAS ? 1.5 : isEq ? 0.25 : 0.5;
        let regimeDirRG = 'neutral', regimeStrengthRG = 0;
        if (regimeNetChgPctRG >=  strongThr) { regimeDirRG = 'bull'; regimeStrengthRG = 2; }
        else if (regimeNetChgPctRG <= -strongThr) { regimeDirRG = 'bear'; regimeStrengthRG = 2; }
        else if (regimeNetChgPctRG >=  weakThr) { regimeDirRG = 'bull'; regimeStrengthRG = 1; }
        else if (regimeNetChgPctRG <= -weakThr) { regimeDirRG = 'bear'; regimeStrengthRG = 1; }
        // PHASE 3.66 — recency override
        {
          const _rec = applyRecencyOverride(s, sym, regimeDirRG, regimeStrengthRG);
          if (_rec.downgrade) {
            log(sym, '↪️ Multi-day regime ' + _rec.downgrade + ' (Phase 3.66)');
            regimeDirRG = _rec.dir;
            regimeStrengthRG = _rec.strength;
          }
        }

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
      } else if (sym === 'QQQ' || sym === 'SPY') {
        // ===== REGIME FAIL-SAFE (F2, added 2026-06-12 — 0-losers policy) =====
        // No regime reading = no equity fades. macroSnaps are in-memory; the 6/12 ~09:10
        // redeploy wiped them, leaving the regime gate blind until ~11:10 — all 4 QQQ PUTs
        // (3 losses) fired inside that blind window on a +1.5% call day, the exact pattern
        // the gate had been blocking the day before. If we can't see the tape's direction,
        // counter-trend fades don't fire. Trend-mirror (TMIR) signals are unaffected.
        const isFadeNoRegime = /HI|LO|6\/6|7\/6/.test(tagEarlyRG);
        if (isFadeNoRegime && !String(sig.type).startsWith('exit')) {
          log(sym, '🌫️ ' + tagEarlyRG + ' ' + sig.type.toUpperCase() + ' BLOCKED — regime unavailable (macroSnaps window < 2h, likely post-restart). No regime reading = no fades (F2).');
          return false;
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
      } else {
        // ===== DIRECTION-AWARE FADE EXEMPTION (fixed 2026-06-11) =====
        // The exemption above was direction-blind, letting fades fire on the WRONG side of
        // their extreme: 6/8 ⬆LO CALL at RSI 81.1, 6/10 ⬆LO CALL at RSI 69.8 (SL'd). A LO
        // CALL fades a LOW — it's designed to fire near oversold; by RSI > 65 the bounce
        // already happened and the entry is a chase. Symmetric for HI PUT at deep oversold
        // (XAU equivalent: 6/8 07:15 ⬇HI PUT at RSI 27.5, SL'd).
        if (sig.type === 'call' && typeof rsiV === 'number' && rsiV > 65) {
          log(sym, '🛑 ' + tagQ + ' CALL BLOCKED — fade on wrong side: RSI ' + rsiV.toFixed(1) + ' > 65. LO-fade CALL should fire near the low, not after the bounce.');
          return false;
        }
        if (sig.type === 'put' && typeof rsiV === 'number' && rsiV < 35) {
          log(sym, '🛑 ' + tagQ + ' PUT BLOCKED — fade on wrong side: RSI ' + rsiV.toFixed(1) + ' < 35. HI-fade PUT should fire near the high, not after the drop.');
          return false;
        }
      }
    }

    // ===== QQQ VWAP SESSION-BIAS GATE (added 2026-06-11, proposal U3) =====
    // Momentum entries must be on the right side of session VWAP: 6/6 CALL above, 6/6 PUT
    // below. Fades (HI/LO) are exempt — they fade extremes by design and routinely fire on
    // the "wrong" side. This covers the gap the regime gate leaves on slow-drift days that
    // never leave the neutral band: 6/10 produced three 6/6 CALL losses on a down-drift day
    // (regime read neutral all morning) — all would-be entries below a falling VWAP.
    // NOTE (U2 finding): the regime gate's equity fade regex /HI|LO|6\/6|7\/6/ already
    // matches every QQQ signal type, so counter-regime entries are blocked in WEAK and
    // STRONG regimes alike — the "weak-regime momentum gap" from the proposal turned out
    // to be a NEUTRAL-regime gap, and this VWAP gate is the fix for it.
    if (sym === 'QQQ') {
      const isMomentumQ = /6\/6|7\/6/.test(sig.score || '');
      const vwapQ = s._vwap;
      if (isMomentumQ && typeof vwapQ === 'number' && vwapQ > 0 && isFinite(vwapQ)) {
        if (sig.type === 'call' && price < vwapQ) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🛑 ' + (sig.score || '') + ' CALL BLOCKED — VWAP session bias: $' + price.toFixed(2) + ' < VWAP $' + vwapQ.toFixed(2) + '. Momentum CALL needs price above VWAP.');
          return false;
        }
        if (sig.type === 'put' && price > vwapQ) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🛑 ' + (sig.score || '') + ' PUT BLOCKED — VWAP session bias: $' + price.toFixed(2) + ' > VWAP $' + vwapQ.toFixed(2) + '. Momentum PUT needs price below VWAP.');
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
      } else {
        // ===== DIRECTION-AWARE FADE EXEMPTION (R3 fix 2026-06-11, ports the QQQ fix) =====
        // The blanket exemption let fades fire on the WRONG side of their extreme:
        // 6/5 10:07 ⬆LO CALL at RSI 83.7 (price then dropped $16), 6/8 07:15 ⬇HI PUT at
        // RSI 27.5 (SL'd). A LO/ATL CALL fades a LOW — by RSI > 65 the bounce already
        // happened. A HI/ATH PUT fades a HIGH — at RSI < 35 the drop already happened.
        if (sig.type === 'call' && typeof rsiV === 'number' && rsiV > 65) {
          log(sym, '🛑 ' + tagX + ' CALL BLOCKED — fade on wrong side: RSI ' + rsiV.toFixed(1) + ' > 65. A low-fade CALL fires near the low, not after the bounce.');
          return false;
        }
        if (sig.type === 'put' && typeof rsiV === 'number' && rsiV < 35) {
          log(sym, '🛑 ' + tagX + ' PUT BLOCKED — fade on wrong side: RSI ' + rsiV.toFixed(1) + ' < 35. A high-fade PUT fires near the high, not after the drop.');
          return false;
        }
      }
    }

    // ===== REPEAT-LOSS ZONE LOCKOUT (R5, added 2026-06-11 — 0-losers policy) =====
    // After 2 SL losses from the same detector+direction within 3 hours, stop re-entering
    // until price escapes the loss zone by >= 1.5x ATR (or the 3h window rolls off).
    // 6/8 21:19 + 22:36 + 6/9 01:23: three LHFP PUTs in the same $10 zone, all SL'd —
    // time-based cooldowns alone produce a slow bleed in overnight ranges.
    // Extended XAU → all MT5 (B2, 2026-06-11): same re-entry chains on BTC LLFP CALLs 6/8–6/10.
    if (isMT5 && Array.isArray(s.slLossHistory) && s.slLossHistory.length >= 2) {
      const detNowR5 = String(sig.score || '').replace(/[^A-Z0-9/]/g, '');
      const nowR5 = Date.now();
      const zoneR5 = (typeof atrVal === 'number' && atrVal > 0 ? atrVal : (isBTC ? 35 : isNAS ? 15 : 2)) * 1.5;
      const recentR5 = s.slLossHistory.filter(l =>
        l.det === detNowR5 && l.dir === sig.type && (nowR5 - l.ts) < 10800000);
      if (recentR5.length >= 2 && recentR5.some(l => Math.abs(price - l.ep) <= zoneR5)) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🛑 ' + (sig.score || '') + ' ' + sig.type.toUpperCase() + ' BLOCKED — repeat-loss lockout: ' + recentR5.length + ' ' + detNowR5 + ' ' + sig.type.toUpperCase() + ' SLs in last 3h within $' + zoneR5.toFixed(2) + ' of this price. Re-entry requires price to escape the loss zone (R5).');
        return false;
      }
    }

    const conv = convictionFor(sig.type);
    sig.conv = conv;

    const tagEarly = sig.score || '';
    const isFadeEarly = /ATH|ATL|HI|LO|DIV/.test(tagEarly) && !/MFLIP|TREND|FAST|BREAK|RIDE/.test(tagEarly);
    const macroContraNow = Date.now();

    // ===== SESSION-DIRECTION COUNTER-TREND GATE (added 2026-05-26) =====
    // When the 4-hour price trajectory is decisively in one direction, counter-trend
    // signals need higher conviction to fire. Cross-asset conv factors can be misleading
    // when the symbol itself is grinding the other way.
    //
    // 5/26 case: 3 XAU CALL signals fired during a $4540→$4486 down-session, all
    // with conv 5-7 + OB factor, all SL'd. The conv "HIGH" label came from cross-asset
    // metals (DXY/TLT/SLV/GDX) being CALL-aligned while XAU itself was bleeding.
    // Meanwhile XAU ATL CALL at the actual low (conv 4, lower!) ran TP3 — the fresh-
    // extreme fade was the real reversal, not the chase entries.
    //
    // Rule: if 4h slope exceeds threshold against the signal direction, require conv ≥6
    // (raised from typical 5). Fresh-extreme fades (ATL/ATH/VREV/SWEEP/HI/LO/OBREJ) are
    // EXEMPT — they're designed to fire AT reversal points, not as counter-trend chases.
    //
    // 0-losers safety:
    //   - Only ADDS block conditions, never loosens
    //   - Conv 6+ still allows exceptional setups through
    //   - Fresh-extreme fades preserved (saw XAU ATL TP3 winner with this exemption)
    //   - Per-symbol thresholds (XAU/BTC/NAS have different volatility profiles)
    const isExtremeFadeExempt = /ATL|ATH|VREV|SWEEP|HI|LO|OBREJ|LHFP|LLFP/.test(tagEarly);
    if (!isExtremeFadeExempt && Array.isArray(s.macroSnaps) && s.macroSnaps.length >= 4) {
      // Find closest snapshot to 4h ago — macroSnaps is 5-min interval, 72 entries = 6h
      const fourHrsAgoTs = Date.now() - 4 * 60 * 60 * 1000;
      let refSnap = null;
      for (const snap of s.macroSnaps) {
        if (snap.ts <= fourHrsAgoTs) refSnap = snap;
        else break;
      }
      // Fallback to oldest snap if none is >=4h old yet
      if (!refSnap) refSnap = s.macroSnaps[0];
      const refAgeMs = refSnap ? (Date.now() - refSnap.ts) : 0;
      // Need at least 1h of history for the session trend to be meaningful
      if (refSnap && refSnap.p > 0 && refAgeMs >= 3600000) {
        const sessionPct = ((price - refSnap.p) / refSnap.p) * 100;
        // Per-symbol thresholds — XAU more volatile, NAS even more, BTC most. Equities tight.
        const ctDownThr = isXAU ? -0.20 : isBTC ? -0.40 : isNAS ? -0.30 : -0.15;
        const ctUpThr   = isXAU ?  0.20 : isBTC ?  0.40 : isNAS ?  0.30 :  0.15;
        const inDownSession = sessionPct <= ctDownThr;
        const inUpSession   = sessionPct >= ctUpThr;
        const CT_MIN_CONV = 6;
        if (sig.type === 'call' && inDownSession && conv.score < CT_MIN_CONV) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🌊 ' + tagEarly + ' CALL BLOCKED — counter-trend in DOWN session ('
            + sessionPct.toFixed(2) + '% over ' + Math.round(refAgeMs / 60000) + 'min, conv '
            + conv.score + '/' + CT_MIN_CONV + ' required). Fresh-extreme fades exempt.');
          return false;
        }
        if (sig.type === 'put' && inUpSession && conv.score < CT_MIN_CONV) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🌊 ' + tagEarly + ' PUT BLOCKED — counter-trend in UP session (+'
            + sessionPct.toFixed(2) + '% over ' + Math.round(refAgeMs / 60000) + 'min, conv '
            + conv.score + '/' + CT_MIN_CONV + ' required). Fresh-extreme fades exempt.');
          return false;
        }
      }
    }

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
      // ===== FADE-INSIDE-OPPOSING-OB BLOCK (added 2026-05-26) =====
      // Fade signals (ATL/ATH/HI/LO/VREV/DIV/SWEEP/LHF/LLF) are normally exempt from OB
      // proximity blocks because they're designed to fire AT extremes. But when a fade
      // would enter LITERALLY INSIDE an opposing OB zone, the move is structurally capped
      // and the fade likely fails.
      // 5/26 case: XAU ATL CALL fired at $4,506.85 inside bearish supply OB $4506.41-$4507.62.
      // Entry conv was 5/HIGH from cross-asset metals, but lacked MACRO and OB factors.
      // Price stalled at supply, reversed, SL'd. Price then ran $20+ in the OPPOSITE direction.
      if (isFadeForOb) {
        const insideObZone = price >= ob.lo && price <= ob.hi;
        if (insideObZone) {
          // CALL fade INSIDE bearish supply OB → capped by overhead supply
          if (sig.type === 'call' && ob.dir === 'put') {
            Object.assign(s, _emitSnapshot);
            log(sym, '🧱 ' + tagEarly + ' CALL BLOCKED — fade fires INSIDE bearish supply OB $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' at price $' + price.toFixed(2) + '. Move capped by overhead supply.');
            return false;
          }
          // PUT fade INSIDE bullish demand OB → capped by underlying demand
          if (sig.type === 'put' && ob.dir === 'call') {
            Object.assign(s, _emitSnapshot);
            log(sym, '🧱 ' + tagEarly + ' PUT BLOCKED — fade fires INSIDE bullish demand OB $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' at price $' + price.toFixed(2) + '. Move capped by underlying demand.');
            return false;
          }
        }
      }
    }
    // ===== FADE-INSIDE-OPPOSING-OB BLOCK — XAU orderBlocks array (added 2026-05-26) =====
    // XAU also tracks displacement OBs in s.orderBlocks (separate from s.obZone). Apply
    // the same "no fading inside opposing OB" rule to those zones too.
    if (isXAU && Array.isArray(s.orderBlocks) && s.orderBlocks.length > 0) {
      const isFadeForObXAU = /VREV|ATH|ATL|HI|LO|DIV|SWEEP|LHF|LLF/.test(tagEarly);
      if (isFadeForObXAU) {
        for (const ob of s.orderBlocks) {
          if (ob.mitigated) continue;
          const insideOb = price >= ob.lo && price <= ob.hi;
          if (!insideOb) continue;
          // CALL fade INSIDE bearish supply (orderBlocks type 'bear')
          if (sig.type === 'call' && ob.type === 'bear') {
            Object.assign(s, _emitSnapshot);
            log(sym, '🧱 ' + tagEarly + ' CALL BLOCKED — fade fires INSIDE bearish supply (orderBlocks) $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' at $' + price.toFixed(2) + '. Move capped by overhead supply.');
            return false;
          }
          // PUT fade INSIDE bullish demand (orderBlocks type 'bull')
          if (sig.type === 'put' && ob.type === 'bull') {
            Object.assign(s, _emitSnapshot);
            log(sym, '🧱 ' + tagEarly + ' PUT BLOCKED — fade fires INSIDE bullish demand (orderBlocks) $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' at $' + price.toFixed(2) + '. Move capped by underlying demand.');
            return false;
          }
        }
      }
    }

    // ===== PHASE 2 — UNIVERSAL PRE-GATE (added 2026-06-17, tasks #189-#194) =====
    // Structural/timing/location/quality gates that fire BEFORE the chop block and most
    // detector-specific checks. Consumes Phase 1 state (s.session, s.asianH, s.htf1h_dir,
    // s.rangeZone, s.liqPools, s.newsBlackout). These gates implement the "levels-first"
    // methodology that mainstream XAU traders actually use.
    //
    // Order matters — most-defensive gates fire first:
    //   1. News blackout (kill switch)
    //   2. HTF bias agreement (macro structural)
    //   3. Killzone window (timing)
    //   4. Premium/discount zone (location, chop only)
    //   5. Range-extremity (location, always)
    //   6. OB 50% retracement (quality, OB detectors only)
    //
    // Exit signals (sig.type starts with 'exit') are EXEMPT from all Phase 2 gates —
    // we never want to block an exit.
    if (!String(sig.type).startsWith('exit')) {
      const tagP2 = sig.score || '';
      const isFadeP2 = /VREV|LHF|LLF|OBREJ|OBMIT|STRUCT_SWEEP|STRUCT_LIQ_GRAB|STRUCT_OB_FILL|INVERSAL_BREAK/.test(tagP2);
      const isP2Mt5 = isXAU || isBTC || isNAS;

      // ── 2.1: News Blackout Gate (task #189)
      // Block ALL entries when within 15min before / 30min after high-impact USD event.
      // s.newsBlackout populated by pollEconomicCalendar (Phase 1.7).
      if (s.newsBlackout && s.newsBlackout.active) {
        Object.assign(s, _emitSnapshot);
        const nb = s.newsBlackout;
        log(sym, '📰 ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — news blackout: ' + (nb.eventName || 'unknown event') + ' in ' + (nb.minutesUntil != null ? nb.minutesUntil + 'min' : '?') + ' (impact: ' + (nb.impact || '?') + ').');
        return false;
      }

      // ── 2.2: HTF Bias Agreement Gate (task #190)
      // Block signals fighting BOTH the 1h AND 4h trend. Single-tf disagreement is OK
      // (caught by existing regime gate); double-disagreement is the high-conviction trap
      // that conviction scoring can't see. Only applied when both HTF reads are available.
      if (isP2Mt5 && s.htf1h_dir && s.htf4h_dir) {
        const isCall_p2 = sig.type === 'call';
        const fightsH1 = (isCall_p2 && s.htf1h_dir === 'down') || (!isCall_p2 && s.htf1h_dir === 'up');
        const fightsH4 = (isCall_p2 && s.htf4h_dir === 'down') || (!isCall_p2 && s.htf4h_dir === 'up');
        // Fade detectors are EXEMPT — they're designed to fade local moves against HTF
        if (fightsH1 && fightsH4 && !isFadeP2) {
          Object.assign(s, _emitSnapshot);
          log(sym, '📈 ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — fights BOTH 1h (' + s.htf1h_dir + ' ' + s.htf1h_strength.toFixed(2) + '%) AND 4h (' + s.htf4h_dir + ' ' + s.htf4h_strength.toFixed(2) + '%) HTF trend. Double-disagreement is the trap.');
          return false;
        }
      }

      // ── 2.3: Killzone Window Gate (task #191) — UPDATED 2026-06-22 with Phase 3.37 conv override
      // In chop, outside London KZ (02:00-05:00 ET) + NY AM (08:00-11:00 ET): only fades.
      // Killzones print 60-70% of intraday range. Trend signals outside KZ in chop are
      // structurally low-quality (they fire in low-vol consolidation that mean-reverts).
      //
      // ===== PHASE 3.37 OVERRIDE (added 2026-06-22, task #238) =====
      // Conv ≥ 5 (HIGH tier) override: when cross-asset confluence is HIGH and all factors
      // agree, the directional thesis is strong enough to override the time-of-day chop rule.
      // 6/22 case: BTC RIDE PUT conv 5 HIGH at 14:26 (all cross-asset PUT-aligned) blocked
      // by chop+nyPM rule. NAS RIDE CALL conv 8 HIGH at 14:16 same problem.
      //
      // Trade management for override signals is HANDLED IN TRv2 ENTRY (line ~7896) using
      // tighter SL/TP multipliers — smaller risk, faster BE-trail — to manage the elevated
      // chop reversal risk.
      if (isP2Mt5 && s.chopActive && !s.inKillzone && !isFadeP2) {
        const convForKZOverride = sig.conv ? sig.conv.score : convictionFor(sig.type).score;
        if (convForKZOverride < 5) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🕐 ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — outside Killzone (session: ' + (s.session || '?') + ') + chop active, conv ' + convForKZOverride + '/5 needed for override. Non-fade detectors restricted to London KZ / NY AM in chop.');
          return false;
        }
        // High-conv signal passed override — log the bypass for visibility
        log(sym, '↪️ ' + tagP2 + ' ' + sig.type.toUpperCase() + ' KILLZONE OVERRIDE — conv ' + convForKZOverride + '/5+ allowed despite chop+outside-KZ (' + (s.session || '?') + '). Tighter TP/SL applied.');
      }

      // ── 2.4: Premium/Discount Zone Gate (task #192) — chop only
      // In chop with a defined range (Asian or rolling), don't long the top, don't short
      // the bottom. This enforces "buy low, sell high" structurally — the inverse of the
      // 6/15-16 XAU losses where we kept shorting $4,307 and longing $4,325.
      // Fade detectors are EXEMPT — they're designed to fade extremes.
      if (isP2Mt5 && s.chopActive && s.rangeZone && !isFadeP2) {
        // PHASE 3.72 — conv ≥6 bypasses premium/discount zone gate (2026-06-29, task #260)
        // 5-day audit: 0 straight-SL losers at conv 6+. Quality gates that filter location
        // (top/bottom of range) become noise at HIGH conviction — the cross-asset confluence
        // already validates the entry.
        if (sig.type === 'call' && s.rangeZone === 'premium') {
          if (conv && conv.score >= 6) {
            log(sym, '↪️ ' + tagP2 + ' CALL EXEMPT (premium zone) — conv ' + conv.score + '/7 HIGH bypasses zone gate (Phase 3.72). Buying premium with cross-asset confirmation.');
          } else {
            Object.assign(s, _emitSnapshot);
            log(sym, '🏔️ ' + tagP2 + ' CALL BLOCKED — premium zone (' + s.rangePosPct.toFixed(0) + '% of ' + s.rangeRef + ' range $' + s.rangeRefLo.toFixed(2) + '-$' + s.rangeRefHi.toFixed(2) + '). Buying the top in chop.');
            return false;
          }
        }
        if (sig.type === 'put' && s.rangeZone === 'discount') {
          if (conv && conv.score >= 6) {
            log(sym, '↪️ ' + tagP2 + ' PUT EXEMPT (discount zone) — conv ' + conv.score + '/7 HIGH bypasses zone gate (Phase 3.72). Shorting discount with cross-asset confirmation.');
          } else {
            Object.assign(s, _emitSnapshot);
            log(sym, '🏕️ ' + tagP2 + ' PUT BLOCKED — discount zone (' + s.rangePosPct.toFixed(0) + '% of ' + s.rangeRef + ' range $' + s.rangeRefLo.toFixed(2) + '-$' + s.rangeRefHi.toFixed(2) + '). Shorting the bottom in chop.');
            return false;
          }
        }
      }

      // ── 2.5: Range-Extremity Guard (task #193) — defense-in-depth, always-on for non-fades
      // Even outside chop, non-fade detectors firing in the top/bottom 15% of any defined
      // range are usually chasing exhaustion. Catches cases where chop flag hasn't yet
      // activated but price is at a structural extreme.
      //
      // ===== PHASE 3.16 — REGIME-AWARE EXTREMITY (added 2026-06-19, task #216) =====
      // In a clearly directional multi-day regime, "the wrong extreme" is actually trend
      // continuation, not exhaustion. PUT at the bottom of a 5-day downtrend isn't
      // "shorting the low" — it's joining the trend. CALL at the top of a 5-day uptrend
      // likewise.
      //
      // 6/18 case: XAU TRv2 RIDE PUTs blocked at the bottom 15% during a clear bear regime.
      // Two of them (12:18 @ $4226, 12:51 @ $4217) would have hit TP1 as XAU continued
      // $4226 → $4144. Net cost: ~2 missed TP1 winners. Meanwhile every blocked CALL on
      // the same day would have lost (-$330+ avoided) — so CALL blocks were correct, only
      // the PUT side was over-strict.
      //
      // Rule: in a STRONG (strength=2) or WEAK (strength=1) directional regime, allow
      // trend-continuation entries at the matching extremity. Counter-trend entries at
      // the wrong extremity stay blocked (those are exhaustion chases).
      //
      // Reads sig._regime annotation set by the earlier multi-day regime gate (line 3384).
      // If regime data is unavailable (regime === undefined), falls back to the original
      // symmetric behavior — safer default.
      if (isP2Mt5 && s.rangePosPct !== null && !isFadeP2) {
        const TOP_PCT = 85;    // top 15%
        const BOT_PCT = 15;    // bottom 15%
        const regime = sig._regime;
        const isBearRegime = regime && regime.dir === 'bear' && regime.strength >= 1;
        const isBullRegime = regime && regime.dir === 'bull' && regime.strength >= 1;
        // PHASE 3.72 — conv ≥6 also bypasses range-extremity (2026-06-29, task #260)
        const _highConvExempt = conv && conv.score >= 6;
        if (sig.type === 'call' && s.rangePosPct >= TOP_PCT) {
          if (isBullRegime) {
            log(sym, '↪️ ' + tagP2 + ' CALL EXEMPT (range-extremity) — ' + s.rangePosPct.toFixed(0) + '% of ' + s.rangeRef + ' range BUT BULL regime (' + regime.window + ' ' + (regime.netChgPct >= 0 ? '+' : '') + regime.netChgPct + '%, strength ' + regime.strength + '). Top extremity = trend continuation in bull regime.');
          } else if (_highConvExempt) {
            log(sym, '↪️ ' + tagP2 + ' CALL EXEMPT (range-extremity) — conv ' + conv.score + '/7 HIGH bypasses extremity gate (Phase 3.72). Cross-asset confluence validates the entry.');
          } else {
            Object.assign(s, _emitSnapshot);
            log(sym, '🎯 ' + tagP2 + ' CALL BLOCKED — range-extremity guard: ' + s.rangePosPct.toFixed(0) + '% of ' + s.rangeRef + ' range. Top 15% reserved for fade detectors' + (regime ? ' (regime: ' + regime.dir + ' s' + regime.strength + ')' : ' (no regime data)') + '.');
            return false;
          }
        }
        if (sig.type === 'put' && s.rangePosPct <= BOT_PCT) {
          if (isBearRegime) {
            log(sym, '↪️ ' + tagP2 + ' PUT EXEMPT (range-extremity) — ' + s.rangePosPct.toFixed(0) + '% of ' + s.rangeRef + ' range BUT BEAR regime (' + regime.window + ' ' + (regime.netChgPct >= 0 ? '+' : '') + regime.netChgPct + '%, strength ' + regime.strength + '). Bottom extremity = trend continuation in bear regime.');
          } else if (_highConvExempt) {
            log(sym, '↪️ ' + tagP2 + ' PUT EXEMPT (range-extremity) — conv ' + conv.score + '/7 HIGH bypasses extremity gate (Phase 3.72). Cross-asset confluence validates the entry.');
          } else {
            Object.assign(s, _emitSnapshot);
            log(sym, '🎯 ' + tagP2 + ' PUT BLOCKED — range-extremity guard: ' + s.rangePosPct.toFixed(0) + '% of ' + s.rangeRef + ' range. Bottom 15% reserved for fade detectors' + (regime ? ' (regime: ' + regime.dir + ' s' + regime.strength + ')' : ' (no regime data)') + '.');
            return false;
          }
        }
      }

      // ── 2.6: OB 50% Retracement Rule (task #194)
      // OBMIT/OBREJ require price has retraced at least 50% into the OB zone before firing.
      // First-touch OB tests bounce too weakly — wait for deep retracement which confirms
      // institutional interest. Uses existing s.obZone tracking.
      if (/OBMIT|OBREJ/.test(tagP2) && s.obZone && s.obZone.hi > s.obZone.lo) {
        const obMid = (s.obZone.hi + s.obZone.lo) / 2;
        // Check current price retracement depth into OB
        let retracePct = 0;
        if (s.obZone.dir === 'bull') {
          // Bullish OB below — price retracing DOWN into it. 100% = at lo, 0% = at hi.
          retracePct = ((s.obZone.hi - price) / (s.obZone.hi - s.obZone.lo)) * 100;
        } else if (s.obZone.dir === 'bear') {
          // Bearish OB above — price retracing UP into it. 100% = at hi, 0% = at lo.
          retracePct = ((price - s.obZone.lo) / (s.obZone.hi - s.obZone.lo)) * 100;
        }
        if (retracePct < 50) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🧱 ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — OB retracement only ' + retracePct.toFixed(0) + '% (<50%). Weak first-touch test — wait for deeper fill.');
          return false;
        }
      }

      // ── 2.8: STRUCT/INVERSAL RSI direction-consistency (task #202, added 2026-06-17)
      // Catches "wrong-direction fade" entries — e.g., CALL at RSI 75 chasing an exhausted
      // bounce. The STRUCT_* / INVERSAL_BREAK detectors are designed to fire AGAINST
      // exhaustion. Firing IN the direction of exhaustion is the failure mode.
      //
      // 6/17 04:08 NAS100 STRUCT_LIQ_GRAB CALL @ RSI 75.7 → SL -$47/contract.
      // The detector fired because a pool below was swept then price came back above —
      // structurally valid — BUT by the time price rallied that far, RSI was deeply
      // overbought. We were buying the top of the bounce.
      //
      // Thresholds 72/28 (not 70/30): STRUCT/INVERSAL detectors SHOULD fire near
      // RSI extremes (that's where structural setups happen). 70/30 would block
      // legitimate setups. 72/28 still allows the normal "near-extreme" zone but
      // blocks the disasters above 72 / below 28.
      if (/STRUCT_SWEEP|STRUCT_LIQ_GRAB|STRUCT_OB_FILL|STRUCT_VWAP|INVERSAL_BREAK/.test(tagP2)) {
        const rsiP2 = parseFloat(sig.rsi);
        if (!isNaN(rsiP2)) {
          if (sig.type === 'call' && rsiP2 > 72) {
            Object.assign(s, _emitSnapshot);
            log(sym, '🚫 ' + tagP2 + ' CALL BLOCKED — RSI ' + rsiP2.toFixed(1) + ' > 72 — chasing overbought / exhausted bounce. Wrong-direction fade.');
            return false;
          }
          if (sig.type === 'put' && rsiP2 < 28) {
            Object.assign(s, _emitSnapshot);
            log(sym, '🚫 ' + tagP2 + ' PUT BLOCKED — RSI ' + rsiP2.toFixed(1) + ' < 28 — chasing oversold / exhausted drop. Wrong-direction fade.');
            return false;
          }
        }
      }

      // ===== PHASE 3.17 / FIX B — INVERSAL_BREAK RSI 35/65 TIGHTER FLOOR (added 2026-06-19, task #217) =====
      // INVERSAL_BREAK fires on FAILED breakouts — by definition implying momentum is
      // already reversing. Firing INVERSAL_BREAK at exhausted RSI is the worst-case
      // setup: the reversal that the detector is trying to ride has already played out
      // and we're entering at the turning point of the turning point.
      //
      // Phase 2.8 above blocks the STRUCT/INVERSAL family at 72/28. INVERSAL_BREAK
      // alone gets a tighter 65/35 floor because:
      //
      // 6/18 02:40 NAS INVERSAL_BREAK PUT @ RSI 30.0 → SL -$60/contract.
      // RSI 30.0 was 2 points inside Phase 2.8's no-fire zone (< 28) so it slipped
      // through. With this tighter floor (PUT requires RSI ≥ 35, CALL requires
      // RSI ≤ 65), it would have been blocked.
      //
      // Other STRUCT detectors (SWEEP, LIQ_GRAB, OB_FILL, VWAP) stay at 72/28 — they
      // benefit from firing closer to extremes because they have structural anchors
      // (sweep level, liquidity pool, OB zone). INVERSAL_BREAK has no such anchor —
      // it's pure momentum reversal logic, so it needs the wider safety margin.
      if (/INVERSAL_BREAK/.test(tagP2)) {
        const rsiP2 = parseFloat(sig.rsi);
        if (!isNaN(rsiP2)) {
          if (sig.type === 'call' && rsiP2 > 65) {
            Object.assign(s, _emitSnapshot);
            log(sym, '🚫 ' + tagP2 + ' CALL BLOCKED — INVERSAL_BREAK RSI ' + rsiP2.toFixed(1) + ' > 65 (tighter floor than other STRUCTs). Failed-breakout CALL at overbought is chasing exhaustion.');
            return false;
          }
          if (sig.type === 'put' && rsiP2 < 35) {
            Object.assign(s, _emitSnapshot);
            log(sym, '🚫 ' + tagP2 + ' PUT BLOCKED — INVERSAL_BREAK RSI ' + rsiP2.toFixed(1) + ' < 35 (tighter floor than other STRUCTs). Failed-breakout PUT at oversold is chasing exhaustion.');
            return false;
          }
        }
      }

      // ===== PHASE 3.18 / FIX C — STRUCT_LIQ_GRAB HTF/REGIME GATE (added 2026-06-19, task #218) =====
      // STRUCT_LIQ_GRAB is in the isFadeP2 regex (line 3756), which exempts it from the
      // Phase 2.2 HTF Bias Agreement Gate. That exemption made sense for pure fades
      // (LHF/LLF/OBREJ are designed to counter local moves), but STRUCT_LIQ_GRAB is more
      // structural — it fires when a liquidity pool gets swept then price reclaims the
      // level. On RANGING days, that's a legitimate reversal pattern. On strongly
      // TRENDING days, the same setup is just a stop-hunt that resolves IN the trend's
      // direction — and we're betting against the trend.
      //
      // 6/18 08:48 BTC STRUCT_LIQ_GRAB CALL @ $64,282 → SL -$306/unit.
      //   - BTC was in a multi-day BEAR regime (5-day net -2.5%)
      //   - HTF 1h: down, HTF 4h: down
      //   - The grab structurally valid (a pool below got swept then reclaimed)
      //   - BUT the reclaim was a dead-cat bounce; trend resumed within an hour.
      //
      // Rule: STRUCT_LIQ_GRAB now requires EITHER:
      //   (a) Multi-day regime supports its direction (bull regime → CALL OK; bear → PUT OK)
      //   (b) At least one HTF (1h or 4h) supports its direction
      //   (c) Both HTFs read "neutral" (no clear directional bias)
      // Block only when ALL three conditions fail — i.e., directional regime AGAINST and
      // BOTH HTFs against. That's the strongest possible "fighting the tide" signal.
      if (/STRUCT_LIQ_GRAB/.test(tagP2)) {
        const isCallLG = sig.type === 'call';
        const regimeLG = sig._regime;
        const regimeAgainst = regimeLG && regimeLG.strength >= 1 &&
                              ((isCallLG && regimeLG.dir === 'bear') ||
                               (!isCallLG && regimeLG.dir === 'bull'));
        const h1Against = s.htf1h_dir && ((isCallLG && s.htf1h_dir === 'down') || (!isCallLG && s.htf1h_dir === 'up'));
        const h4Against = s.htf4h_dir && ((isCallLG && s.htf4h_dir === 'down') || (!isCallLG && s.htf4h_dir === 'up'));
        // Block ONLY when regime is directionally against AND both HTFs are against.
        // If either HTF is neutral/missing or regime is neutral/missing, we let it through —
        // the existing Phase 2.8 RSI gate is the secondary safety net.
        if (regimeAgainst && h1Against && h4Against) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🌪️ ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — STRUCT_LIQ_GRAB fights regime ' + regimeLG.dir + '(' + regimeLG.netChgPct + '%) + HTF1h ' + s.htf1h_dir + ' + HTF4h ' + s.htf4h_dir + '. Liq grab against all 3 tides = dead-cat bounce setup.');
          return false;
        }
      }

      // ===== PHASE 3.60 — OBREJ HIGH-GRADE ZONE REQUIREMENT (2026-06-26, task #249) =====
      // Research: "High-grade zones → expect a reaction, fade the tap." OBREJ should
      // only fire at HTF extremes (top/bottom of multi-day range), not at internal
      // range OBs. If OBREJ fires inside the daily range (>1% from 24h high/low),
      // require conviction tier HIGH (5+) to fire. Otherwise block as "low-grade".
      if (/OBREJ/.test(tagP2)) {
        try {
          let sessHi = -Infinity, sessLo = Infinity;
          if (s.macroSnaps && s.macroSnaps.length > 0) {
            const cutoff24h = Date.now() - 86400000;
            s.macroSnaps.forEach(sn => {
              if (sn && sn.ts >= cutoff24h && sn.p > 0) {
                if (sn.p > sessHi) sessHi = sn.p;
                if (sn.p < sessLo) sessLo = sn.p;
              }
            });
          }
          if (sessHi > 0 && sessLo > 0 && sessHi !== -Infinity && sessLo !== Infinity) {
            const distHiPct = (sessHi - price) / price * 100;
            const distLoPct = (price - sessLo) / price * 100;
            const isCallOR = sig.type === 'call';
            // CALL OBREJ fades resistance (top) — needs price near 24h high (within 1%)
            // PUT OBREJ fades support (bottom) — needs price near 24h low (within 1%)
            const nearExtreme = isCallOR ? distHiPct < 1.0 : distLoPct < 1.0;
            if (!nearExtreme) {
              const tagConv = (typeof convictionFor === 'function') ? convictionFor(sym, sig) : null;
              const tagConvS = tagConv ? tagConv.score : 0;
              if (tagConvS < 5) {
                Object.assign(s, _emitSnapshot);
                log(sym, '🧱 ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — OBREJ at low-grade zone (CALL distHi=' + distHiPct.toFixed(2) + '%, PUT distLo=' + distLoPct.toFixed(2) + '%, conv ' + tagConvS + '<5). Research: OBREJ only edges at HTF extremes (Phase 3.60).');
                return false;
              }
            }
          }
        } catch (e) {}
      }

      // ===== PHASE 3.39 / OBREJ HTF GATE (added 2026-06-23, task #240) =====
      // OBREJ is currently in isFadeP2 regex — exempt from Phase 2.2 HTF Bias Agreement.
      // That exemption made sense for true fades (LHF/LLF — small local-extreme fades),
      // but OBREJ fades INSTITUTIONAL order blocks which are themselves directional
      // structures. Per SMC research (tradelikemaster.com, fxnx.com, dailypriceaction.com):
      //   • OBs WITH HTF confluence: 65-75% win rate (tradeable edge)
      //   • OBs WITHOUT HTF confluence: ~50% — coin flip
      //   • OBs AGAINST HTF: <40% — explicit "common mistake to avoid"
      //
      // 6/22 evidence: 2 of 2 resolved XAU OBREJ CALLs fired into clear bearish HTF
      // (XAU was dropping from $4,212 → $4,116). Both SL'd.
      //
      // Rule: block OBREJ only when fighting BOTH 1h AND 4h (worst case). If either
      // HTF is neutral/missing or aligned, OBREJ still fires. Same pattern as Phase 3.18.
      if (/OBREJ/.test(tagP2) && s.htf1h_dir && s.htf4h_dir) {
        const isCallOb = sig.type === 'call';
        const fightsH1_OB = (isCallOb && s.htf1h_dir === 'down') || (!isCallOb && s.htf1h_dir === 'up');
        const fightsH4_OB = (isCallOb && s.htf4h_dir === 'down') || (!isCallOb && s.htf4h_dir === 'up');
        if (fightsH1_OB && fightsH4_OB) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🧱 ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — OBREJ fights both HTFs (1h=' + s.htf1h_dir + ', 4h=' + s.htf4h_dir + '). Counter-HTF OB rejection has ~50% win rate per SMC research; against both HTFs it drops to <40%.');
          return false;
        }
      }

      // ===== PHASE 3.59 — LHFP/LLFP HTF BIAS GATE (2026-06-26, task #249) =====
      // Research validation: counter-HTF fades have 45-65% WR; against HTF: <50%.
      // Our LHFP/LLFP on NAS over 4 days = 43% WR — right at the bad-fade boundary.
      // Mirror of Phase 3.39 OBREJ gate. LHFP PUT (fade local high) needs HTF NOT
      // bullish. LLFP CALL (fade local low) needs HTF NOT bearish. Block only when
      // BOTH 1h AND 4h are against (same conservatism as 3.39).
      if (/LHFP|LLFP/.test(tagP2) && s.htf1h_dir && s.htf4h_dir) {
        const isCallLfp = sig.type === 'call';
        const fightsH1_LFP = (isCallLfp && s.htf1h_dir === 'down') || (!isCallLfp && s.htf1h_dir === 'up');
        const fightsH4_LFP = (isCallLfp && s.htf4h_dir === 'down') || (!isCallLfp && s.htf4h_dir === 'up');
        if (fightsH1_LFP && fightsH4_LFP) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🧱 ' + tagP2 + ' ' + sig.type.toUpperCase() + ' BLOCKED — LHFP/LLFP fights both HTFs (1h=' + s.htf1h_dir + ', 4h=' + s.htf4h_dir + '). Counter-HTF fades have <50% WR per SMC research; 43% measured WR on NAS confirms (Phase 3.59).');
          return false;
        }
      }
    }
    // ===== END PHASE 2 PRE-GATE =====

    // ===== CHOP SUPPRESSION — NAS + BTC + XAU (extended 2026-06-16 to XAU) =====
    // Original 5/18: 4 of 5 NAS RIDE losses + 1 BREAK loss during NAS chop $28800-29150.
    // Extended 5/19: 3 BTC BREAK losses overnight in $76,600-77,200 chop range.
    // Extended 6/16: XAU added after 4 clean SLs on 6/15-16 in $4307-$4327 chop range:
    //   6/15 20:22 ⬇BREAK PUT → SL -$11.36
    //   6/15 21:01 ⬆BREAK CALL → SL -$9.69
    //   6/15 22:06 ⬇6/6 PUT @ $4307.61 → SL -$10.17 (range LOW short)
    //   6/16 11:25 ⬇LHF PUT → SL -$7.24 (with positive MACD — additional MACD guard below)
    //
    // Rule: in chop mode (NAS/BTC/XAU), allow ONLY fade-at-extremes detectors:
    // V-REV, LHF/LHFP, LLF/LLFP, OBREJ, OBMIT. These are DESIGNED for the bounce-off-the-edges
    // pattern. Block all other detectors (BREAK, FAST, TREND, RIDE, ATH, ATL, HI, LO,
    // MFLIP, 6/6, DIV, TMIR, etc.).
    if ((isNAS || isBTC || isXAU) && s.chopActive) {
      const isFadeAllowedInChop = /VREV|LHF|LLF|OBREJ|OBMIT|STRUCT_SWEEP|STRUCT_LIQ_GRAB|STRUCT_OB_FILL|INVERSAL_BREAK/.test(tagEarly);
      if (!isFadeAllowedInChop) {
        // ===== PHASE 3.54 REVISED — VOL>=1.5x BYPASS (2026-06-26, task #249) =====
        // Pro research: "Low-grade on volume → trade the break." Volume confirmation
        // 1.5x+ is the standard validation threshold (per LuxAlgo, TradingSim, Trade
        // with the Pros). Our chop-block was rejecting trend continuation entries even
        // when volume confirmed the breakout. Now: if conviction contains VOL>=1.5x
        // AND signal direction matches recent 30min directional move, allow through.
        let _chopVolBypass = false;
        try {
          const cConv = (typeof convictionFor === 'function') ? convictionFor(sym, sig) : null;
          const volF = (cConv && cConv.factors || []).find(f => /^VOL×/.test(f));
          const volS = volF ? parseFloat(volF.split('×')[1]) : 0;
          if (volS >= 1.5 && s.macroSnaps && s.macroSnaps.length >= 6) {
            const sn30 = s.macroSnaps[Math.max(0, s.macroSnaps.length - 6)];
            if (sn30 && sn30.p > 0) {
              const dirChg = (price - sn30.p) / sn30.p;
              const sigDir = sig.type === 'call' ? 1 : sig.type === 'put' ? -1 : 0;
              const aligned = (sigDir > 0 && dirChg > 0.001) || (sigDir < 0 && dirChg < -0.001);
              if (aligned) {
                _chopVolBypass = true;
                log(sym, '↪️ ' + tagEarly + ' ' + sig.type.toUpperCase() + ' — chop bypass: VOL×' + volS.toFixed(1) + ' + aligned dir (30min ' + (dirChg * 100).toFixed(2) + '%). Allowed (Phase 3.54).');
              }
            }
          }
        } catch (e) {}
        // ===== PHASE 3.63 — BTC MILD-CHOP RIDE BYPASS (2026-06-27, task #251) =====
        // Even when Phase 3.54 VOL bypass doesn't trigger (e.g. VOL data still warming up
        // on BTC after Phase 3.61, or VOL spike below 1.5x), BTC has a "mild chop" gray
        // zone where 60min range is 0.5-1.5% — not pure trend, not dead chop. RIDE entries
        // with conv >= 6 (HIGH+) in this zone are usually directional continuation, not
        // mean-reversion. Allow them if direction aligns with 60min movement direction.
        let _btcMildChopBypass = false;
        if (!_chopVolBypass && sym === 'BTC' && /RIDE/.test(tagEarly)) {
          try {
            if (s.macroSnaps && s.macroSnaps.length >= 12) {
              const sn60 = s.macroSnaps[Math.max(0, s.macroSnaps.length - 12)];
              if (sn60 && sn60.p > 0) {
                const recentSnaps = s.macroSnaps.slice(-12);
                let mn = Infinity, mx = -Infinity;
                recentSnaps.forEach(sn => {
                  if (sn && sn.p > 0) {
                    if (sn.p < mn) mn = sn.p;
                    if (sn.p > mx) mx = sn.p;
                  }
                });
                const rangePct = (mx > 0 && mn !== Infinity) ? (mx - mn) / mn * 100 : 0;
                const isMildChop = rangePct >= 0.5 && rangePct <= 1.5;
                if (isMildChop) {
                  const cBtc = (typeof convictionFor === 'function') ? convictionFor(sym, sig) : null;
                  const cBtcS = cBtc ? cBtc.score : 0;
                  const netDir = (price - sn60.p) / sn60.p;
                  const sigD = sig.type === 'call' ? 1 : sig.type === 'put' ? -1 : 0;
                  const aligned63 = (sigD > 0 && netDir > 0.002) || (sigD < 0 && netDir < -0.002);
                  if (cBtcS >= 6 && aligned63) {
                    _btcMildChopBypass = true;
                    log(sym, '↪️ ' + tagEarly + ' ' + sig.type.toUpperCase() + ' — BTC mild-chop bypass (Phase 3.63): 60min range ' + rangePct.toFixed(2) + '% + conv ' + cBtcS + ' + aligned dir (' + (netDir * 100).toFixed(2) + '%). Allowed.');
                  }
                }
              }
            }
          } catch (e) {}
        }
        // ===== PHASE 3.69 — XAU METALS-CONFLUENCE CHOP BYPASS (2026-06-29, task #257) =====
        // XAU has no volume data so Phase 3.54 VOL bypass never fires. But XAU has
        // its own equivalent: cross-asset metals confluence (DXY, TLT, SLV, GDX).
        // When 3+ of the 4 metals factors agree with the signal direction at conv>=5,
        // that's "smart-money confirmation" similar to a volume spike in equities.
        // Real example: 06-29 13:45 XAU PUT @ $4021.70 had conv 6 with all 4 metals
        // (DXY+TLT+SLV+GDX) and XAU rolled over $5 in 30min — that signal would have
        // been a winner but got blocked. This bypass allows it.
        let _xauMetalsBypass = false;
        if (!_chopVolBypass && !_btcMildChopBypass && sym === 'XAU' && /RIDE/.test(tagEarly)) {
          try {
            const cXau = (typeof convictionFor === 'function') ? convictionFor(sym === 'QQQ' ? 'call' : (sig.type === 'call' ? 'call' : 'put')) : null;
            const cXauS = cXau ? cXau.score : 0;
            const cXauF = cXau ? (cXau.factors || []) : [];
            const metalsSet = ['DXY', 'TLT', 'SLV', 'GDX'];
            const metalsCount = metalsSet.filter(m => cXauF.indexOf(m) !== -1).length;
            if (cXauS >= 5 && metalsCount >= 3) {
              // Direction alignment check using macroSnaps (30min ≈ 6 snaps of 5min)
              if (s.macroSnaps && s.macroSnaps.length >= 6) {
                const sn30x = s.macroSnaps[Math.max(0, s.macroSnaps.length - 6)];
                if (sn30x && sn30x.p > 0) {
                  const dirChgX = (price - sn30x.p) / sn30x.p;
                  const sigDX = sig.type === 'call' ? 1 : sig.type === 'put' ? -1 : 0;
                  const alignedX = (sigDX > 0 && dirChgX > 0.001) || (sigDX < 0 && dirChgX < -0.001);
                  if (alignedX) {
                    _xauMetalsBypass = true;
                    log(sym, '↪️ ' + tagEarly + ' ' + sig.type.toUpperCase() + ' — XAU metals-confluence bypass (Phase 3.69): conv ' + cXauS + ' + ' + metalsCount + '/4 metals (' + metalsSet.filter(m => cXauF.indexOf(m) !== -1).join(',') + ') + aligned dir (' + (dirChgX * 100).toFixed(2) + '%). Allowed.');
                  }
                }
              }
            }
          } catch (e) {}
        }
        // ===== PHASE 3.70 — NAS/BTC CROSS-ASSET CONFLUENCE CHOP BYPASS (2026-06-29, task #258) =====
        // Extends Phase 3.69 (XAU metals) to NAS and BTC with per-symbol factor sets:
        //   NAS100: >= 3 of {SPY, QQQ, DXY, BTC, QQQ_SIG, TRUMP}
        //   BTC:    >= 3 of {SPY, QQQ, DXY, NAS}
        // Stricter conv floor (>=6) than 3.69's >=5 since BTC/NAS chop is more dangerous.
        // 06-29 misses that would have fired:
        //   NAS 11:37 conv 7 RIDE @ 29,522 (caught $29,522 → $29,783 = +$261)
        //   BTC 13:13 conv 6 RIDE @ 60,271 + VOL×1.7 (caught the 59K → 60.5K reverse)
        //   BTC 12:40 conv 6 RIDE @ 59,724
        let _crossAssetBypass = false;
        if (!_chopVolBypass && !_btcMildChopBypass && !_xauMetalsBypass && /RIDE/.test(tagEarly) && (sym === 'NAS100' || sym === 'BTC')) {
          try {
            const cCA = (typeof convictionFor === 'function') ? convictionFor(sig.type) : null;
            const cCAS = cCA ? cCA.score : 0;
            const cCAF = cCA ? (cCA.factors || []) : [];
            const factorSet = sym === 'NAS100'
              ? ['SPY', 'QQQ', 'DXY', 'BTC', 'QQQ_SIG', 'TRUMP']
              : ['SPY', 'QQQ', 'DXY', 'NAS'];
            const matchCount = factorSet.filter(f => cCAF.indexOf(f) !== -1).length;
            const requiredMatch = sym === 'NAS100' ? 3 : 3;
            if (cCAS >= 6 && matchCount >= requiredMatch) {
              // Direction alignment check using macroSnaps
              if (s.macroSnaps && s.macroSnaps.length >= 6) {
                const sn30c = s.macroSnaps[Math.max(0, s.macroSnaps.length - 6)];
                if (sn30c && sn30c.p > 0) {
                  const dirChgC = (price - sn30c.p) / sn30c.p;
                  const sigDC = sig.type === 'call' ? 1 : sig.type === 'put' ? -1 : 0;
                  const alignedC = (sigDC > 0 && dirChgC > 0.001) || (sigDC < 0 && dirChgC < -0.001);
                  if (alignedC) {
                    _crossAssetBypass = true;
                    const matched = factorSet.filter(f => cCAF.indexOf(f) !== -1).join(',');
                    log(sym, '↪️ ' + tagEarly + ' ' + sig.type.toUpperCase() + ' — ' + sym + ' cross-asset confluence bypass (Phase 3.70): conv ' + cCAS + ' + ' + matchCount + '/' + factorSet.length + ' factors (' + matched + ') + aligned dir (' + (dirChgC * 100).toFixed(2) + '%). Allowed.');
                  }
                }
              }
            }
          } catch (e) {}
        }
        if (!_chopVolBypass && !_btcMildChopBypass && !_xauMetalsBypass && !_crossAssetBypass) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🌊 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — ' + sym + ' chop mode active (only V-REV / LHF / LLF / OBREJ / OBMIT allowed in chop; other detectors consistently lose in flat range).');
          return false;
        }
      }
    }

    // ===== LHF/LLF/OBMIT/OBREJ MACD DIRECTION-CONSISTENCY (added 2026-06-16, task #179; extended 2026-06-17 task #210) =====
    // 6/16 11:25 XAU ⬇LHF PUT fired with MACD line at +0.248 (BULLISH momentum) and SL'd
    // for -$7.24/unit. A PUT signal demands declining/negative MACD momentum; with MACD
    // pointing UP, the "fade" is shorting INTO upward momentum — exactly the wrong setup.
    //
    // Extended 6/17 (task #210) to OBMIT/OBREJ after 05:09 XAU OBMIT PUT @ MACD +0.026
    // SL'd for -$5.45/oz. Same root cause: order-block fade detectors also fail when
    // they fire against the momentum direction.
    //
    // Rule for all OB-fade and local-fade detectors (LHF/LHFP/LLF/LLFP/OBMIT/OBREJ):
    //   PUT  → block if macdLine > 0 (require MACD line ≤ 0 OR declining significantly)
    //   CALL → block if macdLine < 0 (require MACD line ≥ 0 OR rising significantly)
    //
    // We don't have a clean delta-based check here without restructuring, so we use a simple
    // sign check. Macd extremity gates handle the "too far" case already; this catches the
    // basic "wrong direction" case. macdL is the MACD LINE (not histogram), already available
    // from the sig object as sig.macd (string) — parse it back.
    if (/LHF|LLF|OBMIT|OBREJ/.test(tagEarly)) {
      const sigMacd = parseFloat(sig.macd);
      if (!isNaN(sigMacd)) {
        if (sig.type === 'put' && sigMacd > 0) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🚫 ' + tagEarly + ' PUT BLOCKED — MACD direction mismatch: MACD line +' + sigMacd.toFixed(3) + ' (bullish momentum) contradicts bearish fade thesis. Fade detectors require MACD ≤ 0 for PUT.');
          return false;
        }
        if (sig.type === 'call' && sigMacd < 0) {
          Object.assign(s, _emitSnapshot);
          log(sym, '🚫 ' + tagEarly + ' CALL BLOCKED — MACD direction mismatch: MACD line ' + sigMacd.toFixed(3) + ' (bearish momentum) contradicts bullish fade thesis. Fade detectors require MACD ≥ 0 for CALL.');
          return false;
        }
      }
    }

    // ===== SAME-DIRECTION SAME-PRICE DEDUP (added 2026-06-16, task #180) =====
    // 6/16 XAU showed the textbook chop redundancy pattern:
    //   11:03:20 ⬇LHFP PUT @ $4324.10 (pending)
    //   11:25:43 ⬇LHF  PUT @ $4323.66 (SL -$7.24)
    // Two same-direction fade signals at virtually identical price ($4324 ±$0.50) within
    // 22 minutes. When the first fade hasn't moved price meaningfully, firing a second is
    // doubling down on a thesis the market is rejecting — a chop signature.
    //
    // Rule for LHF/LHFP/LLF/LLFP detectors only (fade detectors are most prone to this):
    // Block if any prior same-symbol, same-direction signal fired within last 30min at
    // a price within ±0.15% of current. Other detectors (BREAK/TREND/RIDE) have their
    // own cooldowns; this targets the fade-cluster pattern specifically.
    if (/LHF|LLF/.test(tagEarly) && signalHistory && Array.isArray(signalHistory)) {
      const dedupWindowMs = 30 * 60 * 1000;
      const priceThresholdPct = 0.0015; // 0.15%
      const priceThreshold = price * priceThresholdPct;
      const nowMs = Date.now();
      const recentSameDir = signalHistory.filter(h =>
        h && h.symbol === sym &&
        h.type === sig.type &&
        h.ts && (nowMs - h.ts) < dedupWindowMs &&
        h.price && Math.abs(parseFloat(h.price) - price) <= priceThreshold
      );
      if (recentSameDir.length >= 1) {
        const prior = recentSameDir[recentSameDir.length - 1];
        const ageMin = Math.round((nowMs - prior.ts) / 60000);
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — same-direction ' + (prior.score || '?') + ' fired ' + ageMin + 'min ago at $' + parseFloat(prior.price).toFixed(2) + ' (current $' + price.toFixed(2) + ', within 0.15%). Chop redundancy guard.');
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

    // ===== PHASE 3.40 — INVERSAL_BREAK CONV 4+ FLOOR (added 2026-06-24, task #242) =====
    // 3-day data analysis showed:
    //   Conv 3: 1/1 SL (06-24 03:57 NAS PUT @ $29,494 → -$70)
    //   Conv 4: 1 BE-scratch, 1 open
    //   Conv 5: 1 mixed
    //   Conv 6: 2 confirmed TP1 wins + 2 likely winners
    // Pattern: conv 3 = systematic loss. Failed-breakout fades fire AT extremes by
    // design — without strong cross-asset confluence, they catch falling knives.
    // SMC trader research confirms: low-conviction failed breakouts are coin-flip
    // at best, losing on average due to chop-trap entries.
    //
    // Conv 4 floor blocks 1 of 8 historical signals (12.5%) — only the proven loser.
    // 7 of 8 signals still fire. Conservative tightening.
    if (/INVERSAL_BREAK/.test(tagEarly)) {
      // PHASE 3.71 — bumped floor from 4 to 5 (2026-06-29, task #259)
      if (conv.score < 5) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — INVERSAL_BREAK conv floor: conv ' + conv.score + '/7 [' + (conv.factors || []).join(',') + '] < 5 (HIGH). Phase 3.71 raised from 4 to 5 after loser audit — MOD-tier failed-breakout fades dominate the losers list.');
        return false;
      }
    }

    // ===== PHASE 3.71 — FADE DETECTOR CONV 5+ FLOOR (2026-06-29, task #259) =====
    // 5-day loser audit (11 straight-SL losers): 91% were conv 4 MOD fade detectors
    // firing counter-trend. Apply hard conv ≥5 floor to all four primary fade tags.
    // Net effect: blocks ~91% of losers, costs some MOD winners — positive R per audit.
    // Covered detectors: LHFP, LLFP, OBREJ, STRUCT_LIQ_GRAB
    // INVERSAL_BREAK above raised from conv 4 to conv 5 in the same phase.
    if (/LHFP|LLFP|OBREJ|STRUCT_LIQ_GRAB/.test(tagEarly)) {
      if (conv.score < 5) {
        Object.assign(s, _emitSnapshot);
        log(sym, '🚫 ' + tagEarly + ' ' + sig.type.toUpperCase() + ' BLOCKED — fade conv floor (Phase 3.71): conv ' + conv.score + '/7 [' + (conv.factors || []).join(',') + '] < 5 (HIGH). MOD-tier counter-trend fades dominated the 5-day loser list (10/11 = 91%).');
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
      // PHASE 3.66 — recency override (second occurrence)
      {
        const _rec2 = applyRecencyOverride(s, sym, regimeDir, regimeStrength);
        if (_rec2.downgrade) {
          regimeDir = _rec2.dir;
          regimeStrength = _rec2.strength;
        }
      }

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

    // ===== BTC WEEKEND PUT-ONLY GATE — REMOVED 2026-06-21 (Phase 3.26, task #226) =====
    // The gate was added 2026-05-16 based on a Nov 2025 → May 2026 sample where BTC weekends
    // were 58% PUT-favorable. Regime has since flipped bullish.
    //
    // Sat 6/20 evidence: BTC closed HIGHER (+$200) but bot fired 8 PUTs (net ~-$250) and
    // missed the obvious CALL entries. Sun 6/21 early: BTC rallied $63,920 → $64,260 with
    // bot silent on the long side.
    //
    // The multi-day regime gate (line ~4111) already filters counter-trend in strong
    // regimes (requires conv 6 STRONG / conv 5 WEAK against direction). Phase 2.2 HTF Bias
    // Agreement also blocks "fighting both 1h and 4h" entries. Those adapt automatically
    // to regime shifts; a hardcoded direction lock does not.
    //
    // Original gate (removed):
    //   if (isBTC && s._weekendBtcPutOnly && sig.type === 'call') {
    //     Object.assign(s, _emitSnapshot);
    //     log(sym, '🚫 ' + tagEarly + ' CALL BLOCKED — BTC weekend PUT-only mode ...');
    //     return false;
    //   }
    //
    // The s._weekendBtcPutOnly flag is still computed (line ~4756) and surfaced in /status
    // for diagnostics. If a future bear regime returns, we can reactivate this block as a
    // one-liner, or convert it to a conviction-gated rule (e.g. weekend CALL requires conv 5+).

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
    // BTC trades 24/7. Weekend gate history:
    //   • 2026-05-16 task #100: After 52-week analysis, blocked CALL/allowed PUT on weekends
    //     based on Nov 2025 → May 2026 sample showing 58% PUT-favorable regime.
    //   • 2026-06-21 task #226 (Phase 3.26): GATE REMOVED. Sat 6/20 BTC closed +$200 but
    //     bot fired 8 PUTs (-$250 net). The multi-day regime gate + HTF Bias Agreement gate
    //     now handle direction-bias adaptively, so the hardcoded weekend PUT-only lock is
    //     no longer needed. CALLs are allowed on weekends if conv/HTF/regime confirm.
    //
    // The flag below is preserved for /status diagnostics — it indicates "is it weekend?"
    // not "is CALL blocked?". The companion 10-min log message has been retired.
    const dow = gETDow();
    s._weekendBtcPutOnly = (dow === 0 || dow === 6); // legacy name, retained for /status
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

  // Order Block Zone Filter — proximity-weighted boost (dynamic ±2/±1 based on closeness)
  // CALL near bullish OB (demand) = boost, CALL into bearish OB (supply overhead) = penalty
  // PUT near bearish OB (supply) = boost, PUT into bullish OB (demand below) = penalty
  //
  // Proximity tiers (added 2026-05-25): closer to the OB edge = stronger structural signal.
  //   - Tier 1 (very close, within $2 of edge or inside zone) = ±2 (the price IS at the level)
  //   - Tier 2 (within $5 of edge) = ±1 (approaching)
  //   - Beyond $5 = 0 (out of range)
  // Previously a flat ±1 — the dynamic weight makes near-OB setups (where reversal is most
  // likely) hit higher conv tiers, and far-OB setups don't get artificial inflation.
  if (isXAU && s.orderBlocks.length > 0) {
    let obBoost = 0;
    const tier1Range = 2.0;  // very-close (inside OB or within $2 of edge)
    const tier2Range = 5.0;  // approaching ($2-5 from edge)
    for (const ob of s.orderBlocks) {
      // Distance to nearest OB edge (0 if price is INSIDE the zone)
      const distToEdge = price < ob.lo ? (ob.lo - price) : price > ob.hi ? (price - ob.hi) : 0;
      if (distToEdge > tier2Range) continue;
      const tier = distToEdge <= tier1Range ? 2 : 1;
      if (ob.type === 'bull') {
        // Price at bullish OB (demand zone) — good for CALL, bad for PUT
        if (cS >= pS) { obBoost = tier; log(sym, '🟩 OB boost: CALL +' + tier + ' — at bullish demand $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' (dist $' + distToEdge.toFixed(2) + ', tier ' + tier + ')'); }
        else { obBoost = -tier; log(sym, '🟩 OB penalty: PUT -' + tier + ' — at bullish demand $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' (dist $' + distToEdge.toFixed(2) + ', tier ' + tier + ')'); }
      }
      if (ob.type === 'bear') {
        // Price at bearish OB (supply zone) — good for PUT, bad for CALL
        if (pS > cS) { obBoost = tier; log(sym, '🟥 OB boost: PUT +' + tier + ' — at bearish supply $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' (dist $' + distToEdge.toFixed(2) + ', tier ' + tier + ')'); }
        else { obBoost = -tier; log(sym, '🟥 OB penalty: CALL -' + tier + ' — at bearish supply $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' (dist $' + distToEdge.toFixed(2) + ', tier ' + tier + ')'); }
      }
      break; // use closest/most recent OB only
    }
    if (obBoost > 0) { if (cS >= pS) cS += obBoost; else pS += obBoost; }
    if (obBoost < 0) { if (cS >= pS) cS += obBoost; else pS += obBoost; } // obBoost is negative
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
    // F3 (2026-06-12): equity one-fade-per-window — the 6/12 stack fired 3 ⬇HI PUTs in
    // 8 min (10:04/10:08/10:11), the 2nd and 3rd before the 1st had any outcome. Equities
    // resolve over a 15-min window; don't re-fade the high until the prior fade played out.
    const hiFadeWindowOk = isMT5 || (now2 - (s.lastEqHiFadeTs || 0) > 900000);
    if (distFromHigh >= hiRevDist && s.rsiAtSessionHigh > 55 && sessionRange >= hiRevRange && highWasRecent && hiFadeWindowOk && (hiRevRocOk || hiRevMacdOk)) {
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
        if (!isMT5) s.lastEqHiFadeTs = now2; // F3 — one equity high-fade per 15-min window
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
    // F3 (2026-06-12): mirror of the equity high-fade window — one LO fade per 15 min.
    const loFadeWindowOk = isMT5 || (now2 - (s.lastEqLoFadeTs || 0) > 900000);
    if (distFromLow >= loRevDist && s.rsiAtSessionLow < 45 && sessionRange >= loRevRange && lowWasRecent && loFadeWindowOk && (loRevRocOk || loRevMacdOk)) {
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
        if (!isMT5) s.lastEqLoFadeTs = now2; // F3 — one equity low-fade per 15-min window
        log(sym, '🚀 SESSION LOW REVERSAL CALL — $' + distFromLow.toFixed(2) + ' off low $' + s.sessionLow.toFixed(2) + ' RSI@low:' + s.rsiAtSessionLow.toFixed(1) + ' RSInow:' + rsiV.toFixed(1) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' LOW REVERSAL CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · $' + distFromLow.toFixed(2) + ' off low · RSI@low:' + s.rsiAtSessionLow.toFixed(1), 'signal');
        s.trade = isMT5 ? buildCfdTrade('call', price, atrVal, sym) : { active: true, type: 'call', ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
        return;
      }
    }
  }

  // ===== TREND-MIRROR: QQQ ← NAS100 TRv2 (added 2026-06-12) =====
  // QQQ had NO trend-following signal source: the session-high blocker vetoes CALLs at
  // highs (where price lives on trend days) and HI/LO only fade. 6/12 case: +1.5% call
  // day, bot fired 4 PUTs / 0 CALLs while NAS TRv2 rode the same Nasdaq rally long.
  // QQQ and NAS100 are the same index — when TRv2 enters and the ETF confirms (VWAP side,
  // EMA alignment, RSI band, ROC direction), mirror the entry as a QQQ signal. One mirror
  // per TRv2 entry. Still passes enrichSig (conviction / exhaustion / regime gates apply).
  if (sym === 'QQQ' && etMin >= 570 && etMin < 945 && !(etMin >= 720 && etMin < 840) && cool) {
    const nasS_M = S['NAS100'];
    const t2m = nasS_M && nasS_M.trv2Trade;
    if (t2m && (t2m.dir === 'long' || t2m.dir === 'short')) {
      const mDir = t2m.dir === 'long' ? 'call' : 'put';
      const nasEntryTs = mDir === 'call' ? (nasS_M.lastCallSignalTs || 0) : (nasS_M.lastPutSignalTs || 0);
      const mFresh = nasEntryTs > 0 && (Date.now() - nasEntryTs) < 600000; // within 10 min of TRv2 entry
      const mNotMirrored = (s.lastMirrorNasTs || 0) !== nasEntryTs;        // one mirror per entry
      const mVwapOk = typeof s._vwap === 'number' && s._vwap > 0 &&
        (mDir === 'call' ? price > s._vwap : price < s._vwap);
      const mEmaOk = mDir === 'call' ? (s.pE5 > s.pE13) : (s.pE5 < s.pE13);
      const mRsiOk = mDir === 'call' ? (rsiV >= 50 && rsiV <= 68) : (rsiV >= 32 && rsiV <= 50);
      const mRocOk = mDir === 'call' ? roc3 > 0.010 : roc3 < -0.010;
      if (mFresh && mNotMirrored && mVwapOk && mEmaOk && mRsiOk && mRocOk &&
          flipCoolFor(mDir) && (winProtectDir === null || winProtectDir === mDir)) {
        s.lastMirrorNasTs = nasEntryTs;
        s.lastAT = mDir; if (mDir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir && s.lastSignalDir !== mDir) s.lastReversalTs = now2;
        s.lastSignalDir = mDir; s.lastSignalTs = now2; s.lastNTs = now2;
        const sig = { type: mDir, time: ts(), price: price.toFixed(2), score: (mDir === 'call' ? '⬆' : '⬇') + 'TMIR', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return; s.signals.push(sig);
        logSignal(sym, sig);
        log(sym, '🪞 TREND MIRROR ' + mDir.toUpperCase() + ' — NAS100 TRv2 ' + t2m.dir.toUpperCase() + ' @ $' + (t2m.ep || 0).toFixed(2) + ' + QQQ confirms (VWAP ' + (mDir === 'call' ? '>' : '<') + ' $' + s._vwap.toFixed(2) + ' · RSI ' + rsiV.toFixed(1) + ' · ROC ' + roc3.toFixed(3) + '%) [#' + s.dailySignalCount + ']');
        sendPush('🪞 QQQ ' + mDir.toUpperCase() + ' #' + s.dailySignalCount + ' (NAS mirror)', '$' + price.toFixed(2) + ' · NAS100 TRv2 ' + t2m.dir.toUpperCase() + ' confirmed by QQQ trend', 'signal');
        s.trade = { active: true, type: mDir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
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
  // N3 kill-switch (2026-06-11): NAS100 local fades (LHF/LLF/LHFP/LLFP) produced 0 clean wins
  // in Jun 4–11 fired set and 3W/38L+S blocked — TRv2 already covers NAS comprehensively.
  // Set env DISABLE_NAS_FADES=1 to suppress all four NAS fade paths for an A/B period.
  const nasFadesOff = isNAS && process.env.DISABLE_NAS_FADES === '1';
  if (hasLocalCandles && cool && !nasFadesOff && (rsiV >= 10 && rsiV <= 90)) {
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
    // R4 fix (2026-06-11): don't fade INTO a live up-thrust. 6/8 05:36 ⬇LHF PUT fired at
    // ROC +0.277% and SL'd in 25s. Fading is fine; fading fresh momentum is chasing.
    const lhfPutRocOk    = roc3 <= 0.10;
    // Relaxed LHF macro gate (2026-05-18): original macroAlignedFor required 6+/7 stable
    // for 5min — far too strict, produced 885 blocks in one session with zero fires.
    // New: accept EITHER the strict alignment OR a softer "5+/7 stable for 2min" check.
    // The softer path catches setups where macro is forming but hasn't reached full strength.
    // Other gates (RSI rolling, MACD compressing, fresh local high <25min) still gate quality.
    const SOFT_MACRO_THR = 5;
    const SOFT_MACRO_STABLE_MS = 120000; // 2 min
    const tSoftMacro = Date.now();
    // OB-confluence bypass (added 2026-05-25): if there's an unmitigated bearish OB zone
    // overhead and ROC is strongly negative, treat OB as macro-substitute. The OB IS
    // structural supply — by definition it's where institutions sold last time. EMAs lag
    // price but OB doesn't. Today's case: XAU dropped $4576→$4564 with 341 OB boost
    // events and 122 LHF blocks (macro lagged). Bot fired BREAKOUT at the bottom instead
    // of LHF mid-move. OB-confluence path:
    //   1. obZone exists, unmitigated, direction = 'put' (bearish supply)
    //   2. Price is within proximity of the OB (it IS the structural top)
    //   3. ROC strongly negative (move underway, not just noise)
    // All other LHF gates (timing, distance, range, cooldown, RSI, MACD, flip, win-protect)
    // still apply. 0-losers safe — tight SL at localHi+buffer is unchanged.
    const obProxXAU = 5.0, obProxBTC = 200, obProxNAS = 25;
    const obProx = isBTC ? obProxBTC : isNAS ? obProxNAS : obProxXAU;
    const rocStrongBearThr = isBTC ? -0.08 : isNAS ? -0.05 : isXAU ? -0.05 : -0.05;
    // OB path A: s.obZone (universal, set after BREAKOUT fires)
    const lhfPutObZoneOk = s.obZone && !s.obMitigated && !s.obDeparted &&
      s.obZone.dir === 'put' &&
      (s.obZone.lo - price) <= obProx && price < s.obZone.hi + obProx &&
      roc3 < rocStrongBearThr;
    // OB path B (XAU only, added 2026-05-26): s.orderBlocks ARRAY also tracks displacement
    // OBs that exist BEFORE any breakout. Today's case: 508 LHF blocks while a matching
    // bearish OB existed in orderBlocks but s.obZone wasn't set yet. Without this, the
    // bypass misses XAU setups where the demand/supply zone is from a displacement candle.
    let lhfPutObArrayOk = false;
    if (isXAU && Array.isArray(s.orderBlocks) && roc3 < rocStrongBearThr) {
      for (const ob of s.orderBlocks) {
        if (ob.mitigated) continue;
        if (ob.type !== 'bear') continue;            // PUT needs bearish supply OB
        if (price > ob.hi + obProxXAU) continue;     // price too far above the supply zone
        if (price < ob.lo - obProxXAU) continue;     // price punched through (mitigated)
        lhfPutObArrayOk = true;
        break;
      }
    }
    const lhfPutObOk = lhfPutObZoneOk || lhfPutObArrayOk;
    const lhfPutMacroOk  = macroAlignedFor('put') ||
      (s.fullConvSincePut > 0 && (tSoftMacro - s.fullConvSincePut) >= SOFT_MACRO_STABLE_MS && convictionFor('put').score >= SOFT_MACRO_THR) ||
      lhfPutObOk;
    const lhfPutFlipOk   = flipCoolFor('put');
    const lhfPutWinOk    = winProtectDir !== 'call';
    if (lhfPutTimingOk && lhfPutDistOk && lhfPutRangeOk && lhfPutCoolOk &&
        lhfPutRsiOk && lhfPutMacdOk && lhfPutRocOk && lhfPutMacroOk && lhfPutFlipOk && lhfPutWinOk) {
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
      else if (!lhfPutRocOk) reason = 'ROC ' + roc3.toFixed(3) + '% > +0.10% — price thrusting up, not fading (R4)';
      else if (!lhfPutFlipOk) reason = 'flip cooldown';
      else if (!lhfPutWinOk) reason = 'protecting winning CALL';
      if (reason) log(sym, '🚫 ⬇LHF PUT BLOCKED — ' + reason + ' (was $' + dropFromLocalHi.toFixed(2) + ' off local high $' + localHi6.toFixed(2) + ', ' + Math.round(lhfHiAgeMin) + 'min ago).');
      // ===== PERSISTENCE TRACKING (added 2026-05-28) =====
      // Track macro-ONLY blocks (other reasons mean the setup itself has issues).
      // The LHFP detector below uses this count to fire when persistence is strong.
      if (!lhfPutMacroOk && lhfPutRsiOk && lhfPutMacdOk && lhfPutRocOk) {
        s.lhfPutMacroBlocks = s.lhfPutMacroBlocks || [];
        s.lhfPutMacroBlocks.push({ ts: Date.now(), localHi: localHi6, drop: dropFromLocalHi });
        // Keep only last 10 min of blocks
        const cutoff = Date.now() - 10 * 60 * 1000;
        s.lhfPutMacroBlocks = s.lhfPutMacroBlocks.filter(b => b.ts > cutoff);
      }
    }

    // ---- LLF CALL (fade fresh local low) — symmetric mirror ----
    const riseFromLocalLo = price - localLo6;
    const llfCallTimingOk = lhfLoAgeMin >= lhfMinAgeMin && lhfLoAgeMin <= lhfMaxAgeMin;
    const llfCallDistOk   = riseFromLocalLo >= lhfDistMin && riseFromLocalLo <= lhfDistMax;
    const llfCallRangeOk  = lhfLocalRange >= lhfRangeMin;
    const llfCallCoolOk   = (Date.now() - s.lastLlfCallTs) >= lhfCooldownMs;
    const llfCallRsiOk    = rsiV > 40 && rsiV < 65;
    const llfCallMacdOk   = macdL > macdS && macdHist > 0;
    // R4 fix (2026-06-11): mirror of LHF PUT ROC ceiling — don't fade INTO a live down-thrust.
    const llfCallRocOk    = roc3 >= -0.10;
    // Same relaxed macro gate for LLF (mirror of LHF). See LHF comment above.
    // OB-confluence bypass (added 2026-05-25): mirror of LHF — when there's an unmitigated
    // bullish OB zone below and ROC strongly positive, treat OB as macro-substitute.
    const rocStrongBullThr = isBTC ? 0.08 : isNAS ? 0.05 : isXAU ? 0.05 : 0.05;
    // OB path A: s.obZone (universal)
    const llfCallObZoneOk = s.obZone && !s.obMitigated && !s.obDeparted &&
      s.obZone.dir === 'call' &&
      (price - s.obZone.hi) <= obProx && price > s.obZone.lo - obProx &&
      roc3 > rocStrongBullThr;
    // OB path B (XAU only, added 2026-05-26): s.orderBlocks ARRAY for displacement OBs.
    // Today's case: 508 LLF CALL blocks at $4528 while bullish OB existed in orderBlocks
    // at $4527-$4529. Without this path, the bypass missed the structural confluence.
    let llfCallObArrayOk = false;
    if (isXAU && Array.isArray(s.orderBlocks) && roc3 > rocStrongBullThr) {
      for (const ob of s.orderBlocks) {
        if (ob.mitigated) continue;
        if (ob.type !== 'bull') continue;            // CALL needs bullish demand OB
        if (price < ob.lo - obProxXAU) continue;     // price too far below the demand zone
        if (price > ob.hi + obProxXAU) continue;     // price punched through (mitigated)
        llfCallObArrayOk = true;
        break;
      }
    }
    const llfCallObOk = llfCallObZoneOk || llfCallObArrayOk;
    const llfCallMacroOk  = macroAlignedFor('call') ||
      (s.fullConvSinceCall > 0 && (tSoftMacro - s.fullConvSinceCall) >= SOFT_MACRO_STABLE_MS && convictionFor('call').score >= SOFT_MACRO_THR) ||
      llfCallObOk;
    const llfCallFlipOk   = flipCoolFor('call');
    const llfCallWinOk    = winProtectDir !== 'put';
    if (llfCallTimingOk && llfCallDistOk && llfCallRangeOk && llfCallCoolOk &&
        llfCallRsiOk && llfCallMacdOk && llfCallRocOk && llfCallMacroOk && llfCallFlipOk && llfCallWinOk) {
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
      else if (!llfCallRocOk) reason = 'ROC ' + roc3.toFixed(3) + '% < -0.10% — price thrusting down, not fading (R4)';
      else if (!llfCallFlipOk) reason = 'flip cooldown';
      else if (!llfCallWinOk) reason = 'protecting winning PUT';
      if (reason) log(sym, '🚫 ⬆LLF CALL BLOCKED — ' + reason + ' (was $' + riseFromLocalLo.toFixed(2) + ' off local low $' + localLo6.toFixed(2) + ', ' + Math.round(lhfLoAgeMin) + 'min ago).');
      // Persistence tracking — macro-only blocks (added 2026-05-28)
      if (!llfCallMacroOk && llfCallRsiOk && llfCallMacdOk && llfCallRocOk) {
        s.llfCallMacroBlocks = s.llfCallMacroBlocks || [];
        s.llfCallMacroBlocks.push({ ts: Date.now(), localLo: localLo6, rise: riseFromLocalLo });
        const cutoff = Date.now() - 10 * 60 * 1000;
        s.llfCallMacroBlocks = s.llfCallMacroBlocks.filter(b => b.ts > cutoff);
      }
    }

    // ===== LHF/LLF PERSISTENCE DETECTOR (added 2026-05-28) =====
    // When LHF/LLF has been blocked 80+ times in last 10 min (macro-only blocks — meaning
    // RSI/MACD/timing/distance ALL passed, only macro alignment was missing), the setup
    // is persistent enough to fire. The block count IS the conviction signal.
    //
    // 5/28 case: XAU LHF PUT blocked 100+ times before price dropped $18 ($4,403→$4,385).
    // Bot had structural conviction but macro EMAs lagged. This detector catches that.
    //
    // Gates (all must pass):
    //   - ≥80 macro-only blocks in last 10 min
    //   - Setup STILL valid (current price still in LHF distance/range)
    //   - ROC strongly directional (≥0.05% for XAU/NAS, ≥0.08% for BTC)
    //   - 30-min cooldown per direction
    //   - All standard enrichSig gates (regime, conv floor, etc.)
    //
    // Trade setup:
    //   - SL: local high + buffer (PUT) / local low - buffer (CALL) — same as LHF/LLF
    //   - TP1: existing per-symbol cap ($5 XAU / $50 BTC / $30 NAS)
    //   - TP2/TP3: proportional to slDist (2.5x, 4x)
    //   - TP1 BE-trail engages on hit
    const LHFP_BLOCK_THR = 80;
    const LHFP_COOLDOWN_MS = 30 * 60 * 1000;
    // R2 fix (2026-06-11): on the ~1 tick/sec MT5 feed, 80 blocks ≈ 80 seconds — any setup
    // that merely persists for ~1.5 min reached the bar, making LHFP 54% of all XAU volume
    // (Jun 4–11) with poor results. Real persistence = block count AND duration: the oldest
    // block in the rolling 10-min window must be ≥ 8 min old.
    const LHFP_MIN_PERSIST_MS = 8 * 60 * 1000;
    const lhfpRocBearThr = isBTC ? -0.08 : isNAS ? -0.05 : isXAU ? -0.05 : -0.05;
    const lhfpRocBullThr = isBTC ?  0.08 : isNAS ?  0.05 : isXAU ?  0.05 :  0.05;

    // --- LHFP PUT (persistence) ---
    if (Array.isArray(s.lhfPutMacroBlocks) && s.lhfPutMacroBlocks.length >= LHFP_BLOCK_THR &&
        (Date.now() - s.lhfPutMacroBlocks[0].ts) >= LHFP_MIN_PERSIST_MS) {
      const lastLhfpPutTs = s.lastLhfpPutTs || 0;
      const cooldownClear = (Date.now() - lastLhfpPutTs) >= LHFP_COOLDOWN_MS;
      // Re-verify setup still valid
      const stillInDistance = dropFromLocalHi >= lhfDistMin && dropFromLocalHi <= lhfDistMax;
      const rsiBand = rsiV >= 35 && rsiV < 60;
      const macdBearish = macdL < macdS && macdHist < 0;
      const rocBearish = roc3 < lhfpRocBearThr;
      const flipOk = flipCoolFor('put');
      const winOk = winProtectDir !== 'call';
      // ===== ANTI-CHASE GUARD (added 2026-06-12) — mirror of LLFP CALL guard below =====
      // If price has already dropped more than the per-instrument threshold below the HIGHEST
      // local high in the persistence window, the down-move is mid-flight — skip, don't chase.
      const lhfpChaseThr = isBTC ? 300 : isNAS ? 35 : 12;
      const lhfpWindowHi = Math.max(...s.lhfPutMacroBlocks.map(b => (typeof b.localHi === 'number' ? b.localHi : -Infinity)));
      const lhfpChasing = isFinite(lhfpWindowHi) && (lhfpWindowHi - price) > lhfpChaseThr;
      if (lhfpChasing && cooldownClear && stillInDistance && rsiBand && macdBearish && rocBearish &&
          (!s._lhfpChaseLogTs || Date.now() - s._lhfpChaseLogTs > 60000)) {
        log(sym, '🏃 ⬇LHFP PUT SKIPPED — anti-chase: price $' + price.toFixed(2) + ' is $' + (lhfpWindowHi - price).toFixed(2) + ' below window high $' + lhfpWindowHi.toFixed(2) + ' (> $' + lhfpChaseThr + '). Move is mid-flight — wait for the bounce.');
        s._lhfpChaseLogTs = Date.now();
      }
      if (cooldownClear && stillInDistance && rsiBand && macdBearish && rocBearish && flipOk && winOk && !lhfpChasing) {
        if (s.lastSignalDir !== 'put' || (now2 - s.lastNTs > COOLDOWN_MS)) {
          s.lastAT = 'put'; s.nP++; s.dailySignalCount++;
          if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
          s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
          s.lastSameDir = 'put'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
          const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇LHFP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) return;
          s.signals.push(sig); logSignal(sym, sig);
          if (isMT5) {
            // Tight SL at local high + buffer; TPs scaled
            const lhfSlPrice = localHi6 + lhfSlBuffer;
            const slDist = lhfSlPrice - price;
            if (slDist > 0) {
              const tp1Cap = isXAU ? 5 : isBTC ? 50 : isNAS ? 30 : 0.50;
              const tp1Dist = Math.min(slDist * 1.5, tp1Cap);
              const tp1P = price - tp1Dist;
              const tp2P = price - slDist * 2.5;
              const tp3P = price - slDist * 4.0;
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
              s.trade = buildCfdTrade('put', price, atrVal, sym);
              attachTpSl(sig, 'put', price, atrVal, sym);
            }
          }
          const lhfpBlockCount = s.lhfPutMacroBlocks.length;
          s.lastLhfpPutTs = Date.now();
          s.lhfPutMacroBlocks = []; // reset after fire
          log(sym, '🎯 LHF PERSISTENCE PUT — ' + lhfpBlockCount + ' macro blocks in 10min · $' + dropFromLocalHi.toFixed(2) + ' off local high $' + localHi6.toFixed(2) + ' · RSI ' + rsiV.toFixed(1) + ' · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
          sendPush('🎯 ' + sym + ' LHF PERSISTENCE PUT #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · ' + LHFP_BLOCK_THR + '+ persistent blocks · $' + dropFromLocalHi.toFixed(2) + ' off $' + localHi6.toFixed(2), 'signal');
          SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'put'; S[other].crossAssetTs = now2; } });
          return;
        }
      }
    }

    // --- LLFP CALL (persistence) ---
    if (Array.isArray(s.llfCallMacroBlocks) && s.llfCallMacroBlocks.length >= LHFP_BLOCK_THR &&
        (Date.now() - s.llfCallMacroBlocks[0].ts) >= LHFP_MIN_PERSIST_MS) {
      const lastLlfpCallTs = s.lastLlfpCallTs || 0;
      const cooldownClear = (Date.now() - lastLlfpCallTs) >= LHFP_COOLDOWN_MS;
      const stillInDistance = riseFromLocalLo >= lhfDistMin && riseFromLocalLo <= lhfDistMax;
      const rsiBand = rsiV > 40 && rsiV < 65;
      const macdBullish = macdL > macdS && macdHist > 0;
      const rocBullish = roc3 > lhfpRocBullThr;
      const flipOk = flipCoolFor('call');
      const winOk = winProtectDir !== 'put';
      // ===== ANTI-CHASE GUARD (added 2026-06-12) =====
      // LLFP is confirmation-lagged by design — by the time persistence proves out, price may
      // be far above the move's origin. "Distance off local low" can't catch this: the rolling
      // 30-min local low CLIMBS with the trend, so the entry looks fresh while the move is $20+
      // old. 6/12 case: LLFP CALL fired at $4226.77 after blocks accumulated from a ~$4205 base;
      // pulled back to $4216 SL before resuming up. Guard: if price has extended more than the
      // per-instrument threshold above the LOWEST local low in the persistence window, the move
      // is mid-flight — skip the entry and wait for the pullback (0-losers: skip > chase).
      const llfpChaseThr = isBTC ? 300 : isNAS ? 35 : 12;
      const llfpWindowLo = Math.min(...s.llfCallMacroBlocks.map(b => (typeof b.localLo === 'number' ? b.localLo : Infinity)));
      const llfpChasing = isFinite(llfpWindowLo) && (price - llfpWindowLo) > llfpChaseThr;
      if (llfpChasing && cooldownClear && stillInDistance && rsiBand && macdBullish && rocBullish &&
          (!s._llfpChaseLogTs || Date.now() - s._llfpChaseLogTs > 60000)) {
        log(sym, '🏃 ⬆LLFP CALL SKIPPED — anti-chase: price $' + price.toFixed(2) + ' is $' + (price - llfpWindowLo).toFixed(2) + ' above window low $' + llfpWindowLo.toFixed(2) + ' (> $' + llfpChaseThr + '). Move is mid-flight — wait for pullback.');
        s._llfpChaseLogTs = Date.now();
      }
      if (cooldownClear && stillInDistance && rsiBand && macdBullish && rocBullish && flipOk && winOk && !llfpChasing) {
        if (s.lastSignalDir !== 'call' || (now2 - s.lastNTs > COOLDOWN_MS)) {
          s.lastAT = 'call'; s.nC++; s.dailySignalCount++;
          if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
          s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
          s.lastSameDir = 'call'; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
          const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆LLFP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) return;
          s.signals.push(sig); logSignal(sym, sig);
          if (isMT5) {
            const llfSlPrice = localLo6 - lhfSlBuffer;
            const slDist = price - llfSlPrice;
            if (slDist > 0) {
              const tp1Cap = isXAU ? 5 : isBTC ? 50 : isNAS ? 30 : 0.50;
              const tp1Dist = Math.min(slDist * 1.5, tp1Cap);
              const tp1P = price + tp1Dist;
              const tp2P = price + slDist * 2.5;
              const tp3P = price + slDist * 4.0;
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
          s.lastLlfpCallTs = Date.now();
          s.llfCallMacroBlocks = []; // reset after fire
          log(sym, '🎯 LLF PERSISTENCE CALL — ' + LHFP_BLOCK_THR + '+ macro blocks in 10min · $' + riseFromLocalLo.toFixed(2) + ' off local low $' + localLo6.toFixed(2) + ' · RSI ' + rsiV.toFixed(1) + ' · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
          sendPush('🎯 ' + sym + ' LLF PERSISTENCE CALL #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · ' + LHFP_BLOCK_THR + '+ persistent blocks · $' + riseFromLocalLo.toFixed(2) + ' off $' + localLo6.toFixed(2), 'signal');
          SYMBOLS.forEach(other => { if (other !== sym) { S[other].crossAssetDir = 'call'; S[other].crossAssetTs = now2; } });
          return;
        }
      }
    }
  }

  // ╔══════════════════════════════════════════════════════════════════════════════╗
  // ║  ===== PHASE 3 — STRUCTURE-FIRST DETECTORS (added 2026-06-17) =====          ║
  // ║  Tasks #196 (SWEEP) / #197 (OB_FILL) / #198 (LIQ_GRAB) / #199 (VWAP_BOUNCE)  ║
  // ║                                                                              ║
  // ║  These are the OFFENSIVE side of the redesign — they generate trade signals  ║
  // ║  from STRUCTURE (Asian H/L sweeps, OB fills, liquidity grabs, VWAP bounces). ║
  // ║  Mainstream XAU traders use these as PRIMARY entry triggers, with macro /    ║
  // ║  correlation as confluence. We do the opposite today — Phase 3 inverts that. ║
  // ║                                                                              ║
  // ║  All 4 detectors:                                                            ║
  // ║   - run on MT5 instruments (XAU/BTC/NAS) only                                ║
  // ║   - tag signals with STRUCT_* prefix so they're easy to filter in analytics  ║
  // ║   - go through enrichSig like all other signals — Phase 2 gates still apply  ║
  // ║   - have a 30-60 min cooldown to prevent cluster fires                       ║
  // ║   - use ATR-based SL/TP via buildCfdTrade() for consistency                  ║
  // ╚══════════════════════════════════════════════════════════════════════════════╝
  if (isMT5) {
    const cool3 = now2 - s.lastNTs > COOLDOWN_MS;

    // ── 3.1: STRUCT_SWEEP — Asian H/L Sweep + Reversal (Judas Swing)
    // Setup: price breached Asian high (or low) within last 4 hours, now coming back inside
    // the Asian range. Classic SMC Judas swing — the most-traded XAU pattern.
    // Direction: sweep up → PUT (price reversing down after taking liquidity above)
    //            sweep down → CALL (price reversing up after grabbing liquidity below)
    //
    // ===== ENHANCED 2026-06-17 (tasks #203, #204, #205) =====
    // Based on French XAU trader's disciplined rule:
    //   "Étape 1: étudier la tendance de fond sur du H4"  (H4 trend)
    //   "Tendance haussière: Cassure de l'Asian par le Low + Liquidation + 2 closed
    //    5min candles + 6 pips, SL sur le Low"  (CALL on Asian-low sweep with H4 up)
    //   "Sinon: cassure par le High → éteindre les écrans"  (otherwise stop trading)
    //
    // Improvements:
    //  #203 — HTF direction match: block CALL if 4h is DOWN, block PUT if 4h is UP
    //  #204 — Conservative mode (env STRUCT_SWEEP_MODE=conservative): require last 2
    //         closed 5-min candle closes back inside Asian range + larger re-entry
    //  #205 — Session lock: if Asian range breaks cleanly (>30 min beyond w/o reversal),
    //         STRUCT_SWEEP locks for the rest of the session (set via s.asianSweepInvalidated)
    const STRUCT_SWEEP_MODE = process.env.STRUCT_SWEEP_MODE || 'aggressive';
    const isConservativeMode = STRUCT_SWEEP_MODE === 'conservative';
    if (s.asianH_locked && s.asianL_locked && cool3 && !s.asianSweepInvalidated) {
      const sweepCool = now2 - s.structSweepLastTs > 60 * 60 * 1000; // 60min between sweeps
      const sweepWindowMs = 4 * 60 * 60 * 1000; // sweep must have happened in last 4h

      // Conservative mode confirmation helper — checks last 2 closed 5-min candles
      const candleConfirm = (sideAboveOk, sideBelowOk) => {
        // sideAboveOk: closes must be ABOVE asianH (for CALL after sweep low)
        //              wait that's wrong — closes must be BACK INSIDE range
        // Correctly: for sweep above (PUT), closes must be BELOW asianH (back inside)
        //            for sweep below (CALL), closes must be ABOVE asianL (back inside)
        if (!s.atrCandles || s.atrCandles.length < 2) return false;
        const c1 = s.atrCandles[s.atrCandles.length - 1];  // most recent closed
        const c2 = s.atrCandles[s.atrCandles.length - 2];  // 2nd most recent closed
        if (!c1 || !c2 || !c1.c || !c2.c) return false;
        if (sideAboveOk) {
          // PUT case: both closes must be BELOW asianH (back inside range)
          return c1.c < s.asianH_locked && c2.c < s.asianH_locked;
        } else if (sideBelowOk) {
          // CALL case: both closes must be ABOVE asianL (back inside range)
          return c1.c > s.asianL_locked && c2.c > s.asianL_locked;
        }
        return false;
      };

      // Per-instrument "6 pips equivalent" — used by conservative mode for re-entry depth
      const sixPipsXAU = 2.0;    // ~0.05% of $4300
      const sixPipsBTC = 30.0;   // ~0.05% of $66k
      const sixPipsNAS = 15.0;   // ~0.05% of $30k
      const sixPipsEq = isXAU ? sixPipsXAU : isBTC ? sixPipsBTC : sixPipsNAS;

      // Sweep high + reverse → PUT
      if (s.asianSweptHigh && (now2 - s.asianSweepHighTs) <= sweepWindowMs && sweepCool &&
          price < s.asianH_locked && s.structSweepLastDir !== 'put') {
        // === Phase 3.7 HTF direction match — block PUT if 4h is UP (against macro)
        if (s.htf4h_dir === 'up') {
          // Reset the sweep flag so we don't keep checking — but don't fire
          // (we wait until next Asian session for an aligned setup)
          if (s.asianSweepHighTs && now2 - s.asianSweepHighTs > sweepWindowMs - 60000) {
            log(sym, '🚫 STRUCT_SWEEP PUT skipped — Asian H swept but 4h trend UP. Setup fights macro (rule: only trade WITH H4 trend).');
          }
        } else {
          const sweepDistAbove = s.asianSweepHighPeak - s.asianH_locked;
          const reentryDistRaw = s.asianH_locked - price;
          // ===== ADAPTIVE SWEEP DEPTH (task #206, added 2026-06-17) =====
          // Old: fixed 25% of Asian range. Too strict for tight ranges (6/17 11:44 case:
          // Asian range $6.20, needed $1.55 depth; actual $1.50 — barely missed).
          // New: max(15% of range, 0.02% of price). For tight ranges, the 0.02% floor
          // ensures we require at least some meaningful $-distance regardless of range.
          // For wide ranges, the 15% scaling still demands a real liquidity grab.
          const minSweep = Math.max(s.asianRange * 0.15, price * 0.0002);
          // Re-entry: same logic — adaptive scaling
          const minReentryAggr = Math.max(s.asianRange * 0.08, price * 0.00015);
          const minReentryCons = Math.max(s.asianRange * 0.10, sixPipsEq);
          const minReentry = isConservativeMode ? minReentryCons : minReentryAggr;
          const candlesOk = isConservativeMode ? candleConfirm(true, false) : true;
          if (sweepDistAbove >= minSweep && reentryDistRaw >= minReentry && candlesOk) {
            s.dailySignalCount++;
            s.lastAT = 'put'; s.nP++;
            if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
            s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
            const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇STRUCT_SWEEP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
            if (!enrichSig(sig)) return;
            s.signals.push(sig); logSignal(sym, sig);
            s.trade = buildCfdTrade('put', price, atrVal, sym);
            attachTpSl(sig, 'put', price, atrVal, sym);
            s.structSweepLastTs = now2;
            s.structSweepLastDir = 'put';
            s.asianSweptHigh = false; // consume the sweep
            const modeTag = isConservativeMode ? ' [CONS+2candles]' : '';
            const htfTag = s.htf4h_dir === 'down' ? ' + 4h DOWN aligned' : ' (4h flat)';
            log(sym, '🥷 STRUCT_SWEEP PUT (Judas)' + modeTag + htfTag + ' — swept Asian high $' + s.asianH_locked.toFixed(2) + ' to peak $' + s.asianSweepHighPeak.toFixed(2) + ' (+$' + sweepDistAbove.toFixed(2) + '), now back below at $' + price.toFixed(2) + ' (-$' + reentryDistRaw.toFixed(2) + ') [#' + s.dailySignalCount + ']');
            sendPush('🥷 ' + sym + ' STRUCT_SWEEP PUT #' + s.dailySignalCount, 'Asian high swept then reversed — $' + price.toFixed(2), 'signal');
            return;
          }
        }
      }
      // Sweep low + reverse → CALL
      if (s.asianSweptLow && (now2 - s.asianSweepLowTs) <= sweepWindowMs && sweepCool &&
          price > s.asianL_locked && s.structSweepLastDir !== 'call') {
        // === Phase 3.7 HTF direction match — block CALL if 4h is DOWN (against macro)
        if (s.htf4h_dir === 'down') {
          if (s.asianSweepLowTs && now2 - s.asianSweepLowTs > sweepWindowMs - 60000) {
            log(sym, '🚫 STRUCT_SWEEP CALL skipped — Asian L swept but 4h trend DOWN. Setup fights macro (rule: only trade WITH H4 trend).');
          }
        } else {
          const sweepDistBelow = s.asianL_locked - s.asianSweepLowTrough;
          const reentryDistRaw = price - s.asianL_locked;
          // ===== ADAPTIVE SWEEP DEPTH (task #206, added 2026-06-17) =====
          // Symmetric with PUT branch above. See comment there for rationale.
          const minSweep = Math.max(s.asianRange * 0.15, price * 0.0002);
          const minReentryAggr = Math.max(s.asianRange * 0.08, price * 0.00015);
          const minReentryCons = Math.max(s.asianRange * 0.10, sixPipsEq);
          const minReentry = isConservativeMode ? minReentryCons : minReentryAggr;
          const candlesOk = isConservativeMode ? candleConfirm(false, true) : true;
          if (sweepDistBelow >= minSweep && reentryDistRaw >= minReentry && candlesOk) {
            s.dailySignalCount++;
            s.lastAT = 'call'; s.nC++;
            if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
            s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
            const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆STRUCT_SWEEP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
            if (!enrichSig(sig)) return;
            s.signals.push(sig); logSignal(sym, sig);
            s.trade = buildCfdTrade('call', price, atrVal, sym);
            attachTpSl(sig, 'call', price, atrVal, sym);
            s.structSweepLastTs = now2;
            s.structSweepLastDir = 'call';
            s.asianSweptLow = false;
            const modeTag = isConservativeMode ? ' [CONS+2candles]' : '';
            const htfTag = s.htf4h_dir === 'up' ? ' + 4h UP aligned' : ' (4h flat)';
            log(sym, '🥷 STRUCT_SWEEP CALL (Judas)' + modeTag + htfTag + ' — swept Asian low $' + s.asianL_locked.toFixed(2) + ' to trough $' + s.asianSweepLowTrough.toFixed(2) + ' (-$' + sweepDistBelow.toFixed(2) + '), now back above at $' + price.toFixed(2) + ' (+$' + reentryDistRaw.toFixed(2) + ') [#' + s.dailySignalCount + ']');
            sendPush('🥷 ' + sym + ' STRUCT_SWEEP CALL #' + s.dailySignalCount, 'Asian low swept then reversed — $' + price.toFixed(2), 'signal');
            return;
          }
        }
      }
    }

    // ── 3.2: STRUCT_OB_FILL — Deep OB Retracement + Reversal
    // Setup: price has retraced >= 60% into a valid OB zone (s.obZone) AND is now reversing
    // out of the zone in the OB's direction. Stronger than first-touch OBREJ/OBMIT because
    // it requires deep fill + confirmation.
    if (s.obZone && cool3 && (now2 - s.structOBFillLastTs) > 60 * 60 * 1000 &&
        s.structOBFillLastObTs !== s.obZone.ts &&
        s.obZone.hi > s.obZone.lo &&
        !s.obFired && !s.obMitigated) {
      const obHi = s.obZone.hi;
      const obLo = s.obZone.lo;
      const obDir = s.obZone.dir; // 'bull' or 'bear'
      // Check if price is currently INSIDE the OB
      const insideOb = price >= obLo && price <= obHi;
      if (insideOb) {
        // Compute retracement depth (how deep into the OB price has gone)
        let retracePct = 0;
        if (obDir === 'bull') {
          // Bullish OB sits BELOW current trend — price retracing DOWN. 100% at lo, 0% at hi.
          retracePct = ((obHi - price) / (obHi - obLo)) * 100;
        } else {
          // Bearish OB sits ABOVE — price retracing UP. 100% at hi, 0% at lo.
          retracePct = ((price - obLo) / (obHi - obLo)) * 100;
        }
        // Need: deep fill (>=60%) AND momentum reversing out of zone in OB direction
        if (retracePct >= 60) {
          // Bullish OB → CALL; momentum confirm: price ticking up + MACD hist rising
          if (obDir === 'bull' && roc3 > 0 && macdHist > -0.05 * Math.abs(macdL || 1)) {
            s.dailySignalCount++;
            s.lastAT = 'call'; s.nC++;
            if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
            s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
            const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆STRUCT_OB_FILL', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
            if (!enrichSig(sig)) return;
            s.signals.push(sig); logSignal(sym, sig);
            s.trade = buildCfdTrade('call', price, atrVal, sym);
            attachTpSl(sig, 'call', price, atrVal, sym);
            s.structOBFillLastTs = now2;
            s.structOBFillLastObTs = s.obZone.ts;
            log(sym, '🎯 STRUCT_OB_FILL CALL — ' + retracePct.toFixed(0) + '% into bullish OB $' + obLo.toFixed(2) + '-$' + obHi.toFixed(2) + ', momentum reversing up · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
            sendPush('🎯 ' + sym + ' STRUCT_OB_FILL CALL #' + s.dailySignalCount, 'Deep fill (' + retracePct.toFixed(0) + '%) of bullish OB — $' + price.toFixed(2), 'signal');
            return;
          }
          // Bearish OB → PUT
          if (obDir === 'bear' && roc3 < 0 && macdHist < 0.05 * Math.abs(macdL || 1)) {
            s.dailySignalCount++;
            s.lastAT = 'put'; s.nP++;
            if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
            s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
            const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇STRUCT_OB_FILL', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
            if (!enrichSig(sig)) return;
            s.signals.push(sig); logSignal(sym, sig);
            s.trade = buildCfdTrade('put', price, atrVal, sym);
            attachTpSl(sig, 'put', price, atrVal, sym);
            s.structOBFillLastTs = now2;
            s.structOBFillLastObTs = s.obZone.ts;
            log(sym, '🎯 STRUCT_OB_FILL PUT — ' + retracePct.toFixed(0) + '% into bearish OB $' + obLo.toFixed(2) + '-$' + obHi.toFixed(2) + ', momentum reversing down · ROC ' + roc3.toFixed(3) + '% [#' + s.dailySignalCount + ']');
            sendPush('🎯 ' + sym + ' STRUCT_OB_FILL PUT #' + s.dailySignalCount, 'Deep fill (' + retracePct.toFixed(0) + '%) of bearish OB — $' + price.toFixed(2), 'signal');
            return;
          }
        }
      }
    }

    // ── 3.3: STRUCT_LIQ_GRAB — Liquidity Pool Sweep + Reversal
    // Setup: a liquidity pool (2+ equal highs/lows from macroSnaps) just got swept (price
    // went through it) AND price is now reversing back through the level. Classic SMC
    // stop-hunt pattern.
    if (cool3 && (now2 - s.structLiqGrabLastTs) > 45 * 60 * 1000) {
      // Pool ABOVE was just swept and price is back below → PUT
      if (s.liqSweptAbovePrice > 0 && (now2 - s.liqSweptAboveTs) <= 20 * 60 * 1000 &&
          price < s.liqSweptAbovePrice) {
        // Need meaningful re-entry (>= 0.05% below the pool)
        const reentry = (s.liqSweptAbovePrice - price) / s.liqSweptAbovePrice;
        if (reentry >= 0.0005) {
          // ===== PHASE 3.19 SPAM FIX (added 2026-06-19, task #219) =====
          // Set the 45-min cooldown + consume the swept-pool BEFORE enrichSig. Previously
          // these only fired on enrichSig pass, so a blocked setup would re-evaluate true
          // on EVERY subsequent tick — log showed 339 STRUCT_LIQ_GRAB attempts in one
          // 6-min window when the daily cap was reached. Setting them upfront means a
          // blocked setup gets one log line then sleeps for 45 min. The same setup
          // re-emerging later (new sweep, new reversal) gets a fresh chance.
          const sweptAbove = s.liqSweptAbovePrice; // capture for log before clearing
          s.structLiqGrabLastTs = now2;
          s.liqSweptAbovePrice = 0; // consume sweep state regardless of enrichSig outcome
          s.dailySignalCount++;
          s.lastAT = 'put'; s.nP++;
          if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
          s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
          const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇STRUCT_LIQ_GRAB', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) return;
          s.signals.push(sig); logSignal(sym, sig);
          s.trade = buildCfdTrade('put', price, atrVal, sym);
          attachTpSl(sig, 'put', price, atrVal, sym);
          log(sym, '🪤 STRUCT_LIQ_GRAB PUT — pool above $' + sweptAbove.toFixed(2) + ' swept then reversed, now $' + price.toFixed(2) + ' [#' + s.dailySignalCount + ']');
          sendPush('🪤 ' + sym + ' STRUCT_LIQ_GRAB PUT #' + s.dailySignalCount, 'Liquidity above grabbed then reversed — $' + price.toFixed(2), 'signal');
          return;
        }
      }
      // Pool BELOW was just swept and price is back above → CALL
      if (s.liqSweptBelowPrice > 0 && (now2 - s.liqSweptBelowTs) <= 20 * 60 * 1000 &&
          price > s.liqSweptBelowPrice) {
        const reentry = (price - s.liqSweptBelowPrice) / s.liqSweptBelowPrice;
        if (reentry >= 0.0005) {
          // Phase 3.19 spam fix — see PUT branch above for full reasoning.
          const sweptBelow = s.liqSweptBelowPrice;
          s.structLiqGrabLastTs = now2;
          s.liqSweptBelowPrice = 0;
          s.dailySignalCount++;
          s.lastAT = 'call'; s.nC++;
          if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
          s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
          const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆STRUCT_LIQ_GRAB', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
          if (!enrichSig(sig)) return;
          s.signals.push(sig); logSignal(sym, sig);
          s.trade = buildCfdTrade('call', price, atrVal, sym);
          attachTpSl(sig, 'call', price, atrVal, sym);
          log(sym, '🪤 STRUCT_LIQ_GRAB CALL — pool below $' + sweptBelow.toFixed(2) + ' swept then reversed, now $' + price.toFixed(2) + ' [#' + s.dailySignalCount + ']');
          sendPush('🪤 ' + sym + ' STRUCT_LIQ_GRAB CALL #' + s.dailySignalCount, 'Liquidity below grabbed then reversed — $' + price.toFixed(2), 'signal');
          return;
        }
      }
    }

    // ── 3.4: STRUCT_VWAP_BOUNCE — VWAP Touch + Bounce in HTF Direction
    // Setup: price recently touched VWAP (within 0.05%) and is now bouncing away in the
    // direction of the 1h HTF trend. Mean-reversion within a trending session — buy the
    // dip / sell the rip relative to session anchor.
    if (s.vwap && s.vwapTouchedTs > 0 && cool3 &&
        (now2 - s.structVwapLastTs) > 45 * 60 * 1000 &&
        (now2 - s.vwapTouchedTs) <= 15 * 60 * 1000 && s.htf1h_dir) {
      const vwapDistNow = (price - s.vwap) / s.vwap;
      // CALL: touched VWAP from above (or below), now bouncing up in uptrend
      if (s.htf1h_dir === 'up' && vwapDistNow >= 0.0008 && s.vwapTouchedSide === 'below') {
        // We dipped to VWAP and now bouncing up — buy the dip
        s.dailySignalCount++;
        s.lastAT = 'call'; s.nC++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆STRUCT_VWAP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return;
        s.signals.push(sig); logSignal(sym, sig);
        s.trade = buildCfdTrade('call', price, atrVal, sym);
        attachTpSl(sig, 'call', price, atrVal, sym);
        s.structVwapLastTs = now2;
        s.vwapTouchedTs = 0;
        log(sym, '📊 STRUCT_VWAP CALL — VWAP $' + s.vwap.toFixed(2) + ' touched, bouncing up in 1h uptrend ' + s.htf1h_strength.toFixed(2) + '%, now $' + price.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('📊 ' + sym + ' STRUCT_VWAP CALL #' + s.dailySignalCount, 'VWAP bounce in uptrend — $' + price.toFixed(2), 'signal');
        return;
      }
      // PUT: touched VWAP from below (or above), now bouncing down in downtrend
      if (s.htf1h_dir === 'down' && vwapDistNow <= -0.0008 && s.vwapTouchedSide === 'above') {
        s.dailySignalCount++;
        s.lastAT = 'put'; s.nP++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇STRUCT_VWAP', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return;
        s.signals.push(sig); logSignal(sym, sig);
        s.trade = buildCfdTrade('put', price, atrVal, sym);
        attachTpSl(sig, 'put', price, atrVal, sym);
        s.structVwapLastTs = now2;
        s.vwapTouchedTs = 0;
        log(sym, '📊 STRUCT_VWAP PUT — VWAP $' + s.vwap.toFixed(2) + ' touched, rolling down in 1h downtrend ' + s.htf1h_strength.toFixed(2) + '%, now $' + price.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('📊 ' + sym + ' STRUCT_VWAP PUT #' + s.dailySignalCount, 'VWAP rejection in downtrend — $' + price.toFixed(2), 'signal');
        return;
      }
    }

    // ── 3.5: INVERSAL_BREAK (task #200) — Universal Failed-Breakout Detector
    // Replaces the disabled BREAK detector. The trade rationale:
    //   Traditional BREAK fires WITH the breakout (33-40% win rate in chop — fails as stop-hunt).
    //   INVERSAL_BREAK fires AGAINST the failed breakout (the high-edge SMC pattern).
    //
    // Watches 10 level types in parallel: rolling 5d H/L, PDH/PDL, round numbers above/below,
    // local 60min H/L, OB top/bottom. State is maintained in s.sweptLevels.
    //
    // AGGRESSIVE MODE: fires on first close back inside the level. SL is tight (just beyond
    // the swept extreme). Tradeoff: more false fires but maximizes the sharp-reversal wins.
    //
    // Direction: any UP-sweep that comes back below → PUT. Any DOWN-sweep that comes back
    // above → CALL. Multiple swept levels boost conviction (multi-level sweep = highest quality).
    if (cool3 && (now2 - s.inversalLastTs) > 45 * 60 * 1000) {
      // ===== PHASE 3.31 — ADAPTIVE PARAMETERS FOR LOW-ATR (added 2026-06-22, task #231) =====
      // Default sweep window (30 min) and reentry threshold (0.05%) were calibrated for
      // NAS/BTC. On slow XAU days (ATR ~$1.5), the sweep state expires before price has
      // time to reverse cleanly through the level.
      //
      // 6/22 case: XAU swept $4,200 round number ~05:00 ET (peaked at $4,212), but
      // didn't come back below until ~10:00 ET — 5 hours later. With the 30-min window
      // the sweep state was already cleared, so INVERSAL_BREAK PUT never fired during
      // what was a clear -$26 reversal.
      //
      // Fix: in low-ATR conditions (XAU < $2.5, BTC < $50, NAS < $12), extend sweep
      // window to 90 min and loosen reentry threshold to 0.03%. Normal-ATR markets
      // keep the original 30 min / 0.05% (no behavior change for BTC/NAS in active sessions).
      const lowAtrMode = (isXAU && atrVal < 2.5) || (isBTC && atrVal < 50) || (isNAS && atrVal < 12);
      const reentryThr = price * (lowAtrMode ? 0.0003 : 0.0005);
      const sweepWindow = lowAtrMode ? 90 * 60 * 1000 : 30 * 60 * 1000;
      if (lowAtrMode && (!s._inversalAdaptiveLogTs || now2 - s._inversalAdaptiveLogTs > 1800000)) {
        log(sym, '🐌 INVERSAL_BREAK adaptive mode — low ATR ($' + atrVal.toFixed(2) + '), window 90min / reentry 0.03%.');
        s._inversalAdaptiveLogTs = now2;
      }

      // Collect swept-above and swept-below levels that are currently in reversal state
      const sweptAbove = []; // levels that were swept UP and price is now back BELOW
      const sweptBelow = []; // levels that were swept DOWN and price is now back ABOVE
      const lvlKeys = ['rolling5dHi','rolling5dLo','pdh','pdl','roundNumAbv','roundNumBlw','localHi60','localLo60','obHi','obLo'];
      for (const key of lvlKeys) {
        const lv = s.sweptLevels[key];
        if (!lv.swept || lv.level <= 0) continue;
        if ((now2 - lv.ts) > sweepWindow) continue;
        // Was this an "above" sweep or "below" sweep?
        const isAboveSweep = lv.extreme > lv.level;
        if (isAboveSweep && price < lv.level - reentryThr) {
          sweptAbove.push({ key, level: lv.level, extreme: lv.extreme, ts: lv.ts });
        } else if (!isAboveSweep && price > lv.level + reentryThr) {
          sweptBelow.push({ key, level: lv.level, extreme: lv.extreme, ts: lv.ts });
        }
      }

      // Fire if we have at least one valid sweep-reversal in either direction
      // PUT: sweep above + reversal back below
      if (sweptAbove.length > 0 && s.inversalLastDir !== 'put') {
        // Find the highest level swept and the most recent ts (used for SL placement)
        const topLevel = sweptAbove.reduce((a, b) => a.extreme > b.extreme ? a : b);
        const fastReversal = (now2 - topLevel.ts) <= 5 * 60 * 1000; // < 5min = sharp = high quality
        const inKZ = s.inKillzone === true;
        s.dailySignalCount++;
        s.lastAT = 'put'; s.nP++;
        if (s.lastSignalDir === 'call') s.lastReversalTs = now2;
        s.lastSignalDir = 'put'; s.lastSignalTs = now2; s.lastNTs = now2;
        const sig = { type: 'put', time: ts(), price: price.toFixed(2), score: '⬇INVERSAL_BREAK', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return;
        s.signals.push(sig); logSignal(sym, sig);
        // Custom SL: just above the highest swept extreme (tight, level-based, not ATR-based)
        const slBuf = (isXAU ? 2 : isBTC ? 25 : 5);
        const ibSl = topLevel.extreme + slBuf;
        const slDist = ibSl - price;
        if (slDist > 0) {
          const tp1Cap = isXAU ? 5 : isBTC ? 50 : isNAS ? 30 : 0.50;
          const tp1Dist = Math.min(slDist * 1.5, tp1Cap);
          const tp1P = price - tp1Dist;
          const tp2P = price - slDist * 2.5;
          const tp3P = price - slDist * 4.0;
          s.trade = buildCfdTrade('put', price, atrVal, sym);
          s.trade.slPrice = +ibSl.toFixed(2);
          s.trade.tp1Price = +tp1P.toFixed(2);
          s.trade.tp2Price = +tp2P.toFixed(2);
          s.trade.tp3Price = +tp3P.toFixed(2);
          sig.sl = ibSl.toFixed(2);
          sig.tp1 = tp1P.toFixed(2);
          sig.tp2 = tp2P.toFixed(2);
          sig.tp3 = tp3P.toFixed(2);
        } else {
          s.trade = buildCfdTrade('put', price, atrVal, sym);
          attachTpSl(sig, 'put', price, atrVal, sym);
        }
        s.inversalLastTs = now2;
        s.inversalLastDir = 'put';
        // Consume the swept levels to prevent re-fire on same sweep
        for (const sw of sweptAbove) { s.sweptLevels[sw.key].swept = false; }
        const levelsHit = sweptAbove.map(x => x.key).join(', ');
        log(sym, '🔄 INVERSAL_BREAK PUT — failed up-breach of ' + sweptAbove.length + ' level(s) [' + levelsHit + '] — peak $' + topLevel.extreme.toFixed(2) + ' (over $' + topLevel.level.toFixed(2) + '), now back to $' + price.toFixed(2) + (fastReversal ? ' · FAST reversal' : '') + (inKZ ? ' · KZ' : '') + ' · SL $' + ibSl.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' INVERSAL_BREAK PUT #' + s.dailySignalCount, sweptAbove.length + ' level(s) failed at $' + topLevel.extreme.toFixed(2) + ', reversing — $' + price.toFixed(2), 'signal');
        return;
      }
      // CALL: sweep below + reversal back above
      if (sweptBelow.length > 0 && s.inversalLastDir !== 'call') {
        const botLevel = sweptBelow.reduce((a, b) => a.extreme < b.extreme ? a : b);
        const fastReversal = (now2 - botLevel.ts) <= 5 * 60 * 1000;
        const inKZ = s.inKillzone === true;
        s.dailySignalCount++;
        s.lastAT = 'call'; s.nC++;
        if (s.lastSignalDir === 'put') s.lastReversalTs = now2;
        s.lastSignalDir = 'call'; s.lastSignalTs = now2; s.lastNTs = now2;
        const sig = { type: 'call', time: ts(), price: price.toFixed(2), score: '⬆INVERSAL_BREAK', rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return;
        s.signals.push(sig); logSignal(sym, sig);
        const slBuf = (isXAU ? 2 : isBTC ? 25 : 5);
        const ibSl = botLevel.extreme - slBuf;
        const slDist = price - ibSl;
        if (slDist > 0) {
          const tp1Cap = isXAU ? 5 : isBTC ? 50 : isNAS ? 30 : 0.50;
          const tp1Dist = Math.min(slDist * 1.5, tp1Cap);
          const tp1P = price + tp1Dist;
          const tp2P = price + slDist * 2.5;
          const tp3P = price + slDist * 4.0;
          s.trade = buildCfdTrade('call', price, atrVal, sym);
          s.trade.slPrice = +ibSl.toFixed(2);
          s.trade.tp1Price = +tp1P.toFixed(2);
          s.trade.tp2Price = +tp2P.toFixed(2);
          s.trade.tp3Price = +tp3P.toFixed(2);
          sig.sl = ibSl.toFixed(2);
          sig.tp1 = tp1P.toFixed(2);
          sig.tp2 = tp2P.toFixed(2);
          sig.tp3 = tp3P.toFixed(2);
        } else {
          s.trade = buildCfdTrade('call', price, atrVal, sym);
          attachTpSl(sig, 'call', price, atrVal, sym);
        }
        s.inversalLastTs = now2;
        s.inversalLastDir = 'call';
        for (const sw of sweptBelow) { s.sweptLevels[sw.key].swept = false; }
        const levelsHit = sweptBelow.map(x => x.key).join(', ');
        log(sym, '🔄 INVERSAL_BREAK CALL — failed down-breach of ' + sweptBelow.length + ' level(s) [' + levelsHit + '] — trough $' + botLevel.extreme.toFixed(2) + ' (under $' + botLevel.level.toFixed(2) + '), now back to $' + price.toFixed(2) + (fastReversal ? ' · FAST reversal' : '') + (inKZ ? ' · KZ' : '') + ' · SL $' + ibSl.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🔄 ' + sym + ' INVERSAL_BREAK CALL #' + s.dailySignalCount, sweptBelow.length + ' level(s) failed at $' + botLevel.extreme.toFixed(2) + ', reversing — $' + price.toFixed(2), 'signal');
        return;
      }
    }
  }
  // ===== END PHASE 3 STRUCTURE-FIRST DETECTORS =====

  // ╔══════════════════════════════════════════════════════════════════════════════╗
  // ║  ===== BREAK DETECTOR — DISABLED 2026-06-17 (task #201) =====                ║
  // ║                                                                              ║
  // ║  Performance analysis 6/9-6/17 showed BREAK at 33% clean win rate, 50% clean ║
  // ║  loss rate, ≈$2/oz net P&L over 9 days. 100% of clean losses were FAILED     ║
  // ║  breakouts (the exact pattern INVERSAL_BREAK trades).                        ║
  // ║                                                                              ║
  // ║  INVERSAL_BREAK now fires in the OPPOSITE direction of failed breakouts.    ║
  // ║                                                                              ║
  // ║  The coil detection + s._pendingBreakout flag is STILL set by processTicks  ║
  // ║  (we may want it for other detectors), but the firing logic below is gated. ║
  // ║  Set BREAK_DETECTOR_ENABLED=true in env to re-enable if needed.              ║
  // ╚══════════════════════════════════════════════════════════════════════════════╝
  const BREAK_DETECTOR_ENABLED = process.env.BREAK_DETECTOR_ENABLED === 'true';
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
  if (isMT5 && s._pendingBreakout && !BREAK_DETECTOR_ENABLED) {
    // BREAK detector disabled — consume the pending flag and log for shadow analysis.
    const _bo = s._pendingBreakout;
    s._pendingBreakout = null;
    log(sym, '⏭️ BREAK ' + _bo.dir.toUpperCase() + ' skipped — detector disabled (task #201). INVERSAL_BREAK active. Coil resolved at $' + price.toFixed(2));
    // fall through to remaining detectors (we still want everything else to run)
  }
  if (isMT5 && s._pendingBreakout && BREAK_DETECTOR_ENABLED) {
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

  // ===== ORDER BLOCK RETEST / MITIGATION SIGNALS — REMOVED 2026-06-11 (audit A4) =====
  // Was disabled (0% WR across 4/30 + 5/1 samples). Code preserved in
  // archive/disabled_detectors_2026-06-11.js. OB zone tracking still active for scoring.

  // ===== OB-MITIGATED TREND CONTINUATION (added 2026-05-25) =====
  // When an OB zone from s.orderBlocks is freshly mitigated (price punched THROUGH the
  // demand/supply zone), it's strong evidence that the level held — then broke. This is a
  // high-quality continuation setup in the punch-through direction.
  //   - Bull OB (demand) mitigated by drop = bears overpowered demand = PUT continuation
  //   - Bear OB (supply) mitigated by rise = bulls overpowered supply = CALL continuation
  //
  // Conditions:
  //   - Fresh mitigation within last 60s (s.lastObMitTs set in the OB-builder block above)
  //   - Not already fired for this mitigation (s.obMitFired flag)
  //   - 30-min cooldown per symbol (avoid spam if multiple OBs break in succession)
  //   - ROC + MACD confirm direction (no chasing reversals)
  //   - All standard gates via enrichSig (chop, regime, RSI floor, etc.)
  //
  // 0-losers safe: uses standard buildCfdTrade SL/TP, including OB-anchored TP1 (Fix 2)
  // which will set TP1 just before the NEXT downstream OB if one exists.
  if (isMT5 && s.lastObMitTs && !s.obMitFired) {
    const obMitAgeMs = now2 - s.lastObMitTs;
    const obMitCoolMs = 30 * 60 * 1000; // 30 min
    const obMitFresh = obMitAgeMs < 60000; // within last 60s
    const obMitCoolOk = (s.lastObMitSignalTs || 0) === 0 || (now2 - s.lastObMitSignalTs) > obMitCoolMs;
    if (obMitFresh && obMitCoolOk && cool) {
      const dir = s.lastObMitType === 'bull' ? 'put' : 'call';
      const rocOk = (dir === 'call' && roc3 > 0.02) || (dir === 'put' && roc3 < -0.02);
      const macdDirOk = (dir === 'call' && macdHist > 0) || (dir === 'put' && macdHist < 0);
      const flipOk = flipCoolFor(dir);
      const winOk = winProtectDir === null || winProtectDir === dir;
      if (rocOk && macdDirOk && flipOk && winOk) {
        s.obMitFired = true;
        s.lastObMitSignalTs = now2;
        s.lastAT = dir; if (dir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
        if (s.lastSignalDir && s.lastSignalDir !== dir) s.lastReversalTs = now2;
        s.lastSignalDir = dir; s.lastSignalTs = now2; s.lastNTs = now2;
        s.lastSameDir = dir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
        const scoreTag = dir === 'call' ? '⬆OBMIT' : '⬇OBMIT';
        const sig = { type: dir, time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
        if (!enrichSig(sig)) return;
        s.signals.push(sig); logSignal(sym, sig);
        if (isMT5) attachTpSl(sig, dir, price, atrVal, sym);
        log(sym, '⚡ OB-MIT CONTINUATION ' + dir.toUpperCase() + ' — ' + s.lastObMitType.toUpperCase() + ' OB broken @ $' + s.lastObMitLevel.toFixed(2) + ' · ROC ' + roc3.toFixed(3) + '% · MACD hist ' + macdHist.toFixed(3) + ' [#' + s.dailySignalCount + ']');
        sendPush('⚡ ' + sym + ' OB-MIT ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · ' + s.lastObMitType.toUpperCase() + ' OB broken @ $' + s.lastObMitLevel.toFixed(2), 'signal');
        s.trade = isMT5 ? buildCfdTrade(dir, price, atrVal, sym) : { active: true, type: dir, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, pt1: 30, pt2: 60, sl2: 25, ts: Date.now() };
        return;
      }
    }
  }

  // ===== OB-REJECTION FADE DETECTOR (added 2026-05-26) =====
  // Fires fade signal when price ENTERS an unmitigated OB in the OB direction.
  // Bearish supply OB holds → fire PUT (price rejects DOWN off supply).
  // Bullish demand OB holds → fire CALL (price rejects UP off demand).
  //
  // Complement to OBMIT (above) which fires when OB BREAKS — OBREJ fires when OB HOLDS.
  // Today's case: 5/26 XAU ATL CALL fired at $4,506.85 INSIDE bearish supply OB
  // $4,506.41-$4,507.62 → SL'd → price dropped $20 to $4,486. OBREJ PUT would have
  // fired at the same moment with tight SL at OB high + buffer, catching the $20 move.
  //
  // 0-losers safety:
  //   - Tight SL at OB outer edge + buffer (typically $2-$4 risk on XAU)
  //   - TP1 capped per-symbol ($5 XAU / $50 BTC / $30 NAS) — high hit rate
  //   - TP1 BE-trail engages on TP1 hit
  //   - Conv ≥3 confirmation (some cross-asset alignment)
  //   - RSI exhaustion floor enforced (PUT≥35, CALL≤65)
  //   - 30-min cooldown per direction (no spam on chop near OB level)
  //   - All standard enrichSig gates (regime, win-protect, etc.)
  if (isMT5 && cool) {
    const obRejCoolMs = 30 * 60 * 1000;
    const obRejBuffer = isBTC ? 50 : isNAS ? 8 : isXAU ? 2 : 0.20;
    const tryObRej = (ob, isBearOb, isBullOb) => {
      if (!isBearOb && !isBullOb) return false;
      const insideOb = price >= ob.lo && price <= ob.hi;
      if (!insideOb) return false;
      const dir = isBearOb ? 'put' : 'call';
      // Cooldown
      const lastTs = dir === 'put' ? (s.lastObRejPutTs || 0) : (s.lastObRejCallTs || 0);
      if (lastTs > 0 && (Date.now() - lastTs) < obRejCoolMs) return false;
      // Direction-aware gates
      if (!flipCoolFor(dir)) return false;
      if (winProtectDir !== null && winProtectDir !== dir) return false;
      // RSI exhaustion floor — don't fade an already-exhausted move
      if (dir === 'put' && rsiV < 35) return false;
      if (dir === 'call' && rsiV > 65) return false;
      // Conv ≥3 confirmation
      const obrConv = convictionFor(dir);
      if (obrConv.score < 3) return false;
      // Build signal
      const scoreTag = (dir === 'call' ? '⬆' : '⬇') + 'OBREJ';
      s.lastAT = dir; if (dir === 'call') s.nC++; else s.nP++; s.dailySignalCount++;
      if (s.lastSignalDir && s.lastSignalDir !== dir) s.lastReversalTs = now2;
      s.lastSignalDir = dir; s.lastSignalTs = now2; s.lastNTs = now2;
      s.lastSameDir = dir; s.lastSameDirMacd = Math.abs(macdHist); s.lastSameDirTs = now2; s.lastSameDirPrice = price;
      const sig = { type: dir, time: ts(), price: price.toFixed(2), score: scoreTag, rsi: rsiV.toFixed(1), macd: macdL.toFixed(3), roc: (roc3 >= 0 ? '+' : '') + roc3.toFixed(3) + '%', num: s.dailySignalCount };
      if (!enrichSig(sig)) return true; // blocked by other gates — still consume to avoid spam
      s.signals.push(sig); logSignal(sym, sig);
      // Custom SL/TP based on OB structure
      const slPrice = dir === 'put' ? ob.hi + obRejBuffer : ob.lo - obRejBuffer;
      const slDist = Math.abs(slPrice - price);
      if (slDist > 0) {
        const tp1Cap = isXAU ? 5 : isBTC ? 50 : isNAS ? 30 : 5;
        const tp1Dist = Math.min(slDist * 1.5, tp1Cap);
        const tp1P = dir === 'put' ? price - tp1Dist : price + tp1Dist;
        const tp2P = dir === 'put' ? price - slDist * 2.5 : price + slDist * 2.5;
        const tp3P = dir === 'put' ? price - slDist * 4.0 : price + slDist * 4.0;
        s.trade = buildCfdTrade(dir, price, atrVal, sym);
        s.trade.slPrice = +slPrice.toFixed(2);
        s.trade.tp1Price = +tp1P.toFixed(2);
        s.trade.tp2Price = +tp2P.toFixed(2);
        s.trade.tp3Price = +tp3P.toFixed(2);
        sig.sl = slPrice.toFixed(2);
        sig.tp1 = tp1P.toFixed(2);
        sig.tp2 = tp2P.toFixed(2);
        sig.tp3 = tp3P.toFixed(2);
      } else {
        s.trade = buildCfdTrade(dir, price, atrVal, sym);
        attachTpSl(sig, dir, price, atrVal, sym);
      }
      if (dir === 'put') s.lastObRejPutTs = Date.now();
      else s.lastObRejCallTs = Date.now();
      log(sym, '🧱 OB-REJECTION ' + dir.toUpperCase() + ' — price $' + price.toFixed(2) + ' INSIDE ' + (isBearOb ? 'bearish supply' : 'bullish demand') + ' OB $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' · conv ' + obrConv.score + ' [' + (obrConv.factors.join(',') || 'none') + '] [#' + s.dailySignalCount + ']');
      sendPush('🧱 ' + sym + ' OBREJ ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · ' + (isBearOb ? 'rejected at supply' : 'bounced off demand') + ' $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2), 'signal');
      return true;
    };
    // Check s.obZone (universal, set on breakouts) — must not be mitigated/departed
    if (s.obZone && !s.obMitigated && !s.obDeparted) {
      const fired = tryObRej(s.obZone, s.obZone.dir === 'put', s.obZone.dir === 'call');
      if (fired) return;
    }
    // Check s.orderBlocks (XAU array, from displacement candles)
    if (isXAU && Array.isArray(s.orderBlocks)) {
      for (const ob of s.orderBlocks) {
        if (ob.mitigated) continue;
        const fired = tryObRej(ob, ob.type === 'bear', ob.type === 'bull');
        if (fired) return;
      }
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
        s.lastDivTroughInvalTs = now2; // timestamp for TRv2 liquidity-sweep cooldown (added 2026-05-26)
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
        s.lastDivPeakInvalTs = now2; // timestamp for TRv2 liquidity-sweep cooldown (added 2026-05-26)
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

  // ===== SUSTAINED MOVE DETECTOR — REMOVED 2026-06-11 (audit A4) =====
  // Was disabled (replaced by ATH/ATL reversal — better timing). Code preserved in
  // archive/disabled_detectors_2026-06-11.js.

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
  // Replaces TREND + MFLIP for NAS100 + BTC. One entry per trend leg, hold until reversal.
  // Uses averaged 15/20/30-min EMA as trend line. Fires entry with TP1/TP2/TP3, manages trade,
  // exits on EMA cross-back, optionally reverses.
  // BTC re-enabled 2026-05-25 (was disabled after 0/6 -$872 on 5/6) — cascade limit, EMA
  // dedupe, conv maturity factor, and TP1 BE-trail scratch protection now prevent the
  // original loss-cascade pattern. User assessment: TRv2 fits BTC's clean directional legs.
  // TRv2 detector — extended to XAU 2026-06-18 (task #213).
  // XAU-specific constants: minSpreadPct 0.06% (~$2.5 on $4300 price), ATR fallback $3
  // (typical XAU 1-min candle range). These match BTC's relative scale, not absolute.
  if ((isNAS || isBTC || isXAU) && s.trv2TrendEma !== null && s.trv2Candles.length >= 30) {
    const tEma = s.trv2TrendEma;
    const spread = Math.abs(price - tEma);
    const spreadPct = (spread / tEma) * 100;
    const minSpreadPct = isBTC ? 0.08 : isXAU ? 0.06 : 0.06;  // NAS uses 0.06, XAU same
    const priceAbove = price > tEma;
    const priceBelow = price < tEma;
    const now3 = Date.now();

    // --- Calculate ATR from recent 1-min candles ---
    let trv2Atr = isBTC ? 120 : isXAU ? 3 : 30;  // XAU 1-min ATR ~$3; NAS ~$30; BTC ~$120
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
          // N1 (2026-06-11): LOSING crossback exits now feed the cascade-limit + EMA-spread
          // dedupe guards. They previously only counted SL exits, so a losing crossback could
          // re-enter ~30min later at a near-identical EMA spread and lose again (6/8 11:56
          // -$26 → 12:28 -$36 long churn). Winning crossbacks don't count — re-entering after
          // a profitable trend leg is fine.
          if (exitPnl < 0) {
            s.trv2SlHistory = s.trv2SlHistory || [];
            s.trv2SlHistory.push({ ts: now3, dir: t.dir, price: price, ema: tEma || 0, spreadPct: spreadPct });
            if (s.trv2SlHistory.length > 10) s.trv2SlHistory.shift();
          }
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
            // ===== AUTO-REVERSE GUARDS (mirror initial-entry, added 2026-05-26) =====
            const revEntryType = revDir === 'long' ? 'call' : 'put';
            const revConv_g = convictionFor(revEntryType);
            if (revConv_g.score < 5) {
              log(sym, '🎯 TRv2 auto-reverse ' + revDir.toUpperCase() + ' BLOCKED — conv ' + revConv_g.score + '/5 (factors: ' + (revConv_g.factors.join(',') || 'none') + '). Needs HIGH conv (5+/7).');
              return;
            }
            const DIV_INVAL_COOL_MS_R = 15 * 60 * 1000;
            if (revDir === 'short' && s.lastDivTroughInvalTs && (now3 - s.lastDivTroughInvalTs) < DIV_INVAL_COOL_MS_R) {
              log(sym, '🌊 TRv2 auto-reverse SHORT BLOCKED — DIV trough invalidated ' + Math.round((now3 - s.lastDivTroughInvalTs) / 60000) + 'min ago (liquidity-sweep).');
              return;
            }
            if (revDir === 'long' && s.lastDivPeakInvalTs && (now3 - s.lastDivPeakInvalTs) < DIV_INVAL_COOL_MS_R) {
              log(sym, '🌊 TRv2 auto-reverse LONG BLOCKED — DIV peak invalidated ' + Math.round((now3 - s.lastDivPeakInvalTs) / 60000) + 'min ago (liquidity-sweep).');
              return;
            }
            const FRESH_EXT_COOL_MS_R = 15 * 60 * 1000;
            if (revDir === 'short' && s.rollingLowUpdateTs && (now3 - s.rollingLowUpdateTs) < FRESH_EXT_COOL_MS_R) {
              log(sym, '🏔️ TRv2 auto-reverse SHORT BLOCKED — fresh local low ' + Math.round((now3 - s.rollingLowUpdateTs) / 60000) + 'min ago (selling-the-bottom).');
              return;
            }
            if (revDir === 'long' && s.rollingHighUpdateTs && (now3 - s.rollingHighUpdateTs) < FRESH_EXT_COOL_MS_R) {
              log(sym, '🏔️ TRv2 auto-reverse LONG BLOCKED — fresh local high ' + Math.round((now3 - s.rollingHighUpdateTs) / 60000) + 'min ago (buying-the-top).');
              return;
            }
            // TP/SL policy: SL=2×ATR (always tight), TPs differ by symbol.
            // NAS (extended 2026-05-25 to match buildCfdTrade NAS extension from task #102):
            //   NAS futures show clean directional legs — 5/15 was $29400→$29000 with minimal
            //   counter-spikes. Default 1.5/2.5/4× was cutting TP3 at ~0.08% (Sunday TRv2 win:
            //   only $24.75). NAS now uses 3/6/12× to capture full legs (~$30/$60/$120 with
            //   typical ATR ~10). BTC keeps default — BTC chops harder, tighter TPs are safer.
            //
            // TP1 min floor (updated 2026-05-25): $5 is too tight for NAS at $29k+ (only 0.017%).
            // Raised to $30 for NAS so even low-ATR entries get a meaningful first target.
            // XAU/BTC keep $5 floor (proportional to their price levels).
            const revMults = isNAS
              ? { sl: 2, t1: 3, t2: 6, t3: 12 }
              : { sl: 2, t1: 1.5, t2: 2.5, t3: 4 };
            const revTp1Floor = isNAS ? 30 : 5;
            const revSl = revDir === 'long' ? price - Math.max(trv2Atr * revMults.sl, 5) : price + Math.max(trv2Atr * revMults.sl, 5);
            // Phase 3.28 — apply same TP-ordering fix as the entry path above (see line ~7884).
            const revTp1Dist = Math.max(trv2Atr * revMults.t1, revTp1Floor);
            const revTp2Dist = Math.max(trv2Atr * revMults.t2, revTp1Dist * (revMults.t2 / revMults.t1));
            const revTp3Dist = Math.max(trv2Atr * revMults.t3, revTp1Dist * (revMults.t3 / revMults.t1));
            const revTp1 = revDir === 'long' ? price + revTp1Dist : price - revTp1Dist;
            const revTp2 = revDir === 'long' ? price + revTp2Dist : price - revTp2Dist;
            const revTp3 = revDir === 'long' ? price + revTp3Dist : price - revTp3Dist;

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
            // ===== AUTO-REVERSE ENRICHSIG GATE (added 2026-06-16, task #178) =====
            // Same pattern as main entry: enrichSig blocks now prevent trade activation, but
            // signal is still stored with enrichBlocked flag for analytics. s.trv2Trade above
            // remains set so internal shadow tracking continues (server sees virtual TP/SL hits
            // for blocked entries — useful for backtesting whether the blocks were correct).
            const revEnrichPassed = enrichSig(revSig);
            if (!revEnrichPassed) {
              if (!revSig.conv) revSig.conv = { score: 0, label: 'BLOCKED', factors: [] };
              revSig.conv.enrichBlocked = true;
              log(sym, '🚫 TRv2 AUTO-REVERSE ' + revDir.toUpperCase() + ' BLOCKED by enrichSig @ $' + price.toFixed(2) + ' — no EA trade activation (shadow only) [#' + s.dailySignalCount + ']');
              s.signals.push(revSig); logSignal(sym, revSig);
              return;
            }
            s.signals.push(revSig); logSignal(sym, revSig);
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

    // TRv2 runs on NAS100 + BTC (BTC re-enabled 2026-05-25). No chop gating on entry —
    // NAS chop detector overfires on staircase trends (94% chop=1 on +185pt day, 5/6). NAS
    // TRv2 went 6/6 TP1 hit during "chop". Auto-reverse path DOES have chop block (#153)
    // since the 5/21 cascade. Entry path is protected by cascade limit, EMA dedupe, conv
    // maturity, and TP1 BE-trail scratch — keeps the strategy 0-losers even when entries
    // fire during chop classifications.
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
        // ===== TRv2 ENTRY GUARDS (added 2026-05-26 — three coordinated checks) =====
        // User strategy: TRv2 should fire only when 70%+ directionally confident.
        // The three new guards address the 5/26 BTC SHORT loss (entered at $76,778 right
        // after DIV trough invalidated at $76,777 = textbook liquidity-sweep loss) +
        // two NAS LONGs that SL'd in chop-range tops.
        //
        // Guard 1: Conv 5+/7 floor — TRv2 entry must reach HIGH conv tier
        const trv2EntryType = dir === 'long' ? 'call' : 'put';
        const trv2Conv = convictionFor(trv2EntryType);
        const TRv2_MIN_CONV = 5;
        // ===== PHASE 3.47 — REGIME+VOL CONV EXEMPTION (added 2026-06-25, task #247) =====
        // On 06-24 morning, 5+ NAS TRv2 SHORTs blocked at conv 2/5 during confirmed bear
        // continuation (XAU -180, NAS -200). Lower conv floor to 3 when regime+VOL agree.
        let _trv2ConvFloor = TRv2_MIN_CONV;
        let _trv2Exempt = null;
        try {
          const tcvf = (trv2Conv.factors || []).find(f => /^VOL×/.test(f));
          const tcvs = tcvf ? parseFloat(tcvf.split('×')[1]) : 0;
          let trChg = null;
          if (s.dailyLevels && s.dailyLevels.length >= 5) {
            const oTR = s.dailyLevels[0];
            if (oTR && oTR.high > 0 && oTR.low > 0) {
              trChg = ((price - (oTR.high + oTR.low) / 2) / ((oTR.high + oTR.low) / 2)) * 100;
            }
          }
          if (trChg === null && s.macroSnaps && s.macroSnaps.length > 0) {
            const oSnTR = s.macroSnaps[0];
            const ahTR = (Date.now() - oSnTR.ts) / 3600000;
            if (ahTR >= 24 && oSnTR.p > 0) trChg = ((price - oSnTR.p) / oSnTR.p) * 100;
          }
          const wkTR = isXAU ? 1.0 : isBTC ? 2.5 : isNAS ? 1.5 : 0.5;
          const trAligned = trChg !== null && ((dir === 'short' && trChg <= -wkTR) || (dir === 'long' && trChg >= wkTR));
          if (tcvs >= 4.0) {
            _trv2ConvFloor = 4;
            _trv2Exempt = 'VOL×' + tcvs.toFixed(1) + ' >=4.0 strong-volume override';
          } else if (trAligned && tcvs >= 2.5) {
            _trv2ConvFloor = 3;
            _trv2Exempt = 'regime ' + trChg.toFixed(2) + '% + VOL×' + tcvs.toFixed(1);
          }
        } catch (e) {}
        if (_trv2Exempt && trv2Conv.score >= _trv2ConvFloor && trv2Conv.score < TRv2_MIN_CONV) {
          log(sym, '↪️ TRv2 ' + dir.toUpperCase() + ' — conv ' + trv2Conv.score + '/' + TRv2_MIN_CONV + ' BELOW normal floor but ' + _trv2Exempt + ' bypasses. Allowed (Phase 3.47).');
        }
        if (trv2Conv.score < _trv2ConvFloor) {
          log(sym, '🎯 TRv2 ' + dir.toUpperCase() + ' BLOCKED — conv ' + trv2Conv.score + '/' + TRv2_MIN_CONV + ' (factors: ' + (trv2Conv.factors.join(',') || 'none') + '). TRv2 needs HIGH conv tier (5+/7).');
          return;
        }
        // Guard 2: DIV invalidation cooldown (15 min) — fresh trough/peak break is a
        // liquidity-sweep pattern, not a continuation. 5/26 BTC SHORT fired 3 min after
        // DIV trough invalidated at $76,777 → price reversed UP $156 from entry.
        const DIV_INVAL_COOL_MS = 15 * 60 * 1000;
        if (dir === 'short' && s.lastDivTroughInvalTs && (now3 - s.lastDivTroughInvalTs) < DIV_INVAL_COOL_MS) {
          const minsAgo = Math.round((now3 - s.lastDivTroughInvalTs) / 60000);
          log(sym, '🌊 TRv2 SHORT BLOCKED — DIV trough invalidated ' + minsAgo + 'min ago (liquidity-sweep pattern). 15min cooldown.');
          return;
        }
        if (dir === 'long' && s.lastDivPeakInvalTs && (now3 - s.lastDivPeakInvalTs) < DIV_INVAL_COOL_MS) {
          const minsAgo = Math.round((now3 - s.lastDivPeakInvalTs) / 60000);
          log(sym, '🌊 TRv2 LONG BLOCKED — DIV peak invalidated ' + minsAgo + 'min ago (liquidity-sweep pattern). 15min cooldown.');
          return;
        }
        // Guard 3: Fresh-extreme guard (15 min) — don't fire TRv2 at a freshly-set local
        // extreme. SHORT at a fresh local low or LONG at a fresh local high is the
        // "selling-the-bottom / buying-the-top" anti-pattern.
        //
        // ===== PHASE 3.42 — REGIME-AWARE EXEMPTION (added 2026-06-24, task #244) =====
        // In a confirmed multi-day directional regime, fresh-extreme same-direction
        // entries are TREND CONTINUATION, not knife-catching. 6/24 evidence:
        //   • XAU down $180 over 2 days (clear bear) — 11+ SHORT entries blocked in 19s
        //     because XAU was making new lows continuously. Bot wanted to ride trend.
        //   • NAS bouncing — LONG entries blocked at fresh highs despite bull recovery.
        // Same regime-aware pattern as Phase 3.16 / 3.18 / 3.39.
        const FRESH_EXTREME_COOL_MS = 15 * 60 * 1000;
        const _trendContinuation = (function (direction) {
          let regimeChgPct = null;
          if (s.dailyLevels && s.dailyLevels.length >= 5) {
            const oldest = s.dailyLevels[0];
            if (oldest && oldest.high > 0 && oldest.low > 0) {
              const mid = (oldest.high + oldest.low) / 2;
              regimeChgPct = ((price - mid) / mid) * 100;
            }
          }
          if (regimeChgPct === null && s.macroSnaps && s.macroSnaps.length > 0) {
            const oldestS = s.macroSnaps[0];
            const ageH = (Date.now() - oldestS.ts) / 3600000;
            if (ageH >= 24 && oldestS.p > 0) {
              regimeChgPct = ((price - oldestS.p) / oldestS.p) * 100;
            }
          }
        // ===== PHASE 3.45 — VOL>=3.0 BYPASS (added 2026-06-25, task #247) =====
        // Heavy-volume break of local extreme usually starts extension, not top/bottom.
        // 06-25 09:30 NAS PUT VOL×9.1 caught a 757-pt drop. VOL>=3.0 bypasses fresh-extreme.
        const _teVolFactor = ((trv2Conv && trv2Conv.factors) || []).find(f => /^VOL×/.test(f));
        const _teVolSpike = _teVolFactor ? parseFloat(_teVolFactor.split('×')[1]) : 0;
        if (_teVolSpike >= 3.0) {
          return { regimeChgPct: regimeChgPct === null ? 0 : regimeChgPct, dir: direction === 'short' ? 'bear' : 'bull', volBypass: _teVolSpike };
        }
                  if (regimeChgPct === null) return false;
          const weak = isXAU ? 1.0 : isBTC ? 2.5 : isNAS ? 1.5 : 0.5;
          if (direction === 'short' && regimeChgPct <= -weak) return { regimeChgPct: regimeChgPct, dir: 'bear' };
          if (direction === 'long' && regimeChgPct >= weak) return { regimeChgPct: regimeChgPct, dir: 'bull' };
          return false;
        })(dir);
        if (dir === 'short' && s.rollingLowUpdateTs && (now3 - s.rollingLowUpdateTs) < FRESH_EXTREME_COOL_MS) {
          const minsAgo = Math.round((now3 - s.rollingLowUpdateTs) / 60000);
          if (_trendContinuation) {
            log(sym, '↪️ TRv2 SHORT — fresh local low ' + minsAgo + 'min ago BUT ' + (_trendContinuation.volBypass ? ('VOL×' + _trendContinuation.volBypass.toFixed(1) + ' bypass (Phase 3.45)') : ('bear regime continuation (' + _trendContinuation.regimeChgPct.toFixed(2) + '%) (Phase 3.42)')) + '. Allowed.');
          } else {
            log(sym, '🏔️ TRv2 SHORT BLOCKED — fresh local low set ' + minsAgo + 'min ago at $' + s.rollingLow.toFixed(2) + ' (selling-the-bottom pattern). 15min cooldown.');
            return;
          }
        }
        if (dir === 'long' && s.rollingHighUpdateTs && (now3 - s.rollingHighUpdateTs) < FRESH_EXTREME_COOL_MS) {
          const minsAgo = Math.round((now3 - s.rollingHighUpdateTs) / 60000);
          if (_trendContinuation) {
            log(sym, '↪️ TRv2 LONG — fresh local high ' + minsAgo + 'min ago BUT ' + (_trendContinuation.volBypass ? ('VOL×' + _trendContinuation.volBypass.toFixed(1) + ' bypass (Phase 3.45)') : ('bull regime continuation (' + _trendContinuation.regimeChgPct.toFixed(2) + '%) (Phase 3.42)')) + '. Allowed.');
          } else {
            log(sym, '🏔️ TRv2 LONG BLOCKED — fresh local high set ' + minsAgo + 'min ago at $' + s.rollingHigh.toFixed(2) + ' (buying-the-top pattern). 15min cooldown.');
            return;
          }
        }
        // ===== PHASE 3.30 — SAME-DIRECTION SL LOCKOUT (added 2026-06-22, task #230) =====
        // After a TRv2 SL on this symbol+direction, block new same-direction TRv2 entries
        // for 30 min. The existing cascadeActive_E gate above counts 2+ SLs in any direction
        // and is too lax for the single-direction whipsaw pattern.
        //
        // 6/22 case: XAU CALL SL'd at 08:22, then 3 more CALL RIDEs fired at 09:48 / 10:09
        // / 10:47 — same direction, slightly worse prices, same setup that just failed.
        // The doubling-down pattern is what kills runs of "the bot is right about direction
        // but every entry hits the next pullback".
        //
        // Uses s.trv2SlHistory which is already populated at the SL hit sites (lines ~7553,
        // ~7568, ~7601, ~7631). Each entry has { ts, dir, price, ema, spreadPct }.
        const SAME_DIR_SL_COOL_MS = 30 * 60 * 1000;
        const sameDirRecentSl = s.trv2SlHistory.find(h => h.dir === dir && (now3 - h.ts) < SAME_DIR_SL_COOL_MS);
        if (sameDirRecentSl) {
          const minsAgo = Math.round((now3 - sameDirRecentSl.ts) / 60000);
          log(sym, '🛑 TRv2 ' + dir.toUpperCase() + ' BLOCKED — same-direction SL ' + minsAgo + 'min ago @ $' + sameDirRecentSl.price.toFixed(2) + '. 30min lockout breaks the whipsaw doubling-down pattern.');
          return;
        }
        // TP/SL policy: SL=2×ATR (always tight), TPs differ by symbol.
        // NAS (extended 2026-05-25 to match buildCfdTrade NAS extension from task #102):
        //   NAS futures produce clean directional legs that the default 1.5/2.5/4× was cutting
        //   short. Sunday TRv2 NAS PUT hit TP3 at +$24.75 (0.08%) — the leg actually ran
        //   $30-$50 lower. NAS now uses 3/6/12× to capture the full leg (~$30/$60/$120 with
        //   typical ATR ~10). BTC keeps default — BTC chops harder, wide TPs risk give-back.
        //
        // TP1 min floor (updated 2026-05-25): $5 was too small for NAS at $29k+ (only 0.017%
        // of price). Raised to $30 so even low-ATR TRv2 entries have a meaningful first
        // target. XAU/BTC keep $5 (proportional to their price levels).
        //
        // ===== PHASE 3.37 — TIGHTER TP/SL IN CHOP+OUTSIDE-KZ OVERRIDE (added 2026-06-22, task #238) =====
        // When TRv2 fires in chop+outside-killzone via the conv 5+ override (Phase 2.3),
        // the reversal risk is elevated. Tighter SL + closer TPs:
        //   • SL: 1.5× ATR instead of 2× — smaller loss when wrong
        //   • TP1: 1× ATR instead of 1.5× — locks BE-trail faster (NAS: 2× instead of 3×)
        //   • TP2/TP3: ~60% of normal — captures the chop bounce but doesn't expect runaway
        //   • Floor: smaller too — proportional reduction
        const isChopOverride = s.chopActive && !s.inKillzone;
        const entMults = isNAS
          ? (isChopOverride
              ? { sl: 1.5, t1: 2, t2: 4, t3: 8 }          // NAS chop override
              : { sl: 2,   t1: 3, t2: 6, t3: 12 })        // NAS normal
          : (isChopOverride
              ? { sl: 1.5, t1: 1,   t2: 1.75, t3: 2.5 }   // XAU/BTC chop override
              : { sl: 2,   t1: 1.5, t2: 2.5,  t3: 4 });   // XAU/BTC normal
        const tp1Floor = isNAS ? (isChopOverride ? 20 : 30) : (isChopOverride ? 3 : 5);
        if (isChopOverride) {
          log(sym, '🌊 TRv2 CHOP-OVERRIDE TPs — tighter SL/TPs applied (chop+outside-KZ, conv 5+).');
        }
        const sl = dir === 'long' ? price - Math.max(trv2Atr * entMults.sl, 5) : price + Math.max(trv2Atr * entMults.sl, 5);
        // ===== PHASE 3.28 — Fix TP2/TP3 < TP1 bug (added 2026-06-22, task #228) =====
        // Previously TP1 had a Math.max(...,tp1Floor) clamp but TP2/TP3 used raw
        // ATR multipliers. On low-ATR XAU entries (ATR=1.38), TP1 hit the $5 floor
        // while TP2 (raw 1.38×2.5 = $3.44) and TP3 (1.38×4 = $5.52) ended up
        // BELOW or barely above TP1 — broken ordering.
        //
        // Fix: compute TP1's actual distance after the floor, then ensure TP2/TP3
        // are at least TP1's distance scaled by their respective multipliers.
        // This preserves the intended 1.5:2.5:4 ratio between TP1/TP2/TP3 even
        // when the floor kicks in.
        const tp1Dist = Math.max(trv2Atr * entMults.t1, tp1Floor);
        const tp2Dist = Math.max(trv2Atr * entMults.t2, tp1Dist * (entMults.t2 / entMults.t1));
        const tp3Dist = Math.max(trv2Atr * entMults.t3, tp1Dist * (entMults.t3 / entMults.t1));
        const tp1 = dir === 'long' ? price + tp1Dist : price - tp1Dist;
        const tp2 = dir === 'long' ? price + tp2Dist : price - tp2Dist;
        const tp3 = dir === 'long' ? price + tp3Dist : price - tp3Dist;

        // ===== PHASE 3.29 — s.trv2Trade now set AFTER enrichSig passes (added 2026-06-22, task #229) =====
        // Previously: s.trv2Trade was populated here, BEFORE enrichSig could block the signal.
        // When blocked, the trade object stayed in memory and the TP1/TP2/TP3 hit checker
        // (line ~7510) fired sendPush() notifications for entries that were supposedly
        // blocked. User received "🎯 XAU TP1 HIT" notifications for a blocked CALL.
        // The trv2Trade setup is now deferred to the enrichPassed branch below.
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
        // ===== TRv2 ENTRY GATING (rewritten 2026-06-16) =====
        // History:
        // - Pre-2026-05-25: `if (!enrichSig(sig)) return;` blocked everything (incl. trade).
        // - 2026-05-25: removed the gate because TRv2's own gates were thought stricter; missed
        //   one silent TP3 sweep was the trigger.
        // - 2026-06-15: per #176, added "always store" — entries got stored even if enrichSig
        //   would have blocked, tagged with `enrichBlocked: true`. BUT s.trade was still firing
        //   unconditionally — meaning enrichSig blocks NEVER prevented actual trades.
        // - 2026-06-16: TODAY's data: 6 of 7 enrichBlocked TRv2 RIDE entries SL'd, ~-$564/unit
        //   across BTC+NAS. enrichSig's chop/cascade/maturity gates were correctly trying to
        //   stop these — but the trade ran anyway because activation was UNCONDITIONAL.
        //
        // CURRENT BEHAVIOR (per #178):
        // 1. Call enrichSig FIRST (before any side effects).
        // 2. ALWAYS store + log the signal (preserves #176 analytics requirement).
        // 3. If enrichSig blocked → tag with enrichBlocked flag, skip notification + trade.
        //    Cross-asset timestamps are STILL set so NAS_SIG/BTC_SIG still see the attempt
        //    (per 2026-06-12 fix below).
        // 4. If enrichSig passed → notify + activate s.trade as before.
        const enrichPassed = enrichSig(sig);

        // Cross-asset confluence (2026-06-12): set direction timestamps UNCONDITIONALLY so
        // cross-asset confluence sees this entry even when enrichSig blocks the trade.
        // Otherwise XAU/BTC NAS_SIG conviction would miss TRv2 attempts in chop.
        try {
          if (sigType === 'call') s.lastCallSignalTs = Date.now();
          else if (sigType === 'put') s.lastPutSignalTs = Date.now();
        } catch (e) { /* never crash entry on bookkeeping */ }

        if (!enrichPassed) {
          // Tag, store for analytics, but DO NOT activate trade or notify.
          if (!sig.conv) sig.conv = { score: 0, label: 'BLOCKED', factors: [] };
          sig.conv.enrichBlocked = true;
          log(sym, '🚫 TRv2 entry ' + dir.toUpperCase() + ' BLOCKED by enrichSig @ $' + price.toFixed(2) + ' — no trade activation (stored for analytics only) [#' + s.dailySignalCount + ']');
          s.signals.push(sig);
          logSignal(sym, sig);
          return;
        }

        // enrichSig passed — fire normally
        // Phase 3.29: trv2Trade is set HERE (was previously up at line ~7905 before
        // enrichSig). This ensures the TP1/TP2/TP3 hit tracker only watches real entries.
        s.trv2Trade = { dir: dir, ep: price, ts: now3, sl: sl, tp1: tp1, tp2: tp2, tp3: tp3, tp1Hit: false, tp2Hit: false, tp3Hit: false, bestPrice: price, atr: trv2Atr, trailSl: 0, isCfd: true };
        log(sym, '🚀 TRv2 ENTRY ' + dir.toUpperCase() + (withMacro ? ' +MACRO' : '') + ' — $' + price.toFixed(2) + ' > EMA $' + tEma.toFixed(2) + ' (+' + spreadPct.toFixed(3) + '%) · ATR $' + trv2Atr.toFixed(2) + ' · TP1 $' + tp1.toFixed(2) + ' · TP2 $' + tp2.toFixed(2) + ' · TP3 $' + tp3.toFixed(2) + ' · SL $' + sl.toFixed(2) + ' [#' + s.dailySignalCount + ']');
        sendPush('🚀 ' + sym + ' ' + dir.toUpperCase() + ' #' + s.dailySignalCount, '$' + price.toFixed(2) + ' · TP1 $' + tp1.toFixed(2) + ' · TP2 $' + tp2.toFixed(2) + ' · TP3 $' + tp3.toFixed(2) + ' · SL $' + sl.toFixed(2), 'signal');
        s.trade = { active: true, type: sigType, ep: price, t1: false, t2: false, sl: false, rev: false, lastETs: 0, ts: Date.now(), pt1: 30, pt2: 60, sl2: 25, isTrend: true, isCfd: true, slPrice: sl, tp1Price: tp1, tp2Price: tp2, tp3Price: tp3, atr: trv2Atr, bestPrice: price, trailSl: 0 };
        s.signals.push(sig);
        logSignal(sym, sig);
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
    // ===== MACRO-STRENGTH OVERRIDE (added 2026-05-28, Option A) =====
    // If macro is NOW 6+/7 aligned in the NEW (opposite) direction, the market has decisively
    // flipped — the previous signal was on the wrong side of a real reversal. Allow TREND RIDE
    // at 15min instead of 30min when macro confirms. 0-losers safe: macro 6+/7 is the strictest
    // structural confirmation we have.
    // 5/28 case: XAU PUT @ 10:01, then macro flipped to 6+/7 CALL by 10:10. Bot was still in
    // 30-min cooldown when XAU rallied $44. With this override, would have caught at 10:16.
    let trFlipOverride = false;
    if (trFlipBlocked && (now2 - s.lastNTs >= 15 * 60 * 1000) && macroAlignedFor(trSigDir)) {
      trFlipOverride = true;
      log(sym, '✅ TREND RIDE flip-cooldown OVERRIDE — macro 6+/7 aligned ' + trSigDir.toUpperCase() + ', prior ' + s.lastSignalDir.toUpperCase() + ' ' + Math.round((now2 - s.lastNTs) / 60000) + 'min ago (≥15min + macro flip = real reversal).');
    }
    const trFlipFinal = trFlipBlocked && !trFlipOverride;
    if (trFlipFinal) {
      log(sym, 'TREND RIDE blocked — last signal was ' + s.lastSignalDir.toUpperCase() + ' ' + Math.round((now2 - s.lastNTs) / 60000) + 'm ago (need 30m for opposite TREND, or 15min + macro 6+/7).');
    }

    if (trSpreadPct >= trMinSpread && trRoc3Ok && trRoc6Ok && trMacdOk && trSameDirOk && !trFlipFinal) {
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

  // === FIRE SIGNALS (0DTE indicator engine — QQQ/SPY/XAU only) ===
  // BTC/NAS100 use TRv2 EXCLUSIVELY — block base engine for them.
  // XAU (task #213, 2026-06-18): runs BOTH base engine (LHFP/LLFP/STRUCT_*/OBREJ/etc.)
  // AND TRv2 in parallel. The base engine catches fade/reversal patterns; TRv2 catches
  // sustained trend continuations that the fade detectors miss (e.g., 6/18 $50 down move).
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

// ===== OB-ANCHORED TP1 (added 2026-05-25) =====
// Find the closest UNMITIGATED opposing OB in the trade direction. For a PUT trade going
// down, look for a BULLISH OB (demand zone) below — that's where price typically bounces.
// For a CALL trade going up, look for a BEARISH OB (supply zone) above — where price
// typically rejects. If found and CLOSER than the default ATR-based TP1, anchor TP1
// just before the OB edge. Result: higher TP1 hit rate at structurally meaningful levels.
//
// Only TIGHTENS TP1 — never widens it. If the OB is further than default TP1, default
// wins. This is 0-losers-safe: smaller TP1 = higher hit rate = more BE-trail protection.
//
// Returns the OB-anchored TP1 price, or null if no usable OB found.
function findObAnchoredTp1(s, sym, dir, entryPrice, atr) {
  if (!s.orderBlocks || s.orderBlocks.length === 0) return null;
  // Per-symbol buffer before the OB edge (how much room to leave for TP1 to hit reliably)
  const buffer = sym === 'XAU' ? 0.50 : sym === 'BTC' ? 20 : sym === 'NAS100' ? 2.0 : 0.20;
  // Minimum distance from entry — don't anchor TP1 if OB is too close (would be insta-hit)
  const minDist = sym === 'XAU' ? 1.5 : sym === 'BTC' ? 30 : sym === 'NAS100' ? 3 : 0.10;
  let bestTp1 = null;
  let bestDist = Infinity;
  for (const ob of s.orderBlocks) {
    if (ob.mitigated) continue;
    if (dir === 'put') {
      // PUT going down → look for BULL OB below entry (price will bounce off demand)
      if (ob.type !== 'bull') continue;
      if (ob.hi >= entryPrice) continue; // OB must be below entry
      const tp1Candidate = ob.hi + buffer;
      const dist = entryPrice - tp1Candidate;
      if (dist < minDist) continue;
      if (dist < bestDist) { bestDist = dist; bestTp1 = tp1Candidate; }
    } else {
      // CALL going up → look for BEAR OB above entry (price will reject off supply)
      if (ob.type !== 'bear') continue;
      if (ob.lo <= entryPrice) continue; // OB must be above entry
      const tp1Candidate = ob.lo - buffer;
      const dist = tp1Candidate - entryPrice;
      if (dist < minDist) continue;
      if (dist < bestDist) { bestDist = dist; bestTp1 = tp1Candidate; }
    }
  }
  return bestTp1;
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
  // NAS TP1 min floor raised $5 → $30 (added 2026-05-25): NAS at $29k+ makes $5 floor
  // only 0.017% of price — too small to be a meaningful first target. $30 floor matches
  // ~3× ATR with typical NAS ATR ~10, only kicks in during low-vol periods.
  const tp1Dist = isXAU ? 5.0 : isNAS ? Math.max(atr * mults.t1, 30) : Math.max(atr * mults.t1, 5);
  const tp2Dist = atr * mults.t2;
  const tp3Dist = atr * mults.t3;
  const sl = iC ? price - slDist : price + slDist;
  let tp1 = iC ? price + tp1Dist : price - tp1Dist;
  const tp2 = iC ? price + tp2Dist : price - tp2Dist;
  const tp3 = iC ? price + tp3Dist : price - tp3Dist;
  // ===== OB-ANCHORED TP1 (added 2026-05-25) =====
  // If there's an unmitigated opposing OB in the trade direction CLOSER than the
  // ATR-based TP1, anchor TP1 to just before the OB edge. The OB is a structural
  // reversal level — TP1 there has a much higher hit rate than blindly $5/$30/3×ATR
  // out. Only tightens TP1; never widens it. 0-losers safe.
  const sStateForOb = sym && S[sym] ? S[sym] : null;
  if (sStateForOb) {
    const obTp1 = findObAnchoredTp1(sStateForOb, sym, type, price, atr);
    if (obTp1 !== null) {
      const tighterTp1 = iC ? Math.min(obTp1, tp1) : Math.max(obTp1, tp1);
      if (tighterTp1 !== tp1) {
        console.log('[' + ts() + '] ' + sym + ': 🎯 OB-anchored TP1 — using $' + tighterTp1.toFixed(2) + ' (before opposing OB) vs ATR default $' + tp1.toFixed(2));
        tp1 = tighterTp1;
      }
    }
  }

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
  // Direct reference (fixed 2026-06-11 — signalHistory[lastHistIdx] went stale after array pruning)
  const entry = s.lastHistEntry;
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
        // R5 (2026-06-11): record the loss for the repeat-loss zone lockout (gate in enrichSig)
        try {
          const detR5 = (s.lastHistEntry && s.lastHistEntry.symbol === sym && s.lastHistEntry.score)
            ? String(s.lastHistEntry.score).replace(/[^A-Z0-9/]/g, '') : 'UNKNOWN';
          s.slLossHistory = s.slLossHistory || [];
          s.slLossHistory.push({ ts: now, det: detR5, dir: t.type, ep: t.ep });
          if (s.slLossHistory.length > 20) s.slLossHistory.shift();
        } catch (e) { /* never crash exit handling */ }
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

      // ===== PHASE 3.44 — DEFENSIVE SUBSCRIBE STAGGER (added 2026-06-24, task #246) =====
      // Previously: QQQ sub fired 0ms after open (no buffer for Finnhub's router to be
      // ready), SPY 3s later. Result: QQQ subscribe was apparently being dropped, leaving
      // QQQ stuck at $0 while SPY ticked normally.
      // Fix: stagger BOTH subscribes with deliberate delays (1500ms QQQ, 3500ms SPY) so
      // neither hits Finnhub at handshake-edge time. Also resubscribe both in keepalive
      // (not just QQQ) to keep both symbols actively asserted.
      try {
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOLS[0] }));
            console.log('[' + ts() + '] Subscribed to: ' + SYMBOLS[0]);
            wsLog('SUB ' + SYMBOLS[0]);
          }
        }, 1500);
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN && SYMBOLS.length > 1) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOLS[1] }));
            console.log('[' + ts() + '] Subscribed to: ' + SYMBOLS[1]);
            wsLog('SUB ' + SYMBOLS[1]);
          }
        }, 3500);
        // ===== PHASE 3.61 — BTC CRYPTO VOLUME SUBSCRIBE (2026-06-27, task #250) =====
        // Subscribe BTC at 5500ms (after QQQ + SPY) for volume-only ingestion.
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN && BTC_FH_SYMBOL) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: BTC_FH_SYMBOL }));
            console.log('[' + ts() + '] Subscribed to: ' + BTC_FH_SYMBOL + ' (BTC volume only)');
            wsLog('SUB ' + BTC_FH_SYMBOL);
          }
        }, 5500);
      } catch (e) {
        console.error('[' + ts() + '] Subscribe error: ' + e.message);
      }

      // Start ping/pong heartbeat every 20s + Finnhub-level keepalive
      // PHASE 3.44 — keepalive now asserts BOTH symbols (not just SYMBOLS[0]). If a stuck
      // symbol exists, the periodic resend pokes Finnhub to re-establish the stream.
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
          // Re-assert subscription for BOTH Finnhub symbols. Generates WS data frames
          // (proxies treat as activity) AND nudges Finnhub if either stream went silent.
          ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOLS[0] }));
          if (SYMBOLS.length > 1) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOLS[1] }));
          }
          // PHASE 3.61 — also re-assert BTC crypto subscription
          if (BTC_FH_SYMBOL) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: BTC_FH_SYMBOL }));
          }
        } catch (e) {}
      }, 20000);

      // ===== PHASE 3.44 — STUCK-SYMBOL AUTO-RECOVERY (added 2026-06-24, task #246) =====
      // If a Finnhub symbol shows no ticks for 90s while WS is OPEN and the OTHER symbol
      // tick normally, automatically fire unsubscribe → resubscribe to wake it up.
      // Self-healing for the QQQ-stuck-at-$0 scenario without needing /admin/resub.
      // Runs every 30s, only during market window (avoids unnecessary churn at night).
      setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!isMarketWindow()) return;
        const now = Date.now();
        // Need WS to have been up ≥ 60s before considering a symbol "stuck"
        if (!wsOpenedAt || (now - wsOpenedAt) < 60000) return;
        const finnhubSyms = [SYMBOLS[0], SYMBOLS[1]];
        const ages = finnhubSyms.map(sym => ({
          sym,
          age: S[sym].lastTradeTs ? (now - S[sym].lastTradeTs) : Infinity
        }));
        // Only act if there's an asymmetry: one symbol ticking <30s ago, other >90s
        const minAge = Math.min(...ages.map(a => a.age));
        if (minAge > 30000) return; // both are stale — likely market quiet, don't churn
        ages.forEach(({ sym, age }) => {
          if (age > 90000) {
            console.log('[' + ts() + '] AUTO-RECOVER ' + sym + ' — no ticks for ' + Math.round(age / 1000) + 's, while peer tick <30s. Resubscribing.');
            wsLog('AUTO_RECOVER ' + sym + ' age=' + Math.round(age / 1000) + 's');
            try {
              ws.send(JSON.stringify({ type: 'unsubscribe', symbol: sym }));
              setTimeout(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
                }
              }, 500);
            } catch (e) {}
          }
        });
      }, 30000);
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
            const tFh = t.s;
            // ===== PHASE 3.61 — BTC CRYPTO VOLUME-ONLY ROUTING (2026-06-27, task #250) =====
            // If the tick is from Finnhub's BTC crypto symbol (BINANCE:BTCUSDT etc.),
            // route to S.BTC.volBuckets for volume tracking ONLY. BTC price stays with MT5.
            // Skip lastPrice / tickBuf / lastTradeTs (those are MT5-driven for BTC).
            let sym = tFh;
            let btcVolumeOnly = false;
            if (tFh === BTC_FH_SYMBOL) {
              sym = 'BTC';
              btcVolumeOnly = true;
            }
            if (!SYMBOLS.includes(sym)) return;
            if (!btcVolumeOnly) {
              S[sym].lastPrice = t.p;
              S[sym].tickBuf.push({ p: t.p });
              // ===== PHASE 3.43 — PER-SYMBOL LAST-TRADE TIMESTAMP (added 2026-06-24, task #245) =====
              // Track when each symbol last received a tick from Finnhub, so we can detect
              // "symbol subscribed but Finnhub not sending data" cases (e.g. QQQ stuck at $0
              // while SPY updates). Surfaces in /status and /wsdebug.
              S[sym].lastTradeTs = Date.now();
            } else {
              // For BTC, only track volume freshness for diagnostics
              S[sym].lastBtcVolTs = Date.now();
            }
            // ===== PHASE 3.41 — VOLUME CAPTURE (added 2026-06-24, task #243) =====
            // Finnhub trade ticks include 'v' (volume). Accumulate into 1-min buckets,
            // keep rolling window of last 20 buckets. Used by convictionFor() to add
            // a VOLUME factor when current-bar volume spikes above the 20-bucket avg.
            const v = (typeof t.v === 'number' && t.v > 0) ? t.v : 0;
            if (v > 0) {
              const s = S[sym];
              const tk = (typeof t.t === 'number') ? t.t : Date.now();
              if (!s.volBuckets) { s.volBuckets = []; s.volCurBucket = 0; s.volBucketStartTs = tk; }
              if (tk - s.volBucketStartTs >= 60000) {
                s.volBuckets.push(s.volCurBucket);
                if (s.volBuckets.length > 20) s.volBuckets.shift();
                s.volCurBucket = 0;
                s.volBucketStartTs = tk;
              }
              s.volCurBucket += v;
            }
          });
        } else if (msg.type === 'error') {
          // ===== PHASE 3.43 — SURFACE FINNHUB ERRORS (added 2026-06-24, task #245) =====
          // Previously: any non-trade message was silently swallowed by the empty catch.
          // Result: when Finnhub rejected a subscribe (e.g. "Symbol not supported on your
          // plan" or "Subscription expired"), the bot stayed silently broken with no logs.
          // Now: errors are explicitly logged AND tracked in wsEvents for /wsdebug.
          const errMsg = msg.msg || JSON.stringify(msg);
          console.error('[' + ts() + '] Finnhub ERROR: ' + errMsg);
          wsLog('FINNHUB_ERROR: ' + errMsg);
        } else if (msg.type && msg.type !== 'ping') {
          // Log any other unexpected message types (sub responses, etc.) for visibility
          wsLog('MSG type=' + msg.type + ' ' + JSON.stringify(msg).substring(0, 120));
        }
      } catch (e) {
        // PHASE 3.43 — log parse errors too instead of silently swallowing
        wsLog('PARSE_ERR: ' + (e.message || 'unknown') + ' raw=' + String(data).substring(0, 80));
      }
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

// ===== PHASE 3.34 — INITIAL FINNHUB WS CONNECT (added 2026-06-22, task #234) =====
// CRITICAL BUG FIX: connectFinnhub() was defined with full reconnect logic but never
// initially called. All references to it were setTimeout retries from WITHIN the
// function itself — so the chain never started.
//
// Result: WebSocket state stayed "NULL" forever, reconnects: 0, QQQ/SPY always $0.
// Started today's day with QQQ/SPY completely silent because the bot never tried to
// connect to Finnhub.
//
// Fix: invoke connectFinnhub() once on startup. The function self-handles market-hour
// gating + reconnect backoff, so this single call kicks off the persistent loop.
if (API) {
  console.log('[STARTUP] Initiating Finnhub WebSocket connection...');
  connectFinnhub();
} else {
  console.warn('[STARTUP] FINNHUB_API_KEY not set — QQQ/SPY price feed disabled.');
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
    //
    // BUG FIX (2026-05-25): gated to !s.trade.isCfd — this legacy trailing logic was
    // ratcheting slPrice to BE at 1× ATR profit, which is BEFORE TP1 hits (TP1 is at
    // 1.5× ATR for default, 3× ATR for NAS). For CFD trades (TRv2, BREAKOUT, FAST, TREND
    // entered via buildCfdTrade), this caused SL to move to entry too early — any tick
    // back to entry would SL out the trade before TP1 booked a partial profit, breaking
    // the 0-losers strategy. CFD trades use the TP1/TP2/TP3 trailSl mechanism in
    // checkExit() which correctly waits for TP1 hit before moving SL to BE.
    // Legacy percentage-based trades (non-CFD) still use this trailing logic as before.
    if ((isXAUt || isBTCt || isNASt) && s.trade.active && s.trade.isTrend && !s.trade.isCfd) {
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

        // Detect OB mitigation: price sliced through entire OB (breakout failed).
        // Also feed the OBMIT continuation detector (Fix #166 Fix 4) — this was previously
        // gap'd because OBMIT only watched s.orderBlocks (XAU array), not s.obZone.
        // 5/28 XAU case: bearish supply OB at $4393 broke up at 12:30 UTC, XAU then rallied
        // $48 to $4428 over the next hour. The break of bearish OB by bulls IS the
        // continuation signal — extending tracking here closes the gap.
        if (ob.dir === 'call' && price < ob.lo - obTolerance) {
          if (!s.obMitigated) {
            // Bullish OB mitigated DOWN → bears overpowered demand → PUT continuation
            s.lastObMitTs = Date.now();
            s.lastObMitType = 'bull';
            s.lastObMitLevel = (ob.hi + ob.lo) / 2;
            s.obMitFired = false;
            log(sym, '⚡ obZone freshly MITIGATED: BULL $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' broken — watching for PUT continuation');
          }
          s.obMitigated = true;
          log(sym, '🧱 OB MITIGATED: price $' + price.toFixed(2) + ' broke below OB low $' + ob.lo.toFixed(2) + ' — breakout failed');
        } else if (ob.dir === 'put' && price > ob.hi + obTolerance) {
          if (!s.obMitigated) {
            // Bearish OB mitigated UP → bulls overpowered supply → CALL continuation
            s.lastObMitTs = Date.now();
            s.lastObMitType = 'bear';
            s.lastObMitLevel = (ob.hi + ob.lo) / 2;
            s.obMitFired = false;
            log(sym, '⚡ obZone freshly MITIGATED: BEAR $' + ob.lo.toFixed(2) + '-$' + ob.hi.toFixed(2) + ' broken — watching for CALL continuation');
          }
          s.obMitigated = true;
          log(sym, '🧱 OB MITIGATED: price $' + price.toFixed(2) + ' broke above OB high $' + ob.hi.toFixed(2) + ' — breakout failed');
        }
      }
    }

    } catch (e) {
      // Stack added 2026-06-12: 'undefined (reading toFixed)' errors (5/11 BTC, 6/12 NAS100)
      // were unfindable from message alone — log the top stack frames so the next occurrence
      // pinpoints the exact line.
      const frames = (e.stack || '').split('\n').slice(0, 4).join(' | ');
      console.error('[' + ts() + '] processTicks ' + sym + ' error:', e.message, '·', frames);
    }
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

  // ===== PHASE 3.67 — SELF-POPULATING DAILY LEVELS (2026-06-29, task #254) =====
  // Bug: previous design only pushed today's H/L to dailyLevels when the date
  // CHANGED while the server was running. Every deploy reset _lastResetDate to
  // today, so the trigger never fired across multi-deploy days. Result on 06-29:
  // dailyLevels=[] for XAU → multi-day regime gate offline → Phase 3.16, 3.18,
  // 3.42, 3.66 all skip.
  // Fix: every 30s, upsert today's entry from live sessionHigh/sessionLow. Past
  // days are preserved. Rolling H/L recomputed. Date-change full reset below
  // continues to handle EMA/VWAP/RSI resets for the new day.
  SYMBOLS.forEach(symLP => {
    const sLP = S[symLP];
    if (!sLP || sLP.sessionHigh === -Infinity || sLP.sessionLow === Infinity) return;
    sLP.dailyLevels = sLP.dailyLevels || [];
    const todayEntry = sLP.dailyLevels.find(d => d.date === today);
    if (todayEntry) {
      todayEntry.high = Math.max(todayEntry.high, sLP.sessionHigh);
      todayEntry.low = Math.min(todayEntry.low, sLP.sessionLow);
    } else {
      sLP.dailyLevels.push({ high: sLP.sessionHigh, low: sLP.sessionLow, date: today });
      if (sLP.dailyLevels.length > 5) sLP.dailyLevels = sLP.dailyLevels.slice(-5);
      console.log('[' + ts() + '] 📅 ' + symLP + ' dailyLevels: added today ' + today + ' (' + sLP.dailyLevels.length + '/5 days)');
    }
    if (sLP.dailyLevels.length > 0) {
      sLP.rollingHigh = Math.max(...sLP.dailyLevels.map(d => d.high));
      sLP.rollingLow = Math.min(...sLP.dailyLevels.map(d => d.low));
    }
  });

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
// GET /blocked-outcomes/:sym — review shadow-fire data for blocked signals (added 2026-05-25).
// Returns summary stats + last 30 tracked entries. Use to decide on future tuning:
//   - High win-rate on blocked signals = we're over-blocking, consider relaxing
//   - High loss-rate on blocked signals = gates are correctly filtering, keep tight
//   - Mixed = need more data or per-detector analysis
// Read-only — no side effects on signal firing.
app.get('/blocked-outcomes/:sym', (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const s = S[sym];
  if (!s) return res.status(404).json({ error: 'Unknown symbol: ' + sym });
  const outcomes = Array.isArray(s.blockedOutcomes) ? s.blockedOutcomes : [];
  const closed = outcomes.filter(o => o.closed);
  const wins = closed.filter(o => o.outcome === 'win').length;
  const losses = closed.filter(o => o.outcome === 'loss').length;
  const scratches = closed.filter(o => o.outcome === 'scratch').length;
  const unresolved = closed.filter(o => o.outcome === 'no_resolve').length;
  // Per-detector breakdown
  const byDetector = {};
  closed.forEach(o => {
    const key = o.detector + '-' + o.type;
    if (!byDetector[key]) byDetector[key] = { total: 0, win: 0, loss: 0, scratch: 0, no_resolve: 0 };
    byDetector[key].total++;
    byDetector[key][o.outcome]++;
  });
  res.json({
    symbol: sym,
    total: outcomes.length,
    open: outcomes.length - closed.length,
    closed: closed.length,
    summary: { wins, losses, scratches, unresolved },
    winRate: closed.length > 0 ? (((wins + scratches * 0.5) / closed.length) * 100).toFixed(1) + '%' : 'n/a',
    avoidedLossRate: closed.length > 0 ? (((losses + scratches * 0.5) / closed.length) * 100).toFixed(1) + '%' : 'n/a',
    byDetector,
    lastTrackedAgoMin: s.lastBlockTrackedTs ? Math.round((Date.now() - s.lastBlockTrackedTs) / 60000) : null,
    cooldownMin: BLOCK_TRACK_COOLDOWN_MS / 60000,
    entries: outcomes.slice(-30)
  });
});

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
      // PHASE 3.66 — recency override (second occurrence)
      {
        const _rec2 = applyRecencyOverride(s, sym, regimeDir, regimeStrength);
        if (_rec2.downgrade) {
          regimeDir = _rec2.dir;
          regimeStrength = _rec2.strength;
        }
      }
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
      // ===== PHASE 1 INFRASTRUCTURE EXPOSURE (added 2026-06-17) =====
      // Read-only debug surface for verifying Phase 1 tracking. Dashboards / monitoring can
      // poll /prices and inspect phase1.{asian, session, htf, vwap} to confirm population
      // before Phase 2 gates start consuming this state.
      phase1: (sym === 'XAU' || sym === 'BTC' || sym === 'NAS100') ? {
        session: s.session || null,
        inKillzone: !!s.inKillzone,
        asian: {
          h: s.asianH ? +s.asianH.toFixed(2) : null,
          l: s.asianL ? +s.asianL.toFixed(2) : null,
          range: s.asianRange ? +s.asianRange.toFixed(2) : 0,
          hLocked: s.asianH_locked ? +s.asianH_locked.toFixed(2) : null,
          lLocked: s.asianL_locked ? +s.asianL_locked.toFixed(2) : null,
          lockedDate: s.asianLockedDate || null,
          ageMin: s.asianStartTs ? Math.round((Date.now() - s.asianStartTs) / 60000) : 0
        },
        htf: {
          h1Dir: s.htf1h_dir || null,
          h1Pct: +(s.htf1h_strength || 0).toFixed(3),
          h4Dir: s.htf4h_dir || null,
          h4Pct: +(s.htf4h_strength || 0).toFixed(3)
        },
        vwap: {
          value: s.vwap ? +s.vwap.toFixed(2) : null,
          distPct: +(s.vwapDistPct || 0).toFixed(3),
          dir: s.vwapDir || null,
          ageMin: s.vwapAnchorTs ? Math.round((Date.now() - s.vwapAnchorTs) / 60000) : 0
        },
        liqPools: {
          above: s.liqPoolsAbove || [],
          below: s.liqPoolsBelow || [],
          ageSec: s.liqPoolsTs ? Math.round((Date.now() - s.liqPoolsTs) / 1000) : null
        },
        range: {
          zone: s.rangeZone || null,
          posPct: s.rangePosPct,
          ref: s.rangeRef || null,
          hi: s.rangeRefHi ? +s.rangeRefHi.toFixed(2) : null,
          lo: s.rangeRefLo ? +s.rangeRefLo.toFixed(2) : null
        },
        roundNum: {
          level: s.roundNumLevel,
          dist: s.roundNumDist ? +s.roundNumDist.toFixed(2) : null,
          near: !!s.nearRoundNumber
        },
        news: s.newsBlackout || null
      } : null,
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
      trv2: (sym === 'BTC' || sym === 'NAS100' || sym === 'XAU') ? {
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
      // PHASE 3.43 — surface per-symbol last-tick age. If WS is OPEN but lastTickAgeSec
      // keeps climbing for one symbol while others tick normally, we have a symbol-level
      // subscribe issue (not a global connection issue).
      lastTickAgeSec: s.lastTradeTs ? Math.round((Date.now() - s.lastTradeTs) / 1000) : null,
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

// ===== PHASE 3.43 — WS DEBUG + ADMIN RE-SUBSCRIBE (added 2026-06-24, task #245) =====
// Triggered by QQQ stuck at $0 while SPY tickle normally. Two endpoints:
//   GET  /wsdebug      — dump wsEvents log (last 50 OPEN/CLOSE/ERROR/MSG entries)
//   POST /admin/resub  — force unsubscribe + resubscribe both Finnhub symbols
// /admin/resub requires ADMIN_KEY env var to match ?key= query param (light protection;
// rotate via Railway dashboard if leaked). On hit, sends {type:'unsubscribe',symbol:X}
// then a {type:'subscribe',symbol:X} for QQQ and SPY in sequence.
app.get('/wsdebug', (req, res) => {
  res.json({
    wsState: ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] : 'NULL',
    reconnects: wsReconnects,
    backoff: wsBackoff,
    uptime: wsUptime(),
    lastPongSec: wsLastPong > 0 ? Math.round((Date.now() - wsLastPong) / 1000) : null,
    sessionAgeSec: wsOpenedAt > 0 ? Math.round((Date.now() - wsOpenedAt) / 1000) : null,
    lastTickAgeSec: SYMBOLS.reduce((o, sym) => {
      o[sym] = S[sym].lastTradeTs ? Math.round((Date.now() - S[sym].lastTradeTs) / 1000) : null;
      return o;
    }, {}),
    events: wsEvents.slice(-50)
  });
});

app.get('/admin/resub', (req, res) => {
  // Light auth — require ?key=<ADMIN_KEY> matching env var
  const adminKey = process.env.ADMIN_KEY || '';
  if (adminKey && req.query.key !== adminKey) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'ws not open', state: ws ? ws.readyState : 'null' });
  }
  const targets = [SYMBOLS[0], SYMBOLS[1]]; // QQQ, SPY
  const result = { sent: [] };
  try {
    targets.forEach(sym => {
      ws.send(JSON.stringify({ type: 'unsubscribe', symbol: sym }));
      result.sent.push('unsub ' + sym);
    });
    setTimeout(() => {
      try {
        targets.forEach(sym => {
          ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
        });
        console.log('[' + ts() + '] /admin/resub — resubscribed: ' + targets.join(', '));
        wsLog('ADMIN_RESUB ' + targets.join(','));
      } catch (e) {
        console.error('[' + ts() + '] resub re-subscribe error: ' + e.message);
      }
    }, 500);
    result.scheduledResubMs = 500;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PHASE 3.68b — FORCE-SEED ADMIN ENDPOINT (2026-06-29, task #256) =====
// Manually trigger dailyLevels seed without restarting. Use when /state shows
// dailyLevels.count=0 and you want to fix it without a redeploy.
//   GET /admin/seed-daily-levels?key=<ADMIN_KEY>
app.get('/admin/seed-daily-levels', (req, res) => {
  const adminKey = process.env.ADMIN_KEY || '';
  if (adminKey && req.query.key !== adminKey) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const before = {};
  ['XAU', 'BTC', 'NAS100'].forEach(sym => {
    before[sym] = (S[sym] && S[sym].dailyLevels) ? S[sym].dailyLevels.length : 0;
  });
  try {
    seedDailyLevels();
    const after = {};
    ['XAU', 'BTC', 'NAS100'].forEach(sym => {
      after[sym] = (S[sym] && S[sym].dailyLevels) ? S[sym].dailyLevels.length : 0;
    });
    res.json({ ok: true, before: before, after: after });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Signal history — full JSON API (7-day persistent store)
app.get('/signals', (req, res) => {
  let filtered = signalHistory;
  if (req.query.symbol) {
    const sym = req.query.symbol.toUpperCase();
    filtered = filtered.filter(h => h.symbol === sym);
  }
  if (req.query.date) {
    filtered = filtered.filter(h => h.date === req.query.date);
  }
  if (req.query.days) {
    const daysMs = parseInt(req.query.days) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - daysMs;
    filtered = filtered.filter(h => h.ts > cutoff);
  }
  if (req.query.type) {
    filtered = filtered.filter(h => h.type === req.query.type.toLowerCase());
  }
  if (req.query.score) {
    const scoreQ = req.query.score.toUpperCase();
    filtered = filtered.filter(h => h.score && h.score.toUpperCase().includes(scoreQ));
  }
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

app.listen(PORT, () => {
  console.log('[STARTUP] Server listening on port ' + PORT);
});
