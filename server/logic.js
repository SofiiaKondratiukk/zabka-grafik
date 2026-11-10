'use strict';
const { all, get, run } = require('./db');

// ---------- time helpers ----------
const TZ = 'Europe/Warsaw';
function warsawNow() {
  const s = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [d, t] = s.split(' ');
  const [h, m] = t.split(':').map(Number);
  return { date: d, min: h * 60 + m };
}
const pd = d => new Date(d + 'T00:00:00Z');
const fd = dt => dt.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = pd(d); x.setUTCDate(x.getUTCDate() + n); return fd(x); };
const dow = d => (pd(d).getUTCDay() + 6) % 7; // 0=Mon..6=Sun
const weekStart = d => addDays(d, -dow(d));
const monthOf = d => d.slice(0, 7);
const monthRange = m => { const [y, mo] = m.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return [m + '-01', m + '-' + String(last).padStart(2, '0')]; };
const prevMonth = m => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return fd(d).slice(0, 7); };
const hm = min => min == null ? '' : String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
const parseHM = s => { if (s == null || s === '') return null; if (typeof s === 'number') return s; const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); if (!m) return NaN; return +m[1] * 60 + +m[2]; };
function dates(from, to) { const r = []; for (let d = from; d <= to; d = addDays(d, 1)) r.push(d); return r; }
const DELIVERY_DOW = [0, 2, 3, 4]; // Mon, Wed, Thu, Fri
const TIMED = ['s1', 's2', 'rs'];

function defaults(date, slot) {
  const sun = dow(date) === 6;
  if (slot === 's1') return { start: sun ? 480 : 360, end: 870 };
  if (slot === 's2') return { start: 870, end: 1380 };
  if (slot === 'rs') return { start: 1080, end: 1380 };
  return { start: null, end: null };
}

const palletPay = p => (p && p > 0) ? 120 + (p - 1) * 80 : 0;

// ---------- users / access ----------
const userName = id => id ? ((get('SELECT name FROM users WHERE id=?', id) || {}).name || '?') : '';
function locationsFor(user) {
  if (user.role === 'owner') return all('SELECT * FROM locations WHERE active=1 ORDER BY sort,id');
  return all(`SELECT DISTINCT l.* FROM locations l LEFT JOIN user_locations ul ON ul.location_id=l.id AND ul.user_id=?
    WHERE l.active=1 AND (ul.user_id IS NOT NULL OR l.admin_id=? OR l.deputy_id=?) ORDER BY l.sort,l.id`, user.id, user.id, user.id);
}
function isAdmin(user, locId) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  const l = get('SELECT admin_id, deputy_id FROM locations WHERE id=?', locId);
  return !!l && (l.admin_id === user.id || l.deputy_id === user.id);
}
function adminLocIds(user) {
  if (user.role === 'owner') return all('SELECT id FROM locations').map(r => r.id);
  return all('SELECT id FROM locations WHERE admin_id=? OR deputy_id=?', user.id, user.id).map(r => r.id);
}
const canRates = user => user.role === 'owner' || !!user.can_rates;
function isClosed(locId, date) { return !!get('SELECT 1 FROM months WHERE location_id=? AND month=?', locId, monthOf(date)); }
function isPublished(locId, date) { return (get('SELECT status FROM weeks WHERE location_id=? AND week=?', locId, weekStart(date)) || {}).status === 'published'; }

// ---------- hard rules ----------
/**
 * Validate a set of proposed shifts for given dates.
 * proposed: array of shift objects {id?, location_id, date, slot, user_id, start, end, cancelled}
 * replacing all existing shifts with same (location_id,date,slot) or same id.
 * opts.strictHandover: require s1.end == s2.start (schedule editing).
 */
function validate(proposed, opts = {}, t = (k, p) => k) {
  const errors = [];
  const byDate = {};
  for (const p of proposed) (byDate[p.date] = byDate[p.date] || []).push(p);
  for (const date of Object.keys(byDate)) {
    const existing = all('SELECT * FROM shifts WHERE date=?', date);
    const map = new Map();
    for (const s of existing) map.set(s.location_id + ':' + s.slot, s);
    for (const p of byDate[date]) {
      if (p.id) for (const [k, s] of map) if (s.id === p.id) map.delete(k);
      map.set(p.location_id + ':' + p.slot, p);
    }
    const list = [...map.values()].filter(s => s.user_id && !s.cancelled);
    const touchedLocs = new Set(byDate[date].map(p => p.location_id));
    const touchedUsers = new Set(byDate[date].map(p => p.user_id).filter(Boolean));
    // basic time checks
    for (const s of list) {
      if (!TIMED.includes(s.slot)) continue;
      if (s.start == null || s.end == null || isNaN(s.start) || isNaN(s.end) || s.start < 0 || s.end > 1440 || s.start >= s.end)
        errors.push(t('err_time', { date, slot: t('slot_' + s.slot), name: userName(s.user_id) }));
    }
    // per location: s1 / s2 never overlap; strict equality when editing schedule
    for (const loc of touchedLocs) {
      const s1 = map.get(loc + ':s1'), s2 = map.get(loc + ':s2');
      if (s1 && s2 && s1.user_id && s2.user_id && !s1.cancelled && !s2.cancelled) {
        if (s1.end > s2.start) errors.push(t('err_overlap_slots', { date, a: userName(s1.user_id), b: userName(s2.user_id), t1: hm(s1.end), t2: hm(s2.start) }));
        else if (opts.strictHandover && s1.end !== s2.start) errors.push(t('err_handover', { date, t1: hm(s1.end), t2: hm(s2.start) }));
      }
    }
    // per user: no overlapping intervals (any location)
    const byUser = {};
    for (const s of list) if (TIMED.includes(s.slot)) (byUser[s.user_id] = byUser[s.user_id] || []).push(s);
    for (const uid of Object.keys(byUser)) {
      if (!touchedUsers.has(+uid)) continue;
      const arr = byUser[uid].sort((a, b) => a.start - b.start);
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (a.start < b.end && b.start < a.end) {
          const la = (get('SELECT name FROM locations WHERE id=?', a.location_id) || {}).name;
          const lb = (get('SELECT name FROM locations WHERE id=?', b.location_id) || {}).name;
          errors.push(t('err_user_overlap', { date, name: userName(+uid), a: `${t('slot_' + a.slot)} ${la} ${hm(a.start)}–${hm(a.end)}`, b: `${t('slot_' + b.slot)} ${lb} ${hm(b.start)}–${hm(b.end)}` }));
        }
      }
    }
  }
  return [...new Set(errors)];
}

// ---------- computing worked time ----------
function shiftCredited(s, now) {
  if (!s.user_id || s.cancelled || !TIMED.includes(s.slot)) return false;
  if (!isPublished(s.location_id, s.date)) return false;
  return s.date < now.date || (s.date === now.date && s.end <= now.min);
}

/** Records per (location,user,date). */
function computeRecords(locIds, from, to, userId) {
  const now = warsawNow();
  if (!locIds.length) return [];
  const ph = locIds.map(() => '?').join(',');
  const uf = userId ? ' AND user_id=' + Number(userId) : '';
  const recs = new Map();
  const rec = (loc, uid, date) => {
    const k = loc + ':' + uid + ':' + date;
    if (!recs.has(k)) recs.set(k, { location_id: loc, user_id: uid, date, shifts: [], sched: 0, extra: 0, training: 0, pallets: 0, deliveries: 0, adj: [], planned: [] });
    return recs.get(k);
  };
  for (const s of all(`SELECT * FROM shifts WHERE location_id IN (${ph}) AND date BETWEEN ? AND ?${uf} ORDER BY date, start`, ...locIds, from, to)) {
    if (!TIMED.includes(s.slot) || !s.user_id) continue;
    const r = rec(s.location_id, s.user_id, s.date);
    if (shiftCredited(s, now)) { r.shifts.push(s); r.sched += s.end - s.start; }
    else if (!s.cancelled && isPublished(s.location_id, s.date)) r.planned.push(s);
  }
  for (const a of all(`SELECT * FROM adjustments WHERE deleted=0 AND location_id IN (${ph}) AND date BETWEEN ? AND ?${uf}`, ...locIds, from, to)) {
    const r = rec(a.location_id, a.user_id, a.date);
    if (a.kind === 'training') r.training += a.minutes; else r.extra += a.minutes;
    r.adj.push(a);
  }
  for (const d of all(`SELECT * FROM deliveries WHERE pallets IS NOT NULL AND location_id IN (${ph}) AND date BETWEEN ? AND ?${uf}`, ...locIds, from, to)) {
    if (!d.user_id) continue;
    const r = rec(d.location_id, d.user_id, d.date);
    r.pallets += d.pallets; r.deliveries += 1; r.delivery = d;
  }
  return [...recs.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function money(rec, user) {
  const hoursSum = (rec.sched + rec.extra) / 60 * user.rate + rec.training / 60 * user.training_rate;
  const palletSum = rec.deliveries ? 40 * rec.deliveries + 80 * rec.pallets : 0; // == sum(120+(p-1)*80)
  return { hoursSum, palletSum, total: hoursSum + palletSum };
}

// ---------- warnings ----------
function warnings(locIds, from, to, t = k => k) {
  const now = warsawNow();
  const start = get("SELECT value FROM settings WHERE key='start_date'")?.value || '2000-01-01';
  if (from < start) from = start;
  const out = [];
  for (const locId of locIds) {
    const loc = get('SELECT * FROM locations WHERE id=?', locId);
    if (!loc || !loc.active) continue;
    for (const d of dates(from, to)) {
      // 1. delivery day without confirmed pallets
      if (DELIVERY_DOW.includes(dow(d)) && (d < now.date || (d === now.date && now.min >= 23 * 60))) {
        const del = get('SELECT * FROM deliveries WHERE location_id=? AND date=? AND pallets IS NOT NULL', locId, d);
        if (!del) out.push({ key: `dl:${locId}:${d}`, location_id: locId, date: d, kind: 'delivery', text: t('warn_delivery') });
      }
      // 2. empty slot in published week
      if (isPublished(locId, d) && d >= now.date) {
        const slots = loc.has_restock ? ['s1', 's2', 'rs'] : ['s1', 's2'];
        for (const sl of slots) {
          const s = get('SELECT * FROM shifts WHERE location_id=? AND date=? AND slot=?', locId, d, sl);
          if (!s || !s.user_id || s.cancelled) out.push({ key: `empty:${locId}:${d}:${sl}`, location_id: locId, date: d, slot: sl, kind: 'empty', text: t('warn_empty', { slot: t('slot_' + sl) }) });
        }
      }
    }
    // 3. pending requests > 24h
    for (const r of all("SELECT * FROM requests WHERE location_id=? AND status='pending' AND created_at <= datetime('now','-24 hours')", locId))
      out.push({ key: `req:${r.id}`, location_id: locId, date: r.date || r.created_at.slice(0, 10), kind: 'request', request_id: r.id, text: t('warn_request', { name: userName(r.user_id), type: t('rq_' + r.type) }) });
  }
  out.push(...require('./money').warnings(locIds, from, to, t)); // премії/штрафи/мінуси/аванси
  const acked = new Set(all('SELECT key FROM acks').map(r => r.key));
  return out.filter(w => !acked.has(w.key)).sort((a, b) => a.date.localeCompare(b.date));
}

function audit(user, locId, action, details) {
  run('INSERT INTO audit(user_id, location_id, action, details) VALUES(?,?,?,?)', user ? user.id : null, locId || null, action, typeof details === 'string' ? details : JSON.stringify(details));
}

module.exports = { warsawNow, addDays, dow, weekStart, monthOf, monthRange, prevMonth, hm, parseHM, dates, defaults, palletPay, DELIVERY_DOW, TIMED,
  userName, locationsFor, isAdmin, adminLocIds, canRates, isClosed, isPublished, validate, computeRecords, money, warnings, audit, shiftCredited };
