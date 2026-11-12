'use strict';
/* global I18N_tr */
const S = { me: null, loc: null, lang: localStorage.getItem('lang') || 'uk', workers: [] };
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const t = (k, p) => I18N_tr(S.lang, k, p);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = m => (m == null || m === '') ? '' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const hmShort = m => { if (m == null || m === '') return ''; const neg = m < 0; m = Math.abs(Math.round(m)); return (neg ? '−' : '') + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
const parseHM = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? +m[1] * 60 + +m[2] : null; };
const zl = v => (Math.round((v || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' zł';
const pal = v => String(v || 0).replace('.', ',');
const pd = d => new Date(d + 'T00:00:00Z');
const fd = x => x.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = pd(d); x.setUTCDate(x.getUTCDate() + n); return fd(x); };
const dow = d => (pd(d).getUTCDay() + 6) % 7;
const weekStart = d => addDays(d, -dow(d));
const today = () => S.me ? S.me.now.date : fd(new Date());
const monthRange = m => { const [y, mo] = m.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return [m + '-01', m + '-' + String(last).padStart(2, '0')]; };
const lts = s => { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString(S.lang === 'pl' ? 'pl-PL' : 'uk-UA', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const ddmm = d => d.slice(8, 10) + '.' + d.slice(5, 7);
const DEF = (date, slot) => { const sun = dow(date) === 6; return slot === 's1' ? [sun ? 480 : 360, 870] : slot === 's2' ? [870, 1380] : slot === 'rs' ? [1080, 1380] : [null, null]; };

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null; try { data = await r.json(); } catch (_) {}
  if (r.status === 401 && url !== '/api/login') { S.me = null; renderLogin(); throw new Error('unauthorized'); }
  if (!r.ok) { const e = new Error((data && data.error) || r.statusText); e.data = data; throw e; }
  return data;
}
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), 3500); }
function errBox(e) { const errs = e.data && e.data.errors; return `<div class="warnbox"><span class="excl">!</span>${esc(e.message)}${errs ? '<ul>' + errs.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}</div>`; }
function modal(html, wide) { const m = $('#modal'); $('.modal-body', m).innerHTML = html; $('.modal-box', m).classList.toggle('wide', !!wide); m.classList.remove('hidden'); return $('.modal-body', m); }
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal .modal-x').onclick = closeModal;
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
const curLoc = () => S.me && S.me.locations.find(l => l.id === S.loc);
const isAdmin = () => !!(curLoc() && curLoc().is_admin);
const isOwner = () => !!S.me && ['admin', 'owner'].includes(S.me.user.role); // будь-який адміністратор
function setLang(l) { S.lang = l; localStorage.setItem('lang', l); document.documentElement.lang = l; if (S.me) api('POST', '/api/me/lang', { lang: l }); }

// ---------------- boot ----------------
async function boot() {
  try { S.me = await api('GET', '/api/me'); } catch (e) { return renderLogin(); }
  if (S.me.user.lang && !localStorage.getItem('lang')) S.lang = S.me.user.lang;
  document.documentElement.lang = S.lang;
  const saved = Number(sessionStorage.getItem('loc'));
  S.loc = S.me.locations.some(l => l.id === saved) ? saved : null;
  if (!S.loc) return renderPick();
  await loadWorkers();
  route();
}
async function loadWorkers() { S.workers = S.loc ? await api('GET', `/api/locations/${S.loc}/workers`) : []; }
function renderLogin() {
  $('#app').innerHTML = `<div class="login"><div class="row" style="justify-content:flex-end">${langSeg()}</div>
    <div class="card"><h1>${t('app_title')}</h1><form id="lf">
    <label class="f"><span>${t('login')}</span><input name="login" autocomplete="username" required autocapitalize="none"></label>
    <label class="f"><span>${t('password')}</span><input name="password" type="password" autocomplete="current-password" required></label>
    <div id="lerr"></div><button class="pri" style="width:100%;margin-top:8px">${t('sign_in')}</button></form></div></div>`;
  bindLang(renderLogin);
  $('#lf').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api('POST', '/api/login', { login: f.get('login'), password: f.get('password') }); sessionStorage.removeItem('loc'); boot(); }
    catch (err) { $('#lerr').innerHTML = `<div class="warnbox">${t('bad_login')}</div>`; }
  };
}
const langSeg = () => `<span class="seg lang"><button data-l="uk" class="${S.lang === 'uk' ? 'on' : ''}">UA</button><button data-l="pl" class="${S.lang === 'pl' ? 'on' : ''}">PL</button></span>`;
function bindLang(rerender) { $$('.seg.lang button').forEach(b => b.onclick = () => { setLang(b.dataset.l); rerender(); }); }

function renderPick() {
  $('#app').innerHTML = `<main><div class="row" style="justify-content:space-between"><h1>${t('pick_location')}</h1>${langSeg()}</div>
    <div class="loc-pick">${S.me.locations.map(l => `<button data-id="${l.id}"><b>${esc(l.name)}</b><br><span class="mute small">${t('admin')}: ${esc(l.admin_name)}${l.deputy_name ? ' · ' + t('deputy') + ': ' + esc(l.deputy_name) : ''}${l.is_admin ? ' · ★' : ''}</span></button>`).join('')}
    ${S.me.locations.length ? '' : `<div class="card">${t('no_locations')}</div>`}</div>
    <p style="text-align:center"><button id="lo">${t('logout')}</button></p></main>`;
  bindLang(renderPick);
  $$('.loc-pick button').forEach(b => b.onclick = async () => { S.loc = Number(b.dataset.id); sessionStorage.setItem('loc', S.loc); await loadWorkers(); location.hash = '#/home'; route(); });
  $('#lo').onclick = logout;
}
async function logout() { await api('POST', '/api/logout'); S.me = null; sessionStorage.clear(); renderLogin(); }

const PAGES = {
  home: { fn: pageHome }, schedule: { fn: pageSchedule }, avail: { fn: pageMyAvail }, vacation: { fn: pageVacation }, disposition: { fn: pageDisposition, admin: true }, tasks: { fn: pageTasks, admin: true }, hours: { fn: pageHours }, requests: { fn: pageRequests }, notes: { fn: pageNotes },
  warnings: { fn: pageWarnings, admin: true }, shiftcards: { fn: pageShiftCards, admin: true }, reports: { fn: pageReports, admin: true }, workers: { fn: pageWorkers, admin: true },
  locations: { fn: pageLocations, owner: true }, months: { fn: pageMonths, admin: true }, audit: { fn: pageAudit, admin: true },
  settings: { fn: pageSettings }, notifications: { fn: pageNotifications },
};
function navHtml(page) {
  const items = [['home', t('nav_home')], ['schedule', t('nav_schedule')], ['avail', t('nav_avail')], ['vacation', t('nav_vacation')], ['hours', t('nav_hours')], ['requests', t('nav_requests')], ['notes', t('nav_notes')]];
  if (isAdmin()) items.push(['tasks', t('nav_tasks')], ['disposition', t('nav_disposition')], ['shiftcards', t('nav_shiftcards')], ['warnings', t('nav_warnings')], ['reports', t('nav_reports')], ['workers', t('nav_workers')], ['months', t('nav_months')], ['audit', t('nav_audit')]);
  if (isOwner()) items.push(['locations', t('nav_locations')]);
  items.push(['settings', t('nav_settings')]);
  return items.map(([k, l]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${l}</a>`).join('');
}
async function route() {
  if (!S.me) return renderLogin();
  if (!S.loc) return renderPick();
  let page = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'home';
  const def = PAGES[page];
  if (!def || (def.admin && !isAdmin()) || (def.owner && !isOwner())) page = 'home';
  $('#app').innerHTML = `<header class="top"><button class="loc" id="locbtn">📍 ${esc(curLoc().name)}</button><span class="sp"></span>
    ${langSeg()}<button class="ic" id="bell" title="${t('notifications')}">🔔${S.me.unread ? `<span class="badge">${S.me.unread}</span>` : ''}</button><button class="ic" id="logout" title="${t('logout')}">⎋</button></header>
    <nav class="tabs">${navHtml(page)}</nav><main id="main"><div class="loading">…</div></main>`;
  $('#locbtn').onclick = () => { sessionStorage.removeItem('loc'); S.loc = null; renderPick(); };
  $('#bell').onclick = () => { location.hash = '#/notifications'; };
  $('#logout').onclick = logout;
  bindLang(route);
  const on = $('nav.tabs a.on'); if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  try { await PAGES[page].fn($('#main')); } catch (e) { if (e.message !== 'unauthorized') $('#main').innerHTML = errBox(e); }
}
window.addEventListener('hashchange', route);
const refreshMe = async () => { S.me = await api('GET', '/api/me'); };

// ---------------- helpers for shifts ----------------
function timeLabel(s) {
  if (!s || !['s1', 's2', 'rs'].includes(s.slot)) return '';
  const [ds, de] = DEF(s.date, s.slot);
  if (s.start === ds && s.end === de) return '';
  if (s.slot === 'rs' && s.end === de) return t('at_time', { t: hm(s.start) });
  if (s.start !== ds && s.end === de) return t('from_time', { t: hm(s.start) });
  if (s.start === ds && s.end !== de) return t('to_time', { t: hm(s.end) });
  return hm(s.start) + '–' + hm(s.end);
}
const slotName = s => t('slot_' + s);
const shiftText = s => `${ddmm(s.date)} ${t('dow_' + dow(s.date))} · ${slotName(s.slot)}${s.start != null ? ' ' + hm(s.start) + '–' + hm(s.end) : ''}${s.name ? ' · ' + s.name : ''}`;

// ---------------- HOME ----------------
async function pageHome(el) {
  const h = await api('GET', `/api/home/${S.loc}`);
  const me = S.me.user;
  const cur = h.myShifts.filter(s => s.date === h.now.date && s.slot !== 'dl');
  const next = h.myShifts.filter(s => s.slot !== 'dl' && (s.date > h.now.date || (s.date === h.now.date && s.end > h.now.min)));
  let html = `<h1>${t('hello', { name: esc(me.name) })}</h1>`;
  if (isOwner() && !S.me.tg.enabled) html += `<div class="warnbox"><span class="excl">!</span>${t('tg_not_configured_admin')} <a href="#/settings">${t('nav_settings')} →</a></div>`;
  if (isAdmin()) html += `<div class="grid2" style="margin-bottom:12px">
    <a class="stat" href="#/requests" style="text-decoration:none;color:inherit"><span class="mute">${t('pending_requests')}</span><b class="${h.pending ? 'red' : ''}">${h.pending}</b></a>
    <a class="stat" href="#/warnings" style="text-decoration:none;color:inherit"><span class="mute">${t('nav_warnings')}</span><b class="${h.warnings ? 'red' : ''}">${h.warnings ? '! ' : ''}${h.warnings}</b></a>
    <a class="stat" href="#/notes" style="text-decoration:none;color:inherit"><span class="mute">${t('open_notes')}</span><b>${h.openNotes}</b></a></div>`;
  html += '<div id="mytasks"></div>'; // завдання від адміністратора
  if (h.notes.length) html += `<div class="card"><h2 style="margin-top:0">📝 ${t('notes_for_you')}</h2>${h.notes.slice(0, 5).map(n => `<div class="note" style="margin:6px 0"><b>${esc(n.author)}</b> <span class="mute small">${lts(n.created_at)}</span><br>${esc(n.text)}</div>`).join('')}</div>`;
  if (h.toConfirm.length) html += `<div class="card" style="border-color:var(--acc)"><h2 style="margin-top:0">📦 ${t('confirm_delivery')}</h2>${h.toConfirm.map(d => `<div class="row" style="margin:6px 0"><b>${ddmm(d)} ${t('dow_' + dow(d))}</b>
    <input type="number" step="0.5" min="0" value="1" class="pal" data-d="${d}" style="width:90px"> <span class="mute">${t('pallets_short')}</span><button class="pri sm" data-confirm="${d}">${t('confirm')}</button></div>`).join('')}
    <p class="mute small">${t('pallet_formula')}</p></div>`;
  html += `<div class="card"><h2 style="margin-top:0">${t('my_next_shifts')}</h2>${next.length ? '<div class="list">' + next.slice(0, 6).map(s => `<div class="item"><div class="grow"><b>${ddmm(s.date)} ${t('dow_' + dow(s.date))}</b> · ${slotName(s.slot)} · ${hm(s.start)}–${hm(s.end)} <span class="mute">${esc(s.location)}</span></div></div>`).join('') + '</div>' : `<p class="mute">${t('no_shifts')}</p>`}
    ${h.myShifts.filter(s => s.slot === 'dl' && s.date >= h.now.date).map(s => `<div class="small">📦 ${t('delivery_on', { d: ddmm(s.date) + ' ' + t('dow_' + dow(s.date)) })} (${esc(s.location)})</div>`).join('')}</div>`;
  html += `<div class="card"><h2 style="margin-top:0">${t('today_at_location')}</h2>${h.today.length ? h.today.map(s => `<div>${slotName(s.slot)}: <b>${esc(s.name)}</b> ${s.start != null ? hm(s.start) + '–' + hm(s.end) : ''}</div>`).join('') : `<p class="mute">—</p>`}</div>`;
  html += `<div class="card"><div class="row"><button class="pri" data-go="extra">${t('rq_btn_extra')}</button><button data-go="swap">${t('rq_btn_swap')}</button><button data-go="handover">${t('rq_btn_handover')}</button><button data-go="note">${t('leave_note')}</button></div>
    ${h.myPending ? `<p class="small mute">${t('my_pending', { n: h.myPending })}</p>` : ''}<p class="small mute">${t('auto_credit_info')}</p></div>`;
  el.innerHTML = html;
  myTasksBlock($('#mytasks', el));
  $$('[data-confirm]', el).forEach(b => b.onclick = async () => {
    const d = b.dataset.confirm; const p = Number($(`.pal[data-d="${d}"]`, el).value);
    if (!confirm(t('confirm_pallets_q', { p: pal(p), d: ddmm(d) }))) return;
    try { await api('POST', '/api/deliveries', { location_id: S.loc, date: d, pallets: p }); toast(t('saved')); route(); } catch (e) { toast(e.message); }
  });
  $$('[data-go]', el).forEach(b => b.onclick = () => { if (b.dataset.go === 'note') location.hash = '#/notes'; else { sessionStorage.setItem('rqType', b.dataset.go); location.hash = '#/requests'; } });
}

// ---------------- SCHEDULE ----------------
let schWeek = null;
async function pageSchedule(el) {
  schWeek = schWeek || weekStart(today());
  const v = await api('GET', `/api/schedule/${S.loc}?week=${schWeek}`);
  const admin = isAdmin();
  const loc = v.location;
  const slots = ['s1', 's2', 'dl'].concat(loc.has_restock ? ['rs'] : []);
  const end = addDays(schWeek, 6);
  const wmap = {}; (v.warnings || []).forEach(w => { if (w.kind === 'empty') wmap[w.date + ':' + w.slot] = w; if (w.kind === 'delivery') wmap[w.date + ':dl'] = w; });
  let html = `<div class="row" style="justify-content:space-between"><h1>${t('nav_schedule')}: ${ddmm(schWeek)} – ${ddmm(end)}.${end.slice(0, 4)}</h1>
    <div class="row"><button id="wprev">‹</button><button id="wnow">${t('this_week')}</button><button id="wnext">›</button></div></div>
    <div class="row" style="margin-bottom:10px">${v.status === 'published' ? `<span class="pill pub">${t('published')}</span>` : v.status === 'hidden' ? `<span class="pill draft">${t('not_published_yet')}</span>` : `<span class="pill draft">${t('draft')}</span>`}
    ${admin ? `<span class="small mute">${t('sched_rules_info')}</span>` : ''}</div>`;
  if (v.status === 'hidden') { el.innerHTML = html + `<div class="card mute">${t('schedule_hidden')}</div>`; bindWeekNav(el); return; }
  const editable = admin;
  html += `<div id="sch-err"></div><div class="tbl-wrap"><table class="t sch"><thead><tr><th>${t('day')}</th>${slots.map(s => `<th>${slotName(s)}<div class="small mute" style="font-weight:400">${s === 'dl' ? t('dl_days') : s === 'rs' ? '18:00–23:00' : s === 's1' ? '06:00/08:00–14:30' : '14:30–23:00'}</div></th>`).join('')}</tr></thead><tbody>`;
  for (const d of v.days) {
    html += `<tr class="${d.dow === 6 ? 'sun' : ''} ${d.date === today() ? 'today' : ''}"><td class="day" data-l="">${t('dow_full_' + d.dow)} <span class="d">${ddmm(d.date)}</span>${d.closed ? ' 🔒' : ''}${admin ? ` <a href="#/shiftcards" class="small" title="${t('nav_shiftcards')}" onclick="sessionStorage.setItem('cardDate','${d.date}')">📋</a>` : ''}</td>`;
    for (const sl of slots) {
      const c = d.cells[sl];
      const w = wmap[d.date + ':' + sl];
      const lab = slotName(sl);
      if (editable) {
        const [ds, de] = DEF(d.date, sl);
        const st = c ? c.start : ds, en = c ? c.end : de;
        const custom = c && sl !== 'dl' && (c.start !== ds || c.end !== de);
        html += `<td data-l="${lab}" class="${sl === 'dl' && d.delivery_day ? 'dl-day' : ''}"><div class="cell ${c && c.user_id ? '' : 'empty'}" data-date="${d.date}" data-slot="${sl}">
          <div class="row" style="gap:4px;flex-wrap:nowrap">${w ? `<span class="excl" title="${esc(w.text)}">!</span>` : ''}<select class="who" ${d.closed ? 'disabled' : ''}><option value="">—</option>${sl !== 'dl' && v.avail ? workerOptionsByAvail(v.avail, d.date, st, en, c && c.user_id) : S.workers.map(u => `<option value="${u.id}" ${c && c.user_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}${c && c.user_id && !S.workers.some(u => u.id === c.user_id) ? `<option value="${c.user_id}" selected>${esc(c.name)}</option>` : ''}</select>
          ${sl !== 'dl' ? `<button class="sm tbtn" type="button" title="${t('custom_time')}">⏱</button>` : ''}</div>
          ${sl !== 'dl' ? `<div class="times" style="${custom ? '' : 'display:none'}"><input type="time" class="st" value="${hm(st)}" ${d.closed ? 'disabled' : ''}>–<input type="time" class="en" value="${hm(en)}" ${d.closed ? 'disabled' : ''}></div>` : ''}
          ${c && c.cancelled ? `<span class="small red">✕ ${t('cancelled')}</span>` : ''}
          ${c && c.plan_user_id && (c.plan_user_id !== c.user_id || c.plan_start !== c.start || c.plan_end !== c.end) ? `<span class="chg">${t('plan')}: ${esc(c.plan_name)} ${hm(c.plan_start)}–${hm(c.plan_end)}</span>` : ''}
          ${sl === 'dl' && d.delivery ? `<span class="small">📦 ${pal(d.delivery.pallets)} ${t('pallets_short')} (${esc(d.delivery.name)})</span>` : ''}
          ${v.status === 'published' && c && c.id && !d.closed && sl !== 'dl' ? `<div class="acts"><button class="sm" data-fix="${c.id}">✎ ${t('fact')}</button></div>` : ''}
          ${v.status === 'published' && sl === 'dl' && !d.closed && (c || d.delivery) && d.date <= today() ? `<div class="acts"><button class="sm" data-pal="${d.date}">📦 ${t('pallets_short')}</button></div>` : ''}
          ${w ? `<span class="small red">${esc(w.text)}</span>` : ''}
        </div></td>`;
      } else {
        const mine = c && c.user_id === S.me.user.id;
        html += `<td data-l="${lab}" class="${sl === 'dl' && d.delivery_day ? 'dl-day' : ''}"><div class="cell ${c && c.user_id ? '' : 'empty'}">${c && c.user_id ? `<span class="nm ${c.cancelled ? 'cancel' : ''}"><span class="${mine ? 'me' : ''}">${esc(c.name)}</span></span>${timeLabel(c) ? `<span class="tm">${esc(timeLabel(c))}</span>` : ''}` : '<span class="mute">—</span>'}
          ${sl === 'dl' && d.delivery && d.delivery.pallets != null && mine ? `<span class="small">📦 ${pal(d.delivery.pallets)}</span>` : ''}</div></td>`;
      }
    }
    html += '</tr>';
  }
  html += `</tbody></table></div>`;
  if (editable) html += `<div class="row" style="margin-top:12px"><button id="copyprev">${t('copy_prev_week')}</button><span class="grow"></span>
     <button id="save" class="${v.status === 'published' ? 'pri' : ''}">${v.status === 'published' ? t('save_published') : t('save_draft')}</button>${v.status !== 'published' ? `<button id="publish" class="pri">${t('publish')}</button>` : ''}
     <button id="addadj">+ ${t('add_extra_admin')}</button></div><p class="small mute">${t('sched_admin_help')}</p>`;
  el.innerHTML = html;
  bindWeekNav(el);
  if (!editable) return;
  // custom time toggles + auto handover
  $$('.cell', el).forEach(c => {
    const tb = $('.tbtn', c); if (tb) tb.onclick = () => { const x = $('.times', c); x.style.display = x.style.display === 'none' ? '' : 'none'; };
    const st = $('.st', c), en = $('.en', c);
    const other = slot => $(`.cell[data-date="${c.dataset.date}"][data-slot="${slot}"]`, el);
    if (c.dataset.slot === 's1' && en) en.onchange = () => { const o = other('s2'); if (o) { $('.st', o).value = en.value; $('.times', o).style.display = ''; } };
    if (c.dataset.slot === 's2' && st) st.onchange = () => { const o = other('s1'); if (o) { $('.en', o).value = st.value; $('.times', o).style.display = ''; } };
  });
  const collect = () => $$('.cell', el).map(c => ({ date: c.dataset.date, slot: c.dataset.slot, user_id: $('.who', c).value || null, start: $('.st', c) ? $('.st', c).value : null, end: $('.en', c) ? $('.en', c).value : null }));
  const save = async publish => {
    const warns = v.avail ? availWarnings(v.avail, collect()) : [];
    if (warns.length && !confirm(t('av_warn_confirm') + '\n\n' + warns.join('\n'))) return;
    try { await api('PUT', `/api/schedule/${S.loc}`, { week: schWeek, cells: collect(), publish }); toast(publish ? t('published_ok') : t('saved')); pageSchedule(el); }
    catch (e) { $('#sch-err').innerHTML = errBox(e); $('#sch-err').scrollIntoView({ behavior: 'smooth' }); }
  };
  $('#save').onclick = () => save(false);
  if ($('#publish')) $('#publish').onclick = () => { if (confirm(t('publish_q'))) save(true); };
  $('#copyprev').onclick = async () => {
    const pv = await api('GET', `/api/schedule/${S.loc}?week=${addDays(schWeek, -7)}`);
    pv.days.forEach((d, i) => {
      const date = addDays(schWeek, i);
      for (const sl of slots) {
        const c = $(`.cell[data-date="${date}"][data-slot="${sl}"]`, el); if (!c || $('.who', c).disabled) continue;
        const src = d.cells[sl];
        $('.who', c).value = src && src.plan_user_id ? String(src.plan_user_id) : '';
        if (sl !== 'dl') { const [ds, de] = DEF(date, sl); const s0 = src && src.plan_start != null ? src.plan_start : ds, e0 = src && src.plan_end != null ? src.plan_end : de; $('.st', c).value = hm(s0); $('.en', c).value = hm(e0); $('.times', c).style.display = (s0 !== ds || e0 !== de) ? '' : 'none'; }
      }
    });
    toast(t('copied_check'));
  };
  $$('[data-fix]', el).forEach(b => b.onclick = () => fixShiftModal(v, Number(b.dataset.fix), () => pageSchedule(el)));
  $$('[data-pal]', el).forEach(b => b.onclick = () => palletModal(b.dataset.pal, v, () => pageSchedule(el)));
  $('#addadj').onclick = () => adjModal(() => pageSchedule(el));
}
function bindWeekNav(el) {
  $('#wprev', el).onclick = () => { schWeek = addDays(schWeek, -7); pageSchedule(el); };
  $('#wnext', el).onclick = () => { schWeek = addDays(schWeek, 7); pageSchedule(el); };
  $('#wnow', el).onclick = () => { schWeek = weekStart(today()); pageSchedule(el); };
}
function fixShiftModal(v, id, done) {
  let c; v.days.forEach(d => Object.values(d.cells).forEach(x => { if (x.id === id) c = x; }));
  const b = modal(`<h2>${t('fact_correction')}</h2><p class="mute small">${t('fact_help')}</p><p><b>${shiftText({ ...c, name: c.name })}</b></p>
    <label class="f"><span>${t('worker')}</span><select id="fu">${S.workers.map(u => `<option value="${u.id}" ${u.id === c.user_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    <div class="row"><label class="f grow"><span>${t('start')}</span><input type="time" id="fs" value="${hm(c.start)}"></label><label class="f grow"><span>${t('end')}</span><input type="time" id="fe" value="${hm(c.end)}"></label></div>
    <label class="f"><input type="checkbox" id="fn" checked> ${t('move_neighbour')}</label>
    <label class="f"><input type="checkbox" id="fc" ${c.cancelled ? 'checked' : ''}> ${t('noshow_cancel')}</label>
    <label class="f"><span>${t('comment_required')}</span><textarea id="fcm"></textarea></label><div id="ferr"></div>
    <div class="row end"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="fok">${t('save')}</button></div>`);
  $('#fok', b).onclick = async () => {
    try { await api('POST', `/api/shifts/${id}/correct`, { user_id: $('#fu', b).value, start: $('#fs', b).value, end: $('#fe', b).value, cancelled: $('#fc', b).checked, moveNeighbour: $('#fn', b).checked, comment: $('#fcm', b).value }); closeModal(); toast(t('saved')); done(); }
    catch (e) { $('#ferr', b).innerHTML = errBox(e); }
  };
}
function palletModal(date, v, done) {
  const d = v.days.find(x => x.date === date);
  const cur = d.delivery || {}; const who = (d.cells.dl && d.cells.dl.user_id) || cur.user_id;
  const b = modal(`<h2>📦 ${t('delivery')} ${ddmm(date)}</h2>
    <label class="f"><span>${t('worker')}</span><select id="pu">${S.workers.map(u => `<option value="${u.id}" ${u.id === who ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    <label class="f"><span>${t('pallets_count')}</span><input type="number" step="0.5" min="0" id="pp" value="${cur.pallets ?? 1}"></label><p class="small mute">${t('pallet_formula')}</p><div id="perr"></div>
    <div class="row end"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="pok">${t('save')}</button></div>`);
  $('#pok', b).onclick = async () => { try { await api('POST', '/api/deliveries', { location_id: S.loc, date, user_id: $('#pu', b).value, pallets: Number($('#pp', b).value) }); closeModal(); toast(t('saved')); done(); } catch (e) { $('#perr', b).innerHTML = errBox(e); } };
}
function adjModal(done, preset = {}) {
  const b = modal(`<h2>${t('add_extra_admin')}</h2>
    <label class="f"><span>${t('kind')}</span><select id="ak"><option value="extra">${t('kind_extra')}</option><option value="training" ${preset.kind === 'training' ? 'selected' : ''}>${t('kind_training')}</option></select></label>
    <label class="f"><span>${t('worker')}</span><select id="au">${S.workers.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
    <label class="f"><span>${t('date')}</span><input type="date" id="ad" value="${today()}"></label>
    <label class="f"><span>${t('minutes')}</span><input type="number" id="am" min="1" step="5" value="20"></label>
    <label class="f"><span>${t('comment_required')}</span><textarea id="ac"></textarea></label><div id="aerr"></div>
    <div class="row end"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="aok">${t('save')}</button></div>`);
  $('#aok', b).onclick = async () => { try { await api('POST', '/api/adjustments', { location_id: S.loc, kind: $('#ak', b).value, user_id: $('#au', b).value, date: $('#ad', b).value, minutes: Number($('#am', b).value), comment: $('#ac', b).value }); closeModal(); toast(t('saved')); done && done(); } catch (e) { $('#aerr', b).innerHTML = errBox(e); } };
}

// ---------------- MY HOURS ----------------
let hoursMonth = null;
async function pageHours(el) {
  hoursMonth = hoursMonth || today().slice(0, 7);
  const h = await api('GET', `/api/my/hours?month=${hoursMonth}`);
  const T = h.totals;
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h1>${t('nav_hours')}</h1><input type="month" id="hm" value="${hoursMonth}"></div>
    <div class="grid2" style="margin-bottom:12px">
      <div class="stat"><span class="mute">${t('c_sched')}</span><b>${hmShort(T.sched)}</b></div>
      <div class="stat"><span class="mute">${t('c_extra')}</span><b>${hmShort(T.extra)}</b></div>
      ${T.training ? `<div class="stat"><span class="mute">${t('c_training')}</span><b>${hmShort(T.training)}</b></div>` : ''}
      <div class="stat"><span class="mute">${t('c_pallets')}</span><b>${pal(T.pallets)}</b></div>
      <div class="stat" style="border-color:var(--acc)"><span class="mute">${t('c_earned')}</span><b>${zl(T.sum)}</b><span class="small mute">${t('your_rate')}: ${zl(h.rate)}/${t('h')}</span></div></div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th>${t('c_date')}</th><th>${t('c_location')}</th><th>${t('c_shift_time')}</th><th>${t('c_hours')}</th><th>${t('c_extra')}</th><th>${t('c_pallets')}</th><th>${t('c_sum')}</th></tr></thead><tbody>
    ${h.rows.map(r => `<tr class="${r.dow === 6 ? 'sun' : ''}"><td>${ddmm(r.date)} ${t('dow_' + r.dow)}</td><td>${esc(r.location)}</td><td>${r.shifts.join(', ')}${r.planned.length ? `<span class="mute">${r.shifts.length ? ', ' : ''}${r.planned.join(', ')} (${t('planned')})</span>` : ''}</td>
      <td class="n">${r.sched ? hmShort(r.sched) : ''}</td><td class="n" title="${esc(r.adj.map(a => a.comment).join('; '))}">${r.extra ? '+' + hmShort(r.extra) : ''}${r.training ? ` <span class="mute">${t('kind_training')} ${hmShort(r.training)}</span>` : ''}</td><td class="n">${r.pallets ? pal(r.pallets) : ''}</td><td class="n">${r.sum ? zl(r.sum) : ''}</td></tr>`).join('')}
    ${h.rows.length ? '' : `<tr><td colspan="7" class="mute">${t('no_data')}</td></tr>`}
    <tr class="total"><td colspan="3">${t('total')}</td><td class="n">${hmShort(T.sched)}</td><td class="n">${hmShort(T.extra)}</td><td class="n">${pal(T.pallets)}</td><td class="n">${zl(T.sum)}</td></tr></tbody></table></div>
    <div id="mymoney"></div><p class="small mute">${t('auto_credit_info')}</p>`;
  $('#hm', el).onchange = e => { hoursMonth = e.target.value; pageHours(el); };
  myMoneyBlock($('#mymoney', el), hoursMonth, T.sum);
}

// ---------------- REQUESTS ----------------
const statusPill = s => `<span class="pill ${s}">${t('status_' + s)}</span>`;
async function pageRequests(el) {
  const admin = isAdmin();
  let html = `<h1>${t('nav_requests')}</h1>`;
  html += `<div class="card"><h2 style="margin-top:0">${t('new_request')}</h2><div class="typebtns">${['extra', 'swap', 'handover', 'early', 'pallets', 'training'].map(x => `<button data-type="${x}"><b>${t('rq_' + x)}</b><br><span class="small mute">${t('rqh_' + x)}</span></button>`).join('')}</div><div id="rqform"></div></div>`;
  if (admin) html += `<div class="row"><h2 class="grow">${t('incoming_requests')}</h2><span class="seg" id="rqf"><button data-s="pending" class="on">${t('status_pending')}</button><button data-s="">${t('all')}</button></span></div><div id="inbox"></div>`;
  html += `<h2>${t('my_requests')}</h2><div id="mine"></div>`;
  el.innerHTML = html;
  $$('.typebtns button', el).forEach(b => b.onclick = () => { $$('.typebtns button', el).forEach(x => x.classList.toggle('on', x === b)); requestForm($('#rqform', el), b.dataset.type, () => pageRequests(el)); });
  const pre = sessionStorage.getItem('rqType'); if (pre) { sessionStorage.removeItem('rqType'); const b = $(`.typebtns button[data-type="${pre}"]`, el); if (b) b.click(); }
  const mine = await api('GET', `/api/requests?loc=${S.loc}&mine=1`);
  $('#mine', el).innerHTML = mine.length ? `<div class="card list">${mine.map(r => `<div class="item"><div class="grow"><b>${t('rq_' + r.type)}</b> ${statusPill(r.status)} <span class="mute small">${esc(r.location)} · ${lts(r.created_at)}</span><br>${esc(r.desc)}${r.comment ? `<br><span class="mute">${esc(r.comment)}</span>` : ''}
    ${r.decided_name && r.status !== 'cancelled' ? `<br><span class="small">${t('decided_by')}: ${esc(r.decided_name)} ${lts(r.decided_at)}${r.decision_comment ? ' — ' + esc(r.decision_comment) : ''}</span>` : ''}</div>
    ${r.status === 'pending' ? `<button class="sm" data-cancel="${r.id}">${t('withdraw')}</button>` : ''}</div>`).join('')}</div>` : `<p class="mute">${t('no_data')}</p>`;
  $$('[data-cancel]', el).forEach(b => b.onclick = async () => { await api('POST', `/api/requests/${b.dataset.cancel}/cancel`); pageRequests(el); });
  if (admin) {
    const load = async status => {
      const list = await api('GET', `/api/requests?loc=${S.loc}${status ? '&status=' + status : ''}`);
      const box = $('#inbox', el);
      box.innerHTML = list.length ? `<div class="card list">${list.map(r => {
        const old = r.status === 'pending' && (Date.now() - new Date(r.created_at.replace(' ', 'T') + 'Z').getTime()) > 864e5;
        return `<div class="item" data-id="${r.id}"><div class="grow">${old ? '<span class="excl">!</span>' : ''}<b>${esc(r.user_name)}</b> — ${t('rq_' + r.type)} ${statusPill(r.status)} <span class="mute small">#${r.id} · ${lts(r.created_at)}</span><br>${esc(r.desc)}${r.comment ? `<br>💬 ${esc(r.comment)}` : ''}
        ${r.status === 'pending' ? `<div class="row" style="margin-top:6px"><input class="dc grow" placeholder="${t('decision_comment_opt')}"><button class="pri sm" data-ok="${r.id}">✓ ${t('approve')}</button><button class="danger sm" data-no="${r.id}">✕ ${t('reject')}</button></div><div class="derr"></div>` : `<br><span class="small mute">${esc(r.decided_name)} ${lts(r.decided_at)} ${esc(r.decision_comment || '')}</span>`}</div></div>`;
      }).join('')}</div>` : `<p class="mute">${t('no_requests')}</p>`;
      $$('[data-ok],[data-no]', box).forEach(b => b.onclick = async () => {
        const item = b.closest('.item'); const id = b.dataset.ok || b.dataset.no;
        try { await api('POST', `/api/requests/${id}/decide`, { approve: !!b.dataset.ok, comment: $('.dc', item).value }); toast(t('saved')); load(status); }
        catch (e) { $('.derr', item).innerHTML = errBox(e); }
      });
    };
    $$('#rqf button', el).forEach(b => b.onclick = () => { $$('#rqf button', el).forEach(x => x.classList.toggle('on', x === b)); load(b.dataset.s); });
    load('pending');
  }
}
async function requestForm(box, type, done) {
  const me = S.me.user.id;
  let html = `<div style="margin-top:12px">`;
  let shifts = [];
  if (['swap', 'handover', 'early'].includes(type)) {
    shifts = (await api('GET', `/api/shifts?loc=${S.loc}`)).filter(s => s.slot !== 'dl');
    const mineS = shifts.filter(s => s.user_id === me), others = shifts.filter(s => s.user_id !== me && s.date >= addDays(today(), -3));
    if (type === 'swap') html += `<label class="f"><span>${t('shift_to_take')}</span><select id="rs">${others.map(s => `<option value="${s.id}">${esc(shiftText(s))}</option>`).join('')}</select></label>
      <label class="f"><span>${t('swap_my_shift_opt')}</span><select id="rss"><option value="">— ${t('no_swap')} —</option>${mineS.filter(s => s.date >= today()).map(s => `<option value="${s.id}">${esc(shiftText(s))}</option>`).join('')}</select></label>`;
    else html += `<label class="f"><span>${t('my_shift')}</span><select id="rs">${mineS.filter(s => s.date <= today()).reverse().concat(mineS.filter(s => s.date > today())).map(s => `<option value="${s.id}" ${s.date === today() ? 'selected' : ''}>${esc(shiftText(s))}</option>`).join('')}</select></label>`;
    if (type === 'handover') html += `<label class="f"><span>${t('worked_until')}</span><input type="time" id="rt" value="15:00"></label><p class="small mute">${t('handover_help')}</p>`;
    if (type === 'early') html += `<label class="f"><input type="checkbox" id="rn"> ${t('noshow')}</label><label class="f" id="rtl"><span>${t('left_at')}</span><input type="time" id="rt" value="12:00"></label>`;
  } else if (type === 'pallets') {
    html += `<label class="f"><span>${t('date')}</span><input type="date" id="rd" value="${today()}"></label><label class="f"><span>${t('pallets_correct')}</span><input type="number" step="0.5" min="0" id="rp" value="1"></label>`;
  } else {
    html += `<label class="f"><span>${t('date')}</span><input type="date" id="rd" value="${today()}"></label><label class="f"><span>${t('minutes')}</span><input type="number" min="1" step="5" id="rm" value="${type === 'training' ? 60 : 20}"></label>`;
  }
  html += `<label class="f"><span>${['extra', 'training'].includes(type) ? t('what_done_required') : t('comment_opt')}</span><textarea id="rc" placeholder="${type === 'extra' ? t('extra_placeholder') : ''}"></textarea></label><div id="rerr"></div>
    <button class="pri" id="rsend">${t('send_request')}</button></div>`;
  box.innerHTML = html;
  if ($('#rn', box)) $('#rn', box).onchange = e => { $('#rtl', box).style.display = e.target.checked ? 'none' : ''; };
  if ($('#rs', box) && !$('#rs', box).options.length) $('#rerr', box).innerHTML = `<div class="warnbox">${t('no_shifts_to_pick')}</div>`;
  $('#rsend', box).onclick = async () => {
    const v = id => $(id, box) ? $(id, box).value : undefined;
    const body = { location_id: S.loc, type, shift_id: v('#rs'), swap_shift_id: v('#rss') || null, time: v('#rt'), noshow: $('#rn', box) ? $('#rn', box).checked : false, date: v('#rd'), minutes: v('#rm'), pallets: v('#rp'), comment: v('#rc') };
    try { await api('POST', '/api/requests', body); toast(t('request_sent')); done(); } catch (e) { $('#rerr', box).innerHTML = errBox(e); }
  };
}

// ---------------- NOTES ----------------
async function pageNotes(el) {
  const notes = await api('GET', `/api/notes?loc=${S.loc}`);
  const admin = isAdmin();
  el.innerHTML = `<h1>${t('nav_notes')}</h1><div class="card"><label class="f"><span>${t('note_for_next')}</span><textarea id="nt" maxlength="500" placeholder="${t('note_placeholder')}"></textarea></label><button class="pri" id="ns">${t('send')}</button></div>
    <div class="card list">${notes.map(n => `<div class="item"><div class="grow ${n.resolved_at ? 'mute' : ''}"><b>${esc(n.author)}</b> <span class="small mute">${lts(n.created_at)}</span><br>${esc(n.text)}${n.resolved_at ? `<br><span class="small">✓ ${t('resolved')}: ${esc(n.resolver)} ${lts(n.resolved_at)}</span>` : ''}</div>
    ${admin && !n.resolved_at ? `<button class="sm" data-res="${n.id}">✓ ${t('mark_resolved')}</button>` : ''}</div>`).join('') || `<p class="mute">${t('no_data')}</p>`}</div>`;
  $('#ns', el).onclick = async () => { const text = $('#nt', el).value.trim(); if (!text) return; try { await api('POST', '/api/notes', { location_id: S.loc, text }); toast(t('saved')); pageNotes(el); } catch (e) { toast(e.message); } };
  $$('[data-res]', el).forEach(b => b.onclick = async () => { await api('POST', `/api/notes/${b.dataset.res}/resolve`); pageNotes(el); });
}

// ---------------- WARNINGS ----------------
async function pageWarnings(el) {
  const all = isOwner() && el.dataset.all === '1';
  const list = await api('GET', `/api/warnings?loc=${all ? 'all' : S.loc}`);
  el.innerHTML = `<div class="row"><h1 class="grow">${t('nav_warnings')}</h1>${isOwner() ? `<label><input type="checkbox" id="wall" ${all ? 'checked' : ''}> ${t('all_locations')}</label>` : ''}</div>
    <p class="small mute">${t('warnings_help')}</p>
    <div class="card list">${list.map(w => `<div class="item"><span class="excl">!</span><div class="grow red"><b>${ddmm(w.date)} ${t('dow_' + dow(w.date))}</b> ${all ? '· ' + esc(w.location) : ''} — ${esc(w.text)}</div><button class="sm" data-ack="${esc(w.key)}">✓ ${t('checked_ok')}</button></div>`).join('') || `<div class="okbox">✓ ${t('no_warnings')}</div>`}</div>`;
  if ($('#wall', el)) $('#wall', el).onchange = e => { el.dataset.all = e.target.checked ? '1' : ''; pageWarnings(el); };
  $$('[data-ack]', el).forEach(b => b.onclick = async () => { await api('POST', '/api/warnings/ack', { key: b.dataset.ack }); pageWarnings(el); });
}

// ---------------- REPORTS ----------------
const R = { type: 'payroll', mode: 'month', month: null, week: null, from: null, to: null, user: '', all: false };
const fmtCell = (c, v, row) => {
  if (v == null || v === '') return '';
  if (row && row._money && typeof v === 'number') return v.toFixed(2).replace('.', ',');
  switch (c.t) { case 'hm': case 'hmd': return typeof v === 'number' ? hmShort(v) : esc(v); case 'money': return typeof v === 'number' ? v.toFixed(2).replace('.', ',') : esc(v); case 'dec': return typeof v === 'number' ? v.toFixed(2).replace('.', ',') : esc(v); case 'pallets': return pal(v); default: return esc(v); }
};
function reportTable(s, opts = {}) {
  const num = c => ['hm', 'hmd', 'money', 'dec', 'int', 'pallets'].includes(c.t);
  let head;
  if (s.grouped) {
    let g = '<tr>'; let i = 0; const cols = s.columns;
    while (i < cols.length) { let j = i; while (cols[i].group && j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++; g += `<th colspan="${j - i + 1}" style="text-align:center">${esc(cols[i].group || cols[i].l)}</th>`; i = j + 1; }
    head = g + '</tr><tr>' + cols.map(c => `<th>${esc(c.group ? c.sub : '')}</th>`).join('') + '</tr>';
  } else head = '<tr>' + s.columns.map(c => `<th>${esc(c.l)}</th>`).join('') + (opts.extraCol ? '<th></th>' : '') + '</tr>';
  const rows = s.rows.map((r, ri) => `<tr class="${r._cls || ''} ${opts.click && r._uid ? 'click' : ''}" data-ri="${ri}" ${r._uid ? `data-uid="${r._uid}"` : ''}>${s.columns.map(c => {
    if (c.ui === 'status' && opts.status) return `<td style="white-space:nowrap" class="noclick"><label><input type="checkbox" data-st="checked" data-u="${r.user_id}" ${r.checked_at ? 'checked' : ''}> ${t('st_checked')}</label> <label><input type="checkbox" data-st="paid" data-u="${r.user_id}" ${r.paid_at ? 'checked' : ''}> ${t('st_paid')}</label><div class="small mute">${esc(r.status || '')}</div></td>`;
    return `<td class="${num(c) ? 'n' : ''}">${c.bold ? '<b>' : ''}${fmtCell(c, r[c.k])}${c.bold ? '</b>' : ''}</td>`;
  }).join('')}${opts.extraCol ? `<td class="noclick">${opts.extraCol(r)}</td>` : ''}</tr>`).join('');
  const tot = s.totalRow ? `<tr class="total">${s.columns.map(c => `<td class="${num(c) ? 'n' : ''}">${fmtCell(c, s.totalRow[c.k])}</td>`).join('')}${opts.extraCol ? '<td></td>' : ''}</tr>` : '';
  const after = (s.afterRows || []).map(r => `<tr class="bold">${s.columns.map(c => `<td class="${num(c) ? 'n' : ''}">${fmtCell(c, r[c.k], r)}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl-wrap"><table class="t"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="${s.columns.length}" class="mute">${t('no_data')}</td></tr>`}${tot}${after}</tbody></table></div>`;
}
const REPORTS = ['payroll', 'daily', 'weekly', 'deliveries', 'extra', 'money', 'requests', 'warnings', 'summary', 'compare'];
async function pageReports(el) {
  R.month = R.month || today().slice(0, 7); R.week = R.week || weekStart(today());
  if (!R.from) { [R.from, R.to] = monthRange(R.month); }
  el.innerHTML = `<h1>${t('nav_reports')}</h1><div class="card"><div class="row">
    <select id="rt">${REPORTS.filter(r => r !== 'summary' || isOwner()).map(r => `<option value="${r}" ${R.type === r ? 'selected' : ''}>${t('r_' + r)}</option>`).join('')}</select>
    <span class="seg" id="rmode"><button data-m="week" class="${R.mode === 'week' ? 'on' : ''}">${t('week')}</button><button data-m="month" class="${R.mode === 'month' ? 'on' : ''}">${t('month')}</button><button data-m="custom" class="${R.mode === 'custom' ? 'on' : ''}">${t('custom_dates')}</button></span>
    <span id="rper"></span>
    <select id="ru"><option value="">${t('all_workers')}</option>${S.workers.map(u => `<option value="${u.id}" ${String(R.user) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
    ${isOwner() ? `<label><input type="checkbox" id="rall" ${R.all ? 'checked' : ''}> ${t('all_locations')}</label>` : ''}
    </div><div class="row" style="margin-top:10px"><button id="xpdf">⬇ PDF</button><button id="xxlsx">⬇ XLSX</button><button id="xods">⬇ ODS</button><span class="small mute">${t('export_help')}</span></div></div><div id="rout" class="rep"><div class="loading">…</div></div>`;
  const per = $('#rper', el);
  const drawPer = () => {
    if (R.mode === 'month') per.innerHTML = `<input type="month" id="pm" value="${R.month}">`;
    else if (R.mode === 'week') per.innerHTML = `<button id="pw1" class="sm">‹</button> <input type="date" id="pw" value="${R.week}"> <button id="pw2" class="sm">›</button>`;
    else per.innerHTML = `<input type="date" id="pf" value="${R.from}"> – <input type="date" id="pt" value="${R.to}">`;
    if ($('#pm', per)) $('#pm', per).onchange = e => { R.month = e.target.value; [R.from, R.to] = monthRange(R.month); load(); };
    if ($('#pw', per)) { const setW = w => { R.week = weekStart(w); R.from = R.week; R.to = addDays(R.week, 6); drawPer(); load(); }; $('#pw', per).onchange = e => setW(e.target.value); $('#pw1', per).onclick = () => setW(addDays(R.week, -7)); $('#pw2', per).onclick = () => setW(addDays(R.week, 7)); }
    if ($('#pf', per)) { $('#pf', per).onchange = e => { R.from = e.target.value; load(); }; $('#pt', per).onchange = e => { R.to = e.target.value; load(); }; }
  };
  $$('#rmode button', el).forEach(b => b.onclick = () => {
    R.mode = b.dataset.m; $$('#rmode button', el).forEach(x => x.classList.toggle('on', x === b));
    if (R.mode === 'month') [R.from, R.to] = monthRange(R.month); if (R.mode === 'week') { R.from = R.week; R.to = addDays(R.week, 6); }
    drawPer(); load();
  });
  $('#rt', el).onchange = e => { R.type = e.target.value; if (R.type === 'weekly' && R.mode !== 'week') { R.mode = 'week'; R.from = R.week; R.to = addDays(R.week, 6); pageReports(el); return; } load(); };
  $('#ru', el).onchange = e => { R.user = e.target.value; load(); };
  if ($('#rall', el)) $('#rall', el).onchange = e => { R.all = e.target.checked; load(); };
  const qs = () => `loc=${R.all ? 'all' : S.loc}&from=${R.from}&to=${R.to}${R.user ? '&user=' + R.user : ''}`;
  $('#xpdf', el).onclick = () => { location.href = `/api/export/${R.type}?${qs()}&format=pdf`; };
  $('#xxlsx', el).onclick = () => { location.href = `/api/export/${R.type}?${qs()}&format=xlsx`; };
  $('#xods', el).onclick = () => { location.href = `/api/export/${R.type}?${qs()}&format=ods`; };
  const load = async () => {
    const out = $('#rout', el); out.innerHTML = '<div class="loading">…</div>';
    try {
      const rep = await api('GET', `/api/reports/${R.type}?${qs()}`);
      out.innerHTML = `<p class="mute small">${esc(rep.locations)} · ${rep.from} — ${rep.to}</p>` + rep.sections.map((s, si) => `${s.title ? `<h2>${esc(s.title)}</h2>` : ''}<div data-si="${si}">${reportTable(s, {
        click: rep.clickable, status: R.type === 'payroll' && s.location_id,
        extraCol: s.ackable ? r => `<button class="sm" data-ack="${esc(r.key)}">✓ ${t('checked_ok')}</button>` : s.deletable ? r => `<button class="sm danger" data-del="${r.id}" data-dk="${s.deletable}">✕</button>` : null,
      })}</div>`).join('');
      $$('tr.click', out).forEach(tr => tr.onclick = e => { if (e.target.closest('.noclick')) return; detailModal(Number(tr.dataset.uid)); });
      $$('[data-st]', out).forEach(cb => cb.onchange = async () => {
        const si = cb.closest('[data-si]').dataset.si; const s = rep.sections[si];
        await api('POST', '/api/payroll-status', { location_id: s.location_id, user_id: Number(cb.dataset.u), month: s.month, field: cb.dataset.st, value: cb.checked }); toast(t('saved'));
      });
      $$('[data-ack]', out).forEach(b => b.onclick = async () => { await api('POST', '/api/warnings/ack', { key: b.dataset.ack }); load(); });
      $$('[data-del]', out).forEach(b => b.onclick = async () => { if (!confirm(t('delete_q'))) return; try { await api('DELETE', b.dataset.dk === 'money' ? `/api/money/${b.dataset.del}` : `/api/adjustments/${b.dataset.del}`); load(); } catch (e) { toast(e.message); } });
      if (R.type === 'payroll') out.insertAdjacentHTML('beforeend', `<p class="small mute">${t('payroll_help')}</p>`);
    } catch (e) { out.innerHTML = errBox(e); }
  };
  drawPer(); load();
  async function detailModal(uid) {
    const rep = await api('GET', `/api/reports/detail?${qs().replace(/&user=\d+/, '')}&user=${uid}`);
    const b = modal(`<h2>${esc(rep.title)}</h2>${rep.sections.map(s => `<p class="mute small">${esc(s.title)}</p>${reportTable(s)}`).join('')}
      <div class="row" style="margin-top:10px"><a class="small" href="/api/export/detail?${qs().replace(/&user=\d+/, '')}&user=${uid}&format=pdf">⬇ PDF</a> <a class="small" href="/api/export/detail?${qs().replace(/&user=\d+/, '')}&user=${uid}&format=xlsx">⬇ XLSX</a></div>`, true);
  }
}

// ---------------- WORKERS ----------------
async function pageWorkers(el) {
  const users = await api('GET', '/api/users');
  const locs = S.me.locations;
  const rates = S.me.can_rates;
  const adminLocs = locs.filter(l => l.is_admin);
  el.innerHTML = `<div class="row"><h1 class="grow">${t('nav_workers')}</h1><button class="pri" id="uadd">+ ${t('add_worker')}</button></div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th>${t('name')}</th><th>${t('login')}</th><th>${t('c_locations')}</th>${rates ? `<th>${t('c_rate')}</th><th>${t('c_trate')}</th>` : ''}<th>Telegram</th><th>${t('status')}</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr class="${u.active ? '' : 'mute'}"><td><b>${esc(u.name)}</b>${['admin', 'owner'].includes(u.role) ? ` <span class="pill pub">${t('admin')}</span>` : ''}</td><td>${esc(u.login)}</td><td>${u.locations.map(id => esc((locs.find(l => l.id === id) || {}).name || '#' + id)).join(', ')}</td>
      ${rates ? `<td class="n">${u.rate != null ? zl(u.rate) : ''}</td><td class="n">${u.training_rate != null ? zl(u.training_rate) : ''}</td>` : ''}<td>${u.tg_linked ? '✓' : '—'}</td><td>${u.active ? t('active') : t('inactive')}</td><td><button class="sm" data-edit="${u.id}">✎</button></td></tr>`).join('')}
    </tbody></table></div><p class="small mute">${t('workers_help')}</p>`;
  const edit = u => {
    const isNew = !u; u = u || { active: 1, locations: [S.loc], rate: 31.4, training_rate: 20 };
    const b = modal(`<h2>${isNew ? t('add_worker') : esc(u.name)}</h2>
      <label class="f"><span>${t('name')}</span><input id="un" value="${esc(u.name || '')}"></label>
      <label class="f"><span>${t('login')}</span><input id="ul" autocapitalize="none" autocomplete="off" value="${esc(u.login || '')}">${isNew ? '' : `<span class="small mute">${t('login_change_help')}</span>`}</label>
      <label class="f"><span>${isNew ? t('password') : t('new_password_opt')}</span><input id="up" type="text" autocomplete="new-password"></label>
      <div class="f"><span class="mute small">${t('c_locations')}</span><br>${adminLocs.map(l => `<label style="margin-right:12px"><input type="checkbox" class="ulc" value="${l.id}" ${u.locations.includes(l.id) ? 'checked' : ''}> ${esc(l.name)}</label>`).join('')}</div>
      ${rates ? `<div class="row"><label class="f grow"><span>${t('c_rate')} (zł/${t('h')})</span><input id="ur" type="number" step="0.1" value="${u.rate ?? ''}"></label><label class="f grow"><span>${t('c_trate')} (zł/${t('h')})</span><input id="utr" type="number" step="0.1" value="${u.training_rate ?? ''}"></label></div>` : ''}
      ${isOwner() && u.id !== S.me.user.id ? `<label class="f"><input type="checkbox" id="urole" ${['admin', 'owner'].includes(u.role) ? 'checked' : ''}> ${t('is_admin_role')} <span class="small mute">(${t('is_admin_help')})</span></label>` : ''}
      ${!isNew ? `<label class="f"><input type="checkbox" id="ua" ${u.active ? 'checked' : ''}> ${t('active')} <span class="small mute">(${t('deactivate_help')})</span></label>` : ''}
      <div id="uerr"></div><div class="row end"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="uok">${t('save')}</button></div>`);
    $('#uok', b).onclick = async () => {
      const body = { name: $('#un', b).value, password: $('#up', b).value || undefined, locations: $$('.ulc', b).filter(x => x.checked).map(x => Number(x.value)) };
      if (rates) { body.rate = Number($('#ur', b).value); body.training_rate = Number($('#utr', b).value); }
      if ($('#urole', b)) body.role = $('#urole', b).checked ? 'admin' : 'user';
      if ($('#ua', b)) body.active = $('#ua', b).checked;
      body.login = $('#ul', b).value;
      try { if (isNew) { await api('POST', '/api/users', body); } else await api('PUT', `/api/users/${u.id}`, body); closeModal(); toast(t('saved')); await loadWorkers(); pageWorkers(el); }
      catch (e) { $('#uerr', b).innerHTML = errBox(e); }
    };
  };
  $('#uadd', el).onclick = () => edit(null);
  $$('[data-edit]', el).forEach(b => b.onclick = () => edit(users.find(u => u.id === Number(b.dataset.edit))));
}

// ---------------- LOCATIONS (owner) ----------------
async function pageLocations(el) {
  const [locs, users] = await Promise.all([api('GET', '/api/locations'), api('GET', '/api/users')]);
  const opts = (sel) => `<option value="">—</option>` + users.filter(u => u.active).map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  el.innerHTML = `<div class="row"><h1 class="grow">${t('nav_locations')}</h1><button class="pri" id="ladd">+ ${t('add_location')}</button></div>
    <div class="card list">${locs.map(l => `<div class="item"><div class="grow"><b>${esc(l.name)}</b> ${l.active ? '' : `<span class="pill">${t('inactive')}</span>`}<br><span class="small">${t('admin')}: ${esc(l.admin_name || '—')}${l.deputy_name ? ` · ${t('deputy')}: ${esc(l.deputy_name)}` : ''} · ${t('restock_col')}: ${l.has_restock ? '✓' : '—'}</span></div><button class="sm" data-e="${l.id}">✎</button></div>`).join('')}</div>
    <p class="small mute">${t('locations_help')}</p>`;
  const edit = l => {
    const isNew = !l; l = l || { name: '', active: 1, has_restock: 0 };
    const b = modal(`<h2>${isNew ? t('add_location') : esc(l.name)}</h2>
      <label class="f"><span>${t('name')}</span><input id="ln" value="${esc(l.name)}"></label>
      <label class="f"><span>${t('admin')}</span><select id="la">${opts(l.admin_id)}</select></label>
      <label class="f"><span>${t('deputy')} <span class="small">(${t('deputy_help')})</span></span><select id="ld">${opts(l.deputy_id)}</select></label>
      <label class="f"><input type="checkbox" id="lr" ${l.has_restock ? 'checked' : ''}> ${t('restock_col')}</label>
      ${!isNew ? `<label class="f"><input type="checkbox" id="lac" ${l.active ? 'checked' : ''}> ${t('active')}</label>` : ''}
      <div id="lerr"></div><div class="row end"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="lok">${t('save')}</button></div>`);
    $('#lok', b).onclick = async () => {
      const body = { name: $('#ln', b).value, admin_id: $('#la', b).value || null, deputy_id: $('#ld', b).value || null, has_restock: $('#lr', b).checked, active: $('#lac', b) ? $('#lac', b).checked : true };
      try { if (isNew) await api('POST', '/api/locations', body); else await api('PUT', `/api/locations/${l.id}`, body); closeModal(); await refreshMe(); pageLocations(el); } catch (e) { $('#lerr', b).innerHTML = errBox(e); }
    };
  };
  $('#ladd', el).onclick = () => edit(null);
  $$('[data-e]', el).forEach(b => b.onclick = () => edit(locs.find(l => l.id === Number(b.dataset.e))));
}

// ---------------- MONTHS ----------------
async function pageMonths(el) {
  const closed = await api('GET', `/api/months?loc=${S.loc}`);
  const months = []; let m = today().slice(0, 7);
  for (let i = 0; i < 6; i++) { months.push(m); const [y, mo] = m.split('-').map(Number); m = fd(new Date(Date.UTC(y, mo - 2, 1))).slice(0, 7); }
  el.innerHTML = `<h1>${t('nav_months')}</h1><p class="small mute">${t('months_help')}</p><div class="card list">${months.map(mm => { const c = closed.find(x => x.month === mm); return `<div class="item"><div class="grow"><b>${mm}</b> ${c ? `🔒 <span class="small">${t('closed_by')}: ${esc(c.closed_name)} ${lts(c.closed_at)}</span>` : `<span class="small mute">${t('open')}</span>`}</div>
    ${c ? (isOwner() ? `<button class="sm" data-re="${mm}">${t('reopen')}</button>` : '') : `<button class="sm pri" data-cl="${mm}">${t('close_month')}</button>`}</div>`; }).join('')}</div>`;
  $$('[data-cl]', el).forEach(b => b.onclick = async () => { if (!confirm(t('close_month_q', { m: b.dataset.cl }))) return; await api('POST', '/api/months/close', { location_id: S.loc, month: b.dataset.cl }); pageMonths(el); });
  $$('[data-re]', el).forEach(b => b.onclick = async () => { await api('POST', '/api/months/reopen', { location_id: S.loc, month: b.dataset.re }); pageMonths(el); });
}

// ---------------- AUDIT ----------------
async function pageAudit(el) {
  const rows = await api('GET', `/api/audit?loc=${S.loc}`);
  const fmtD = d => { try { const o = JSON.parse(d); return Object.entries(o).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' · '); } catch (_) { return esc(d); } };
  el.innerHTML = `<h1>${t('nav_audit')}</h1><div class="tbl-wrap"><table class="t"><thead><tr><th>${t('when')}</th><th>${t('who')}</th><th>${t('action')}</th><th>${t('c_details')}</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td style="white-space:nowrap">${lts(r.at)}</td><td>${esc(r.user_name || '')}</td><td>${esc(t('a_' + r.action))}</td><td class="small" style="overflow-wrap:anywhere">${fmtD(r.details)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------------- SETTINGS ----------------
async function pageSettings(el) {
  const u = S.me.user;
  const cats = ['schedule', 'shift', 'decision', 'money', 'avail', 'task', 'note', 'request', 'reminder'];
  el.innerHTML = `<h1>${t('nav_settings')}</h1>
    <div class="card"><h2 style="margin-top:0">${t('language')}</h2>${langSeg()}</div>
    ${isOwner() ? '<div class="card" id="tgadmin"><div class="loading">…</div></div>' : ''}
    <div class="card"><h2 style="margin-top:0">Telegram</h2>${u.tg_linked ? `<p>✓ ${t('tg_linked')}</p><button id="tgun">${t('tg_unlink')}</button>` : `<p class="mute">${t('tg_help')}</p><button class="pri" id="tgl">${t('tg_link')}</button><div id="tgout"></div>`}
      <h2>${t('notif_settings')}</h2>${cats.map(c => `<label class="f"><input type="checkbox" class="nc" value="${c}" ${u.notify[c] === false ? '' : 'checked'}> ${t('ncat_' + c)}</label>`).join('')}
      ${isOwner() ? `<h2>${t('notif_locations')}</h2><p class="small mute">${t('notif_locations_help')}</p>${S.me.locations.map(l => { const home = l.admin_id === u.id || l.deputy_id === u.id; return `<label class="f"><input type="checkbox" class="nl" value="${l.id}" ${home ? 'checked disabled' : ((u.notify.locs || []).includes(l.id) ? 'checked' : '')}> ${esc(l.name)}${home ? ` <span class="small mute">(${t('notif_home_loc')})</span>` : ''}</label>`; }).join('')}` : ''}</div>
    <div class="card"><h2 style="margin-top:0">${t('change_password')}</h2><label class="f"><span>${t('old_password')}</span><input type="password" id="po"></label><label class="f"><span>${t('new_password')}</span><input type="password" id="pn"></label><div id="perr"></div><button id="psave">${t('save')}</button></div>
    <div class="card"><button id="lo2">${t('logout')}</button></div>`;
  bindLang(route);
  if ($('#tgl', el)) $('#tgl', el).onclick = async () => {
    const win = window.open('', '_blank');
    const r = await api('POST', '/api/me/tg-code');
    if (win) win.location = r.link; else location.href = r.link;
    $('#tgout', el).innerHTML = `<p><a class="pri" href="${r.link}" target="_blank" rel="noopener">${t('tg_open_bot')}</a></p><p class="small mute">${t('tg_after')}</p>`;
    let n = 0; const iv = setInterval(async () => { n++; const me = await api('GET', '/api/me'); if (me.user.tg_linked || n > 60) { clearInterval(iv); if (me.user.tg_linked) { S.me = me; toast(t('tg_linked')); if (location.hash.includes('settings')) pageSettings(el); } } }, 3000);
  };
  if ($('#tgadmin', el)) tgAdminCard($('#tgadmin', el));
  if ($('#tgun', el)) $('#tgun', el).onclick = async () => { await api('POST', '/api/me/tg-unlink'); await refreshMe(); pageSettings(el); };
  const saveNotify = async () => { const o = {}; $$('.nc', el).forEach(x => { if (!x.checked) o[x.value] = false; }); if ($$('.nl', el).length) o.locs = $$('.nl', el).filter(x => x.checked && !x.disabled).map(x => Number(x.value)); await api('POST', '/api/me/notify', o); await refreshMe(); toast(t('saved')); };
  $$('.nc, .nl', el).forEach(cb => cb.onchange = saveNotify);
  $('#psave', el).onclick = async () => { try { await api('POST', '/api/me/password', { old: $('#po', el).value, password: $('#pn', el).value }); toast(t('saved')); $('#po', el).value = $('#pn', el).value = ''; } catch (e) { $('#perr', el).innerHTML = errBox(e); } };
  $('#lo2', el).onclick = logout;
}

// ---------------- NOTIFICATIONS ----------------
async function pageNotifications(el) {
  const list = await api('GET', '/api/notifications');
  el.innerHTML = `<h1>${t('notifications')}</h1><div class="card list">${list.map(n => `<div class="item"><div class="grow ${n.read ? 'mute' : ''}">${n.read ? '' : '● '}${esc(n.text)}<br><span class="small mute">${lts(n.created_at)}</span></div></div>`).join('') || `<p class="mute">${t('no_data')}</p>`}</div>`;
  if (list.some(n => !n.read)) { await api('POST', '/api/notifications/read'); S.me.unread = 0; const bd = $('#bell .badge'); if (bd) bd.remove(); }
}

// ---------------- ПРЕМІЇ, ШТРАФИ, МІНУСИ, АВАНСИ ----------------
const MK = ['bonus', 'fine', 'shortage', 'advance'];
const signed = e => e.kind === 'advance' ? zl(e.amount) : (e.kind === 'bonus' ? '+' : '−') + zl(e.amount);
const moneyCls = e => (e.kind === 'fine' || e.kind === 'shortage') ? 'red' : '';
async function myMoneyBlock(box, month, earned) {
  const m = await api('GET', `/api/my/money?month=${month}`);
  const s = m.sums; const accrued = earned + s.bonus - s.fine - s.shortage; const left = accrued - s.advance;
  box.innerHTML = `<h2>${t('r_money')}</h2>${m.entries.length ? `<div class="card list">${m.entries.map(e => `<div class="item"><div class="grow"><b class="${moneyCls(e)}">${t('mk_' + e.kind)} ${signed(e)}</b> <span class="mute small">${ddmm(e.date)} · ${esc(e.location)}${e.method ? ' · ' + t('method_' + e.method) : ''}${e.shift ? ' · ' + slotName(e.shift) : ''}</span><br>${esc(e.comment)}<br><span class="small mute">${t('c_entered_by')}: ${esc(e.created_name)}, ${lts(e.created_at)}</span></div></div>`).join('')}</div>` : `<p class="mute">${t('no_data')}</p>`}
    <div class="card"><div class="tbl-wrap" style="border:0"><table class="t"><tbody>
      <tr><td>${t('c_earned')}</td><td class="n">${zl(earned)}</td></tr>
      <tr><td>+ ${t('c_bonus')}</td><td class="n">${zl(s.bonus)}</td></tr><tr><td>− ${t('c_fine')}</td><td class="n">${zl(s.fine)}</td></tr><tr><td>− ${t('c_shortage')}</td><td class="n">${zl(s.shortage)}</td></tr>
      <tr class="total"><td>= ${t('c_accrued')}</td><td class="n">${zl(accrued)}</td></tr>
      <tr><td>− ${t('advances_received')}</td><td class="n">${zl(s.advance)}</td></tr>
      <tr class="total"><td>= ${t('left_to_pay')}</td><td class="n ${left < 0 ? 'red' : ''}">${zl(left)}</td></tr></tbody></table></div></div>`;
}
function moneyModal(preset, done) {
  preset = preset || {};
  const kind0 = preset.kind || 'bonus';
  const b = modal(`<h2>${t('add_money')}</h2>
    <label class="f"><span>${t('kind')}</span><select id="mk">${MK.map(k => `<option value="${k}" ${k === kind0 ? 'selected' : ''}>${t('mk_' + k)} (${k === 'bonus' ? '+' : '−'})</option>`).join('')}</select></label>
    <div id="mone"><label class="f"><span>${t('worker')}</span><select id="mu">${S.workers.map(u => `<option value="${u.id}" ${u.id === preset.user_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="f"><span>${t('amount_zl')}</span><input type="number" id="ma" min="0.01" step="0.01"></label></div>
    <div id="msplit"><label class="f"><span>${t('shortage_total')}</span><input type="number" id="mt" min="0.01" step="0.01"></label>
      <div class="f"><span class="mute small">${t('split_between')}</span>${S.workers.map(u => `<div class="row" style="margin:4px 0"><label class="grow"><input type="checkbox" class="msu" value="${u.id}" ${u.id === preset.user_id ? 'checked' : ''}> ${esc(u.name)}</label><input type="number" class="msa" data-u="${u.id}" min="0" step="0.01" style="width:110px" placeholder="zł"></div>`).join('')}</div></div>
    <label class="f" id="mdl"><span>${t('date')}</span><input type="date" id="md" value="${preset.date || today()}"></label>
    <label class="f" id="mml"><span>${t('c_method')}</span><select id="mm"><option value="cash">${t('method_cash')}</option><option value="transfer">${t('method_transfer')}</option></select></label>
    ${preset.shift_id ? `<p class="small">${t('c_slot')}: <b>${esc(preset.shift_text || '')}</b></p>` : `<p class="small mute" id="mnoshift">${t('shortage_from_card')}</p>`}
    <label class="f"><span>${t('comment_required')}</span><textarea id="mc" placeholder="${t('money_placeholder')}"></textarea></label><div id="merr"></div>
    <div class="row end"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="mok">${t('save')}</button></div>`);
  const sync = () => {
    const k = $('#mk', b).value;
    $('#mone', b).style.display = k === 'shortage' ? 'none' : '';
    $('#msplit', b).style.display = k === 'shortage' ? '' : 'none';
    $('#mml', b).style.display = k === 'advance' ? '' : 'none';
    $('#mdl', b).style.display = preset.shift_id ? 'none' : '';
    if ($('#mnoshift', b)) $('#mnoshift', b).style.display = k === 'shortage' ? '' : 'none';
    $('#mok', b).disabled = k === 'shortage' && !preset.shift_id;
  };
  const resplit = () => { const sel = $$('.msu', b).filter(x => x.checked); const tot = Number($('#mt', b).value) || 0; const each = sel.length ? Math.floor(tot / sel.length * 100) / 100 : 0;
    $$('.msa', b).forEach(i => { i.value = ''; }); sel.forEach((x, i) => { const inp = $(`.msa[data-u="${x.value}"]`, b); inp.value = (i === sel.length - 1 ? Math.round((tot - each * (sel.length - 1)) * 100) / 100 : each).toFixed(2); }); };
  $('#mk', b).onchange = sync; $('#mt', b).oninput = resplit; $$('.msu', b).forEach(x => x.onchange = resplit); sync();
  $('#mok', b).onclick = async () => {
    const k = $('#mk', b).value;
    const body = { location_id: S.loc, kind: k, comment: $('#mc', b).value, date: $('#md', b).value, shift_id: preset.shift_id || null, method: $('#mm', b).value };
    if (k === 'shortage') body.split = $$('.msu', b).filter(x => x.checked).map(x => ({ user_id: Number(x.value), amount: Number($(`.msa[data-u="${x.value}"]`, b).value) }));
    else { body.user_id = Number($('#mu', b).value); body.amount = Number($('#ma', b).value); }
    try { await api('POST', '/api/money', body); closeModal(); toast(t('saved')); done && done(); } catch (e) { $('#merr', b).innerHTML = errBox(e); }
  };
}
let cardDate = null;
async function pageShiftCards(el) {
  const pre = sessionStorage.getItem('cardDate'); if (pre) { cardDate = pre; sessionStorage.removeItem('cardDate'); }
  cardDate = cardDate || today();
  const d = await api('GET', `/api/shift-cards/${S.loc}?date=${cardDate}`);
  const mrow = e => `<div class="small"><b class="${moneyCls(e)}">${t('mk_' + e.kind)} ${signed(e)}</b> ${e.kind === 'advance' && e.method ? '(' + t('method_' + e.method) + ') ' : ''}— ${esc(e.comment)} <span class="mute">(${esc(e.created_name)}, ${lts(e.created_at)})</span> ${d.closed && !isOwner() ? '' : `<button class="sm danger" data-mdel="${e.id}">✕</button>`}</div>`;
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h1>${t('nav_shiftcards')}: ${ddmm(cardDate)} ${t('dow_' + dow(cardDate))}${d.closed ? ' 🔒' : ''}</h1>
    <div class="row"><button id="cprev">‹</button><input type="date" id="cdate" value="${cardDate}"><button id="cnext">›</button><button id="cadd" class="pri">+ ${t('add_money')}</button></div></div>
    ${d.delivery ? `<p>📦 ${t('delivery')}: <b>${esc(d.delivery.name)}</b> — ${d.delivery.pallets != null ? pal(d.delivery.pallets) + ' ' + t('pallets_short') : '<span class="red">! ' + t('not_confirmed') + '</span>'}</p>` : ''}
    <div class="grid2">${d.cards.map(c => `<div class="card" style="${c.cancelled ? 'opacity:.6' : ''}"><div class="row"><b class="grow">${slotName(c.slot)}</b>${c.ended ? `<span class="pill approved">${t('shift_done')}</span>` : c.cancelled ? `<span class="pill rejected">${t('cancelled')}</span>` : `<span class="pill">${t('planned')}</span>`}</div>
      <div style="font-size:17px;margin:6px 0"><b>${esc(c.name)}</b> ${hm(c.start)}–${hm(c.end)}</div>
      ${c.changed ? `<div class="small chg" style="color:var(--blue)">${t('plan')}: ${esc(c.plan)}</div>` : ''}
      ${c.extra.map(a => `<div class="small">⏱ ${t('kind_' + a.kind)} +${a.minutes} ${t('min')} — ${esc(a.comment || '')} <span class="mute">(${esc(a.approved)})</span></div>`).join('')}
      ${c.pallets != null ? `<div class="small">📦 ${pal(c.pallets)} ${t('pallets_short')}</div>` : ''}
      ${c.money.map(mrow).join('')}
      ${c.notes.map(n => `<div class="small note">📝 ${esc(n.time)} ${esc(n.author)}: ${esc(n.text)}${n.resolved ? ' ✓' : ''}</div>`).join('')}
      ${d.closed && !isOwner() ? '' : `<div class="row" style="margin-top:8px"><button class="sm danger" data-short="${c.id}">− ${t('add_shortage')}</button><button class="sm" data-bonus="${c.id}">+ ${t('add_bonus')}</button></div>`}</div>`).join('') || `<p class="mute">${t('no_shifts')}</p>`}</div>`;
  const go = dd => { cardDate = dd; pageShiftCards(el); };
  $('#cprev', el).onclick = () => go(addDays(cardDate, -1)); $('#cnext', el).onclick = () => go(addDays(cardDate, 1)); $('#cdate', el).onchange = e => go(e.target.value);
  const reload = () => pageShiftCards(el);
  $('#cadd', el).onclick = () => moneyModal({ date: cardDate }, reload);
  const card = id => d.cards.find(c => c.id === Number(id));
  $$('[data-short]', el).forEach(btn => btn.onclick = () => { const c = card(btn.dataset.short); moneyModal({ kind: 'shortage', shift_id: c.id, user_id: c.user_id, shift_text: `${ddmm(cardDate)} ${slotName(c.slot)} ${hm(c.start)}–${hm(c.end)} · ${c.name}` }, reload); });
  $$('[data-bonus]', el).forEach(btn => btn.onclick = () => { const c = card(btn.dataset.bonus); moneyModal({ kind: 'bonus', user_id: c.user_id, date: cardDate }, reload); });
  $$('[data-mdel]', el).forEach(btn => btn.onclick = async () => { if (!confirm(t('delete_q'))) return; try { await api('DELETE', `/api/money/${btn.dataset.mdel}`); reload(); } catch (e) { toast(e.message); } });
}

// ---------------- ДИСПОЗИЦІЯ (доступність) ----------------
const AV_KINDS = ['all', 's1', 's2', 'rs', 'from', 'to', 'range', 'no'];
const avDesc = e => {
  if (!e) return t('av_none');
  if (e.kind === 'vac') return t('av_vac');
  if (e.kind === 'from') return t('av_btn_from').replace('…', hm(e.start));
  if (e.kind === 'to') return t('av_btn_to').replace('…', hm(e.end));
  if (e.kind === 'range') return t('av_btn_range').replace('…', hm(e.start)).replace('…', hm(e.end));
  return t('av_' + e.kind);
};
const avClass = e => !e ? 'av-none' : e.kind === 'all' ? 'av-full' : (e.kind === 'no' || e.kind === 'vac') ? 'av-no' : 'av-part';
function avInterval(e, date) {
  if (!e || e.kind === 'no' || e.kind === 'vac') return null;
  if (e.kind === 'all') return [0, 1440];
  if (['s1', 's2', 'rs'].includes(e.kind)) return DEF(date, e.kind);
  if (e.kind === 'from') return [e.start, 1440];
  if (e.kind === 'to') return [0, e.end];
  return [e.start, e.end];
}
/** full | partial | no | none — чи може працівник на інтервал [s, en] */
function avCoverage(e, date, s, en) {
  if (!e) return 'none';
  const iv = avInterval(e, date);
  if (!iv) return 'no';
  if (iv[0] <= s && iv[1] >= en) return 'full';
  if (iv[0] < en && iv[1] > s) return 'partial';
  return 'no';
}
function workerOptionsByAvail(avail, date, s, en, selected) {
  const groups = { full: [], partial: [], none: [], no: [] };
  for (const u of S.workers) { const e = (avail[u.id] || {})[date]; groups[avCoverage(e, date, s, en)].push({ u, e }); }
  const opt = ({ u, e }, g) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${g === 'full' ? '✅ ' : g === 'partial' ? '🟡 ' : g === 'no' ? '⛔ ' : '▫️ '}${esc(u.name)}${g === 'partial' || g === 'no' ? ' — ' + esc(avDesc(e)) : ''}</option>`;
  return ['full', 'partial', 'none', 'no'].filter(g => groups[g].length).map(g => `<optgroup label="${t('av_g_' + g)}">${groups[g].map(x => opt(x, g)).join('')}</optgroup>`).join('');
}
function availWarnings(avail, cells) {
  const out = [];
  for (const c of cells) {
    if (!c.user_id || c.slot === 'dl') continue;
    const [ds, de] = DEF(c.date, c.slot);
    const s = parseHM(c.start) ?? ds, en = parseHM(c.end) ?? de;
    const e = (avail[c.user_id] || {})[c.date];
    const cov = avCoverage(e, c.date, s, en);
    if (cov === 'no' || cov === 'partial') {
      const name = (S.workers.find(u => u.id === Number(c.user_id)) || {}).name || '?';
      out.push(`• ${ddmm(c.date)} ${slotName(c.slot)} ${hm(s)}–${hm(en)}: ${name} — ${avDesc(e)}`);
    }
  }
  return out;
}
/** Форма вибору варіанту доступності (8 кнопок + час + коментар). */
function availEditor(box, entry) {
  let kind = entry ? entry.kind : null;
  box.innerHTML = `<div class="avbtns">${AV_KINDS.map(k => `<button type="button" data-k="${k}" class="${k === kind ? 'on' : ''} avk-${k}">${t('av_btn_' + k)}</button>`).join('')}</div>
    <div class="row avtimes" style="margin-top:6px"><label class="avs">${t('av_from')} <input type="time" class="avstart" value="${entry && entry.start != null ? hm(entry.start) : '12:00'}"></label>
    <label class="ave">${t('av_to')} <input type="time" class="avend" value="${entry && entry.end != null ? hm(entry.end) : '18:00'}"></label></div>
    <input class="avc" maxlength="200" placeholder="${t('av_comment')}" value="${esc(entry && entry.comment || '')}" style="width:100%;margin-top:6px">`;
  const sync = () => {
    $$('.avbtns button', box).forEach(b => b.classList.toggle('on', b.dataset.k === kind));
    $('.avs', box).style.display = kind === 'from' || kind === 'range' ? '' : 'none';
    $('.ave', box).style.display = kind === 'to' || kind === 'range' ? '' : 'none';
  };
  $$('.avbtns button', box).forEach(b => b.onclick = () => { kind = b.dataset.k; sync(); });
  sync();
  return () => kind ? { kind, start: $('.avstart', box).value, end: $('.avend', box).value, comment: $('.avc', box).value } : null;
}
const dlText = d => `${t('dow_full_' + d.dow)} ${ddmm(d.date)} ${d.time}`;

let myAvWeek = null;
async function pageMyAvail(el) {
  const r = await api('GET', `/api/my/avail${myAvWeek ? '?week=' + myAvWeek : ''}`);
  myAvWeek = r.week;
  const end = addDays(r.week, 6);
  let html = `<div class="row" style="justify-content:space-between"><h1>${t('nav_avail')}: ${ddmm(r.week)} – ${ddmm(end)}</h1>
    <div class="row"><button id="aw1">‹</button><button id="aw2">›</button></div></div>`;
  if (!r.has_locations) { el.innerHTML = html + `<div class="card mute">${t('err_avail_no_locations')}</div>`; bind(); return; }
  html += `<div class="${r.editable ? 'okbox' : 'warnbox'}">${r.editable ? t('av_deadline_info', { d: dlText(r.deadline) }) : t('av_deadline_passed', { d: dlText(r.deadline) })}</div>
    <p class="small mute">${t('av_your_locations')}: ${r.locations.map(esc).join(', ')}</p>`;
  html += r.days.map(d => `<div class="card ${d.dow === 6 ? 'sunbox' : ''}" data-date="${d.date}"><div class="row"><b class="grow">${t('dow_full_' + d.dow)} ${ddmm(d.date)}</b>
      <span class="pill ${avClass(d.entry)}">${esc(avDesc(d.entry))}</span></div>
      ${d.entry && d.entry.comment ? `<div class="small mute">💬 ${esc(d.entry.comment)}</div>` : ''}
      ${r.editable ? `<div class="aved" style="margin-top:8px"></div><div class="row end" style="margin-top:6px"><button class="pri sm avsave">${t('save')}</button></div>`
        : `<div class="row end" style="margin-top:6px"><button class="sm avreq">${t('av_change_request')}</button></div>`}</div>`).join('');
  el.innerHTML = html;
  bind();
  for (const d of r.days) {
    const card = $(`.card[data-date="${d.date}"]`, el);
    if (r.editable) {
      const get = availEditor($('.aved', card), d.entry);
      $('.avsave', card).onclick = async () => { const v = get(); if (!v) return toast(t('err_avail_kind')); try { await api('PUT', '/api/my/avail', { date: d.date, ...v }); toast(t('saved')); pageMyAvail(el); } catch (e) { toast(e.message); } };
    } else $('.avreq', card).onclick = () => {
      const b = modal(`<h2>${t('av_change_request')}: ${t('dow_full_' + d.dow)} ${ddmm(d.date)}</h2><p class="small mute">${t('av_now')}: ${esc(avDesc(d.entry))}</p><div id="ared"></div><div id="aerr"></div>
        <div class="row end" style="margin-top:10px"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="aok">${t('send_request')}</button></div>`);
      const get = availEditor($('#ared', b), d.entry);
      $('#aok', b).onclick = async () => { const v = get(); if (!v) return; try { await api('POST', '/api/requests', { location_id: S.loc, type: 'avail', date: d.date, ...v }); closeModal(); toast(t('request_sent')); } catch (e) { $('#aerr', b).innerHTML = errBox(e); } };
    };
  }
  function bind() {
    $('#aw1', el).onclick = () => { myAvWeek = addDays(myAvWeek, -7); pageMyAvail(el); };
    $('#aw2', el).onclick = () => { myAvWeek = addDays(myAvWeek, 7); pageMyAvail(el); };
  }
}

let dispWeek = null; const dispFilter = { day: '', slot: '' };
async function pageDisposition(el) {
  const [r, cfg] = await Promise.all([api('GET', `/api/avail/${S.loc}${dispWeek ? '?week=' + dispWeek : ''}`), api('GET', '/api/avail/settings')]);
  dispWeek = r.week;
  const end = addDays(r.week, 6);
  const filtered = () => {
    if (!dispFilter.day || !dispFilter.slot) return '';
    const date = dispFilter.day; const [s, en] = DEF(date, dispFilter.slot);
    const g = { full: [], partial: [], none: [], no: [] };
    for (const w of r.workers) { const e = r.days.find(d => d.date === date).cells[w.id]; g[avCoverage(e, date, s, en)].push(w.name + (e && e.kind !== 'all' ? ` (${avDesc(e)})` : '')); }
    return `<div class="card"><b>${t('dow_full_' + dow(date))} ${ddmm(date)}, ${slotName(dispFilter.slot)}:</b>
      ${['full', 'partial', 'none', 'no'].map(k => `<div class="small"><span class="pill av-${k === 'full' ? 'full' : k === 'partial' ? 'part' : k}">${t('av_g_' + k)}</span> ${g[k].map(esc).join(', ') || '—'}</div>`).join('')}</div>`;
  };
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h1>${t('nav_disposition')}: ${ddmm(r.week)} – ${ddmm(end)}</h1>
      <div class="row"><button id="dw1">‹</button><button id="dw0">${t('next_week')}</button><button id="dw2">›</button></div></div>
    <div class="card"><div class="row"><span>${t('av_deadline')}:</span><select id="ddow">${[0, 1, 2, 3, 4, 5, 6].map(i => `<option value="${i}" ${cfg.dow === i ? 'selected' : ''}>${t('dow_full_' + i)}</option>`).join('')}</select>
      <input type="time" id="dtime" value="${cfg.time}"><button id="dsave" class="sm">${t('save')}</button>
      <span class="small mute">${t('av_deadline_for_week', { d: dlText(r.deadline) })} · ${r.open ? t('av_open') : t('av_closed')}</span></div></div>
    <div class="row" style="margin-bottom:8px"><span>${t('av_filter')}:</span><select id="fday"><option value="">— ${t('day')} —</option>${r.days.map(d => `<option value="${d.date}" ${dispFilter.day === d.date ? 'selected' : ''}>${t('dow_full_' + d.dow)} ${ddmm(d.date)}</option>`).join('')}</select>
      <select id="fslot"><option value="">— ${t('c_slot')} —</option>${['s1', 's2', 'rs'].map(sl => `<option value="${sl}" ${dispFilter.slot === sl ? 'selected' : ''}>${slotName(sl)}</option>`).join('')}</select>
      <span class="small"><span class="pill av-full">${t('av_all')}</span> <span class="pill av-part">${t('av_partial')}</span> <span class="pill av-no">${t('av_no')}</span> <span class="pill av-none">${t('av_none')}</span></span></div>
    <div id="fout">${filtered()}</div>
    <div class="tbl-wrap"><table class="t avtable"><thead><tr><th>${t('day')}</th>${r.workers.map(w => `<th>${esc(w.name)}<div class="row" style="gap:4px;margin-top:4px"><button class="sm" data-copy="${w.id}" title="${t('av_copy_prev')}">⧉</button><button class="sm" data-fill="${w.id}" title="${t('av_fill_week')}">▤</button></div></th>`).join('')}</tr></thead><tbody>
    ${r.days.map(d => `<tr class="${d.dow === 6 ? 'sun' : ''}"><td style="white-space:nowrap"><b>${t('dow_' + d.dow)}</b> ${ddmm(d.date)}</td>${r.workers.map(w => { const e = d.cells[w.id]; return `<td class="${avClass(e)} avcell" data-u="${w.id}" data-d="${d.date}" title="${e ? esc((e.comment || '') + ' — ' + e.updated_name) : ''}">${esc(avDesc(e))}${e && e.comment ? ' 💬' : ''}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div><p class="small mute">${t('av_admin_help')}</p>`;
  const go = w => { dispWeek = w; pageDisposition(el); };
  $('#dw1', el).onclick = () => go(addDays(dispWeek, -7)); $('#dw2', el).onclick = () => go(addDays(dispWeek, 7)); $('#dw0', el).onclick = () => go(null);
  $('#dsave', el).onclick = async () => { try { await api('PUT', '/api/avail/settings', { dow: Number($('#ddow', el).value), time: $('#dtime', el).value }); toast(t('saved')); pageDisposition(el); } catch (e) { toast(e.message); } };
  $('#fday', el).onchange = e => { dispFilter.day = e.target.value; $('#fout', el).innerHTML = filtered(); };
  $('#fslot', el).onchange = e => { dispFilter.slot = e.target.value; $('#fout', el).innerHTML = filtered(); };
  const wname = id => (r.workers.find(w => w.id === Number(id)) || {}).name;
  $$('.avcell', el).forEach(td => td.onclick = () => {
    const date = td.dataset.d, uid = td.dataset.u; const e = r.days.find(d => d.date === date).cells[uid];
    const b = modal(`<h2>${esc(wname(uid))}: ${t('dow_full_' + dow(date))} ${ddmm(date)}</h2>${e ? `<p class="small mute">${t('av_changed_by')}: ${esc(e.updated_name)}, ${lts(e.updated_at)}</p>` : ''}<div id="ed"></div><div id="eerr"></div>
      <div class="row end" style="margin-top:10px">${e ? `<button class="danger" id="eclr">${t('av_clear')}</button>` : ''}<button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="eok">${t('save')}</button></div>`);
    const get = availEditor($('#ed', b), e);
    $('#eok', b).onclick = async () => { const v = get(); if (!v) return; try { await api('PUT', `/api/avail/user/${uid}`, { date, ...v }); closeModal(); toast(t('saved')); pageDisposition(el); } catch (er) { $('#eerr', b).innerHTML = errBox(er); } };
    if ($('#eclr', b)) $('#eclr', b).onclick = async () => { await api('PUT', `/api/avail/user/${uid}`, { date, clear: true }); closeModal(); pageDisposition(el); };
  });
  $$('[data-copy]', el).forEach(btn => btn.onclick = async () => { if (!confirm(t('av_copy_q', { name: wname(btn.dataset.copy) }))) return; try { await api('POST', `/api/avail/user/${btn.dataset.copy}/copy`, { week: dispWeek }); toast(t('saved')); pageDisposition(el); } catch (e) { toast(e.message); } });
  $$('[data-fill]', el).forEach(btn => btn.onclick = () => {
    const b = modal(`<h2>${t('av_fill_week')}: ${esc(wname(btn.dataset.fill))}</h2><p class="small mute">${ddmm(dispWeek)} – ${ddmm(end)}</p><div id="fed"></div><div id="ferr"></div>
      <div class="row end" style="margin-top:10px"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="fok">${t('save')}</button></div>`);
    const get = availEditor($('#fed', b), null);
    $('#fok', b).onclick = async () => { const v = get(); if (!v) return; try { await api('POST', `/api/avail/user/${btn.dataset.fill}/fill`, { week: dispWeek, ...v }); closeModal(); toast(t('saved')); pageDisposition(el); } catch (e) { $('#ferr', b).innerHTML = errBox(e); } };
  });
}

// ---------------- ЗАВДАННЯ ВІД АДМІНІСТРАТОРА ----------------
const tkStatus = x => x.status === 'done' ? `<span class="pill approved">✓ ${t('tk_done')}</span>` : x.status === 'failed' ? `<span class="pill rejected">✕ ${t('tk_failed')}</span>` : `<span class="pill pending">${t('tk_pending')}</span>`;
/** Блок на головному екрані працівника. */
async function myTasksBlock(box) {
  const list = await api('GET', `/api/tasks/my?loc=${S.loc}`);
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card" style="border-color:var(--blue)"><h2 style="margin-top:0">📋 ${t('tasks_from_admin')}</h2>${list.map(x => `<div class="taskitem" data-id="${x.id}" style="border-left:3px solid var(--blue);padding-left:10px;margin:10px 0">
      <div class="row"><b class="grow">${esc(x.text)}</b>${tkStatus(x)}</div>
      <div class="small mute">${esc(x.target_label)}${x.due ? ' · ' + t('tk_until', { t: x.due }) : ''} · ${esc(x.created_name)}</div>
      ${x.status === 'pending' ? `<input class="tkc" maxlength="300" placeholder="${t('tk_comment_ph')}" style="width:100%;margin-top:6px">
        <div class="row" style="margin-top:6px"><button class="pri sm tkok">✓ ${t('tk_mark_done')}</button><button class="danger sm tkno">✕ ${t('tk_mark_failed')}</button></div><div class="tkerr"></div>`
        : `<div class="small">${esc(x.done_name)}, ${lts(x.done_at)}${x.result_comment ? ' — ' + esc(x.result_comment) : ''}</div>`}</div>`).join('')}</div>`;
  $$('.taskitem', box).forEach(it => {
    const send = async done => {
      try { await api('POST', `/api/tasks/${it.dataset.id}/result`, { done, comment: $('.tkc', it).value }); toast(t('saved')); myTasksBlock(box); }
      catch (e) { $('.tkerr', it).innerHTML = errBox(e); }
    };
    if ($('.tkok', it)) { $('.tkok', it).onclick = () => send(true); $('.tkno', it).onclick = () => send(false); }
  });
}
function taskModal(task, done) {
  const x = task || { location_id: S.loc, date: today(), target: 'slot', slot: 's1', text: '', due: '' };
  const b = modal(`<h2>${task ? t('tk_edit') : t('tk_new')}</h2>
    <label class="f"><span>${t('c_location')}</span><select id="tl">${S.me.locations.map(l => `<option value="${l.id}" ${l.id === x.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
    <label class="f"><span>${t('date')}</span><input type="date" id="td" value="${x.date}"></label>
    <div class="f"><span class="mute small">${t('tk_for')}</span><div class="seg" id="tt" style="margin-top:4px">${['slot', 'user', 'all'].map(k => `<button type="button" data-k="${k}" class="${x.target === k ? 'on' : ''}">${t('tk_target_' + k)}</button>`).join('')}</div></div>
    <label class="f" id="tsl"><span>${t('c_slot')}</span><select id="ts">${['s1', 's2', 'rs', 'dl'].map(sl => `<option value="${sl}" ${x.slot === sl ? 'selected' : ''}>${slotName(sl)}</option>`).join('')}</select></label>
    <label class="f" id="tul"><span>${t('worker')}</span><select id="tu"></select></label>
    <label class="f"><span>${t('tk_text')}</span><textarea id="tx" maxlength="500" placeholder="${t('tk_text_ph')}">${esc(x.text)}</textarea></label>
    <label class="f"><span>${t('tk_due_opt')}</span><input type="time" id="tdue" value="${x.due || ''}"></label>
    <p class="small mute">${t('tk_help')}</p><div id="terr"></div>
    <div class="row end"><button onclick="closeModal()">${t('cancel')}</button><button class="pri" id="tok">${t('save')}</button></div>`);
  let target = x.target;
  const loadWorkers = async () => { const ws = await api('GET', `/api/locations/${$('#tl', b).value}/workers`); $('#tu', b).innerHTML = ws.map(w => `<option value="${w.id}" ${w.id === x.user_id ? 'selected' : ''}>${esc(w.name)}</option>`).join(''); };
  const sync = () => { $$('#tt button', b).forEach(bb => bb.classList.toggle('on', bb.dataset.k === target)); $('#tsl', b).style.display = target === 'slot' ? '' : 'none'; $('#tul', b).style.display = target === 'user' ? '' : 'none'; };
  $$('#tt button', b).forEach(bb => bb.onclick = () => { target = bb.dataset.k; sync(); });
  $('#tl', b).onchange = loadWorkers; loadWorkers(); sync();
  $('#tok', b).onclick = async () => {
    const body = { location_id: Number($('#tl', b).value), date: $('#td', b).value, target, slot: $('#ts', b).value, user_id: Number($('#tu', b).value), text: $('#tx', b).value, due: $('#tdue', b).value || null };
    try { if (task) await api('PUT', `/api/tasks/${task.id}`, body); else await api('POST', '/api/tasks', body); closeModal(); toast(t('saved')); done && done(); }
    catch (e) { $('#terr', b).innerHTML = errBox(e); }
  };
}
const TF = { loc: null, from: null, to: null, user: '', status: '' };
async function pageTasks(el) {
  if (TF.loc === null) TF.loc = String(S.loc);
  if (!TF.from) { TF.from = addDays(today(), -7); TF.to = addDays(today(), 14); }
  const qs = `loc=${TF.loc}&from=${TF.from}&to=${TF.to}${TF.user ? '&user=' + TF.user : ''}${TF.status && TF.status !== 'overdue' ? '&status=' + TF.status : ''}${TF.status === 'overdue' ? '&overdue=1' : ''}`;
  const list = await api('GET', `/api/tasks?${qs}`);
  const users = await api('GET', '/api/users');
  el.innerHTML = `<div class="row"><h1 class="grow">${t('nav_tasks')}</h1><button class="pri" id="tnew">+ ${t('tk_new')}</button></div>
    <div class="card"><div class="row">
      <select id="fl"><option value="all">${t('all_locations')}</option>${S.me.locations.map(l => `<option value="${l.id}" ${String(l.id) === TF.loc ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
      <input type="date" id="ff" value="${TF.from}"> – <input type="date" id="ft" value="${TF.to}">
      <select id="fu"><option value="">${t('all_workers')}</option>${users.filter(u => u.active).map(u => `<option value="${u.id}" ${String(u.id) === TF.user ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
      <select id="fs"><option value="">${t('tk_all_status')}</option>${['pending', 'done', 'failed', 'overdue'].map(s => `<option value="${s}" ${TF.status === s ? 'selected' : ''}>${t('tk_' + s)}</option>`).join('')}</select>
    </div></div>
    <div class="card list">${list.map(x => `<div class="item"><div class="grow">
        <div class="row">${x.overdue ? '<span class="excl" title="' + t('tk_overdue') + '">!</span>' : ''}<b class="grow ${x.overdue ? 'red' : ''}">${esc(x.text)}</b>${tkStatus(x)}</div>
        <div class="small">${ddmm(x.date)} ${t('dow_' + dow(x.date))} · ${esc(x.location)} · ${esc(x.target_label)}${x.recipients.length && x.target !== 'user' ? ' → ' + x.recipients.map(r => esc(r.name)).join(', ') : ''}${x.due ? ' · ' + t('tk_until', { t: x.due }) : ''}</div>
        ${x.status !== 'pending' ? `<div class="small">${x.status === 'done' ? '✓' : '✕'} ${esc(x.done_name)}, ${lts(x.done_at)}${x.result_comment ? ' — 💬 ' + esc(x.result_comment) : ''}</div>` : ''}
        ${x.overdue ? `<div class="small red">! ${t('tk_overdue')}</div>` : ''}
        <div class="small mute">${t('tk_created')}: ${esc(x.created_name)}, ${lts(x.created_at)}${x.updated_by ? ` · ${t('tk_edited')}: ${esc(x.updated_name)}, ${lts(x.updated_at)}` : ''}</div></div>
      ${x.status === 'pending' ? `<div class="row" style="flex-direction:column;gap:4px"><button class="sm" data-edit="${x.id}">✎</button><button class="sm danger" data-del="${x.id}">✕</button></div>` : ''}</div>`).join('') || `<p class="mute">${t('no_data')}</p>`}</div>`;
  const reload = () => pageTasks(el);
  $('#tnew', el).onclick = () => taskModal(null, reload);
  $('#fl', el).onchange = e => { TF.loc = e.target.value; reload(); };
  $('#ff', el).onchange = e => { TF.from = e.target.value; reload(); };
  $('#ft', el).onchange = e => { TF.to = e.target.value; reload(); };
  $('#fu', el).onchange = e => { TF.user = e.target.value; reload(); };
  $('#fs', el).onchange = e => { TF.status = e.target.value; reload(); };
  $$('[data-edit]', el).forEach(btn => btn.onclick = () => { const x = list.find(y => y.id === Number(btn.dataset.edit)); taskModal({ ...x }, reload); });
  $$('[data-del]', el).forEach(btn => btn.onclick = async () => { if (!confirm(t('delete_q'))) return; try { await api('DELETE', `/api/tasks/${btn.dataset.del}`); reload(); } catch (e) { toast(e.message); } });
}

// ---------------- TELEGRAM-БОТ (адміністратор) ----------------
async function tgAdminCard(box) {
  const st = await api('GET', '/api/tg/status');
  const ok = st.ok;
  box.innerHTML = `<h2 style="margin-top:0">🤖 ${t('tg_bot_title')}</h2>
    ${ok ? `<div class="okbox">✅ ${t('tg_bot_ok', { bot: '@' + esc(st.username) })} · ${t('tg_mode_' + st.mode)}${st.mode === 'webhook' ? (st.webhook && st.webhook.active ? ' ✅' : ' <span class="red">' + t('tg_webhook_inactive') + '</span>') : ''}</div>`
      : `<div class="warnbox"><span class="excl">!</span>${t('tg_not_configured_admin')}${st.error && st.error !== 'not_configured' ? ' — ' + t('tg_err_' + st.error) : ''}</div>`}
    ${st.webhook && st.webhook.last_error ? `<p class="small red">${t('tg_last_error')}: ${esc(st.webhook.last_error)}</p>` : ''}
    ${st.source === 'env' ? `<p class="small mute">${t('tg_token_env')}</p>` : `<label class="f"><span>${ok ? t('tg_token_replace') : t('tg_token_label')}</span><input type="password" id="tgtok" autocomplete="off" placeholder="123456789:AA…"></label>
      <div class="row"><button class="pri" id="tgsave">${t('save')}</button>${st.source === 'app' ? `<button class="danger sm" id="tgdel">${t('tg_token_remove')}</button>` : ''}</div><p class="small mute">${t('tg_token_help')}</p>`}
    <div class="row" style="margin-top:10px"><button id="tgtest" ${ok ? '' : 'disabled'}>📨 ${t('tg_send_test')}</button><button class="sm" id="tgcheck">↻ ${t('tg_check')}</button></div><div id="tgres"></div>`;
  const res = $('#tgres', box);
  const after = async () => { await refreshMe(); tgAdminCard(box); };
  if ($('#tgsave', box)) $('#tgsave', box).onclick = async () => { try { await api('POST', '/api/tg/token', { token: $('#tgtok', box).value }); toast(t('saved')); after(); } catch (e) { res.innerHTML = errBox(e); } };
  if ($('#tgdel', box)) $('#tgdel', box).onclick = async () => { if (!confirm(t('delete_q'))) return; await api('POST', '/api/tg/token', { remove: true }); after(); };
  $('#tgcheck', box).onclick = async () => { await api('POST', '/api/tg/check'); after(); };
  $('#tgtest', box).onclick = async () => { try { const r = await api('POST', '/api/tg/test'); res.innerHTML = `<div class="okbox">✅ ${t('tg_test_sent', { time: lts(r.delivered_at.replace('T', ' ').slice(0, 19)) })}</div>`; } catch (e) { res.innerHTML = errBox(e); } };
}

// ---------------- УРЛОП ----------------
const vacStatus = v => `<span class="pill ${v.status}">${t('vac_st_' + v.status)}</span>`;
const vacRange = v => v.start === v.end ? ddmm(v.start) + '.' + v.start.slice(0, 4) : `${ddmm(v.start)} – ${ddmm(v.end)}.${v.end.slice(0, 4)}`;
const VS = { from: '', to: '', months: 0, picking: null };
async function pageVacation(el) {
  const r = await api('GET', `/api/vacations?loc=${S.loc}`);
  const admin = isOwner();
  const me = S.me.user.id;
  // хто у відпустці в кожен день (очікує / підтверджено)
  const onDay = d => r.list.filter(v => v.start <= d && v.end >= d);
  const dayState = d => {
    const on = onDay(d); const others = on.filter(v => v.user_id !== me);
    if (d < r.today) return { cls: 'vd-past', on };
    if (on.some(v => v.user_id === me)) return { cls: 'vd-mine', on };
    if (others.length >= r.max) return { cls: others.some(v => v.status === 'approved') ? 'vd-busy' : 'vd-pend', on };
    return { cls: 'vd-free', on };
  };
  const month0 = r.today.slice(0, 7);
  const monthAdd = (m, n) => { const [y, mo] = m.split('-').map(Number); return fd(new Date(Date.UTC(y, mo - 1 + n, 1))).slice(0, 7); };
  const calMonth = m => {
    const [first, last] = monthRange(m); const pad = dow(first);
    let cells = '';
    for (let i = 0; i < pad; i++) cells += '<div></div>';
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const st = dayState(d);
      const sel = VS.from && d >= VS.from && d <= (VS.to || VS.from);
      const tip = st.on.map(v => `${v.name}: ${vacRange(v)} (${t('vac_st_' + v.status)})`).join('\n');
      cells += `<button type="button" class="vday ${st.cls} ${sel ? 'vd-sel' : ''}" data-d="${d}" title="${esc(tip)}" ${st.cls === 'vd-past' ? 'disabled' : ''}><b>${+d.slice(8)}</b>${st.on.length ? `<span>${esc(st.on.map(v => v.name.split(' ')[0]).join(', '))}</span>` : ''}</button>`;
    }
    const nm = new Date(first + 'T00:00:00Z').toLocaleDateString(S.lang === 'pl' ? 'pl-PL' : 'uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `<div class="vmonth"><div class="vmname">${esc(nm.charAt(0).toUpperCase() + nm.slice(1))}</div><div class="vgrid">${[0, 1, 2, 3, 4, 5, 6].map(i => `<div class="vdow">${t('dow_' + i)}</div>`).join('')}${cells}</div></div>`;
  };
  const upcoming = r.list.filter(v => v.end >= r.today).sort((a, b) => a.start.localeCompare(b.start));
  el.innerHTML = `<h1>${t('nav_vacation')}</h1>
    ${admin && r.pending.length ? `<div class="card" style="border-color:var(--red)"><h2 style="margin-top:0">${t('vac_pending_title')} (${r.pending.length})</h2><div class="list">${r.pending.map(v => `<div class="item" data-id="${v.id}"><div class="grow">
        <b>${esc(v.name)}</b> — ${vacRange(v)} <span class="mute">(${t('vac_days', { n: v.days })}, ${esc(v.locations)})</span>${v.comment ? `<br>💬 ${esc(v.comment)}` : ''}<br><span class="small mute">${t('c_created')}: ${lts(v.created_at)}</span>
        <div class="row" style="margin-top:6px"><input class="dc grow" placeholder="${t('decision_comment_opt')}"><button class="pri sm" data-ok="${v.id}">✓ ${t('approve')}</button><button class="danger sm" data-no="${v.id}">✕ ${t('reject')}</button></div><div class="derr"></div></div></div>`).join('')}</div></div>` : ''}
    <div class="card"><h2 style="margin-top:0">${admin ? t('vac_new_admin') : t('vac_new')}</h2>
      <p class="small mute">${t('vac_help', { max: r.max })}</p>
      ${admin ? `<label class="f"><span>${t('worker')}</span><select id="vu">${r.workers.map(w => `<option value="${w.id}" ${w.id === me ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>` : ''}
      <div class="row"><label class="f grow"><span>${t('vac_from')}</span><input type="date" id="vf" min="${admin ? '' : r.today}" value="${VS.from}"></label><label class="f grow"><span>${t('vac_to')}</span><input type="date" id="vt" min="${admin ? '' : r.today}" value="${VS.to}"></label></div>
      <div id="vcheck"></div>
      <label class="f"><span>${t('comment_opt')}</span><input id="vc" maxlength="300" style="width:100%"></label>
      ${admin ? `<label class="f"><input type="checkbox" id="vapp" checked> ${t('vac_add_approved')}</label><label class="f"><input type="checkbox" id="vforce"> ${t('vac_force')}</label>` : ''}
      <div id="verr"></div><button class="pri" id="vsend">${admin ? t('save') : t('send_request')}</button></div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">${t('vac_calendar')} · ${t('all_locations')}</h2><button class="sm" id="vprev">‹</button><button class="sm" id="vnext">›</button></div>
      <div class="row small" style="margin:8px 0"><span class="vleg vd-free">${t('vac_leg_free')}</span><span class="vleg vd-busy">${t('vac_leg_busy')}</span><span class="vleg vd-pend">${t('vac_leg_pend')}</span><span class="vleg vd-mine">${t('vac_leg_mine')}</span></div>
      <div class="vcal">${[0, 1, 2].map(i => calMonth(monthAdd(month0, VS.months + i))).join('')}</div>
      <p class="small mute">${t('vac_cal_help')}</p></div>
    <div class="card"><h2 style="margin-top:0">${t('vac_list_title')}</h2>${upcoming.length ? `<div class="list">${upcoming.map(v => `<div class="item"><div class="grow"><b>${esc(v.name)}</b> <span class="small mute">${esc(v.location || '')}</span> — ${vacRange(v)} <span class="mute">(${t('vac_days', { n: v.days })})</span> ${vacStatus(v)}${v.comment ? `<br><span class="small">💬 ${esc(v.comment)}</span>` : ''}</div>
        ${(admin || (v.mine && v.status === 'pending')) ? `<button class="sm danger" data-cancel="${v.id}">${v.mine && !admin ? t('withdraw') : t('vac_cancel')}</button>` : ''}</div>`).join('')}</div>` : `<p class="mute">${t('vac_none_planned')}</p>`}</div>
    <div class="card"><h2 style="margin-top:0">${t('vac_my_title')}</h2>${r.mine.length ? `<div class="list">${r.mine.map(v => `<div class="item"><div class="grow">${vacRange(v)} <span class="mute">(${t('vac_days', { n: v.days })})</span> ${vacStatus(v)}${v.decided_name && v.status !== 'pending' ? `<br><span class="small mute">${esc(v.decided_name)} ${lts(v.decided_at)}${v.decision_comment ? ' — ' + esc(v.decision_comment) : ''}</span>` : ''}</div>
        ${v.status === 'pending' ? `<button class="sm" data-cancel="${v.id}">${t('withdraw')}</button>` : ''}</div>`).join('')}</div>` : `<p class="mute">${t('no_data')}</p>`}</div>
    ${admin ? `<div class="card"><div class="row"><span>${t('vac_max_label')}</span><input type="number" id="vmax" min="1" max="10" value="${r.max}" style="width:80px"><button class="sm" id="vmaxs">${t('save')}</button></div></div>` : ''}`;
  const reload = () => pageVacation(el);
  // живa перевірка вибраних дат
  const check = async () => {
    VS.from = $('#vf', el).value; VS.to = $('#vt', el).value;
    const box = $('#vcheck', el); const btn = $('#vsend', el);
    $$('.vday', el).forEach(b => b.classList.toggle('vd-sel', !!VS.from && b.dataset.d >= VS.from && b.dataset.d <= (VS.to || VS.from)));
    if (!VS.from || !VS.to) { box.innerHTML = ''; btn.disabled = false; return; }
    const c = await api('GET', `/api/vacations/check?start=${VS.from}&end=${VS.to}${admin && $('#vu', el) ? '&user=' + $('#vu', el).value : ''}`);
    if (c.error) { box.innerHTML = `<div class="warnbox">${esc(c.error)}</div>`; btn.disabled = true; return; }
    box.innerHTML = c.ok ? `<div class="okbox">✅ ${t('vac_free_ok', { n: c.days })}</div>` : `<div class="warnbox"><span class="excl">!</span>${esc(c.text)}</div>`;
    btn.disabled = !c.ok && !(admin && $('#vforce', el).checked);
  };
  $('#vf', el).onchange = () => { VS.picking = null; if ($('#vt', el).value < $('#vf', el).value) $('#vt', el).value = $('#vf', el).value; check(); };
  $('#vt', el).onchange = check;
  if ($('#vu', el)) $('#vu', el).onchange = check;
  if ($('#vforce', el)) $('#vforce', el).onchange = check;
  // вибір дат кліком у календарі: перший клік — початок, другий — кінець
  $$('.vday', el).forEach(b => b.onclick = () => {
    const d = b.dataset.d;
    if (!VS.picking || d < VS.picking) { $('#vf', el).value = d; $('#vt', el).value = d; VS.picking = d; }
    else { $('#vt', el).value = d; VS.picking = null; }
    check();
  });
  $('#vprev', el).onclick = () => { VS.months -= 1; reload(); };
  $('#vnext', el).onclick = () => { VS.months += 1; reload(); };
  $('#vsend', el).onclick = async () => {
    const body = { start: $('#vf', el).value, end: $('#vt', el).value, comment: $('#vc', el).value };
    if (admin) Object.assign(body, { user_id: Number($('#vu', el).value), approve: $('#vapp', el).checked, force: $('#vforce', el).checked });
    try { await api('POST', '/api/vacations', body); toast(admin && body.approve ? t('saved') : t('request_sent')); VS.from = VS.to = ''; reload(); }
    catch (e) { $('#verr', el).innerHTML = errBox(e); }
  };
  $$('[data-ok],[data-no]', el).forEach(b => b.onclick = async () => {
    const item = b.closest('.item');
    try { await api('POST', `/api/vacations/${b.dataset.ok || b.dataset.no}/decide`, { approve: !!b.dataset.ok, comment: $('.dc', item).value }); toast(t('saved')); reload(); }
    catch (e) { $('.derr', item).innerHTML = errBox(e); }
  });
  $$('[data-cancel]', el).forEach(b => b.onclick = async () => { if (!confirm(t('vac_cancel_q'))) return; try { await api('POST', `/api/vacations/${b.dataset.cancel}/cancel`); reload(); } catch (e) { toast(e.message); } });
  if ($('#vmaxs', el)) $('#vmaxs', el).onclick = async () => { try { await api('PUT', '/api/vacations/settings', { max: Number($('#vmax', el).value) }); toast(t('saved')); reload(); } catch (e) { toast(e.message); } };
  if (VS.from && VS.to) check();
}

window.closeModal = closeModal;
boot();
