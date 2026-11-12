'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { all, get, run, tx, setting } = require('./db');
const L = require('./logic');
const { notify, notifyAdmins, adminRecipients, startBot, getBotUsername, tgEnabled } = require('./notify');
const { tr } = require('../public/i18n.js');
const reports = require('./reports');
const exporter = require('./export');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// ---------- helpers ----------
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const checkPw = (pw, stored) => { const [salt, h] = stored.split(':'); const x = crypto.scryptSync(pw, salt, 32).toString('hex'); return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)); };
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (msg, extra) => { throw new HttpError(400, msg, extra); };
const forbid = () => { throw new HttpError(403, 'forbidden'); };
const wrap = fn => (req, res) => { try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { if (!(e instanceof HttpError)) console.error(e); res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) }); } };
const cookie = (req, name) => { const m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(req.headers.cookie || ''); return m ? decodeURIComponent(m[1]) : null; };
const safeUser = u => u && ({ id: u.id, login: u.login, name: u.name, role: u.role, rate: u.rate, training_rate: u.training_rate, active: u.active, can_rates: u.can_rates, lang: u.lang, tg_linked: !!u.tg_chat_id, notify: JSON.parse(u.notify || '{}') });
const num = v => (v === '' || v == null) ? null : Number(v);
// логін: будь-які літери (укр., пол., лат.), цифри, пробіл, . _ -; порівняння без урахування регістру й зайвих пробілів
const normLogin = s => String(s || '').trim().replace(/\s+/g, ' ');
const loginKey = s => normLogin(s).toLocaleLowerCase('uk');
const LOGIN_RE = /^[\p{L}\p{N}._\- ]{2,32}$/u;
const findByLogin = (login, exceptId) => all('SELECT * FROM users').find(u => u.id !== exceptId && loginKey(u.login) === loginKey(login));

function auth(req, res, next) {
  const token = cookie(req, 'sid') || (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = token && get('SELECT * FROM sessions WHERE token=?', token);
  const u = s && get('SELECT * FROM users WHERE id=? AND active=1', s.user_id);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  req.t = (k, p) => tr(u.lang || 'uk', k, p);
  next();
}
const memberOf = (user, locId) => L.isAdminUser(user) || L.isAdmin(user, locId) || !!get('SELECT 1 FROM user_locations WHERE user_id=? AND location_id=?', user.id, locId);
const needMember = (req, locId) => { if (!memberOf(req.user, Number(locId))) forbid(); };
const needAdmin = (req, locId) => { if (!L.isAdmin(req.user, Number(locId))) forbid(); };
const needOwner = req => { if (!L.isAdminUser(req.user)) forbid(); }; // будь-який адміністратор
const needOpen = (req, locId, date) => { if (L.isClosed(locId, date)) bad(req.t('err_month_closed', { month: L.monthOf(date) })); };
const locName = id => (get('SELECT name FROM locations WHERE id=?', id) || {}).name || '';
const tFor = uid => { const u = get('SELECT lang FROM users WHERE id=?', uid); return (k, p) => tr((u && u.lang) || 'uk', k, p); };
const shiftLabel = (s, t) => `${s.date} ${t('slot_' + s.slot)}${L.TIMED.includes(s.slot) ? ' ' + L.hm(s.start) + '–' + L.hm(s.end) : ''} (${locName(s.location_id)})`;

// ---------- auth ----------
app.post('/api/login', wrap((req, res) => {
  const { login, password } = req.body || {};
  // усі активні користувачі з таким логіном (без урахування регістру); пароль перевіряється для кожного
  const pw = String(password || '');
  const u = all('SELECT * FROM users WHERE active=1').filter(x => loginKey(x.login) === loginKey(login)).find(x => checkPw(pw, x.pass));
  if (!u) throw new HttpError(401, 'bad_login');
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions(token,user_id) VALUES(?,?)', token, u.id);
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`);
  return { ok: true };
}));
app.use('/api', auth);
app.post('/api/logout', wrap((req, res) => { run('DELETE FROM sessions WHERE token=?', cookie(req, 'sid')); res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); return { ok: true }; }));

app.get('/api/me', wrap(req => {
  const locs = L.locationsFor(req.user).map(l => ({ ...l, is_admin: L.isAdmin(req.user, l.id), admin_name: L.userName(l.admin_id), deputy_name: L.userName(l.deputy_id) }));
  return { user: safeUser(req.user), locations: locs, can_rates: L.canRates(req.user), unread: get('SELECT count(*) c FROM notifications WHERE user_id=? AND read=0', req.user.id).c,
    tg: { enabled: tgEnabled(), bot: getBotUsername(), configured: require('./telegram').status().configured }, now: L.warsawNow() };
}));
app.post('/api/me/lang', wrap(req => { const lang = req.body.lang === 'pl' ? 'pl' : 'uk'; run('UPDATE users SET lang=? WHERE id=?', lang, req.user.id); return { ok: true }; }));
app.post('/api/me/password', wrap(req => {
  const { old, password } = req.body;
  if (!checkPw(String(old || ''), req.user.pass)) bad(req.t('err_old_password'));
  if (!password || String(password).length < 6) bad(req.t('err_password_short'));
  run('UPDATE users SET pass=? WHERE id=?', hash(String(password)), req.user.id);
  return { ok: true };
}));
app.post('/api/me/notify', wrap(req => { run('UPDATE users SET notify=? WHERE id=?', JSON.stringify(req.body || {}), req.user.id); return { ok: true }; }));
app.post('/api/me/tg-code', wrap(req => {
  const code = crypto.randomBytes(6).toString('hex');
  run('UPDATE users SET tg_code=? WHERE id=?', code, req.user.id);
  const bot = getBotUsername();
  return { code, link: `https://t.me/${bot}?start=${code}` };
}));
app.post('/api/me/tg-unlink', wrap(req => { run('UPDATE users SET tg_chat_id=NULL WHERE id=?', req.user.id); return { ok: true }; }));
app.get('/api/notifications', wrap(req => all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', req.user.id)));
app.post('/api/notifications/read', wrap(req => { run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id); return { ok: true }; }));

// ---------- locations ----------
app.get('/api/locations', wrap(req => {
  needOwner(req);
  return all('SELECT * FROM locations ORDER BY sort,id').map(l => ({ ...l, admin_name: L.userName(l.admin_id), deputy_name: L.userName(l.deputy_id) }));
}));
app.post('/api/locations', wrap(req => {
  needOwner(req);
  const { name, admin_id, deputy_id, has_restock } = req.body;
  if (!name) bad(req.t('err_required'));
  const r = run('INSERT INTO locations(name,admin_id,deputy_id,has_restock,sort) VALUES(?,?,?,?,?)', name, num(admin_id), num(deputy_id), has_restock ? 1 : 0, 99);
  L.audit(req.user, r.lastInsertRowid, 'location_create', { name });
  return { id: Number(r.lastInsertRowid) };
}));
app.put('/api/locations/:id', wrap(req => {
  needOwner(req);
  const id = Number(req.params.id); const old = get('SELECT * FROM locations WHERE id=?', id); if (!old) bad('not found');
  const b = { ...old, ...req.body };
  run('UPDATE locations SET name=?, admin_id=?, deputy_id=?, has_restock=?, active=?, sort=? WHERE id=?', b.name, num(b.admin_id), num(b.deputy_id), b.has_restock ? 1 : 0, b.active ? 1 : 0, num(b.sort) || 0, id);
  for (const uid of [num(b.admin_id), num(b.deputy_id)]) if (uid) run('INSERT OR IGNORE INTO user_locations(user_id,location_id) VALUES(?,?)', uid, id);
  L.audit(req.user, id, 'location_update', { from: { name: old.name, admin: L.userName(old.admin_id), deputy: L.userName(old.deputy_id), restock: old.has_restock }, to: { name: b.name, admin: L.userName(num(b.admin_id)), deputy: L.userName(num(b.deputy_id)), restock: b.has_restock ? 1 : 0 } });
  return { ok: true };
}));
app.get('/api/locations/:id/workers', wrap(req => {
  needMember(req, req.params.id);
  return all(`SELECT u.id, u.name FROM users u JOIN user_locations ul ON ul.user_id=u.id WHERE ul.location_id=? AND u.active=1 ORDER BY u.name`, Number(req.params.id));
}));

// ---------- users ----------
app.get('/api/users', wrap(req => {
  const admLocs = L.adminLocIds(req.user);
  if (!admLocs.length) forbid();
  const rates = L.canRates(req.user);
  let users;
  if (L.isAdminUser(req.user)) users = all('SELECT * FROM users ORDER BY active DESC, name');
  else users = all(`SELECT DISTINCT u.* FROM users u JOIN user_locations ul ON ul.user_id=u.id WHERE ul.location_id IN (${admLocs.join(',')}) ORDER BY u.active DESC, u.name`);
  return users.map(u => {
    const s = safeUser(u);
    if (!rates && u.id !== req.user.id) { delete s.rate; delete s.training_rate; }
    s.locations = all('SELECT location_id FROM user_locations WHERE user_id=?', u.id).map(r => r.location_id);
    return s;
  });
}));
function saveUserLocations(req, uid, locs) {
  const admLocs = L.adminLocIds(req.user);
  const current = all('SELECT location_id FROM user_locations WHERE user_id=?', uid).map(r => r.location_id);
  for (const l of current) if (admLocs.includes(l) && !locs.includes(l)) run('DELETE FROM user_locations WHERE user_id=? AND location_id=?', uid, l);
  for (const l of locs) if (admLocs.includes(l)) run('INSERT OR IGNORE INTO user_locations(user_id,location_id) VALUES(?,?)', uid, l);
}
app.post('/api/users', wrap(req => {
  if (!L.adminLocIds(req.user).length) forbid();
  const b = req.body;
  if (!b.login || !b.name || !b.password) bad(req.t('err_required'));
  b.login = normLogin(b.login);
  if (!LOGIN_RE.test(b.login)) bad(req.t('err_login_format'));
  if (findByLogin(b.login)) bad(req.t('err_login_taken'));
  const rates = L.canRates(req.user);
  const r = run('INSERT INTO users(login,pass,name,rate,training_rate,lang) VALUES(?,?,?,?,?,?)', b.login.trim(), hash(String(b.password)), b.name.trim(),
    rates && b.rate != null ? Number(b.rate) : Number(setting('base_rate') || 31.4), rates && b.training_rate != null ? Number(b.training_rate) : Number(setting('training_rate') || 20), b.lang === 'pl' ? 'pl' : 'uk');
  const uid = Number(r.lastInsertRowid);
  if (b.role === 'admin') run("UPDATE users SET role='admin' WHERE id=?", uid);
  saveUserLocations(req, uid, (b.locations || []).map(Number));
  L.audit(req.user, null, 'user_create', { name: b.name, login: b.login, role: b.role === 'admin' ? 'admin' : 'user' });
  return { id: uid };
}));
app.put('/api/users/:id', wrap(req => {
  const uid = Number(req.params.id);
  const u = get('SELECT * FROM users WHERE id=?', uid); if (!u) bad('not found');
  const owner = L.isAdminUser(req.user);
  const admLocs = L.adminLocIds(req.user);
  if (!owner) {
    const theirs = all('SELECT location_id FROM user_locations WHERE user_id=?', uid).map(r => r.location_id);
    if (!admLocs.length || (theirs.length && !theirs.some(l => admLocs.includes(l)))) forbid();
    if (u.role === 'owner') forbid();
  }
  const b = req.body; const changes = {};
  if (b.name && b.name !== u.name) { run('UPDATE users SET name=? WHERE id=?', b.name, uid); changes.name = [u.name, b.name]; }
  // зміна логіна — тільки адміністратор
  if (owner && b.login != null && normLogin(b.login) !== u.login) {
    const login = normLogin(b.login);
    if (!LOGIN_RE.test(login)) bad(req.t('err_login_format'));
    if (findByLogin(login, uid)) bad(req.t('err_login_taken'));
    run('UPDATE users SET login=? WHERE id=?', login, uid); changes.login = [u.login, login];
    if (uid !== req.user.id) notify(uid, tr(u.lang || 'uk', 'n_login_changed', { login, name: req.user.name }), 'shift');
  }
  if (b.active != null && !!b.active !== !!u.active) { run('UPDATE users SET active=? WHERE id=?', b.active ? 1 : 0, uid); changes.active = [u.active, b.active ? 1 : 0]; if (!b.active) run('DELETE FROM sessions WHERE user_id=?', uid); }
  if (L.canRates(req.user)) {
    if (b.rate != null && Number(b.rate) !== u.rate) { run('UPDATE users SET rate=? WHERE id=?', Number(b.rate), uid); changes.rate = [u.rate, Number(b.rate)]; }
    if (b.training_rate != null && Number(b.training_rate) !== u.training_rate) { run('UPDATE users SET training_rate=? WHERE id=?', Number(b.training_rate), uid); changes.training_rate = [u.training_rate, Number(b.training_rate)]; }
  }
  if (owner && (b.role === 'admin' || b.role === 'user') && b.role !== (L.isAdminUser(u) ? 'admin' : 'user')) {
    if (b.role === 'user' && get("SELECT count(*) c FROM users WHERE role IN ('admin','owner') AND active=1 AND id<>?", uid).c === 0) bad(req.t('err_last_admin'));
    run('UPDATE users SET role=? WHERE id=?', b.role, uid); changes.role = [u.role, b.role];
  }
  if (b.password) { if (String(b.password).length < 6) bad(req.t('err_password_short')); run('UPDATE users SET pass=? WHERE id=?', hash(String(b.password)), uid); changes.password = 'reset'; }
  if (Array.isArray(b.locations)) { saveUserLocations(req, uid, b.locations.map(Number)); changes.locations = b.locations; }
  L.audit(req.user, null, 'user_update', { user: u.name, ...changes });
  return { ok: true };
}));

// ---------- schedule ----------
function weekView(locId, week, user) {
  const loc = get('SELECT * FROM locations WHERE id=?', locId);
  const w = get('SELECT * FROM weeks WHERE location_id=? AND week=?', locId, week) || { status: 'draft' };
  const admin = L.isAdmin(user, locId);
  const days = [];
  const end = L.addDays(week, 6);
  const rows = all('SELECT * FROM shifts WHERE location_id=? AND date BETWEEN ? AND ?', locId, week, end);
  const dels = all('SELECT * FROM deliveries WHERE location_id=? AND date BETWEEN ? AND ?', locId, week, end);
  for (const d of L.dates(week, end)) {
    const cells = {};
    for (const s of rows.filter(r => r.date === d)) cells[s.slot] = { ...s, name: L.userName(s.user_id), plan_name: L.userName(s.plan_user_id) };
    const del = dels.find(x => x.date === d);
    days.push({ date: d, dow: L.dow(d), cells, delivery: del ? { ...del, name: L.userName(del.user_id) } : null, delivery_day: !!(cells.dl && cells.dl.user_id), closed: L.isClosed(locId, d) });
  }
  if (!admin && w.status !== 'published') return { week, status: 'hidden', location: loc, days: days.map(d => ({ ...d, cells: {}, delivery: null })) };
  const warn = admin ? L.warnings([locId], week, end, tFor(user.id)) : [];
  let availMap;
  if (admin) { // диспозиція для вибору працівника на зміну
    availMap = {};
    const ids = all('SELECT user_id FROM user_locations WHERE location_id=?', locId).map(r => r.user_id);
    for (const e of require('./avail').weekEntries(ids, week)) (availMap[e.user_id] = availMap[e.user_id] || {})[e.date] = e;
    const vac = require('./vacations').approvedDays(ids, week, end); // підтверджений урлоп = не може
    for (const uid of Object.keys(vac)) for (const d of vac[uid]) (availMap[uid] = availMap[uid] || {})[d] = { user_id: Number(uid), date: d, kind: 'vac' };
  }
  return { week, status: w.status, published_at: w.published_at, location: loc, days, warnings: warn, is_admin: admin, avail: availMap };
}
app.get('/api/schedule/:loc', wrap(req => {
  const locId = Number(req.params.loc); needMember(req, locId);
  const week = L.weekStart(req.query.week || L.warsawNow().date);
  return weekView(locId, week, req.user);
}));
app.put('/api/schedule/:loc', wrap(req => {
  const locId = Number(req.params.loc); needAdmin(req, locId);
  const t = req.t;
  const week = L.weekStart(req.body.week);
  const loc = get('SELECT * FROM locations WHERE id=?', locId);
  const slots = ['s1', 's2', 'dl'].concat(loc.has_restock ? ['rs'] : []);
  const weekDates = L.dates(week, L.addDays(week, 6));
  const members = new Set(all('SELECT user_id FROM user_locations ul JOIN users u ON u.id=ul.user_id WHERE location_id=? AND u.active=1', locId).map(r => r.user_id));
  const incoming = {};
  for (const c of req.body.cells || []) {
    if (!weekDates.includes(c.date) || !slots.includes(c.slot)) continue;
    const uid = num(c.user_id);
    if (uid && !members.has(uid)) bad(t('err_not_member', { name: L.userName(uid) }));
    const def = L.defaults(c.date, c.slot);
    let start = c.slot === 'dl' ? null : (L.parseHM(c.start) ?? def.start);
    let end = c.slot === 'dl' ? null : (L.parseHM(c.end) ?? def.end);
    incoming[c.date + ':' + c.slot] = { location_id: locId, date: c.date, slot: c.slot, user_id: uid, start, end, cancelled: 0 };
  }
  const existing = {};
  for (const s of all('SELECT * FROM shifts WHERE location_id=? AND date BETWEEN ? AND ?', locId, week, weekDates[6])) existing[s.date + ':' + s.slot] = s;
  const changed = [];
  const proposed = [];
  for (const d of weekDates) for (const sl of slots) {
    const k = d + ':' + sl; const inc = incoming[k] || { location_id: locId, date: d, slot: sl, user_id: null, start: null, end: null, cancelled: 0 };
    const ex = existing[k];
    const same = ex ? (ex.user_id === inc.user_id && (sl === 'dl' || !inc.user_id || (ex.start === inc.start && ex.end === inc.end))) : !inc.user_id;
    if (!same) { if (L.isClosed(locId, d)) bad(t('err_month_closed', { month: L.monthOf(d) })); changed.push({ k, ex, inc }); }
    proposed.push(ex ? { ...inc, id: ex.id, cancelled: same ? ex.cancelled : 0 } : inc);
  }
  const errors = L.validate(proposed.filter(p => p.user_id || p.id), { strictHandover: true }, t);
  if (errors.length) bad(t('err_rules'), { errors });
  const wasPublished = (get('SELECT status FROM weeks WHERE location_id=? AND week=?', locId, week) || {}).status === 'published';
  const affected = new Set();
  tx(() => {
    for (const { ex, inc } of changed) {
      if (ex) {
        if (ex.user_id) affected.add(ex.user_id);
        if (!inc.user_id) run('DELETE FROM shifts WHERE id=?', ex.id);
        else run('UPDATE shifts SET user_id=?, start=?, end=?, cancelled=0, plan_user_id=?, plan_start=?, plan_end=? WHERE id=?', inc.user_id, inc.start, inc.end, inc.user_id, inc.start, inc.end, ex.id);
      } else if (inc.user_id) run('INSERT INTO shifts(location_id,date,slot,user_id,start,end,plan_user_id,plan_start,plan_end) VALUES(?,?,?,?,?,?,?,?,?)', locId, inc.date, inc.slot, inc.user_id, inc.start, inc.end, inc.user_id, inc.start, inc.end);
      if (inc.user_id) affected.add(inc.user_id);
      if (inc.slot === 'dl') run('UPDATE deliveries SET user_id=? WHERE location_id=? AND date=? AND pallets IS NULL', inc.user_id, locId, inc.date);
    }
    if (changed.length) L.audit(req.user, locId, 'schedule_save', { week, changes: changed.map(c => ({ date: c.inc.date, slot: c.inc.slot, from: c.ex ? `${L.userName(c.ex.user_id)} ${L.hm(c.ex.start)}-${L.hm(c.ex.end)}` : '', to: c.inc.user_id ? `${L.userName(c.inc.user_id)} ${L.hm(c.inc.start)}-${L.hm(c.inc.end)}` : '' })) });
    if (req.body.publish && !wasPublished) {
      run(`INSERT INTO weeks(location_id,week,status,published_at,published_by) VALUES(?,?,'published',datetime('now'),?)
        ON CONFLICT(location_id,week) DO UPDATE SET status='published', published_at=datetime('now'), published_by=excluded.published_by`, locId, week, req.user.id);
      run('UPDATE shifts SET plan_user_id=user_id, plan_start=start, plan_end=end WHERE location_id=? AND date BETWEEN ? AND ?', locId, week, weekDates[6]);
      L.audit(req.user, locId, 'schedule_publish', { week });
    }
  });
  if (req.body.publish && !wasPublished) {
    for (const u of members) { const tt = tFor(u); notify(u, tt('n_published', { loc: loc.name, week }), 'schedule'); }
  } else if (wasPublished) {
    for (const u of affected) { const tt = tFor(u); notify(u, tt('n_shift_changed', { loc: loc.name, week }), 'shift'); }
  }
  return weekView(locId, week, req.user);
}));

// fact correction by admin (does not change plan)
function applyShiftChange(shift, patch, moveNeighbour, t) {
  const proposed = [];
  const upd = { ...shift, ...patch };
  proposed.push(upd);
  const neighbours = [];
  if (moveNeighbour && !shift.cancelled && ['s1', 's2'].includes(shift.slot)) {
    const others = all("SELECT * FROM shifts WHERE location_id=? AND date=? AND slot IN ('s1','s2') AND id<>? AND cancelled=0 AND user_id IS NOT NULL", shift.location_id, shift.date, shift.id);
    for (const o of others) {
      if (patch.end != null && o.start === shift.end && patch.end !== shift.end) { const n = { ...o, start: patch.end }; proposed.push(n); neighbours.push(n); }
      if (patch.start != null && o.end === shift.start && patch.start !== shift.start) { const n = { ...o, end: patch.start }; proposed.push(n); neighbours.push(n); }
    }
  }
  const errors = L.validate(proposed, {}, t);
  return { errors, proposed, neighbours };
}
function writeShift(s) { run('UPDATE shifts SET user_id=?, start=?, end=?, cancelled=? WHERE id=?', s.user_id, s.start, s.end, s.cancelled ? 1 : 0, s.id); }

app.post('/api/shifts/:id/correct', wrap(req => {
  const s = get('SELECT * FROM shifts WHERE id=?', Number(req.params.id)); if (!s) bad('not found');
  needAdmin(req, s.location_id); needOpen(req, s.location_id, s.date);
  const b = req.body; if (!b.comment) bad(req.t('err_comment_required'));
  const patch = {};
  if (b.user_id !== undefined) patch.user_id = num(b.user_id);
  if (b.start) patch.start = L.parseHM(b.start);
  if (b.end) patch.end = L.parseHM(b.end);
  if (b.cancelled != null) patch.cancelled = b.cancelled ? 1 : 0;
  const { errors, proposed } = applyShiftChange(s, patch, !!b.moveNeighbour, req.t);
  if (errors.length) bad(req.t('err_rules'), { errors });
  tx(() => {
    for (const p of proposed) writeShift(p);
    L.audit(req.user, s.location_id, 'shift_correct', { shift: shiftLabel(s, req.t), to: proposed.map(p => `${L.userName(p.user_id)} ${L.hm(p.start)}-${L.hm(p.end)}${p.cancelled ? ' ✕' : ''}`), comment: b.comment });
  });
  const ids = new Set(proposed.map(p => p.user_id).concat([s.user_id]).filter(Boolean));
  for (const u of ids) notify(u, tFor(u)('n_shift_corrected', { shift: shiftLabel(s, tFor(u)), comment: b.comment }), 'shift');
  return { ok: true };
}));

app.get('/api/shifts', wrap(req => {
  const locId = Number(req.query.loc); needMember(req, locId);
  const now = L.warsawNow();
  const from = req.query.from || L.addDays(now.date, -14), to = req.query.to || L.addDays(now.date, 14);
  return all('SELECT * FROM shifts WHERE location_id=? AND date BETWEEN ? AND ? AND user_id IS NOT NULL ORDER BY date, slot', locId, from, to)
    .filter(s => L.isPublished(locId, s.date))
    .map(s => ({ ...s, name: L.userName(s.user_id) }));
}));

// ---------- adjustments (extra time / training by admin) ----------
app.post('/api/adjustments', wrap(req => {
  const b = req.body; const locId = Number(b.location_id);
  needAdmin(req, locId); needOpen(req, locId, b.date);
  const minutes = Math.round(Number(b.minutes));
  if (!b.date || !b.user_id || !minutes) bad(req.t('err_required'));
  if (!b.comment) bad(req.t('err_comment_required'));
  const kind = b.kind === 'training' ? 'training' : 'extra';
  const r = run('INSERT INTO adjustments(location_id,user_id,date,kind,minutes,comment,created_by,approved_by) VALUES(?,?,?,?,?,?,?,?)', locId, Number(b.user_id), b.date, kind, minutes, b.comment, req.user.id, req.user.id);
  L.audit(req.user, locId, 'adjustment_add', { user: L.userName(Number(b.user_id)), date: b.date, kind, minutes, comment: b.comment });
  notify(Number(b.user_id), tFor(Number(b.user_id))('n_adj_added', { minutes, date: b.date, comment: b.comment, kind: tFor(Number(b.user_id))('kind_' + kind) }), 'decision');
  return { id: Number(r.lastInsertRowid) };
}));
app.delete('/api/adjustments/:id', wrap(req => {
  const a = get('SELECT * FROM adjustments WHERE id=?', Number(req.params.id)); if (!a) bad('not found');
  needAdmin(req, a.location_id); needOpen(req, a.location_id, a.date);
  run('UPDATE adjustments SET deleted=1 WHERE id=?', a.id);
  L.audit(req.user, a.location_id, 'adjustment_delete', { user: L.userName(a.user_id), date: a.date, minutes: a.minutes, kind: a.kind });
  return { ok: true };
}));

// ---------- deliveries ----------
app.post('/api/deliveries', wrap(req => {
  const b = req.body; const locId = Number(b.location_id); needMember(req, locId); needOpen(req, locId, b.date);
  const p = Number(b.pallets);
  if (!(p >= 0) || Math.round(p * 2) !== p * 2) bad(req.t('err_pallets'));
  const admin = L.isAdmin(req.user, locId);
  const now = L.warsawNow();
  const dl = get("SELECT * FROM shifts WHERE location_id=? AND date=? AND slot='dl'", locId, b.date);
  const ex = get('SELECT * FROM deliveries WHERE location_id=? AND date=?', locId, b.date);
  let uid = admin ? (num(b.user_id) || (dl && dl.user_id)) : req.user.id;
  if (!admin) {
    if (!dl || dl.user_id !== req.user.id) bad(req.t('err_not_delivery_person'));
    if (b.date > now.date) bad(req.t('err_future'));
    if (ex && ex.pallets != null) bad(req.t('err_already_confirmed'));
  }
  if (!uid) bad(req.t('err_required'));
  run(`INSERT INTO deliveries(location_id,date,user_id,pallets,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,datetime('now'))
    ON CONFLICT(location_id,date) DO UPDATE SET user_id=excluded.user_id, pallets=excluded.pallets, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at`, locId, b.date, uid, p, req.user.id);
  L.audit(req.user, locId, 'delivery_confirm', { date: b.date, user: L.userName(uid), pallets: p, before: ex ? ex.pallets : null });
  return { ok: true };
}));

// ---------- home / my hours ----------
app.get('/api/home/:loc', wrap(req => {
  const locId = Number(req.params.loc); needMember(req, locId);
  const now = L.warsawNow(); const uid = req.user.id;
  const myShifts = all('SELECT * FROM shifts WHERE user_id=? AND date BETWEEN ? AND ? AND cancelled=0 ORDER BY date, start', uid, L.addDays(now.date, -1), L.addDays(now.date, 7))
    .filter(s => L.isPublished(s.location_id, s.date)).map(s => ({ ...s, location: locName(s.location_id) }));
  // notes for me: unresolved notes from my location in the last 24h before my current/next shift start
  const notes = all("SELECT n.*, u.name author FROM notes n JOIN users u ON u.id=n.author_id WHERE n.location_id=? AND n.resolved_at IS NULL AND n.created_at >= datetime('now','-36 hours') AND n.author_id<>? ORDER BY n.id DESC", locId, uid);
  const today = all('SELECT * FROM shifts WHERE location_id=? AND date=? AND user_id IS NOT NULL AND cancelled=0 ORDER BY slot', locId, now.date)
    .filter(s => L.isPublished(locId, s.date)).map(s => ({ ...s, name: L.userName(s.user_id) }));
  const toConfirm = all(`SELECT s.date FROM shifts s LEFT JOIN deliveries d ON d.location_id=s.location_id AND d.date=s.date
    WHERE s.location_id=? AND s.slot='dl' AND s.user_id=? AND s.date BETWEEN ? AND ? AND (d.pallets IS NULL)`, locId, uid, L.addDays(now.date, -10), now.date)
    .filter(r => !L.isClosed(locId, r.date)).map(r => r.date);
  const res = { now, myShifts, notes, today, toConfirm, myPending: get("SELECT count(*) c FROM requests WHERE user_id=? AND status='pending'", uid).c };
  if (L.isAdmin(req.user, locId)) {
    res.pending = get("SELECT count(*) c FROM requests WHERE location_id=? AND status='pending'", locId).c;
    res.warnings = L.warnings([locId], L.monthRange(L.monthOf(now.date))[0], L.addDays(now.date, 14), req.t).length;
    res.openNotes = get('SELECT count(*) c FROM notes WHERE location_id=? AND resolved_at IS NULL', locId).c;
  }
  return res;
}));

app.get('/api/my/hours', wrap(req => {
  const month = req.query.month || L.monthOf(L.warsawNow().date);
  const [from, to] = L.monthRange(month);
  const u = req.user;
  const locIds = all('SELECT id FROM locations').map(r => r.id);
  const recs = L.computeRecords(locIds, from, to, u.id);
  const rows = recs.map(r => {
    const m = L.money(r, u);
    return { date: r.date, dow: L.dow(r.date), location: locName(r.location_id),
      shifts: r.shifts.map(s => `${L.hm(s.start)}–${L.hm(s.end)}`), planned: r.planned.map(s => `${L.hm(s.start)}–${L.hm(s.end)}`),
      sched: r.sched, extra: r.extra, training: r.training, pallets: r.pallets, deliveries: r.deliveries,
      adj: r.adj.map(a => ({ kind: a.kind, minutes: a.minutes, comment: a.comment })), sum: m.total };
  });
  const tot = rows.reduce((a, r) => ({ sched: a.sched + r.sched, extra: a.extra + r.extra, training: a.training + r.training, pallets: a.pallets + r.pallets, sum: a.sum + r.sum }), { sched: 0, extra: 0, training: 0, pallets: 0, sum: 0 });
  return { month, rows, totals: tot, rate: u.rate, training_rate: u.training_rate };
}));

// ---------- requests ----------
const REQ_TYPES = ['extra', 'swap', 'handover', 'early', 'pallets', 'training', 'avail'];
function describeRequest(r, t) {
  const d = JSON.parse(r.data || '{}');
  const s = r.shift_id && get('SELECT * FROM shifts WHERE id=?', r.shift_id);
  const ss = d.swap_shift_id && get('SELECT * FROM shifts WHERE id=?', d.swap_shift_id);
  switch (r.type) {
    case 'extra': case 'training': return t('rqd_minutes', { date: r.date, minutes: d.minutes });
    case 'swap': return s ? t('rqd_swap', { shift: shiftLabel(s, t), who: L.userName(s.user_id) }) + (ss ? ' ⇄ ' + shiftLabel(ss, t) : '') : '?';
    case 'handover': return s ? t('rqd_handover', { shift: shiftLabel(s, t), time: d.time }) : '?';
    case 'early': return s ? (d.noshow ? t('rqd_noshow', { shift: shiftLabel(s, t) }) : t('rqd_early', { shift: shiftLabel(s, t), time: d.time })) : '?';
    case 'pallets': return t('rqd_pallets', { date: r.date, pallets: d.pallets });
    case 'avail': return `${r.date}: ${require('./avail').describe(d, t)}`;
  }
  return '';
}
app.get('/api/requests', wrap(req => {
  const locId = Number(req.query.loc);
  let rows;
  const cond = req.query.status ? " AND status='" + (req.query.status === 'pending' ? 'pending' : req.query.status === 'approved' ? 'approved' : 'rejected') + "'" : '';
  if (req.query.mine || !L.isAdmin(req.user, locId)) rows = all(`SELECT * FROM requests WHERE user_id=?${cond} ORDER BY id DESC LIMIT 200`, req.user.id);
  else rows = all(`SELECT * FROM requests WHERE location_id=?${cond} ORDER BY status='pending' DESC, id DESC LIMIT 300`, locId);
  return rows.map(r => ({ ...r, data: JSON.parse(r.data || '{}'), user_name: L.userName(r.user_id), decided_name: L.userName(r.decided_by), location: locName(r.location_id), desc: describeRequest(r, req.t) }));
}));
app.post('/api/requests', wrap(req => {
  const b = req.body; const t = req.t; const locId = Number(b.location_id);
  needMember(req, locId);
  if (!REQ_TYPES.includes(b.type)) bad('type');
  const data = {}; let date = b.date || null; let shiftId = num(b.shift_id);
  let shift = shiftId && get('SELECT * FROM shifts WHERE id=?', shiftId);
  if (['swap', 'handover', 'early'].includes(b.type)) {
    if (!shift || shift.location_id !== locId) bad(t('err_pick_shift'));
    date = shift.date;
    if (b.type === 'swap') {
      if (shift.user_id === req.user.id) bad(t('err_own_shift'));
      if (b.swap_shift_id) { const ss = get('SELECT * FROM shifts WHERE id=?', Number(b.swap_shift_id)); if (!ss || ss.user_id !== req.user.id) bad(t('err_pick_shift')); data.swap_shift_id = ss.id; }
    } else {
      if (shift.user_id !== req.user.id) bad(t('err_not_your_shift'));
      if (b.type === 'early' && b.noshow) data.noshow = true;
      else { const tm = L.parseHM(b.time); if (tm == null || isNaN(tm)) bad(t('err_time_format')); data.time = L.hm(tm); }
    }
  } else if (b.type === 'avail') {
    Object.assign(data, require('./avail').normalize(b, t));
  } else if (b.type === 'pallets') {
    const p = Number(b.pallets); if (!(p >= 0) || Math.round(p * 2) !== p * 2) bad(t('err_pallets')); data.pallets = p;
  } else {
    const m = Math.round(Number(b.minutes)); if (!(m > 0)) bad(t('err_minutes')); data.minutes = m;
    if (!b.comment || !String(b.comment).trim()) bad(t('err_comment_required'));
  }
  if (!date) bad(t('err_required'));
  needOpen(req, locId, date);
  const r = run('INSERT INTO requests(type,location_id,user_id,date,shift_id,data,comment) VALUES(?,?,?,?,?,?,?)', b.type, locId, req.user.id, date, shiftId, JSON.stringify(data), b.comment || null);
  const rq = get('SELECT * FROM requests WHERE id=?', Number(r.lastInsertRowid));
  L.audit(req.user, locId, 'request_create', { id: rq.id, type: rq.type, desc: describeRequest(rq, t), comment: b.comment });
  const l = get('SELECT * FROM locations WHERE id=?', locId);
  const ids = adminRecipients(locId); ids.delete(req.user.id);
  for (const id of ids) { const tt = tFor(id); notify(id, `[${l.name}] ` + tt('n_new_request', { name: req.user.name, type: tt('rq_' + rq.type), desc: describeRequest(rq, tt) }) + (b.comment ? ` — ${b.comment}` : ''), 'request'); }
  return { id: rq.id };
}));
app.post('/api/requests/:id/cancel', wrap(req => {
  const r = get('SELECT * FROM requests WHERE id=?', Number(req.params.id));
  if (!r || r.user_id !== req.user.id || r.status !== 'pending') bad('not found');
  run("UPDATE requests SET status='cancelled', decided_at=datetime('now'), decided_by=? WHERE id=?", req.user.id, r.id);
  L.audit(req.user, r.location_id, 'request_cancel', { id: r.id });
  return { ok: true };
}));
function applyRequest(r, approver, t) {
  const d = JSON.parse(r.data || '{}');
  const shift = r.shift_id && get('SELECT * FROM shifts WHERE id=?', r.shift_id);
  const notifyUsers = new Set();
  if (['swap', 'handover', 'early'].includes(r.type)) { if (!shift) bad(t('err_pick_shift')); }
  switch (r.type) {
    case 'extra': case 'training':
      run('INSERT INTO adjustments(location_id,user_id,date,kind,minutes,comment,created_by,approved_by,request_id) VALUES(?,?,?,?,?,?,?,?,?)', r.location_id, r.user_id, r.date, r.type, d.minutes, r.comment, r.user_id, approver.id, r.id);
      break;
    case 'swap': {
      const proposed = [{ ...shift, user_id: r.user_id, cancelled: 0 }];
      if (d.swap_shift_id) { const ss = get('SELECT * FROM shifts WHERE id=?', d.swap_shift_id); if (!ss) bad(t('err_pick_shift')); proposed.push({ ...ss, user_id: shift.user_id }); }
      const errors = L.validate(proposed, {}, t); if (errors.length) bad(t('err_conflict'), { errors });
      for (const p of proposed) writeShift(p);
      if (shift.user_id) notifyUsers.add(shift.user_id);
      break;
    }
    case 'handover': {
      const time = L.parseHM(d.time);
      if (time <= shift.start) bad(t('err_time_format'));
      const res = applyShiftChange(shift, { end: time }, true, t);
      if (res.errors.length) bad(t('err_conflict'), { errors: res.errors });
      for (const p of res.proposed) writeShift(p);
      res.neighbours.forEach(n => notifyUsers.add(n.user_id));
      break;
    }
    case 'early': {
      if (d.noshow) writeShift({ ...shift, cancelled: 1 });
      else {
        const time = L.parseHM(d.time); if (time <= shift.start || time > shift.end) bad(t('err_time_format'));
        const errors = L.validate([{ ...shift, end: time }], {}, t); if (errors.length) bad(t('err_conflict'), { errors });
        writeShift({ ...shift, end: time });
      }
      break;
    }
    case 'avail':
      require('./avail').upsert(r.user_id, r.date, d, approver.id);
      break;
    case 'pallets':
      run(`INSERT INTO deliveries(location_id,date,user_id,pallets,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,datetime('now'))
        ON CONFLICT(location_id,date) DO UPDATE SET pallets=excluded.pallets, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at`, r.location_id, r.date, r.user_id, d.pallets, approver.id);
      break;
  }
  return notifyUsers;
}
app.post('/api/requests/:id/decide', wrap(req => {
  const r = get('SELECT * FROM requests WHERE id=?', Number(req.params.id)); if (!r) bad('not found');
  needAdmin(req, r.location_id);
  if (r.status !== 'pending') bad(req.t('err_already_decided'));
  needOpen(req, r.location_id, r.date);
  const approve = !!req.body.approve;
  let others = new Set();
  tx(() => {
    if (approve) others = applyRequest(r, req.user, req.t);
    run('UPDATE requests SET status=?, decided_by=?, decided_at=datetime(\'now\'), decision_comment=? WHERE id=?', approve ? 'approved' : 'rejected', req.user.id, req.body.comment || null, r.id);
    L.audit(req.user, r.location_id, approve ? 'request_approve' : 'request_reject', { id: r.id, type: r.type, user: L.userName(r.user_id), desc: describeRequest(r, req.t), comment: req.body.comment });
  });
  const tt = tFor(r.user_id);
  notify(r.user_id, tt(approve ? 'n_req_approved' : 'n_req_rejected', { type: tt('rq_' + r.type), desc: describeRequest(r, tt) }) + (req.body.comment ? ` — ${req.body.comment}` : ''), 'decision');
  for (const u of others) if (u !== r.user_id) { const t2 = tFor(u); notify(u, t2('n_shift_changed_by_req', { desc: describeRequest(r, t2), name: L.userName(r.user_id) }), 'shift'); }
  return { ok: true };
}));

// ---------- notes ----------
app.get('/api/notes', wrap(req => {
  const locId = Number(req.query.loc); needMember(req, locId);
  const admin = L.isAdmin(req.user, locId);
  const rows = all(`SELECT n.*, u.name author, r.name resolver FROM notes n JOIN users u ON u.id=n.author_id LEFT JOIN users r ON r.id=n.resolved_by WHERE n.location_id=? ${admin ? '' : "AND n.created_at >= datetime('now','-7 days')"} ORDER BY n.id DESC LIMIT 300`, locId);
  return rows;
}));
app.post('/api/notes', wrap(req => {
  const locId = Number(req.body.location_id); needMember(req, locId);
  const text = String(req.body.text || '').trim(); if (!text) bad(req.t('err_required'));
  if (text.length > 500) bad(req.t('err_too_long'));
  const r = run('INSERT INTO notes(location_id,author_id,text) VALUES(?,?,?)', locId, req.user.id, text);
  L.audit(req.user, locId, 'note_add', { text });
  // next shift at this location
  const now = L.warsawNow();
  const next = all("SELECT * FROM shifts WHERE location_id=? AND date>=? AND slot IN ('s1','s2','rs') AND user_id IS NOT NULL AND cancelled=0 ORDER BY date, start", locId, now.date)
    .find(s => (s.date > now.date || s.start >= now.min - 30) && s.user_id !== req.user.id);
  const l = get('SELECT * FROM locations WHERE id=?', locId);
  if (next) notify(next.user_id, tFor(next.user_id)('n_note', { loc: l.name, name: req.user.name, text }), 'note');
  notifyAdmins(locId, tFor(l.admin_id)('n_note', { loc: l.name, name: req.user.name, text }), 'note', req.user.id);
  return { id: Number(r.lastInsertRowid) };
}));
app.post('/api/notes/:id/resolve', wrap(req => {
  const n = get('SELECT * FROM notes WHERE id=?', Number(req.params.id)); if (!n) bad('not found');
  needAdmin(req, n.location_id);
  run("UPDATE notes SET resolved_by=?, resolved_at=datetime('now') WHERE id=?", req.user.id, n.id);
  L.audit(req.user, n.location_id, 'note_resolve', { text: n.text });
  return { ok: true };
}));

// ---------- warnings ----------
app.get('/api/warnings', wrap(req => {
  const locIds = req.query.loc === 'all' ? L.adminLocIds(req.user) : [Number(req.query.loc)];
  locIds.forEach(l => needAdmin(req, l));
  const now = L.warsawNow();
  const from = req.query.from || L.monthRange(L.prevMonth(L.monthOf(now.date)))[0];
  const to = req.query.to || L.addDays(now.date, 14);
  return L.warnings(locIds, from, to, req.t).map(w => ({ ...w, location: locName(w.location_id) }));
}));
app.post('/api/warnings/ack', wrap(req => {
  const key = String(req.body.key || ''); const locId = Number(key.split(':')[1]);
  needAdmin(req, locId);
  run('INSERT OR REPLACE INTO acks(key,location_id,by) VALUES(?,?,?)', key, locId, req.user.id);
  L.audit(req.user, locId, 'warning_ack', { key, comment: req.body.comment || '' });
  return { ok: true };
}));

// ---------- payroll status / month close ----------
app.post('/api/payroll-status', wrap(req => {
  const b = req.body; const locId = Number(b.location_id); needAdmin(req, locId);
  const field = b.field === 'paid' ? 'paid' : 'checked';
  run('INSERT OR IGNORE INTO payroll_status(location_id,user_id,month) VALUES(?,?,?)', locId, Number(b.user_id), b.month);
  run(`UPDATE payroll_status SET ${field}_by=?, ${field}_at=${b.value ? "datetime('now')" : 'NULL'} WHERE location_id=? AND user_id=? AND month=?`, b.value ? req.user.id : null, locId, Number(b.user_id), b.month);
  L.audit(req.user, locId, 'payroll_' + field, { user: L.userName(Number(b.user_id)), month: b.month, value: !!b.value });
  return { ok: true };
}));
app.get('/api/months', wrap(req => {
  const locId = Number(req.query.loc); needAdmin(req, locId);
  return all('SELECT m.*, u.name closed_name FROM months m LEFT JOIN users u ON u.id=m.closed_by WHERE location_id=? ORDER BY month DESC', locId);
}));
app.post('/api/months/close', wrap(req => {
  const locId = Number(req.body.location_id); needAdmin(req, locId);
  const month = String(req.body.month); if (!/^\d{4}-\d{2}$/.test(month)) bad('month');
  run("INSERT OR IGNORE INTO months(location_id,month,closed_by,closed_at) VALUES(?,?,?,datetime('now'))", locId, month, req.user.id);
  L.audit(req.user, locId, 'month_close', { month });
  return { ok: true };
}));
app.post('/api/months/reopen', wrap(req => {
  needOwner(req);
  const locId = Number(req.body.location_id);
  run('DELETE FROM months WHERE location_id=? AND month=?', locId, String(req.body.month));
  L.audit(req.user, locId, 'month_reopen', { month: req.body.month });
  return { ok: true };
}));

// ---------- audit ----------
app.get('/api/audit', wrap(req => {
  const loc = req.query.loc;
  if (loc === 'all') needOwner(req); else needAdmin(req, loc);
  const rows = loc === 'all' ? all('SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 500')
    : all('SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.location_id=? OR (a.location_id IS NULL AND ?) ORDER BY a.id DESC LIMIT 500', Number(loc), L.isAdminUser(req.user) ? 1 : 0);
  return rows.map(r => ({ ...r, location: locName(r.location_id) }));
}));

// ---------- reports ----------
function reportParams(req) {
  const q = req.query;
  let locIds;
  if (q.loc === 'all') { needOwner(req); locIds = all('SELECT id FROM locations WHERE active=1 ORDER BY sort,id').map(r => r.id); }
  else { needAdmin(req, q.loc); locIds = [Number(q.loc)]; }
  const now = L.warsawNow();
  const [mf, mt] = L.monthRange(L.monthOf(now.date));
  return { locIds, from: q.from || mf, to: q.to || mt, userId: q.user ? Number(q.user) : null, t: req.t, lang: req.user.lang || 'uk', user: req.user, all: q.loc === 'all' };
}
app.get('/api/reports/:type', wrap(req => reports.build(req.params.type, reportParams(req))));
app.get('/api/export/:type', async (req, res) => {
  try {
    const p = reportParams(req);
    const rep = reports.build(req.params.type, p);
    const fmt = req.query.format;
    const base = `zabka_${req.params.type}_${p.from}_${p.to}`;
    if (fmt === 'pdf') { const buf = await exporter.pdf(rep); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`); return res.end(buf); }
    const xbuf = await exporter.xlsx(rep);
    if (fmt === 'ods') { const obuf = await exporter.ods(xbuf); res.setHeader('Content-Type', 'application/vnd.oasis.opendocument.spreadsheet'); res.setHeader('Content-Disposition', `attachment; filename="${base}.ods"`); return res.end(obuf); }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`); res.end(xbuf);
  } catch (e) { if (!(e instanceof HttpError)) console.error(e); res.status(e.status || 500).json({ error: e.message }); }
});

// ---------- reminders (pending > 24h) ----------
function remind() {
  for (const r of all("SELECT * FROM requests WHERE status='pending' AND reminded_at IS NULL AND created_at <= datetime('now','-24 hours')")) {
    run("UPDATE requests SET reminded_at=datetime('now') WHERE id=?", r.id);
    const l = get('SELECT * FROM locations WHERE id=?', r.location_id);
    const ids = adminRecipients(r.location_id);
    for (const id of ids) { const tt = tFor(id); notify(id, `[${l.name}] ` + tt('n_reminder', { name: L.userName(r.user_id), type: tt('rq_' + r.type), desc: describeRequest(r, tt) }), 'reminder'); }
  }
}
setInterval(remind, 15 * 60 * 1000);

require('./money').register(app, { wrap, needAdmin, needMember, bad });
const avail = require('./avail'); avail.register(app, { wrap, needAdmin, needMember, bad, forbid }); // диспозиція
require('./tasks').register(app, { wrap, needAdmin, needMember, bad, forbid }); // завдання від адміністратора
require('./telegram').register(app, { wrap, bad, forbid, L }); // Telegram-бот: webhook, токен, тест
require('./vacations').register(app, { wrap, needMember, bad, forbid }); // урлопи // премії, штрафи, мінуси, аванси

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

module.exports = { app, hash };

if (require.main === module) {
  require('./seed').ensureSeed();
  require('./fixes').run({ hash, loginKey }); // одноразові виправлення даних
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Żabka Grafik: http://localhost:${port}`));
  startBot();
  remind();
}
