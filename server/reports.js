'use strict';
const { all, get } = require('./db');
const L = require('./logic');

const locName = id => (get('SELECT name FROM locations WHERE id=?', id) || {}).name || '';
const userRow = id => get('SELECT * FROM users WHERE id=?', id);
const r2 = x => Math.round(x * 100) / 100;
const M = () => require('./money');
/** Додає до рядків працівників, у яких є лише премії/штрафи/мінуси/аванси, і проставляє ці суми. */
function addMoney(rows, mlist, locIds) {
  const ms = M().sums(mlist);
  for (const uid of ms.keys()) if (!rows.some(r => r.user_id === uid)) {
    const u = userRow(uid);
    rows.push({ user_id: uid, name: u.name, rate: u.rate, trate: u.training_rate, shifts: 0, sched: 0, extra: 0, training: 0, total: 0, pallets: 0, deliveries: 0, sum_hours: 0, sum_pallets: 0, pay: 0, locs: new Set(mlist.filter(e => e.user_id === uid).map(e => e.location_id)) });
  }
  for (const r of rows) { const m = ms.get(r.user_id) || M().empty(); Object.assign(r, m, M().settle(r.pay, m)); }
  rows.sort((x, y) => x.name.localeCompare(y.name));
  return rows;
}
const MONEY_COLS = t => [
  { k: 'bonus', l: t('c_bonus'), t: 'money', sum: true },
  { k: 'fine', l: t('c_fine'), t: 'money', sum: true },
  { k: 'shortage', l: t('c_shortage'), t: 'money', sum: true },
  { k: 'accrued', l: t('c_accrued'), t: 'money', sum: true, f: '{pay}+{bonus}-{fine}-{shortage}', bold: true },
  { k: 'advance', l: t('c_advance'), t: 'money', sum: true },
  { k: 'to_pay', l: t('c_to_pay'), t: 'money', sum: true, f: '{accrued}-{advance}', bold: true },
];

function aggregate(recs) {
  const by = new Map();
  for (const r of recs) {
    if (!by.has(r.user_id)) by.set(r.user_id, { user_id: r.user_id, shifts: 0, sched: 0, extra: 0, training: 0, pallets: 0, deliveries: 0, days: new Set(), locs: new Set() });
    const a = by.get(r.user_id);
    a.shifts += r.shifts.length; a.sched += r.sched; a.extra += r.extra; a.training += r.training; a.pallets += r.pallets; a.deliveries += r.deliveries;
    a.locs.add(r.location_id);
  }
  return [...by.values()].map(a => {
    const u = userRow(a.user_id);
    const sumHours = (a.sched + a.extra) / 60 * u.rate + a.training / 60 * u.training_rate;
    const sumPallets = a.deliveries ? 40 * a.deliveries + 80 * a.pallets : 0;
    return { ...a, name: u.name, rate: u.rate, trate: u.training_rate, total: a.sched + a.extra + a.training, sum_hours: r2(sumHours), sum_pallets: sumPallets, pay: r2(sumHours + sumPallets) };
  }).sort((x, y) => x.name.localeCompare(y.name));
}

function payrollSection(p, locIds, title, withStatus) {
  const t = p.t;
  const recs = L.computeRecords(locIds, p.from, p.to, p.userId);
  const rows = addMoney(aggregate(recs), M().entries(locIds, p.from, p.to, p.userId), locIds);
  const month = p.from.slice(0, 7);
  if (withStatus) for (const r of rows) {
    const st = get('SELECT * FROM payroll_status WHERE location_id=? AND user_id=? AND month=?', locIds[0], r.user_id, month) || {};
    r.checked_at = st.checked_at || null; r.paid_at = st.paid_at || null;
    r.status = [st.checked_at ? t('st_checked') + ' ' + st.checked_at.slice(0, 10) : '', st.paid_at ? t('st_paid') + ' ' + st.paid_at.slice(0, 10) : ''].filter(Boolean).join(', ');
  }
  for (const r of rows) { r.total_dec = r2(r.total / 60); r._uid = r.user_id; if (!withStatus) r.locations = [...r.locs].map(locName).join(', '); }
  const columns = [
    { k: 'name', l: t('c_worker'), t: 'text' },
    ...(withStatus ? [] : [{ k: 'locations', l: t('c_locations'), t: 'text' }]),
    { k: 'shifts', l: t('c_shifts'), t: 'int', sum: true },
    { k: 'sched', l: t('c_sched'), t: 'hm', sum: true },
    { k: 'extra', l: t('c_extra'), t: 'hm', sum: true },
    { k: 'training', l: t('c_training'), t: 'hm', sum: true },
    { k: 'total', l: t('c_total_hm'), t: 'hm', sum: true, f: '{sched}+{extra}+{training}' },
    { k: 'total_dec', l: t('c_total_dec'), t: 'dec', sum: true, f: 'ROUND({total}*24,2)' },
    { k: 'rate', l: t('c_rate'), t: 'money' },
    { k: 'trate', l: t('c_trate'), t: 'money' },
    { k: 'sum_hours', l: t('c_sum_hours'), t: 'money', sum: true, f: 'ROUND(({sched}+{extra})*24*{rate}+{training}*24*{trate},2)' },
    { k: 'deliveries', l: t('c_deliveries'), t: 'int', sum: true },
    { k: 'pallets', l: t('c_pallets'), t: 'pallets', sum: true },
    { k: 'sum_pallets', l: t('c_sum_pallets'), t: 'money', sum: true, f: 'IF({deliveries}>0,40*{deliveries}+80*{pallets},0)' },
    { k: 'pay', l: t('c_earned'), t: 'money', sum: true, f: '{sum_hours}+{sum_pallets}' },
    ...MONEY_COLS(t),
    ...(withStatus ? [{ k: 'status', l: t('c_status'), t: 'text', ui: 'status' }] : []),
  ];
  return { title, columns, rows, totals: true, location_id: withStatus ? locIds[0] : null, month };
}

function moneyListSection(ml, t, title, withLoc) {
  const rows = ml.map(e => {
    const sh = e.shift_id && get('SELECT * FROM shifts WHERE id=?', e.shift_id);
    return { id: e.id, date: e.date, location: locName(e.location_id), name: L.userName(e.user_id), kind: t('mk_' + e.kind), amount: r2(M().SIGN[e.kind] * e.amount),
      method: e.method ? t('method_' + e.method) : '', shift: sh ? `${t('slot_' + sh.slot)} ${L.hm(sh.start)}–${L.hm(sh.end)}` : '', comment: e.comment,
      created: `${L.userName(e.created_by)}, ${e.created_at.slice(0, 16)} UTC`, _cls: e.kind === 'bonus' ? '' : (e.kind === 'advance' ? '' : 'warn') };
  });
  return { title, rows, deletable: 'money', columns: [{ k: 'date', l: t('c_date'), t: 'text' }, ...(withLoc ? [{ k: 'location', l: t('c_location'), t: 'text' }] : []), { k: 'name', l: t('c_worker'), t: 'text' },
    { k: 'kind', l: t('c_kind'), t: 'text' }, { k: 'amount', l: t('c_sum') + ' zł', t: 'money' }, { k: 'method', l: t('c_method'), t: 'text' }, { k: 'shift', l: t('c_slot'), t: 'text' },
    { k: 'comment', l: t('c_comment'), t: 'text', wrap: true }, { k: 'created', l: t('c_entered_by'), t: 'text' }] };
}

function moneyByLocation(p) {
  const t = p.t;
  const rows = p.locIds.map(l => {
    const ag = addMoney(aggregate(L.computeRecords([l], p.from, p.to, p.userId)), M().entries([l], p.from, p.to, p.userId), [l]);
    const s = k => r2(ag.reduce((a, r) => a + (r[k] || 0), 0));
    return { location: locName(l), pay: s('pay'), bonus: s('bonus'), fine: s('fine'), shortage: s('shortage'), accrued: s('accrued'), advance: s('advance'), to_pay: s('to_pay') };
  });
  return { title: t('money_by_location'), rows, totals: true, columns: [{ k: 'location', l: t('c_location'), t: 'text' }, { k: 'pay', l: t('c_earned'), t: 'money', sum: true }, ...MONEY_COLS(t)] };
}

const reportsDef = {
  money(p) {
    const t = p.t;
    const ml = M().entries(p.locIds, p.from, p.to, p.userId);
    const sections = [moneyListSection(ml, t, t('r_money'), p.locIds.length > 1)];
    // по працівниках (окремо для кожної локації)
    const byWorker = [];
    for (const l of p.locIds) {
      const ag = addMoney(aggregate(L.computeRecords([l], p.from, p.to, p.userId)), ml.filter(e => e.location_id === l), [l]);
      for (const r of ag) if (r.bonus || r.fine || r.shortage || r.advance) byWorker.push({ name: r.name, location: locName(l), pay: r.pay, bonus: r.bonus, fine: r.fine, shortage: r.shortage, accrued: r.accrued, advance: r.advance, to_pay: r.to_pay });
    }
    sections.push({ title: t('totals_by_worker'), rows: byWorker, totals: true, columns: [{ k: 'name', l: t('c_worker'), t: 'text' }, ...(p.locIds.length > 1 ? [{ k: 'location', l: t('c_location'), t: 'text' }] : []), { k: 'pay', l: t('c_earned'), t: 'money', sum: true }, ...MONEY_COLS(t)] });
    sections.push(moneyByLocation(p));
    // мінуси по змінах / датах
    const groups = new Map();
    for (const e of ml.filter(x => x.kind === 'shortage')) {
      const k = e.group_id || ('s' + e.id);
      if (!groups.has(k)) { const sh = e.shift_id && get('SELECT * FROM shifts WHERE id=?', e.shift_id); groups.set(k, { date: e.date, location: locName(e.location_id), shift: sh ? `${t('slot_' + sh.slot)} ${L.hm(sh.start)}–${L.hm(sh.end)}` : '', total: 0, split: [], comment: e.comment }); }
      const g = groups.get(k); g.total = r2(g.total + e.amount); g.split.push(`${L.userName(e.user_id)} ${e.amount.toFixed(2)}`);
    }
    sections.push({ title: t('shortages_by_shift'), totals: true, rows: [...groups.values()].map(g => ({ ...g, split: g.split.join(', ') })), columns: [{ k: 'date', l: t('c_date'), t: 'text' }, ...(p.locIds.length > 1 ? [{ k: 'location', l: t('c_location'), t: 'text' }] : []),
      { k: 'shift', l: t('c_slot'), t: 'text' }, { k: 'total', l: t('c_shortage'), t: 'money', sum: true }, { k: 'split', l: t('c_split'), t: 'text', wrap: true }, { k: 'comment', l: t('c_comment'), t: 'text', wrap: true }] });
    return { title: t('r_money'), sections };
  },

  payroll(p) {
    const sections = p.locIds.map(l => payrollSection(p, [l], locName(l), true));
    if (p.all) sections.push(payrollSection(p, p.locIds, p.t('all_locations'), false));
    return { title: p.t('r_payroll'), sections, clickable: true };
  },

  detail(p) {
    const t = p.t;
    if (!p.userId) return { title: t('r_detail'), sections: [] };
    const u = userRow(p.userId);
    const recs = L.computeRecords(p.locIds, p.from, p.to, p.userId);
    const rows = recs.map(r => {
      const src = r.adj.map(a => `${t('kind_' + a.kind)} +${a.minutes} ${t('min')}: ${a.comment || ''} (${a.request_id ? t('src_request') + ' #' + a.request_id + ', ' : ''}${t('approved_by')} ${L.userName(a.approved_by)})`);
      const sh = r.shifts.map(s => {
        const changed = s.plan_user_id !== s.user_id || s.plan_start !== s.start || s.plan_end !== s.end;
        return `${t('slot_' + s.slot)} ${L.hm(s.start)}–${L.hm(s.end)}` + (changed ? ` (${t('plan')}: ${s.plan_user_id !== s.user_id ? L.userName(s.plan_user_id) + ' ' : ''}${L.hm(s.plan_start)}–${L.hm(s.plan_end)}; ${t('src_changed')})` : ` (${t('src_schedule')})`);
      });
      const m = L.money(r, u);
      return { date: r.date, dow: t('dow_' + L.dow(r.date)), location: locName(r.location_id), shifts: sh.join('; '), sched: r.sched, extra: r.extra, training: r.training,
        pallets: r.pallets || '', source: [...src, r.delivery ? `${t('c_pallets')}: ${r.delivery.pallets} (${t('confirmed_by')} ${L.userName(r.delivery.confirmed_by)})` : ''].filter(Boolean).join('; '), sum: r2(m.total), _cls: L.dow(r.date) === 6 ? 'sun' : '' };
    }).filter(r => r.sched || r.extra || r.training || r.pallets);
    const out = { title: `${t('r_detail')}: ${u.name}`, sections: [{ title: `${t('c_rate')}: ${u.rate} zł/${t('h')}, ${t('c_trate')}: ${u.training_rate} zł/${t('h')}`, totals: true, rows, columns: [
      { k: 'date', l: t('c_date'), t: 'text' }, { k: 'dow', l: '', t: 'text' }, { k: 'location', l: t('c_location'), t: 'text' },
      { k: 'shifts', l: t('c_shift_time'), t: 'text', wrap: true }, { k: 'sched', l: t('c_sched'), t: 'hm', sum: true }, { k: 'extra', l: t('c_extra'), t: 'hm', sum: true },
      { k: 'training', l: t('c_training'), t: 'hm', sum: true }, { k: 'pallets', l: t('c_pallets'), t: 'pallets', sum: true }, { k: 'source', l: t('c_source'), t: 'text', wrap: true }, { k: 'sum', l: t('c_sum'), t: 'money', sum: true }] }] };
    // премії, штрафи, мінуси, аванси — кожен запис з коментарем
    const ml = M().entries(p.locIds, p.from, p.to, p.userId);
    out.sections.push(moneyListSection(ml, t, t('r_money'), p.locIds.length > 1));
    const earned = r2(rows.reduce((a, r) => a + (r.sum || 0), 0));
    const ms = M().sums(ml, () => 'u').get('u') || M().empty(); const st = M().settle(earned, ms);
    out.sections.push({ title: t('totals'), rows: [
      { k: t('c_earned'), v: earned }, { k: '+ ' + t('c_bonus'), v: ms.bonus }, { k: '− ' + t('c_fine'), v: ms.fine }, { k: '− ' + t('c_shortage'), v: ms.shortage },
      { k: '= ' + t('c_accrued'), v: st.accrued, _cls: 'bold' }, { k: '− ' + t('c_advance'), v: ms.advance }, { k: '= ' + t('c_to_pay'), v: st.to_pay, _cls: 'bold' }],
      columns: [{ k: 'k', l: '', t: 'text' }, { k: 'v', l: 'zł', t: 'money' }] });
    return out;
  },

  daily(p) {
    const t = p.t;
    const sections = [];
    for (const locId of p.locIds) {
      const recs = L.computeRecords([locId], p.from, p.to, p.userId);
      const ml = M().entries([locId], p.from, p.to, p.userId);
      const workers = addMoney(aggregate(recs), ml, [locId]);
      const columns = [{ k: 'date', l: t('c_date'), t: 'text' }, { k: 'dow', l: '', t: 'text' }];
      for (const w of workers) {
        const id = w.user_id;
        columns.push({ k: 'ft' + id, l: w.name, t: 'text', group: w.name, sub: t('c_from_to') },
          { k: 'h' + id, l: t('c_hours'), t: 'hm', sum: true, group: w.name, sub: t('c_hours_s') },
          { k: 'x' + id, l: t('c_extra'), t: 'hm', sum: true, group: w.name, sub: t('c_extra_s') },
          { k: 'p' + id, l: t('c_pallets'), t: 'pallets', sum: true, group: w.name, sub: t('c_pallets_s') },
          { k: 'm' + id, l: t('c_shortage'), t: 'money', sum: true, group: w.name, sub: t('c_shortage_s') });
      }
      const rows = L.dates(p.from, p.to).map(d => {
        const row = { date: d.slice(8, 10) + '.' + d.slice(5, 7), dow: t('dow_' + L.dow(d)), _cls: L.dow(d) === 6 ? 'sun' : '' };
        for (const r of recs.filter(x => x.date === d)) {
          row['ft' + r.user_id] = r.shifts.map(s => `${L.hm(s.start)}–${L.hm(s.end)}`).join(', ');
          row['h' + r.user_id] = r.sched || null; row['x' + r.user_id] = (r.extra + r.training) || null; row['p' + r.user_id] = r.pallets || null;
        }
        for (const e of ml) if (e.date === d && e.kind === 'shortage') row['m' + e.user_id] = r2((row['m' + e.user_id] || 0) + e.amount);
        return row;
      });
      const after = [
        { date: t('c_rate'), dow: '', _money: true, _cls: 'bold' },
        { date: t('c_sum_hours'), dow: '', _money: true, _cls: 'bold' },
        { date: t('c_sum_pallets'), dow: '', _money: true, _cls: 'bold' },
        { date: t('c_earned'), dow: '', _money: true, _cls: 'bold' },
        { date: t('c_accrued'), dow: '', _money: true, _cls: 'bold' },
        { date: t('c_to_pay'), dow: '', _money: true, _cls: 'bold' },
      ];
      for (const w of workers) { after[0]['h' + w.user_id] = w.rate; after[1]['h' + w.user_id] = w.sum_hours; after[2]['p' + w.user_id] = w.sum_pallets; after[3]['h' + w.user_id] = w.pay; after[4]['h' + w.user_id] = w.accrued; after[5]['h' + w.user_id] = w.to_pay; }
      const grand = workers.reduce((a, w) => a + w.to_pay, 0);
      sections.push({ title: `${locName(locId)} — ${t('c_to_pay')}: ${r2(grand).toFixed(2)} zł`, columns, rows, totals: true, fitPage: true, grouped: true, afterRows: after });
    }
    return { title: t('r_daily'), sections, orientation: 'landscape' };
  },

  weekly(p) {
    const t = p.t;
    const week = L.weekStart(p.from);
    const end = L.addDays(week, 6);
    const now = L.warsawNow();
    const sections = [];
    for (const locId of p.locIds) {
      const loc = get('SELECT * FROM locations WHERE id=?', locId);
      const slots = ['s1', 's2'].concat(loc.has_restock ? ['rs'] : []);
      const rows = [];
      for (const d of L.dates(week, end)) for (const sl of slots) {
        const s = get('SELECT * FROM shifts WHERE location_id=? AND date=? AND slot=?', locId, d, sl);
        if (p.userId && (!s || (s.user_id !== p.userId && s.plan_user_id !== p.userId))) continue;
        const plan = s && s.plan_user_id ? `${L.userName(s.plan_user_id)} ${L.hm(s.plan_start)}–${L.hm(s.plan_end)}` : '—';
        const fact = s && s.user_id && !s.cancelled ? `${L.userName(s.user_id)} ${L.hm(s.start)}–${L.hm(s.end)}` : (s && s.cancelled ? `${L.userName(s.user_id)} ✕ ${t('cancelled')}` : '—');
        const pm = s && s.plan_user_id ? s.plan_end - s.plan_start : 0, fm = s && s.user_id && !s.cancelled ? s.end - s.start : 0;
        const diff = plan !== fact;
        rows.push({ date: d.slice(8) + '.' + d.slice(5, 7), dow: t('dow_' + L.dow(d)), slot: t('slot_' + sl), plan, plan_h: pm || null, fact, fact_h: fm || null, diff: fm - pm ? (fm - pm > 0 ? '+' : '−') + L.hm(Math.abs(fm - pm)) : (diff ? '≠' : ''), done: d < now.date || (d === now.date && s && s.end <= now.min) ? '✓' : '', _cls: diff ? 'diff' : (L.dow(d) === 6 ? 'sun' : '') });
      }
      sections.push({ title: `${loc.name}: ${week} — ${end}`, rows, totals: true, columns: [
        { k: 'date', l: t('c_date'), t: 'text' }, { k: 'dow', l: '', t: 'text' }, { k: 'slot', l: t('c_slot'), t: 'text' },
        { k: 'plan', l: t('c_plan'), t: 'text' }, { k: 'plan_h', l: t('c_hours'), t: 'hm', sum: true }, { k: 'fact', l: t('c_fact'), t: 'text' }, { k: 'fact_h', l: t('c_hours'), t: 'hm', sum: true },
        { k: 'diff', l: t('c_diff'), t: 'text' }, { k: 'done', l: t('c_done'), t: 'text' }] });
    }
    return { title: t('r_weekly'), sections };
  },

  deliveries(p) {
    const t = p.t; const now = L.warsawNow();
    const rows = []; const byUser = {};
    for (const locId of p.locIds) for (const d of L.dates(p.from, p.to)) {
      const del = get('SELECT * FROM deliveries WHERE location_id=? AND date=?', locId, d);
      const sch = get("SELECT * FROM shifts WHERE location_id=? AND date=? AND slot='dl'", locId, d);
      const uid = (del && del.user_id) || (sch && sch.user_id);
      if (p.userId && uid !== p.userId) continue;
      const confirmed = del && del.pallets != null;
      const isDay = L.DELIVERY_DOW.includes(L.dow(d));
      if (!confirmed && !(isDay && d <= now.date) && !sch) continue;
      const sum = confirmed ? L.palletPay(del.pallets) : 0;
      rows.push({ date: d, dow: t('dow_' + L.dow(d)), location: locName(locId), name: L.userName(uid) || '—', pallets: confirmed ? del.pallets : null, sum: confirmed ? sum : null,
        status: confirmed ? t('confirmed') + ' (' + L.userName(del.confirmed_by) + ')' : (d <= now.date ? '! ' + t('not_confirmed') : t('planned')), _cls: !confirmed && d <= now.date && isDay ? 'warn' : '' });
      if (confirmed) { const k = uid; byUser[k] = byUser[k] || { name: L.userName(uid), count: 0, pallets: 0, sum: 0 }; byUser[k].count++; byUser[k].pallets += del.pallets; byUser[k].sum += sum; }
    }
    return { title: t('r_deliveries'), sections: [
      { title: t('r_deliveries'), rows, totals: true, columns: [{ k: 'date', l: t('c_date'), t: 'text' }, { k: 'dow', l: '', t: 'text' }, ...(p.locIds.length > 1 ? [{ k: 'location', l: t('c_location'), t: 'text' }] : []),
        { k: 'name', l: t('c_unloaded'), t: 'text' }, { k: 'pallets', l: t('c_pallets'), t: 'pallets', sum: true }, { k: 'sum', l: t('c_sum'), t: 'money', sum: true, f: 'IF({pallets}>0,120+({pallets}-1)*80,0)' }, { k: 'status', l: t('c_status'), t: 'text' }] },
      { title: t('totals_by_worker'), totals: true, rows: Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name)), columns: [{ k: 'name', l: t('c_worker'), t: 'text' }, { k: 'count', l: t('c_deliveries'), t: 'int', sum: true }, { k: 'pallets', l: t('c_pallets'), t: 'pallets', sum: true }, { k: 'sum', l: t('c_sum'), t: 'money', sum: true }] }] };
  },

  extra(p) {
    const t = p.t; const ph = p.locIds.map(() => '?').join(',');
    const adj = all(`SELECT * FROM adjustments WHERE deleted=0 AND location_id IN (${ph}) AND date BETWEEN ? AND ? ${p.userId ? 'AND user_id=' + p.userId : ''} ORDER BY date, id`, ...p.locIds, p.from, p.to);
    const byUser = {};
    const rows = adj.map(a => {
      const u = userRow(a.user_id);
      const sum = r2(a.minutes / 60 * (a.kind === 'training' ? u.training_rate : u.rate));
      const k = a.user_id; byUser[k] = byUser[k] || { name: u.name, extra: 0, training: 0, sum: 0 };
      byUser[k][a.kind === 'training' ? 'training' : 'extra'] += a.minutes; byUser[k].sum = r2(byUser[k].sum + sum);
      return { id: a.id, date: a.date, location: locName(a.location_id), name: u.name, kind: t('kind_' + a.kind), minutes: a.minutes, comment: a.comment || '', source: a.request_id ? t('src_request') + ' #' + a.request_id : t('src_admin') + ' ' + L.userName(a.created_by), approved: L.userName(a.approved_by), sum };
    });
    return { title: t('r_extra'), sections: [
      { title: t('r_extra'), rows, totals: true, deletable: 'adjustment', columns: [{ k: 'date', l: t('c_date'), t: 'text' }, ...(p.locIds.length > 1 ? [{ k: 'location', l: t('c_location'), t: 'text' }] : []), { k: 'name', l: t('c_worker'), t: 'text' }, { k: 'kind', l: t('c_kind'), t: 'text' },
        { k: 'minutes', l: t('c_minutes'), t: 'int', sum: true }, { k: 'comment', l: t('c_comment'), t: 'text', wrap: true }, { k: 'source', l: t('c_source'), t: 'text' }, { k: 'approved', l: t('c_approved_by'), t: 'text' }, { k: 'sum', l: t('c_sum'), t: 'money', sum: true }] },
      { title: t('totals_by_worker'), totals: true, rows: Object.values(byUser), columns: [{ k: 'name', l: t('c_worker'), t: 'text' }, { k: 'extra', l: t('c_extra') + ', ' + t('min'), t: 'int', sum: true }, { k: 'training', l: t('c_training') + ', ' + t('min'), t: 'int', sum: true }, { k: 'sum', l: t('c_sum'), t: 'money', sum: true }] }] };
  },

  requests(p) {
    const t = p.t; const ph = p.locIds.map(() => '?').join(',');
    const rows = all(`SELECT * FROM requests WHERE location_id IN (${ph}) AND date(created_at) BETWEEN ? AND ? ${p.userId ? 'AND user_id=' + p.userId : ''} ORDER BY id DESC`, ...p.locIds, p.from, p.to).map(r => ({
      id: r.id, created: r.created_at.slice(0, 16), type: t('rq_' + r.type), name: L.userName(r.user_id), location: locName(r.location_id), desc: describe(r, t), comment: r.comment || '',
      status: t('status_' + r.status), decided: r.decided_by ? L.userName(r.decided_by) : '', decided_at: r.decided_at ? r.decided_at.slice(0, 16) : '', dcomment: r.decision_comment || '', _cls: r.status === 'pending' ? 'warn' : '' }));
    return { title: t('r_requests'), sections: [{ title: '', rows, columns: [{ k: 'id', l: '#', t: 'int' }, { k: 'created', l: t('c_created'), t: 'text' }, { k: 'type', l: t('c_kind'), t: 'text' }, { k: 'name', l: t('c_worker'), t: 'text' },
      ...(p.locIds.length > 1 ? [{ k: 'location', l: t('c_location'), t: 'text' }] : []), { k: 'desc', l: t('c_details'), t: 'text', wrap: true }, { k: 'comment', l: t('c_comment'), t: 'text', wrap: true },
      { k: 'status', l: t('c_status'), t: 'text' }, { k: 'decided', l: t('c_decided_by'), t: 'text' }, { k: 'decided_at', l: t('c_decided_at'), t: 'text' }, { k: 'dcomment', l: t('c_decision_comment'), t: 'text' }] }] };
  },

  warnings(p) {
    const t = p.t;
    const rows = L.warnings(p.locIds, p.from, p.to, t).map(w => ({ key: w.key, date: w.date, dow: t('dow_' + L.dow(w.date)), location: locName(w.location_id), text: '! ' + w.text, _cls: 'warn' }));
    return { title: t('r_warnings'), sections: [{ title: '', rows, ackable: true, columns: [{ k: 'date', l: t('c_date'), t: 'text' }, { k: 'dow', l: '', t: 'text' }, { k: 'location', l: t('c_location'), t: 'text' }, { k: 'text', l: t('c_comment'), t: 'text' }] }] };
  },

  summary(p) {
    const t = p.t;
    const locRows = p.locIds.map(l => {
      const ag = aggregate(L.computeRecords([l], p.from, p.to, p.userId));
      const s = k => ag.reduce((a, r) => a + r[k], 0);
      return { location: locName(l), workers: ag.length, sched: s('sched'), extra: s('extra'), training: s('training'), total: s('total'), pallets: s('pallets'), sum_hours: r2(s('sum_hours')), sum_pallets: s('sum_pallets'), pay: r2(s('pay')) };
    });
    // workers on multiple locations
    const multi = [];
    const all3 = aggregate(L.computeRecords(p.locIds, p.from, p.to, p.userId)).filter(a => a.locs.size > 1);
    for (const a of all3) {
      for (const l of a.locs) { const x = aggregate(L.computeRecords([l], p.from, p.to, a.user_id))[0]; multi.push({ name: a.name, location: locName(l), total: x.total, pallets: x.pallets, pay: x.pay }); }
      multi.push({ name: a.name, location: t('total_all'), total: a.total, pallets: a.pallets, pay: a.pay, _cls: 'bold' });
    }
    return { title: t('r_summary'), sections: [
      { title: t('by_location'), rows: locRows, totals: true, columns: [{ k: 'location', l: t('c_location'), t: 'text' }, { k: 'workers', l: t('c_workers'), t: 'int' }, { k: 'sched', l: t('c_sched'), t: 'hm', sum: true },
        { k: 'extra', l: t('c_extra'), t: 'hm', sum: true }, { k: 'training', l: t('c_training'), t: 'hm', sum: true }, { k: 'total', l: t('c_total_hm'), t: 'hm', sum: true }, { k: 'pallets', l: t('c_pallets'), t: 'pallets', sum: true },
        { k: 'sum_hours', l: t('c_sum_hours'), t: 'money', sum: true }, { k: 'sum_pallets', l: t('c_sum_pallets'), t: 'money', sum: true }, { k: 'pay', l: t('c_pay'), t: 'money', sum: true, bold: true, f: '{sum_hours}+{sum_pallets}' }] },
      moneyByLocation(p),
      { title: t('multi_location_workers'), rows: multi, columns: [{ k: 'name', l: t('c_worker'), t: 'text' }, { k: 'location', l: t('c_location'), t: 'text' }, { k: 'total', l: t('c_total_hm'), t: 'hm' }, { k: 'pallets', l: t('c_pallets'), t: 'pallets' }, { k: 'pay', l: t('c_pay'), t: 'money' }] }] };
  },

  compare(p) {
    const t = p.t;
    const m = p.from.slice(0, 7); const pm = L.prevMonth(m);
    const [cf, ct] = L.monthRange(m); const [pf, pt] = L.monthRange(pm);
    const cur = aggregate(L.computeRecords(p.locIds, cf, ct, p.userId));
    const prev = aggregate(L.computeRecords(p.locIds, pf, pt, p.userId));
    const ids = new Set([...cur, ...prev].map(a => a.user_id));
    const rows = [...ids].map(id => {
      const c = cur.find(a => a.user_id === id) || {}; const q = prev.find(a => a.user_id === id) || {};
      const d = (k) => (c[k] || 0) - (q[k] || 0);
      return { name: c.name || q.name, h_prev: q.total || 0, h_cur: c.total || 0, h_diff: d('total'), x_prev: q.extra || 0, x_cur: c.extra || 0, p_prev: q.pallets || 0, p_cur: c.pallets || 0, pay_prev: q.pay || 0, pay_cur: c.pay || 0, pay_diff: r2(d('pay')) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { title: `${t('r_compare')}: ${m} / ${pm}`, sections: [{ title: '', rows, totals: true, columns: [{ k: 'name', l: t('c_worker'), t: 'text' },
      { k: 'h_prev', l: t('c_total_hm') + ' ' + pm, t: 'hm', sum: true }, { k: 'h_cur', l: t('c_total_hm') + ' ' + m, t: 'hm', sum: true }, { k: 'h_diff', l: 'Δ', t: 'hmd', sum: true, f: '{h_cur}-{h_prev}' },
      { k: 'x_prev', l: t('c_extra') + ' ' + pm, t: 'hm', sum: true }, { k: 'x_cur', l: t('c_extra') + ' ' + m, t: 'hm', sum: true },
      { k: 'p_prev', l: t('c_pallets') + ' ' + pm, t: 'pallets', sum: true }, { k: 'p_cur', l: t('c_pallets') + ' ' + m, t: 'pallets', sum: true },
      { k: 'pay_prev', l: t('c_pay') + ' ' + pm, t: 'money', sum: true }, { k: 'pay_cur', l: t('c_pay') + ' ' + m, t: 'money', sum: true }, { k: 'pay_diff', l: 'Δ zł', t: 'money', sum: true, f: '{pay_cur}-{pay_prev}' }] }] };
  },
};

function describe(r, t) {
  const d = JSON.parse(r.data || '{}');
  const s = r.shift_id && get('SELECT * FROM shifts WHERE id=?', r.shift_id);
  const sl = s ? `${s.date} ${t('slot_' + s.slot)}` : '';
  switch (r.type) {
    case 'extra': case 'training': return `${r.date}: +${d.minutes} ${t('min')}`;
    case 'swap': return `${sl} (${L.userName(s && s.plan_user_id)})${d.swap_shift_id ? ' ⇄' : ''}`;
    case 'handover': return `${sl} → ${d.time}`;
    case 'early': return `${sl} ${d.noshow ? t('noshow') : '→ ' + d.time}`;
    case 'pallets': return `${r.date}: ${d.pallets}`;
    case 'avail': return `${r.date}: ${require('./avail').describe(d, t)}`;
  }
  return '';
}

function build(type, p) {
  const fn = reportsDef[type];
  if (!fn) throw Object.assign(new Error('unknown report'), { status: 400 });
  const rep = fn(p);
  rep.type = type; rep.from = p.from; rep.to = p.to;
  rep.locations = p.locIds.map(locName).join(', ');
  // totals rows
  for (const s of rep.sections) if (s.totals) {
    const tot = {}; for (const c of s.columns) if (c.sum) tot[c.k] = r2(s.rows.reduce((a, r) => a + (Number(r[c.k]) || 0), 0));
    tot[s.columns[0].k] = p.t('total'); s.totalRow = tot;
  }
  return rep;
}
module.exports = { build, aggregate };
