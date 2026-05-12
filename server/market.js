// Market data via dual sources:
//   - Binance API for crypto (real-time, free, no key needed)
//   - Yahoo Finance for Bursa Malaysia stocks (15-min delay, free)

const WATCHLIST = [
  // ─── Bursa Malaysia — Banks & Finance ───
  '1155.KL',  // MAYBANK
  '1023.KL',  // CIMB
  '1295.KL',  // PBBANK
  '1066.KL',  // RHBBANK
  '5819.KL',  // HLBANK
  '1015.KL',  // AMBANK
  // ─── Bursa Malaysia — Telco & Utilities ───
  '5347.KL',  // TENAGA
  '6012.KL',  // MAXIS
  '4863.KL',  // TM
  // ─── Bursa Malaysia — Plantation ───
  '1961.KL',  // IOICORP
  '2445.KL',  // KLK
  '5285.KL',  // SIMEPLT
  // ─── Bursa Malaysia — Construction & Property ───
  '5398.KL',  // GAMUDA
  '3336.KL',  // IJM
  '5211.KL',  // SUNWAY
  // ─── Bursa Malaysia — Tech & Manufacturing ───
  '0166.KL',  // INARI
  '0128.KL',  // FRONTKN
  '5292.KL',  // UWC
  '3867.KL',  // MPI
  '0002.KL',  // GTRONIC
  // ─── Bursa Malaysia — Consumer ───
  '4707.KL',  // NESTLE
  '3026.KL',  // DLADY
  '3689.KL',  // F&N
  // ─── Bursa Malaysia — Gaming & Others ───
  '4715.KL',  // GENM
  '3182.KL',  // GENTING
  // ─── Crypto (24/7, Binance real-time) ───
  'BTC-USD', 'ETH-USD', 'SOL-USD',
];

const cache = new Map();
const CACHE_TTL_QUOTE = 60000;   // 1 min
const CACHE_TTL_HIST = 300000;   // 5 min

// ─── Source detection (isCrypto now exported below) ──────────

function toBinanceSymbol(symbol) {
  return symbol.replace('-USD', 'USDT');
}

function fromBinanceSymbol(binanceSym) {
  return binanceSym.replace('USDT', '-USD');
}

// ─── Binance API (crypto, real-time) ────────────────────────

async function binanceFetch(path) {
  const url = `https://api.binance.com${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance error ${res.status}`);
  return res.json();
}

async function binanceQuote(symbol) {
  const binSym = toBinanceSymbol(symbol);
  const [ticker, priceData] = await Promise.all([
    binanceFetch(`/api/v3/ticker/24hr?symbol=${binSym}`),
    binanceFetch(`/api/v3/ticker/price?symbol=${binSym}`),
  ]);

  const price = parseFloat(priceData.price);
  const change = parseFloat(ticker.priceChange || 0);
  const changePercent = parseFloat(ticker.priceChangePercent || 0);
  const high = parseFloat(ticker.highPrice || price);
  const low = parseFloat(ticker.lowPrice || price);
  const volume = parseFloat(ticker.volume || 0);

  return {
    symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    high: Math.round(high * 100) / 100,
    low: Math.round(low * 100) / 100,
    volume,
    timestamp: new Date().toISOString(),
  };
}

async function binanceHistory(symbol, interval = '1h', limit = 150) {
  const binSym = toBinanceSymbol(symbol);
  const klines = await binanceFetch(`/api/v3/klines?symbol=${binSym}&interval=${interval}&limit=${limit}`);

  return klines.map(k => ({
    date: new Date(k[0]).toISOString(),
    open: Math.round(parseFloat(k[1]) * 100) / 100,
    high: Math.round(parseFloat(k[2]) * 100) / 100,
    low: Math.round(parseFloat(k[3]) * 100) / 100,
    close: Math.round(parseFloat(k[4]) * 100) / 100,
    volume: parseFloat(k[5]),
  })).filter(e => e.close > 0);
}

// ─── Yahoo Finance (Bursa Malaysia, 15-min delay) ───────────

async function yahooFetch(symbol, interval = '1d', range = '1mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`Yahoo error ${symbol}: ${res.status}`);
  return res.json();
}

function yahooExtractQuote(result) {
  const meta = result.meta;
  const quotes = result.indicators?.quote?.[0];
  if (!meta || !quotes) return null;
  const lastIdx = result.timestamp.length - 1;
  const price = meta.regularMarketPrice || meta.previousClose;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = price - prevClose;
  return {
    symbol: meta.symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePercent: prevClose > 0 ? Math.round((change / prevClose) * 10000) / 100 : 0,
    high: Math.round((quotes.high?.[lastIdx] || price) * 100) / 100,
    low: Math.round((quotes.low?.[lastIdx] || price) * 100) / 100,
    volume: quotes.volume?.[lastIdx] || 0,
    timestamp: new Date().toISOString(),
  };
}

function yahooExtractHistory(result) {
  const timestamps = result.timestamp || [];
  const quotes = result.indicators?.quote?.[0];
  if (!timestamps.length || !quotes) return null;

  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString(),
    open: Math.round((quotes.open?.[i] || 0) * 100) / 100,
    high: Math.round((quotes.high?.[i] || 0) * 100) / 100,
    low: Math.round((quotes.low?.[i] || 0) * 100) / 100,
    close: Math.round((quotes.close?.[i] || 0) * 100) / 100,
    volume: quotes.volume?.[i] || 0,
  })).filter(e => e.close > 0);
}

// ─── Public API ──────────────────────────────────────────────

export async function getQuote(symbol) {
  const cacheKey = `q:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_QUOTE) return cached.data;

  try {
    let quote;
    if (isCrypto(symbol)) {
      quote = await binanceQuote(symbol);
    } else {
      const data = await yahooFetch(symbol, '1d', '5d');
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      quote = yahooExtractQuote(result);
    }
    if (quote) cache.set(cacheKey, { data: quote, ts: Date.now() });
    return quote;
  } catch (e) {
    console.error(`Quote error ${symbol}:`, e.message);
    // Fallback: try the other source if first fails
    return null;
  }
}

export async function getHistorical(symbol, interval = '1h', days = 7) {
  const cacheKey = `h:${symbol}:${interval}:${days}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_HIST) return cached.data;

  try {
    let entries;
    if (isCrypto(symbol)) {
      // Map interval to Binance format
      const binInterval = interval === '15m' ? '15m' : interval === '1h' ? '1h' : '1d';
      const binLimit = interval === '15m' ? 96 : interval === '1h' ? 150 : 90;
      entries = await binanceHistory(symbol, binInterval, binLimit);
    } else {
      const range = days <= 2 ? '2d' : days <= 5 ? '5d' : days <= 15 ? '15d' : '1mo';
      const yahooInterval = interval === '15m' ? '15m' : interval === '1h' ? '60m' : '1d';
      const data = await yahooFetch(symbol, yahooInterval, range);
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      entries = yahooExtractHistory(result);
    }
    if (entries && entries.length > 0) cache.set(cacheKey, { data: entries, ts: Date.now() });
    return entries;
  } catch (e) {
    console.error(`History error ${symbol}:`, e.message);
    return null;
  }
}

// Training-optimized: faster data with more bars
export async function getTrainingData(symbol) {
  // Primary: 1-hour bars for last 15 days
  const hourly = await getHistorical(symbol, '1h', 15);
  if (hourly && hourly.length >= 30) return hourly;

  // Fallback: daily bars for last 90 days
  const daily = await getHistorical(symbol, '1d', 90);
  return daily;
}

export function getWatchlist() { return WATCHLIST; }

export function isCrypto(symbol) {
  return symbol === 'BTC-USD' || symbol === 'ETH-USD' || symbol === 'SOL-USD';
}

// Market hours check (Bursa Malaysia)
export function isMarketOpen() {
  const now = new Date();
  const sg = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const day = sg.getDay();
  const hour = sg.getHours();
  const min = sg.getMinutes();
  const time = hour * 100 + min;

  if (day === 0 || day === 6) return false;
  return time >= 900 && time <= 1700;
}

export function isPreMarket() {
  const now = new Date();
  const sg = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const day = sg.getDay();
  const hour = sg.getHours();
  const min = sg.getMinutes();
  const time = hour * 100 + min;

  if (day === 0 || day === 6) return false;
  return time >= 800 && time < 900;
}
