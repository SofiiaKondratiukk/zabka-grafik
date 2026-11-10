'use strict';
const { all, get, run, setting } = require('./db');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let botUsername = null;

async function tg(method, body) {
  if (!TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { console.error('telegram error', e.message); return null; }
}

/** category: schedule | shift | decision | note | request | reminder */
function notify(userId, text, category) {
  if (!userId) return;
  const u = get('SELECT * FROM users WHERE id=? AND active=1', userId);
  if (!u) return;
  run('INSERT INTO notifications(user_id, text) VALUES(?,?)', userId, text);
  let prefs = {}; try { prefs = JSON.parse(u.notify || '{}'); } catch (_) {}
  if (prefs[category] === false) return;
  if (u.tg_chat_id) tg('sendMessage', { chat_id: u.tg_chat_id, text });
}
/**
 * Адміністратори, яким надходять запити/сповіщення локації: закріплений за локацією (і заступник)
 * + ті, хто увімкнув у налаштуваннях сповіщення з цієї локації. На права доступу не впливає.
 */
function adminRecipients(locId) {
  const l = get('SELECT * FROM locations WHERE id=?', locId);
  const ids = new Set();
  for (const u of all("SELECT id, notify FROM users WHERE role IN ('admin','owner') AND active=1")) {
    let prefs = {}; try { prefs = JSON.parse(u.notify || '{}'); } catch (_) {}
    if ((l && (l.admin_id === u.id || l.deputy_id === u.id)) || (Array.isArray(prefs.locs) && prefs.locs.includes(locId))) ids.add(u.id);
  }
  if (!ids.size) for (const u of all("SELECT id FROM users WHERE role IN ('admin','owner') AND active=1")) ids.add(u.id);
  return ids;
}
/** Notify admin(s) of location without duplicates. */
function notifyAdmins(locId, text, category, exceptId) {
  const l = get('SELECT * FROM locations WHERE id=?', locId);
  const ids = adminRecipients(locId);
  ids.delete(exceptId);
  for (const id of ids) notify(id, (l ? `[${l.name}] ` : '') + text, category);
}

async function startBot() {
  if (!TOKEN) { console.log('Telegram: TELEGRAM_BOT_TOKEN not set — notifications only in app'); return; }
  const me = await tg('getMe');
  if (me && me.ok) { botUsername = me.result.username; console.log('Telegram bot @' + botUsername); }
  let offset = Number(setting('tg_offset') || 0);
  const loop = async () => {
    const r = await tg('getUpdates', { offset, timeout: 25 });
    if (r && r.ok) for (const upd of r.result) {
      offset = upd.update_id + 1; setting('tg_offset', offset);
      const m = upd.message; if (!m || !m.text) continue;
      const code = (/^\/start\s+(\S+)/.exec(m.text) || [])[1];
      if (code) {
        const u = get('SELECT * FROM users WHERE tg_code=?', code);
        if (u) { run('UPDATE users SET tg_chat_id=?, tg_code=NULL WHERE id=?', String(m.chat.id), u.id); tg('sendMessage', { chat_id: m.chat.id, text: `✅ ${u.name}: Telegram прив'язано / połączono.` }); }
        else tg('sendMessage', { chat_id: m.chat.id, text: '❌ Код недійсний / Kod nieprawidłowy' });
      } else tg('sendMessage', { chat_id: m.chat.id, text: 'Żabka Grafik: відкрийте «Налаштування» в застосунку й натисніть «Прив\'язати Telegram».' });
    }
    setTimeout(loop, r ? 500 : 5000);
  };
  loop();
}
const getBotUsername = () => botUsername;
module.exports = { notify, notifyAdmins, adminRecipients, startBot, getBotUsername, tgEnabled: () => !!TOKEN };
