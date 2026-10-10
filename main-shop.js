// LinCut — магазин плагинов (главный процесс): запросы к серверу магазина, аккаунт (ник + секретный ключ),
// установка из магазина и упаковка своего плагина для публикации.
// Окно магазина — src/js/shop.js, сервер — api/lcstore.php на сайте TrollLand.
const { app, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const Plugins = require('./main-plugins');

const STORE_URL = process.env.LINCUT_STORE_URL || 'https://hm537533.webhm.cloud/api/lcstore.php';
const ACCOUNT_FILE = path.join(path.dirname(Plugins.PLUGINS_DIR), 'store-account.json');
const MAX_UPLOAD = 4 * 1024 * 1024;

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const account = () => { const a = readJSON(ACCOUNT_FILE); return a && a.key ? a : null; };
const saveAccount = (a) => {
  if (!a) { fs.rmSync(ACCOUNT_FILE, { force: true }); return; }
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
};

// запрос к API: GET с параметрами или POST с JSON / двоичным телом. Ответ — объект или { error }
async function call(action, { params = {}, json, body, headers = {} } = {}) {
  const u = new URL(STORE_URL);
  u.searchParams.set('a', action);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const acc = account();
  const h = { 'User-Agent': 'LinCut/' + app.getVersion(), ...headers };
  if (acc) h['X-Lcs-Key'] = acc.key;
  const o = { method: 'GET', headers: h };
  if (json !== undefined) { o.method = 'POST'; h['Content-Type'] = 'application/json'; o.body = JSON.stringify(json); }
  if (body !== undefined) { o.method = 'POST'; o.body = body; }
  let r;
  try { r = await net.fetch(u.href, o); } catch (e) { return { error: 'Нет связи с магазином. Проверьте интернет.', offline: true }; }
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch { }
  if (!d) return { error: `Магазин ответил странно (код ${r.status})` };
  if (!r.ok && !d.error) d.error = 'Ошибка магазина (код ' + r.status + ')';
  if (r.status === 401 && acc) d.auth = true;
  return d;
}

// ---------------------------------------------------------------- zip из папки плагина (deflate, без внешних программ)
function zipDir(dir, rootName) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__MACOSX') continue; // .git, .DS_Store, временные файлы
      const full = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) files.push({ full, name: rootName + '/' + r, time: st.mtime });
    }
  };
  walk(dir, '');
  const parts = [], central = [];
  let off = 0;
  const dosTime = (t) => ((t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1)) & 0xffff;
  const dosDate = (t) => (((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate()) & 0xffff;
  for (const f of files) {
    const raw = fs.readFileSync(f.full), comp = zlib.deflateRawSync(raw, { level: 9 });
    const useComp = comp.length < raw.length, data = useComp ? comp : raw;
    const name = Buffer.from(f.name, 'utf8'), crc = zlib.crc32(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); // utf-8 имена
    loc.writeUInt16LE(useComp ? 8 : 0, 8); loc.writeUInt16LE(dosTime(f.time), 10); loc.writeUInt16LE(dosDate(f.time), 12);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(name.length, 26); loc.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useComp ? 8 : 0, 10); cen.writeUInt16LE(dosTime(f.time), 12); cen.writeUInt16LE(dosDate(f.time), 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(off, 42);
    parts.push(loc, name, data);
    central.push(cen, name);
    off += loc.length + name.length + data.length;
  }
  const cdir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdir, end]);
}

function setup() {
  ipcMain.handle('shop:account', () => { const a = account(); return a ? { nick: a.nick, admin: !!a.admin } : null; });
  ipcMain.handle('shop:call', (e, action, o) => call(action, o || {}));

  // новый ник: сервер выдаёт ключ, храним его в папке настроек LinCut
  ipcMain.handle('shop:register', async (e, nick) => {
    saveAccount(null);
    const d = await call('register', { json: { nick } });
    if (d.error) return d;
    saveAccount({ nick: d.nick, key: d.key, admin: !!d.admin });
    return { nick: d.nick, admin: !!d.admin };
  });
  // вход по ключу (перенос аккаунта на другой компьютер)
  ipcMain.handle('shop:login', async (e, key) => {
    key = String(key || '').trim().toLowerCase();
    if (!/^[a-f0-9]{48}$/.test(key)) return { error: 'Ключ — 48 знаков 0–9 и a–f' };
    const old = account();
    saveAccount({ key });
    const d = await call('me');
    if (d.error) { saveAccount(old); return d; }
    saveAccount({ nick: d.nick, key, admin: !!d.admin });
    return { nick: d.nick, admin: !!d.admin };
  });
  ipcMain.handle('shop:logout', () => { saveAccount(null); return true; });
  ipcMain.handle('shop:key', () => { const a = account(); return a ? a.key : null; });

  // установка: скачиваем архив, сверяем sha256 с тем, что сказал магазин, и ставим как обычный .lcplugin
  ipcMain.handle('shop:install', async (e, id, sha256) => {
    const u = new URL(STORE_URL);
    u.searchParams.set('a', 'download'); u.searchParams.set('id', id);
    let buf;
    try {
      const r = await net.fetch(u.href, { headers: { 'User-Agent': 'LinCut/' + app.getVersion() } });
      if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch { } return { ok: false, error: m || 'Магазин не отдал плагин (код ' + r.status + ')' }; }
      buf = Buffer.from(await r.arrayBuffer());
    } catch { return { ok: false, error: 'Нет связи с магазином. Проверьте интернет.' }; }
    if (sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== sha256) return { ok: false, error: 'Архив повреждён при скачивании — попробуйте ещё раз.' };
    const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'lincut-shop-'));
    const file = path.join(tmp, id + '.lcplugin');
    try {
      fs.writeFileSync(file, buf);
      return Plugins.install(file);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // публикация установленного плагина (из папки плагинов)
  ipcMain.handle('shop:publish', async (e, id) => {
    const p = Plugins.scan().find(x => x.id === id);
    if (!p) return { error: 'Плагин не найден в папке плагинов' };
    const err = Plugins.checkManifest(p.manifest);
    if (err) return { error: err };
    let zip;
    try { zip = zipDir(fs.realpathSync(p.dir), p.manifest.id); } catch (x) { return { error: 'Не удалось упаковать плагин: ' + x.message }; }
    if (zip.length > MAX_UPLOAD) return { error: `Плагин весит ${(zip.length / 1048576).toFixed(1)} МБ в архиве — больше 4 МБ. Уберите лишние файлы.` };
    const manifest = Buffer.from(JSON.stringify(p.manifest)).toString('base64');
    return call('upload', { body: zip, headers: { 'Content-Type': 'application/zip', 'X-Lcs-Manifest': manifest } });
  });
}

module.exports = { setup, zipDir };
