#!/usr/bin/env python3
"""Download historical market data from Yahoo Finance for training."""
import json, csv, os, time, sys
from datetime import datetime, timedelta

DATA_DIR = '/home/openclaw/projects/trading-bot/training/data'
os.makedirs(f'{DATA_DIR}/daily', exist_ok=True)
os.makedirs(f'{DATA_DIR}/hourly', exist_ok=True)

TICKERS = [
    '1155.KL','1023.KL','1295.KL','1066.KL','5819.KL','1015.KL',
    '5347.KL','6012.KL','4863.KL','1961.KL','2445.KL','5285.KL',
    '5398.KL','3336.KL','5211.KL','0166.KL','0128.KL','5292.KL',
    '3867.KL','0002.KL','4707.KL','3026.KL','3689.KL','4715.KL','3182.KL',
    'BTC-USD','ETH-USD','SOL-USD',
]

def fetch_yahoo(symbol, interval, range_param):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range_param}&interval={interval}'
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f'  Error {symbol}: {e}')
        return None

def extract_csv(data, interval_label):
    result = data.get('chart', {}).get('result', [None])[0]
    if not result:
        return None
    timestamps = result.get('timestamp', [])
    quotes = result.get('indicators', {}).get('quote', [{}])[0]
    if not timestamps or not quotes:
        return None
    rows = []
    for i, ts in enumerate(timestamps):
        o = quotes.get('open', [None])[i]
        h = quotes.get('high', [None])[i]
        l = quotes.get('low', [None])[i]
        c = quotes.get('close', [None])[i]
        v = quotes.get('volume', [None])[i]
        if c is not None and c > 0:
            dt = datetime.utcfromtimestamp(ts).strftime('%Y-%m-%d')
            if interval_label == 'hourly':
                dt = datetime.utcfromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')
            rows.append({
                'date': dt, 'open': round(o, 4) if o else 0,
                'high': round(h, 4) if h else 0, 'low': round(l, 4) if l else 0,
                'close': round(c, 4), 'volume': int(v) if v else 0
            })
    return rows

def save_csv(rows, filepath):
    if not rows:
        return False
    with open(filepath, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['date','open','high','low','close','volume'])
        w.writeheader()
        w.writerows(rows)
    return True

print('Downloading historical data for training...')
print(f'Tickers: {len(TICKERS)}')
print()

results = {}
for i, symbol in enumerate(TICKERS):
    print(f'[{i+1}/{len(TICKERS)}] {symbol}...')
    
    # Daily data (2 years)
    data = fetch_yahoo(symbol, '1d', '2y')
    if data:
        rows = extract_csv(data, 'daily')
        if rows:
            save_csv(rows, f'{DATA_DIR}/daily/{symbol}.csv')
            results[symbol] = {'daily_rows': len(rows), 'start': rows[0]['date'], 'end': rows[-1]['date']}
            print(f'  Daily: {len(rows)} rows ({rows[0]["date"]} to {rows[-1]["date"]})')
        else:
            print(f'  Daily: no data extracted')
    else:
        print(f'  Daily: failed')
    
    # Hourly data (1 year)
    time.sleep(0.5)
    data_h = fetch_yahoo(symbol, '60m', '1y')
    if data_h:
        rows_h = extract_csv(data_h, 'hourly')
        if rows_h:
            save_csv(rows_h, f'{DATA_DIR}/hourly/{symbol}.csv')
            if symbol in results:
                results[symbol]['hourly_rows'] = len(rows_h)
            print(f'  Hourly: {len(rows_h)} rows ({rows_h[0]["date"]} to {rows_h[-1]["date"]})')
        else:
            print(f'  Hourly: no data extracted')
    else:
        print(f'  Hourly: failed')
    
    time.sleep(1)  # rate limit
    
    # Split for metadata
    if symbol in results and results[symbol].get('daily_rows', 0) > 0:
        yr1_end = '2025-05-01'
        daily_path = f'{DATA_DIR}/daily/{symbol}.csv'
        with open(daily_path) as f:
            reader = csv.DictReader(f)
            all_rows = list(reader)
        yr1 = [r for r in all_rows if r['date'] < yr1_end]
        yr2 = [r for r in all_rows if r['date'] >= yr1_end]
        results[symbol]['train_rows'] = len(yr1)
        results[symbol]['test_rows'] = len(yr2)

# Write metadata
metadata = {
    'tickers': results,
    'total_tickers': len(TICKERS),
    'downloaded_at': datetime.utcnow().isoformat(),
    'data_dir': DATA_DIR,
    'train_period': '2024-05 to 2025-05',
    'test_period': '2025-05 to 2026-05',
}
with open(f'{DATA_DIR}/metadata.json', 'w') as f:
    json.dump(metadata, f, indent=2)

print()
print(f'Metadata written to {DATA_DIR}/metadata.json')
print(f'Successful: {len(results)}/{len(TICKERS)} tickers')

# Summary
success = sum(1 for v in results.values() if v.get('daily_rows', 0) > 0)
print(f'Daily data: {success}/{len(TICKERS)} tickers')
hourly_success = sum(1 for v in results.values() if v.get('hourly_rows', 0) > 0)
print(f'Hourly data: {hourly_success}/{len(TICKERS)} tickers')
