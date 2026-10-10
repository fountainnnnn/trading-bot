import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, strategy, resetDb, count } from './helpers.js';
import { createExclusiveRunner } from '../server/exclusive.js';

const { executeAIDecision, executeTrade } = strategy;

beforeEach(resetDb);

test('one /api/execute call writes exactly one decision and one trade', async () => {
  const r = await executeAIDecision('1155.KL', 'buy', 10, 50, null, { requestId: 'req-1' });
  assert.equal(r.executed, true, r.reason);
  assert.equal(count('trades'), 1);
  assert.equal(count('decisions'), 1);
});

test('replaying the same request id does not create a second trade', async () => {
  const first = await executeAIDecision('1155.KL', 'buy', 10, 50, null, { requestId: 'req-2' });
  const second = await executeAIDecision('1155.KL', 'buy', 10, 50, null, { requestId: 'req-2' });
  assert.equal(first.executed, true);
  assert.equal(second.executed, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.tradeId, first.tradeId);
  assert.equal(count('trades'), 1);
  assert.equal(count('decisions'), 1);
  const { cash } = db.prepare('SELECT cash FROM metrics WHERE id = 1').get();
  assert.equal(Math.round(cash), Math.round(10000 - first.total));
});

test('request ids are unique at the database level', () => {
  const ins = db.prepare("INSERT INTO trades (symbol, type, shares, price, total, request_id) VALUES ('A', 'buy', 1, 1, 1, 'dup')");
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/);
});

test('concurrent buys of the same symbol execute once', async () => {
  const plan = { positionSize: 50 };
  const results = await Promise.all([
    executeTrade('1155.KL', 'buy', 10, 0.5, 'a', { ...plan }, { slippagePct: 0 }),
    executeTrade('1155.KL', 'buy', 10, 0.5, 'b', { ...plan }, { slippagePct: 0 }),
  ]);
  assert.equal(results.filter(r => r.executed).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM trades WHERE type = 'buy'").get().c, 1);
});

test('concurrent sells close a position once', async () => {
  await executeTrade('1155.KL', 'buy', 10, 0.5, 'buy', { positionSize: 50 }, { slippagePct: 0 });
  const results = await Promise.all([
    executeTrade('1155.KL', 'sell', 10, 0.5, 's1', null, { slippagePct: 0 }),
    executeTrade('1155.KL', 'sell', 10, 0.5, 's2', null, { slippagePct: 0 }),
  ]);
  assert.equal(results.filter(r => r.executed).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM trades WHERE type = 'sell'").get().c, 1);
});

test('scan runner skips a tick while the previous scan is still running', async () => {
  const runExclusive = createExclusiveRunner();
  let calls = 0;
  let release;
  const slowScan = () => { calls++; return new Promise(r => { release = r; }); };

  const first = runExclusive(slowScan);
  const second = await runExclusive(slowScan);
  assert.equal(second.skipped, true);
  assert.equal(calls, 1);

  release('done');
  assert.deepEqual(await first, { skipped: false, value: 'done' });

  const third = await runExclusive(async () => { calls++; return 'again'; });
  assert.deepEqual(third, { skipped: false, value: 'again' });
  assert.equal(calls, 2);
});

test('the lock is released when a scan throws', async () => {
  const runExclusive = createExclusiveRunner();
  await assert.rejects(runExclusive(async () => { throw new Error('boom'); }));
  assert.equal((await runExclusive(async () => 1)).skipped, false);
});
