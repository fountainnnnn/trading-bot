#!/usr/bin/env python3
"""Fast backtest engine - processes tickers independently, supports daily and hourly data."""
import json, csv, os, sys, argparse, math
import numpy as np

# ─── Technical Indicators ───

def calc_rsi(prices, period=14):
    if len(prices) < period + 1: return 50.0
    changes = [prices[i] - prices[i-1] for i in range(1, len(prices))]
    gains = sum(max(c, 0) for c in changes[-period:]) / period
    losses = abs(sum(min(c, 0) for c in changes[-period:])) / period
    return 100.0 - (100.0 / (1.0 + gains / losses)) if losses else 100.0

def calc_sma(prices, period):
    return sum(prices[-period:]) / period if len(prices) >= period else prices[-1]

def calc_atr(highs, lows, closes, period=14):
    if len(highs) < period + 1: return None
    trs = []
    for i in range(1, min(len(highs), 50)):
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1])))
    return sum(trs[-period:]) / period if trs else None

def calc_position_size(entry, sl, account, params):
    rps = abs(entry - sl)
    max_risk = account * params['maxRiskPercent'] / 100
    frac = entry > 50
    raw = max_risk / rps if rps > 0 else 0
    sh = round(raw, 3) if frac else int(raw)
    return max(sh, 10 / entry if frac else 1)

# ─── Strategy ───

def evaluate(prices, highs, lows, price, pos, params, account):
    rsi = calc_rsi(prices)
    sma10 = calc_sma(prices, 10)
    sma30 = calc_sma(prices, 30)
    atr = calc_atr(highs, lows, prices)
    trend = 'bullish' if sma10 > sma30 else 'bearish'
    regime = 'oversold' if rsi < params['rsiOversold'] else ('overbought' if rsi > params['rsiOverbought'] else 'neutral')
    
    buy = None
    sell = None
    
    if not pos:
        if rsi < params['rsiOversold'] + 5 and regime == 'oversold':
            sl = price - (atr * 1.5 if atr else price * 0.04)
            tp = price + (atr * 3 if atr else price * 0.08)
            rr = (tp - price) / (price - sl)
            if rr >= params['minRewardRisk']:
                sh = calc_position_size(price, sl, account, params)
                buy = {'shares': sh, 'price': price, 'sl': round(sl, 4), 'tp': round(tp, 4)}
        if trend == 'bullish' and 40 <= rsi <= 55 and price <= sma10 * 1.02 and price >= sma10 * 0.97:
            sl = sma30 * 0.97
            tp = price + (price - sl) * 2.5
            rr = (tp - price) / (price - sl)
            if rr >= params['minRewardRisk']:
                sh = calc_position_size(price, sl, account, params)
                buy = {'shares': sh, 'price': price, 'sl': round(sl, 4), 'tp': round(tp, 4)}
    else:
        ep, shares = pos['entry'], pos['shares']
        pnl_pct = (price - ep) / ep * 100
        if rsi > params['rsiOverbought']:
            sell = {'price': price, 'reason': 'tp_rsi'}
        elif pnl_pct > 0:
            target = params['minRewardRisk'] * params['maxRiskPercent'] / 2
            if price >= ep * (1 + target / 100):
                sell = {'price': price, 'reason': 'target'}
        elif pnl_pct < 0:
            atr_v = atr or price * 0.02
            stop = max(abs(params['stopMultiplier'] * atr_v / price) * 100, params['maxRiskPercent'] / 4)
            if price <= ep * (1 - stop / 100):
                sell = {'price': price, 'reason': 'stop'}
    return buy, sell

def score_ticker(csv_path, params, initial_capital=10000, mode='all'):
    """Score a single ticker. mode='train' for year1, 'test' for year2, 'all' for both."""
    rows = []
    with open(csv_path) as f:
        for r in csv.DictReader(f):
            rows.append({
                'date': r['date'][:10], 'open': float(r['open']), 'high': float(r['high']),
                'low': float(r['low']), 'close': float(r['close']), 'volume': int(r['volume'])
            })
    # Filter by train/test split
    cutoff = '2024-05-01'
    if mode == 'train':
        rows = [r for r in rows if r['date'] < cutoff]
    elif mode == 'test':
        rows = [r for r in rows if r['date'] >= cutoff]
    
    cash = initial_capital
    pos = None
    trades = []
    equity = []
    max_val = initial_capital
    
    for i in range(20, len(rows)):
        hist = rows[:i+1]
        r = rows[i]
        price = r['close']
        
        prices = [h['close'] for h in hist]
        highs = [h['high'] for h in hist]
        lows = [h['low'] for h in hist]
        
        total = cash + (pos['shares'] * price if pos else 0)
        max_val = max(max_val, total)
        if i % 20 == 0:
            equity.append({'ts': r['date'], 'value': round(total, 2)})
        
        buy, sell = evaluate(prices, highs, lows, price, pos, params, total)
        
        if sell and pos:
            pnl = pos['shares'] * sell['price'] - pos['shares'] * pos['entry']
            cash += pos['shares'] * sell['price']
            trades.append({'type': 'sell', 'pnl': pnl, 'date': r['date']})
            pos = None
        elif buy and not pos and cash >= buy['shares'] * buy['price']:
            cost = buy['shares'] * buy['price']
            cash -= cost
            pos = {'shares': buy['shares'], 'entry': buy['price'], 'sl': buy['sl'], 'tp': buy['tp']}
            trades.append({'type': 'buy', 'date': r['date']})
    
    # Final value
    final = cash + (pos['shares'] * rows[-1]['close'] if pos else 0)
    ret = (final - initial_capital) / initial_capital
    
    # Metrics
    sells = [t for t in trades if t['type'] == 'sell']
    wins = sum(1 for t in sells if t['pnl'] > 0)
    losses = sum(1 for t in sells if t['pnl'] < 0)
    wr = wins / (wins + losses) if (wins + losses) > 0 else 0
    
    dd = 0
    peak = equity[0]['value'] if equity else final
    for e in equity:
        if e['value'] > peak: peak = e['value']
        dd = max(dd, (peak - e['value']) / peak)
    
    daily_ret = []
    for j in range(1, len(equity)):
        if equity[j-1]['value'] > 0:
            daily_ret.append(equity[j]['value'] / equity[j-1]['value'] - 1)
    sharpe = 0
    if daily_ret and np.std(daily_ret) > 0:
        sharpe = np.mean(daily_ret) / np.std(daily_ret) * np.sqrt(252)
    
    return {
        'return': ret, 'sharpe': sharpe, 'dd': dd, 'win_rate': wr,
        'total_trades': len(sells), 'wins': wins, 'losses': losses,
        'final': final, 'trades': len(trades), 'equity': equity,
    }

def multi_ticker_score(params, data_dir, mode='all', tickers=None):
    """Score across multiple tickers. mode='train'/'test'/'all'."""
    daily_dir = os.path.join(data_dir, 'daily')
    all_files = sorted([f for f in os.listdir(daily_dir) if f.endswith('.csv')])
    if tickers:
        all_files = [f for f in all_files if f.replace('.csv', '') in tickers]
    
    results = []
    
    for fname in all_files:
        symbol = fname.replace('.csv', '')
        csv_path = os.path.join(daily_dir, fname)
        
        # Quick check if this ticker has data in the right period
        with open(csv_path) as f:
            first = f.readline()
            # Just check the cutoff roughly
            pass
        
        s = score_ticker(csv_path, params, mode=mode)
        results.append(s)
    
    if not results:
        return {'fitness': 0, 'total_return': 0, 'sharpe': 0, 'max_drawdown': 0, 'win_rate': 0,
                'total_trades': 0, 'final_capital': 10000, 'equity_curve': []}
    
    # Aggregate: weighted average by ticker, total return as sum
    total_ret = sum(r['return'] for r in results) / len(results)
    avg_sharpe = sum(r['sharpe'] for r in results) / len(results)
    avg_dd = sum(r['dd'] for r in results) / len(results)
    avg_wr = sum(r['win_rate'] for r in results) / len(results)
    total_trades = sum(r['total_trades'] for r in results)
    
    # Fitness (same formula as genetic_search.py)
    fitness = (0.40 * max(0, avg_sharpe) / 3 + 0.25 * max(0, total_ret * 10) + 0.20 * (1 - avg_dd) + 0.15 * avg_wr) * 100
    
    return {
        'fitness': round(fitness, 2),
        'total_return': round(total_ret * 100, 2),
        'sharpe': round(avg_sharpe, 3),
        'max_drawdown': round(avg_dd * 100, 2),
        'win_rate': round(avg_wr, 3),
        'total_trades': total_trades,
        'final_capital': round(10000 * (1 + total_ret), 2),
        'equity_curve': results[0].get('equity', []) if results else [],
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--params', type=str, default='{}')
    parser.add_argument('--data-dir', type=str, default='./data')
    parser.add_argument('--output', type=str, default='./results')
    parser.add_argument('--tickers', type=str, default='')
    parser.add_argument('--train', action='store_true')
    parser.add_argument('--test', action='store_true')
    args = parser.parse_args()
    
    params = json.loads(args.params)
    defaults = {'rsiOversold': 30, 'rsiOverbought': 70, 'stopMultiplier': 1.5, 'minRewardRisk': 1.5, 'maxRiskPercent': 2.0}
    defaults.update(params)
    
    tickers = args.tickers.split(',') if args.tickers else None
    mode = 'train' if args.train else ('test' if args.test else 'all')
    result = multi_ticker_score(defaults, args.data_dir, mode=mode, tickers=tickers)
    print(json.dumps(result, indent=2))
