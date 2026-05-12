const BASE = '/api';

async function fetchJSON(url, options) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  portfolio: () => fetchJSON('/portfolio'),
  quotes: () => fetchJSON('/market/quotes'),
  history: (sym) => fetchJSON(`/market/history/${sym}`),
  decisions: () => fetchJSON('/decisions'),
  trades: () => fetchJSON('/trades'),
  analyze: (sym) => fetchJSON(`/analyze/${sym}`, { method: 'POST' }),
  analyzeAll: () => fetchJSON('/analyze-all', { method: 'POST' }),
};
