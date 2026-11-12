'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
      password_hash TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL CHECK (type IN ('AR','AP')),
      invoice_no   TEXT NOT NULL,
      party        TEXT NOT NULL,
      issue_date   TEXT NOT NULL,
      due_date     TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      description  TEXT NOT NULL DEFAULT '',
      reference    TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      voided       INTEGER NOT NULL DEFAULT 0,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (type, invoice_no, party)
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_type_due ON invoices(type, due_date);

    CREATE TABLE IF NOT EXISTS payments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      paid_date    TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      method       TEXT NOT NULL DEFAULT '',
      reference    TEXT NOT NULL DEFAULT '',
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

    CREATE TABLE IF NOT EXISTS activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action     TEXT NOT NULL,
      detail     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

module.exports = { openDatabase };
