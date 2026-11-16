'use strict';
/*
 * Вхідні сигнали (webhook) → «Завдання від адміністратора».
 * Наприклад: оповіщення Power BI → Power Automate → POST https://<програма>/hooks/task?key=<ключ>
 * Тіло: JSON {"text": "...", "location": "Dietla" | 2 | "all", "slot": "s1|s2|rs|dl", "date": "YYYY-MM-DD", "due": "HH:MM"}
 * або простий текст. Захищено секретним ключем; повтори того самого завдання протягом 12 год ігноруються.
 */
const crypto = require('crypto');
const express = require('express');
const { db, all, get, run, setting } = require('./db');
const L = require('./logic');
const { notifyAdmins } = require('./notify');
const tasks = require('./tasks');

db.exec(`CREATE TABLE IF NOT EXISTS hook_log (id INTEGER PRIMARY KEY, at TEXT DEFAULT (datetime('now')), ok INTEGER, info TEXT);`);

const key = () => { let k = setting('hook_key'); if (!k) { k = crypto.randomBytes(18).toString('hex'); setting('hook_key', k); } return k; };
const cfg = () => ({ enabled: setting('hook_enabled') !== '0', loc: setting('hook_loc') || 'all', target: setting('hook_target') || 'all', prefix: setting('hook_prefix') ?? '📊 ' });
const log = (ok, info) => { run('INSERT INTO hook_log(ok, info) VALUES(?,?)', ok ? 1 : 0, String(info).slice(0, 500)); run('DELETE FROM hook_log WHERE id NOT IN (SELECT id FROM hook_log ORDER BY id DESC LIMIT 50)'); };
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Локації з поля location: id, частина назви («Dietla»), «all»/порожньо — за налаштуванням. */
function resolveLocations(v) {
  const locs = all('SELECT * FROM locations WHERE active=1 ORDER BY sort,id');
  const want = v == null || v === '' ? cfg().loc : v;
  if (String(want).toLowerCase() === 'all' || want === '*') return locs;
  const s = String(want).trim().toLowerCase();
  if (/^\d+$/.test(s)) return locs.filter(l => String(l.id) === s); // номер локації — лише за id
  return locs.filter(l => l.name.toLowerCase().includes(s));
}

/** Створює завдання з вхідного сигналу. Повертає {created:[...], skipped:[...]} */
function handle(body, query) {
  const c = cfg();
  const p = typeof body === 'string' ? { text: body } : { ...(body || {}) };
  for (const k of ['text', 'location', 'slot', 'date', 'due']) if (p[k] == null && query[k] != null) p[k] = query[k];
  let given = String(p.text || p.title || p.message || p.Message || p.Title || '').trim();
  // без тексту — береться текст завдання зі звіту локації (напр. «🏷️ Пшецена…»)
  const textFor = l => given ? (c.prefix || '') + given.slice(0, 480) : (require('./reportembed').cfgFor(l.id).url ? require('./reportembed').cfgFor(l.id).text : '');
  const locs = resolveLocations(p.location);
  if (!locs.length) throw Object.assign(new Error('location not found'), { status: 400 });
  const now = L.warsawNow();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : now.date;
  const slot = ['s1', 's2', 'rs', 'dl'].includes(p.slot) ? p.slot : (['s1', 's2', 'rs', 'dl'].includes(c.target) ? c.target : null);
  const due = p.due ? L.parseHM(p.due) : null;
  const created = [], skipped = [];
  for (const l of locs) {
    const text = textFor(l);
    if (!text) { skipped.push(`${l.name}: немає тексту і не налаштовано звіт`); continue; }
    // для завдання зі звіту (без тексту в сигналі) — зміна з налаштувань звіту
    const sl = (!given && !['s1', 's2', 'rs', 'dl'].includes(p.slot)) ? require('./reportembed').cfgFor(l.id).slot : slot;
    if (sl === 'rs' && !l.has_restock) { skipped.push(`${l.name}: немає докладки`); continue; }
    const dup = get("SELECT id FROM tasks WHERE deleted=0 AND location_id=? AND date=? AND text=? AND created_at >= datetime('now','-12 hours')", l.id, date, text);
    if (dup) { skipped.push(`${l.name}: уже є (#${dup.id})`); continue; }
    const id = tasks.createSystemTask({ location_id: l.id, date, target: sl ? 'slot' : 'all', slot: sl, text, due: due != null && !isNaN(due) ? due : null });
    created.push(`${l.name} #${id}`);
    notifyAdmins(l.id, `📊 Power BI → завдання (${date}): ${text}`, 'task');
  }
  if (!created.length && !skipped.length) throw Object.assign(new Error('text is required'), { status: 400 });
  return { created, skipped, date };
}

function register(app, h) {
  const { wrap, bad, forbid } = h;
  const receive = (req, res) => {
    try {
      const c = cfg();
      const k = req.headers['x-hook-key'] || req.query.key;
      if (!safeEq(k, key())) { log(false, 'неправильний ключ'); return res.status(403).json({ ok: false, error: 'bad key' }); }
      if (!c.enabled) { log(false, 'вимкнено в налаштуваннях'); return res.status(423).json({ ok: false, error: 'disabled' }); }
      if ((req.body && req.body.test === true) || req.query.test === '1') { log(true, 'тестовий сигнал — зв\'язок працює (завдання не створено)'); return res.json({ ok: true, test: true, created: [], skipped: [] }); }
      const r = handle(req.body, req.query);
      log(true, `створено: ${r.created.join(', ') || '—'}${r.skipped.length ? '; пропущено: ' + r.skipped.join(', ') : ''}`);
      res.json({ ok: true, ...r });
    } catch (e) { log(false, e.message); res.status(e.status || 500).json({ ok: false, error: e.message }); }
  };
  app.post('/hooks/task', express.text({ type: ['text/*'] }), receive);
  app.get('/hooks/task', receive);

  const needAnyAdmin = req => { if (!L.isAdminUser(req.user)) forbid(); };
  const view = req => {
    const base = require('./telegram').status().public_url || `${(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    return { ...cfg(), url: `${base}/hooks/task?key=${key()}`, log: all('SELECT * FROM hook_log ORDER BY id DESC LIMIT 15') };
  };
  app.get('/api/hooks/settings', wrap(req => { needAnyAdmin(req); return view(req); }));
  app.put('/api/hooks/settings', wrap(req => {
    needAnyAdmin(req);
    const b = req.body;
    if (b.enabled != null) setting('hook_enabled', b.enabled ? '1' : '0');
    if (b.loc != null) setting('hook_loc', String(b.loc));
    if (b.target != null) { if (!['all', 's1', 's2', 'rs', 'dl'].includes(b.target)) bad('target'); setting('hook_target', b.target); }
    if (b.prefix != null) setting('hook_prefix', String(b.prefix).slice(0, 10));
    L.audit(req.user, null, 'hook_settings', { enabled: cfg().enabled, loc: cfg().loc, target: cfg().target });
    return view(req);
  }));
  app.post('/api/hooks/regenerate', wrap(req => {
    needAnyAdmin(req);
    setting('hook_key', crypto.randomBytes(18).toString('hex'));
    L.audit(req.user, null, 'hook_settings', { key: 'regenerated' });
    return view(req);
  }));
}
module.exports = { register, handle };
