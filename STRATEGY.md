# Strategy and risk rules

This file describes what the code does today. The source of truth is
`server/strategy.js` (live paper trading) and `training/backtest.py` (the
backtest, which mirrors the same signals). If the two disagree with this file,
the code wins and this file needs updating.

## Universe and schedule

- Watchlist (`server/market.js`): 25 Bursa Malaysia stocks (`*.KL`, quotes from
  Yahoo Finance, about 15 minutes delayed) and 3 crypto pairs (BTC, ETH, SOL
  against USD, quotes from Binance).
- The server scans the whole watchlist every 5 minutes. Bursa symbols are
  skipped outside Mon-Fri 09:00-17:00 Malaysia time (the lunch break and
  public holidays are not modelled). Crypto is scanned around the clock.
- Indicators are computed on 1-hour bars from the last 15 days, falling back to
  daily bars from the last 90 days when fewer than 30 hourly bars are available.
- Only one scan runs at a time. A timer tick that fires while a scan is still
  running is skipped, and `POST /api/analyze-all` returns 409 in that case.

## Indicators

| Indicator | Definition |
| --- | --- |
| RSI | 14 periods, simple average of gains and losses |
| SMA short / long | 10 and 30 period simple moving averages of close |
| ATR | 14-period average true range (see known limitations) |
| Volatility | standard deviation of log returns x sqrt(252); "high" above 30%, "elevated" above 20% |
| Trend | bullish when SMA10 > SMA30, otherwise bearish |

## Entry signals (long only)

No entry is taken when a position in the symbol is already open, so the bot
never adds to or averages down a position. No entry is taken when volatility is
"high".

1. **Oversold bounce.** RSI is below `rsiOversold`. If `trendFilter` is on,
   the trend must also be bullish. Stop = price - 1.5 x ATR (or price - 4%
   without ATR). Target = price + 3 x ATR (or +8%). The setup is only taken if
   reward/risk is at least `minRewardRisk`.
2. **Trend pullback.** Bullish trend, RSI between 40 and 55, and price between
   97% and 102% of SMA10. Stop = 97% of SMA30. Target = price + 2.5 x (price -
   stop). Reward/risk must be at least `minRewardRisk`.

If both setups fire on the same bar, the trend pullback is used.

## Exit signals

Exits are checked before entries. The whole position is closed when the first
of these holds:

1. **Take profit on RSI:** RSI is above `rsiOverbought`, whatever the P&L.
2. **Target hit:** the position is in profit and price is at least
   `minRewardRisk x maxRiskPercent / 2` percent above entry.
3. **Stop loss:** the position is at a loss and price is below entry by at
   least `max(stopMultiplier x ATR / entry, maxRiskPercent / 4)` percent.

## Parameters

Defaults: `rsiOversold` 30, `rsiOverbought` 70, `stopMultiplier` 1.5,
`minRewardRisk` 1.5, `maxRiskPercent` 2.0, `volatilityFilter` on, `trendFilter`
off, `maxDailyTrades` 3.

They are overridden from `metrics.params` in the database, which is written by:

- `training/regime-classifier.py`: classifies each ticker as trending up,
  trending down, volatile or ranging, from 2 months of daily bars, and writes
  per-ticker RSI, stop and risk settings for that regime. Per-ticker values
  apply only while that ticker is analysed and are restored afterwards.
- `GET /api/review` (run every 24 hours by the server, just before the regime
  classifier): replaces the global parameters with a fixed baseline (RSI 25/75,
  stop 2.0, reward/risk 2.0, risk 1.5%) and, once the last 30 days hold at least
  5 closed trades, switches to more selective settings when the win rate is
  below 40% or losses average more than 1.5x wins.
- `training/genetic_search.py`: writes its best parameters if they beat the
  previous run.

## Pre-trade risk checks

Every trade, whether from the strategy or from `POST /api/execute`, has to
pass `canTradeToday`:

| Check | Rule |
| --- | --- |
| Kill switch | `POST /api/stop` pauses all trading until `POST /api/resume` |
| Daily loss limit | stop when today's realized loss (UTC day, closed trades only) is at least **5%** of the initial balance |
| Weekly loss limit | stop when this week's realized loss is at least **10%** of the initial balance |
| Trade count | at most `maxDailyTrades` buys per day (default 3) |

Only realized P&L from closed positions counts. Money spent on buys and
unrealized losses on open positions do not count towards the loss limits.

## Position sizing

`calculatePositionSize` takes the smallest of:

1. **Risk-based size:** `maxRiskPercent` of account value divided by the
   distance from entry to stop, so hitting the stop loses about
   `maxRiskPercent` of the account.
2. **Concentration cap:** no single position above **25%** of account value
   (`MAX_POSITION_PCT`, which can be set through the environment).
3. **Available cash.**

Account value is cash plus open positions at cost. Instruments priced above 50
are sized in 0.001 units and cheaper ones in whole shares, always rounded down.
If the result is zero, no trade is placed. There is no forced minimum size.

## Execution guards (paper broker)

`executeTrade` runs these checks and the database writes in one transaction:

- no buy if a position in the symbol is already open
- crypto exposure capped at 20% of the initial balance (at cost)
- the concentration cap is applied again, which also trims sizes supplied
  through `/api/execute`
- enough cash for the order
- at most 8 open positions
- an optional idempotency key (`request_id` in the body or an `Idempotency-Key`
  header on `/api/execute`) is stored on the trade with a unique index, so a
  retried request cannot trade twice

Fills are simulated: buys fill 0.1-0.3% above the quote and sells 0.1-0.3%
below it, picked at random. The paper broker charges no commission. Realized
P&L on a sell is exit value minus that position's cost basis.

## Known limitations

- When a loss limit or the daily trade count blocks trading, exits are blocked
  too. Open positions are not stopped out until the block lifts.
- The ATR helper in `strategy.js` and `backtest.py` takes true ranges from the
  first 50 bars it is given rather than the most recent ones, so with long
  histories it does not reflect current volatility.
- Volatility is annualised with sqrt(252) even when the bars are hourly.
- `volatilityFilter` raises the reward/risk bar by 1.3x for volatility above
  30%, but entries are already skipped in that regime, so in practice it has no
  effect.
- The weekly window starts on Sunday, computed in server local time.

## Rules from the earlier agent brief that are not implemented

An earlier version of this repo had a prose rulebook for an AI agent. The parts
that are enforced in code are covered above. These were not enforced and should
not be assumed: risking at most 0.5% per trade (the code uses
`maxRiskPercent`, default 2%), at most 3 open trades (the code allows 8), 2%
daily and 5% weekly loss limits (the code uses 5% and 10%), a minimum 2:1
reward/risk (the default is 1.5), and the pre-trade checklist and daily report
formats.
