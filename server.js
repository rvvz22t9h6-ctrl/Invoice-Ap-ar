'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('./db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_DAYS = 30;
const ROLES = ['admin', 'editor', 'viewer'];
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function todayIn(timeZone) {
  return new Date().toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

function toCents(value, field) {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative number`);
  return Math.round(n * 100);
}

function str(value, field, { required = false, max = 500 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

function csvEscape(v) {
  let s = v == null ? '' : String(v);
  // Prevent spreadsheet formula injection for text cells (numbers are passed as plain digits).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createApp(db, options = {}) {
  const timeZone = options.timeZone || process.env.TIMEZONE || 'UTC';
  const secureCookies = options.secureCookies ?? process.env.SECURE_COOKIES === 'true';
  const loginAttempts = new Map(); // ip -> { count, resetAt }

  const today = () => (options.today ? options.today() : todayIn(timeZone));

  function getSetting(key, fallback) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  function log(userId, action, detail) {
    db.prepare('INSERT INTO activity (user_id, action, detail) VALUES (?, ?, ?)').run(userId, action, detail);
  }

  // --- Invoice computation -------------------------------------------------

  const INVOICE_SELECT = `
    SELECT i.*, COALESCE(p.paid, 0) AS paid_cents, p.last_paid,
           cu.name AS created_by_name, uu.name AS updated_by_name
    FROM invoices i
    LEFT JOIN (SELECT invoice_id, SUM(amount_cents) AS paid, MAX(paid_date) AS last_paid
               FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users uu ON uu.id = i.updated_by`;

  function decorate(row, now) {
    const balance = Math.max(row.amount_cents - row.paid_cents, 0);
    let status;
    if (row.voided) status = 'Void';
    else if (balance === 0) status = 'Paid';
    else if (row.due_date < now) status = 'Overdue';
    else if (row.paid_cents > 0) status = 'Partially paid';
    else status = 'Open';
    const daysOverdue = status === 'Overdue' ? daysBetween(row.due_date, now) : 0;
    return {
      id: row.id,
      type: row.type,
      invoice_no: row.invoice_no,
      party: row.party,
      issue_date: row.issue_date,
      due_date: row.due_date,
      amount: row.amount_cents / 100,
      paid: row.paid_cents / 100,
      balance: row.voided ? 0 : balance / 100,
      description: row.description,
      reference: row.reference,
      notes: row.notes,
      voided: !!row.voided,
      status,
      partially_paid: !row.voided && row.paid_cents > 0 && balance > 0,
      days_overdue: daysOverdue,
      last_paid: row.last_paid || null,
      created_by: row.created_by_name || null,
      updated_by: row.updated_by_name || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function getInvoice(id) {
    const row = db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Invoice not found');
    return row;
  }

  function listInvoices() {
    const now = today();
    return db.prepare(`${INVOICE_SELECT} ORDER BY i.due_date ASC, i.id ASC`).all().map((r) => decorate(r, now));
  }

  function validateInvoice(body, existing) {
    const merged = { ...existing, ...body };
    const type = str(merged.type, 'Type', { required: true }).toUpperCase();
    if (!['AR', 'AP'].includes(type)) throw new HttpError(400, 'Type must be AR or AP');
    const issue = str(merged.issue_date, 'Issue date', { required: true });
    const due = str(merged.due_date, 'Due date', { required: true });
    if (!isValidDate(issue)) throw new HttpError(400, 'Issue date must be YYYY-MM-DD');
    if (!isValidDate(due)) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
    if (due < issue) throw new HttpError(400, 'Due date cannot be before issue date');
    return {
      type,
      invoice_no: str(merged.invoice_no, 'Invoice number', { required: true, max: 100 }),
      party: str(merged.party, type === 'AR' ? 'Customer' : 'Supplier', { required: true, max: 200 }),
      issue_date: issue,
      due_date: due,
      amount_cents: body.amount !== undefined ? toCents(body.amount, 'Amount') : existing?.amount_cents ?? toCents(undefined, 'Amount'),
      description: str(merged.description, 'Description', { max: 1000 }),
      reference: str(merged.reference, 'Reference', { max: 200 }),
      notes: str(merged.notes, 'Notes', { max: 2000 }),
      voided: merged.voided ? 1 : 0,
    };
  }

  function insertInvoice(v, userId) {
    try {
      const r = db.prepare(`INSERT INTO invoices
        (type, invoice_no, party, issue_date, due_date, amount_cents, description, reference, notes, voided, created_by, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.type, v.invoice_no, v.party, v.issue_date, v.due_date,
        v.amount_cents, v.description, v.reference, v.notes, v.voided, userId, userId);
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) {
        throw new HttpError(409, `${v.type} invoice ${v.invoice_no} for ${v.party} already exists`);
      }
      throw e;
    }
  }

  // --- Summary -------------------------------------------------------------

  function summary() {
    const now = today();
    const in7 = addDays(now, 7);
    const monthStart = `${now.slice(0, 7)}-01`;
    const invoices = listInvoices();
    const blank = () => ({
      outstanding: 0, overdue: 0, open_count: 0, overdue_count: 0, due_7_days: 0, due_7_count: 0,
      aging: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
      paid_this_month: 0,
    });
    const out = { today: now, AR: blank(), AP: blank(), due_soon: [], top_overdue: [] };

    for (const inv of invoices) {
      if (inv.voided || inv.balance <= 0) continue;
      const s = out[inv.type];
      s.outstanding += inv.balance;
      s.open_count += 1;
      const d = inv.days_overdue;
      if (inv.status === 'Overdue') {
        s.overdue += inv.balance;
        s.overdue_count += 1;
      }
      if (d === 0) s.aging.current += inv.balance;
      else if (d <= 30) s.aging.d1_30 += inv.balance;
      else if (d <= 60) s.aging.d31_60 += inv.balance;
      else if (d <= 90) s.aging.d61_90 += inv.balance;
      else s.aging.d90_plus += inv.balance;
      if (inv.due_date >= now && inv.due_date <= in7) {
        s.due_7_days += inv.balance;
        s.due_7_count += 1;
        out.due_soon.push(inv);
      }
      if (inv.status === 'Overdue') out.top_overdue.push(inv);
    }

    const paid = db.prepare(`SELECT i.type, SUM(p.amount_cents) AS total FROM payments p
      JOIN invoices i ON i.id = p.invoice_id WHERE p.paid_date >= ? AND p.paid_date <= ? AND i.voided = 0
      GROUP BY i.type`).all(monthStart, now);
    for (const r of paid) out[r.type].paid_this_month = r.total / 100;

    const round = (o) => {
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'number') o[k] = Math.round(o[k] * 100) / 100;
        else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) round(o[k]);
      }
    };
    round(out.AR);
    round(out.AP);
    out.net_position = Math.round((out.AR.outstanding - out.AP.outstanding) * 100) / 100;
    out.due_soon.sort((a, b) => a.due_date.localeCompare(b.due_date));
    out.top_overdue.sort((a, b) => b.days_overdue - a.days_overdue || b.balance - a.balance);
    out.top_overdue = out.top_overdue.slice(0, 10);
    out.recent_activity = db.prepare(`SELECT a.action, a.detail, a.created_at, u.name AS user
      FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 10`).all();
    return out;
  }

  // --- Auth ----------------------------------------------------------------

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    const row = db.prepare(`SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    if (!row || !row.active || row.expires_at < Date.now()) return null;
    return { id: row.id, username: row.username, name: row.name, role: row.role };
  }

  function sessionCookie(token, maxAgeSec) {
    return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookies ? '; Secure' : ''}`;
  }

  function requireRole(user, ...roles) {
    if (!user) throw new HttpError(401, 'Please sign in');
    if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'You have read-only access');
  }

  function checkLoginRate(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (entry && entry.resetAt > now && entry.count >= 10) {
      throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    }
    if (!entry || entry.resetAt <= now) loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60000 });
    else entry.count += 1;
  }

  function publicUser(u) {
    return { id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active,
      created_at: u.created_at, last_login_at: u.last_login_at };
  }

  function validatePassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    return pw;
  }

  function activeAdminCount(excludeId) {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(excludeId ?? -1).n;
  }

  // --- Routes --------------------------------------------------------------

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  route('POST', '/api/login', ({ body, req, res }) => {
    const ip = req.socket.remoteAddress || 'unknown';
    checkLoginRate(ip);
    const username = str(body.username, 'Username', { required: true, max: 100 });
    const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Incorrect username or password');
    }
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), user.id, Date.now() + SESSION_DAYS * 86400000);
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
    return { user: { id: user.id, username: user.username, name: user.name, role: user.role } };
  });

  route('POST', '/api/logout', ({ req, res }) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => {
    requireRole(user);
    return { user, settings: { company_name: getSetting('company_name', ''), currency: getSetting('currency', process.env.CURRENCY || 'USD') } };
  });

  route('POST', '/api/me/password', ({ user, body }) => {
    requireRole(user);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(body.current_password || ''), row.password_hash)) {
      throw new HttpError(400, 'Current password is incorrect');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validatePassword(body.new_password)), user.id);
    return { ok: true };
  });

  route('GET', '/api/summary', ({ user }) => {
    requireRole(user);
    return summary();
  });

  route('GET', '/api/invoices', ({ user }) => {
    requireRole(user);
    return { invoices: listInvoices(), today: today() };
  });

  route('GET', '/api/invoices/:id', ({ user, params }) => {
    requireRole(user);
    const inv = decorate(getInvoice(params.id), today());
    inv.payments = db.prepare(`SELECT p.id, p.paid_date, p.amount_cents, p.method, p.reference, p.created_at, u.name AS created_by
      FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.invoice_id = ? ORDER BY p.paid_date, p.id`)
      .all(params.id).map((p) => ({ ...p, amount: p.amount_cents / 100, amount_cents: undefined }));
    return inv;
  });

  route('POST', '/api/invoices', ({ user, body }) => {
    requireRole(user, 'admin', 'editor');
    const v = validateInvoice(body, null);
    const id = insertInvoice(v, user.id);
    log(user.id, 'invoice.create', `Added ${v.type} invoice ${v.invoice_no} (${v.party})`);
    return decorate(getInvoice(id), today());
  });

  route('POST', '/api/invoices/import', ({ user, body }) => {
    requireRole(user, 'admin', 'editor');
    const rows = Array.isArray(body.invoices) ? body.invoices : null;
    if (!rows || !rows.length) throw new HttpError(400, 'No invoices to import');
    if (rows.length > 5000) throw new HttpError(400, 'Import at most 5000 invoices at a time');
    const errors = [];
    let created = 0;
    let paymentsAdded = 0;
    db.exec('BEGIN');
    try {
      rows.forEach((row, i) => {
        try {
          const v = validateInvoice(row, null);
          const id = insertInvoice(v, user.id);
          created += 1;
          if (row.paid !== undefined && row.paid !== '' && row.paid !== null) {
            const paidCents = Math.min(toCents(row.paid, 'Paid'), v.amount_cents);
            if (paidCents > 0) {
              const paidDate = isValidDate(row.paid_date) ? row.paid_date : v.issue_date;
              db.prepare('INSERT INTO payments (invoice_id, paid_date, amount_cents, method, reference, created_by) VALUES (?,?,?,?,?,?)')
                .run(id, paidDate, paidCents, 'Imported', '', user.id);
              paymentsAdded += 1;
            }
          }
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          errors.push({ row: i + 2, error: e.message });
        }
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (created) log(user.id, 'invoice.import', `Imported ${created} invoice(s)`);
    return { created, payments: paymentsAdded, errors };
  });

  route('PUT', '/api/invoices/:id', ({ user, body, params }) => {
    requireRole(user, 'admin', 'editor');
    const existing = getInvoice(params.id);
    const v = validateInvoice(body, existing);
    try {
      db.prepare(`UPDATE invoices SET type=?, invoice_no=?, party=?, issue_date=?, due_date=?, amount_cents=?,
        description=?, reference=?, notes=?, voided=?, updated_by=?, updated_at=datetime('now') WHERE id=?`)
        .run(v.type, v.invoice_no, v.party, v.issue_date, v.due_date, v.amount_cents, v.description,
          v.reference, v.notes, v.voided, user.id, params.id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Another invoice with this number and party already exists');
      throw e;
    }
    const what = v.voided && !existing.voided ? 'Voided' : !v.voided && existing.voided ? 'Restored' : 'Updated';
    log(user.id, 'invoice.update', `${what} ${v.type} invoice ${v.invoice_no} (${v.party})`);
    return decorate(getInvoice(params.id), today());
  });

  route('DELETE', '/api/invoices/:id', ({ user, params }) => {
    requireRole(user, 'admin');
    const existing = getInvoice(params.id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(params.id);
    log(user.id, 'invoice.delete', `Deleted ${existing.type} invoice ${existing.invoice_no} (${existing.party})`);
    return { ok: true };
  });

  route('POST', '/api/invoices/:id/payments', ({ user, body, params }) => {
    requireRole(user, 'admin', 'editor');
    const inv = getInvoice(params.id);
    if (inv.voided) throw new HttpError(400, 'Cannot record a payment on a void invoice');
    const paidDate = str(body.paid_date, 'Payment date', { required: true });
    if (!isValidDate(paidDate)) throw new HttpError(400, 'Payment date must be YYYY-MM-DD');
    const cents = toCents(body.amount, 'Payment amount');
    if (cents <= 0) throw new HttpError(400, 'Payment amount must be greater than zero');
    const remaining = inv.amount_cents - inv.paid_cents;
    if (cents > remaining) {
      throw new HttpError(400, `Payment exceeds the outstanding balance of ${(remaining / 100).toFixed(2)}`);
    }
    db.prepare('INSERT INTO payments (invoice_id, paid_date, amount_cents, method, reference, created_by) VALUES (?,?,?,?,?,?)')
      .run(inv.id, paidDate, cents, str(body.method, 'Method', { max: 100 }), str(body.reference, 'Reference', { max: 200 }), user.id);
    db.prepare("UPDATE invoices SET updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(user.id, inv.id);
    const verb = inv.type === 'AR' ? 'Received' : 'Paid';
    log(user.id, 'payment.create', `${verb} ${(cents / 100).toFixed(2)} on ${inv.type} invoice ${inv.invoice_no} (${inv.party})`);
    return decorate(getInvoice(inv.id), today());
  });

  route('DELETE', '/api/payments/:id', ({ user, params }) => {
    requireRole(user, 'admin', 'editor');
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(params.id);
    if (!p) throw new HttpError(404, 'Payment not found');
    const inv = getInvoice(p.invoice_id);
    db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
    db.prepare("UPDATE invoices SET updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(user.id, inv.id);
    log(user.id, 'payment.delete', `Removed payment of ${(p.amount_cents / 100).toFixed(2)} from ${inv.type} invoice ${inv.invoice_no} (${inv.party})`);
    return { ok: true };
  });

  route('GET', '/api/export.csv', ({ user, res, query }) => {
    requireRole(user);
    const type = String(query.get('type') || '').toUpperCase();
    const rows = listInvoices().filter((i) => !type || i.type === type);
    const header = ['Type', 'Invoice No', 'Customer/Supplier', 'Issue Date', 'Due Date', 'Amount', 'Paid', 'Balance',
      'Status', 'Days Overdue', 'Last Payment', 'Reference', 'Description', 'Notes'];
    const lines = [header.join(',')].concat(rows.map((i) => [i.type, i.invoice_no, i.party, i.issue_date, i.due_date,
      i.amount.toFixed(2), i.paid.toFixed(2), i.balance.toFixed(2), i.status, i.days_overdue, i.last_paid || '',
      i.reference, i.description, i.notes].map(csvEscape).join(',')));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="invoices-${type || 'all'}-${today()}.csv"`,
    });
    res.end(`﻿${lines.join('\r\n')}\r\n`);
    return undefined;
  });

  // --- Users & settings (admin) -------------------------------------------

  route('GET', '/api/users', ({ user }) => {
    requireRole(user, 'admin');
    return { users: db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(publicUser) };
  });

  route('POST', '/api/users', ({ user, body }) => {
    requireRole(user, 'admin');
    const username = str(body.username, 'Username', { required: true, max: 100 });
    if (!/^[A-Za-z0-9._@-]+$/.test(username)) throw new HttpError(400, 'Username may only contain letters, numbers and . _ @ -');
    const role = String(body.role || 'viewer');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
    const name = str(body.name, 'Name', { required: true, max: 100 });
    try {
      const r = db.prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?,?,?,?)')
        .run(username, name, role, hashPassword(validatePassword(body.password)));
      log(user.id, 'user.create', `Created ${role} account for ${name}`);
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid));
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That username is already taken');
      throw e;
    }
  });

  route('PUT', '/api/users/:id', ({ user, body, params }) => {
    requireRole(user, 'admin');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
    if (!target) throw new HttpError(404, 'User not found');
    const role = body.role !== undefined ? String(body.role) : target.role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
    const active = body.active !== undefined ? (body.active ? 1 : 0) : target.active;
    if (target.role === 'admin' && target.active && (role !== 'admin' || !active) && activeAdminCount(target.id) === 0) {
      throw new HttpError(400, 'There must be at least one active admin');
    }
    const name = body.name !== undefined ? str(body.name, 'Name', { required: true, max: 100 }) : target.name;
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, target.id);
    if (body.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validatePassword(body.password)), target.id);
    }
    if (body.password || !active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    log(user.id, 'user.update', `Updated account for ${name}`);
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id));
  });

  route('DELETE', '/api/users/:id', ({ user, params }) => {
    requireRole(user, 'admin');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
    if (!target) throw new HttpError(404, 'User not found');
    if (target.id === user.id) throw new HttpError(400, 'You cannot delete your own account');
    if (target.role === 'admin' && activeAdminCount(target.id) === 0) throw new HttpError(400, 'There must be at least one active admin');
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    log(user.id, 'user.delete', `Deleted account for ${target.name}`);
    return { ok: true };
  });

  route('PUT', '/api/settings', ({ user, body }) => {
    requireRole(user, 'admin');
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (body.company_name !== undefined) upsert.run('company_name', str(body.company_name, 'Company name', { max: 100 }));
    if (body.currency !== undefined) upsert.run('currency', str(body.currency, 'Currency', { required: true, max: 10 }).toUpperCase());
    return { ok: true };
  });

  // --- Dispatcher ----------------------------------------------------------

  function serveStatic(req, res, pathname) {
    let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 10 * 1024 * 1024) {
          reject(new HttpError(413, 'Request too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  return async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
      return serveStatic(req, res, pathname);
    }

    try {
      const match = routes.map((r) => ({ r, m: req.method === r.method && pathname.match(r.re) })).find((x) => x.m);
      if (!match) throw new HttpError(404, 'Not found');
      let body = {};
      if (req.method !== 'GET') {
        // Requiring a JSON content type blocks cross-site form posts (CSRF).
        const ct = String(req.headers['content-type'] || '');
        const raw = await readBody(req);
        if (raw) {
          if (!ct.startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
          try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
        } else if (req.method !== 'DELETE' && pathname !== '/api/logout' && !ct.startsWith('application/json')) {
          throw new HttpError(415, 'Expected JSON');
        }
        if (!body || typeof body !== 'object') body = {};
      }
      const params = {};
      match.r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match.m[i + 1]); });
      const result = await match.r.handler({ req, res, body, params, query: url.searchParams, user: currentUser(req) });
      if (result !== undefined && !res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong' : e.message }));
      }
    }
  };
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

function ensureAdmin(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, 'admin', ?)")
    .run(username, process.env.ADMIN_NAME || 'Administrator', hashPassword(password));
  return { username, password, generated };
}

if (require.main === module) {
  const dbFile = process.env.DATABASE_FILE || path.join(__dirname, 'data', 'invoices.db');
  const db = openDatabase(dbFile);
  const created = ensureAdmin(db);
  if (created) {
    console.log('='.repeat(60));
    console.log('Created the first admin account:');
    console.log(`  username: ${created.username}`);
    if (created.generated) console.log(`  password: ${created.password}   <- change this after signing in`);
    else console.log('  password: (from ADMIN_PASSWORD)');
    console.log('='.repeat(60));
  }
  const port = Number(process.env.PORT || 3000);
  http.createServer(createApp(db)).listen(port, () => {
    console.log(`Invoice tracker running on http://localhost:${port}  (database: ${dbFile})`);
  });
}

module.exports = { createApp, openDatabase, ensureAdmin, hashPassword };
