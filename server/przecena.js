'use strict';
/*
 * «Пшецена»: список товарів з коротким терміном (експорт зі звіту Power BI Żabka «Lista indeksów z niskim terminem ważności»).
 * Адміністратор надсилає файл .xlsx/.csv боту в Telegram або завантажує в програмі.
 * Програма порівнює з попереднім списком і лише для НОВИХ товарів створює завдання працівнику на зміні.
 */
const ExcelJS = require('exceljs');
const { db, all, get, run, setting, tx } = require('./db');
const L = require('./logic');
const { notifyAdmins, notify } = require('./notify');
const tasks = require('./tasks');

db.exec(`
CREATE TABLE IF NOT EXISTS przecena_items (
  location_id INTEGER NOT NULL, indeks TEXT NOT NULL, opis TEXT, grupa TEXT, qty REAL, price REAL, mpk TEXT,
  first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(location_id, indeks));
CREATE TABLE IF NOT EXISTS przecena_imports (id INTEGER PRIMARY KEY, location_id INTEGER, at TEXT DEFAULT (datetime('now')), by INTEGER, source TEXT, rows INTEGER, new_count INTEGER, task_id INTEGER);
`);

const cellText = v => {
  if (v == null) return '';
  if (typeof v === 'object') { if (v.richText) return v.richText.map(x => x.text).join(''); if (v.result != null) return String(v.result); if (v.text) return String(v.text); if (v instanceof Date) return v.toISOString().slice(0, 10); }
  return String(v).trim();
};
const num = s => { const n = Number(String(s).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Читає таблицю з файлу: шукає рядок із заголовком «INDEKS». */
async function parse(buffer, filename = '') {
  let rows = [];
  if (/\.csv$/i.test(filename) || buffer.slice(0, 2).toString() !== 'PK') {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    rows = text.split(/\r?\n/).map(l => l.split(delim).map(c => c.replace(/^"|"$/g, '').trim()));
  } else {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    ws.eachRow({ includeEmpty: false }, r => { const vals = []; r.eachCell({ includeEmpty: true }, (c, i) => { vals[i - 1] = cellText(c.value); }); rows.push(vals.map(v => v ?? '')); });
  }
  const hi = rows.findIndex(r => r.some(c => norm(c) === 'indeks'));
  if (hi < 0) throw Object.assign(new Error('У файлі не знайдено колонку «INDEKS». Надішліть експорт зі звіту «Lista indeksów z niskim terminem ważności».'), { status: 400 });
  const head = rows[hi].map(norm);
  const col = (...names) => head.findIndex(h => names.some(n => h === n || h.startsWith(n)));
  const ci = { mpk: col('mpk'), indeks: col('indeks'), opis: col('opis'), grupa: col('material gr1', 'material'), qty: col('zapas', 'ilość', 'ilosc'), price: col('cena') };
  const items = [];
  for (const r of rows.slice(hi + 1)) {
    const indeks = String(r[ci.indeks] || '').trim();
    if (!/^\d{3,}$/.test(indeks)) continue; // підсумки, примітки фільтрів тощо
    items.push({ mpk: ci.mpk >= 0 ? String(r[ci.mpk] || '').trim() : '', indeks, opis: ci.opis >= 0 ? r[ci.opis] : '', grupa: ci.grupa >= 0 ? r[ci.grupa] : '', qty: ci.qty >= 0 ? num(r[ci.qty]) : null, price: ci.price >= 0 ? num(r[ci.price]) : null });
  }
  return items;
}

/** Локація для файлу: за кодом MPK (запам'ятовується), інакше закріплена локація адміністратора. */
function locationFor(mpk, user) {
  if (mpk) { const id = setting('mpk_' + mpk.toUpperCase()); if (id && get('SELECT 1 FROM locations WHERE id=? AND active=1', Number(id))) return Number(id); }
  const home = get('SELECT id FROM locations WHERE active=1 AND (admin_id=? OR deputy_id=?) ORDER BY id LIMIT 1', user.id, user.id)
    || get("SELECT id FROM locations WHERE active=1 AND name LIKE 'Nadwi%' LIMIT 1") || get('SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1');
  const id = home && home.id;
  if (mpk && id) setting('mpk_' + mpk.toUpperCase(), id);
  return id;
}

const fmtItem = i => `${i.opis || i.indeks}${i.qty != null ? ` ×${i.qty}` : ''}${i.price != null ? ` — ${i.price.toFixed(2).replace('.', ',')} zł` : ''}`;

/** Імпорт: оновлює список і створює завдання лише для нових товарів. Повертає текст звіту для бота/екрана. */
async function importFile(buffer, filename, user, source) {
  const items = await parse(buffer, filename);
  if (!items.length) return { text: '⚠️ У файлі немає жодного товару (можливо, звіт порожній або не той файл).', results: [] };
  const byLoc = new Map();
  for (const it of items) { const loc = locationFor(it.mpk, user); if (!byLoc.has(loc)) byLoc.set(loc, []); byLoc.get(loc).push(it); }
  const results = [];
  for (const [locId, list] of byLoc) {
    const loc = get('SELECT * FROM locations WHERE id=?', locId);
    const before = new Set(all('SELECT indeks FROM przecena_items WHERE location_id=? AND active=1', locId).map(r => r.indeks));
    const fresh = list.filter(i => !before.has(i.indeks));
    tx(() => {
      run('UPDATE przecena_items SET active=0 WHERE location_id=?', locId);
      for (const i of list) run(`INSERT INTO przecena_items(location_id,indeks,opis,grupa,qty,price,mpk,first_seen,last_seen,active) VALUES(?,?,?,?,?,?,?,datetime('now'),datetime('now'),1)
        ON CONFLICT(location_id,indeks) DO UPDATE SET opis=excluded.opis, grupa=excluded.grupa, qty=excluded.qty, price=excluded.price, mpk=excluded.mpk, last_seen=excluded.last_seen, active=1,
        first_seen=CASE WHEN przecena_items.active=0 AND przecena_items.last_seen < datetime('now','-1 day') THEN excluded.first_seen ELSE przecena_items.first_seen END`, locId, i.indeks, i.opis, i.grupa, i.qty, i.price, i.mpk);
    });
    let taskId = null;
    if (fresh.length) {
      const rep = require('./reportembed').cfgFor(locId);
      const head = `🏷️ Пшецена — нові товари (${fresh.length}): `;
      let body = fresh.map(fmtItem).join('; ');
      const tail = '. Повний список — у вкладці «Пшецена».';
      if ((head + body + tail).length > 500) body = body.slice(0, 500 - head.length - tail.length - 1) + '…';
      taskId = tasks.createSystemTask({ location_id: locId, date: L.warsawNow().date, target: 'slot', slot: rep.slot || 's1', text: head + body + tail });
      notifyAdmins(locId, `🏷️ Пшецена: нових товарів ${fresh.length} — завдання створено.`, 'task', user.id);
    }
    run('INSERT INTO przecena_imports(location_id,by,source,rows,new_count,task_id) VALUES(?,?,?,?,?,?)', locId, user.id, source, list.length, fresh.length, taskId);
    L.audit(user, locId, 'przecena_import', { source, rows: list.length, new: fresh.length, task: taskId || '' });
    results.push({ location: loc.name, rows: list.length, fresh: fresh.length, taskId, freshItems: fresh });
  }
  const text = results.map(r => r.fresh
    ? `✅ ${r.location}: товарів у списку ${r.rows}, нових ${r.fresh} — завдання «Пшецена» створено для працівника на зміні.\n• ${r.freshItems.slice(0, 15).map(fmtItem).join('\n• ')}${r.fresh > 15 ? `\n… і ще ${r.fresh - 15}` : ''}`
    : `👌 ${r.location}: товарів у списку ${r.rows}, нових немає — завдання не створюю.`).join('\n\n');
  return { text, results };
}

/** Нагадування адміністратору в Telegram раз на тиждень (типово понеділок 12:00): «перевірте звіт і надішліть файл». */
if (!setting('mig_pz_weekly')) { setting('pz_remind_dow', 0); setting('pz_remind_time', '12:00'); setting('mig_pz_weekly', 1); }
const remindCfg = () => ({ on: setting('pz_remind_on') !== '0', dow: Number(setting('pz_remind_dow') ?? 0), time: setting('pz_remind_time') || '12:00' });
function remind() {
  const c = remindCfg(); if (!c.on) return;
  const now = L.warsawNow();
  if (L.dow(now.date) !== c.dow || now.min < L.parseHM(c.time) || setting('pz_remind_last') === now.date) return;
  setting('pz_remind_last', now.date);
  for (const l of all('SELECT DISTINCT location_id id FROM przecena_imports')) {
    const loc = get('SELECT * FROM locations WHERE id=? AND active=1', l.id); if (!loc) continue;
    const today = get("SELECT 1 FROM przecena_imports WHERE location_id=? AND date(at, '+1 hour') >= ?", l.id, now.date);
    if (today) continue;
    const ids = new Set([loc.admin_id, loc.deputy_id].filter(Boolean));
    if (!ids.size) for (const a of all("SELECT id FROM users WHERE role IN ('admin','owner') AND active=1")) ids.add(a.id);
    for (const id of ids) notify(id, `🏷️ ${loc.name}: перевірте звіт «Lista indeksów z niskim terminem ważności» і надішліть сюди файл (експорт .xlsx) — нові товари на пшецену отримають працівники.`, 'task');
  }
}

function register(app, h) {
  const { wrap, needMember, bad, forbid } = h;
  setInterval(remind, 5 * 60 * 1000); setTimeout(remind, 15000);
  app.get('/api/przecena/remind', wrap(req => { if (!L.isAdminUser(req.user)) forbid(); return remindCfg(); }));
  app.put('/api/przecena/remind', wrap(req => {
    if (!L.isAdminUser(req.user)) forbid();
    const tm = L.parseHM(req.body.time); if (tm == null || isNaN(tm)) bad(req.t('err_time_format'));
    const dw = Number(req.body.dow); if (!(dw >= 0 && dw <= 6)) bad(req.t('err_required'));
    setting('pz_remind_on', req.body.on ? '1' : '0'); setting('pz_remind_time', L.hm(tm)); setting('pz_remind_dow', dw);
    L.audit(req.user, null, 'przecena_remind', remindCfg());
    return remindCfg();
  }));
  app.get('/api/przecena', wrap(req => {
    const locId = Number(req.query.loc); needMember(req, locId);
    const last = get('SELECT p.*, u.name by_name FROM przecena_imports p LEFT JOIN users u ON u.id=p.by WHERE location_id=? ORDER BY id DESC LIMIT 1', locId);
    const lastAt = last ? last.at : null;
    const items = all('SELECT * FROM przecena_items WHERE location_id=? AND active=1 ORDER BY grupa, opis', locId)
      .map(i => ({ ...i, is_new: !!(lastAt && i.first_seen >= lastAt) }));
    return { items, last };
  }));
  app.post('/api/przecena/import', async (req, res) => {
    try {
      if (!L.isAdminUser(req.user)) return res.status(403).json({ error: 'forbidden' });
      const b = req.body || {};
      if (!b.data) return res.status(400).json({ error: 'no file' });
      const r = await importFile(Buffer.from(String(b.data), 'base64'), String(b.name || ''), req.user, 'app');
      res.json(r);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
}
module.exports = { register, importFile, parse };
