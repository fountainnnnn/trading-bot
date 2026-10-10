// Shared setup: an in-memory SQLite DB, initialised before strategy.js loads.
process.env.TRADING_DB_PATH = ':memory:';

const { initDb } = await import('../server/db.js');
export const db = initDb();
export const strategy = await import('../server/strategy.js');

export function resetDb() {
  db.exec('DELETE FROM trades; DELETE FROM portfolio; DELETE FROM decisions;');
  db.prepare('UPDATE metrics SET cash = 10000, initial_balance = 10000, trading_paused = 0, params = NULL WHERE id = 1').run();
}

export function metrics() {
  return db.prepare('SELECT * FROM metrics WHERE id = 1').get();
}

export const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
