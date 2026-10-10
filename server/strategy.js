import { getDb } from './db.js';

// ─── Risk Parameters ────────────────────────────────────────────────────────
// Read from DB daily review updates. Falls back to defaults if not set.
// Reads a fraction in (0, 1] from the environment, e.g. MAX_POSITION_PCT=0.2.
function envFraction(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

const ACCOUNT_SIZE = 10000;        // RM 10,000 initial balance (fallback if metrics lacks it)
const MAX_OPEN_TRADES = 8;           // max 8 positions (need room for crypto)
// Max share of account value in any single position. Applied in position sizing
// and again at execution. Override with MAX_POSITION_PCT.
export const MAX_POSITION_PCT = envFraction('MAX_POSITION_PCT', 0.25);
const MAX_CRYPTO_PCT = 0.20;         // max 20% of initial balance in crypto
export const MAX_DAILY_LOSS = 0.05;  // 5% of account
export const MAX_WEEKLY_LOSS = 0.10; // 10% of account

// Dynamic params (overridden by daily self-review via DB)
let DYNAMIC = {
  stopMultiplier: 1.5,
  rsiOversold: 30,
  rsiOverbought: 70,
  minRewardRisk: 1.5,
  maxRiskPercent: 2.0,
  volatilityFilter: 1,      // 0=off, 1=on: tightens stops when vol > 30%
  trendFilter: 0,            // 0=buy any trend, 1=buy only in bullish trend
  maxDailyTrades: 3,         // 0=unlimited, >0=max trades per day
};

// Per-ticker regime params (loaded from regime classifier)
let TICKER_PARAMS = {};

// Get ticker-specific params (falls back to global defaults)
export function getTickerParams(symbol) {
  const tp = TICKER_PARAMS[symbol];
  if (tp) {
    return tp;
  }
  // Fall back to global defaults
  return DYNAMIC;
}

// Load params from DB at startup and on each review
export function loadParams() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT params FROM metrics WHERE id = 1').get();
    if (row && row.params) {
      const parsed = JSON.parse(row.params);
      
      // Check if this is a regime-classified payload (has overallRegime)
      if (parsed.overallRegime && parsed.tickers) {
        // Store per-ticker params for individual use
        TICKER_PARAMS = parsed.tickers || {};
        // Set global defaults to the overall regime's sample
        const sampleTicker = parsed.tickers['1155.KL'] || parsed.tickers['BTC-USD'];
        if (sampleTicker) {
          DYNAMIC.rsiOversold = sampleTicker.rsiOversold;
          DYNAMIC.rsiOverbought = sampleTicker.rsiOverbought;
          DYNAMIC.stopMultiplier = sampleTicker.stopMultiplier;
          DYNAMIC.minRewardRisk = sampleTicker.minRewardRisk;
          DYNAMIC.maxRiskPercent = sampleTicker.maxRiskPercent;
          console.log('[params] Regime:', parsed.overallRegime, '-', Object.keys(TICKER_PARAMS).length, 'tickers with per-tune RSI');
        } else {
          Object.assign(DYNAMIC, parsed);
          console.log('[params] Loaded:', JSON.stringify(DYNAMIC));
        }
      } else {
        // Legacy flat params
        Object.assign(DYNAMIC, parsed);
        console.log('[params] Loaded:', JSON.stringify(DYNAMIC));
      }
    }
  } catch (e) {
    // defaults are fine
  }
}

// Load params immediately
loadParams();

// Technical analysis constants (not user-adjustable)
const RSI_PERIOD = 14;
const SMA_SHORT = 10;
const SMA_LONG = 30;
const ATR_PERIOD = 14;

// ─── Helpers ────────────────────────────────────────────────────────────────

function calcRSI(prices, period = RSI_PERIOD) {
  if (prices.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
  const recent = changes.slice(-period);
  const gains = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = Math.abs(recent.filter(c => c < 0).reduce((a, b) => a + b, 0)) / period;
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function calcSMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcATR(highs, lows, closes) {
  const period = ATR_PERIOD;
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < Math.min(highs.length, 50); i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  if (trs.length === 0) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Risk Checks ────────────────────────────────────────────────────────────

// Realized loss as a fraction of the account base. Only a negative realized
// P&L counts as a loss; money spent on buys is not a loss.
export function lossLimitStatus(realizedPnL, accountBase, limitPct) {
  const loss = Math.max(0, -(realizedPnL || 0));
  const lossPct = accountBase > 0 ? loss / accountBase : 0;
  return { loss, lossPct, breached: loss > 0 && lossPct >= limitPct };
}

export function canTradeToday(db, metrics) {
  // Emergency stop: global kill switch
  if (metrics.trading_paused) {
    return { allowed: false, reason: 'Trading paused via /api/stop. POST /api/resume to restart.' };
  }

  const accountBase = metrics.initial_balance || ACCOUNT_SIZE;

  // Daily loss: realized P&L of today's sells only (created_at is UTC)
  const today = new Date().toISOString().split('T')[0];
  const todayPnL = db.prepare(
    "SELECT COALESCE(SUM(pnl), 0) as pnl FROM trades WHERE type = 'sell' AND date(created_at) = ?"
  ).get(today)?.pnl || 0;

  const daily = lossLimitStatus(todayPnL, accountBase, MAX_DAILY_LOSS);
  if (daily.breached) {
    return { allowed: false, reason: `Daily loss limit hit: ${(daily.lossPct * 100).toFixed(2)}%` };
  }

  // Weekly loss: based on actual closed P&L from sells
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const weekPnLRow = db.prepare(
    "SELECT COALESCE(SUM(pnl), 0) as pnl FROM trades WHERE type = 'sell' AND date(created_at) >= ?"
  ).get(weekStartStr);
  
  const weekly = lossLimitStatus(weekPnLRow?.pnl || 0, accountBase, MAX_WEEKLY_LOSS);
  if (weekly.breached) {
    return { allowed: false, reason: `Weekly loss limit hit: ${(weekly.lossPct * 100).toFixed(2)}%` };
  }

  // Max daily trades: limit number of buys per day
  if (DYNAMIC.maxDailyTrades > 0) {
    const todayBuys = db.prepare(
      "SELECT COUNT(*) as c FROM trades WHERE type = 'buy' AND date(created_at) = ?"
    ).get(today);
    if (todayBuys && todayBuys.c >= DYNAMIC.maxDailyTrades) {
      return { allowed: false, reason: `Max ${DYNAMIC.maxDailyTrades} daily trades reached` };
    }
  }

  return { allowed: true };
}

// Assets priced above 50 are sized in fractional units (3 dp), cheaper ones in
// whole shares. Always rounds down so caps are never exceeded.
function roundShares(shares, price) {
  if (!(shares > 0)) return 0;
  return price > 50 ? Math.floor(shares * 1000) / 1000 : Math.floor(shares);
}

// Largest size that keeps one position within maxPositionPct of account value.
export function maxSharesForPosition(price, accountValue, maxPositionPct = MAX_POSITION_PCT) {
  if (!(price > 0) || !(accountValue > 0)) return 0;
  return roundShares((accountValue * maxPositionPct) / price, price);
}

// Size = min(risk-based size, concentration cap, what cash can pay for).
// Risk-based size: shares such that hitting the stop loses maxRiskPercent of
// account value.
export function calculatePositionSize(entryPrice, stopLoss, accountValue, {
  cash = accountValue,
  maxPositionPct = MAX_POSITION_PCT,
  maxRiskPercent = DYNAMIC.maxRiskPercent,
} = {}) {
  const riskPerShare = Math.abs(entryPrice - stopLoss);
  const maxRisk = accountValue * maxRiskPercent / 100;

  const riskShares = riskPerShare > 0 ? maxRisk / riskPerShare : 0;
  const capShares = maxSharesForPosition(entryPrice, accountValue, maxPositionPct);
  const cashShares = entryPrice > 0 ? cash / entryPrice : 0;
  const shares = roundShares(Math.min(riskShares, capShares, cashShares), entryPrice);

  return {
    shares,
    risk: Math.round(shares * riskPerShare * 100) / 100,
    maxRisk: Math.round(maxRisk * 100) / 100,
    cappedByConcentration: capShares < riskShares,
  };
}

// Cash plus open positions at cost.
function getAccountValue(db, metrics) {
  const holdingsCost = db.prepare('SELECT COALESCE(SUM(shares * avg_cost), 0) as v FROM portfolio WHERE shares > 0').get().v;
  return metrics.cash + holdingsCost;
}

// ─── Pre-Trade Checklist ────────────────────────────────────────────────────

function evaluateSetups(symbol, currentPrice, historical, portfolio, metrics, accountValue = metrics.cash) {
  if (!historical || historical.length < 20) {
    return { trade: false, reason: 'Insufficient data for analysis' };
  }

  const prices = historical.map(h => h.close);
  const highs = historical.map(h => h.high);
  const lows = historical.map(h => h.low);
  const current = currentPrice || prices[prices.length - 1];

  // Technical indicators
  const rsi = calcRSI(prices);
  const smaShort = calcSMA(prices, SMA_SHORT);
  const smaLong = calcSMA(prices, SMA_LONG);
  const atr = calcATR(highs, lows, prices);
  
  // Volatility check
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - avgRet) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  const annualVol = Math.round(vol * 10000) / 100;
  
  // Market condition assessment
  const trend = smaShort > smaLong ? 'bullish' : 'bearish';
  const volRegime = annualVol > 30 ? 'high' : annualVol > 20 ? 'elevated' : 'normal';
  const rsiRegime = rsi < DYNAMIC.rsiOversold ? 'oversold' : rsi > DYNAMIC.rsiOverbought ? 'overbought' : 'neutral';
  
  // Current position
  const hasPosition = portfolio && portfolio.shares > 0;
  const positionVal = hasPosition ? portfolio.shares * portfolio.avg_cost : 0;

  // Apply volatility filter: tighten params in high vol markets
  const volActive = DYNAMIC.volatilityFilter && annualVol > 30;
  const volStopMult = volActive ? DYNAMIC.stopMultiplier * 0.7 : DYNAMIC.stopMultiplier;
  const volMinRR = volActive ? DYNAMIC.minRewardRisk * 1.3 : DYNAMIC.minRewardRisk;

  // Pre-trade assessment
  const assessment = {
    symbol,
    price: current,
    rsi: Math.round(rsi * 10) / 10,
    smaShort: Math.round(smaShort * 100) / 100,
    smaLong: Math.round(smaLong * 100) / 100,
    trend,
    volatility: annualVol,
    volRegime,
    rsiRegime,
    atr: atr ? Math.round(atr * 100) / 100 : null,
    hasPosition,
    positionValue: positionVal,
  };

  // ─── BUY SETUP ───
  // Clear buy conditions:
  // 1. Downtrend reversal (RSI oversold + price above SMA + bullish cross)
  // 2. Trend pullback (bullish trend + RSI neutral + price at SMA support)
  // 3. Breakout (price above both SMAs + rising volume pattern)
  
  let buySetup = null;
  let sellSetup = null;

  // BUY: Oversold bounce
  // trendFilter: skip buys in bearish trend (only buy in bullish)
  if (rsi < DYNAMIC.rsiOversold + 5 && rsiRegime === 'oversold' && volRegime !== 'high' && !hasPosition &&
      (!DYNAMIC.trendFilter || trend === 'bullish')) {
    const stopLoss = current - (atr ? atr * 1.5 : current * 0.04);
    const takeProfit = current + (atr ? atr * 3 : current * 0.08);
    const rr = ((takeProfit - current) / (current - stopLoss));
    
    if (rr >= volMinRR) {
      const posSize = calculatePositionSize(current, stopLoss, accountValue, { cash: metrics.cash });
      buySetup = {
        direction: 'long',
        entry: current,
        stopLoss: Math.round(stopLoss * 100) / 100,
        takeProfit: Math.round(takeProfit * 100) / 100,
        rewardRisk: Math.round(rr * 10) / 10,
        shares: posSize.shares,
        maxLoss: posSize.risk,
        reason: `Oversold bounce: RSI ${rsi.toFixed(1)} in ${trend} trend`,
        confidence: Math.min(0.35 + (35 - rsi) / 100, 0.6),
        invalidation: `Price closes below ${Math.round(stopLoss * 100) / 100}`,
      };
    }
  }

  // BUY: Trend pullback to SMA
  if (trend === 'bullish' && rsi >= 40 && rsi <= 55 && !hasPosition &&
      current <= smaShort * 1.02 && current >= smaShort * 0.97 && volRegime !== 'high') {
    const stopLoss = smaLong * 0.97;
    const takeProfit = current + (current - stopLoss) * 2.5;
    const rr = ((takeProfit - current) / (current - stopLoss));
    
    if (rr >= DYNAMIC.minRewardRisk) {
      const posSize = calculatePositionSize(current, stopLoss, accountValue, { cash: metrics.cash });
      buySetup = {
        direction: 'long',
        entry: current,
        stopLoss: Math.round(stopLoss * 100) / 100,
        takeProfit: Math.round(takeProfit * 100) / 100,
        rewardRisk: Math.round(rr * 10) / 10,
        shares: posSize.shares,
        maxLoss: posSize.risk,
        reason: `Pullback to SMA${SMA_SHORT} in bullish trend`,
        confidence: 0.45,
        invalidation: `Price closes below SMA${SMA_LONG}`,
      };
    }
  }

  // ─── SELL SETUPS (3-tier adaptive exit) ───
  // Uses dynamic RSI/ATR/risk params from regime classifier (per-ticker or global)
  // Designed for profit-taking, not panic. As adaptive as the buy logic.

  if (hasPosition && portfolio) {
    const entryPrice = portfolio.avg_cost;
    const pnlPercent = ((current - entryPrice) / entryPrice) * 100;
    const atrVal = atr || entryPrice * 0.02;

    // TIER 1: TAKE PROFIT — Overbought in ANY trend
    // Adaptive RSI threshold from regime classifier / daily review
    // If RSI crosses above overbought, exit with profit regardless of trend direction
    if (rsi > DYNAMIC.rsiOverbought) {
      const bearishNote = trend === 'bearish' ? ' with bearish divergence' : '';
      const confidence = Math.min(0.5 + (rsi - DYNAMIC.rsiOverbought) / 50, 0.85);
      sellSetup = {
        direction: 'close',
        entry: current,
        reason: `Take profit: RSI ${rsi.toFixed(1)} > ${DYNAMIC.rsiOverbought} (${trend}${bearishNote}) | P&L ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
        confidence,
      };
    }

    // TIER 2: TARGET HIT — Price achieved reward:risk target from entry
    // Adaptive: uses dynamic minRewardRisk from daily review
    if (!sellSetup && pnlPercent > 0) {
      const targetMultiplier = DYNAMIC.minRewardRisk * DYNAMIC.maxRiskPercent / 2;
      const targetPrice = entryPrice * (1 + targetMultiplier / 100);
      if (current >= targetPrice) {
        sellSetup = {
          direction: 'close',
          entry: current,
          reason: `Target hit: +${pnlPercent.toFixed(2)}% gain (target ${targetMultiplier.toFixed(1)}%) | R/R ${DYNAMIC.minRewardRisk}:1`,
          confidence: 0.6,
        };
      }
    }

    // TIER 3: STOP LOSS — Price breached adaptive ATR-based stop
    // Adaptive: uses per-ticker stopMultiplier and maxRiskPercent from regime classifier
    if (!sellSetup && pnlPercent < 0) {
      const stopPercent = Math.abs(DYNAMIC.stopMultiplier * atrVal / entryPrice) * 100;
      const floorStop = DYNAMIC.maxRiskPercent / 2;
      const effectiveStop = Math.max(stopPercent, floorStop * 0.5);

      if (current <= entryPrice * (1 - effectiveStop / 100)) {
        sellSetup = {
          direction: 'close',
          entry: current,
          reason: `Stop loss: ${Math.abs(pnlPercent).toFixed(2)}% loss | ATR stop ${effectiveStop.toFixed(2)}%`,
          confidence: 0.8,
        };
      }
    }
  }

  return {
    assessment,
    buySetup,
    sellSetup,
    canTrade: canTradeToday,
  };
}

// ─── Analysis Engine ────────────────────────────────────────────────────────

// ─── AI-Trusted Execution ──────────────────────────────────────────────────
// AI sub-agent pipeline has already analyzed and approved the trade.
// This function trusts the AI's decision and only applies basic guardrails
// (cash balance, daily/weekly loss limits) before executing.

// requestId (optional) is an idempotency key from the caller. A retried or
// replayed request with the same key returns the original trade instead of
// executing a second time.
export async function executeAIDecision(symbol, action, price, shares, plan, { requestId, confidence, reasoning } = {}) {
  const db = getDb();
  const metrics = db.prepare('SELECT * FROM metrics WHERE id = 1').get();

  if (requestId) {
    const prior = db.prepare('SELECT id FROM trades WHERE request_id = ?').get(requestId);
    if (prior) {
      return { executed: false, duplicate: true, tradeId: prior.id, reason: `Request ${requestId} already executed as trade #${prior.id}` };
    }
  }

  // Basic guardrails only
  const tradeCheck = canTradeToday(db, metrics);
  if (!tradeCheck.allowed) {
    return { executed: false, reason: tradeCheck.reason };
  }

  // Build trade plan object for executeTrade
  const tradePlan = {
    direction: action === 'buy' ? 'long' : 'close',
    entry: price,
    stopLoss: plan?.stopLoss || null,
    takeProfit: plan?.takeProfit || null,
    positionSize: shares,
    maxLoss: plan?.maxLoss || (shares * Math.abs(price - (plan?.stopLoss || 0))),
    rewardRisk: plan?.rewardRisk || null,
    reason: plan?.reason || reasoning || `AI decision: ${action}`,
    invalidation: plan?.invalidation || null,
    confidence: plan?.confidence || confidence || 0.5,
  };

  // executeTrade logs the decision row; callers must not log it again.
  return await executeTrade(symbol, action, price, tradePlan.confidence, tradePlan.reason, tradePlan, { requestId });
}

export async function analyzeSymbol(symbol, currentPrice, historical) {
  const db = getDb();
  const portfolio = db.prepare('SELECT * FROM portfolio WHERE symbol = ?').get(symbol);
  const metrics = db.prepare('SELECT * FROM metrics WHERE id = 1').get();
  
  // Reload per-ticker regime params from DB
  try {
    const row = db.prepare('SELECT params FROM metrics WHERE id = 1').get();
    if (row && row.params) {
      const parsed = JSON.parse(row.params);
      if (parsed.tickers) {
        TICKER_PARAMS = parsed.tickers;
      }
    }
  } catch (e) { /* use current params */ }
  
  // Get params specific to this ticker (falls back to global DYNAMIC)
  const p = getTickerParams(symbol);
  
  // Override global DYNAMIC with per-ticker thresholds for this analysis
  // (evaluateSetups uses DYNAMIC internally, so we set them before calling it).
  // Restored afterwards so one ticker's params never leak into the next.
  const _saved = { ...DYNAMIC };
  for (const k of ['rsiOversold', 'rsiOverbought', 'stopMultiplier', 'minRewardRisk', 'maxRiskPercent']) {
    if (p[k] !== undefined) DYNAMIC[k] = p[k];
  }
  try {
    return decide(db, symbol, currentPrice, historical, portfolio, metrics);
  } finally {
    DYNAMIC = _saved;
  }
}

function decide(db, symbol, currentPrice, historical, portfolio, metrics) {
  // Check if we can trade
  const tradeCheck = canTradeToday(db, metrics);
  
  // Evaluate setups
  const evaluation = evaluateSetups(symbol, currentPrice, historical, portfolio, metrics, getAccountValue(db, metrics));

  // If trade not allowed, report why
  if (!tradeCheck.allowed) {
    return {
      symbol,
      action: 'hold',
      confidence: 0,
      reasoning: `Trade blocked: ${tradeCheck.reason}`,
      assessment: evaluation.assessment,
    };
  }

  // Decide action
  let action = 'hold';
  let confidence = 0;
  let reasoning = '';
  let tradePlan = null;

  // Priority 1: Exit signals (risk management always first)
  if (portfolio && portfolio.shares > 0 && evaluation.sellSetup) {
    action = 'sell';
    confidence = evaluation.sellSetup.confidence;
    reasoning = evaluation.sellSetup.reason;
    tradePlan = evaluation.sellSetup;
  }
  // Priority 2: Entry signals
  else if (evaluation.buySetup && !portfolio?.shares) {
    action = 'buy';
    confidence = evaluation.buySetup.confidence;
    reasoning = `${evaluation.buySetup.reason} | R/R ${evaluation.buySetup.rewardRisk}:1 | Max loss $${evaluation.buySetup.maxLoss}`;
    tradePlan = evaluation.buySetup;
  }
  // No clear setup
  else {
    reasoning = `No clear setup. RSI ${evaluation.assessment.rsi} | ${evaluation.assessment.trend} trend | ${evaluation.assessment.volRegime} vol`;
  }

  // Build detailed trade plan for logging
  const plan = tradePlan ? {
    ticker: symbol,
    direction: tradePlan.direction,
    entryReason: tradePlan.reason,
    marketCondition: `${evaluation.assessment.trend}/${evaluation.assessment.rsiRegime}/${evaluation.assessment.volRegime}`,
    entryPrice: tradePlan.entry,
    stopLoss: tradePlan.stopLoss || null,
    takeProfit: tradePlan.takeProfit || null,
    positionSize: tradePlan.shares || null,
    maxLoss: tradePlan.maxLoss || null,
    rewardRisk: tradePlan.rewardRisk || null,
    failReason: `Stop loss at ${tradePlan.stopLoss || 'N/A'} would be hit`,
    confidence,
    invalidation: tradePlan.invalidation || null,
  } : null;

  return {
    symbol,
    action,
    confidence: Math.round(confidence * 100) / 100,
    reasoning,
    tradePlan: plan,
    assessment: evaluation.assessment,
  };
}

// ─── Execution ──────────────────────────────────────────────────────────────

// opts.slippagePct: fixed slippage fraction (default: random 0.1-0.3%).
// opts.requestId: idempotency key stored on the trade row (unique).
export async function executeTrade(symbol, action, price, confidence, reasoning, tradePlan, opts = {}) {
  const db = getDb();
  const metrics = db.prepare('SELECT * FROM metrics WHERE id = 1').get();
  const isCrypto = symbol.endsWith('-USD') || symbol.endsWith('-USDT');
  const requestId = opts.requestId || null;

  // Slippage model: apply 0.1-0.3% slippage to simulate real fills
  const slippagePct = opts.slippagePct ?? (0.001 + Math.random() * 0.002); // 0.1-0.3%
  const slippageDir = action === 'buy' ? 1 : -1; // buy higher, sell lower
  const execPrice = Math.round(price * (1 + slippageDir * slippagePct) * 100) / 100;
  const slippageLogged = Math.round(slippagePct * 10000) / 100;

  // Emergency stop: skip execution if paused
  if (metrics.trading_paused) {
    return { executed: false, reason: 'Trading paused via /api/stop' };
  }

  // Log decision (exactly once per call)
  db.prepare(
    'INSERT INTO decisions (symbol, action, price, confidence, reasoning) VALUES (?, ?, ?, ?, ?)'
  ).run(symbol, action, price, confidence, reasoning);

  // Execute buy. Checks and writes run in one IMMEDIATE transaction so a second
  // process (or a retried request) cannot pass the same checks before this
  // write lands.
  if (action === 'buy' && tradePlan && tradePlan.positionSize > 0) {
    const buy = db.transaction(() => {
      if (requestId && db.prepare('SELECT id FROM trades WHERE request_id = ?').get(requestId)) {
        return { executed: false, duplicate: true, reason: `Request ${requestId} already executed` };
      }

      // Guard: no duplicate buys
      const existingPos = db.prepare('SELECT shares FROM portfolio WHERE symbol = ? AND shares > 0').get(symbol);
      if (existingPos) {
        return { executed: false, reason: `Already holding ${existingPos.shares} shares of ${symbol}. No duplicate buys.` };
      }

      const m = db.prepare('SELECT * FROM metrics WHERE id = 1').get();

      // Crypto allocation cap: max 20% of initial balance in crypto
      if (isCrypto) {
        const cryptoValue = db.prepare('SELECT * FROM portfolio WHERE shares > 0').all()
          .filter(h => h.symbol.endsWith('-USD') || h.symbol.endsWith('-USDT'))
          .reduce((s, h) => s + h.shares * h.avg_cost, 0);
        const newTotal = cryptoValue + tradePlan.positionSize * execPrice;
        const maxCrypto = m.initial_balance * MAX_CRYPTO_PCT;
        if (newTotal > maxCrypto) {
          return { executed: false, reason: `Crypto cap exceeded: RM${newTotal.toFixed(0)} > RM${maxCrypto.toFixed(0)} (${MAX_CRYPTO_PCT * 100}% max)` };
        }
      }

      // Concentration cap: no single position above MAX_POSITION_PCT of account value
      const accountValue = getAccountValue(db, m);
      const cappedShares = maxSharesForPosition(execPrice, accountValue);
      if (cappedShares <= 0) {
        return { executed: false, reason: `Position cap: RM${(accountValue * MAX_POSITION_PCT).toFixed(0)} (${(MAX_POSITION_PCT * 100).toFixed(0)}% of RM${accountValue.toFixed(0)}) too small for one unit at RM${execPrice}` };
      }
      const shares = Math.min(tradePlan.positionSize, cappedShares);

      const total = shares * execPrice;
      if (m.cash < total) {
        return { executed: false, reason: 'Insufficient cash' };
      }

      // Check max open positions
      const openPositions = db.prepare('SELECT COUNT(*) as c FROM portfolio WHERE shares > 0').get().c;
      if (openPositions >= MAX_OPEN_TRADES) {
        return { executed: false, reason: `Max ${MAX_OPEN_TRADES} open positions reached` };
      }

      db.prepare(
        'INSERT INTO portfolio (symbol, shares, avg_cost) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET shares = shares + ?, avg_cost = ?'
      ).run(symbol, shares, execPrice, shares, execPrice);

      db.prepare('UPDATE metrics SET cash = cash - ? WHERE id = 1').run(total);

      const info = db.prepare(
        'INSERT INTO trades (symbol, type, shares, price, total, reason, confidence, slippage, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(symbol, 'buy', shares, price, total, reasoning, confidence, slippageLogged, requestId);

      return {
        executed: true, action: 'buy', tradeId: Number(info.lastInsertRowid),
        shares, price: execPrice, originalPrice: price,
        total, slippage: slippageLogged,
        cappedByConcentration: shares < tradePlan.positionSize,
        stopLoss: tradePlan.stopLoss, takeProfit: tradePlan.takeProfit,
      };
    });
    return buy.immediate();
  }

  // Execute sell (close position). Position is re-read inside the transaction
  // so two concurrent sells cannot both close it.
  if (action === 'sell') {
    const sell = db.transaction(() => {
      const portfolio = db.prepare('SELECT * FROM portfolio WHERE symbol = ? AND shares > 0').get(symbol);
      if (!portfolio) return { executed: false, reason: 'No position' };
      const currentShares = portfolio.shares;
      const total = currentShares * execPrice;
      // Realized P&L of this position only: exit value minus its cost basis.
      const pnl = total - currentShares * portfolio.avg_cost;

      db.prepare('DELETE FROM portfolio WHERE symbol = ?').run(symbol);
      db.prepare('UPDATE metrics SET cash = cash + ? WHERE id = 1').run(total);

      const info = db.prepare(
        'INSERT INTO trades (symbol, type, shares, price, total, pnl, reason, confidence, slippage, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(symbol, 'sell', currentShares, price, total, pnl, reasoning, confidence, slippageLogged, requestId);

      return { executed: true, action: 'sell', tradeId: Number(info.lastInsertRowid), shares: currentShares, price: execPrice, originalPrice: price, total, pnl, slippage: slippageLogged };
    });
    return sell.immediate();
  }

  return { executed: false, reason: action === 'sell' ? 'No position' : 'No valid setup' };
}

// ─── End-of-Day Evaluation ──────────────────────────────────────────────────

export function evaluateDay() {
  const db = getDb();
  
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartStr = dayStart.toISOString();

  const trades = db.prepare(
    "SELECT * FROM trades WHERE created_at >= ? ORDER BY id"
  ).all(dayStartStr);

  const decisions = db.prepare(
    "SELECT * FROM decisions WHERE created_at >= ? ORDER BY id"
  ).all(dayStartStr);

  const metrics = db.prepare('SELECT * FROM metrics WHERE id = 1').get();

  // Calculate stats
  const wins = trades.filter(t => t.type === 'sell' && t.pnl > 0).length;
  const losses = trades.filter(t => t.type === 'sell' && t.pnl < 0).length;
  const winRate = (wins + losses) > 0 ? wins / (wins + losses) : 0;
  
  const pnls = trades.filter(t => t.type === 'sell').map(t => t.pnl || 0);
  const avgWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0) / (wins || 1);
  const avgLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0)) / (losses || 1);
  const profitFactor = losses > 0 ? (pnls.filter(p => p > 0).reduce((a, b) => a + b, 0) / Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0))) : 0;

  // Find rule violations
  const violations = [];
  if (trades.length > 5) violations.push('Possible overtrading');
  
  // Update metrics
  db.prepare('UPDATE metrics SET total_trades = total_trades + ?, wins = ?, losses = ?, win_rate = ? WHERE id = 1')
    .run(trades.length, wins, losses, winRate);

  return {
    date: dayStartStr.split('T')[0],
    totalTrades: trades.length,
    wins, losses,
    winRate: Math.round(winRate * 10000) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    bestTrade: pnls.length > 0 ? Math.round(Math.max(...pnls) * 100) / 100 : 0,
    worstTrade: pnls.length > 0 ? Math.round(Math.min(...pnls) * 100) / 100 : 0,
    violations,
    cash: metrics.cash,
    totalValue: null, // calculated by portfolio route
  };
}
