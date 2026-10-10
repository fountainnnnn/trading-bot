#!/usr/bin/env python3
"""Training Dashboard -- Profit over generations only."""
import json, os, http.server

BASE = os.path.dirname(os.path.abspath(__file__))
PORT = 5903

def load_json(path):
    try:
        with open(os.path.join(BASE, path)) as f:
            return json.load(f)
    except:
        return None

def get_status():
    lb = load_json('results/leaderboard.json') or {}
    gens = lb.get('generations', [])
    
    gen_nums = []
    gen_best_return = []
    gen_avg_return = []
    
    for g in gens:
        if not g: continue
        returns = [e.get('result', {}).get('total_return', 0) for e in g if e.get('result')]
        if not returns: continue
        gen_nums.append(g[0]['generation'])
        gen_best_return.append(max(returns))
        gen_avg_return.append(round(sum(returns) / len(returns), 2))
    
    # Best overall from leaderboard
    best_entry = None
    for e in lb.get('leaderboard', []):
        r = e.get('result', {})
        ret = r.get('total_return', 0)
        if ret and (best_entry is None or ret > best_entry['return']):
            best_entry = {'gen': e.get('generation'), 'return': ret, 'sharpe': r.get('sharpe'), 'dd': r.get('max_drawdown')}
    
    return {
        'gen_nums': gen_nums,
        'gen_best_return': gen_best_return,
        'gen_avg_return': gen_avg_return,
        'best': best_entry,
        'gen_count': len(gen_nums),
        'candidate_count': len(lb.get('leaderboard', [])),
        'search_active': True,
    }

HTML = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Training Dashboard</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#FAFAF8;color:#1A1A1A;font-family:Inter,sans-serif;padding:28px 32px}
h1{font-size:20px;font-weight:600;letter-spacing:-0.3px;margin-bottom:2px}
.sub{font-size:13px;color:#8C8C8C;margin-bottom:20px}
.card{background:rgba(255,255,255,0.72);border:1px solid rgba(0,0,0,0.06);border-radius:10px;padding:14px;backdrop-filter:blur(8px)}
.card .lbl{font-size:10px;color:#B0B0B0;font-family:JetBrains Mono,monospace;text-transform:uppercase;margin-bottom:2px}
.card .val{font-size:24px;font-weight:600}
.card .sub{font-size:10px;color:#8C8C8C;font-family:JetBrains Mono,monospace;margin-top:2px}
.top{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.chart{background:rgba(255,255,255,0.72);border:1px solid rgba(0,0,0,0.06);border-radius:12px;padding:16px;backdrop-filter:blur(8px);margin-bottom:16px}
.chart .h{font-size:11px;font-weight:600;text-transform:uppercase;color:#8C8C8C;margin-bottom:8px}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#07CA6B;margin-right:6px}
</style>
</head>
<body>
<div style="display:flex;justify-content:space-between;margin-bottom:2px">
  <h1>Training Dashboard</h1>
  <div><span class="dot"></span><span id="st" style="font-size:11px;color:#8C8C8C;font-family:JetBrains Mono">Searching...</span></div>
</div>
<div class="sub">Profit over generations &middot; 28 tickers &middot; 2yr hourly data</div>

<div class="top" id="kpis"></div>

<div class="chart">
  <div class="h">Best Return % per Generation</div>
  <div id="chart" style="height:320px"></div>
</div>
<div id="log-area"></div>

<script>
function render(d){
  document.getElementById('st').textContent=d.gen_count+' gens';
  
  var b=d.best;
  document.getElementById('kpis').innerHTML=
    '<div class=card><div class=lbl>Best Return</div><div class=val style=color:#1856FF>'+(b&&typeof b.return=='number'?b.return.toFixed(2):'?')+'%</div><div class=sub>Gen '+(b?b.gen:'?')+'</div></div>'+
    '<div class=card><div class=lbl>Sharpe</div><div class=val>'+(b&&typeof b.sharpe=='number'?b.sharpe.toFixed(2):'?')+'</div><div class=sub>Best gen</div></div>'+
    '<div class=card><div class=lbl>Drawdown</div><div class=val style=color:#EA2143>'+(b&&typeof b.dd=='number'?b.dd.toFixed(2):'?')+'%</div><div class=sub>Best gen</div></div>';
  
  if(d.gen_nums&&d.gen_nums.length>1){
    Plotly.newPlot('chart',[
      {x:d.gen_nums,y:d.gen_best_return,name:'Best',type:'scatter',mode:'lines+markers',line:{color:'#1856FF',width:2},marker:{size:6}},
      {x:d.gen_nums,y:d.gen_avg_return,name:'Avg',type:'scatter',mode:'lines',line:{color:'rgba(24,86,255,0.3)',width:1,dash:'dot'}}
    ],{
      margin:{t:4,r:4,b:28,l:48},
      paper_bgcolor:'transparent',plot_bgcolor:'transparent',
      xaxis:{title:'Generation',tickfont:{size:10,color:'#B0B0B0'},gridcolor:'rgba(0,0,0,0.04)'},
      yaxis:{title:'Return %',tickfont:{size:10,color:'#B0B0B0'},gridcolor:'rgba(0,0,0,0.04)'},
      legend:{font:{size:10,color:'#8C8C8C'},orientation:'h',y:1.05},
      hovermode:'x unified'
    });
  }
}
fetch('/api/status').then(r=>r.json()).then(render).catch(()=>{});
setInterval(()=>{fetch('/api/status').then(r=>r.json()).then(render).catch(()=>{})},5000);

</script>
</body>
</html>'''

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(get_status()).encode())
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(HTML.encode())
    def log_message(self, *a): pass

if __name__ == '__main__':
    print(f'[dash] http://127.0.0.1:{PORT}')
    http.server.HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
