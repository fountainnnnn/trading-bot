import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'trading.db');

let db;

export function initDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      shares REAL NOT NULL DEFAULT 0,
      avg_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      type TEXT CHECK(type IN ('buy','sell')) NOT NULL,
      shares REAL NOT NULL,
      price REAL NOT NULL,
      total REAL NOT NULL,
      reason TEXT DEFAULT '',
      confidence REAL DEFAULT 0.5,
      correct INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      action TEXT CHECK(action IN ('buy','sell','hold')) NOT NULL,
      price REAL NOT NULL,
      confidence REAL NOT NULL,
      reasoning TEXT DEFAULT '',
      actual_return REAL DEFAULT NULL,
      correct INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash REAL NOT NULL DEFAULT 10000.00,
      total_value REAL NOT NULL DEFAULT 10000.00,
      initial_balance REAL NOT NULL DEFAULT 10000.00,
      total_trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      trade_log TEXT DEFAULT '[]'
    );

    INSERT OR IGNORE INTO metrics (id, cash, total_value, initial_balance)
    VALUES (1, 10000.00, 10000.00, 10000.00);
  `);

  // Migrations: add columns that may not exist in older DBs
  try { db.exec('ALTER TABLE metrics ADD COLUMN trading_paused INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE metrics ADD COLUMN last_trade_at TEXT DEFAULT NULL'); } catch (e) {}
  try { db.exec('ALTER TABLE trades ADD COLUMN slippage REAL DEFAULT NULL'); } catch (e) {}

  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}
