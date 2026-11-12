'use strict';
/* «Диспозиція» — доступність працівників на наступний тиждень. Доповнення до основної програми. */
const { db, all, get, run, tx, setting } = require('./db');
const L = require('./logic');
const { notify } = require('./notify');
const { tr } = require('../public/i18n.js');

db.exec(`
CREATE TABLE IF NOT EXISTS availability (
  user_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, start INTEGER, end INTEGER, comment TEXT,
  updated_by INTEGER, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id, date));
`);
// одноразова міграція: усі адміністратори мають однакові повні права
if (!setting('mig_admins_v1')) {
  run("UPDATE users SET role='admin' WHERE role='owner' OR id IN (SELECT admin_id FROM locations WHERE admin_id IS NOT NULL UNION SELECT deputy_id FROM locations WHERE deputy_id IS NOT NULL)");
  setting('mig_admins_v1', 1);
}

const KINDS = ['all', 's1', 's2', 'rs', 'from', 'to', 'range', 'no'];
const tFor = uid => { const u = get('SELECT lang FROM users WHERE id=?', uid); return (k, p) => tr((u && u.lang) || 'uk', k, p); };

function deadlineCfg() { return { dow: Number(setting('avail_deadline_dow') ?? 3), time: setting('avail_deadline_time') || '20:00' }; }
/** Дедлайн для тижня week (понеділок): день dow попереднього тижня о time. */
function deadlineFor(week) { const c = deadlineCfg(); return { date: L.addDays(week, -7 + c.dow), min: L.parseHM(c.time), time: c.time, dow: c.dow }; }
function beforeDeadline(week) { const d = deadlineFor(week); const now = L.warsawNow(); return now.date < d.date || (now.date === d.date && now.min < d.min); }

/** Перевіряє й нормалізує запис доступності. */
function normalize(b, t) {
  const kind = String(b.kind || '');
  if (!KINDS.includes(kind)) throw Object.assign(new Error(t('err_avail_kind')), { status: 400 });
  let start = null, end = null;
  if (kind === 'from' || kind === 'range') { start = L.parseHM(b.start); if (start == null || isNaN(start)) throw Object.assign(new Error(t('err_time_format')), { status: 400 }); }
  if (kind === 'to' || kind === 'range') { end = L.parseHM(b.end); if (end == null || isNaN(end)) throw Object.assign(new Error(t('err_time_format')), { status: 400 }); }
  if (kind === 'range' && start >= end) throw Object.assign(new Error(t('err_time_format')), { status: 400 });
  const comment = String(b.comment || '').trim().slice(0, 200) || null;
  return { kind, start, end, comment };
}
function upsert(uid, date, e, byId) {
  run(`INSERT INTO availability(user_id,date,kind,start,end,comment,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id,date) DO UPDATE SET kind=excluded.kind, start=excluded.start, end=excluded.end, comment=excluded.comment, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    uid, date, e.kind, e.start, e.end, e.comment, byId);
}
function describe(e, t) {
  if (!e) return t('av_none');
  const base = e.kind === 'from' ? t('av_btn_from').replace('…', L.hm(e.start)) : e.kind === 'to' ? t('av_btn_to').replace('…', L.hm(e.end))
    : e.kind === 'range' ? t('av_btn_range').replace('…', L.hm(e.start)).replace('…', L.hm(e.end)) : t('av_' + e.kind);
  return base + (e.comment ? ` (${e.comment})` : '');
}
const weekEntries = (uids, week) => uids.length ? all(`SELECT * FROM availability WHERE user_id IN (${uids.map(() => '?').join(',')}) AND date BETWEEN ? AND ?`, ...uids, week, L.addDays(week, 6)) : [];
const hasLocations = uid => !!get('SELECT 1 FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=? AND l.active=1', uid);

/** Нагадування тим, хто не заповнив доступність: за день до дедлайну і в день дедлайну. */
function remind() {
  const now = L.warsawNow();
  const week = L.addDays(L.weekStart(now.date), 7);
  const d = deadlineFor(week);
  let which = null;
  if (now.date === L.addDays(d.date, -1) && now.min >= 600) which = 1;
  else if (now.date === d.date && now.min >= 600 && now.min < d.min) which = 0;
  if (which === null || setting(`avrem:${week}:${which}`)) return;
  setting(`avrem:${week}:${which}`, 1);
  const users = all("SELECT DISTINCT u.id FROM users u JOIN user_locations ul ON ul.user_id=u.id WHERE u.active=1 AND u.role NOT IN ('admin','owner')");
  for (const u of users) {
    const n = get('SELECT count(*) c FROM availability WHERE user_id=? AND date BETWEEN ? AND ?', u.id, week, L.addDays(week, 6)).c;
    if (n >= 7) continue;
    const t = tFor(u.id);
    notify(u.id, t('n_avail_remind', { week, deadline: `${t('dow_full_' + d.dow)} ${d.date.slice(8)}.${d.date.slice(5, 7)} ${d.time}`, filled: n }), 'avail');
  }
}

function register(app, h) {
  const { wrap, needAdmin, needMember, bad, forbid } = h;
  const needAnyAdmin = req => { if (!L.isAdminUser(req.user)) forbid(); };
  const weekParam = q => L.weekStart(q || L.addDays(L.weekStart(L.warsawNow().date), 7));

  // --- працівник ---
  app.get('/api/my/avail', wrap(req => {
    const week = weekParam(req.query.week);
    const rows = weekEntries([req.user.id], week);
    const d = deadlineFor(week);
    return { week, deadline: d, editable: beforeDeadline(week) && hasLocations(req.user.id), has_locations: hasLocations(req.user.id),
      locations: all('SELECT l.name FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=? AND l.active=1', req.user.id).map(r => r.name),
      days: L.dates(week, L.addDays(week, 6)).map(date => ({ date, dow: L.dow(date), entry: rows.find(r => r.date === date) || null })) };
  }));
  app.put('/api/my/avail', wrap(req => {
    const date = String(req.body.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad(req.t('err_required'));
    const week = L.weekStart(date);
    if (!hasLocations(req.user.id)) bad(req.t('err_avail_no_locations'));
    if (!beforeDeadline(week)) bad(req.t('err_avail_deadline'));
    const e = normalize(req.body, req.t);
    upsert(req.user.id, date, e, req.user.id);
    return { ok: true };
  }));

  // --- адміністратор ---
  app.get('/api/avail/settings', wrap(req => { needAnyAdmin(req); return deadlineCfg(); }));
  app.put('/api/avail/settings', wrap(req => {
    needAnyAdmin(req);
    const dow = Number(req.body.dow); const tm = L.parseHM(req.body.time);
    if (!(dow >= 0 && dow <= 6) || tm == null || isNaN(tm)) bad(req.t('err_time_format'));
    const old = deadlineCfg();
    setting('avail_deadline_dow', dow); setting('avail_deadline_time', L.hm(tm));
    L.audit(req.user, null, 'avail_settings', { from: old, to: { dow, time: L.hm(tm) } });
    return deadlineCfg();
  }));
  app.get('/api/avail/:loc', wrap(req => {
    const locId = Number(req.params.loc); needAdmin(req, locId);
    const week = weekParam(req.query.week);
    const workers = all('SELECT u.id, u.name FROM users u JOIN user_locations ul ON ul.user_id=u.id WHERE ul.location_id=? AND u.active=1 ORDER BY u.name', locId);
    const rows = weekEntries(workers.map(w => w.id), week);
    const vac = require('./vacations').approvedDays(workers.map(w => w.id), week, L.addDays(week, 6)); // урлоп поверх доступності
    return { week, deadline: deadlineFor(week), open: beforeDeadline(week), workers,
      days: L.dates(week, L.addDays(week, 6)).map(date => ({ date, dow: L.dow(date), cells: Object.fromEntries(rows.filter(r => r.date === date).map(r => [r.user_id, { ...r, updated_name: L.userName(r.updated_by) }])
        .concat(workers.filter(w => (vac[w.id] || new Set()).has(date)).map(w => [w.id, { user_id: w.id, date, kind: 'vac', updated_name: '' }]))) })) };
  }));
  const checkWorker = (req, uid) => { const u = get('SELECT * FROM users WHERE id=?', uid); if (!u) bad('not found'); return u; };
  app.put('/api/avail/user/:uid', wrap(req => {
    needAnyAdmin(req);
    const uid = Number(req.params.uid); const u = checkWorker(req, uid);
    const date = String(req.body.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad(req.t('err_required'));
    const old = get('SELECT * FROM availability WHERE user_id=? AND date=?', uid, date);
    if (req.body.clear) { run('DELETE FROM availability WHERE user_id=? AND date=?', uid, date); }
    else upsert(uid, date, normalize(req.body, req.t), req.user.id);
    const now = get('SELECT * FROM availability WHERE user_id=? AND date=?', uid, date);
    L.audit(req.user, null, 'avail_set', { user: u.name, date, from: describe(old, req.t), to: describe(now, req.t) });
    if (uid !== req.user.id) { const t = tFor(uid); notify(uid, t('n_avail_changed', { date, what: describe(now, t), name: req.user.name }), 'avail'); }
    return { ok: true };
  }));
  app.post('/api/avail/user/:uid/copy', wrap(req => {
    needAnyAdmin(req);
    const uid = Number(req.params.uid); const u = checkWorker(req, uid);
    const week = L.weekStart(req.body.week); const prev = L.addDays(week, -7);
    const src = weekEntries([uid], prev);
    if (!src.length) bad(req.t('err_avail_prev_empty'));
    tx(() => { for (const e of src) upsert(uid, L.addDays(e.date, 7), e, req.user.id); });
    L.audit(req.user, null, 'avail_copy', { user: u.name, from: prev, to: week, days: src.length });
    return { ok: true, days: src.length };
  }));
  app.post('/api/avail/user/:uid/fill', wrap(req => {
    needAnyAdmin(req);
    const uid = Number(req.params.uid); const u = checkWorker(req, uid);
    const week = L.weekStart(req.body.week); const e = normalize(req.body, req.t);
    tx(() => { for (const d of L.dates(week, L.addDays(week, 6))) upsert(uid, d, e, req.user.id); });
    L.audit(req.user, null, 'avail_fill', { user: u.name, week, value: describe(e, req.t) });
    return { ok: true };
  }));

  setInterval(remind, 30 * 60 * 1000); setTimeout(remind, 5000);
}

module.exports = { register, normalize, upsert, describe, weekEntries, KINDS };
