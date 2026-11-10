'use strict';
const { all, get, run, tx, setting } = require('./db');
const L = require('./logic');

const LOCS = [
  { name: 'Nadwiślańska 11', admin: 'sofiia', restock: 1 },
  { name: 'Dietla 68', admin: 'andrii', restock: 0 },
  { name: 'Stradomska 18', admin: 'mariia', restock: 0 },
];
const USERS = [
  { login: 'mariia', name: 'Mariia Poradiuk', role: 'owner', locs: [3] },
  { login: 'sofiia', name: 'Sofiia Kondratiuk', locs: [1] },
  { login: 'andrii', name: 'Andrii Lavtakov', locs: [2] },
  { login: 'ivan', name: 'Іван', locs: [1, 2] },
  { login: 'maksym', name: 'Максим', locs: [1, 3] },
  { login: 'nikita', name: 'Нікіта', locs: [2, 3] },
  { login: 'kiril', name: 'Кіріл', locs: [1] },
  { login: 'violetta', name: 'Віолетта', locs: [1] },
  { login: 'nadia', name: 'Надя', locs: [1] },
  { login: 'khrystia', name: 'Христя', locs: [1] },
  { login: 'tioma', name: 'Тьома', locs: [2] },
  { login: 'ira', name: 'Іра', locs: [2, 3], rate: 25 },
  { login: 'olena', name: 'Олена', locs: [3] },
];

function ensureSeed() {
  if (get('SELECT count(*) c FROM users').c > 0) return;
  const { hash } = require('./server');
  const pw = process.env.INITIAL_PASSWORD || 'zabka2026';
  tx(() => {
    setting('start_date', L.warsawNow().date);
    setting('base_rate', 31.4); setting('training_rate', 20);
    const ids = {};
    for (const u of USERS) ids[u.login] = Number(run('INSERT INTO users(login,pass,name,role,rate) VALUES(?,?,?,?,?)', u.login, hash(pw), u.name, u.role || 'user', u.rate || 31.4).lastInsertRowid);
    LOCS.forEach((l, i) => run('INSERT INTO locations(id,name,admin_id,has_restock,sort) VALUES(?,?,?,?,?)', i + 1, l.name, ids[l.admin], l.restock, i + 1));
    for (const u of USERS) for (const l of u.locs) run('INSERT INTO user_locations(user_id,location_id) VALUES(?,?)', ids[u.login], l);
  });
  console.log(`Seeded users. Initial password for all: ${pw}`);
  if (process.env.DEMO === '1') demo();
}

/** Demo data: previous + current week schedule for all locations. */
function demo() {
  const id = login => get('SELECT id FROM users WHERE login=?', login).id;
  const plan = {
    1: { s1: ['kiril', 'violetta', 'nadia', 'kiril', 'ivan', 'maksym', 'violetta'], s2: ['khrystia', 'ivan', 'maksym', 'violetta', 'nadia', 'khrystia', 'kiril'], dl: ['kiril', null, 'violetta', 'kiril', 'ivan', null, null], rs: ['nadia', 'khrystia', 'kiril', 'nadia', 'khrystia', 'nadia', null] },
    2: { s1: ['ivan', 'tioma', 'nikita', 'tioma', 'nikita', 'ira', 'tioma'], s2: ['nikita', 'ira', 'tioma', 'ira', 'tioma', 'nikita', 'ira'], dl: ['ivan', null, 'nikita', 'tioma', 'nikita', null, null] },
    3: { s1: ['maksym', 'olena', 'ira', 'olena', 'maksym', 'olena', 'nikita'], s2: ['olena', 'nikita', 'olena', 'nikita', 'olena', 'maksym', 'olena'], dl: ['maksym', null, 'ira', 'olena', 'maksym', null, null] },
  };
  const now = L.warsawNow();
  const cur = L.weekStart(now.date);
  for (const week of [L.addDays(cur, -14), L.addDays(cur, -7), cur]) {
    for (const loc of [1, 2, 3]) {
      for (let i = 0; i < 7; i++) {
        const d = L.addDays(week, i);
        for (const slot of Object.keys(plan[loc])) {
          const who = plan[loc][slot][i]; if (!who) continue;
          const def = L.defaults(d, slot);
          run('INSERT INTO shifts(location_id,date,slot,user_id,start,end,plan_user_id,plan_start,plan_end) VALUES(?,?,?,?,?,?,?,?,?)', loc, d, slot, id(who), def.start, def.end, id(who), def.start, def.end);
        }
        if (L.DELIVERY_DOW.includes(i) && plan[loc].dl[i] && d < now.date && !(loc === 2 && week === cur))
          run("INSERT INTO deliveries(location_id,date,user_id,pallets,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,datetime('now'))", loc, d, id(plan[loc].dl[i]), [1, 1.5, 2, 2.5, 3][(i + loc) % 5], id(plan[loc].dl[i]));
      }
      run("INSERT INTO weeks(location_id,week,status,published_at,published_by) VALUES(?,?,'published',datetime('now'),?)", loc, week, id('mariia'));
    }
  }
  setting('start_date', L.addDays(cur, -14));
  console.log('Demo schedule created');
}
module.exports = { ensureSeed, demo };
