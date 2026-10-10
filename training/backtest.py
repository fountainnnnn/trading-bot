#!/usr/bin/env python3
"""Fast backtest engine - processes tickers independently on daily bars.

Trading costs are charged on every entry and exit:
  * slippage: the fill is moved against us by `slippage` (fraction of price):
    buys fill at close * (1 + slippage), sells at close * (1 - slippage).
  * commission: `commission` (fraction of traded notional) is paid on each side.
Both reduce cash, so they flow into return, Sharpe, drawdown and win rate.
Defaults can be overridden with --commission/--slippage or the
BACKTEST_COMMISSION / BACKTEST_SLIPPAGE environment variables.
"""
import json, csv, os, sys, argparse, math
import numpy as np

# Per-side defaults. 0.1% commission approximates retail Bursa brokerage plus
# clearing/stamp fees; 0.2% slippage is the midpoint of the live bot's 0.1-0.3%
# paper-fill model (server/strategy.js).
DEFAULT_COMMISSION = float(os.environ.get('BACKTEST_COMMISSION', 0.001))
DEFAULT_SLIPPAGE = float(os.environ.get('BACKTEST_SLIPPAGE', 0.002))
# Train/test split: rows before this date are "train" (year 1), the rest "test"
# (year 2). Matches the split recorded by fetch_data.py.
DEFAULT_SPLIT_DATE = os.environ.get('BACKTEST_SPLIT_DATE', '2025-05-01')

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

# ─── Trading costs ───

def buy_fill(price, slippage):
    return price * (1 + slippage)

def sell_fill(price, slippage):
    return price * (1 - slippage)

def entry_cash_needed(shares, price, commission, slippage):
    """Cash leaving the account to open a position (notional + commission)."""
    notional = shares * buy_fill(price, slippage)
    return notional + notional * commission

def exit_cash_received(shares, price, commission, slippage):
    """Cash returned when closing a position (notional - commission)."""
    notional = shares * sell_fill(price, slippage)
    return notional - notional * commission

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

def score_ticker(csv_path, params, initial_capital=10000, mode='all',
                 commission=DEFAULT_COMMISSION, slippage=DEFAULT_SLIPPAGE,
                 split_date=DEFAULT_SPLIT_DATE):
    """Score a single ticker. mode='train' for year1, 'test' for year2, 'all' for both."""
    rows = []
    with open(csv_path) as f:
        for r in csv.DictReader(f):
            rows.append({
                'date': r['date'][:10], 'open': float(r['open']), 'high': float(r['high']),
                'low': float(r['low']), 'close': float(r['close']), 'volume': int(r['volume'])
            })
    # Filter by train/test split
    if mode == 'train':
        rows = [r for r in rows if r['date'] < split_date]
    elif mode == 'test':
        rows = [r for r in rows if r['date'] >= split_date]
    
    cash = initial_capital
    pos = None
    trades = []
    equity = []        # sampled every 20 bars, for charts
    bar_values = []    # every bar, for Sharpe and drawdown
    max_val = initial_capital
    fees_paid = 0.0
    slippage_paid = 0.0
    
    for i in range(20, len(rows)):
        hist = rows[:i+1]
        r = rows[i]
        price = r['close']
        
        prices = [h['close'] for h in hist]
        highs = [h['high'] for h in hist]
        lows = [h['low'] for h in hist]
        
        total = cash + (pos['shares'] * price if pos else 0)
        max_val = max(max_val, total)
        bar_values.append(total)
        if i % 20 == 0:
            equity.append({'ts': r['date'], 'value': round(total, 2)})
        
        buy, sell = evaluate(prices, highs, lows, price, pos, params, total)
        
        if sell and pos:
            sh = pos['shares']
            received = exit_cash_received(sh, sell['price'], commission, slippage)
            fees_paid += sh * sell_fill(sell['price'], slippage) * commission
            slippage_paid += sh * sell['price'] * slippage
            pnl = received - pos['cost']   # net of both sides' costs
            cash += received
            trades.append({'type': 'sell', 'pnl': pnl, 'date': r['date']})
            pos = None
        elif buy and not pos:
            sh = buy['shares']
            needed = entry_cash_needed(sh, buy['price'], commission, slippage)
            if cash >= needed:
                fees_paid += sh * buy_fill(buy['price'], slippage) * commission
                slippage_paid += sh * buy['price'] * slippage
                cash -= needed
                pos = {'shares': sh, 'entry': buy_fill(buy['price'], slippage), 'cost': needed,
                       'sl': buy['sl'], 'tp': buy['tp']}
                trades.append({'type': 'buy', 'date': r['date']})
    
    # Final value: an open position is valued at what closing it would return,
    # i.e. after exit slippage and commission.
    if not rows:
        final = initial_capital
    elif pos:
        final = cash + exit_cash_received(pos['shares'], rows[-1]['close'], commission, slippage)
    else:
        final = cash
    if bar_values:
        bar_values[-1] = final
    ret = (final - initial_capital) / initial_capital
    
    # Metrics
    sells = [t for t in trades if t['type'] == 'sell']
    wins = sum(1 for t in sells if t['pnl'] > 0)
    losses = sum(1 for t in sells if t['pnl'] < 0)
    wr = wins / (wins + losses) if (wins + losses) > 0 else 0
    
    # Drawdown and Sharpe use every bar (daily data -> annualise with sqrt(252)).
    dd = 0
    peak = initial_capital
    for v in bar_values:
        if v > peak: peak = v
        dd = max(dd, (peak - v) / peak)
    
    daily_ret = []
    prev = initial_capital
    for v in bar_values:
        if prev > 0:
            daily_ret.append(v / prev - 1)
        prev = v
    sharpe = 0
    if daily_ret and np.std(daily_ret) > 0:
        sharpe = float(np.mean(daily_ret) / np.std(daily_ret) * np.sqrt(252))
    
    return {
        'return': ret, 'sharpe': sharpe, 'dd': dd, 'win_rate': wr,
        'total_trades': len(sells), 'wins': wins, 'losses': losses,
        'final': final, 'trades': len(trades), 'equity': equity,
        'fees': fees_paid, 'slippage': slippage_paid,
    }

def multi_ticker_score(params, data_dir, mode='all', tickers=None,
                       commission=DEFAULT_COMMISSION, slippage=DEFAULT_SLIPPAGE,
                       split_date=DEFAULT_SPLIT_DATE):
    """Score across multiple tickers. mode='train'/'test'/'all'."""
    daily_dir = os.path.join(data_dir, 'daily')
    all_files = sorted([f for f in os.listdir(daily_dir) if f.endswith('.csv')])
    if tickers:
        all_files = [f for f in all_files if f.replace('.csv', '') in tickers]
    
    results = []
    
    for fname in all_files:
        symbol = fname.replace('.csv', '')
        csv_path = os.path.join(daily_dir, fname)
        s = score_ticker(csv_path, params, mode=mode, commission=commission,
                         slippage=slippage, split_date=split_date)
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
        'total_fees': round(sum(r['fees'] for r in results), 2),
        'total_slippage': round(sum(r['slippage'] for r in results), 2),
        'costs': {'commission': commission, 'slippage': slippage},
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
    parser.add_argument('--commission', type=float, default=DEFAULT_COMMISSION,
                        help='commission per side, fraction of notional (0.001 = 0.1%%)')
    parser.add_argument('--slippage', type=float, default=DEFAULT_SLIPPAGE,
                        help='slippage per side, fraction of price (0.002 = 0.2%%)')
    parser.add_argument('--split-date', type=str, default=DEFAULT_SPLIT_DATE,
                        help='first date of the test period (YYYY-MM-DD)')
    args = parser.parse_args()
    
    params = json.loads(args.params)
    defaults = {'rsiOversold': 30, 'rsiOverbought': 70, 'stopMultiplier': 1.5, 'minRewardRisk': 1.5, 'maxRiskPercent': 2.0}
    defaults.update(params)
    
    tickers = args.tickers.split(',') if args.tickers else None
    mode = 'train' if args.train else ('test' if args.test else 'all')
    result = multi_ticker_score(defaults, args.data_dir, mode=mode, tickers=tickers,
                                commission=args.commission, slippage=args.slippage,
                                split_date=args.split_date)
    print(json.dumps(result, indent=2))
