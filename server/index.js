import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { getQuote, getWatchlist, getTrainingData, isMarketOpen, isPreMarket, isCrypto } from './market.js';
import { analyzeSymbol, executeTrade, executeAIDecision, evaluateDay } from './strategy.js';

const PORT = parseInt(process.env.PORT || '5900', 10);
const HOST = process.env.HOST || '127.0.0.1';
const app = express();

app.use(cors({ origin: false }));
app.use(express.json());

initDb();

// ─── Portfolio (with live prices for P&L) ───
app.get('/api/portfolio', async (req, res) => {
  try {
    const db = getDb();
    const dbHoldings = db.prepare('SELECT * FROM portfolio WHERE shares > 0').all();
    const metrics = db.prepare('SELECT * FROM metrics WHERE id = 1').get();

    // Fetch live prices for each holding
    const holdings = [];
    let marketValue = 0;
    for (const h of dbHoldings) {
      let currentPrice = h.avg_cost;
      try {
        const quote = await getQuote(h.symbol);
        if (quote && quote.price) currentPrice = quote.price;
      } catch (e) { /* use cost as fallback */ }
      
      const costBasis = h.shares * h.avg_cost;
      const currentValue = h.shares * currentPrice;
      const unrealizedPnl = currentValue - costBasis;
      const unrealizedPnlPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;
      marketValue += currentValue;
      
      holdings.push({
        symbol: h.symbol,
        shares: h.shares,
        avg_cost: Math.round(h.avg_cost * 100) / 100,
        current_price: Math.round(currentPrice * 100) / 100,
        cost_basis: Math.round(costBasis * 100) / 100,
        market_value: Math.round(currentValue * 100) / 100,
        unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
        unrealized_pnl_pct: Math.round(unrealizedPnlPct * 100) / 100,
      });
    }

    // Calculate realized P&L (all-time + monthly)
    const realizedPnL = db.prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE type = 'sell'").get().total || 0;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthlyPnL = db.prepare(
      "SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE type = 'sell' AND created_at >= ?"
    ).get(monthStart.toISOString()).total || 0;
    const allTrades = db.prepare('SELECT * FROM trades').all();
    const sellTrades = allTrades.filter(t => t.type === 'sell');
    const tradeWins = sellTrades.filter(t => t.pnl > 0).length;
    const tradeLosses = sellTrades.filter(t => t.pnl < 0).length;
    const tradeWinRate = (tradeWins + tradeLosses) > 0 ? Math.round((tradeWins / (tradeWins + tradeLosses)) * 10000) / 10000 : 0;

    const totalValue = metrics.cash + marketValue;
    const totalPnl = totalValue - metrics.initial_balance;
    const totalPnlPct = (totalPnl / metrics.initial_balance) * 100;

    res.json({
      cash: Math.round(metrics.cash * 100) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      totalValue: Math.round(totalValue * 100) / 100,
      initialBalance: metrics.initial_balance,
      realized_pnl: Math.round(realizedPnL * 100) / 100,
      unrealized_pnl: Math.round((marketValue - holdings.reduce((s,h) => s + h.cost_basis, 0)) * 100) / 100,
      pnl: Math.round(totalPnl * 100) / 100,
      pnlPercent: Math.round(totalPnlPct * 100) / 100,
      // Use actual trade data, not stale metrics table
      totalTrades: allTrades.length,
      wins: tradeWins,
      losses: tradeLosses,
      winRate: tradeWinRate,
      monthly_pnl: Math.round(monthlyPnL * 100) / 100,
      trading_paused: !!metrics.trading_paused,
      holdings,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Market Data ───
app.get('/api/market/quotes', async (req, res) => {
  try {
    const symbols = getWatchlist();
    const quotes = [];
    for (const symbol of symbols) {
      const q = await getQuote(symbol);
      if (q) quotes.push(q);
      await new Promise(r => setTimeout(r, 1200)); // rate limit: 5 calls/min
    }
    res.json({ quotes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/market/history/:symbol', async (req, res) => {
  try {
    const data = await getHistorical(req.params.symbol);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Decisions & Trades ───
app.get('/api/decisions', (req, res) => {
  try {
    const db = getDb();
    const decisions = db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT 50').all();
    res.json({ decisions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trades', (req, res) => {
  try {
    const db = getDb();
    const trades = db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 100').all();
    res.json({ trades });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Decision Engine (manual trigger for testing) ───
app.post('/api/analyze/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const quote = await getQuote(symbol);
    const historical = await getTrainingData(symbol);

    if (!quote || !historical || historical.length < 10) {
      return res.status(400).json({ error: 'Insufficient market data' });
    }

    const decision = await analyzeSymbol(symbol, quote.price, historical);
    const result = await executeTrade(symbol, decision.action, quote.price, decision.confidence, decision.reasoning, decision.tradePlan);

    evaluateDay();

    res.json({ quote, decision, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Analyze all watchlist symbols ───
app.post('/api/analyze-all', async (req, res) => {
  try {
    const symbols = getWatchlist();
    const results = [];

    for (const symbol of symbols) {
      try {
        const quote = await getQuote(symbol);
        const historical = await getTrainingData(symbol);
        if (!quote || !historical) {
          results.push({ symbol, action: 'skip', reason: 'No data' });
          continue;
        }
        const decision = await analyzeSymbol(symbol, quote.price, historical);
        const result = await executeTrade(symbol, decision.action, quote.price, decision.confidence, decision.reasoning, decision.tradePlan);
        results.push({ symbol, price: quote.price, ...decision, result });
        await new Promise(r => setTimeout(r, 500)); // 500ms delay for 20 tickers
      } catch (e) {
        results.push({ symbol, error: e.message });
      }
    }

    evaluateDay();
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Top 5 Candidates for AI Analysis ──────────────────────────────────────
// Fast pre-screen all tickers, return top 5 most promising for LLM decision.
app.get('/api/analyze-top', async (req, res) => {
  try {
    const symbols = getWatchlist();
    const candidates = [];
    for (const symbol of symbols) {
      try {
        const quote = await getQuote(symbol);
        const historical = await getTrainingData(symbol);
        if (!quote || !historical) continue;
        const decision = await analyzeSymbol(symbol, quote.price, historical);
        // Score: confidence * signal quality, weighted by action type
        let score = (decision.confidence || 0) * 100;
        if (decision.action === 'buy') score += 30;
        if (decision.signal_quality) score += decision.signal_quality;
        candidates.push({ symbol, price: quote.price, action: decision.action, score, reason: decision.reasoning || '' });
        await new Promise(r => setTimeout(r, 200));
      } catch (e) { /* skip */ }
    }
    // Sort by score descending, return top 5
    candidates.sort((a, b) => b.score - a.score);
    res.json({ candidates: candidates.slice(0, 5), total: candidates.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Market Snapshot (fast, all tickers, no delay) ─────────────────────────
// Returns all tickers with current price and signal.
app.get('/api/market/snapshot', async (req, res) => {
  try {
    const symbols = getWatchlist();
    const tickers = [];
    for (const symbol of symbols) {
      try {
        const quote = await getQuote(symbol);
        if (quote) {
          const historical = await getTrainingData(symbol);
          const decision = historical ? await analyzeSymbol(symbol, quote.price, historical) : null;
          tickers.push({
            symbol,
            price: quote.price,
            change: quote.change || 0,
            changePercent: quote.changePercent || 0,
            signal: decision ? decision.action : 'hold',
            signalStr: decision ? (decision.reasoning || '').substring(0, 50) : '',
          });
        }
      } catch (e) { /* skip tickers with errors */ }
    }
    res.json({ tickers, count: tickers.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Top Performer History ──────────────────────────────────────────────────
// Returns price history for the top performing ticker (by unrealized P&L).
app.get('/api/market/top-history', async (req, res) => {
  try {
    const db = getDb();
    const holdings = db.prepare('SELECT * FROM portfolio WHERE shares > 0').all();
    let topSymbol = null, bestPnl = -Infinity;
    for (const h of holdings) {
      try {
        const quote = await getQuote(h.symbol);
        if (quote) {
          const currentValue = h.shares * quote.price;
          const costBasis = h.shares * h.avg_cost;
          const pnl = currentValue - costBasis;
          if (pnl > bestPnl) { bestPnl = pnl; topSymbol = h.symbol; }
        }
      } catch (e) {}
    }
    if (!topSymbol) return res.json({ symbol: null, history: [] });
    const hist = await getTrainingData(topSymbol);
    const prices = hist ? hist.map(p => ({ date: p.date, price: p.close })).filter(p => p.price) : [];
    res.json({ symbol: topSymbol, history: prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI-Trusted Direct Execution ───────────────────────────────────────────
// The AI sub-agent pipeline has already analyzed the trade.
// This endpoint trusts the AI decision and only applies basic guardrails.
// Called by trading-bot-scan cron after Risk Manager approves.
app.post('/api/execute', async (req, res) => {
  try {
    const { symbol, action, price, shares, plan, confidence, reasoning } = req.body;
    
    if (!symbol || !action || !price || !shares) {
      return res.status(400).json({ error: 'Missing required fields: symbol, action, price, shares' });
    }

    // Execute the AI-approved trade directly (no re-analysis)
    const result = await executeAIDecision(symbol, action, price, shares, plan);

    // Log the AI decision
    const db = getDb();
    db.prepare(
      'INSERT INTO decisions (symbol, action, price, confidence, reasoning) VALUES (?, ?, ?, ?, ?)'
    ).run(symbol, action, price, confidence || 0.5, reasoning || `AI pipeline decision: ${action}`);

    evaluateDay();

    res.json({ executed: result.executed, result, source: 'ai-pipeline' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Emergency Stop / Resume ───
app.post('/api/stop', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE metrics SET trading_paused = 1 WHERE id = 1').run();
  console.log('[trading] EMERGENCY STOP — all trading halted');
  res.json({ status: 'paused', message: 'Trading halted. POST /api/resume to restart.' });
});

app.post('/api/resume', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE metrics SET trading_paused = 0 WHERE id = 1').run();
  console.log('[trading] RESUMED');
  res.json({ status: 'active', message: 'Trading resumed.' });
});

// ─── Bursa Malaysia hours (GMT+8) ───
function canTradeSymbol(symbol) {
  if (isCrypto(symbol)) return { allowed: true, reason: 'crypto 24/7' };
  if (isMarketOpen()) return { allowed: true, reason: 'bursa open' };
  return { allowed: false, reason: 'Bursa closed (Mon-Fri 9AM-5PM MYT)' };
}

// ─── Market Status ───
app.get('/api/market-status', (req, res) => {
  const db = getDb();
  const metrics = db.prepare('SELECT trading_paused FROM metrics WHERE id = 1').get();
  res.json({
    trading_paused: !!metrics?.trading_paused,
    bursa_open: isMarketOpen(),
    time: new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }),
    watchlistSize: getWatchlist().length,
  });
});

// ─── Health ───
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Serve frontend ───
const distPath = new URL('../dist', import.meta.url).pathname;
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(distPath + '/index.html');
});

// ─── 24/7 Auto-Scan Loop ───────────────────────────────────────────────────
// Scans all tickers every 2 minutes, 24/7. No market hours check.
// Buys/sells automatically based on technical analysis.
async function autoScan() {
  try {
    const db = getDb();
    const metrics = db.prepare('SELECT trading_paused, cash FROM metrics WHERE id = 1').get();

    // Emergency stop: skip entire scan if paused
    if (metrics?.trading_paused) {
      console.log('[auto-scan] TRADING PAUSED — skipping scan');
      return;
    }

    const symbols = getWatchlist();
    for (const symbol of symbols) {
      try {
        // Market hours filter: skip Bursa stocks when market closed
        const hoursCheck = canTradeSymbol(symbol);
        if (!hoursCheck.allowed) {
          continue;  // skip silently, no error noise
        }

        const quote = await getQuote(symbol);
        const historical = await getTrainingData(symbol);
        if (!quote || !historical) continue;
        const decision = await analyzeSymbol(symbol, quote.price, historical);
        const result = await executeTrade(symbol, decision.action, quote.price, decision.confidence, decision.reasoning, decision.tradePlan);
        if (result.executed) {
          console.log(`[auto-scan] ${symbol}: ${decision.action} ${result.shares || ''} @ ${quote.price}`);
          db.prepare('UPDATE metrics SET last_trade_at = datetime(\'now\') WHERE id = 1').run();
        }
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        // individual symbol errors don't stop the loop
      }
    }
    evaluateDay();
  } catch (e) {
    console.error('[auto-scan] error:', e.message);
  }
}

// Start auto-scan loop: every 2 minutes
setInterval(autoScan, 300000);  // 5 minutes
setTimeout(autoScan, 5000);

app.listen(PORT, HOST, () => {
  console.log(`[trading-bot] running on http://${HOST}:${PORT}`);
  console.log(`[trading-bot] auto-scan every 2 minutes, 24/7`);
});

// ─── Auto-Fix / Health ──────────────────────────────────────────────────────
// Internal diagnostic endpoint that detects and repairs common issues.
// Called by the auto-fix loop cron to keep the system healthy.
app.post('/api/fix', async (req, res) => {
  try {
    const db = getDb();
    const fixes = [];

    // Fix 1: Remove duplicate trades (same symbol, type, price, timestamp)
    const dups = db.prepare(`
      SELECT id, symbol, type, created_at FROM trades 
      WHERE (symbol, type, price, created_at) IN (
        SELECT symbol, type, price, created_at FROM trades 
        GROUP BY symbol, type, price, created_at HAVING COUNT(*) > 1
      ) AND id NOT IN (
        SELECT MIN(id) FROM trades 
        GROUP BY symbol, type, price, created_at HAVING COUNT(*) > 1
      )
    `).all();

    for (const d of dups) {
      db.prepare('DELETE FROM trades WHERE id = ?').run(d.id);
      fixes.push({ type: 'trade-dedup', detail: `Removed duplicate ${d.type} of ${d.symbol} (trade #${d.id})` });
    }

    // Fix 2: Remove duplicate decisions (same symbol, action, price within 1s)
    const dupDecisions = db.prepare(`
      SELECT id, symbol, action FROM decisions
      WHERE (symbol, action, price, strftime('%s', created_at)) IN (
        SELECT symbol, action, price, strftime('%s', created_at) FROM decisions
        GROUP BY symbol, action, price, strftime('%s', created_at) HAVING COUNT(*) > 1
      ) AND id NOT IN (
        SELECT MIN(id) FROM decisions
        GROUP BY symbol, action, price, strftime('%s', created_at) HAVING COUNT(*) > 1
      )
    `).all();

    for (const d of dupDecisions) {
      db.prepare('DELETE FROM decisions WHERE id = ?').run(d.id);
      fixes.push({ type: 'decision-dedup', detail: `Removed duplicate decision on ${d.symbol} (decision #${d.id})` });
    }

    // Fix 3: Recalculate metrics from actual portfolio
    const holdings = db.prepare('SELECT * FROM portfolio WHERE shares > 0').all();
    const holdingsValue = holdings.reduce((sum, h) => sum + (h.shares * h.avg_cost), 0);
    const cash = db.prepare('SELECT cash FROM metrics WHERE id = 1').get()?.cash || 0;
    const totalValue = holdingsValue + cash;

    res.json({ fixes, portfolioValue: totalValue, holdingsCount: holdings.length });
  } catch (e) {
    res.status(500).json({ error: e.message, fixes: [] });
  }
});

// ─── Journal API (AI decision logging) ──────────────────────────────────────
// Structured decision log replacing /tmp/trade-journal-*.json
// Zero token cost. Queryable by dream cycle and daily report.

app.post('/api/journal', (req, res) => {
  try {
    const db = getDb();
    const { trade_id, symbol, decision, verdict_reason, signal_quality, confidence,
            planned_entry, planned_stop, planned_target, planned_shares,
            risk_amount, position_size_pct, news_risk, market_data_ref,
            compliance_passed, violation } = req.body;

    if (!trade_id || !symbol || !decision) {
      return res.status(400).json({ error: 'trade_id, symbol, decision required' });
    }

    db.prepare(`
      INSERT INTO journal (trade_id, symbol, decision, verdict_reason, signal_quality,
        confidence, planned_entry, planned_stop, planned_target, planned_shares,
        risk_amount, position_size_pct, news_risk, market_data_ref,
        compliance_passed, violation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(trade_id, symbol, decision, verdict_reason, signal_quality,
      confidence, planned_entry || null, planned_stop || null, planned_target || null,
      planned_shares || null, risk_amount || null, position_size_pct || null,
      news_risk || null, market_data_ref || null,
      compliance_passed !== undefined ? (compliance_passed ? 1 : 0) : 1,
      violation || null);

    res.json({ logged: true, trade_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/journal', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const symbol = req.query.symbol;
    
    let rows;
    if (symbol) {
      rows = db.prepare('SELECT * FROM journal WHERE symbol = ? ORDER BY id DESC LIMIT ?').all(symbol, limit);
    } else {
      rows = db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT ?').all(limit);
    }
    res.json({ entries: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/journal/stats', (req, res) => {
  try {
    const db = getDb();
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN decision = 'APPROVED' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN decision = 'CONDITIONAL' THEN 1 ELSE 0 END) as conditional,
        SUM(CASE WHEN decision = 'VETOED' THEN 1 ELSE 0 END) as vetoed,
        SUM(CASE WHEN compliance_passed = 0 THEN 1 ELSE 0 END) as violations,
        COUNT(DISTINCT symbol) as symbols
      FROM journal
    `).get();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Daily Self-Review ──────────────────────────────────────────────────────
// Analyzes trade history, adjusts strategy parameters, logs performance.
app.get('/api/review', (req, res) => {
  try {
    const db = getDb();
    const sellTrades = db.prepare("SELECT * FROM trades WHERE type = 'sell' AND created_at >= datetime('now', '-30 days') ORDER BY created_at").all();
    const wins = sellTrades.filter(t => t.pnl > 0);
    const losses = sellTrades.filter(t => t.pnl < 0);
    const totalTrades = sellTrades.length;
    const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnl), 0) / losses.length : 0;

    const bySymbol = {};
    for (const t of sellTrades) {
      bySymbol[t.symbol] = bySymbol[t.symbol] || { wins: 0, losses: 0, pnl: 0, count: 0 };
      bySymbol[t.symbol].pnl += (t.pnl || 0); bySymbol[t.symbol].count += 1;
      if (t.pnl > 0) bySymbol[t.symbol].wins += 1;
      if (t.pnl < 0) bySymbol[t.symbol].losses += 1;
    }
    let bestT = null, worstT = null, bestP = -Infinity, worstP = Infinity;
    for (const [sym, data] of Object.entries(bySymbol)) {
      if (data.pnl > bestP) { bestP = data.pnl; bestT = sym; }
      if (data.pnl < worstP) { worstP = data.pnl; worstT = sym; }
    }

    // ─── Calculate & APPLY parameter adjustments ────────────────────────────────
    let params = { stopMultiplier: 1.5, rsiOversold: 30, rsiOverbought: 70, minRewardRisk: 1.5, maxRiskPercent: 2.0 };
    const adjustments = [];

    if (totalTrades >= 5) {
      if (winRate < 0.4) {
        params.rsiOversold = 25; params.rsiOverbought = 75;
        params.stopMultiplier = 2.0;
        adjustments.push('Win rate ' + (winRate*100).toFixed(0) + '% — tightened RSI to 25/75, stop to 2.0x');
      } else if (winRate > 0.6) {
        params.rsiOversold = 35; params.rsiOverbought = 65;
        params.stopMultiplier = 1.2;
        adjustments.push('Win rate ' + (winRate*100).toFixed(0) + '% — loosened RSI to 35/65, stop to 1.2x');
      }
      if (avgLoss > 0 && avgWin > 0 && avgLoss > avgWin * 2) {
        params.stopMultiplier = 1.0;
        adjustments.push('Losses ' + (avgLoss/avgWin).toFixed(1) + 'x bigger than wins — forced stop to 1.0x');
      }
      params.minRewardRisk = winRate < 0.4 ? 2.0 : 1.5;
      params.maxRiskPercent = winRate < 0.4 ? 1.5 : 2.0;
    }

    // Write adjusted params to database
    db.prepare('UPDATE metrics SET params = ? WHERE id = 1').run(JSON.stringify(params));
    if (adjustments.length > 0) {
      console.log('[review] PARAMS UPDATED:', JSON.stringify(params));
    }

    res.json({
      period: '30d',
      totalTrades, wins: wins.length, losses: losses.length,
      winRate: Math.round(winRate * 1000) / 1000,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      totalPnl: Math.round(sellTrades.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100,
      bestTicker: bestT, bestPnl: Math.round(bestP * 100) / 100,
      worstTicker: worstT, worstPnl: Math.round(worstP * 100) / 100,
      adjustments,
      recommendations: totalTrades === 0
        ? ['No trades yet. Let the bot run 24h.']
        : winRate < 0.4 ? ['Cut losses faster', 'Add trend confirmation before entry']
        : winRate > 0.6 ? ['Strategy working. Scale up.']
        : ['Win rate acceptable. Monitor.'],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Daily Review Cron (24h loop) ───────────────────────────────────────────
setInterval(async () => {
  try {
    const httpRes = await fetch('http://127.0.0.1:5900/api/review');
    const data = await httpRes.json();
    console.log('[review] Daily review complete —', data.totalTrades, 'trades,', (data.winRate*100).toFixed(0) + '% win rate');
    if (data.adjustments.length > 0) {
      console.log('[review] Adjustments:', data.adjustments.join('; '));
    }
  } catch (e) {
    console.error('[review] error:', e.message);
  }
  // Also run regime classifier
  try {
    const { execSync } = await import('child_process');
    execSync('python3 /home/openclaw/scripts/regime-classifier.py', { timeout: 120000 });
    console.log('[review] Regime classifier complete');
  } catch (e) {
    console.error('[review] Regime classifier error:', e.message);
  }
}, 86400000); // 24 hours
