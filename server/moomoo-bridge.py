#!/usr/bin/env python3
"""Moomoo HTTP Bridge -- Provides real-time Bursa Malaysia quotes via moomoo API.

Runs as a local HTTP server (port 5902). The trading bot (Node.js on port 5900)
calls this bridge for Bursa stock data instead of Yahoo Finance.

Usage:
  python3 moomoo-bridge.py

Endpoints:
  GET /quote/MY.1155  -- Real-time quote for a Bursa stock
  GET /history/MY.1155?days=7 -- Historical data
  GET /health        -- Bridge health
"""

import json
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from moomoo import OpenQuoteContext, RET_OK

OPEND_HOST = '127.0.0.1'
OPEND_PORT = 11111
BRIDGE_PORT = 5902

# Bursa symbol mapping: Yahoo ".KL" format -> Moomoo "MY." format
def to_moomoo_symbol(symbol):
    """Convert Yahoo-style symbol (1155.KL) to Moomoo format (MY.1155)"""
    if symbol.endswith('.KL'):
        code = symbol.replace('.KL', '')
        return f'MY.{code}'
    return symbol

def to_klse_symbol(symbol):
    """Convert Moomoo format (MY.1155) back to Yahoo-style (1155.KL)"""
    if symbol.startswith('MY.'):
        code = symbol.replace('MY.', '')
        return f'{code}.KL'
    return symbol

class BridgeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        ctx = None
        try:
            path = self.path.split('?')[0]
            
            if path == '/health':
                self._json(200, {'status': 'ok'})
                return
            
            if path.startswith('/quote/'):
                symbol = path.replace('/quote/', '')
                if not symbol:
                    self._json(400, {'error': 'Missing symbol'})
                    return
                
                ctx = OpenQuoteContext(host=OPEND_HOST, port=OPEND_PORT)
                ret, data = ctx.get_market_snapshot([symbol])
                if ret != RET_OK or data is None or len(data) == 0:
                    self._json(500, {'error': f'Failed to get quote for {symbol}', 'ret': ret})
                    return
                
                row = data.iloc[0]
                quote = {
                    'symbol': symbol,
                    'price': round(float(row.get('lastPrice', 0)), 2),
                    'open': round(float(row.get('openPrice', 0)), 2),
                    'high': round(float(row.get('highPrice', 0)), 2),
                    'low': round(float(row.get('lowPrice', 0)), 2),
                    'prevClose': round(float(row.get('prevClosePrice', 0)), 2),
                    'volume': int(row.get('volume', 0)),
                    'change': round(float(row.get('changeVal', 0)), 2),
                    'changePercent': round(float(row.get('changeRate', 0)) * 100, 2),
                    'timestamp': row.get('updateTime', ''),
                    'source': 'moomoo',
                }
                self._json(200, quote)
                return
            
            if path.startswith('/history/'):
                symbol = path.replace('/history/', '')
                days = int(self._get_param('days', '7'))
                if not symbol:
                    self._json(400, {'error': 'Missing symbol'})
                    return
                
                ctx = OpenQuoteContext(host=OPEND_HOST, port=OPEND_PORT)
                # Map days to request type
                req_type = 2  # Qot_KLType.kKLineDay
                if days <= 1:
                    req_type = 1  # kKLine1Min
                elif days <= 5:
                    req_type = 5  # kKLine60Min
                
                ret, data = ctx.get_history_kl(symbol, start=None, end=None, ktype=req_type, autype=0, max_count=min(days * 80, 1000))
                if ret != RET_OK or data is None:
                    self._json(500, {'error': f'Failed to get history for {symbol}'})
                    return
                
                history = []
                for _, row in data.iterrows():
                    history.append({
                        'date': row.get('time', ''),
                        'open': round(float(row.get('open', 0)), 2),
                        'high': round(float(row.get('high', 0)), 2),
                        'low': round(float(row.get('low', 0)), 2),
                        'close': round(float(row.get('close', 0)), 2),
                        'volume': int(row.get('volume', 0)),
                    })
                
                self._json(200, {'symbol': symbol, 'history': history})
                return
            
            self._json(404, {'error': 'Not found'})
            
        except Exception as e:
            self._json(500, {'error': str(e)})
        finally:
            if ctx:
                try:
                    ctx.close()
                except:
                    pass
    
    def _get_param(self, name, default=None):
        import urllib.parse
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        return params.get(name, [default])[0]
    
    def _json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def log_message(self, format, *args):
        print(f'[moomoo-bridge] {args[0]} {args[1]} {args[2]}', file=sys.stderr)


if __name__ == '__main__':
    print(f'[moomoo-bridge] Starting on port {BRIDGE_PORT}...')
    print(f'[moomoo-bridge] Connecting to OpenD at {OPEND_HOST}:{OPEND_PORT}')
    server = HTTPServer(('127.0.0.1', BRIDGE_PORT), BridgeHandler)
    print(f'[moomoo-bridge] Ready. Quotes at http://127.0.0.1:{BRIDGE_PORT}/quote/MY.1155')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[moomoo-bridge] Shutting down')
        server.server_close()
