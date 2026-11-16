'use strict';
/*
 * Звіт Power BI у програмі (вкладка «Прострочка» тощо) + щоденне автоматичне завдання «перевірити».
 * Адміністратор вставляє посилання «Опублікувати в інтернеті» (https://app.powerbi.com/view?r=...) для локації.
 */
const { get, setting, all } = require('./db');
const L = require('./logic');
const tasks = require('./tasks');

const keyOf = (locId, k) => `rep_${k}_${locId}`;
function cfg(locId) {
  return {
    url: setting(keyOf(locId, 'url')) || '',
    title: setting(keyOf(locId, 'title')) || 'Прострочка',
    daily: setting(keyOf(locId, 'daily')) === '1',
    slot: setting(keyOf(locId, 'slot')) || 's1',
    text: setting(keyOf(locId, 'text')) || '🧾 Перевірити прострочку: відкрийте вкладку «Прострочка», зніміть товар з полиці й позначте «Виконано».',
  };
}
/** Для /api/me: які локації мають звіт (назва вкладки). */
function menuFor(locIds) { const out = {}; for (const id of locIds) { const c = cfg(id); if (c.url) out[id] = c.title; } return out; }

/** Щодня: завдання «перевірити прострочку» на вибрану зміну (сповіщення приходить на початку зміни). */
function daily() {
  const now = L.warsawNow();
  for (const l of all('SELECT id FROM locations WHERE active=1')) {
    const c = cfg(l.id);
    if (!c.url || !c.daily) continue;
    if (setting(keyOf(l.id, 'last')) === now.date) continue;
    setting(keyOf(l.id, 'last'), now.date);
    const exists = get("SELECT id FROM tasks WHERE deleted=0 AND location_id=? AND date=? AND text=?", l.id, now.date, c.text);
    if (!exists) tasks.createSystemTask({ location_id: l.id, date: now.date, target: 'slot', slot: c.slot, text: c.text });
  }
}

function register(app, h) {
  const { wrap, needMember, bad, forbid } = h;
  app.get('/api/report-embed', wrap(req => {
    const locId = Number(req.query.loc); needMember(req, locId);
    const c = cfg(locId);
    return L.isAdminUser(req.user) ? c : { url: c.url, title: c.title };
  }));
  app.put('/api/report-embed', wrap(req => {
    if (!L.isAdminUser(req.user)) forbid();
    const b = req.body; const locId = Number(b.location_id);
    if (!get('SELECT 1 FROM locations WHERE id=?', locId)) bad('location');
    let url = String(b.url || '').trim();
    if (url) {
      const m = /src="([^"]+)"/.exec(url); if (m) url = m[1]; // вставили весь код <iframe ...>
      if (!/^https:\/\/(app\.powerbi\.com|app\.fabric\.microsoft\.com)\//.test(url)) bad(req.t('err_report_url'));
    }
    const set = (k, v) => setting(keyOf(locId, k), v);
    set('url', url);
    if (b.title != null) set('title', String(b.title).trim().slice(0, 30) || 'Прострочка');
    if (b.daily != null) set('daily', b.daily ? '1' : '0');
    if (['s1', 's2', 'rs', 'dl'].includes(b.slot)) set('slot', b.slot);
    if (b.text != null && String(b.text).trim()) set('text', String(b.text).trim().slice(0, 300));
    L.audit(req.user, locId, 'report_embed', { url: url ? 'set' : 'removed', title: cfg(locId).title, daily: cfg(locId).daily, slot: cfg(locId).slot });
    daily();
    return cfg(locId);
  }));
  setInterval(daily, 10 * 60 * 1000); setTimeout(daily, 10000);
}
module.exports = { register, menuFor };
