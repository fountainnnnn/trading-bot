import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, strategy, resetDb, metrics } from './helpers.js';

const { canTradeToday, lossLimitStatus, executeTrade, MAX_DAILY_LOSS } = strategy;
const NO_SLIP = { slippagePct: 0 };
const buyPlan = (shares) => ({ positionSize: shares });

beforeEach(resetDb);

test('lossLimitStatus: only negative realized P&L counts as loss', () => {
  assert.equal(lossLimitStatus(0, 10000, 0.05).breached, false);
  assert.equal(lossLimitStatus(250, 10000, 0.05).breached, false);
  assert.equal(lossLimitStatus(-499, 10000, 0.05).breached, false);
  const hit = lossLimitStatus(-500, 10000, 0.05);
  assert.equal(hit.breached, true);
  assert.equal(hit.lossPct, 0.05);
});

test('regression: buy notional is not counted as loss (logged "132.92%" with $0 loss)', () => {
  // The log showed two JPM buy rows of $6,646.20 and $0 realized loss, yet the
  // limit reported 2 * 6646.20 / 10000 = 132.92%.
  const ins = db.prepare("INSERT INTO trades (symbol, type, shares, price, total) VALUES ('JPM', 'buy', 22, 302.10, 6646.20)");
  ins.run();
  ins.run();
  const check = canTradeToday(db, metrics());
  assert.equal(check.allowed, true, check.reason);
});

test('regression: repeated round trips at a flat price record zero P&L and do not trip the limit', async () => {
  // Previously sell P&L = sale proceeds - SUM(every buy ever made in the symbol),
  // so the second flat round trip booked the first buy's cost as a -$1,000 loss
  // (10% of the account), which blocked trading for the day.
  for (let i = 0; i < 2; i++) {
    const b = await executeTrade('1155.KL', 'buy', 10, 0.5, 'test', buyPlan(100), NO_SLIP);
    assert.equal(b.executed, true, b.reason);
    const s = await executeTrade('1155.KL', 'sell', 10, 0.5, 'test', null, NO_SLIP);
    assert.equal(s.executed, true, s.reason);
    assert.equal(s.pnl, 0);
  }
  const pnls = db.prepare("SELECT pnl FROM trades WHERE type = 'sell'").all().map(r => r.pnl);
  assert.deepEqual(pnls, [0, 0]);
  assert.equal(canTradeToday(db, metrics()).allowed, true);
});

test('a real realized loss of at least the daily limit blocks trading', async () => {
  await executeTrade('1155.KL', 'buy', 10, 0.5, 'test', buyPlan(100), NO_SLIP);   // RM1,000
  const s = await executeTrade('1155.KL', 'sell', 4, 0.5, 'test', null, NO_SLIP); // RM400 back
  assert.equal(s.pnl, -600);
  const check = canTradeToday(db, metrics());
  assert.equal(check.allowed, false);
  assert.match(check.reason, /Daily loss limit hit: 6\.00%/);
  assert.ok(0.06 >= MAX_DAILY_LOSS);
});

test('losses above 100% of the account still block (no "corrupt data" bypass)', () => {
  db.prepare("INSERT INTO trades (symbol, type, shares, price, total, pnl) VALUES ('X', 'sell', 1, 1, 1, -15000)").run();
  assert.equal(canTradeToday(db, metrics()).allowed, false);
});
