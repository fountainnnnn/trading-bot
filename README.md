# trading-bot

A paper-trading research bot for Bursa Malaysia stocks and a few crypto pairs.
It scans a watchlist, generates RSI/moving-average signals, runs them through
risk checks and position sizing, and records simulated fills in a local SQLite
database. A separate Python pipeline backtests the same rules and tunes their
parameters with a genetic search.

**This is not financial advice and it does not trade real money.** No broker
orders are placed anywhere in this code: the "broker" is a table in SQLite.
The Moomoo bridge only reads quotes. Treat any result from this project as a
research artifact, not evidence that the strategy works.

## Architecture

```
market data            signal               risk checks            sizing               paper broker
(Yahoo, Binance)  -->  evaluateSetups  -->  canTradeToday     -->  calculatePosition -->  executeTrade
 server/market.js      RSI / SMA / ATR      kill switch,           risk %, 25%           SQLite: portfolio,
                       entry + exit         daily/weekly loss,     concentration cap,    trades, decisions;
                       setups               trades per day         cash                  simulated slippage
```

- `server/index.js`: Express API on port 5900. Runs the auto-scan every 5
  minutes, serves the built dashboard, and runs a daily parameter review.
- `server/strategy.js`: signals, risk checks, sizing and the paper broker.
- `server/market.js`: watchlist and market data (Yahoo Finance for `.KL`
  stocks, Binance for crypto), with a small in-memory cache.
- `server/db.js`: SQLite schema and migrations (`data/trading.db`, created on
  first run).
- `server/moomoo-bridge.py`: optional local HTTP bridge to Moomoo OpenD for
  Bursa quotes and history on port 5902. It is read-only and is **not** wired
  into `market.js` yet.
- `src/`: React + Vite dashboard (portfolio, market snapshot, recent trades).
- `training/`: data download, backtest, genetic search, regime classifier and a
  small training dashboard.

`POST /api/execute` lets an external process submit a trade directly. It skips
the signal step but still goes through the risk checks, the concentration cap
and the other execution guards.

## Strategy and risk rules

See [STRATEGY.md](STRATEGY.md) for the entry and exit rules, parameters, risk
limits, sizing and known limitations, all described as implemented. In short:

- long-only oversold-bounce and trend-pullback entries, with exits on
  overbought RSI, a profit target or an ATR stop
- trading stops for the day at a 5% realized loss and for the week at 10%
- risk-based sizing (default 2% of account per trade), capped at 25% of account
  value per position (`MAX_POSITION_PCT`) and by available cash
- at most 8 open positions, crypto capped at 20%, no adding to open positions

## Training and evaluation methodology

1. `training/fetch_data.py` downloads two years of daily and one year of hourly
   bars per ticker from Yahoo Finance into `training/data/`.
2. `training/backtest.py` replays the strategy bar by bar on daily data, per
   ticker, starting from 10,000 each time. Rows before the split date (default
   `2025-05-01`, `--split-date`) are the **training** period (year 1); rows from
   the split date on are the **test** period (year 2).
3. `training/genetic_search.py` tunes the parameters on the training period
   only. Each generation mutates 1-3 parameters of the two best candidates by
   5-20% and blends them by crossover, 8 children per generation, for up to 25
   generations, stopping after 5 generations without improvement. Fitness,
   averaged across tickers, is

   `100 x (0.40 x max(0, Sharpe) / 3 + 0.25 x max(0, 10 x return) + 0.20 x (1 - max drawdown) + 0.15 x win rate)`

4. The best parameters and the defaults are then scored once on the test
   period, and both are saved to `training/results/validation.json`.
5. `training/regime-classifier.py` runs daily from the server. It labels each
   ticker as trending up, trending down, volatile or ranging from 2 months of
   daily bars and writes per-ticker parameter presets for that regime into the
   database.

Caveats: the genetic search writes its best parameters into the live database
(and runs `pm2 restart trading-bot`) based on **training** fitness, before the
test-period check runs, so the out-of-sample result is only reported, not used
as a gate. The test period is also the only holdout, so repeated searches
against it will overfit it over time.

### Fees and slippage

The backtest charges costs on every entry and exit:

- **Slippage:** buys fill at `close x (1 + slippage)`, sells at
  `close x (1 - slippage)`. Default 0.2% per side, the midpoint of the live
  paper broker's 0.1-0.3%.
- **Commission:** `commission x notional` per side. Default 0.1%.

Costs come out of cash, so they are included in return, win rate, Sharpe and
max drawdown. Results report `total_fees` and `total_slippage`. Override with
`--commission 0.0015 --slippage 0.001` or the `BACKTEST_COMMISSION` and
`BACKTEST_SLIPPAGE` environment variables (the genetic search passes these
through to each backtest). Sharpe and drawdown are computed from every daily
bar, and Sharpe is annualised with sqrt(252).

The live paper broker applies random 0.1-0.3% slippage but no commission.

### Results

No backtest results are reported here. The repository does not include market
data (it is downloaded into the git-ignored `training/data/`), and no backtest
was run on real data as part of this write-up.

## Setup

Requirements: Node.js 18 or newer (developed on 22), Python 3.9 or newer.

```bash
npm install
pip install numpy            # backtest and genetic search
pip install moomoo-api       # only for the Moomoo bridge
```

### Server and dashboard

```bash
npm start                    # build the dashboard, then serve API + UI on http://127.0.0.1:5900
npm run server               # API only (serves dist/ if it was built)
npm run dev                  # Vite dev server on http://127.0.0.1:5701, proxies /api to 5900
```

The server starts scanning 5 seconds after launch and fetches live quotes from
Yahoo Finance and Binance. Use `POST /api/stop` and `POST /api/resume` to pause
and resume trading.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `5900` / `127.0.0.1` | API address |
| `TRADING_DB_PATH` | `data/trading.db` | SQLite file (also read by the Python scripts) |
| `MAX_POSITION_PCT` | `0.25` | max share of account value in one position |
| `PYTHON` | `python3` | interpreter for the daily regime classifier |

### Moomoo bridge (optional)

Needs Moomoo OpenD running on `127.0.0.1:11111`.

```bash
python3 server/moomoo-bridge.py      # http://127.0.0.1:5902/quote/MY.1155, /history/MY.1155?days=7, /health
```

### Training

```bash
python3 training/fetch_data.py                                   # download data (network)
python3 training/backtest.py --data-dir training/data --train    # score defaults on year 1
python3 training/backtest.py --data-dir training/data --test --params '{"rsiOversold": 25}'
python3 training/genetic_search.py                               # search on year 1, validate on year 2
python3 training/dashboard.py                                    # progress at http://127.0.0.1:5903
python3 training/regime-classifier.py                            # write regime params to the DB (network)
```

Paths default to the repo and can be overridden with `TRAINING_DATA_DIR`,
`TRAINING_RESULTS_DIR` and `TRADING_DB_PATH`.

## Tests

```bash
npm test          # both suites
npm run test:js   # node:test, server logic against an in-memory SQLite DB
npm run test:py   # unittest, backtest cost model on synthetic data
```

The JS tests cover the daily loss limit, sell P&L, idempotent execution, scan
overlap, and the concentration cap. The Python tests check the cost arithmetic
by hand and that costs lower return and Sharpe on a deterministic price series.
