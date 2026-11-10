'use strict';
/* «Завдання від адміністратора» — доповнення до основної програми. */
const { db, all, get, run } = require('./db');
const L = require('./logic');
const { notify, notifyAdmins } = require('./notify');
const { tr } = require('../public/i18n.js');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL, date TEXT NOT NULL,
  target TEXT NOT NULL, slot TEXT, user_id INTEGER, text TEXT NOT NULL, due INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', result_comment TEXT, done_by INTEGER, done_at TEXT,
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_by INTEGER, updated_at TEXT,
  notified TEXT DEFAULT '[]', deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_tasks ON tasks(location_id, date);
`);

const SLOTS = ['s1', 's2', 'rs', 'dl'];
const tFor = uid => { const u = get('SELECT lang FROM users WHERE id=?', uid); return (k, p) => tr((u && u.lang) || 'uk', k, p); };
const locName = id => (get('SELECT name FROM locations WHERE id=?', id) || {}).name || '';

/** Хто зараз має виконати завдання: [{user_id, start, end}] — за актуальним графіком (після замін і пересменок). */
function recipients(task) {
  const shifts = all('SELECT * FROM shifts WHERE location_id=? AND date=? AND user_id IS NOT NULL AND cancelled=0', task.location_id, task.date)
    .filter(s => L.isPublished(s.location_id, s.date));
  const win = s => s.slot === 'dl' ? { start: 360, end: 1380 } : { start: s.start, end: s.end };
  if (task.target === 'slot') { const s = shifts.find(x => x.slot === task.slot); return s ? [{ user_id: s.user_id, ...win(s) }] : []; }
  if (task.target === 'user') {
    const mine = shifts.filter(s => s.user_id === task.user_id);
    return [{ user_id: task.user_id, start: mine.length ? Math.min(...mine.map(s => win(s).start)) : 480, end: mine.length ? Math.max(...mine.map(s => win(s).end)) : 1380 }];
  }
  const by = new Map();
  for (const s of shifts) { const w = win(s); const r = by.get(s.user_id); by.set(s.user_id, r ? { user_id: s.user_id, start: Math.min(r.start, w.start), end: Math.max(r.end, w.end) } : { user_id: s.user_id, ...w }); }
  return [...by.values()];
}
/** Хвилина, до якої завдання має бути виконане: «до котрої години» або кінець зміни. */
function deadlineMin(task, rec) { return task.due != null ? task.due : (rec.length ? Math.max(...rec.map(r => r.end)) : 1380); }
function overdue(task, rec) {
  if (task.status !== 'pending') return false;
  const now = L.warsawNow();
  return task.date < now.date || (task.date === now.date && now.min > deadlineMin(task, rec));
}
function targetLabel(task, t) {
  if (task.target === 'slot') return t('slot_' + task.slot);
  if (task.target === 'user') return L.userName(task.user_id);
  return t('tk_all');
}
function view(task, t) {
  const rec = recipients(task);
  return { ...task, due: task.due != null ? L.hm(task.due) : null, location: locName(task.location_id), target_label: targetLabel(task, t),
    recipients: rec.map(r => ({ user_id: r.user_id, name: L.userName(r.user_id) })), overdue: overdue(task, rec),
    created_name: L.userName(task.created_by), updated_name: L.userName(task.updated_by), done_name: L.userName(task.done_by) };
}

/** Сповіщення працівникам на початку їхньої зміни (або одразу, якщо зміна вже йде). */
function dispatch() {
  const now = L.warsawNow();
  for (const task of all("SELECT * FROM tasks WHERE deleted=0 AND status='pending' AND date=?", now.date)) {
    let sent; try { sent = JSON.parse(task.notified || '[]'); } catch (_) { sent = []; }
    let changed = false;
    for (const r of recipients(task)) {
      if (sent.includes(r.user_id) || now.min < r.start || now.min >= r.end) continue;
      const t = tFor(r.user_id);
      notify(r.user_id, t('n_task', { loc: locName(task.location_id), text: task.text, due: task.due != null ? ' ' + t('tk_until', { t: L.hm(task.due) }) : '' }), 'task');
      sent.push(r.user_id); changed = true;
    }
    if (changed) run('UPDATE tasks SET notified=? WHERE id=?', JSON.stringify(sent), task.id);
  }
}

function register(app, h) {
  const { wrap, needAdmin, needMember, bad, forbid } = h;
  const needAnyAdmin = req => { if (!L.isAdminUser(req.user)) forbid(); };
  const parse = (req, b, old) => {
    const t = req.t;
    const locId = Number(b.location_id ?? old?.location_id); needAdmin(req, locId);
    if (!get('SELECT 1 FROM locations WHERE id=?', locId)) bad(t('err_required'));
    const date = String(b.date ?? old?.date ?? ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad(t('err_required'));
    const target = String(b.target ?? old?.target ?? '');
    if (!['slot', 'user', 'all'].includes(target)) bad(t('err_task_target'));
    let slot = null, userId = null;
    if (target === 'slot') { slot = String(b.slot ?? old?.slot ?? ''); if (!SLOTS.includes(slot)) bad(t('err_task_target')); }
    if (target === 'user') { userId = Number(b.user_id ?? old?.user_id); if (!get('SELECT 1 FROM user_locations WHERE user_id=? AND location_id=?', userId, locId)) bad(t('err_not_member', { name: L.userName(userId) || '?' })); }
    const text = String(b.text ?? old?.text ?? '').trim(); if (!text) bad(t('err_task_text')); if (text.length > 500) bad(t('err_too_long'));
    let due = b.due === undefined ? (old ? old.due : null) : (b.due ? L.parseHM(b.due) : null);
    if (due != null && isNaN(due)) bad(t('err_time_format'));
    return { location_id: locId, date, target, slot, user_id: userId, text, due };
  };
  const loadPending = (req, id) => {
    const task = get('SELECT * FROM tasks WHERE id=? AND deleted=0', Number(id)); if (!task) bad('not found');
    needAdmin(req, task.location_id);
    if (task.status !== 'pending') bad(req.t('err_task_done'));
    return task;
  };

  // --- адміністратор ---
  app.get('/api/tasks', wrap(req => {
    needAnyAdmin(req);
    const q = req.query; const cond = ['deleted=0']; const p = [];
    if (q.loc && q.loc !== 'all') { cond.push('location_id=?'); p.push(Number(q.loc)); }
    if (q.from) { cond.push('date>=?'); p.push(q.from); }
    if (q.to) { cond.push('date<=?'); p.push(q.to); }
    if (q.status && ['pending', 'done', 'failed'].includes(q.status)) { cond.push('status=?'); p.push(q.status); }
    let list = all(`SELECT * FROM tasks WHERE ${cond.join(' AND ')} ORDER BY date DESC, COALESCE(due, 1440), id DESC LIMIT 500`, ...p).map(x => view(x, req.t));
    if (q.user) { const uid = Number(q.user); list = list.filter(x => x.user_id === uid || x.done_by === uid || x.recipients.some(r => r.user_id === uid)); }
    if (q.overdue) list = list.filter(x => x.overdue);
    return list;
  }));
  app.post('/api/tasks', wrap(req => {
    needAnyAdmin(req);
    const v = parse(req, req.body);
    const r = run('INSERT INTO tasks(location_id,date,target,slot,user_id,text,due,created_by) VALUES(?,?,?,?,?,?,?,?)', v.location_id, v.date, v.target, v.slot, v.user_id, v.text, v.due, req.user.id);
    const task = get('SELECT * FROM tasks WHERE id=?', Number(r.lastInsertRowid));
    L.audit(req.user, v.location_id, 'task_create', { id: task.id, date: v.date, for: targetLabel(task, req.t), text: v.text, due: v.due != null ? L.hm(v.due) : '' });
    dispatch();
    return view(task, req.t);
  }));
  app.put('/api/tasks/:id', wrap(req => {
    needAnyAdmin(req);
    const old = loadPending(req, req.params.id);
    const v = parse(req, req.body, old);
    const reset = v.date !== old.date || v.target !== old.target || v.slot !== old.slot || v.user_id !== old.user_id || v.location_id !== old.location_id;
    run(`UPDATE tasks SET location_id=?, date=?, target=?, slot=?, user_id=?, text=?, due=?, updated_by=?, updated_at=datetime('now')${reset ? ", notified='[]'" : ''} WHERE id=?`,
      v.location_id, v.date, v.target, v.slot, v.user_id, v.text, v.due, req.user.id, old.id);
    const task = get('SELECT * FROM tasks WHERE id=?', old.id);
    L.audit(req.user, v.location_id, 'task_edit', { id: old.id, from: `${old.date} ${targetLabel(old, req.t)}: ${old.text}`, to: `${v.date} ${targetLabel(task, req.t)}: ${v.text}` });
    dispatch();
    return view(task, req.t);
  }));
  app.delete('/api/tasks/:id', wrap(req => {
    needAnyAdmin(req);
    const task = loadPending(req, req.params.id);
    run("UPDATE tasks SET deleted=1, updated_by=?, updated_at=datetime('now') WHERE id=?", req.user.id, task.id);
    L.audit(req.user, task.location_id, 'task_delete', { id: task.id, date: task.date, text: task.text });
    return { ok: true };
  }));

  // --- працівник ---
  app.get('/api/tasks/my', wrap(req => {
    const locId = Number(req.query.loc); needMember(req, locId);
    const now = L.warsawNow();
    // завдання на сьогодні, де працівник — актуальний виконавець (за графіком після замін)
    return all("SELECT * FROM tasks WHERE deleted=0 AND location_id=? AND date=? ORDER BY COALESCE(due, 1440), id", locId, now.date)
      .map(x => view(x, req.t))
      .filter(x => x.recipients.some(r => r.user_id === req.user.id) || x.done_by === req.user.id);
  }));
  app.post('/api/tasks/:id/result', wrap(req => {
    const task = get('SELECT * FROM tasks WHERE id=? AND deleted=0', Number(req.params.id)); if (!task) bad('not found');
    const isRec = recipients(task).some(r => r.user_id === req.user.id);
    if (!isRec && !L.isAdmin(req.user, task.location_id)) forbid();
    if (task.status !== 'pending') bad(req.t('err_task_done'));
    const status = req.body.done ? 'done' : 'failed';
    const comment = String(req.body.comment || '').trim().slice(0, 300) || null;
    if (status === 'failed' && !comment) bad(req.t('err_comment_required'));
    run("UPDATE tasks SET status=?, result_comment=?, done_by=?, done_at=datetime('now') WHERE id=?", status, comment, req.user.id, task.id);
    L.audit(req.user, task.location_id, status === 'done' ? 'task_done' : 'task_failed', { id: task.id, text: task.text, comment });
    const l = get('SELECT * FROM locations WHERE id=?', task.location_id);
    notifyAdmins(task.location_id, tFor(l.admin_id || req.user.id)(status === 'done' ? 'n_task_done' : 'n_task_failed', { name: req.user.name, text: task.text, date: task.date, comment: comment ? ` — ${comment}` : '' }), 'task', req.user.id);
    return { ok: true };
  }));

  setInterval(dispatch, 5 * 60 * 1000); setTimeout(dispatch, 8000);
}

module.exports = { register, recipients, dispatch };
