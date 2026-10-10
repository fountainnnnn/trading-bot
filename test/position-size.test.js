import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, strategy, resetDb } from './helpers.js';

const { calculatePositionSize, maxSharesForPosition, executeTrade, executeAIDecision, MAX_POSITION_PCT } = strategy;

beforeEach(resetDb);

test('default concentration cap is 25%', () => {
  assert.equal(MAX_POSITION_PCT, 0.25);
});

test('sizing caps a wide-risk setup at 25% of account value', () => {
  // Logged JPM trade: 22 @ 302.10 = 66% of a $10,000 account.
  // Risk sizing alone (2% risk, $2.22 stop distance) would allow ~90 shares.
  const size = calculatePositionSize(302.10, 299.88, 10000, { maxRiskPercent: 2 });
  assert.equal(size.cappedByConcentration, true);
  assert.ok(size.shares * 302.10 <= 2500, `notional ${size.shares * 302.10}`);
  assert.ok(size.shares * 302.10 > 2490);
});

test('cap is configurable', () => {
  const size = calculatePositionSize(10, 9, 10000, { maxRiskPercent: 5, maxPositionPct: 0.10 });
  assert.equal(size.shares, 100); // 10% of 10,000 / 10
});

test('risk sizing wins when it is the smaller limit', () => {
  // 1% risk of 10,000 = 100; stop distance 1 -> 100 shares = RM1,000 (10%) < 25% cap
  const size = calculatePositionSize(10, 9, 10000, { maxRiskPercent: 1 });
  assert.equal(size.shares, 100);
  assert.equal(size.cappedByConcentration, false);
  assert.equal(size.risk, 100);
});

test('sizing never spends more than available cash', () => {
  const size = calculatePositionSize(10, 9, 10000, { maxRiskPercent: 5, cash: 300 });
  assert.equal(size.shares, 30);
});

test('no forced minimum position: a cap smaller than one whole share sizes to 0', () => {
  // Old sizing forced at least 1 share even when that broke the limits.
  assert.equal(maxSharesForPosition(40, 100), 0); // 25 of 100 buys 0 whole shares at 40
  assert.equal(calculatePositionSize(40, 39, 100, { maxRiskPercent: 2 }).shares, 0);
});

test('fractional assets are capped in fractional units', () => {
  assert.equal(maxSharesForPosition(60000, 10000), 0.041);
});

test('execution re-applies the cap to externally supplied sizes', async () => {
  // The AI pipeline asked for 22 shares (66%); execution trims it to <= 25%.
  const r = await executeAIDecision('JPM', 'buy', 302.10, 22, null);
  assert.equal(r.executed, true, r.reason);
  assert.equal(r.cappedByConcentration, true);
  assert.ok(r.total <= 2500, `total ${r.total}`);
});

test('cap is measured against cash plus open positions', async () => {
  await executeTrade('A.KL', 'buy', 10, 0.5, 't', { positionSize: 250 }, { slippagePct: 0 }); // RM2,500
  const r = await executeTrade('B.KL', 'buy', 10, 0.5, 't', { positionSize: 1000 }, { slippagePct: 0 });
  assert.equal(r.executed, true, r.reason);
  assert.equal(r.shares, 250); // 25% of (7,500 cash + 2,500 held)
});
