'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'zabka.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', rate REAL NOT NULL DEFAULT 31.4, training_rate REAL NOT NULL DEFAULT 20,
  active INTEGER NOT NULL DEFAULT 1, can_rates INTEGER NOT NULL DEFAULT 0, lang TEXT DEFAULT 'uk',
  tg_chat_id TEXT, tg_code TEXT, notify TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, admin_id INTEGER REFERENCES users(id), deputy_id INTEGER REFERENCES users(id),
  has_restock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_locations (user_id INTEGER REFERENCES users(id), location_id INTEGER REFERENCES locations(id), PRIMARY KEY(user_id, location_id));
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL REFERENCES locations(id), date TEXT NOT NULL, slot TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id), start INTEGER, end INTEGER,
  plan_user_id INTEGER, plan_start INTEGER, plan_end INTEGER, cancelled INTEGER NOT NULL DEFAULT 0,
  UNIQUE(location_id, date, slot));
CREATE TABLE IF NOT EXISTS weeks (location_id INTEGER, week TEXT, status TEXT DEFAULT 'draft', published_at TEXT, published_by INTEGER, PRIMARY KEY(location_id, week));
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL, user_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL,
  minutes INTEGER NOT NULL, comment TEXT, created_by INTEGER, approved_by INTEGER, request_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')), deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL, date TEXT NOT NULL, user_id INTEGER, pallets REAL,
  confirmed_by INTEGER, confirmed_at TEXT, UNIQUE(location_id, date));
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, location_id INTEGER NOT NULL, user_id INTEGER NOT NULL, date TEXT,
  shift_id INTEGER, data TEXT DEFAULT '{}', comment TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), decided_by INTEGER, decided_at TEXT, decision_comment TEXT, reminded_at TEXT);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL, author_id INTEGER NOT NULL, text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')), resolved_by INTEGER, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS acks (key TEXT PRIMARY KEY, location_id INTEGER, by INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payroll_status (location_id INTEGER, user_id INTEGER, month TEXT, checked_by INTEGER, checked_at TEXT, paid_by INTEGER, paid_at TEXT, PRIMARY KEY(location_id, user_id, month));
CREATE TABLE IF NOT EXISTS months (location_id INTEGER, month TEXT, closed_by INTEGER, closed_at TEXT, PRIMARY KEY(location_id, month));
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT DEFAULT (datetime('now')), user_id INTEGER, location_id INTEGER, action TEXT, details TEXT);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, created_at TEXT DEFAULT (datetime('now')), read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_shifts_date ON shifts(date);
CREATE INDEX IF NOT EXISTS ix_adj ON adjustments(location_id, date);
CREATE INDEX IF NOT EXISTS ix_req ON requests(location_id, status);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const setting = (k, v) => v === undefined ? (get('SELECT value FROM settings WHERE key=?', k) || {}).value
  : run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));

module.exports = { db, all, get, run, tx, setting };
