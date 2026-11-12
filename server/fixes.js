'use strict';
/* Одноразові виправлення даних, які виконуються під час запуску (кожне — лише один раз). Нікого не вимикають. */
const { all, run, setting } = require('./db');
const L = require('./logic');
const { notify } = require('./notify');

function fixAndrii(h) {
  // 2026-11: обліковий запис працівника Андрія — логін andrii2, пароль zabka2026
  const keys = ['andrii2', 'andrii 2', 'андрій2', 'андрій 2'];
  const users = all('SELECT * FROM users');
  const byLogin = users.filter(u => keys.includes(h.loginKey(u.login)));
  let target = null;
  if (byLogin.length) {
    const active = byLogin.filter(u => u.active);
    if (active.length === 1) target = active[0];
    else if (active.length === 0 && byLogin.length === 1) target = byLogin[0];
    else return 'кілька активних записів з таким логіном — пропущено';
  } else {
    const named = users.filter(u => u.active && /^андрій(\s|$)/i.test(u.name.trim()));
    if (named.length === 1) target = named[0];
    else if (named.length > 1) return 'кілька працівників «Андрій» — пропущено';
    else {
      const latin = users.filter(u => u.active && /^andrii(\s|$)/i.test(u.name.trim()));
      if (latin.length === 1) target = latin[0]; else return 'обліковий запис не знайдено однозначно — пропущено';
    }
  }
  // логін andrii2 має бути вільним: перейменовуємо лише НЕАКТИВНІ дублікати (вони й так не можуть увійти)
  for (const u of byLogin) if (u.id !== target.id) {
    if (u.active) return 'логін andrii2 має інший активний запис — пропущено';
    run('UPDATE users SET login=? WHERE id=?', `${u.login}-old${u.id}`, u.id);
  }
  run('UPDATE users SET login=?, pass=?, active=1 WHERE id=?', 'andrii2', h.hash('zabka2026'), target.id);
  L.audit(null, null, 'account_fix', { user: target.name, login: [target.login, 'andrii2'], password: 'zabka2026 (reset)' });
  notify(target.id, '🔑 Ваш логін для входу: andrii2, пароль: zabka2026. Змініть пароль у «Налаштуваннях».', 'shift');
  return `обліковий запис «${target.name}» → логін andrii2`;
}

function run_(h) {
  if (!setting('fix_andrii2_v2')) {
    setting('fix_andrii2_v2', 1);
    try { console.log('fix: ' + fixAndrii(h)); } catch (e) { console.error('fix andrii2 failed', e.message); }
  }
}
module.exports = { run: run_ };
