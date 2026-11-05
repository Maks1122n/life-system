// «Жизнь в порядке» — автономный сервер. Без внешних зависимостей, нужен только Node.js 18+.
// Запуск: APP_PASSWORD=твой_пароль PORT=8090 node server.js
// Данные хранятся в data/data.json (рядом лежат автоматические резервные копии за последние дни).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8090', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.APP_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SEED_FILE = path.join(__dirname, 'seed.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const COLLECTIONS = ['config', 'spheres', 'goals', 'tasks', 'days', 'weeks', 'months', 'notes'];
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_BODY = 512 * 1024;
const STARTED = new Date().toISOString();

if (!PASSWORD || PASSWORD.length < 8 || PASSWORD === 'СМЕНИ_ЭТОТ_ПАРОЛЬ') {
  console.error('Задай пароль не короче 8 символов: APP_PASSWORD=... node server.js');
  process.exit(1);
}

// Секрет для подписи сессий: стабилен между перезапусками, хранится рядом с данными.
fs.mkdirSync(DATA_DIR, { recursive: true });
const SECRET_FILE = path.join(DATA_DIR, '.secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

// ---------- хранилище ----------
let store = {};
let version = 0;
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function isEmpty(d) { return !d || COLLECTIONS.every(c => !d[c] || !Object.keys(d[c]).length); }
function load() {
  // Стартовые данные берутся, только если в сервисе совсем пусто — твои записи никогда не затираются.
  let d = fs.existsSync(DATA_FILE) ? readJson(DATA_FILE) : null;
  let fromSeed = false;
  if (isEmpty(d) && fs.existsSync(SEED_FILE)) { const s = readJson(SEED_FILE); if (!isEmpty(s)) { d = s; fromSeed = true; } }
  store = d || {};
  for (const c of COLLECTIONS) if (!store[c] || typeof store[c] !== 'object') store[c] = {};
  version = Date.now();
  if (fromSeed) { persistNow(); console.log('Загружены стартовые данные'); }
}
let timer = null;
function persist() { clearTimeout(timer); timer = setTimeout(persistNow, 300); }
function persistNow() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA_FILE);
  // одна резервная копия в день, храним 14 последних
  const day = new Date().toISOString().slice(0, 10);
  const bk = path.join(DATA_DIR, `backup-${day}.json`);
  if (!fs.existsSync(bk)) {
    fs.copyFileSync(DATA_FILE, bk);
    const old = fs.readdirSync(DATA_DIR).filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (old.length > 14) fs.unlinkSync(path.join(DATA_DIR, old.shift()));
  }
}
load();

// ---------- сессии ----------
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function makeToken() { const exp = Date.now() + 1000 * 60 * 60 * 24 * 90; const v = `${exp}`; return `${v}.${sign(v)}`; }
function validToken(t) {
  if (!t || typeof t !== 'string') return false;
  const [v, s] = t.split('.');
  if (!v || !s) return false;
  const good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return false;
  return Number(v) > Date.now();
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function authed(req) { return validToken(cookies(req).lp_session); }
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
// простая защита от перебора пароля
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 10;
}

// ---------- http ----------
function send(res, code, body, headers) {
  const isStr = typeof body === 'string';
  res.writeHead(code, Object.assign({
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, headers || {}));
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (tooMany(ip)) return send(res, 429, { error: 'Слишком много попыток. Подожди 15 минут.' });
      const b = await readBody(req);
      if (!safeEqual(b.password || '', PASSWORD)) { attempts.get(ip).push(Date.now()); return send(res, 401, { error: 'Неверный пароль' }); }
      attempts.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `lp_session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}` });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'lp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    // Служебная проверка без входа: только количество записей, без содержимого.
    if (p === '/api/health' && req.method === 'GET') {
      const counts = {}; for (const c of COLLECTIONS) counts[c] = Object.keys(store[c] || {}).length;
      return send(res, 200, { ok: true, started: STARTED, counts, bot: botStatus() });
    }
    if (p.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      if (p === '/api/all' && req.method === 'GET') return send(res, 200, { version, data: store });
      const m = p.match(/^\/api\/doc\/([^/]+)\/([^/]+)$/);
      if (m) {
        const c = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
        if (!COLLECTIONS.includes(c) || !SEG.test(id)) return send(res, 400, { error: 'bad_path' });
        if (req.method === 'PUT') {
          const b = await readBody(req);
          if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'bad_body' });
          store[c][id] = b; version = Date.now(); persist();
          return send(res, 200, { ok: true, version });
        }
        if (req.method === 'DELETE') {
          delete store[c][id]; version = Date.now(); persist();
          return send(res, 200, { ok: true, version });
        }
      }
      return send(res, 404, { error: 'not_found' });
    }
    send(res, 404, 'Not found');
  } catch (e) {
    send(res, e.message === 'too_large' ? 413 : 400, { error: e.message });
  }
});
server.listen(PORT, HOST, () => console.log(`«Жизнь в порядке» работает: http://${HOST}:${PORT}`));

// =====================================================================
// Telegram-бот: текст и голос → ИИ раскладывает по блокам → подтверждение → запись.
// Включается, только если в .env заданы TELEGRAM_BOT_TOKEN и OPENAI_API_KEY.
// ИИ каждый раз получает только наши инструкции и данные этого сервиса:
// запросы к API не хранят память между вызовами и не связаны с другими сервисами.
// =====================================================================
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OAI_KEY = process.env.OPENAI_API_KEY || '';
const OAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODELS = [process.env.OPENAI_MODEL || 'gpt-5.4-mini', 'gpt-4o-mini'];
const TMODELS = [process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe', 'whisper-1'];
const PAIR = process.env.TG_PAIR_CODE || '';
const TZ = process.env.APP_TZ || 'Europe/Moscow';
const BOT_FILE = path.join(DATA_DIR, 'bot.json');
const BOT_ON = !!(TG_TOKEN && OAI_KEY);
let bot = readJson(BOT_FILE) || {};
const pending = new Map();
let botLastError = '';
function saveBot() { try { fs.writeFileSync(BOT_FILE, JSON.stringify(bot), { mode: 0o600 }); } catch (e) { } }
function botStatus() { return { enabled: BOT_ON, paired: !!bot.ownerId, lastError: botLastError ? botLastError.slice(0, 120) : '' }; }

/* время по Москве */
function nowLocal() {
  const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const pad2 = n => String(n).padStart(2, '0');
const dUTC = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDaysS = (k, n) => { const d = dUTC(k); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayS = k => { const d = dUTC(k); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
function weekKeyS(k) { const t = dUTC(k); t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)); const w1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const w = 1 + Math.round(((t - w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7); return `${t.getUTCFullYear()}-W${pad2(w)}`; }
function addMinS(t, m) { const [h, mi] = String(t || '00:00').split(':').map(Number); const v = Math.max(0, Math.min(1439, (h || 0) * 60 + (mi || 0) + m)); return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60); }
const uidS = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const short = (s, n = 80) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const cfgS = () => (store.config && store.config.main) || {};
const fmtV = (v, u) => { const s = Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 }); return u === '$' ? '$' + s : s + (u ? ' ' + u : ''); };

/* сеть */
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
async function oai(pathname, init, timeoutMs = 60000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(OAI_BASE + pathname, Object.assign({ signal: ac.signal }, init, { headers: Object.assign({ Authorization: 'Bearer ' + OAI_KEY }, init.headers || {}) }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status)); e.status = r.status; e.code = j.error && j.error.code; throw e; }
    return j;
  } finally { clearTimeout(t); }
}
const isModelErr = e => e && (e.status === 404 || e.code === 'model_not_found' || /model/i.test(e.message || ''));
const say = (text, extra) => tg('sendMessage', Object.assign({ chat_id: bot.chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }, extra || {}));

/* голос → текст */
async function transcribe(media) {
  const f = await tg('getFile', { file_id: media.file_id });
  const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error('не удалось скачать голосовое');
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = (String(f.file_path).split('.').pop() || 'ogg').toLowerCase();
  let lastErr;
  for (const model of TMODELS) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: media.mime_type || 'audio/ogg' }), 'voice.' + (ext === 'oga' ? 'ogg' : ext));
      fd.append('model', model); fd.append('language', 'ru');
      const j = await oai('/audio/transcriptions', { method: 'POST', body: fd }, 120000);
      return String(j.text || '').trim();
    } catch (e) { lastErr = e; if (!isModelErr(e)) break; }
  }
  throw lastErr;
}

/* что ИИ может записать */
const TYPES = ['note', 'task', 'task_done', 'task_move', 'promise_done', 'promise_skip', 'plan_add', 'plan_shift', 'plan_status', 'goal_value', 'goal_add', 'milestone_done', 'energy', 'review', 'week_review', 'kr_add', 'top_add'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['actions'],
  properties: {
    actions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'label', 'text', 'date', 'time', 'minutes', 'ref_id', 'ref2_id', 'value', 'field', 'scope', 'status'],
        properties: {
          type: { type: 'string', enum: TYPES },
          label: { type: 'string' },
          text: { type: ['string', 'null'] }, date: { type: ['string', 'null'] }, time: { type: ['string', 'null'] },
          minutes: { type: ['integer', 'null'] }, ref_id: { type: ['string', 'null'] }, ref2_id: { type: ['string', 'null'] },
          value: { type: ['number', 'null'] },
          field: { type: ['string', 'null'], enum: ['wins', 'lesson', 'free', 'misses', 'next', null] },
          scope: { type: ['string', 'null'], enum: ['week', 'month', null] },
          status: { type: ['string', 'null'], enum: ['done', 'skip', null] }
        }
      }
    }
  }
};
const SYS = `Ты — помощник личной системы «Жизнь в порядке» Макса. Твоя единственная работа: разобрать его сообщение (текст или расшифровку голосового) и разложить по блокам системы. Ты не даёшь советов и не оцениваешь, только раскладываешь.

Верни JSON {"actions":[...]}. У каждого действия есть поле label: короткое описание по-русски, что будет записано (например «Задача: позвонить юристу, срок завтра»). Неиспользуемые поля ставь null.

Типы действий:
- note: мысль, идея, наблюдение, переживание, всё, что не является конкретным делом. text — исходные слова Макса почти дословно, не сокращай смысл.
- task: новое дело. text — формулировка задачи; date — срок YYYY-MM-DD, если назван (иначе null); ref_id — id цели, если задача явно её двигает.
- task_done: Макс сделал существующую задачу. ref_id — id из open_tasks.
- task_move: перенести существующую задачу. ref_id — id задачи, date — новая дата.
- promise_done: выполнено ежедневное обещание. ref_id — id из promises. date — если речь о другом дне («вчера»).
- promise_skip: обещание сегодня осознанно отпускается. ref_id — id обещания.
- plan_add: новый блок в плане дня. time — HH:MM, text — что делает. date — если не сегодня.
- plan_shift: день пошёл иначе, остаток плана сдвигается. minutes — на сколько (может быть отрицательным).
- plan_status: блок плана сделан или отпущен. ref_id — id блока из plan_today, status — done или skip.
- goal_value: новое общее значение числовой цели («подписчиков уже 300»). ref_id — id цели, value — общее значение.
- goal_add: прибавка к числовой цели («заработал 200$», «+40 подписчиков»). ref_id — id цели, value — прибавка.
- milestone_done: выполнен этап цели. ref_id — id цели, ref2_id — id этапа.
- energy: оценка энергии за день, value от 1 до 5.
- review: вечерний обзор дня. field: wins (что получилось), lesson (что мешало и что меняю), free (всё остальное). text — слова Макса.
- week_review: обзор недели. field: wins, misses (что сорвалось и почему), next (фокус следующей недели). text — слова Макса.
- kr_add: результат недели или месяца. scope — week или month, text — формулировка.
- top_add: одна из главных задач дня. text — формулировка; ref_id — id существующей задачи, если это она.

Правила:
1. Используй только id из контекста. Никогда не выдумывай id. Если не уверен, к чему относится, — сохрани как note.
2. Одно сообщение может дать несколько действий. «Сделал спорт и записал ролик» — два promise_done.
3. Даты считай от now в контексте: «завтра», «в пятницу», «через неделю» → конкретная дата YYYY-MM-DD.
4. Деньги и подписчики: если сказано «заработал/пришло/+», это goal_add; если «сейчас/уже/всего», это goal_value. Валюта должна совпадать с unit цели; рубли в доллары не пересчитывай — сохрани как note.
5. Длинный поток мыслей не дроби на мелкие задачи: сохрани его одним note, а отдельными task — только явные дела.
6. Если сообщение — ответ на вечерний вопрос «как прошёл день», раскладывай в review и promise_done.
7. Пустой список действий не возвращай: в крайнем случае один note с исходным текстом.`;

function buildContext() {
  const n = nowLocal(), c = cfgS(), d = store.days[n.date] || {};
  const plan = Array.isArray(d.plan) ? d.plan : (c.schedule || []).map((b, i) => ({ id: 'b' + i, time: b.time, title: b.title, st: '' }));
  return {
    now: { date: n.date, time: n.hm, weekday: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][n.dow] },
    promises: (c.promises || []).map(p => ({ id: p.id, text: p.text, done_today: !!(d.promises && d.promises[p.id]) })),
    goals: Object.entries(store.goals).map(([id, g]) => ({ id, title: g.title, kind: g.kind, unit: g.unit || null, current: g.current ?? null, target: g.target ?? null, deadline: g.deadline || null, open_milestones: (g.milestones || []).filter(m => !m.done).map(m => ({ id: m.id, title: m.title, date: m.date })) })),
    open_tasks: Object.entries(store.tasks).filter(([, t]) => !t.done).slice(0, 80).map(([id, t]) => ({ id, title: t.title, due: t.due || null, goal: t.goal || null })),
    plan_today: plan.map(b => ({ id: b.id, time: b.time, title: b.title, status: b.st || 'planned' }))
  };
}
async function interpret(text) {
  const messages = [{ role: 'system', content: SYS }, { role: 'user', content: `Контекст (JSON):\n${JSON.stringify(buildContext())}\n\nСообщение Макса:\n${text}` }];
  let lastErr;
  for (const model of MODELS) {
    try {
      const j = await oai('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, response_format: { type: 'json_schema', json_schema: { name: 'life_actions', strict: true, schema: SCHEMA } } }) });
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      const parsed = JSON.parse(content || '{}');
      return Array.isArray(parsed.actions) ? parsed.actions : [];
    } catch (e) { lastErr = e; if (!isModelErr(e)) break; }
  }
  throw lastErr;
}

/* проверка: ссылки только на существующее, иначе — в мысль */
function sanitize(actions, original) {
  const c = cfgS(), n = nowLocal(), d = store.days[n.date] || {};
  const plan = Array.isArray(d.plan) ? d.plan : (c.schedule || []).map((b, i) => ({ id: 'b' + i }));
  const okDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const okTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const hasP = id => (c.promises || []).some(p => p.id === id);
  const out = [];
  for (const a of (actions || []).slice(0, 12)) {
    if (!a || !TYPES.includes(a.type)) continue;
    const g = a.ref_id && store.goals[a.ref_id];
    let ok = true;
    switch (a.type) {
      case 'note': case 'task': case 'kr_add': case 'top_add': ok = !!String(a.text || '').trim(); break;
      case 'task_done': ok = !!store.tasks[a.ref_id]; break;
      case 'task_move': ok = !!store.tasks[a.ref_id] && okDate(a.date); break;
      case 'promise_done': case 'promise_skip': ok = hasP(a.ref_id); break;
      case 'plan_add': ok = okTime(a.time) && !!String(a.text || '').trim(); break;
      case 'plan_shift': ok = Number.isInteger(a.minutes) && a.minutes !== 0 && Math.abs(a.minutes) <= 600; break;
      case 'plan_status': ok = plan.some(b => b.id === a.ref_id) && (a.status === 'done' || a.status === 'skip'); break;
      case 'goal_value': case 'goal_add': ok = !!g && g.kind === 'number' && typeof a.value === 'number' && isFinite(a.value); break;
      case 'milestone_done': ok = !!g && (g.milestones || []).some(m => m.id === a.ref2_id); break;
      case 'energy': ok = typeof a.value === 'number' && a.value >= 1 && a.value <= 5; break;
      case 'review': ok = ['wins', 'lesson', 'free'].includes(a.field) && !!String(a.text || '').trim(); break;
      case 'week_review': ok = ['wins', 'misses', 'next'].includes(a.field) && !!String(a.text || '').trim(); break;
    }
    if (a.date && !okDate(a.date)) a.date = null;
    if (ok) out.push(a);
  }
  if (!out.length) out.push({ type: 'note', text: original, label: 'Мысль: ' + short(original) });
  return out;
}

/* запись в хранилище (со снимком для отмены) */
function reqForS(mode) { return (cfgS().promises || []).filter(p => mode !== 'min' || p.min).map(p => ({ id: p.id, label: mode === 'min' ? p.min : p.text })); }
function applyActions(actions) {
  const snap = {}, done = [], today = nowLocal().date;
  const touch = (c, id) => { const k = c + '/' + id; if (!(k in snap)) snap[k] = store[c][id] === undefined ? null : JSON.parse(JSON.stringify(store[c][id])); };
  const day = date => {
    touch('days', date);
    let d = store.days[date];
    if (!d) { d = { date, mode: 'normal', promises: {}, top: [{ t: '', d: false }, { t: '', d: false }, { t: '', d: false }], energy: null, wins: '', lesson: '' }; store.days[date] = d; }
    d.promises = d.promises || {}; d.top = Array.isArray(d.top) ? d.top : []; while (d.top.length < 3) d.top.push({ t: '', d: false });
    if (date >= today || !d.req) d.req = reqForS(d.mode);
    return d;
  };
  const mat = d => { if (!Array.isArray(d.plan)) d.plan = (cfgS().schedule || []).map((b, i) => ({ id: 'b' + i, time: b.time, title: b.title, st: '' })); };
  for (const a of actions) {
    try {
      const date = a.date || today, txt = String(a.text || '').trim();
      switch (a.type) {
        case 'note': { const id = uidS(); touch('notes', id); store.notes[id] = { text: txt, at: new Date().toISOString(), day: today, to: null, src: 'tg' }; break; }
        case 'task': { const id = uidS(); touch('tasks', id); const g = a.ref_id && store.goals[a.ref_id]; store.tasks[id] = { title: txt, sphere: g ? (g.sphere || null) : null, goal: g ? a.ref_id : null, due: a.date || null, done: false, doneAt: null, created: today }; break; }
        case 'task_done': touch('tasks', a.ref_id); store.tasks[a.ref_id].done = true; store.tasks[a.ref_id].doneAt = today; break;
        case 'task_move': touch('tasks', a.ref_id); store.tasks[a.ref_id].due = a.date; break;
        case 'promise_done': { const d = day(date); d.promises[a.ref_id] = true; if (d.skip) delete d.skip[a.ref_id]; break; }
        case 'promise_skip': { const d = day(date); d.skip = Object.assign({}, d.skip, { [a.ref_id]: true }); delete d.promises[a.ref_id]; break; }
        case 'plan_add': { const d = day(date); mat(d); d.plan.push({ id: uidS(), time: a.time, title: txt, st: '' }); break; }
        case 'plan_shift': { const d = day(today); mat(d); const hm = nowLocal().hm; d.plan.forEach(b => { if (!b.st && b.time > hm) b.time = addMinS(b.time, a.minutes); }); break; }
        case 'plan_status': { const d = day(today); mat(d); const b = d.plan.find(x => x.id === a.ref_id); if (b) b.st = a.status; break; }
        case 'goal_value': case 'goal_add': {
          touch('goals', a.ref_id); const g = store.goals[a.ref_id];
          const v = a.type === 'goal_add' ? (+g.current || 0) + a.value : a.value;
          g.current = Math.round(v * 100) / 100; g.log = [...(g.log || []).filter(l => l.d !== today), { d: today, v: g.current }].sort((x, y) => x.d.localeCompare(y.d));
          a.label = a.label + ` → теперь ${fmtV(g.current, g.unit)}`; break;
        }
        case 'milestone_done': { touch('goals', a.ref_id); const m = store.goals[a.ref_id].milestones.find(x => x.id === a.ref2_id); if (m) m.done = true; break; }
        case 'energy': { const d = day(date); d.energy = Math.round(a.value); break; }
        case 'review': { const d = day(date); d[a.field] = (d[a.field] ? d[a.field] + '\n' : '') + txt; break; }
        case 'week_review': { const wk = weekKeyS(date); touch('weeks', wk); const w = store.weeks[wk] || (store.weeks[wk] = { start: mondayS(date) }); w[a.field] = (w[a.field] ? w[a.field] + '\n' : '') + txt; break; }
        case 'kr_add': {
          const sc = a.scope === 'month' ? 'month' : 'week', key = sc === 'month' ? date.slice(0, 7) : weekKeyS(date), col = sc === 'month' ? 'months' : 'weeks';
          touch(col, key); const o = store[col][key] || (store[col][key] = sc === 'week' ? { start: mondayS(date) } : {}); o.krs = [...(o.krs || []), { id: uidS(), t: txt, d: false }]; break;
        }
        case 'top_add': {
          const d = day(date), t = a.ref_id && store.tasks[a.ref_id];
          const slot = { t: t ? t.title : txt, d: false }; if (t) slot.task = a.ref_id;
          const i = d.top.findIndex(x => !x.task && !String(x.t || '').trim());
          if (i >= 0) d.top[i] = slot; else if (d.top.length < 6) d.top.push(slot); else { const id = uidS(); touch('notes', id); store.notes[id] = { text: 'Главная задача (не влезла в 6): ' + slot.t, at: new Date().toISOString(), day: today, src: 'tg' }; }
          break;
        }
      }
      done.push(a.label);
    } catch (e) { console.error('bot apply', a.type, e.message); }
  }
  version = Date.now(); persist();
  return { snap, done };
}
function restoreSnap(snap) {
  for (const k of Object.keys(snap)) { const i = k.indexOf('/'), c = k.slice(0, i), id = k.slice(i + 1); if (snap[k] === null) delete store[c][id]; else store[c][id] = snap[k]; }
  version = Date.now(); persist();
}

/* сводки */
function todayText() {
  const n = nowLocal(), c = cfgS(), d = store.days[n.date] || {};
  const pr = (c.promises || []).map(p => `${d.skip && d.skip[p.id] ? '↷' : (d.promises && d.promises[p.id] ? '✅' : '▫️')} ${p.text}`).join('\n');
  const top = (d.top || []).filter(t => t.task || String(t.t || '').trim()).map(t => { const tk = t.task && store.tasks[t.task]; return `${(tk ? tk.done : t.d) ? '✅' : '▫️'} ${tk ? tk.title : t.t}`; }).join('\n');
  const plan = (Array.isArray(d.plan) ? d.plan : (c.schedule || [])).filter(b => !b.st && b.time > n.hm).sort((a, b) => a.time.localeCompare(b.time)).slice(0, 3).map(b => `${b.time} ${b.title}`).join('\n');
  const goals = Object.values(store.goals).filter(g => g.kind === 'number').map(g => `${g.title}: ${fmtV(g.current, g.unit)} из ${fmtV(g.target, g.unit)}`).join('\n');
  return `Сегодня, ${n.date.split('-').reverse().join('.')}\n\nОбещания:\n${pr || '—'}\n\nГлавные задачи:\n${top || 'не выбраны'}\n\nДальше по плану:\n${plan || 'на сегодня всё'}\n\nЦифры:\n${goals || '—'}`;
}
function candidates() {
  const n = nowLocal();
  return Object.values(store.tasks).filter(t => !t.done && t.due && t.due <= addDaysS(n.date, 1)).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 5).map(t => `• ${t.title}${t.due < n.date ? ' (просрочено)' : ''}`).join('\n');
}
const HELP = `Пиши или говори как есть — я разложу по блокам и спрошу подтверждение.

Примеры:
• «Завтра позвонить юристу про ИП»
• «Сделал спорт и записал ролик»
• «Созвон затянулся, сдвинь план на час»
• «Заработал 200 долларов» / «Подписчиков уже 260»
• «Идея: продукт 30 дней новой жизни…»

Команды: /today — сводка дня.`;

/* обработка входящих */
async function onMessage(m) {
  const from = m.from && m.from.id, text = String(m.text || m.caption || '').trim();
  if (!bot.ownerId) {
    if (PAIR && text.startsWith('/start') && text.split(/\s+/)[1] === PAIR) { bot.ownerId = from; bot.chatId = m.chat.id; saveBot(); return say('Готово: бот привязан к тебе.\n\n' + HELP); }
    return tg('sendMessage', { chat_id: m.chat.id, text: 'Это личный бот. Чтобы привязать, отправь /start и код с сервера.' });
  }
  if (from !== bot.ownerId) return;
  if (bot.chatId !== m.chat.id) { bot.chatId = m.chat.id; saveBot(); }
  if (/^\/(start|help)\b/.test(text)) return say(HELP);
  if (/^\/today\b/.test(text)) return say(todayText());
  let input = text, voice = false;
  const media = m.voice || m.audio || m.video_note;
  if (media) {
    voice = true; tg('sendChatAction', { chat_id: bot.chatId, action: 'typing' }).catch(() => { });
    try { input = await transcribe(media); } catch (e) { botLastError = 'transcribe: ' + e.message; return say('Не получилось расшифровать голосовое. Попробуй ещё раз или напиши текстом.'); }
    if (!input) return say('В голосовом не разобрал слов. Попробуй ещё раз.');
  }
  if (!input) return say('Пришли текст или голосовое.');
  tg('sendChatAction', { chat_id: bot.chatId, action: 'typing' }).catch(() => { });
  let actions;
  try { actions = sanitize(await interpret(input), input); botLastError = ''; }
  catch (e) {
    botLastError = 'llm: ' + e.message;
    const pid = uidS(); pending.set(pid, { text: input, actions: [{ type: 'note', text: input, label: 'Мысль: ' + short(input) }], at: Date.now() });
    return say(`ИИ сейчас не ответил (${short(e.message, 60)}). Сохранить это как мысль, чтобы не потерялось?`, { reply_markup: { inline_keyboard: [[{ text: '💭 Сохранить мыслью', callback_data: 'note:' + pid }, { text: '✖ Не надо', callback_data: 'no:' + pid }]] } });
  }
  const pid = uidS(); pending.set(pid, { text: input, actions, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 2 * 864e5) pending.delete(k);
  const lines = actions.map((a, i) => `${i + 1}. ${a.label}`).join('\n');
  return say(`${voice ? `🎙 «${short(input, 400)}»\n\n` : ''}Понял так:\n${lines}\n\nЗаписать?`, { reply_markup: { inline_keyboard: [[{ text: '✅ Записать', callback_data: 'ok:' + pid }, { text: '💭 Только мыслью', callback_data: 'note:' + pid }], [{ text: '✖ Отмена', callback_data: 'no:' + pid }]] } });
}
async function onCallback(q) {
  const ans = t => tg('answerCallbackQuery', { callback_query_id: q.id, text: t || '' }).catch(() => { });
  if (!bot.ownerId || q.from.id !== bot.ownerId) return ans('Это личный бот');
  const [kind, pid] = String(q.data || '').split(':');
  const p = pending.get(pid), msg = q.message;
  const edit = (text, kb) => tg('editMessageText', Object.assign({ chat_id: msg.chat.id, message_id: msg.message_id, text: text.slice(0, 4000) }, kb ? { reply_markup: kb } : {})).catch(() => { });
  if (!p) { await ans('Это сообщение устарело'); return edit('Устарело: ничего не записано. Пришли ещё раз.'); }
  if (kind === 'no') { pending.delete(pid); await ans('Отменено'); return edit('✖ Отменено, ничего не записано.'); }
  if (kind === 'ok' || kind === 'note') {
    if (p.applied) return ans('Уже записано');
    const acts = kind === 'note' ? [{ type: 'note', text: p.text, label: 'Мысль: ' + short(p.text) }] : p.actions;
    const r = applyActions(acts); p.applied = r.snap;
    await ans('Записано');
    return edit(`✅ Записано:\n${r.done.map((l, i) => `${i + 1}. ${l}`).join('\n')}`, { inline_keyboard: [[{ text: '↩ Отменить', callback_data: 'undo:' + pid }]] });
  }
  if (kind === 'undo') {
    if (!p.applied) return ans('Нечего отменять');
    restoreSnap(p.applied); pending.delete(pid); await ans('Отменено');
    return edit('↩ Отменено: всё вернул как было.');
  }
  return ans();
}

/* напоминания по Москве */
async function remind(kind) {
  const n = nowLocal(), d = store.days[n.date] || {}, c = cfgS();
  if (kind === 'morning') {
    const cand = candidates();
    return say(`Доброе утро. Какие 3 главные задачи сегодня? Ответь текстом или голосом — я поставлю их в день.${cand ? '\n\nЖдут своей очереди:\n' + cand : ''}`);
  }
  if (kind === 'evening') {
    const pr = (c.promises || []).filter(p => !(d.skip && d.skip[p.id])).map(p => `${d.promises && d.promises[p.id] ? '✅' : '▫️'} ${p.text}`).join('\n');
    return say(`Вечерний обзор. Расскажи голосом, как прошёл день: что получилось, что мешало, энергия от 1 до 5. Без самонаказания — только выводы.\n\nОбещания сейчас:\n${pr || '—'}\n\nЕсли что-то сделал, но не отметил — просто скажи.`);
  }
  if (kind === 'weekly') return say('Воскресенье — обзор недели. Расскажи: что получилось, что сорвалось и почему, какой фокус на следующую неделю. Я запишу в неделю.');
}
function tick() {
  if (!bot.chatId) return;
  const n = nowLocal(); bot.sent = bot.sent || {};
  const fire = (key, cond) => { if (cond && bot.sent[key] !== n.date) { bot.sent[key] = n.date; saveBot(); remind(key).catch(e => { botLastError = 'remind: ' + e.message; }); } };
  fire('morning', n.hm >= '08:45' && n.hm < '11:00');
  fire('evening', n.hm >= '22:00' && n.hm <= '23:59');
  fire('weekly', n.dow === 0 && n.hm >= '20:00' && n.hm <= '23:59');
}

async function pollLoop() {
  let offset = 0;
  for (; ;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of ups) {
        offset = u.update_id + 1;
        try { if (u.callback_query) await onCallback(u.callback_query); else if (u.message) await onMessage(u.message); }
        catch (e) { botLastError = 'update: ' + e.message; console.error('bot update', e.message); }
      }
    } catch (e) { botLastError = 'poll: ' + e.message; console.error('bot poll', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}
if (BOT_ON) {
  console.log('Telegram-бот включён' + (bot.ownerId ? '' : ': ждёт привязку /start КОД'));
  pollLoop();
  setInterval(tick, 30000);
}
process.on('SIGTERM', () => { clearTimeout(timer); persistNow(); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timer); persistNow(); process.exit(0); });
