import { useEffect, useState, useCallback, useRef } from 'react';
// Plotly loaded from CDN via index.html script tag
declare const Plotly: any;

const BASE = '/api';
async function fetchJSON(url, opts) {
  const res = await fetch(`${BASE}${url}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
  return res.json();
}

const green = '#22C55E', red = '#EF4444', muted = '#5C5C72', text = '#E8E8ED';
function fmt(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPct(n) { return `${(Number(n || 0) >= 0 ? '+' : '')}${Number(n || 0).toFixed(2)}%`; }

function Card({ label, value, color = text, sub }) {
  return (
    <div className="glass" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PriceChart({ data, symbol }) {
  const elRef = useRef(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !data || data.length < 2) return;
    const cutoff72h = Date.now() - 72 * 60 * 60 * 1000;
    const sliced = data.filter(d => new Date(d.date).getTime() >= cutoff72h);
    const plotData = sliced.length >= 2 ? sliced : data;
    const prices = plotData.map(d => d.price);
    const dates = plotData.map(d => d.date);
    const yMin = Math.min(...prices);
    const yMax = Math.max(...prices);
    const yPad = Math.max((yMax - yMin) * 0.08, 1);
    const chg = prices[prices.length - 1] - prices[0];
    const lineColor = chg >= 0 ? '#22C55E' : '#EF4444';

    Plotly.newPlot(el, [{
      x: dates,
      y: prices,
      type: 'scatter',
      mode: 'lines',
      line: { color: lineColor, width: 2 },
      fill: 'tozeroy',
      fillcolor: chg >= 0 ? 'rgba(34,197,94,0.03)' : 'rgba(239,68,68,0.03)',
      hoverlabel: { bgcolor: '#2a2a3a', font: { family: 'JetBrains Mono', size: 12, color: '#F0F0F5' }, bordercolor: '#3a3a4a' },
    }], {
      margin: { t: 4, r: 4, b: 24, l: 44 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      xaxis: {
        showgrid: false,
        zeroline: false,
        tickfont: { family: 'JetBrains Mono', size: 9, color: '#5C5C72' },
        showspikes: false,
      },
      yaxis: {
        showgrid: true,
        gridcolor: '#2a2a3a',
        zeroline: false,
        tickfont: { family: 'JetBrains Mono', size: 9, color: '#5C5C72' },
        tickprefix: 'RM',
        range: [yMin - yPad, yMax + yPad],
        showspikes: false,
      },
      hovermode: 'closest',
      dragmode: false,
      modebar: { remove: ['autoScale2d', 'resetScale2d', 'zoom2d', 'pan2d', 'select2d', 'lasso2d', 'zoomIn2d', 'zoomOut2d', 'toggleSpikelines'], bgcolor: 'transparent', color: '#5C5C72' },
    }, { responsive: true, displayModeBar: false });

    return () => { try { Plotly.purge(el); } catch(e) {} };
  }, [data]);

  if (!data || data.length < 2) return <div style={{ padding: 40, textAlign: 'center', color: muted, fontSize: 13 }}>Not enough data</div>;

  const cutoff72h = Date.now() - 72 * 60 * 60 * 1000;
  const sliced = data.filter(d => new Date(d.date).getTime() >= cutoff72h);
  const show = sliced.length >= 2 ? sliced : data;
  const first = show[0];
  const last = show[show.length - 1];
  const chg = last.price - first.price;
  return (
    <div>
      <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', marginBottom: 4 }}>
        {symbol} 3d &middot; RM{fmt(last.price)}
        <span style={{ color: chg >= 0 ? green : red, marginLeft: 6 }}>
          {fmtPct(chg / first.price * 100)}
        </span>
      </div>
      <div ref={elRef} style={{ width: '100%', height: 220 }} />
    </div>
  );
}

export default function Dashboard() {
  const [portfolio, setPortfolio] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [topHistory, setTopHistory] = useState(null);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, q, t] = await Promise.all([
        fetchJSON('/portfolio'),
        fetchJSON('/market/snapshot'),
        fetchJSON('/trades'),
      ]);
      setPortfolio(p);
      setQuotes(q.tickers || q.quotes || []);
      setTrades(t.trades || t || []);
    } catch (e) { /* retry on next refresh */ }
    // Load top performer chart separately
    try {
      const th = await fetchJSON('/market/top-history');
      if (th.symbol) setTopHistory(th);
    } catch (e) {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000); // 30s refresh
    return () => clearInterval(interval);
  }, [load]);

  if (loading) return (
    <div style={{ padding: 24, background: '#0F0F17', minHeight: '100vh', color: text }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>TRADING BOT</div>
      <div style={{ color: muted, fontSize: 12, marginBottom: 24 }}>Loading...</div>
    </div>
  );

  const pnlColor = portfolio?.realized_pnl >= 0 ? green : red;
  const totalTrades = portfolio?.totalTrades || 0;
  const wins = portfolio?.wins || 0;
  const losses = portfolio?.losses || 0;

  return (
    <div style={{ padding: 24, background: '#0F0F17', minHeight: '100vh', color: text }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>TRADING BOT</div>
          <div style={{ color: muted, fontSize: 12 }}>Auto-refresh every 30s &middot; {portfolio?.holdings?.length || 0} holdings</div>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
        <Card label="Total Portfolio" value={`RM${fmt(portfolio?.totalValue || 0)}`} color={text}
          sub={`RM${fmt(portfolio?.marketValue || 0)} in holdings + RM${fmt(portfolio?.cash || 0)} cash`} />
        <Card label="Cash" value={`RM${fmt(portfolio?.cash || 0)}`} color={text}
          sub={`${portfolio?.holdings?.length || 0} holdings`} />
        <Card label="Realized P&L" value={`RM${fmt(Math.abs(portfolio?.realized_pnl || 0))}`} color={pnlColor} />
        <Card label="This Month" value={`RM${fmt(Math.abs(portfolio?.monthly_pnl || 0))}`} color={portfolio?.monthly_pnl >= 0 ? green : red}
          sub={fmtPct(portfolio?.monthly_pnl / portfolio?.initialBalance * 100 || 0)} />
        <Card label="Unrealized P&L" value={`${portfolio?.unrealized_pnl >= 0 ? '+' : ''}RM${fmt(Math.abs(portfolio?.unrealized_pnl || 0))}`} color={portfolio?.unrealized_pnl >= 0 ? green : red}
          sub={`${portfolio?.unrealized_pnl >= 0 ? '+' : ''}${Number(portfolio?.pnlPercent || 0).toFixed(2)}%`} />
        <Card label="Win Rate" value={totalTrades > 0 ? `${(portfolio.winRate * 100).toFixed(0)}%` : '--'} color={text}
          sub={`${wins}W / ${losses}L`} />
        <Card label="Trades" value={totalTrades} color={text} />
        <Card label="Initial" value={`RM${fmt(portfolio?.initialBalance || 10000)}`} color={muted} />
      </div>

      {/* Holdings + Recent Trades */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        {/* Holdings */}
        <div className="glass" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', marginBottom: 8 }}>Holdings ({portfolio?.holdings?.length || 0})</div>
          {(!portfolio?.holdings || portfolio.holdings.length === 0) ? (
            <div style={{ padding: 20, textAlign: 'center', color: muted, fontSize: 13 }}>No open positions</div>
          ) : (
            <div style={{ maxHeight: 220, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead><tr style={{ color: muted }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Sym</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Shares</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Avg</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Price</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Change</th>
                </tr></thead>
                <tbody>
                  {portfolio.holdings.map(h => {
                    const pnlC = h.unrealized_pnl >= 0 ? green : red;
                    return (
                      <tr key={h.symbol} style={{ borderTop: '1px solid #1a1a2a' }}>
                        <td style={{ padding: '6px', fontWeight: 600 }}>{h.symbol}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>{h.shares}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>RM{fmt(h.avg_cost)}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>RM{fmt(h.current_price)}</td>
                        <td style={{ padding: '6px', textAlign: 'right', fontWeight: 600, color: pnlC, whiteSpace: 'nowrap' }}>
                          <div>{h.unrealized_pnl >= 0 ? '+' : ''}RM{fmt(Math.abs(h.unrealized_pnl))}</div>
                          <div style={{ fontSize: 10, color: pnlC, opacity: 0.7 }}>{h.unrealized_pnl >= 0 ? '+' : ''}{Number(h.unrealized_pnl_pct || 0).toFixed(2)}%</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent Trades */}
        <div className="glass" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', marginBottom: 8 }}>Recent Trades ({trades.length})</div>
          {trades.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: muted, fontSize: 13 }}>No trades yet</div>
          ) : (
            <div style={{ maxHeight: 220, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead><tr style={{ color: muted }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Sym</th>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Type</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Shares</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Price</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Total</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>P&L</th>
                </tr></thead>
                <tbody>
                  {trades.slice(-15).reverse().map((t, i) => {
                    const bg = t.type === 'buy' ? 'rgba(34,197,94,0.05)' : t.type === 'sell' && t.pnl && t.pnl < 0 ? 'rgba(239,68,68,0.05)' : 'transparent';
                    return (
                      <tr key={t.id || i} style={{ borderTop: '1px solid #1a1a2a', background: bg }}>
                        <td style={{ padding: '6px', fontWeight: 600 }}>{t.symbol}</td>
                        <td style={{ padding: '6px' }}>{t.type}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>{Number(t.shares).toFixed(1)}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>RM{fmt(t.price)}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>RM{fmt(t.total)}</td>
                        <td style={{ padding: '6px', textAlign: 'right', color: t.pnl >= 0 ? green : red, fontWeight: 600 }}>
                          {t.pnl ? `${t.pnl >= 0 ? '+' : ''}RM${fmt(Math.abs(t.pnl))}` : '--'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Ticker List + Chart */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* All Tickers */}
        <div className="glass" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', marginBottom: 8 }}>All Tickers ({quotes.length})</div>
          {quotes.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: muted, fontSize: 13 }}>No data</div>
          ) : (
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead><tr style={{ color: muted, position: 'sticky', top: 0, background: '#0F0F17' }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Ticker</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Price</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Chg%</th>
                  <th style={{ textAlign: 'center', padding: '4px 6px' }}>Signal</th>
                </tr></thead>
                <tbody>
                  {quotes.map(t => {
                    const chgColor = t.changePercent >= 0 ? green : red;
                    const sigColor = t.signal === 'buy' ? green : t.signal === 'sell' ? red : muted;
                    return (
                      <tr key={t.symbol} style={{ borderTop: '1px solid #1a1a2a' }}>
                        <td style={{ padding: '4px 6px', fontWeight: 600 }}>{t.symbol}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'JetBrains Mono' }}>RM{fmt(t.price)}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', color: chgColor, fontFamily: 'JetBrains Mono' }}>{fmtPct(t.changePercent)}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                          <span style={{ color: sigColor, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>{t.signal || 'hold'}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Chart */}
        <div className="glass" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', marginBottom: 8 }}>Top Performer</div>
          {topHistory ? (
            <PriceChart data={topHistory.history} symbol={topHistory.symbol} />
          ) : portfolio?.holdings?.length > 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: muted, fontSize: 13 }}>
              Loading chart data...
            </div>
          ) : (
            <div style={{ padding: 40, textAlign: 'center', color: muted, fontSize: 13 }}>
              No holdings to chart
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
