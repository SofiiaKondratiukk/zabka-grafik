'use strict';
const { all, get, run, setting } = require('./db');
const telegram = require('./telegram'); // бот: токен, webhook/polling, надсилання

/** category: schedule | shift | decision | note | request | reminder */
function notify(userId, text, category) {
  if (!userId) return;
  const u = get('SELECT * FROM users WHERE id=? AND active=1', userId);
  if (!u) return;
  run('INSERT INTO notifications(user_id, text) VALUES(?,?)', userId, text);
  let prefs = {}; try { prefs = JSON.parse(u.notify || '{}'); } catch (_) {}
  if (prefs[category] === false) return;
  if (u.tg_chat_id) telegram.send(u.tg_chat_id, text);
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

const startBot = () => telegram.start();
const getBotUsername = () => telegram.username();
const tgEnabled = () => telegram.status().ok;
module.exports = { notify, notifyAdmins, adminRecipients, startBot, getBotUsername, tgEnabled };
