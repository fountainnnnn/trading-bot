#!/usr/bin/env python3
"""Fetch 2 years of hourly data for all tickers."""
import json, csv, os, time, urllib.request
from datetime import datetime

# Defaults to training/data/hourly2; override the data root with TRAINING_DATA_DIR.
DATA_DIR = os.path.join(
    os.environ.get('TRAINING_DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')),
    'hourly2')
os.makedirs(DATA_DIR, exist_ok=True)

TICKERS = [
    '1155.KL','1023.KL','1295.KL','1066.KL','5819.KL','1015.KL',
    '5347.KL','6012.KL','4863.KL','1961.KL','2445.KL','5285.KL',
    '5398.KL','3336.KL','5211.KL','0166.KL','0128.KL','5292.KL',
    '3867.KL','0002.KL','4707.KL','3026.KL','3689.KL','4715.KL','3182.KL',
    'BTC-USD','ETH-USD','SOL-USD',
]

for i, symbol in enumerate(TICKERS):
    print(f'[{i+1}/{len(TICKERS)}] {symbol}...', end=' ', flush=True)
    try:
        url = f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=2y&interval=60m'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        
        result = data.get('chart', {}).get('result', [None])[0]
        if not result:
            print('no result')
            continue
        
        timestamps = result.get('timestamp', [])
        quotes = result.get('indicators', {}).get('quote', [{}])[0]
        if not timestamps or not quotes:
            print('no data')
            continue
        
        rows = []
        for idx, ts in enumerate(timestamps):
            c = quotes.get('close', [None])[idx]
            if c and c > 0:
                dt = datetime.utcfromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')
                rows.append({
                    'date': dt, 'open': round(quotes.get('open', [None])[idx] or 0, 4),
                    'high': round(quotes.get('high', [None])[idx] or 0, 4),
                    'low': round(quotes.get('low', [None])[idx] or 0, 4),
                    'close': round(c, 4),
                    'volume': int(quotes.get('volume', [None])[idx] or 0)
                })
        
        with open(f'{DATA_DIR}/{symbol}.csv', 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=['date','open','high','low','close','volume'])
            w.writeheader()
            w.writerows(rows)
        
        print(f'{len(rows)} rows ({rows[0]["date"]} to {rows[-1]["date"]})')
    except Exception as e:
        print(f'error: {e}')
    time.sleep(1.2)

print(f'\nDone. Files in {DATA_DIR}')
