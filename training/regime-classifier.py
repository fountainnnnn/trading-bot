#!/usr/bin/env python3
"""Regime classifier with performance feedback loop.
Classifies each ticker's market regime + adjusts thresholds based on P&L per regime."""

import sqlite3, json, urllib.request, statistics, math
from datetime import datetime, timedelta

DB_PATH = '/home/openclaw/projects/trading-bot/data/trading.db'
YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'

# Baseline thresholds per regime (will be adjusted by performance feedback)
REGIME_THRESHOLDS = {
    'trending_up':   {'rsiOversold': 40, 'rsiOverbought': 70, 'stopMultiplier': 1.5, 'minRewardRisk': 1.5, 'maxRiskPercent': 2.5},
    'trending_down': {'rsiOversold': 25, 'rsiOverbought': 60, 'stopMultiplier': 1.0, 'minRewardRisk': 2.0, 'maxRiskPercent': 1.5},
    'volatile':      {'rsiOversold': 30, 'rsiOverbought': 70, 'stopMultiplier': 1.8, 'minRewardRisk': 2.0, 'maxRiskPercent': 1.5},
    'ranging':       {'rsiOversold': 35, 'rsiOverbought': 65, 'stopMultiplier': 1.2, 'minRewardRisk': 1.5, 'maxRiskPercent': 2.0},
}

TICKER_IDS = [
    '1155.KL','1023.KL','1295.KL','1066.KL','5819.KL','1015.KL',
    '5347.KL','6012.KL','4863.KL','1961.KL','2445.KL','5285.KL',
    '5398.KL','3336.KL','5211.KL','0166.KL','0128.KL','5292.KL',
    '3867.KL','0002.KL','4707.KL','3026.KL','3689.KL','4715.KL','3182.KL',
    'BTC-USD','ETH-USD','SOL-USD',
]

def fetch_history(symbol):
    url = f"{YAHOO_BASE}/{symbol}?range=2mo&interval=1d"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            quotes = data['chart']['result'][0]
            closes = quotes['indicators']['quote'][0]
            timestamps = quotes['timestamp']
            prices = []
            for i in range(len(timestamps)):
                close = closes['close'][i]
                high = closes['high'][i]
                low = closes['low'][i]
                if close and high and low and not math.isnan(close):
                    prices.append({'close': close, 'high': high, 'low': low, 'date': timestamps[i]})
            return prices
    except:
        return None

def classify_regime(prices):
    if not prices or len(prices) < 30:
        return 'ranging', 0
    closes = [p['close'] for p in prices]
    highs = [p['high'] for p in prices]
    lows = [p['low'] for p in prices]
    sma10 = statistics.mean(closes[-10:])
    sma30 = statistics.mean(closes[-30:])
    trend_strength = (sma10 - sma30) / sma30 * 100
    returns = [(closes[i] - closes[i-1]) / closes[i-1] for i in range(1, len(closes))]
    daily_vol = statistics.stdev(returns) if len(returns) > 1 else 0
    annual_vol = daily_vol * math.sqrt(252) * 100
    trs = []
    for i in range(1, min(len(highs), 30)):
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
        trs.append(tr)
    atr_pct = (statistics.mean(trs) / closes[-1] * 100) if trs else 0
    is_volatile = annual_vol > 40 or atr_pct > 5
    if is_volatile:
        return 'volatile', annual_vol
    elif trend_strength > 2:
        return 'trending_up', trend_strength
    elif trend_strength < -2:
        return 'trending_down', abs(trend_strength)
    else:
        return 'ranging', abs(closes[-1] - sma30) / sma30 * 100

def apply_performance_feedback(base_params, regime, db):
    """Adjust regime thresholds based on actual P&L performance of trades in this regime."""
    params = dict(base_params)
    
    # Get closed trades that were active during this regime
    # Tag trades as belonging to a regime based on their created_at date
    # For simplicity, we check if trades tagged with this regime exist and their net P&L
    try:
        # Count trades made while each regime was active
        regimes_data = db.execute("SELECT * FROM regime_performance WHERE regime = ?", (regime,)).fetchone()
        if regimes_data:
            trades_count = regimes_data[2]  # trades column
            net_pnl = regimes_data[3]        # net_pnl column
            
            if trades_count >= 5:
                # Calculate win rate for this regime
                wins = regimes_data[4]
                loss_count = trades_count - wins
                win_rate = wins / trades_count if trades_count > 0 else 0
                
                adj = []
                if win_rate < 0.35:
                    # Bad performance: tighten everything
                    params['rsiOversold'] = max(params['rsiOversold'] - 5, 20)
                    params['rsiOverbought'] = min(params['rsiOverbought'] + 5, 75)
                    params['stopMultiplier'] = min(params['stopMultiplier'] * 1.3, 2.5)
                    params['maxRiskPercent'] = max(params['maxRiskPercent'] * 0.8, 1.0)
                    adj.append(f"win rate {win_rate:.0%} → tightened")
                elif win_rate > 0.60 and net_pnl > 0:
                    # Good performance: loosen slightly
                    params['rsiOversold'] = min(params['rsiOversold'] + 3, 45)
                    params['rsiOverbought'] = max(params['rsiOverbought'] - 3, 55)
                    params['maxRiskPercent'] = min(params['maxRiskPercent'] * 1.1, 3.0)
                    adj.append(f"win rate {win_rate:.0%} +RM{net_pnl:.0f} → loosened")
                
                if adj:
                    print(f"  [feedback] {regime}: {'; '.join(adj)}")
    except:
        pass  # No feedback data yet
    
    return params

def main():
    print("[regime] Classifying market regimes with performance feedback...")
    
    db = sqlite3.connect(DB_PATH)
    c = db.cursor()
    
    # Ensure regime_performance table exists
    c.execute("""
        CREATE TABLE IF NOT EXISTS regime_performance (
            regime TEXT PRIMARY KEY,
            trades INTEGER DEFAULT 0,
            net_pnl REAL DEFAULT 0,
            wins INTEGER DEFAULT 0,
            last_updated TEXT
        )
    """)
    
    # Update regime_performance from closed trades
    # For each sell trade, estimate which regime it belonged to based on its created_at
    # Since we can't retroactively classify, we update incrementally
    c.execute("""
        UPDATE regime_performance SET
            trades = (SELECT COUNT(*) FROM trades WHERE type = 'sell'),
            net_pnl = (SELECT COALESCE(SUM(pnl), 0) FROM trades WHERE type = 'sell'),
            wins = (SELECT COUNT(*) FROM trades WHERE type = 'sell' AND pnl > 0),
            last_updated = datetime('now')
    """)
    
    # Classify each ticker
    all_params = {}
    overall_regimes = {}
    regime_counts = {}

    for sym in TICKER_IDS:
        prices = fetch_history(sym)
        regime, strength = classify_regime(prices)
        regime_counts[regime] = regime_counts.get(regime, 0) + 1
        base = REGIME_THRESHOLDS[regime]
        adjusted = apply_performance_feedback(base, regime, c)
        all_params[sym] = adjusted
        overall_regimes[sym] = {'regime': regime, 'strength': round(strength, 1)}
        print(f"  {sym:>12}: {regime:15} ({strength:.1f}) -> RSI {adjusted['rsiOversold']}/{adjusted['rsiOverbought']}")

    overall_regime = max(regime_counts, key=regime_counts.get)
    print(f"\n[regime] Overall: {overall_regime} ({regime_counts})")
    
    # Check if there's performance feedback
    perf = c.execute("SELECT * FROM regime_performance").fetchall()
    for p in perf:
        print(f"  [feedback] {p[0]}: {p[1]} trades, RM{p[2]:.2f} net, {p[3]} wins")

    # Write to DB
    payload = json.dumps({
        'overallRegime': overall_regime,
        'tickers': all_params,
        'regimes': overall_regimes,
        'updatedAt': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S'),
    })
    c.execute('UPDATE metrics SET params = ? WHERE id = 1', (payload,))
    db.commit()
    db.close()

    print(f"\n[regime] Done. {len(all_params)} tickers classified.")
    return overall_regime

if __name__ == '__main__':
    main()
