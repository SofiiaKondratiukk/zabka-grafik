'use strict';
/*
 * Telegram-бот: токен, webhook / long polling, прив'язка користувачів, опис бота, тестове повідомлення.
 * Токен береться зі змінної середовища TELEGRAM_BOT_TOKEN (.env локально / Variables на хостингу)
 * або з налаштувань програми (адміністратор вставляє його в «Налаштуваннях»). Токен ніколи не логується.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { get, run, setting } = require('./db');

// .env (лише локально; файл у .gitignore)
(function loadDotEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const DEFAULT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'zabka_nds_bot';
const DESCRIPTION = 'Графік, завдання та сповіщення для працівників Żabka (Nadwiślańska 11, Dietla 68, Stradomska 18)';
const MSG_LINKED = 'Telegram підключено ✅';
const MSG_NO_CODE = 'Щоб отримувати сповіщення, зайдіть у програму → Профіль → Підключити Telegram';
const WEBHOOK_PATH = '/tg/webhook';

const state = { ok: false, username: null, mode: 'off', error: null, webhook: null, checkedAt: null };
let generation = 0; // зупиняє старий цикл polling після переналаштування

const token = () => (process.env.TELEGRAM_BOT_TOKEN || setting('tg_token') || '').trim();
const tokenSource = () => process.env.TELEGRAM_BOT_TOKEN ? 'env' : (setting('tg_token') ? 'app' : null);
const secretFor = tk => crypto.createHash('sha256').update('zabka:' + tk).digest('hex').slice(0, 48);

async function call(method, body, tk = token()) {
  if (!tk) return { ok: false, description: 'no token' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${tk}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) {
    console.error(`telegram ${method}: network error`); // без URL — у ньому токен
    return { ok: false, description: 'network error' };
  }
}

function publicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  return setting('public_url') || null; // запам'ятовується з першого HTTPS-запиту адміністратора
}
/** Запам'ятати публічну HTTPS-адресу з запиту (якщо хостинг її не передає). */
function rememberUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0];
  if (proto === 'https' && host && !/^(localhost|127\.|0\.0\.0\.0)/.test(host) && setting('public_url') !== 'https://' + host) {
    setting('public_url', 'https://' + host);
    if (state.ok && state.mode !== 'webhook') init();
  }
}

async function handleUpdate(upd) {
  const m = upd && upd.message;
  if (!m || !m.text || !m.chat) return;
  const code = (/^\/start(?:@\w+)?\s+(\S+)/.exec(m.text) || [])[1];
  if (code) {
    const u = get('SELECT * FROM users WHERE tg_code=? AND active=1', code);
    if (u) {
      run('UPDATE users SET tg_chat_id=NULL WHERE tg_chat_id=? AND id<>?', String(m.chat.id), u.id); // один чат — один користувач
      run('UPDATE users SET tg_chat_id=?, tg_code=NULL WHERE id=?', String(m.chat.id), u.id);
      await call('sendMessage', { chat_id: m.chat.id, text: `${MSG_LINKED}\n${u.name}` });
      return;
    }
    await call('sendMessage', { chat_id: m.chat.id, text: '❌ Код недійсний або вже використаний. ' + MSG_NO_CODE });
    return;
  }
  await call('sendMessage', { chat_id: m.chat.id, text: MSG_NO_CODE });
}

async function pollLoop(gen, offset) {
  if (gen !== generation) return;
  const r = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
  if (gen !== generation) return;
  if (r && r.ok) for (const upd of r.result) { offset = upd.update_id + 1; setting('tg_offset', offset); try { await handleUpdate(upd); } catch (_) {} }
  setTimeout(() => pollLoop(gen, offset), r && r.ok ? 300 : 5000);
}

/** Перевірка й підключення бота. Викликається під час запуску, після зміни токена і періодично. */
async function init() {
  const gen = ++generation;
  const tk = token();
  state.checkedAt = new Date().toISOString();
  if (!tk) { Object.assign(state, { ok: false, username: null, mode: 'off', error: 'not_configured', webhook: null }); console.log('Telegram: не налаштований'); return state; }
  const me = await call('getMe', {}, tk);
  if (gen !== generation) return state;
  if (!me.ok) {
    const net = me.description === 'network error';
    Object.assign(state, { ok: false, username: null, mode: 'off', error: net ? 'network' : 'invalid_token', webhook: null });
    console.log(net ? 'Telegram: немає зв\'язку, повтор через хвилину' : 'Telegram: токен не працює');
    if (net) setTimeout(() => { if (gen === generation) init(); }, 60 * 1000);
    return state;
  }
  Object.assign(state, { ok: true, username: me.result.username, error: null });
  // опис бота
  await call('setMyDescription', { description: DESCRIPTION }, tk);
  await call('setMyShortDescription', { short_description: DESCRIPTION.slice(0, 120) }, tk);
  const url = publicUrl();
  if (url && url.startsWith('https://')) {
    const target = url + WEBHOOK_PATH;
    const r = await call('setWebhook', { url: target, secret_token: secretFor(tk), allowed_updates: ['message'], drop_pending_updates: false }, tk);
    const info = await call('getWebhookInfo', {}, tk);
    state.mode = r.ok ? 'webhook' : 'error';
    state.webhook = info.ok ? { url: info.result.url, active: info.result.url === target, pending: info.result.pending_update_count, last_error: info.result.last_error_message || null } : null;
    if (!r.ok) state.error = 'webhook';
    console.log(`Telegram: @${state.username}, webhook ${state.webhook && state.webhook.active ? 'активний' : 'НЕ активний'}`);
  } else {
    await call('deleteWebhook', { drop_pending_updates: false }, tk);
    state.mode = 'polling'; state.webhook = null;
    console.log(`Telegram: @${state.username}, long polling`);
    pollLoop(gen, Number(setting('tg_offset') || 0));
  }
  return state;
}

function register(app, h) {
  const { wrap, bad, forbid, L } = h;
  // webhook від Telegram (без входу в програму; перевіряється секретний заголовок)
  app.post(WEBHOOK_PATH, (req, res) => {
    const tk = token();
    if (!tk || req.headers['x-telegram-bot-api-secret-token'] !== secretFor(tk)) return res.status(403).end();
    res.json({ ok: true });
    handleUpdate(req.body).catch(() => {});
  });
  const needAnyAdmin = req => { if (!L.isAdminUser(req.user)) forbid(); };
  app.get('/api/tg/status', wrap(req => { needAnyAdmin(req); rememberUrl(req); return status(); }));
  app.post('/api/tg/check', async (req, res) => { if (!L.isAdminUser(req.user)) return res.status(403).json({ error: 'forbidden' }); rememberUrl(req); await init(); res.json(status()); });
  app.post('/api/tg/token', async (req, res) => {
    try {
      if (!L.isAdminUser(req.user)) return res.status(403).json({ error: 'forbidden' });
      rememberUrl(req);
      const tk = String((req.body || {}).token || '').trim();
      if (req.body && req.body.remove) { setting('tg_token', ''); L.audit(req.user, null, 'tg_token', { action: 'removed' }); await init(); return res.json(status()); }
      if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(tk)) return res.status(400).json({ error: req.t('err_tg_token_format') });
      const me = await call('getMe', {}, tk);
      if (!me.ok) return res.status(400).json({ error: req.t(me.description === 'network error' ? 'err_tg_network' : 'err_tg_token_invalid') });
      setting('tg_token', tk);
      L.audit(req.user, null, 'tg_token', { action: 'saved', bot: '@' + me.result.username }); // без самого токена
      await init();
      res.json(status());
    } catch (e) { res.status(500).json({ error: 'error' }); }
  });
  app.post('/api/tg/test', async (req, res) => {
    try {
      if (!L.isAdminUser(req.user)) return res.status(403).json({ error: 'forbidden' });
      if (!state.ok) return res.status(400).json({ error: req.t('tg_not_configured_admin') });
      const u = get('SELECT * FROM users WHERE id=?', req.user.id);
      if (!u.tg_chat_id) return res.status(400).json({ error: req.t('err_tg_not_linked') });
      const r = await call('sendMessage', { chat_id: u.tg_chat_id, text: req.t('tg_test_message', { name: u.name }) });
      if (!r.ok) return res.status(400).json({ error: req.t('err_tg_send') + (r.description ? ` (${r.description})` : '') });
      res.json({ ok: true, delivered_at: new Date(r.result.date * 1000).toISOString() });
    } catch (e) { res.status(500).json({ error: 'error' }); }
  });
}

function status() {
  return { configured: !!token(), source: tokenSource(), ok: state.ok, username: state.username || DEFAULT_USERNAME, mode: state.mode, error: state.error,
    webhook: state.webhook, checkedAt: state.checkedAt, public_url: publicUrl() };
}
const send = (chatId, text) => state.ok ? call('sendMessage', { chat_id: chatId, text }) : Promise.resolve(null);
const username = () => state.username || DEFAULT_USERNAME;

function start() {
  init();
  setInterval(() => { if (token()) init(); }, 30 * 60 * 1000); // повторна перевірка токена й webhook
}

module.exports = { register, start, init, status, send, username, rememberUrl };
