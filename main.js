// LinCut — главный процесс Electron
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
// на Windows любой консольный процесс (ffmpeg, Python) иначе открывает мигающее чёрное окно
const hide = (o) => ({ windowsHide: true, ...(o || {}) });
const spawn = (c, a, o) => cp.spawn(c, a, hide(o));
const execFile = (c, a, o, cb) => typeof o === 'function' ? cp.execFile(c, a, hide(), o) : cp.execFile(c, a, hide(o), cb);

app.setName('LinCut');
// app_id окна на Wayland = имя .desktop-файла → панель задач берёт оттуда иконку
if (typeof app.setDesktopName === 'function') app.setDesktopName('lincut.desktop');
if (process.env.LINCUT_FAKE_MIC) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
// плавная прокрутка колесом, как в нативных программах
app.commandLine.appendSwitch('enable-smooth-scrolling');

// Windows: ffmpeg, ffprobe, yt-dlp и uv лежат рядом с программой (resources/bin) — добавляем в PATH,
// тогда spawn('ffmpeg') и скрипты нейросетей находят их так же, как системные на Linux
const IS_WIN = process.platform === 'win32';
const BIN_DIR = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'vendor', IS_WIN ? 'win' : 'linux');
if (fs.existsSync(BIN_DIR)) process.env.PATH = BIN_DIR + path.delimiter + process.env.PATH;
// русские сообщения Python на Windows (кодировка консоли — не UTF-8)
if (IS_WIN) { process.env.PYTHONUTF8 = '1'; process.env.PYTHONIOENCODING = 'utf-8'; }
const CACHE_DIR = path.join(app.getPath('cache'), 'lincut');
const PROJECTS_DIR = path.join(app.getPath('videos'), 'LinCut');
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

let win = null;
const projDir = (id) => path.join(PROJECTS_DIR, String(id).replace(/[^\w-]/g, ''));

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0b0b0c',
    title: 'LinCut',
    frame: false,           // своя шапка вместо системной рамки
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,            // показываем, когда интерфейс уже отрисован — без пустой вспышки
    webPreferences: {
      offscreen: !!process.env.LINCUT_HIDDEN,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      webSecurity: false, // локальные медиафайлы через file:// без «грязного» canvas
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  if (!process.env.LINCUT_HIDDEN) win.once('ready-to-show', () => win.show());
  const sendMax = () => win.webContents.send('win:maximized', win.isMaximized());
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.env.LINCUT_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  // Отладка: выполнить скрипт в окне
  if (process.env.LINCUT_TEST_SCRIPT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => win.webContents.executeJavaScript(fs.readFileSync(process.env.LINCUT_TEST_SCRIPT, 'utf8')).catch(e => console.log('test error', e)), 500);
    });
  }
  // Отладка: автоматический скриншот окна
  if (process.env.LINCUT_SHOT) {
    const delay = Number(process.env.LINCUT_SHOT_DELAY || 2500);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.LINCUT_SHOT, img.toPNG());
        if (!process.env.LINCUT_KEEP) app.quit();
      }, delay);
    });
  }
  win.webContents.on('console-message', (e) => {
    if (process.env.LINCUT_LOG) fs.appendFileSync(process.env.LINCUT_LOG, e.message + '\n');
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'local-fonts', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler(() => true);
  createWindow();
  initUpdater();
});
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- автообновление (Windows)
// electron-updater смотрит релизы GitHub (Flenstick/lincut: latest.yml + Setup.exe), новую версию качает сам
// в фоне. Ставится по кнопке «Перезапустить и обновить» в шапке или молча при выходе из программы.
// На Linux программа запускается из исходников (git pull) — там обновлений нет.
// LINCUT_UPDATE_URL — свой адрес с latest.yml (проверка обновления под wine с локального сервера).
let updater = null;
const upd = { state: 'off', current: app.getVersion(), version: '', percent: 0, speed: 0, error: '' };
const updSend = () => { if (win && !win.isDestroyed()) win.webContents.send('upd:state', upd); };
const updSet = (o) => { Object.assign(upd, o); updSend(); };
function initUpdater() {
  if (!IS_WIN || !app.isPackaged || process.env.LINCUT_NO_UPDATE) return;
  try { updater = require('electron-updater').autoUpdater; } catch { return; }
  if (process.env.LINCUT_UPDATE_URL) updater.setFeedURL({ provider: 'generic', url: process.env.LINCUT_UPDATE_URL });
  updater.logger = process.env.LINCUT_LOG ? { info: (m) => fs.appendFileSync(process.env.LINCUT_LOG, '[upd] ' + m + '\n'), warn: (m) => fs.appendFileSync(process.env.LINCUT_LOG, '[upd] ' + m + '\n'), error: (m) => fs.appendFileSync(process.env.LINCUT_LOG, '[upd] ' + m + '\n'), debug: () => { } } : null;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.disableWebInstaller = true;
  updater.on('checking-for-update', () => { if (upd.state !== 'downloading' && upd.state !== 'ready') updSet({ state: 'checking', error: '' }); });
  updater.on('update-not-available', () => updSet({ state: 'none' }));
  updater.on('update-available', (i) => updSet({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('download-progress', (p) => updSet({ state: 'downloading', percent: p.percent, speed: p.bytesPerSecond }));
  updater.on('update-downloaded', (i) => updSet({ state: 'ready', version: i.version, percent: 100 }));
  updater.on('error', (e) => { if (upd.state !== 'ready') updSet({ state: 'error', error: String((e && e.message) || e).split('\n')[0] }); });
  upd.state = 'idle';
  const check = () => { if (upd.state !== 'downloading' && upd.state !== 'ready') updater.checkForUpdates().catch(() => { }); };
  setTimeout(check, 8000);
  setInterval(check, 6 * 3600 * 1000);
}
ipcMain.handle('upd:state', () => upd);
ipcMain.handle('upd:check', async () => {
  if (!updater) return upd;
  if (upd.state === 'downloading' || upd.state === 'ready') return upd;
  updSet({ state: 'checking', error: '' });
  try { await updater.checkForUpdates(); } catch (e) { updSet({ state: 'error', error: String(e.message || e).split('\n')[0] }); }
  return upd;
});
// тихая установка (/S) в ту же папку и запуск новой версии
ipcMain.handle('upd:install', () => { if (updater && upd.state === 'ready') setImmediate(() => updater.quitAndInstall(true, true)); });

// ---------------------------------------------------------------- утилиты
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 512, encoding: opts.encoding || 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(stdout);
    });
  });
}
const hashOf = (p) => {
  let st = null;
  try { st = fs.statSync(p); } catch { }
  return crypto.createHash('sha1').update(p + '|' + (st ? st.size + '|' + st.mtimeMs : '')).digest('hex').slice(0, 20);
};
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif', '.tif', '.tiff'];
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.wma', '.aiff', '.aif'];

// Очередь тяжёлых задач ffmpeg, чтобы не повесить систему при импорте кучи файлов
const queue = [];
let active = 0;
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    job.fn().then(job.resolve, job.reject).finally(() => { active--; pump(); });
  }
}

// ---------------------------------------------------------------- диалоги
ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Импорт медиа',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Медиа', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'wmv', '3gp', 'ts', 'mts', 'mpg', 'mpeg', 'ogv', ...IMAGE_EXT.map(e => e.slice(1)), ...AUDIO_EXT.map(e => e.slice(1))] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:saveExport', async (e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Экспорт видео',
    defaultPath: path.join(app.getPath('videos'), defaultName),
    filters: [{ name: 'Видео MP4', extensions: ['mp4'] }, { name: 'WebM', extensions: ['webm'] }, { name: 'MOV', extensions: ['mov'] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('dialog:pickFolder', async (e, def) => {
  const r = await dialog.showOpenDialog(win, { title: 'Папка для экспорта', defaultPath: def || app.getPath('videos'), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

if (process.env.LINCUT_TEST_SCRIPT) {
  ipcMain.handle('debug:shot', async (e, file) => { const img = await win.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); return true; });
}
ipcMain.handle('app:paths', () => ({ videos: app.getPath('videos'), projects: PROJECTS_DIR, cache: CACHE_DIR, home: os.homedir(), app: path.join(__dirname, 'src') }));
ipcMain.handle('shell:showItem', (e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (e, p) => shell.openPath(p));
ipcMain.handle('fs:exists', (e, p) => fs.existsSync(p));
ipcMain.handle('win:setTitle', (e, t) => win && win.setTitle(t));
ipcMain.handle('win:minimize', () => win && win.minimize());
ipcMain.handle('win:toggleMax', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.handle('win:close', () => win && win.close());
ipcMain.handle('win:isMax', () => !!win && win.isMaximized());

ipcMain.handle('fonts:list', async () => {
  if (IS_WIN) return null; // на Windows список даёт сам Chromium (queryLocalFonts)
  try {
    const out = await run('fc-list', [':', 'family']);
    const set = new Set();
    for (const line of out.split('\n')) {
      const fam = line.split(',')[0].trim();
      if (!fam || /\.pcf|Nerd Font|Symbols|Emoji|icomoon|FontAwesome|Material|Misc|MUTT|cursor|dec|Syriac|Estrangelo|Goha|mtx|micro|Fangsong/i.test(fam)) continue;
      set.add(fam);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  } catch { return ['Sans', 'Serif', 'Monospace']; }
});

// ---------------------------------------------------------------- анализ медиа
ipcMain.handle('media:probe', async (e, file) => {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const info = { path: file, name: path.basename(file), size: stat.size, type: 'video', duration: 0, width: 0, height: 0, fps: 30, hasAudio: false, hasVideo: false };
  let j;
  try {
    j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  } catch (err) {
    throw new Error('Не удалось прочитать файл: ' + path.basename(file));
  }
  const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  info.hasAudio = !!a;
  info.hasVideo = !!v;
  info.duration = parseFloat((j.format && j.format.duration) || (v && v.duration) || (a && a.duration) || 0) || 0;
  if (v) {
    info.width = v.width; info.height = v.height;
    let rot = 0;
    if (v.tags && v.tags.rotate) rot = parseInt(v.tags.rotate);
    for (const sd of v.side_data_list || []) if (sd.rotation !== undefined) rot = parseInt(sd.rotation);
    if (Math.abs(rot) % 180 === 90) { info.width = v.height; info.height = v.width; }
    const fr = (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate) || '30/1';
    const [n, d] = fr.split('/').map(Number);
    info.fps = d ? n / d : 30;
    if (!isFinite(info.fps) || info.fps <= 0 || info.fps > 240) info.fps = 30;
    info.vcodec = v.codec_name;
  }
  if (IMAGE_EXT.includes(ext) || (v && !a && (!info.duration || info.duration < 0.05 || ['png', 'mjpeg', 'webp', 'bmp', 'tiff'].includes(v.codec_name) && info.duration < 0.2))) {
    info.type = 'image';
    info.duration = 0;
    if (ext === '.gif' && parseFloat(j.format.duration) > 0.2) { info.type = 'video'; info.duration = parseFloat(j.format.duration); }
  } else if (!v && a) {
    info.type = 'audio';
  } else if (!v && !a) {
    throw new Error('Файл не содержит видео или аудио: ' + path.basename(file));
  }
  info.hash = hashOf(file);
  return info;
});

// Постер + спрайт миниатюр для таймлайна
ipcMain.handle('media:thumbs', (e, info) => enqueue(async () => {
  const dir = path.join(CACHE_DIR, info.hash);
  fs.mkdirSync(dir, { recursive: true });
  const poster = path.join(dir, 'poster.jpg');
  const sprite = path.join(dir, 'sprite.jpg');
  const metaFile = path.join(dir, 'sprite.json');
  if (info.type === 'audio') return null;
  const TH = 90;
  const tw = Math.max(2, Math.round(TH * (info.width / info.height || 16 / 9) / 2) * 2);
  if (!fs.existsSync(poster)) {
    // для картинок без -ss: ffmpeg 9 с «-ss 0» на одиночном кадре молча ничего не пишет
    const seek = info.type === 'video' ? ['-ss', String(Math.min(1, info.duration / 3))] : [];
    const args = ['-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', poster];
    await run('ffmpeg', ['-y', '-v', 'error', ...seek, '-i', info.path, ...args]).catch(() => { });
    if (!fs.existsSync(poster)) await run('ffmpeg', ['-y', '-v', 'error', '-i', info.path, ...args]);
  }
  if (info.type === 'image') {
    if (!fs.existsSync(sprite)) await run('ffmpeg', ['-y', '-v', 'error', '-i', info.path, '-frames:v', '1', '-vf', `scale=${tw}:${TH}`, '-q:v', '4', sprite]);
    return { poster, sprite, count: 1, cols: 1, interval: 1, tw, th: TH };
  }
  if (fs.existsSync(metaFile) && fs.existsSync(sprite)) return { poster, sprite, ...JSON.parse(fs.readFileSync(metaFile, 'utf8')) };
  const dur = Math.max(0.1, info.duration);
  const count = Math.max(1, Math.min(120, Math.ceil(dur / 0.5)));
  const interval = dur / count;
  const cols = Math.min(count, 12);
  const rows = Math.ceil(count / cols);
  const args = ['-y', '-v', 'error'];
  if (dur > 90) args.push('-skip_frame', 'nokey');
  args.push('-i', info.path, '-an', '-vf', `fps=1/${interval.toFixed(4)},scale=${tw}:${TH},tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', sprite);
  await run('ffmpeg', args);
  const meta = { count, cols, interval, tw, th: TH };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  return { poster, sprite, ...meta };
}));

// Пики громкости для отрисовки волны (100 значений в секунду)
ipcMain.handle('media:waveform', (e, info) => enqueue(async () => {
  if (!info.hasAudio) return null;
  const dir = path.join(CACHE_DIR, info.hash);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wave2.bin');
  if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
  const RATE = 8000, PER = 80; // 100 пиков/сек
  const pcm = await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', info.path, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']);
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', reject);
    p.on('close', () => resolve(Buffer.concat(chunks)));
  });
  const samples = pcm.length >> 1;
  const n = Math.ceil(samples / PER);
  const out = new Uint8Array(n);
  let max = 1;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const end = Math.min(samples, (i + 1) * PER);
    for (let s = i * PER; s < end; s++) {
      const v = Math.abs(pcm.readInt16LE(s * 2));
      if (v > peak) peak = v;
    }
    raw[i] = peak;
    if (peak > max) max = peak;
  }
  const norm = Math.max(max, 32768 * 0.05); // нормализация по пику файла
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.pow(raw[i] / norm, 0.8) * 255);
  fs.writeFileSync(file, Buffer.from(out));
  return out;
}));

// Прокси для превью, если Chromium не умеет декодировать исходник (HEVC, ProRes, и т.п.)
ipcMain.handle('media:proxy', (e, info) => enqueue(async () => {
  const dir = path.join(CACHE_DIR, info.hash);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, info.type === 'audio' ? 'proxy.m4a' : 'proxy.mp4');
  if (fs.existsSync(out)) return out;
  const tmp = out + '.part.' + path.extname(out).slice(1);
  const args = ['-y', '-v', 'error', '-i', info.path];
  if (info.type === 'audio') args.push('-vn', '-c:a', 'aac', '-b:a', '192k', tmp);
  else args.push('-vf', "scale='min(1280,iw)':-2,format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp);
  await run('ffmpeg', args);
  fs.renameSync(tmp, out);
  return out;
}));

// Стоп-кадр: извлекаем кадр в PNG в папку проекта
ipcMain.handle('media:frame', async (e, file, t, id) => {
  const dir = path.join(projDir(id), 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'frame_' + Date.now() + '.png');
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', out]);
  return out;
});

// ---------------------------------------------------------------- проекты

ipcMain.handle('project:list', () => {
  const list = [];
  for (const id of fs.readdirSync(PROJECTS_DIR)) {
    const f = path.join(PROJECTS_DIR, id, 'project.json');
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const cover = path.join(PROJECTS_DIR, id, 'cover.jpg');
      list.push({ id, name: j.name, updated: j.updated || fs.statSync(f).mtimeMs, duration: j.durationCache || 0, width: j.width, height: j.height, cover: fs.existsSync(cover) ? cover : null });
    } catch { }
  }
  list.sort((a, b) => b.updated - a.updated);
  return list;
});

ipcMain.handle('project:create', () => {
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  fs.mkdirSync(projDir(id), { recursive: true });
  return { id, dir: projDir(id) };
});

ipcMain.handle('project:load', (e, id) => {
  const f = path.join(projDir(id), 'project.json');
  return { data: JSON.parse(fs.readFileSync(f, 'utf8')), dir: projDir(id) };
});

ipcMain.handle('project:save', (e, id, json, coverDataUrl) => {
  const dir = projDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'project.json');
  fs.writeFileSync(f + '.tmp', json);
  fs.renameSync(f + '.tmp', f);
  if (coverDataUrl && coverDataUrl.startsWith('data:image/jpeg;base64,')) {
    fs.writeFileSync(path.join(dir, 'cover.jpg'), Buffer.from(coverDataUrl.split(',')[1], 'base64'));
  }
  return true;
});

ipcMain.handle('project:writeFile', (e, id, name, dataUrl) => {
  const dir = path.join(projDir(id), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, path.basename(name));
  fs.writeFileSync(f, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  return f;
});

// ---------------------------------------------------------------- буфер обмена (Ctrl+V)
// Под Wayland Electron видит не все типы буфера (список файлов из файлового менеджера) — читаем через wl-paste.
const WL = !!process.env.WAYLAND_DISPLAY && ['/usr/bin/wl-paste', '/usr/local/bin/wl-paste'].some(f => fs.existsSync(f));
const wlRead = (args, enc) => new Promise((resolve) => execFile('wl-paste', args, { encoding: enc || 'buffer', maxBuffer: 1 << 28, timeout: 5000 }, (err, out) => resolve(err ? null : out)));
let clipImage = null; // { buf, ext } — картинка из последнего чтения буфера
// Windows: файлы, скопированные в Проводнике (CF_HDROP), — через PowerShell, Electron отдаёт максимум один
const winClipFiles = () => new Promise((resolve) => {
  let one = '';
  try { one = clipboard.readBuffer('FileNameW').toString('utf16le').replace(/\0+$/, ''); } catch { }
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'],
    { timeout: 4000, windowsHide: true }, (err, out) => {
      const list = err ? [] : String(out).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const all = list.length ? list : one ? [one] : [];
      resolve(all.filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }));
    });
});
function filesFrom(text) {
  const out = [];
  for (let l of String(text || '').split(/\r?\n/)) {
    l = l.trim();
    if (!l || l === 'copy' || l === 'cut' || l.startsWith('#')) continue;
    let f = null;
    if (l.startsWith('file://')) { try { f = decodeURIComponent(new URL(l).pathname); } catch { } }
    else if (l.startsWith('/') || (IS_WIN && /^[a-zA-Z]:[\\/]/.test(l))) f = l;
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) out.push(f);
  }
  return out;
}
// { files, image: ext|null, text, sig } — sig меняется при любом новом содержимом буфера
ipcMain.handle('clip:read', async () => {
  let types = [], text = '', files = [];
  clipImage = null;
  if (WL) {
    const t = await wlRead(['--list-types'], 'utf8');
    types = t ? t.split('\n').map(x => x.trim()).filter(Boolean) : [];
    const uri = types.find(x => x === 'text/uri-list') || types.find(x => x === 'x-special/gnome-copied-files');
    if (uri) files = filesFrom(await wlRead(['--no-newline', '-t', uri], 'utf8'));
    const tt = types.find(x => x === 'text/plain;charset=utf-8') || types.find(x => x === 'text/plain' || x === 'UTF8_STRING');
    if (tt) text = (await wlRead(['--no-newline', '-t', tt], 'utf8')) || '';
    const it = types.find(x => /^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(x));
    if (it) { const buf = await wlRead(['--no-newline', '-t', it]); if (buf && buf.length) clipImage = { buf, ext: it.split('/')[1].replace('jpeg', 'jpg') }; }
  } else {
    types = clipboard.availableFormats();
    for (const f of ['text/uri-list', 'x-special/gnome-copied-files']) if (!files.length && types.includes(f)) files = filesFrom(clipboard.read(f));
    if (IS_WIN && !files.length) files = await winClipFiles();
    text = clipboard.readText() || '';
    const im = clipboard.readImage();
    if (!im.isEmpty()) clipImage = { buf: im.toPNG(), ext: 'png' };
  }
  if (!files.length) files = filesFrom(text);
  const h = crypto.createHash('sha1').update(types.join('|')).update(text).update(files.join('|'));
  if (clipImage) h.update(clipImage.buf);
  return { files, image: clipImage ? clipImage.ext : null, text: text.slice(0, 4000), sig: h.digest('hex') };
});
// картинка из буфера → файл в папке проекта
ipcMain.handle('clip:saveImage', (e, id) => {
  if (!clipImage) return null;
  const dir = path.join(projDir(id), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  let f = path.join(dir, `Вставка ${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}.${clipImage.ext}`);
  for (let i = 2; fs.existsSync(f); i++) f = f.replace(/( \(\d+\))?\.(\w+)$/, ` (${i}).$2`);
  fs.writeFileSync(f, clipImage.buf);
  return f;
});

// ---------------------------------------------------------------- импорт по ссылке (yt-dlp)
// YouTube, TikTok, VK, Rutube и всё, что умеет yt-dlp. Файлы — в папку проекта (assets).
const YTDLP = IS_WIN ? 'yt-dlp' : ['/usr/bin/yt-dlp', '/usr/local/bin/yt-dlp', path.join(os.homedir(), '.local/bin/yt-dlp')].find(f => fs.existsSync(f)) || 'yt-dlp';
// YouTube требует JS-движок; на Windows им служит сама программа (Electron в режиме Node)
const ytArgs = (a) => IS_WIN ? ['--js-runtimes', 'node:' + process.execPath, ...a] : a;
const ytEnv = () => IS_WIN ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
const urlProcs = {};
const urlSend = (msg) => { if (win) win.webContents.send('url:progress', msg); };
ipcMain.handle('url:status', () => new Promise((resolve) => execFile(YTDLP, ['--version'], { timeout: 8000 }, (err, out) => resolve(err ? null : String(out).trim()))));
ipcMain.handle('url:info', (e, url) => new Promise((resolve, reject) => {
  execFile(YTDLP, ytArgs(['-J', '--no-playlist', '--no-warnings', url]), { maxBuffer: 1 << 27, timeout: 60000, env: ytEnv() }, async (err, out, se) => {
    if (err) return reject(new Error(ytErr(se) || 'Не удалось прочитать ссылку'));
    try {
      const d = JSON.parse(out);
      let thumb = null;
      const tu = d.thumbnail || (d.thumbnails && d.thumbnails.length && d.thumbnails[d.thumbnails.length - 1].url);
      if (tu) {
        try {
          const r = await fetch(tu, { signal: AbortSignal.timeout(8000) });
          const b = Buffer.from(await r.arrayBuffer());
          if (r.ok && b.length < 3 << 20) thumb = `data:${(r.headers.get('content-type') || 'image/jpeg').split(';')[0]};base64,${b.toString('base64')}`;
        } catch { }
      }
      resolve({ title: d.title || d.id, duration: d.duration || 0, uploader: d.uploader || d.channel || '', site: d.extractor_key || d.extractor || '', thumb,
        width: d.width || 0, height: d.height || 0, live: !!d.is_live, entries: d._type === 'playlist' });
    } catch (x) { reject(x); }
  });
}));
function ytErr(se) {
  const l = String(se || '').split('\n').filter(x => /ERROR/.test(x)).pop() || '';
  return l.replace(/^.*?ERROR:\s*(\[[^\]]+\]\s*)?(\S+:\s*)?/, '').trim();
}
// job = { name, url, mode: 'video'|'audio', quality: 720|1080|0, id } → путь к файлу
ipcMain.handle('url:download', (e, job) => new Promise((resolve, reject) => {
  const dir = path.join(projDir(job.id), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const H = job.quality ? `[height<=${job.quality}]` : '';
  const args = ['--no-playlist', '--newline', '--no-warnings', '--no-mtime', '-o', path.join(dir, '%(title).80B [%(id)s].%(ext)s'),
    '--progress-template', 'download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
    '--print', 'after_move:FILE %(filepath)s'];
  // видео: лучше H.264 + AAC в mp4 — играет сразу, без прокси
  if (job.mode === 'audio') args.push('-f', 'ba[acodec^=mp4a]/ba/b', '-x', '--audio-format', 'm4a');
  else args.push('-f', `bv*${H}[vcodec^=avc1]+ba[acodec^=mp4a]/bv*${H}+ba/b${H}/b`, '--merge-output-format', 'mp4');
  args.push(job.url);
  const p = spawn(YTDLP, ytArgs(args), { env: ytEnv() });
  urlProcs[job.name] = p;
  let buf = '', err = '', file = null, part = 0, lastP = 0;
  p.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      let m;
      if ((m = /^PROG (\S+) (\S+) (\S+)/.exec(l))) {
        const got = Number(m[1]), tot = Number(m[2]) || Number(m[3]);
        if (!tot) continue;
        let f = Math.min(1, got / tot);
        // видео и звук качаются по очереди: второй поток — последние 10%
        if (f < lastP - 0.5) part++;
        lastP = f;
        urlSend({ name: job.name, p: part ? 0.9 + f * 0.08 : f * (job.mode === 'audio' ? 0.95 : 0.9), stage: 'download' });
      } else if ((m = /^FILE (.+)$/.exec(l))) file = m[1].trim();
      else if (/\[(Merger|ExtractAudio|FixupM3u8|VideoConvertor)\]/.test(l)) urlSend({ name: job.name, p: 0.98, stage: 'merge' });
    }
  });
  p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
  p.on('error', (x) => { delete urlProcs[job.name]; reject(new Error(x.code === 'ENOENT' ? 'Не найден yt-dlp — установите пакет yt-dlp' : String(x))); });
  p.on('close', (code, sig) => {
    delete urlProcs[job.name];
    if (sig) return reject(new Error('Отменено'));
    if (code === 0 && file && fs.existsSync(file)) return resolve(file);
    reject(new Error(ytErr(err) || err.trim().split('\n').slice(-3).join('\n') || 'Не удалось скачать'));
  });
}));
ipcMain.handle('url:cancel', (e, name) => { const p = urlProcs[name]; if (p) p.kill('SIGTERM'); });
app.on('will-quit', () => { for (const p of Object.values(urlProcs)) try { p.kill('SIGTERM'); } catch { } });

ipcMain.handle('project:delete', (e, id) => {
  fs.rmSync(projDir(id), { recursive: true, force: true });
  return true;
});

ipcMain.handle('project:rename', (e, id, name) => {
  const f = path.join(projDir(id), 'project.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.name = name;
  fs.writeFileSync(f, JSON.stringify(j));
  return true;
});

ipcMain.handle('project:duplicate', (e, id) => {
  const nid = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  fs.cpSync(projDir(id), projDir(nid), { recursive: true });
  const f = path.join(projDir(nid), 'project.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.name = j.name + ' (копия)';
  j.id = nid;
  fs.writeFileSync(f, JSON.stringify(j));
  return nid;
});

// Сохранение записанной озвучки: webm/opus -> wav (точная перемотка в плеере)
ipcMain.handle('voice:save', async (e, id, buf) => {
  const dir = path.join(projDir(id), 'voiceover');
  fs.mkdirSync(dir, { recursive: true });
  const base = 'voice_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const webm = path.join(dir, base + '.webm');
  const wav = path.join(dir, base + '.wav');
  fs.writeFileSync(webm, Buffer.from(buf));
  await run('ffmpeg', ['-y', '-v', 'error', '-i', webm, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);
  fs.rmSync(webm, { force: true });
  return wav;
});

// ---------------------------------------------------------------- экспорт
let exportProc = null;
const tmpDir = path.join(os.tmpdir(), 'lincut-' + process.pid);

ipcMain.handle('export:writeTemp', (e, name, dataUrl) => {
  fs.mkdirSync(tmpDir, { recursive: true });
  const f = path.join(tmpDir, name);
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
  else fs.writeFileSync(f, dataUrl);
  return f;
});

// последовательность «картинка на каждый кадр» для экспорта: пронумерованные ссылки на готовые файлы
ipcMain.handle('export:linkSeq', (e, name, files) => {
  const dir = path.join(tmpDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(files[0]);
  // на Windows символьные ссылки требуют прав администратора — жёсткая ссылка, в крайнем случае копия
  const put = (f, to) => {
    if (!IS_WIN) { try { return fs.symlinkSync(f, to); } catch { } }
    try { fs.linkSync(f, to); } catch { fs.copyFileSync(f, to); }
  };
  files.forEach((f, i) => put(f, path.join(dir, String(i).padStart(6, '0') + ext)));
  return path.join(dir, '%06d' + ext);
});

ipcMain.handle('export:run', (e, args, total) => new Promise((resolve) => {
  const full = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', ...args];
  if (process.env.LINCUT_LOG) fs.appendFileSync(process.env.LINCUT_LOG, 'ffmpeg ' + full.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ') + '\n');
  const p = spawn('ffmpeg', full);
  exportProc = p;
  let err = '';
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const m = l.match(/^out_time_us=(\d+)/) || l.match(/^out_time_ms=(\d+)/);
      if (m && total > 0 && win) win.webContents.send('export:progress', Math.min(1, Number(m[1]) / 1e6 / total));
    }
  });
  p.stderr.on('data', d => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
  p.on('close', (code, signal) => {
    exportProc = null;
    if (!process.env.LINCUT_KEEPTMP) fs.rmSync(tmpDir, { recursive: true, force: true });
    resolve({ ok: code === 0, canceled: signal === 'SIGTERM' || signal === 'SIGKILL', log: err.slice(-4000) });
  });
  p.on('error', (er) => resolve({ ok: false, log: String(er) }));
}));

ipcMain.handle('export:cancel', () => { if (exportProc) exportProc.kill('SIGTERM'); });

// ---------------------------------------------------------------- сервер нейросетей
// Режим «На сервере»: «Голос и фон», трекинг и вырезание объекта считает другой компьютер (server/lincut_server.py).
// Отправляется только нужный кусок (звук или уменьшенное видео, для выделения — один кадр), результат кладётся
// туда же и в том же виде, что у локальной нейросети, — остальной код разницы не видит.
// Адрес — сам сервер (http://192.168.0.107:8765) или справочная на сайте (…/ai_server.php): у сервера в интернете
// адрес меняется при каждом запуске (Cloudflare Tunnel), справочная знает текущий.
const aiCfg = (c) => {
  const cfg = { mode: c && c.mode === 'remote' ? 'remote' : 'local', url: String((c && c.url) || '').trim().replace(/\/+$/, ''), key: String((c && c.key) || '').trim() };
  if (cfg.url && !/^https?:\/\//.test(cfg.url)) cfg.url = (/\.php$/.test(cfg.url) ? 'https://' : 'http://') + cfg.url;
  return cfg;
};
let AI = aiCfg(null);
const remoteOn = () => AI.mode === 'remote' && !!AI.url;
ipcMain.handle('ai:config', (e, c) => { AI = aiCfg(c); return true; });
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
const aiDir = {};   // справочная → { url, t }
async function aiBase(cfg, fresh) {
  if (!/\.php$/.test(cfg.url)) return cfg.url;
  const c = aiDir[cfg.url];
  if (c && !fresh && Date.now() - c.t < 10 * 60000) return c.url;
  let d;
  try {
    d = await (await fetch(cfg.url, { signal: AbortSignal.timeout(10000) })).json();
  } catch {
    throw new Error('Не удалось узнать адрес сервера нейросетей у сайта — нет сети или сайт недоступен');
  }
  // ноутбук напоминает о себе каждые 5 минут; молчит 15 — значит, выключен или уснул
  if (!d.url || d.age > 15 * 60) throw new Error('Сервер нейросетей сейчас выключен' + (d.url ? '' : ' (компьютер с видеокартой не в сети)'));
  aiDir[cfg.url] = { url: d.url, t: Date.now() };
  return d.url;
}
async function aiApi(p, opts = {}, cfg = AI) {
  let r, base;
  for (let i = 0; i < 2; i++) {
    base = await aiBase(cfg, i > 0);
    try {
      r = await fetch(base + p, { ...opts, headers: { Authorization: 'Bearer ' + cfg.key, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 30000) });
      // туннель без сервера за ним (ноутбук перезапустился с новым адресом) — спросить справочную заново
      if (r.status === 530) { r = null; if (/\.php$/.test(cfg.url)) continue; }
      break;
    } catch (e) {
      r = null;
      if (!/\.php$/.test(cfg.url) || opts.body) break;   // присланный файл повторно не отправляем
    }
  }
  if (!r) throw new Error('Сервер нейросетей недоступен (' + base + ') — он выключен или нет сети');
  if (!r.ok) {
    let m = '';
    try { m = (await r.json()).error; } catch { }
    if (r.status === 413 && !m) m = 'Кусок видео слишком большой для отправки через интернет (больше 100 МБ) — выдели фрагмент короче';
    const er = new Error(m || `Сервер нейросетей ответил ошибкой ${r.status}`);
    er.status = r.status;
    throw er;
  }
  return r;
}
ipcMain.handle('ai:test', async (e, c) => {
  const cfg = aiCfg(c);
  delete aiDir[cfg.url];   // проверка — всегда со свежим адресом от справочной
  return (await aiApi('/api/status', { timeout: 15000 }, cfg)).json();
});
// задача на сервере: отправить файл, ждать (очередь → работа), вернуть id и список готовых файлов
async function aiJob(kind, params, file, onP, ref) {
  const fd = new FormData();
  fd.append('meta', JSON.stringify({ kind, params }));
  fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  onP(0.01, 'upload');
  const j = await (await aiApi('/api/jobs', { method: 'POST', body: fd, timeout: 30 * 60000 })).json();
  ref.id = j.id;
  let fails = 0;
  for (;;) {
    if (ref.canceled) { await aiApi(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => { }); throw new Error('Отменено'); }
    await sleepMs(1000);
    let st;
    try { st = await (await aiApi(`/api/jobs/${j.id}`)).json(); fails = 0; } catch (e) { if (e.status || ++fails > 20) throw e; continue; }
    if (st.state === 'queued') onP(0.03, 'queue', st.pos);
    else if (st.state === 'running') onP(0.05 + st.p * 0.9, 'run');
    else if (st.state === 'done') return j.id;
    else throw new Error(st.error || 'Ошибка на сервере нейросетей');
  }
}
async function aiFetch(id, name, dst) {
  const r = await aiApi(`/api/jobs/${id}/files/${name}`, { timeout: 30 * 60000 });
  fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
}
const aiDone = (id) => aiApi(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => { });
// кусок видео для сервера: длинная сторона ≤ 1024, все кадры источника (без пересчёта частоты)
const aiCut = (src, ss, dur, out) => run('ffmpeg', ['-y', '-v', 'error', '-ss', String(ss), '-t', String(dur), '-i', src, '-an', '-fps_mode', 'passthrough',
  '-vf', "scale=w='if(gt(iw,ih),min(1024,iw),-2)':h='if(gt(iw,ih),-2,min(1024,ih))'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
// распаковка tar (ustar) — маски ротоскопа
function untar(buf, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let o = 0; o + 512 <= buf.length;) {
    const name = buf.toString('utf8', o, o + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.toString('ascii', o + 124, o + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(buf[o + 156] || 48);
    if ((type === '0' || type === '\0') && !name.includes('..')) fs.writeFileSync(path.join(dir, path.basename(name)), buf.subarray(o + 512, o + 512 + size));
    o += 512 + Math.ceil(size / 512) * 512;
  }
}
const aiRefs = { sep: null, trk: null, roto: null };
const aiCancel = (k) => { if (aiRefs[k]) aiRefs[k].canceled = true; };

// ---------------------------------------------------------------- голос и фон (нейросеть)
// Отдельное окружение Python в ~/.local/share/lincut/sep, в систему ничего не ставится.
// LINCUT_AI_HOME — другая папка (проверка установки с нуля, не трогая настоящую)
const SEP_HOME = process.env.LINCUT_AI_HOME ? path.resolve(process.env.LINCUT_AI_HOME) : IS_WIN ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'LinCut') : path.join(os.homedir(), '.local', 'share', 'lincut');
const SEP_ENV = path.join(SEP_HOME, 'sep');
const SEP_PY = IS_WIN ? path.join(SEP_ENV, 'Scripts', 'python.exe') : path.join(SEP_ENV, 'bin', 'python');
const SEP_MODELS = path.join(SEP_HOME, 'models');
const SEP_MODEL = 'model_bs_roformer_ep_317_sdr_12.9755.ckpt';
const SEP_SCRIPT = path.join(__dirname, 'tools', 'separate.py');
const sepSend = (msg) => { if (win) win.webContents.send('sep:progress', msg); };
let sepProc = null, sepChain = Promise.resolve();

// процесс с построчным выводом; при ошибке — хвост журнала
function spawnLines(cmd, args, onLine, env) {
  return new Promise((resolve, reject) => {
    // SAM2_BUILD_CUDA=0 — пакет sam2 не собирает расширение CUDA (на Windows без компилятора иначе не ставится)
    const pr = spawn(cmd, args, { env: { ...process.env, PYTHONUNBUFFERED: '1', SAM2_BUILD_CUDA: '0', ...env }, windowsHide: true });
    sepProc = pr;
    let tail = '', out = '';
    const feed = (buf, isOut) => {
      const t = buf.toString();
      if (isOut) out += t;
      tail = (tail + t).slice(-4000);
      for (const line of t.split(/[\r\n]+/)) if (line.trim()) onLine && onLine(line);
    };
    pr.stdout.on('data', (b) => feed(b, true));
    pr.stderr.on('data', (b) => feed(b, false));
    pr.on('error', (e) => { sepProc = null; reject(new Error(e.code === 'ENOENT' ? `Не найдена программа «${cmd}»` : e.message)); });
    pr.on('close', (code, sig) => {
      sepProc = null;
      if (code === 0) resolve(out);
      else { const err = new Error(sig ? 'Отменено' : tail.trim().split('\n').slice(-6).join('\n')); err.canceled = !!sig; reject(err); }
    });
  });
}

ipcMain.handle('sep:status', () => remoteOn() ? { env: true, model: true, remote: true } : ({ env: fs.existsSync(SEP_PY), model: fs.existsSync(path.join(SEP_MODELS, SEP_MODEL)) }));

// job = { path, a, b, outDir, name }: вырезаем кусок звука и делим его на голос и фон
ipcMain.handle('sep:run', (e, job) => (sepChain = sepChain.catch(() => { }).then(async () => {
  fs.mkdirSync(job.outDir, { recursive: true });
  if (remoteOn()) {
    const flac = path.join(os.tmpdir(), `lincut-sep-${process.pid}-${job.name}.flac`), ref = aiRefs.sep = {};
    sepSend({ name: job.name, p: 0 });
    try {
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(job.a), '-t', String(job.b - job.a), '-i', job.path, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'flac', flac]);
      const id = await aiJob('sep', {}, flac, (p, stage, pos) => sepSend({ name: job.name, p, stage, pos }), ref);
      const voice = path.join(job.outDir, job.name + '_voice.flac'), bg = path.join(job.outDir, job.name + '_bg.flac');
      await aiFetch(id, 'voice.flac', voice);
      await aiFetch(id, 'bg.flac', bg);
      aiDone(id);
      return { voice, bg };
    } finally { fs.rmSync(flac, { force: true }); aiRefs.sep = null; }
  }
  const wav = path.join(os.tmpdir(), `lincut-sep-${process.pid}-${job.name}.wav`);
  sepSend({ name: job.name, p: 0 });
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(job.a), '-t', String(job.b - job.a), '-i', job.path, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav]);
    const out = await spawnLines(SEP_PY, [SEP_SCRIPT, wav, job.outDir, '--models', SEP_MODELS, '--model', SEP_MODEL, '--name', job.name], (l) => {
      const m = /(\d{1,3})%\|/.exec(l);
      if (m) sepSend({ name: job.name, p: Number(m[1]) / 100 });
    });
    const voice = path.join(job.outDir, job.name + '_voice.flac'), bg = path.join(job.outDir, job.name + '_bg.flac');
    if (!fs.existsSync(voice) || !fs.existsSync(bg)) throw new Error('Нейросеть не вернула файлы.\n' + out.slice(-800));
    return { voice, bg };
  } finally {
    fs.rmSync(wav, { force: true });
  }
})));
ipcMain.handle('sep:cancel', () => { aiCancel('sep'); if (sepProc) sepProc.kill('SIGTERM'); });

// ---------------------------------------------------------------- трекинг объекта (SAM 2 / OpenCV)
// Живёт в том же окружении Python, что и нейросеть «Голос и фон»; модель — в ~/.local/share/lincut/models
const TRK_SCRIPT = path.join(__dirname, 'tools', 'track.py');
const TRK_CKPT = 'sam2.1_hiera_small.pt';
const TRK_URL = 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/' + TRK_CKPT;
let trkChain = Promise.resolve(), trkProc = null, trkCanceled = false;
const trkSend = (msg) => { if (win) win.webContents.send('trk:progress', msg); };
// ---------------------------------------------------------------- установка нейросетей
// Одной кнопкой («Файл → Нейросети → Загрузить все») или при первом использовании функции:
// окружение Python (uv) → все библиотеки одним `uv pip install` → модели.
// Прогресс — в байтах: uv заранее пишет размеры больших пакетов («Downloading torch (2.4GiB)»), а сами байты
// считает маленький прокси на 127.0.0.1, через который ходят uv и Python — видна настоящая скорость.
// PyTorch — `--torch-backend auto`: uv смотрит драйвер NVIDIA и берёт подходящую сборку CUDA (без видеокарты — CPU);
// раньше на Windows был жёстко cu128, и uv брал более новую сборку из PyPI — без видеокарты.
const AI_PARTS = {
  voice: { pkgs: ['audio-separator[gpu]', 'audioread'], mods: ['audio_separator'], models: [{ file: SEP_MODEL, size: 639362000, name: 'BS-Roformer' }] },
  track: { pkgs: ['sam2', 'opencv-contrib-python-headless'], mods: ['sam2', 'cv2'], models: [{ file: TRK_CKPT, size: 184416285, url: TRK_URL, name: 'SAM 2' }] },
};
const pyHas = (mods) => new Promise((resolve) => {
  if (!fs.existsSync(SEP_PY)) return resolve(false);
  // find_spec — пакет на месте, без импорта (импорт torch занял бы секунды)
  execFile(SEP_PY, ['-c', `import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ${JSON.stringify(mods)}) else 1)`], (err) => resolve(!err));
});
const modelHas = (m) => fs.existsSync(path.join(SEP_MODELS, m.file));
ipcMain.handle('ai:status', async () => {
  const parts = {};
  await Promise.all(Object.entries(AI_PARTS).map(async ([k, P]) => {
    const pkgs = await pyHas(P.mods), models = P.models.every(modelHas);
    parts[k] = { pkgs, models, ready: pkgs && models, size: P.models.reduce((s, m) => s + (modelHas(m) ? 0 : m.size), 0) };
  }));
  return { env: fs.existsSync(SEP_PY), home: IS_WIN ? SEP_HOME : SEP_HOME.replace(os.homedir(), '~'), parts, busy: !!inst };
});
// «Готово: трекинг» — для старых вызовов (trk:status) пакеты проверяет pyHas
const trkPkgs = () => pyHas(AI_PARTS.track.mods);
ipcMain.handle('trk:status', async () => remoteOn() ? { env: true, pkgs: true, model: true, remote: true } : ({ env: fs.existsSync(SEP_PY), pkgs: await trkPkgs(), model: fs.existsSync(path.join(SEP_MODELS, TRK_CKPT)) }));

// HTTPS-прокси, который только пересылает байты и считает их (CONNECT-туннель, содержимое не видит)
function byteProxy(onBytes) {
  const http = require('http'), net = require('net');
  const srv = http.createServer((req, res) => { res.writeHead(501); res.end(); });
  const socks = new Set();
  srv.on('connect', (req, sock, head) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
    if (!m) return sock.destroy();
    const up = net.connect(Number(m[2]), m[1]);
    socks.add(up); socks.add(sock);
    up.once('connect', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('data', (b) => onBytes(b.length));
    const end = () => { up.destroy(); sock.destroy(); socks.delete(up); socks.delete(sock); };
    up.on('error', end); sock.on('error', end); up.on('close', end); sock.on('close', end);
  });
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port, close: () => { for (const s of socks) s.destroy(); srv.close(); } }));
  });
}
const uvSize = (s) => { const m = /([\d.]+)\s*([KMG]?)i?B/.exec(s); return m ? Number(m[1]) * { '': 1, K: 1024, M: 1048576, G: 1073741824 }[m[2]] : 0; };

let inst = null, instChain = Promise.resolve();
const instSend = (msg) => { if (win) win.webContents.send('ai:install', msg); };
async function aiInstall(parts) {
  const st = inst = { canceled: false, ac: new AbortController() };
  const halt = () => { if (st.canceled) { const e = new Error('Отменено'); e.canceled = true; throw e; } };
  fs.mkdirSync(SEP_MODELS, { recursive: true });
  // что именно нужно: пакеты ставим одним списком (одно разрешение зависимостей), модели — по одной
  const env0 = fs.existsSync(SEP_PY), pkgs = [], models = [];
  for (const k of parts) {
    const P = AI_PARTS[k];
    if (!env0 || !(await pyHas(P.mods))) pkgs.push(...P.pkgs);
    for (const m of P.models) if (!modelHas(m)) models.push(m);
  }
  // pr: done — байты законченных шагов, cur/curTotal — текущий шаг, rest — ещё не начатые модели
  const pr = { stage: '', text: '', done: 0, cur: 0, curTotal: 0, rest: models.reduce((s, m) => s + m.size, 0), raw: 0, known: !pkgs.length };
  const own = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].some(k => process.env[k]);   // свой прокси пользователя не трогаем
  const proxy = own ? null : await byteProxy((n) => { pr.raw += n; pr.cur += n; }).catch(() => null);
  const penv = proxy ? { HTTPS_PROXY: proxy.url, https_proxy: proxy.url } : {};
  const hist = [];
  const send = () => {
    const now = Date.now();
    hist.push([now, pr.raw]);
    while (hist.length > 2 && now - hist[0][0] > 6000) hist.shift();
    const dt = (now - hist[0][0]) / 1000, speed = dt > 0.5 ? (pr.raw - hist[0][1]) / dt : 0;
    const total = pr.done + pr.curTotal + pr.rest;
    instSend({ stage: pr.stage, text: pr.text, known: pr.known && total > 0, got: pr.done + Math.min(pr.cur, pr.curTotal), total, speed });
  };
  const timer = setInterval(send, 400);
  const step = (stage, text, size) => { pr.stage = stage; pr.text = text; pr.cur = 0; pr.curTotal = size; send(); };
  const finish = () => { pr.done += pr.curTotal; pr.cur = 0; pr.curTotal = 0; };
  try {
    if (!env0) {
      step('env', 'Подготовка Python…', 0);
      await spawnLines('uv', ['venv', '--python', '3.12', SEP_ENV], null, penv);
      halt();
    }
    if (pkgs.length) {
      step('pip', 'Загрузка библиотек (PyTorch, CUDA)…', 0);
      const sizes = {};
      let got = 0;   // без прокси — считаем по завершённым пакетам
      await spawnLines('uv', ['pip', 'install', '--python', SEP_PY, '--torch-backend', 'auto', ...pkgs], (l) => {
        let m;
        if ((m = /^\s*Downloading\s+(\S+)\s+\((.+)\)/.exec(l))) { sizes[m[1]] = uvSize(m[2]); pr.curTotal += sizes[m[1]]; pr.known = true; }
        else if ((m = /^\s*Downloaded\s+(\S+)/.exec(l))) {
          got += sizes[m[1]] || 0;
          if (!proxy) pr.cur = got;
          if (got >= pr.curTotal) pr.text = 'Установка библиотек…';
        } else if (/^\s*Prepared\s/.test(l)) pr.text = 'Установка библиотек…';
      }, penv);
      pr.known = true;
      finish(); halt();
    }
    for (const m of models) {
      pr.rest -= m.size;
      step('model', `Загрузка модели ${m.name}…`, m.size);
      if (m.url) {
        // SAM 2 — просто файл: качаем сами
        const dst = path.join(SEP_MODELS, m.file), tmp = dst + '.part';
        const r = await fetch(m.url, { signal: st.ac.signal });
        if (!r.ok) throw new Error('Не удалось скачать модель: HTTP ' + r.status);
        pr.curTotal = Number(r.headers.get('content-length')) || m.size;
        const out = fs.createWriteStream(tmp);
        try {
          for await (const chunk of r.body) {
            if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
            pr.cur += chunk.length; pr.raw += chunk.length;
          }
          await new Promise((res, rej) => out.end((e) => e ? rej(e) : res()));
        } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw st.canceled ? Object.assign(new Error('Отменено'), { canceled: true }) : e; }
        fs.renameSync(tmp, dst);
      } else {
        // BS-Roformer качает сам audio-separator (модель + её настройки) — байты видит прокси
        await spawnLines(SEP_PY, [SEP_SCRIPT, '-', SEP_MODELS, '--models', SEP_MODELS, '--model', m.file, '--download-only'], (l) => {
          const t = /(\d{1,3})%\|.*?([\d.]+[kMG]?)\/([\d.]+[kMG])/.exec(l);
          if (t && !proxy) pr.cur = Number(t[1]) / 100 * m.size;
        }, penv);
      }
      finish(); halt();
    }
    pr.text = 'Готово'; send();
    return true;
  } catch (e) {
    if (st.canceled) { const er = new Error('Отменено'); er.canceled = true; throw er; }
    throw e;
  } finally {
    clearInterval(timer);
    if (proxy) proxy.close();
    inst = null;
  }
}
// parts — ['voice', 'track'] (что нужно поставить); по одной установке за раз
ipcMain.handle('ai:install', (e, parts) => (instChain = instChain.catch(() => { }).then(() => aiInstall((parts || Object.keys(AI_PARTS)).filter(k => AI_PARTS[k])))));
ipcMain.handle('ai:installCancel', () => {
  if (!inst) return;
  inst.canceled = true;
  inst.ac.abort();
  if (sepProc) sepProc.kill('SIGTERM');
});
app.on('will-quit', () => { if (inst) { inst.canceled = true; inst.ac.abort(); if (sepProc) sepProc.kill('SIGTERM'); } });
// job = { name, path, a, b, t0, box: [x, y, w, h], engine, fps }
async function trkRemote(job) {
  const cut = path.join(os.tmpdir(), `lincut-trk-${process.pid}-${job.name}.mp4`), ref = aiRefs.trk = {};
  trkSend({ name: job.name, p: 0 });
  try {
    await aiCut(job.path, job.a, job.b - job.a, cut);
    const id = await aiJob('trk', { dur: job.b - job.a, t0: job.t0 - job.a, box: job.box, engine: job.engine || 'sam2', fps: job.fps || 30 }, cut,
      (p, stage, pos) => trkSend({ name: job.name, p, stage, pos }), ref);
    const out = cut + '.json';
    await aiFetch(id, 'track.json', out);
    aiDone(id);
    const r = JSON.parse(fs.readFileSync(out, 'utf8'));
    fs.rmSync(out, { force: true });
    // время на сервере — от начала присланного куска
    r.a = job.a;
    for (const p of r.pts) p[0] = Math.round((p[0] + job.a) * 1e5) / 1e5;
    return r;
  } finally { fs.rmSync(cut, { force: true }); aiRefs.trk = null; }
}
ipcMain.handle('trk:run', (e, job) => remoteOn() ? (trkChain = trkChain.catch(() => { }).then(() => trkRemote(job))) : (trkChain = trkChain.catch(() => { }).then(() => new Promise((resolve, reject) => {
  trkCanceled = false;
  const out = path.join(os.tmpdir(), `lincut-trk-${process.pid}-${job.name}.json`);
  const p = spawn(SEP_PY, [TRK_SCRIPT, job.path, '--a', String(job.a), '--b', String(job.b), '--t0', String(job.t0), '--box', ...job.box.map(String),
    '--out', out, '--engine', job.engine || 'sam2', '--fps', String(job.fps || 30), '--models', SEP_MODELS], { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  trkProc = p;
  let err = '', buf = '';
  trkSend({ name: job.name, p: 0 });
  p.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { const m = /^PROGRESS ([\d.]+)/.exec(l); if (m) trkSend({ name: job.name, p: Number(m[1]) }); }
  });
  p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
  p.on('error', reject);
  p.on('close', (code) => {
    trkProc = null;
    if (trkCanceled) { fs.rmSync(out, { force: true }); return reject(new Error('Отменено')); }
    if (code !== 0 || !fs.existsSync(out)) return reject(new Error(err.trim().split('\n').filter(l => !/Warning|warn\(/.test(l)).slice(-6).join('\n') || 'Трекер завершился с ошибкой'));
    try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch (x) { reject(x); } finally { fs.rmSync(out, { force: true }); }
  });
}))));
ipcMain.handle('trk:cancel', () => { aiCancel('trk'); trkCanceled = true; if (trkProc) trkProc.kill('SIGTERM'); });

// ---------------------------------------------------------------- ротоскоп (Roto Brush, SAM 2)
// Живой процесс для выделения (модель загружена, маска кадра за доли секунды) и долгий проход по всем кадрам.
const ROTO_SCRIPT = path.join(__dirname, 'tools', 'roto.py');
let rotoSrv = null, rotoSrvReady = null, rotoReq = 0;
const rotoWait = new Map();
const rotoSend = (msg) => { if (win) win.webContents.send('roto:progress', msg); };
function rotoServe() {
  if (rotoSrv) return rotoSrvReady;
  const p = spawn(SEP_PY, [ROTO_SCRIPT, 'serve', '--models', SEP_MODELS], { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  rotoSrv = p;
  let buf = '', err = '';
  rotoSrvReady = new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.ready) { resolve(m); continue; }
        const w = rotoWait.get(m.id);
        if (w) { rotoWait.delete(m.id); m.ok ? w.resolve(m) : w.reject(new Error(m.error || 'Ошибка нейросети')); }
      }
    });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', () => {
      if (rotoSrv === p) rotoSrv = null;
      const e = new Error(err.trim().split('\n').filter(l => !/Warning|warn\(/.test(l)).slice(-4).join('\n') || 'Нейросеть остановилась');
      reject(e);
      for (const w of rotoWait.values()) w.reject(e);
      rotoWait.clear();
    });
  });
  rotoSrvReady.catch(() => { });
  return rotoSrvReady;
}
function rotoStop() {
  if (!rotoSrv) return;
  const p = rotoSrv; rotoSrv = null;
  try { p.stdin.write('{"cmd":"quit"}\n'); } catch { }
  setTimeout(() => { try { p.kill('SIGTERM'); } catch { } }, 1500);
}
// job = { video, ss, pts, box, out? } → { out, score }
const aiFrames = new Map(); // `${video}|${ss}` → { file, fid }
async function rotoMaskRemote(job) {
  const key = job.video + '|' + job.ss;
  let fr = aiFrames.get(key);
  if (!fr) {
    const file = path.join(os.tmpdir(), `lincut-frame-${process.pid}-${aiFrames.size}.jpg`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(job.ss), '-i', job.video, '-frames:v', '1', '-an',
      '-vf', "scale=w='if(gt(iw,ih),min(1024,iw),-2)':h='if(gt(iw,ih),-2,min(1024,ih))'", '-q:v', '2', file]);
    fr = { file, fid: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') };
    aiFrames.set(key, fr);
  }
  const ask = () => aiApi('/api/mask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fid: fr.fid, pts: job.pts || [], box: job.box || null }), timeout: 90000 });
  let r;
  try { r = await ask(); } catch (e) {
    if (e.status !== 409) throw e;
    await aiApi(`/api/frames/${fr.fid}`, { method: 'PUT', body: fs.readFileSync(fr.file), timeout: 60000 });
    r = await ask();
  }
  const out = path.join(os.tmpdir(), `lincut-roto-${process.pid}-${++rotoReq}.png`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return { out, score: Number(r.headers.get('x-score')) || 0 };
}
ipcMain.handle('roto:mask', async (e, job) => {
  if (remoteOn()) return rotoMaskRemote(job);
  await rotoServe();
  const id = ++rotoReq;
  const out = job.out || path.join(os.tmpdir(), `lincut-roto-${process.pid}-${id}.png`);
  const res = new Promise((resolve, reject) => rotoWait.set(id, { resolve, reject }));
  rotoSrv.stdin.write(JSON.stringify({ id, cmd: 'mask', video: job.video, ss: job.ss, pts: job.pts || [], box: job.box || null, maxside: 1024, out }) + '\n');
  return res;
});
ipcMain.handle('roto:stop', () => rotoStop());
let rotoChain = Promise.resolve(), rotoProc = null, rotoCanceled = false;
// job = { name, video, a, b, fps, prompts: [{ k, pts, box }], out } → meta
async function rotoRemote(job) {
  const ss = Math.max(0, job.a - 0.25 / job.fps);
  const cut = path.join(os.tmpdir(), `lincut-rotoin-${process.pid}-${job.name}.mp4`), ref = aiRefs.roto = {};
  rotoSend({ name: job.name, p: 0 });
  try {
    await aiCut(job.video, ss, job.b - ss, cut);
    const id = await aiJob('roto', { dur: job.b - ss, fps: job.fps, prompts: job.prompts }, cut, (p, stage, pos) => rotoSend({ name: job.name, p, stage, pos }), ref);
    const tar = cut + '.tar';
    await aiFetch(id, 'masks.tar', tar);
    aiDone(id);
    fs.rmSync(job.out, { recursive: true, force: true });
    untar(fs.readFileSync(tar), job.out);
    fs.rmSync(tar, { force: true });
    const meta = JSON.parse(fs.readFileSync(path.join(job.out, 'meta.json'), 'utf8'));
    meta.a = job.a;
    fs.writeFileSync(path.join(job.out, 'meta.json'), JSON.stringify(meta));
    return meta;
  } finally { fs.rmSync(cut, { force: true }); aiRefs.roto = null; }
}
ipcMain.handle('roto:run', (e, job) => remoteOn() ? (rotoChain = rotoChain.catch(() => { }).then(() => rotoRemote(job))) : (rotoChain = rotoChain.catch(() => { }).then(() => new Promise((resolve, reject) => {
  rotoStop(); // видеопамять нужна целиком
  rotoCanceled = false;
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  const p = spawn(SEP_PY, [ROTO_SCRIPT, 'run', job.video, '--a', String(job.a), '--b', String(job.b), '--fps', String(job.fps),
    '--prompts', JSON.stringify(job.prompts), '--out', job.out, '--models', SEP_MODELS], { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  rotoProc = p;
  let err = '', buf = '';
  rotoSend({ name: job.name, p: 0 });
  p.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { const m = /^PROGRESS ([\d.]+)/.exec(l); if (m) rotoSend({ name: job.name, p: Number(m[1]) }); }
  });
  p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
  p.on('error', reject);
  p.on('close', (code) => {
    rotoProc = null;
    if (rotoCanceled) return reject(new Error('Отменено'));
    const meta = path.join(job.out, 'meta.json');
    if (code !== 0 || !fs.existsSync(meta)) return reject(new Error(err.trim().split('\n').filter(l => !/Warning|warn\(|propagate in video/.test(l)).slice(-6).join('\n') || 'Нейросеть завершилась с ошибкой'));
    try { resolve(JSON.parse(fs.readFileSync(meta, 'utf8'))); } catch (x) { reject(x); }
  });
}))));
ipcMain.handle('roto:cancel', () => { aiCancel('roto'); rotoCanceled = true; if (rotoProc) rotoProc.kill('SIGTERM'); });
app.on('will-quit', () => rotoStop());

// ---------------------------------------------------------------- стабилизация
// job = { name, path, a, b, smooth, out }: vidstab в два прохода (замер тряски → выравнивание с приближением),
// результат — видео без звука того же куска источника; прогресс 0–0,5 — замер, 0,5–1 — сборка
let stabChain = Promise.resolve(), stabProc = null, stabCanceled = false;
const stabSend = (msg) => { if (win) win.webContents.send('stab:progress', msg); };
// путь к файлу в параметре фильтра ffmpeg (C:\ → C\:/)
const ffq = (p) => `'${String(p).replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
function ffProgress(args, dur, onP) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', ...args]);
    stabProc = p;
    let err = '', buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) { const m = /^out_time_us=(\d+)/.exec(l); if (m) onP(Math.min(1, Number(m[1]) / 1e6 / dur)); }
    });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => { stabProc = null; if (stabCanceled) reject(new Error('Отменено')); else if (code === 0) resolve(); else reject(new Error(err.trim().split('\n').slice(-4).join('\n'))); });
  });
}
ipcMain.handle('stab:run', (e, job) => (stabChain = stabChain.catch(() => { }).then(async () => {
  stabCanceled = false;
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  const trf = path.join(os.tmpdir(), `lincut-stab-${process.pid}-${job.name}.trf`);
  const dur = job.b - job.a, cut = ['-ss', String(job.a), '-t', String(dur), '-i', job.path];
  try {
    stabSend({ name: job.name, p: 0 });
    await ffProgress([...cut, '-an', '-vf', `vidstabdetect=shakiness=8:accuracy=15:result=${ffq(trf)}`, '-f', 'null', '-'], dur, (p) => stabSend({ name: job.name, p: p * 0.5 }));
    await ffProgress([...cut, '-an', '-vf', `vidstabtransform=input=${ffq(trf)}:smoothing=${job.smooth}:optzoom=1:zoomspeed=0.2:interpol=bicubic,unsharp=5:5:0.5:3:3:0.2`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '15', '-pix_fmt', 'yuv420p', '-g', '15', '-movflags', '+faststart', job.out], dur, (p) => stabSend({ name: job.name, p: 0.5 + p * 0.5 }));
    return job.out;
  } catch (err) {
    fs.rmSync(job.out, { force: true });
    throw err;
  } finally {
    fs.rmSync(trf, { force: true });
  }
})));
ipcMain.handle('stab:cancel', () => { stabCanceled = true; if (stabProc) stabProc.kill('SIGTERM'); });

// ---------------------------------------------------------------- изменение голоса
// job = { path, ss, t, graph, out }: кусок звука через цепочку фильтров пресета ([in] → [out]),
// затем громкость выравнивается под исходник, чтобы ползунок «Громкость» значил то же, что и без эффекта
const meanDb = async (file, pre = []) => {
  const r = await new Promise((res) => execFile('ffmpeg', ['-hide_banner', ...pre, '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 1 << 26 }, (err, so, se) => res(String(se))));
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r);
  return m && m[1] !== '-inf' ? Number(m[1]) : -91;
};
ipcMain.handle('vfx:render', (e, job) => enqueue(async () => {
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  const tmp = path.join(os.tmpdir(), `lincut-vfx-${process.pid}-${path.basename(job.out)}.wav`);
  const cut = ['-ss', String(job.ss), '-t', String(job.t)];
  try {
    const graph = `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[in];${job.graph};[out]atrim=0:${job.t}[fx]`;
    await run('ffmpeg', ['-y', '-v', 'error', ...cut, '-i', job.path, '-vn', '-filter_complex', graph, '-map', '[fx]', '-c:a', 'pcm_f32le', tmp]);
    const [src, fx] = await Promise.all([meanDb(job.path, cut), meanDb(tmp)]);
    const gain = job.norm === false || src <= -90 || fx <= -90 ? 0 : Math.max(-12, Math.min(24, src - fx));
    await run('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.97:level=disabled,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=s32`, '-c:a', 'flac', job.out]);
    return job.out;
  } catch (err) {
    throw new Error((err.stderr || err.message || '').trim().split('\n').slice(-4).join('\n'));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}));
