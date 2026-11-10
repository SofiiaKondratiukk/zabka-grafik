'use strict';
/* Premie, kary, minusy (manko) i zaliczki — doповнення до основної програми. */
const crypto = require('crypto');
const { db, all, get, run, tx, setting } = require('./db');
const L = require('./logic');
const { notify } = require('./notify');
const { tr } = require('../public/i18n.js');

db.exec(`
CREATE TABLE IF NOT EXISTS money_entries (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL, user_id INTEGER NOT NULL, date TEXT NOT NULL,
  kind TEXT NOT NULL, amount REAL NOT NULL, comment TEXT NOT NULL, method TEXT, shift_id INTEGER, group_id TEXT,
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted INTEGER NOT NULL DEFAULT 0, deleted_by INTEGER, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS ix_money ON money_entries(location_id, date);
`);
// одноразова міграція: ставка Nadia 25 zł/год
if (!setting('mig_nadia_25')) { run("UPDATE users SET rate=25 WHERE login='nadia'"); setting('mig_nadia_25', 1); }

const KINDS = ['bonus', 'fine', 'shortage', 'advance'];
const SIGN = { bonus: 1, fine: -1, shortage: -1, advance: -1 };
const r2 = x => Math.round(x * 100) / 100;
const locName = id => (get('SELECT name FROM locations WHERE id=?', id) || {}).name || '';
const tFor = uid => { const u = get('SELECT lang FROM users WHERE id=?', uid); return (k, p) => tr((u && u.lang) || 'uk', k, p); };

function entries(locIds, from, to, userId) {
  if (!locIds.length) return [];
  const ph = locIds.map(() => '?').join(',');
  return all(`SELECT * FROM money_entries WHERE deleted=0 AND location_id IN (${ph}) AND date BETWEEN ? AND ? ${userId ? 'AND user_id=' + Number(userId) : ''} ORDER BY date, id`, ...locIds, from, to);
}
/** Map key → {bonus, fine, shortage, advance} */
function sums(list, keyFn = e => e.user_id) {
  const m = new Map();
  for (const e of list) {
    const k = keyFn(e);
    if (!m.has(k)) m.set(k, { bonus: 0, fine: 0, shortage: 0, advance: 0 });
    m.get(k)[e.kind] = r2(m.get(k)[e.kind] + e.amount);
  }
  return m;
}
const empty = () => ({ bonus: 0, fine: 0, shortage: 0, advance: 0 });
/** НАРАХОВАНО = години + палети + премії − штрафи − мінуси; ДО ВИПЛАТИ = НАРАХОВАНО − аванси */
function settle(pay, s) {
  const accrued = r2(pay + s.bonus - s.fine - s.shortage);
  return { accrued, to_pay: r2(accrued - s.advance) };
}
function shiftLabel(s, t) { return s ? `${s.date} ${t('slot_' + s.slot)} ${L.hm(s.start)}–${L.hm(s.end)}` : ''; }
function describe(e, t) {
  const sign = e.kind === 'advance' ? '' : (SIGN[e.kind] > 0 ? '+' : '−');
  return `${t('mk_' + e.kind)} ${sign}${e.amount.toFixed(2)} zł`;
}

function warsawOf(utc) {
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  const s = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [dd, tt] = s.split(' '); const [h, m] = tt.split(':').map(Number);
  return { date: dd, min: h * 60 + m };
}

/** Попередження: аванси > заробленого; від'ємна сума до виплати. */
function warnings(locIds, from, to, t) {
  const { aggregate } = require('./reports');
  const now = L.warsawNow();
  const out = [];
  const months = new Set();
  for (let d = from.slice(0, 7) + '-01'; d <= to && d <= now.date; d = L.monthRange(d.slice(0, 7))[1], d = L.addDays(d, 1)) months.add(d.slice(0, 7));
  for (const locId of locIds) for (const m of months) {
    const [mf, mt] = L.monthRange(m);
    const ag = new Map(aggregate(L.computeRecords([locId], mf, mt)).map(a => [a.user_id, a]));
    const ms = sums(entries([locId], mf, mt));
    for (const [uid, s] of ms) {
      const pay = ag.has(uid) ? ag.get(uid).pay : 0;
      const gross = r2(pay + s.bonus);
      const { to_pay } = settle(pay, s);
      const date = mt < now.date ? mt : now.date;
      if (s.advance > 0 && s.advance > gross) out.push({ key: `adv:${locId}:${uid}:${m}`, location_id: locId, date, kind: 'money', text: t('warn_advance', { name: L.userName(uid), month: m, adv: s.advance.toFixed(2), earned: gross.toFixed(2) }) });
      else if (to_pay < 0) out.push({ key: `neg:${locId}:${uid}:${m}`, location_id: locId, date, kind: 'money', text: t('warn_negative', { name: L.userName(uid), month: m, sum: to_pay.toFixed(2) }) });
    }
  }
  return out;
}

function register(app, h) {
  const { wrap, needAdmin, needMember, bad } = h;
  const checkOpen = (req, locId, date) => {
    if (L.isClosed(locId, date) && req.user.role !== 'owner') bad(req.t('err_month_closed_money', { month: L.monthOf(date) }));
  };

  app.get('/api/money', wrap(req => {
    const locIds = req.query.loc === 'all' ? L.adminLocIds(req.user) : [Number(req.query.loc)];
    locIds.forEach(l => needAdmin(req, l));
    const now = L.warsawNow(); const [mf, mt] = L.monthRange(L.monthOf(now.date));
    return entries(locIds, req.query.from || mf, req.query.to || mt, req.query.user).map(e => ({ ...e, user_name: L.userName(e.user_id), created_name: L.userName(e.created_by), location: locName(e.location_id) }));
  }));

  app.post('/api/money', wrap(req => {
    const b = req.body; const t = req.t; const locId = Number(b.location_id);
    needAdmin(req, locId);
    if (!KINDS.includes(b.kind)) bad(t('err_required'));
    const comment = String(b.comment || '').trim(); if (!comment) bad(t('err_comment_required'));
    let date = b.date; let shift = null;
    if (b.shift_id) { shift = get('SELECT * FROM shifts WHERE id=?', Number(b.shift_id)); if (!shift || shift.location_id !== locId) bad(t('err_pick_shift')); date = shift.date; }
    if (b.kind === 'shortage' && !shift) bad(t('err_pick_shift'));
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) bad(t('err_required'));
    checkOpen(req, locId, date);
    const parts = b.kind === 'shortage' && Array.isArray(b.split) && b.split.length ? b.split : [{ user_id: b.user_id, amount: b.amount }];
    const members = new Set(all('SELECT user_id FROM user_locations WHERE location_id=?', locId).map(r => r.user_id));
    for (const p of parts) {
      p.user_id = Number(p.user_id); p.amount = r2(Number(p.amount));
      if (!p.user_id || !members.has(p.user_id)) bad(t('err_not_member', { name: L.userName(p.user_id) || '?' }));
      if (!(p.amount > 0)) bad(t('err_amount'));
    }
    if (new Set(parts.map(p => p.user_id)).size !== parts.length) bad(t('err_duplicate_worker'));
    const method = b.kind === 'advance' ? (b.method === 'transfer' ? 'transfer' : 'cash') : null;
    const group = parts.length > 1 ? crypto.randomBytes(6).toString('hex') : null;
    const ids = [];
    tx(() => {
      for (const p of parts) {
        const r = run('INSERT INTO money_entries(location_id,user_id,date,kind,amount,comment,method,shift_id,group_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)', locId, p.user_id, date, b.kind, p.amount, comment, method, shift ? shift.id : null, group, req.user.id);
        ids.push(Number(r.lastInsertRowid));
      }
      L.audit(req.user, locId, 'money_add', { kind: b.kind, date, shift: shift ? shiftLabel(shift, t) : '', parts: parts.map(p => `${L.userName(p.user_id)} ${p.amount.toFixed(2)} zł`), method, comment });
    });
    for (const p of parts) {
      const tt = tFor(p.user_id);
      notify(p.user_id, tt('n_money', { loc: locName(locId), what: describe({ kind: b.kind, amount: p.amount }, tt), date, comment, method: method ? ' (' + tt('method_' + method) + ')' : '', shift: shift ? ' · ' + shiftLabel(shift, tt) : '' }), 'money');
    }
    return { ids };
  }));

  app.delete('/api/money/:id', wrap(req => {
    const e = get('SELECT * FROM money_entries WHERE id=? AND deleted=0', Number(req.params.id)); if (!e) bad('not found');
    needAdmin(req, e.location_id); checkOpen(req, e.location_id, e.date);
    run("UPDATE money_entries SET deleted=1, deleted_by=?, deleted_at=datetime('now') WHERE id=?", req.user.id, e.id);
    L.audit(req.user, e.location_id, 'money_delete', { kind: e.kind, user: L.userName(e.user_id), date: e.date, amount: e.amount, comment: e.comment });
    const tt = tFor(e.user_id);
    notify(e.user_id, tt('n_money_deleted', { what: describe(e, tt), date: e.date }), 'money');
    return { ok: true };
  }));

  // картки змін за день
  app.get('/api/shift-cards/:loc', wrap(req => {
    const locId = Number(req.params.loc); needAdmin(req, locId);
    const now = L.warsawNow();
    const date = req.query.date || now.date;
    const shifts = all("SELECT * FROM shifts WHERE location_id=? AND date=? AND slot IN ('s1','s2','rs') AND user_id IS NOT NULL ORDER BY start", locId, date);
    const adj = all('SELECT * FROM adjustments WHERE deleted=0 AND location_id=? AND date=?', locId, date);
    const del = get('SELECT * FROM deliveries WHERE location_id=? AND date=?', locId, date);
    const dl = get("SELECT * FROM shifts WHERE location_id=? AND date=? AND slot='dl'", locId, date);
    const money = entries([locId], date, date);
    const notes = all('SELECT n.*, u.name author FROM notes n JOIN users u ON u.id=n.author_id WHERE n.location_id=? AND n.created_at BETWEEN ? AND ?', locId, L.addDays(date, -1) + ' 00:00', L.addDays(date, 1) + ' 23:59')
      .map(n => ({ ...n, local: warsawOf(n.created_at) })).filter(n => n.local.date === date);
    const cards = shifts.map(s => {
      const ended = !s.cancelled && (date < now.date || (date === now.date && s.end <= now.min));
      return {
        id: s.id, slot: s.slot, user_id: s.user_id, name: L.userName(s.user_id), start: s.start, end: s.end, cancelled: s.cancelled, ended,
        plan: s.plan_user_id ? `${L.userName(s.plan_user_id)} ${L.hm(s.plan_start)}–${L.hm(s.plan_end)}` : '',
        changed: s.plan_user_id && (s.plan_user_id !== s.user_id || s.plan_start !== s.start || s.plan_end !== s.end),
        extra: adj.filter(a => a.user_id === s.user_id).map(a => ({ kind: a.kind, minutes: a.minutes, comment: a.comment, approved: L.userName(a.approved_by) })),
        pallets: del && del.pallets != null && del.user_id === s.user_id ? del.pallets : null,
        money: money.filter(e => e.shift_id === s.id || (!e.shift_id && e.user_id === s.user_id)).map(e => ({ ...e, user_name: L.userName(e.user_id), created_name: L.userName(e.created_by) })),
        notes: notes.filter(n => n.author_id === s.user_id || (n.local.min >= s.start && n.local.min <= s.end + 30)).map(n => ({ text: n.text, author: n.author, time: L.hm(n.local.min), resolved: !!n.resolved_at })),
      };
    });
    return { date, closed: L.isClosed(locId, date), cards, delivery: del && del.pallets != null ? { name: L.userName(del.user_id), pallets: del.pallets } : (dl ? { name: L.userName(dl.user_id), pallets: null } : null) };
  }));

  // «Мої години»: записи працівника за місяць
  app.get('/api/my/money', wrap(req => {
    const month = req.query.month || L.monthOf(L.warsawNow().date);
    const [from, to] = L.monthRange(month);
    const locIds = all('SELECT id FROM locations').map(r => r.id);
    const list = entries(locIds, from, to, req.user.id).map(e => {
      const s = e.shift_id && get('SELECT * FROM shifts WHERE id=?', e.shift_id);
      return { id: e.id, date: e.date, kind: e.kind, amount: e.amount, comment: e.comment, method: e.method, location: locName(e.location_id), shift: s ? s.slot : null, created_name: L.userName(e.created_by), created_at: e.created_at };
    });
    return { month, entries: list, sums: sums(list, () => 'me').get('me') || empty() };
  }));
}

module.exports = { register, entries, sums, settle, empty, warnings, describe, SIGN, KINDS };
