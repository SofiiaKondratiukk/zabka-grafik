'use strict';
/*
 * «Урлоп» — відпустки працівників з підтвердженням адміністратора. Доповнення до основної програми.
 * Правило: в один день урлоп може мати не більше N людей (типово 1) з УСІХ локацій разом.
 * Дні, зайняті іншим працівником (запит очікує або підтверджено), взяти не можна — навіть надіслати запит.
 */
const { db, all, get, run, setting } = require('./db');
const L = require('./logic');
const { notify, adminRecipients } = require('./notify');
const { tr } = require('../public/i18n.js');

db.exec(`
CREATE TABLE IF NOT EXISTS vacations (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_by INTEGER, created_at TEXT DEFAULT (datetime('now')),
  decided_by INTEGER, decided_at TEXT, decision_comment TEXT);
CREATE INDEX IF NOT EXISTS ix_vac ON vacations(start, end);
`);

const ACTIVE = "('pending','approved')";
const tFor = uid => { const u = get('SELECT lang FROM users WHERE id=?', uid); return (k, p) => tr((u && u.lang) || 'uk', k, p); };
const maxPerDay = () => Math.max(1, Number(setting('vac_max_per_day') || 1));
const userLocs = uid => all('SELECT ul.location_id FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=? AND l.active=1', uid).map(r => r.location_id);
const ddmm = d => d.slice(8, 10) + '.' + d.slice(5, 7);
const fmtRange = v => v.start === v.end ? ddmm(v.start) : `${ddmm(v.start)}–${ddmm(v.end)}`;
const days = v => L.dates(v.start, v.end).length;

/** Урлопи (очікують / підтверджені) працівників указаних локацій, що перетинають період. */
function activeAt(locIds, from, to) {
  if (!locIds.length) return [];
  const ph = locIds.map(() => '?').join(',');
  return all(`SELECT DISTINCT v.* FROM vacations v JOIN user_locations ul ON ul.user_id=v.user_id
    WHERE ul.location_id IN (${ph}) AND v.status IN ${ACTIVE} AND v.start<=? AND v.end>=? ORDER BY v.start`, ...locIds, to, from);
}
/**
 * Які дні періоду вже зайняті для цього працівника (на будь-якій з його локацій ліміт досягнуто іншими людьми).
 * Повертає [{date, location, people:[{name, range}]}].
 */
const locNames = uid => userLocs(uid).map(id => (get('SELECT name FROM locations WHERE id=?', id) || {}).name).join(', ');
/** Усі урлопи (очікують / підтверджені) з усіх локацій, що перетинають період. */
const activeAll = (from, to) => all(`SELECT * FROM vacations WHERE status IN ${ACTIVE} AND start<=? AND end>=? ORDER BY start`, to, from);
function conflicts(uid, start, end, excludeId) {
  const out = []; const max = maxPerDay();
  const others = activeAll(start, end).filter(v => v.user_id !== uid && v.id !== excludeId);
  for (const d of L.dates(start, end)) {
    const on = others.filter(v => v.start <= d && v.end >= d);
    if (on.length >= max) out.push({ date: d, people: on.map(v => ({ name: L.userName(v.user_id), range: fmtRange(v), location: locNames(v.user_id) })) });
  }
  return out;
}
/** Короткий текст конфлікту: «Настя 02.02–14.02 (Nadwiślańska 11)». */
function conflictText(list) {
  const seen = new Map();
  for (const c of list) for (const p of c.people) seen.set(p.name + p.range, `${p.name} ${p.range} (${p.location})`);
  return [...seen.values()].join(', ');
}
function view(v, viewer) {
  const mine = v.user_id === viewer.id;
  const admin = L.isAdminUser(viewer);
  return { id: v.id, user_id: v.user_id, name: L.userName(v.user_id), start: v.start, end: v.end, days: days(v), status: v.status, mine,
    comment: (mine || admin) ? v.comment : null, decision_comment: (mine || admin) ? v.decision_comment : null,
    created_at: v.created_at, created_name: L.userName(v.created_by), decided_name: L.userName(v.decided_by), decided_at: v.decided_at };
}

function register(app, h) {
  const { wrap, needMember, bad, forbid } = h;
  const needAnyAdmin = req => { if (!L.isAdminUser(req.user)) forbid(); };
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

  // список урлопів локації (працівник бачить урлопи колег своєї локації: хто і коли)
  app.get('/api/vacations', wrap(req => {
    const locId = Number(req.query.loc); needMember(req, locId);
    const now = L.warsawNow();
    const from = isDate(req.query.from) ? req.query.from : L.addDays(now.date, -31);
    const to = isDate(req.query.to) ? req.query.to : L.addDays(now.date, 400);
    const list = activeAll(from, to).map(v => ({ ...view(v, req.user), location: locNames(v.user_id) })); // урлопи з усіх локацій
    const mineAll = all('SELECT * FROM vacations WHERE user_id=? AND end>=? ORDER BY start DESC LIMIT 50', req.user.id, L.addDays(now.date, -365)).map(v => view(v, req.user));
    const workers = all('SELECT u.id, u.name FROM users u JOIN user_locations ul ON ul.user_id=u.id WHERE ul.location_id=? AND u.active=1 ORDER BY u.name', locId);
    return { max: maxPerDay(), today: now.date, list, mine: mineAll, workers: L.isAdminUser(req.user) ? workers : undefined,
      pending: L.isAdminUser(req.user) ? all("SELECT * FROM vacations WHERE status='pending' ORDER BY start").map(v => ({ ...view(v, req.user), locations: userLocs(v.user_id).map(id => (get('SELECT name FROM locations WHERE id=?', id) || {}).name).join(', ') })) : undefined };
  }));

  // перевірка дат до надсилання (для підказки «ці дні вже зайняті»)
  app.get('/api/vacations/check', wrap(req => {
    const uid = L.isAdminUser(req.user) && req.query.user ? Number(req.query.user) : req.user.id;
    if (!isDate(req.query.start) || !isDate(req.query.end) || req.query.start > req.query.end) return { ok: false, error: req.t('err_vac_dates') };
    const c = conflicts(uid, req.query.start, req.query.end);
    return { ok: !c.length, days: L.dates(req.query.start, req.query.end).length, busy: c.map(x => x.date), text: c.length ? req.t('vac_busy', { who: conflictText(c) }) : '' };
  }));

  app.post('/api/vacations', wrap(req => {
    const b = req.body; const t = req.t;
    const admin = L.isAdminUser(req.user);
    const uid = admin && b.user_id ? Number(b.user_id) : req.user.id;
    const u = get('SELECT * FROM users WHERE id=? AND active=1', uid); if (!u) bad(t('err_required'));
    if (!isDate(b.start) || !isDate(b.end) || b.start > b.end) bad(t('err_vac_dates'));
    const now = L.warsawNow();
    if (!admin && b.start < now.date) bad(t('err_vac_past'));
    if (!userLocs(uid).length) bad(t('err_avail_no_locations'));
    const mineOverlap = get(`SELECT * FROM vacations WHERE user_id=? AND status IN ${ACTIVE} AND start<=? AND end>=?`, uid, b.end, b.start);
    if (mineOverlap) bad(t('err_vac_own_overlap', { range: fmtRange(mineOverlap) }));
    const c = conflicts(uid, b.start, b.end);
    if (c.length && !(admin && b.force)) bad(t('vac_busy', { who: conflictText(c) }), { busy: c.map(x => x.date) });
    const approved = admin && b.approve;
    const r = run(`INSERT INTO vacations(user_id,start,end,comment,status,created_by${approved ? ',decided_by,decided_at' : ''}) VALUES(?,?,?,?,?,?${approved ? ",?,datetime('now')" : ''})`,
      ...[uid, b.start, b.end, String(b.comment || '').trim().slice(0, 300) || null, approved ? 'approved' : 'pending', req.user.id].concat(approved ? [req.user.id] : []));
    const v = get('SELECT * FROM vacations WHERE id=?', Number(r.lastInsertRowid));
    L.audit(req.user, null, approved ? 'vac_add_approved' : 'vac_request', { user: u.name, range: `${v.start} – ${v.end}`, days: days(v), forced: c.length ? conflictText(c) : undefined, comment: v.comment });
    if (approved) { if (uid !== req.user.id) { const tt = tFor(uid); notify(uid, tt('n_vac_added', { range: fmtRange(v), days: days(v), name: req.user.name }), 'decision'); } }
    else {
      const ids = new Set(); for (const locId of userLocs(uid)) for (const id of adminRecipients(locId)) ids.add(id);
      ids.delete(req.user.id);
      for (const id of ids) notify(id, tFor(id)('n_vac_request', { name: u.name, range: fmtRange(v), days: days(v), comment: v.comment ? ` — ${v.comment}` : '' }), 'request');
    }
    return view(v, req.user);
  }));

  app.post('/api/vacations/:id/decide', wrap(req => {
    needAnyAdmin(req);
    const v = get('SELECT * FROM vacations WHERE id=?', Number(req.params.id)); if (!v) bad('not found');
    if (v.status !== 'pending') bad(req.t('err_already_decided'));
    const approve = !!req.body.approve;
    if (approve) { const c = conflicts(v.user_id, v.start, v.end, v.id); if (c.length && !req.body.force) bad(req.t('vac_busy', { who: conflictText(c) })); }
    run("UPDATE vacations SET status=?, decided_by=?, decided_at=datetime('now'), decision_comment=? WHERE id=?", approve ? 'approved' : 'rejected', req.user.id, req.body.comment || null, v.id);
    L.audit(req.user, null, approve ? 'vac_approve' : 'vac_reject', { user: L.userName(v.user_id), range: `${v.start} – ${v.end}`, comment: req.body.comment || '' });
    const tt = tFor(v.user_id);
    notify(v.user_id, tt(approve ? 'n_vac_approved' : 'n_vac_rejected', { range: fmtRange(v), days: days(v) }) + (req.body.comment ? ` — ${req.body.comment}` : ''), 'decision');
    return { ok: true };
  }));

  app.post('/api/vacations/:id/cancel', wrap(req => {
    const v = get('SELECT * FROM vacations WHERE id=?', Number(req.params.id)); if (!v) bad('not found');
    const admin = L.isAdminUser(req.user);
    if (!admin && !(v.user_id === req.user.id && v.status === 'pending')) forbid();
    if (!['pending', 'approved'].includes(v.status)) bad(req.t('err_already_decided'));
    run("UPDATE vacations SET status='cancelled', decided_by=?, decided_at=datetime('now') WHERE id=?", req.user.id, v.id);
    L.audit(req.user, null, 'vac_cancel', { user: L.userName(v.user_id), range: `${v.start} – ${v.end}` });
    if (v.user_id !== req.user.id) { const tt = tFor(v.user_id); notify(v.user_id, tt('n_vac_cancelled', { range: fmtRange(v), name: req.user.name }), 'decision'); }
    return { ok: true };
  }));

  app.put('/api/vacations/settings', wrap(req => {
    needAnyAdmin(req);
    const n = Math.round(Number(req.body.max)); if (!(n >= 1 && n <= 10)) bad(req.t('err_required'));
    const old = maxPerDay(); setting('vac_max_per_day', n);
    L.audit(req.user, null, 'vac_settings', { max: [old, n] });
    return { max: n };
  }));
}

/** Підтверджені дні урлопу для графіка: {user_id: Set(dates)} */
function approvedDays(uids, from, to) {
  const out = {};
  if (!uids.length) return out;
  for (const v of all(`SELECT * FROM vacations WHERE status='approved' AND start<=? AND end>=? AND user_id IN (${uids.map(() => '?').join(',')})`, to, from, ...uids))
    for (const d of L.dates(v.start > from ? v.start : from, v.end < to ? v.end : to)) (out[v.user_id] = out[v.user_id] || new Set()).add(d);
  return out;
}

module.exports = { register, approvedDays, conflicts };
