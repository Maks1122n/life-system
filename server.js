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
      return send(res, 200, { ok: true, started: STARTED, counts });
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
process.on('SIGTERM', () => { clearTimeout(timer); persistNow(); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timer); persistNow(); process.exit(0); });
