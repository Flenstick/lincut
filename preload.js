const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

let progressCb = null;
ipcRenderer.on('export:progress', (e, v) => progressCb && progressCb(v));
const urlCbs = new Set();
ipcRenderer.on('url:progress', (e, v) => urlCbs.forEach(cb => cb(v)));
const aiInstCbs = new Set(), updCbs = new Set();
ipcRenderer.on('ai:install', (e, v) => aiInstCbs.forEach(cb => cb(v)));
ipcRenderer.on('upd:state', (e, v) => updCbs.forEach(cb => cb(v)));
const sepCbs = new Set(), stabCbs = new Set(), trkCbs = new Set(), rotoCbs = new Set();
ipcRenderer.on('roto:progress', (e, v) => rotoCbs.forEach(cb => cb(v)));
ipcRenderer.on('trk:progress', (e, v) => trkCbs.forEach(cb => cb(v)));
ipcRenderer.on('stab:progress', (e, v) => stabCbs.forEach(cb => cb(v)));
ipcRenderer.on('sep:progress', (e, v) => sepCbs.forEach(cb => cb(v)));

// палитра angelOS (тема «Как в системе»): читается синхронно, чтобы при запуске не мелькала стандартная тема
const fs = require('fs'), path = require('path'), os = require('os');
const PALETTE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'angelos', 'palette.json');
const readPalette = () => { try { return JSON.parse(fs.readFileSync(PALETTE, 'utf8')); } catch { return null; } };

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  saveExport: (name) => ipcRenderer.invoke('dialog:saveExport', name),
  pickFolder: (def) => ipcRenderer.invoke('dialog:pickFolder', def),
  paths: () => ipcRenderer.invoke('app:paths'),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  setTitle: (t) => ipcRenderer.invoke('win:setTitle', t),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMax: () => ipcRenderer.invoke('win:toggleMax'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMax: () => ipcRenderer.invoke('win:isMax'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (e, v) => cb(v)),
  fonts: () => ipcRenderer.invoke('fonts:list'),
  systemPalette: readPalette,
  // angelOS переписывает файл целиком при смене палитры — опрашиваем раз в секунду
  onSystemPalette: (cb) => fs.watchFile(PALETTE, { interval: 1000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) cb(readPalette()); }),

  probe: (p) => ipcRenderer.invoke('media:probe', p),
  thumbs: (info) => ipcRenderer.invoke('media:thumbs', info),
  waveform: (info) => ipcRenderer.invoke('media:waveform', info),
  proxy: (info) => ipcRenderer.invoke('media:proxy', info),
  frame: (file, t, projectId) => ipcRenderer.invoke('media:frame', file, t, projectId),

  listProjects: () => ipcRenderer.invoke('project:list'),
  createProject: () => ipcRenderer.invoke('project:create'),
  loadProject: (id) => ipcRenderer.invoke('project:load', id),
  saveProject: (id, json, cover) => ipcRenderer.invoke('project:save', id, json, cover),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  renameProject: (id, name) => ipcRenderer.invoke('project:rename', id, name),
  duplicateProject: (id) => ipcRenderer.invoke('project:duplicate', id),

  saveVoice: (id, buf) => ipcRenderer.invoke('voice:save', id, buf),

  writeTemp: (name, data) => ipcRenderer.invoke('export:writeTemp', name, data),
  linkSeq: (name, files) => ipcRenderer.invoke('export:linkSeq', name, files),
  runExport: (args, total) => ipcRenderer.invoke('export:run', args, total),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => { progressCb = cb; },
  writeProjectFile: (id, name, data) => ipcRenderer.invoke('project:writeFile', id, name, data),

  sepStatus: () => ipcRenderer.invoke('sep:status'),
  sepRun: (job) => ipcRenderer.invoke('sep:run', job),
  sepCancel: () => ipcRenderer.invoke('sep:cancel'),
  onSepProgress: (cb) => { sepCbs.add(cb); return () => sepCbs.delete(cb); },
  vfxRender: (job) => ipcRenderer.invoke('vfx:render', job),
  stabRun: (job) => ipcRenderer.invoke('stab:run', job),
  trkStatus: () => ipcRenderer.invoke('trk:status'),
  trkRun: (job) => ipcRenderer.invoke('trk:run', job),
  trkCancel: () => ipcRenderer.invoke('trk:cancel'),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipSaveImage: (id) => ipcRenderer.invoke('clip:saveImage', id),
  urlStatus: () => ipcRenderer.invoke('url:status'),
  urlInfo: (url) => ipcRenderer.invoke('url:info', url),
  urlDownload: (job) => ipcRenderer.invoke('url:download', job),
  urlCancel: (name) => ipcRenderer.invoke('url:cancel', name),
  onUrlProgress: (cb) => { urlCbs.add(cb); return () => urlCbs.delete(cb); },
  aiConfig: (c) => ipcRenderer.invoke('ai:config', c),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiInstall: (parts) => ipcRenderer.invoke('ai:install', parts),
  aiInstallCancel: () => ipcRenderer.invoke('ai:installCancel'),
  onAiInstall: (cb) => { aiInstCbs.add(cb); return () => aiInstCbs.delete(cb); },
  updState: () => ipcRenderer.invoke('upd:state'),
  updCheck: () => ipcRenderer.invoke('upd:check'),
  updInstall: () => ipcRenderer.invoke('upd:install'),
  onUpdState: (cb) => { updCbs.add(cb); return () => updCbs.delete(cb); },
  aiTest: (c) => ipcRenderer.invoke('ai:test', c),
  rotoMask: (job) => ipcRenderer.invoke('roto:mask', job),
  rotoStop: () => ipcRenderer.invoke('roto:stop'),
  rotoRun: (job) => ipcRenderer.invoke('roto:run', job),
  rotoCancel: () => ipcRenderer.invoke('roto:cancel'),
  onRotoProgress: (cb) => { rotoCbs.add(cb); return () => rotoCbs.delete(cb); },
  onTrkProgress: (cb) => { trkCbs.add(cb); return () => trkCbs.delete(cb); },
  stabCancel: () => ipcRenderer.invoke('stab:cancel'),
  onStabProgress: (cb) => { stabCbs.add(cb); return () => stabCbs.delete(cb); },

  debugShot: (f) => ipcRenderer.invoke('debug:shot', f),
  fileUrl: (p) => pathToFileURL(p).href,
  pathForFile: (f) => webUtils.getPathForFile(f),
});
