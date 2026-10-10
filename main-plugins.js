// LinCut — плагины (главный процесс): папка плагинов, протокол lincut-plugin://, установка из .zip или папки,
// создание плагина по шаблону, включение/выключение, слежение за файлами (режим разработчика).
// Сам код плагинов выполняется в окне редактора — см. src/js/plugins.js и docs/plugins.md.
const { app, ipcMain, protocol, net, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const cp = require('child_process');
const { pathToFileURL } = require('url');

const SCHEME = 'lincut-plugin';
// id плагина — это имя «хоста» в адресе lincut-plugin://<id>/файл, поэтому только латиница, цифры и дефис
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// схему нужно объявить до готовности приложения: standard — относительные пути в плагине работают,
// supportFetchAPI — fetch(lc.url('data.json')) из кода плагина
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const PLUGINS_DIR = process.env.LINCUT_PLUGINS_DIR || path.join(app.getPath('userData'), 'plugins');
const STATE_FILE = path.join(path.dirname(PLUGINS_DIR), 'plugins-state.json');
const EXAMPLES_DIR = path.join(__dirname, 'examples', 'plugins');
const DOCS_URL = 'https://github.com/Flenstick/lincut/blob/main/docs/plugins.md';
fs.mkdirSync(PLUGINS_DIR, { recursive: true });

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const state = () => Object.assign({ disabled: [], dev: false }, readJSON(STATE_FILE) || {});
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// Проверка plugin.json. Возвращает текст ошибки или null
function checkManifest(m) {
  if (!m || typeof m !== 'object') return 'Нет файла plugin.json или в нём ошибка JSON';
  if (!ID_RE.test(m.id || '')) return 'Поле "id" должно состоять из строчных латинских букв, цифр и дефисов (например, "my-plugin")';
  if (!m.name) return 'Не заполнено поле "name"';
  return null;
}

// «1.10.2» >= «1.9»
function versionAtLeast(have, need) {
  const a = String(have).split('.').map(Number), b = String(need).replace(/^[>=\s^~]+/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; }
  return true;
}

// id → папка (папка может называться не так, как id: например, распакованный архив с GitHub)
let dirById = new Map();
function scan() {
  const st = state(), out = [];
  dirById = new Map();
  let names = [];
  try { names = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name); } catch { }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(PLUGINS_DIR, name);
    const m = readJSON(path.join(dir, 'plugin.json'));
    let error = checkManifest(m);
    const id = m && m.id;
    if (!error && dirById.has(id)) error = `Плагин с id "${id}" уже установлен в папке ${path.basename(dirById.get(id))}`;
    if (!error && m.lincut && !versionAtLeast(app.getVersion(), m.lincut)) error = `Нужна версия LinCut ${String(m.lincut).replace(/^[>=\s^~]+/, '')} или новее (у вас ${app.getVersion()})`;
    const main = (m && m.main) || 'main.js';
    if (!error && !fs.existsSync(path.join(dir, main))) error = `Нет файла ${main}`;
    if (!error) dirById.set(id, dir);
    out.push({ id: id || name, folder: name, dir, manifest: m || {}, main, enabled: !st.disabled.includes(id || name), error });
  }
  return out;
}

// ---------------------------------------------------------------- .zip без внешних программ
// Поддерживаются обычные архивы (без шифрования, сжатие deflate или без сжатия) — так упаковывают
// «Сжать в ZIP» в файловых менеджерах, Проводник Windows и кнопка «Download ZIP» на GitHub.
function unzip(file, dest) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Это не zip-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(dest);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждённый архив');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Недопустимый путь в архиве: ' + name);
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (method === 0) fs.writeFileSync(target, data);
    else if (method === 8) fs.writeFileSync(target, zlib.inflateRawSync(data));
    else throw new Error('Неподдерживаемое сжатие в архиве (' + method + ')');
  }
}

// папка, в которой лежит plugin.json: сама папка или единственная вложенная (архивы с GitHub)
function findPluginRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'plugin.json'))) return dir;
  if (depth > 2) return null;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== '__MACOSX');
  for (const d of subs) { const r = findPluginRoot(path.join(dir, d.name), depth + 1); if (r) return r; }
  return null;
}

function install(src) {
  let tmp = null, root;
  try {
    const st = fs.statSync(src);
    if (st.isDirectory()) root = findPluginRoot(src);
    else if (path.basename(src) === 'plugin.json') root = path.dirname(src);
    else {
      tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'lincut-plugin-'));
      unzip(src, tmp);
      root = findPluginRoot(tmp);
    }
    if (!root) throw new Error('В архиве или папке нет файла plugin.json');
    const m = readJSON(path.join(root, 'plugin.json'));
    const err = checkManifest(m);
    if (err) throw new Error(err);
    if (m.lincut && !versionAtLeast(app.getVersion(), m.lincut)) throw new Error(`Плагину нужна версия LinCut ${m.lincut}, у вас ${app.getVersion()}`);
    scan();
    const old = dirById.get(m.id);
    const dest = path.join(PLUGINS_DIR, m.id);
    if (path.resolve(root) === path.resolve(old || dest)) return { ok: true, id: m.id, name: m.name, updated: false, same: true };
    if (old) fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(root, dest, { recursive: true, filter: (s) => !/(^|[\\/])(\.git|node_modules)$/.test(s) });
    return { ok: true, id: m.id, name: m.name, version: m.version || '', updated: !!old };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- шаблон нового плагина
function template(o) {
  const manifest = {
    id: o.id, name: o.name, version: '1.0.0', author: o.author || '', description: o.description || '',
    main: 'main.js', lincut: '>=' + app.getVersion(),
  };
  const main = `// ${o.name} — плагин для LinCut
// Документация: ${DOCS_URL}
// После правки сохраните файл и нажмите «Плагины → Перезагрузить плагины» (Ctrl+Shift+R)
// или включите «Перезагружать при изменении файлов» в окне «Плагины».

LinCut.plugin((lc) => {
  // Команда в меню «Плагины» с горячей клавишей
  lc.commands.add({
    id: 'hello',
    label: 'Привет из плагина',
    key: 'Ctrl+Alt+H',
    run() {
      const clip = lc.project.selected();
      lc.ui.toast(clip ? 'Выбран клип: ' + clip.kind : 'Привет! Выберите клип на таймлайне.', 'ok');
    },
  });

  // Свой эффект: работает и в превью, и в экспорте (операции описаны в документации)
  lc.effects.add({
    id: 'pulse-red',
    name: 'Красный пульс',
    ops: (p) => [
      { type: 'levels', r0: \`\${0.4 * p.I}*(0.5-0.5*cos(2*PI*T*\${p.V}))\` },
    ],
  });
});
`;
  return { 'plugin.json': JSON.stringify(manifest, null, 2) + '\n', 'main.js': main };
}

// ---------------------------------------------------------------- слежение за файлами (режим разработчика)
let watcher = null, watchTimer = null;
function setWatch(on, send) {
  if (watcher) { watcher.close(); watcher = null; }
  if (!on) return;
  try {
    watcher = fs.watch(PLUGINS_DIR, { recursive: true }, (ev, file) => {
      if (file && /(^|[\\/])\./.test(file)) return; // временные файлы редакторов
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => send('plugins:changed', file || ''), 350);
    });
  } catch (e) { console.log('plugins watch:', e.message); }
}

// ---------------------------------------------------------------- ffmpeg для плагинов
const ffProcs = new Map();
let ffSeq = 0;

function setup(getWin) {
  const send = (ch, v) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, v); };

  app.whenReady().then(() => {
    protocol.handle(SCHEME, async (req) => {
      const u = new URL(req.url);
      if (!dirById.size) scan();
      const dir = dirById.get(u.hostname);
      if (!dir) return new Response('Плагин не найден', { status: 404 });
      const file = path.resolve(dir, '.' + decodeURIComponent(u.pathname));
      if (file !== dir && !file.startsWith(dir + path.sep)) return new Response('Нет доступа', { status: 403 });
      const r = await net.fetch(pathToFileURL(file).href);
      // CORS-заголовок: иначе браузер прячет текст ошибок в скриптах плагина («Script error.»)
      const headers = new Headers(r.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-cache');
      return new Response(r.body, { status: r.status, headers });
    });
    setWatch(state().dev, send);
  });

  ipcMain.handle('plugins:list', () => ({ dir: PLUGINS_DIR, examples: EXAMPLES_DIR, docs: DOCS_URL, version: app.getVersion(), dev: state().dev, plugins: scan() }));
  ipcMain.handle('plugins:setEnabled', (e, id, on) => {
    const st = state();
    st.disabled = st.disabled.filter(x => x !== id);
    if (!on) st.disabled.push(id);
    saveState(st);
    return true;
  });
  ipcMain.handle('plugins:setDev', (e, on) => { const st = state(); st.dev = !!on; saveState(st); setWatch(st.dev, send); return st.dev; });
  ipcMain.handle('plugins:pick', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Установить плагин', properties: ['openFile'],
      filters: [{ name: 'Плагин LinCut', extensions: ['zip', 'lcplugin', 'json'] }, { name: 'Все файлы', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('plugins:pickFolder', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Папка с плагином (в ней plugin.json)', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('plugins:install', (e, src) => install(src));
  ipcMain.handle('plugins:remove', async (e, id) => {
    scan();
    const dir = dirById.get(id) || path.join(PLUGINS_DIR, id);
    if (!path.resolve(dir).startsWith(path.resolve(PLUGINS_DIR) + path.sep)) return false;
    try { await shell.trashItem(dir); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
    return true;
  });
  ipcMain.handle('plugins:create', (e, o) => {
    const err = checkManifest({ id: o.id, name: o.name });
    if (err) return { ok: false, error: err };
    const dir = path.join(PLUGINS_DIR, o.id);
    if (fs.existsSync(dir)) return { ok: false, error: 'Папка ' + o.id + ' уже существует' };
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, data] of Object.entries(template(o))) fs.writeFileSync(path.join(dir, f), data);
    return { ok: true, dir };
  });
  ipcMain.handle('plugins:openExternal', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

  // ffmpeg / ffprobe для плагинов: только эти две программы, аргументы — массивом (без оболочки)
  ipcMain.handle('plugins:ffmpeg', (e, prog, args, opts = {}) => new Promise((resolve) => {
    if (!['ffmpeg', 'ffprobe'].includes(prog) || !Array.isArray(args)) return resolve({ code: -1, stdout: '', stderr: 'Можно запускать только ffmpeg и ffprobe' });
    const id = ++ffSeq;
    const p = cp.spawn(prog, args.map(String), { windowsHide: true, cwd: opts.cwd || undefined });
    ffProcs.set(id, p);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 8e6) out = out.slice(-4e6); });
    p.stderr.on('data', (d) => {
      err += d; if (err.length > 2e6) err = err.slice(-1e6);
      if (opts.progress) { const m = /time=(\d+):(\d+):([\d.]+)/.exec(String(d)); if (m) send('plugins:ffprogress', { job: opts.job, t: +m[1] * 3600 + +m[2] * 60 + +m[3] }); }
    });
    p.on('error', (x) => { ffProcs.delete(id); resolve({ code: -1, stdout: out, stderr: x.message }); });
    p.on('close', (code) => { ffProcs.delete(id); resolve({ code, stdout: out, stderr: err }); });
  }));
  app.on('will-quit', () => { for (const p of ffProcs.values()) try { p.kill('SIGTERM'); } catch { } setWatch(false); });
}

module.exports = { setup, PLUGINS_DIR, scan, install, checkManifest };
