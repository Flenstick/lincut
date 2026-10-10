// Плагины: загрузка из папки плагинов (lincut-plugin://<id>/…), API для плагинов (объект lc), окно «Плагины».
// Документация для авторов — docs/plugins.md. Плагин — это обычный скрипт, который вызывает
//   LinCut.plugin((lc) => { … })
// и через lc добавляет команды, эффекты, фильтры, переходы, голоса, панели, секции инспектора и т. д.
// Всё, что зарегистрировано через lc, работает и в превью, и в экспорте так же, как встроенное.

// эффекты-переходы из плагинов: id → (p) => ops (см. transFxOps в effects.js)
const PLUGIN_TRANS = {};

const LinCut = {
  apiVersion: 1,
  version: '',
  // вызывается из main.js плагина во время его загрузки
  plugin(setup) {
    const s = document.currentScript, P = s && Plugins.byId[s.dataset.plugin];
    if (!P) { console.warn('LinCut.plugin() можно вызывать только из главного файла плагина при загрузке'); return; }
    if (typeof setup !== 'function') { P.error = 'LinCut.plugin(): нужно передать функцию (lc) => { … }'; return; }
    P.setup = setup;
  },
};

// «Ctrl+Shift+H» → { ctrl, shift, alt, code|key }. Буквы и цифры сравниваются по физической клавише,
// поэтому сочетания работают и в русской раскладке
const KEY_NAMES = { del: 'delete', delete: 'delete', esc: 'escape', escape: 'escape', enter: 'enter', tab: 'tab', backspace: 'backspace',
  space: ' ', 'пробел': ' ', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', insert: 'insert',
  left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown', '←': 'arrowleft', '→': 'arrowright', '↑': 'arrowup', '↓': 'arrowdown' };
function parseKey(str) {
  const parts = String(str).split('+').map(s => s.trim()).filter(Boolean);
  if (String(str).trim().endsWith('++')) parts.push('+');
  const last = parts.pop() || '', mods = new Set(parts.map(p => p.toLowerCase()));
  const k = { ctrl: mods.has('ctrl') || mods.has('cmd') || mods.has('meta'), shift: mods.has('shift'), alt: mods.has('alt') };
  if (/^[a-z]$/i.test(last)) k.code = 'Key' + last.toUpperCase();
  else if (/^\d$/.test(last)) k.code = 'Digit' + last;
  else if (/^f\d{1,2}$/i.test(last)) k.key = last.toLowerCase();
  else k.key = KEY_NAMES[last.toLowerCase()] || last.toLowerCase();
  return k;
}
function keyMatches(k, e) {
  if (!!(e.ctrlKey || e.metaKey) !== k.ctrl || e.shiftKey !== k.shift || e.altKey !== k.alt) return false;
  return k.code ? e.code === k.code : e.key.toLowerCase() === k.key;
}

const Plugins = {
  list: [],          // { id, folder, dir, manifest, main, enabled, error, loaded, api, setup }
  byId: {},
  info: null,        // папки, версия, режим разработчика
  commands: [],      // { P, id, label, icon, key, menu, run, enabled, k }
  panels: {},        // ключ панели → { P, def, render } — все панели плагинов в одной вкладке «Плагины»
  inspTabs: [],      // { P, id, def }
  inspSecs: [],      // { P, tab, def }
  clipMenus: [],     // { P, fn }
  changed: false,    // включение/выключение ждёт перезагрузки

  init() {
    // ошибки в коде плагина (в том числе синтаксические и в отложенных функциях) — к своему плагину
    const owner = (s) => { const m = /lincut-plugin:\/\/([a-z0-9-]+)\//.exec(s || ''); return m && this.byId[m[1]]; };
    window.addEventListener('error', (e) => { const P = owner(e.filename) || owner(e.error && e.error.stack); if (P) this.fail(P, e.error || e.message, P.loaded ? '' : 'при загрузке'); });
    window.addEventListener('unhandledrejection', (e) => { const P = owner(e.reason && e.reason.stack); if (P) this.fail(P, e.reason); });
    window.api.plugins.onChanged(() => { if (this.info && this.info.dev) this.reload(true); });
    $('#homePlugins').onclick = () => this.manager();
  },

  // ---------------------------------------------------------------- загрузка
  async load() {
    let r;
    try { r = await window.api.plugins.list(); } catch (e) { console.error('Плагины:', e); return; }
    this.info = r;
    LinCut.version = r.version;
    this.list = r.plugins;
    this.byId = Object.fromEntries(this.list.map(P => [P.id, P]));
    for (const P of this.list) {
      P.errors = [];
      if (!P.enabled || P.error) continue;
      try {
        if (P.manifest.style) this.link(P, P.manifest.style);
        if (!(await this.script(P))) continue;
        if (P.error) continue;
        if (!P.setup) { P.error = 'Плагин не вызвал LinCut.plugin((lc) => { … })'; continue; }
        P.api = this.makeApi(P);
        await P.setup(P.api);
        P.loaded = true;
      } catch (e) {
        P.error = errText(e);
        console.error(`[плагин ${P.id}]`, e);
      }
    }
    const bad = this.list.filter(P => P.enabled && P.error);
    if (bad.length) toast(bad.length === 1 ? `Плагин «${bad[0].manifest.name || bad[0].id}» не загрузился: ${bad[0].error}` : `Не загрузились плагины: ${bad.length}. Подробности — «Плагины → Управление плагинами»`, 'error', 5000);
    this.ready = true;
    this.renderPanelTabs();
    bus.emit('plugins:ready');
  },
  url(P, rel) { return `lincut-plugin://${P.id}/${String(rel).replace(/^\.?\/+/, '').split('/').map(encodeURIComponent).join('/')}`; },
  script(P) {
    return new Promise((res) => {
      const s = document.createElement('script');
      s.crossOrigin = 'anonymous'; // чтобы видеть текст ошибок плагина (см. main-plugins.js)
      s.src = this.url(P, P.main);
      s.dataset.plugin = P.id;
      s.onload = () => res(true);
      s.onerror = () => { P.error = 'Не удалось загрузить ' + P.main; res(false); };
      document.head.appendChild(s);
    });
  },
  link(P, rel) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = this.url(P, rel); l.dataset.plugin = P.id;
    document.head.appendChild(l);
  },

  // Ошибка в коде плагина: в консоль, в окно «Плагины» и (не чаще раза в 4 с) тостом
  fail(P, e, where = '') {
    const msg = errText(e);
    console.error(`[плагин ${P.id}]${where ? ' ' + where : ''}`, e);
    if (!P.loaded && where) { P.error = msg; return; }
    P.errors = P.errors || [];
    P.errors.push({ t: Date.now(), msg: (where ? where + ': ' : '') + msg });
    if (P.errors.length > 20) P.errors.shift();
    const now = Date.now();
    if (!P.lastToast || now - P.lastToast > 4000) { P.lastToast = now; toast(`Плагин «${P.manifest.name || P.id}»: ${msg}`, 'error', 4000); }
  },
  // обёртка для функций плагина: ошибка не ломает редактор
  guard(P, fn, where, fallback) {
    if (typeof fn !== 'function') return () => fallback;
    return (...a) => {
      try {
        const r = fn(...a);
        if (r && typeof r.then === 'function') return r.catch(e => { this.fail(P, e, where); return fallback; });
        return r;
      } catch (e) { this.fail(P, e, where); return fallback; }
    };
  },

  // Перезагрузить окно со всеми плагинами; открытый проект откроется снова
  async reload(quiet) {
    if (store.p) {
      await App.save();
      try { sessionStorage.setItem('lc.reopen', store.p.id); } catch { }
    }
    if (!quiet) try { sessionStorage.setItem('lc.pluginsReloaded', '1'); } catch { }
    location.reload();
  },
  // после перезагрузки: вернуть проект
  async afterStart() {
    let id = null, note = null;
    try { id = sessionStorage.getItem('lc.reopen'); note = sessionStorage.getItem('lc.pluginsReloaded'); sessionStorage.removeItem('lc.reopen'); sessionStorage.removeItem('lc.pluginsReloaded'); } catch { }
    if (id) await App.openProject(id);
    if (note) toast(`Плагины перезагружены: ${this.list.filter(P => P.loaded).length}`, 'ok', 1600);
  },

  // ---------------------------------------------------------------- точки встраивания в редактор
  key(e) {
    for (const c of this.commands) {
      if (!c.k || !keyMatches(c.k, e)) continue;
      if (c.enabled && !c.enabled()) return false;
      c.run();
      return true;
    }
    return false;
  },
  cmdItem(c) { return { label: c.label, icon: c.icon, key: c.key, disabled: c.enabled ? !c.enabled() : false, onClick: () => c.run() }; },
  // пункты меню «Плагины» и команды плагинов в других меню
  extendMenus(m) {
    const own = this.commands.filter(c => c.menu === 'plugins');
    m.plugins = [
      { label: 'Магазин плагинов…', icon: 'storefront', onClick: () => Shop.open() },
      { label: 'Управление плагинами…', icon: 'puzzle', onClick: () => this.manager() },
      { label: 'Перезагрузить плагины', icon: 'reset', key: 'Ctrl+Shift+R', onClick: () => this.reload() },
      '-',
      { label: 'Установить плагин…', icon: 'download', onClick: () => this.installDialog() },
      { label: 'Создать плагин…', icon: 'code', onClick: () => this.createDialog() },
      { label: 'Открыть папку плагинов', icon: 'folder', onClick: () => window.api.openPath(this.info.dir) },
      { label: 'Как написать плагин', icon: 'book', onClick: () => window.api.plugins.openExternal(this.info.docs) },
    ];
    if (own.length) {
      m.plugins.push('-');
      let last = null;
      for (const c of own) { if (last && last !== c.P) m.plugins.push('-'); last = c.P; m.plugins.push(this.cmdItem(c)); }
    }
    for (const key of ['file', 'edit', 'clip', 'view', 'help']) {
      const list = this.commands.filter(c => c.menu === key);
      if (list.length) m[key].push('-', ...list.map(c => this.cmdItem(c)));
    }
    return m;
  },
  clipMenu(c, items) {
    const add = [];
    for (const x of this.clipMenus) { const r = x.fn(c); if (Array.isArray(r)) add.push(...r.map(it => it === '-' ? it : { ...it, onClick: this.guard(x.P, it.onClick, 'меню клипа') })); }
    if (add.length) items.push('-', ...add);
  },
  // Левая панель: панели плагинов живут в одной узкой вкладке-значке «Плагины» (иначе подписи вкладок
  // не помещаются), а слева в ней — список панелей. Панель с разделами (def.tabs) даёт несколько пунктов.
  renderPanelTabs() {
    const bar = $('#lpTabs');
    $$('.lp-plug', bar).forEach(b => b.remove());
    if (!Object.keys(this.panels).length) return;
    const b = h(`<button data-tab="plugins" class="lp-plug"><span data-i="puzzle"></span></button>`);
    setTip(b, 'Панели плагинов');
    bar.appendChild(b);
  },
  panelNavs(tab) {
    if (tab !== 'plugins') return null;
    const out = [];
    for (const [key, p] of Object.entries(this.panels)) {
      const subs = (p.def.tabs || []).map(t => Array.isArray(t) ? t : [t.id, t.title]);
      if (subs.length) for (const [id, title] of subs) out.push([key + '/' + id, p.def.title + ' · ' + title]);
      else out.push([key, p.def.title]);
    }
    return out.length ? out : null;
  },
  panelFn(tab, sub) {
    if (tab !== 'plugins') return null;
    const [key, part] = String(sub).split('/');
    const p = this.panels[key];
    return p ? (root) => p.render(root, part || null) : null;
  },
  // ключ панели плагина P (и раздела) → открыть
  showPanel(key, part) {
    const subs = this.panelNavs('plugins') || [];
    const k = part ? key + '/' + part : (subs.find(([s]) => s === key || s.startsWith(key + '/')) || [key])[0];
    Panels.sub.plugins = k;
    Panels.show('plugins');
  },
  // вкладки и секции инспектора
  inspectorTabs(c) {
    return this.inspTabs.filter(t => t.when(c)).map(t => [t.key, t.def.title]);
  },
  renderInspectorTab(tab, body, c) {
    const t = this.inspTabs.find(x => x.key === tab);
    if (t) t.render(body, c, this.inspCtx());
  },
  inspectorSections(tab, body, c) {
    for (const s of this.inspSecs) {
      if (s.tab !== tab || !s.when(c)) continue;
      const sec = Inspector.section(body, s.def.title, s.def.extra ? s.def.extra(c) : null);
      s.render(sec, c, this.inspCtx());
    }
  },
  inspCtx() { return { onRefresh: (fn) => Inspector.refreshers.push(fn), rerender: () => Inspector.render() }; },

  // ---------------------------------------------------------------- API для плагина
  makeApi(P) {
    const self = this, G = (fn, where, fb) => this.guard(P, fn, where, fb);
    const full = (id) => `${P.id}:${id}`;
    const need = (cond, msg) => { if (!cond) throw new Error(msg); };
    const ownCat = (cat) => {
      if (!cat) return null;
      if (FX_CATS.find(c => c.id === cat)) return cat;
      if (FX_CATS.find(c => c.id === full(cat))) return full(cat);
      return null;
    };
    const resolveFx = (id) => EFFECT_BY_ID[id] ? id : EFFECT_BY_ID[full(id)] ? full(id) : null;
    const offs = [];
    const settingsDefs = Array.isArray(P.manifest.settings) ? P.manifest.settings : [];
    const sKey = 'lc.plugin.' + P.id + '.';
    const lsGet = (k, d) => { try { const v = localStorage.getItem(sKey + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
    const lsSet = (k, v) => { try { if (v === undefined) localStorage.removeItem(sKey + k); else localStorage.setItem(sKey + k, JSON.stringify(v)); } catch { } };
    const setCbs = [];

    const lc = {
      id: P.id,
      manifest: P.manifest,
      dir: P.dir,
      version: LinCut.version,
      apiVersion: LinCut.apiVersion,
      url: (rel) => self.url(P, rel),
      readText: async (rel) => { const r = await fetch(self.url(P, rel)); if (!r.ok) throw new Error('Нет файла ' + rel); return r.text(); },
      readJSON: async (rel) => JSON.parse(await lc.readText(rel)),
      addStyle(cssText) { const s = document.createElement('style'); s.dataset.plugin = P.id; s.textContent = cssText; document.head.appendChild(s); return s; },
      log: (...a) => console.log(`[${P.id}]`, ...a),
      openExternal: (url) => window.api.plugins.openExternal(url),
      paths: () => window.api.paths(),

      // события редактора: selection, time, project, edit, changed, open, close, export:start, export:done, plugins:ready
      on(ev, fn) {
        const f = G(fn, 'событие ' + ev);
        bus.on(ev, f);
        const off = () => bus.off(ev, f);
        offs.push(off);
        return off;
      },

      // ---------------------------------------------------------------- интерфейс
      ui: {
        toast: (msg, kind, ms) => toast(msg, kind, ms),
        modal: (o) => modal(o),
        confirm: (title, text, ok = 'OK', danger = false) => confirmDlg(title, text, ok, danger),
        prompt: (title, value, placeholder) => promptDlg(title, value, placeholder),
        menu: (x, y, items) => showMenu(x, y, items.map(it => it === '-' ? it : { ...it, onClick: G(it.onClick, 'меню') })),
        h: (html) => h(html),
        esc: (s) => esc(s),
        icon: (name, size) => icon(name, size),
        addIcon(name, svgBody) { need(/^[\w-]+$/.test(name), 'addIcon: имя иконки — латиница и цифры'); ICONS[name] = svgBody; },
        slider: (o) => sliderRow({ ...o, onInput: G(o.onInput, 'ползунок'), onCommit: G(o.onCommit, 'ползунок') }),
        toggle: (label, value, onChange) => toggleRow(label, value, G(onChange, 'переключатель')),
        css: (name) => css(name),
      },

      // ---------------------------------------------------------------- команды и меню
      commands: {
        add(def) {
          need(def && def.id && def.label && typeof def.run === 'function', 'commands.add: нужны id, label и run()');
          const c = { P, id: full(def.id), label: def.label, icon: def.icon && ICONS[def.icon] ? def.icon : undefined, key: def.key || '',
            menu: ['file', 'edit', 'clip', 'view', 'help', 'none'].includes(def.menu) ? def.menu : 'plugins',
            run: G(def.run, def.label), enabled: def.enabled ? G(def.enabled, def.label, false) : null, k: def.key ? parseKey(def.key) : null };
          self.commands.push(c);
          return c.id;
        },
        run(id) { const c = self.commands.find(x => x.id === id || x.id === full(id)); if (c) c.run(); },
      },

      // ---------------------------------------------------------------- каталоги: эффекты, фильтры, переходы…
      effects: {
        add(def) {
          need(def && def.id && def.name && typeof def.ops === 'function', 'effects.add: нужны id, name и ops(p)');
          const id = full(def.id);
          need(!EFFECT_BY_ID[id], 'effects.add: эффект ' + def.id + ' уже есть');
          let cat = ownCat(def.cat);
          if (!cat) {
            if (!FX_CATS.find(c => c.id === 'plugins')) FX_CATS.push({ id: 'plugins', name: 'Плагины' });
            cat = 'plugins';
          }
          const warned = new Set();
          const ops = (p) => {
            let list;
            try { list = def.ops(p) || []; } catch (e) { self.fail(P, e, `эффект «${def.name}»`); return []; }
            return list.filter(op => {
              if (op && FXOPS[op.type] && FXEXP[op.type]) return true;
              const t = op && op.type;
              if (!warned.has(t)) { warned.add(t); self.fail(P, new Error(`неизвестная операция "${t}"`), `эффект «${def.name}»`); }
              return false;
            });
          };
          const e = { id, cat, name: def.name, ops, plugin: P.id };
          for (const k of ['speed', 'strength', 'tileT']) if (def[k] !== undefined) e[k] = def[k];
          EFFECTS.push(e);
          EFFECT_BY_ID[id] = e;
          return id;
        },
        addCategory(def) {
          need(def && def.id && def.name, 'effects.addCategory: нужны id и name');
          const id = full(def.id);
          if (!FX_CATS.find(c => c.id === id)) FX_CATS.push({ id, name: def.name });
          return id;
        },
        // своя операция: preview — рисование на canvas, ffmpeg — фильтры для экспорта
        addOp(type, def) {
          need(/^[A-Za-z][\w-]*$/.test(type || ''), 'effects.addOp: имя операции — латиница, цифры, - и _');
          need(!FXOPS[type], 'effects.addOp: операция ' + type + ' уже есть');
          need(def && typeof def.preview === 'function' && typeof def.ffmpeg === 'function', 'effects.addOp: нужны preview() и ffmpeg()');
          FXOPS[type] = { pre(ctx, src, op, env) {
            try { def.preview(ctx, src, op, env); } catch (e) { ctx.drawImage(src, 0, 0, env.W, env.H); self.fail(P, e, 'операция ' + type + ' (превью)'); }
          } };
          FXEXP[type] = async (op, inL, X) => {
            const out = await def.ffmpeg(op, inL, X);
            if (typeof out !== 'string') throw new Error(`операция ${type}: ffmpeg() должна вернуть метку выхода`);
            return out;
          };
          if (def.readsPixels) READS.add(type);
          return type;
        },
        // макрос выражений: name(x) разворачивается в формулу (одинаково для превью и ffmpeg)
        addMacro(name, fn) {
          need(/^[a-z]\w*$/i.test(name) && !FX_MACROS[name] && !FXF[name], 'effects.addMacro: имя занято или недопустимо');
          FX_MACROS[name] = fn;
        },
        value: (expr, T) => fxVal(expr, T),
        ff: (expr, Tsub) => fxFF(expr, Tsub),
        n: (v) => n4(v),
        colorMatrix: (a) => adjustMatrix(a),
        hueMatrix: (a) => hueMatrixExpr(a),
        satMatrix: (s) => satMatrixExpr(s),
        get list() { return EFFECTS; },
        get categories() { return FX_CATS; },
      },
      filters: {
        add(def) {
          need(def && def.id && def.name && def.a, 'filters.add: нужны id, name и a (настройки цвета)');
          const id = full(def.id);
          need(!FILTER_PRESETS.find(f => f.id === id), 'filters.add: фильтр ' + def.id + ' уже есть');
          FILTER_PRESETS.push({ id, name: def.name, a: { ...def.a }, plugin: P.id });
          return id;
        },
      },
      transitions: {
        add(def) {
          need(def && def.id && def.name && typeof def.ops === 'function', 'transitions.add: нужны id, name и ops(p)');
          const id = full(def.id);
          need(!TRANSITIONS.find(t => t.id === id), 'transitions.add: переход ' + def.id + ' уже есть');
          TRANSITIONS.push({ id, name: def.name, group: 'edit', plugin: P.id });
          PLUGIN_TRANS[id] = (D) => {
            const hD = n4(D / 2), U = `((T-${hD})/${hD})`;
            try { return def.ops({ D, U, A: `(1-abs(${U}))` }) || []; } catch (e) { self.fail(P, e, `переход «${def.name}»`); return []; }
          };
          return id;
        },
      },
      voices: {
        add(def) {
          need(def && def.id && def.name && /\[in\]/.test(def.graph || '') && /\[out\]/.test(def.graph || ''), 'voices.add: нужны id, name и graph от [in] до [out]');
          const id = full(def.id);
          const v = { id, name: def.name, icon: ICONS[def.icon] ? def.icon : 'waveform', hint: def.hint || '', graph: def.graph, plugin: P.id };
          VOICE_FX.push(v);
          VOICE_FX_BY_ID[id] = v;
          return id;
        },
      },
      text: {
        addPreset(def) { need(def && def.name, 'text.addPreset: нужно name'); TEXT_PRESETS.push({ name: def.name, text: def.text || def.name, style: def.style || {}, ...(def.y != null ? { y: def.y } : {}) }); },
        addStickers(list) { for (const s of [].concat(list)) if (!STICKERS.includes(s)) STICKERS.push(s); },
      },
      speedCurves: {
        add(def) {
          need(def && def.id && def.name && Array.isArray(def.pts) && def.pts.length >= 2, 'speedCurves.add: нужны id, name и pts [[u, скорость], …]');
          const id = full(def.id);
          SPEED_CURVES.push({ id, name: def.name, pts: def.pts.map(([u, v]) => [clamp(+u, 0, 1), clamp(+v, 0.1, 10)]) });
          return id;
        },
      },

      // ---------------------------------------------------------------- панели и инспектор
      panels: {
        add(def) {
          need(def && def.id && def.title && typeof def.render === 'function', 'panels.add: нужны id, title и render(root, sub)');
          const key = full(def.id);
          self.panels[key] = { P, def, render: G(def.render, 'панель ' + def.title) };
          if (self.ready) self.renderPanelTabs();
          return key;
        },
        show: (id, part) => self.showPanel(self.panels[id] ? id : full(id), part),
        refresh: () => { if (store.p) Panels.render(); },
        isOpen: (id) => !!store.p && Panels.tab === 'plugins' && String(Panels.sub.plugins || '').split('/')[0] === (self.panels[id] ? id : full(id)),
      },
      inspector: {
        // своя вкладка инспектора: when(clip) — показывать ли её у этого клипа
        addTab(def) {
          need(def && def.id && def.title && typeof def.render === 'function', 'inspector.addTab: нужны id, title и render(body, clip)');
          const key = 'plugin-' + P.id + '-' + def.id;
          self.inspTabs.push({ P, key, def, when: G(def.when || (() => true), 'вкладка ' + def.title, false), render: G(def.render, 'вкладка ' + def.title) });
          return key;
        },
        // секция во встроенной вкладке: video, audio, speed, anim, adjust, mask, text, effect, project — или в своей
        addSection(def) {
          need(def && def.id && def.title && typeof def.render === 'function', 'inspector.addSection: нужны id, title и render(sec, clip)');
          let tab = def.tab || 'video';
          if (self.inspTabs.find(t => t.key === 'plugin-' + P.id + '-' + tab)) tab = 'plugin-' + P.id + '-' + tab;
          self.inspSecs.push({ P, tab, def, when: G(def.when || (() => true), 'секция ' + def.title, false), render: G(def.render, 'секция ' + def.title) });
        },
        refresh: () => Inspector.render(),
      },
      timeline: {
        addClipMenu(fn) { self.clipMenus.push({ P, fn: G(fn, 'меню клипа', null) }); },
        render: () => Timeline.render(),
        fit: () => Timeline.fit(),
      },

      // ---------------------------------------------------------------- проект и воспроизведение
      project: {
        get current() { return store.p; },
        get dir() { return store.dir; },
        get width() { return store.p && store.p.width; },
        get height() { return store.p && store.p.height; },
        get fps() { return store.p && store.p.fps; },
        duration: () => store.p ? store.duration() : 0,
        tracks: () => store.p ? store.p.tracks : [],
        clips: () => store.p ? store.allClips() : [],
        find: (id) => store.p ? store.find(id) : null,
        media: (id) => store.p ? (id == null ? store.p.media : store.media(id)) : null,
        selected: () => { const s = store.p && store.selected(); return s ? s.clip : null; },
        selectedAll: () => store.p ? store.selectedAll().map(x => x.clip) : [],
        select(ids) { if (Array.isArray(ids)) store.selectMany(ids); else store.select(ids || null); },
        // зафиксировать изменения: шаг отмены (Ctrl+Z), автосохранение, перерисовка
        commit(label = 'plugin') { store.commit(full(label)); Player.requestRender(); },
        addText(o = {}) {
          need(store.p, 'Нет открытого проекта');
          const c = makeTextClip(o.start ?? store.time, o.text, o.style);
          c.out = o.duration ?? 3;
          if (o.x != null) c.transform.x = o.x;
          if (o.y != null) c.transform.y = o.y;
          store.place(c, 'text');
          store.select(c.id);
          store.commit(full('add-text'));
          return c;
        },
        addEffect(effectId, o = {}) {
          need(store.p, 'Нет открытого проекта');
          const id = resolveFx(effectId);
          need(id, 'Нет эффекта ' + effectId);
          const c = makeEffectClip(o.start ?? store.time, id, o.duration ?? 3);
          store.place(c, 'effect');
          store.select(c.id);
          store.commit(full('add-effect'));
          return c;
        },
        addClipEffect(clip, effectId, params) {
          const id = resolveFx(effectId);
          need(id, 'Нет эффекта ' + effectId);
          need(clip && (clip.kind === 'video' || clip.kind === 'image'), 'Эффект клипа можно добавить только видео или картинке');
          const f = addClipFx(clip, id);
          if (params) Object.assign(f.params, params);
          store.commit(full('clip-fx'));
          return f;
        },
        importFiles: (paths) => Media.importPaths([].concat(paths)),
        place: (media, t) => Media.placeAt([].concat(media), t ?? store.time),
        addMarker(t = store.time, name = '', color) {
          need(store.p, 'Нет открытого проекта');
          store.p.markers = store.p.markers || [];
          const m = { id: uid(), t, name, color: color || '#ffcc00' };
          store.p.markers.push(m);
          store.commit(full('marker'));
          return m;
        },
        save: () => App.save(),
      },
      // свойства клипа во времени (учитывают ключевые кадры и скорость)
      clip: {
        end: (c) => clipEnd(c),
        duration: (c) => clipDur(c),
        sourceTime: (c, t = store.time) => srcTime(c, t),
        transformAt: (c, t = store.time) => tfAt(c, t),
        // если у клипа есть ключевые кадры — значение запишется в ключ на этом месте, как при правке в инспекторе
        setTransform(c, values, t = store.time) { need(c.transform, 'У этого клипа нет трансформации'); setTf(c, values, t); },
        box: (c, t = store.time) => clipBox(c, store.p.width, store.p.height, t),
        mediaSize: (c) => mediaSize(c),
      },
      player: {
        get time() { return store.time; },
        get playing() { return Player.playing; },
        seek(t) { store.setTime(Math.max(0, t)); Timeline.ensureVisible(store.time); },
        play: () => Player.play(),
        pause: () => Player.pause(),
        toggle: () => Player.toggle(),
        render: () => Player.requestRender(),
        snapshot: () => Player.captureCover(),
      },

      // ---------------------------------------------------------------- хранилище и настройки
      storage: { get: lsGet, set: lsSet, remove: (k) => lsSet(k, undefined) },
      settings: {
        get(key) { const d = settingsDefs.find(s => s.key === key); return lsGet('settings.' + key, d ? d.default : undefined); },
        set(key, v) { lsSet('settings.' + key, v); setCbs.forEach(f => f(key, v)); },
        all() { return Object.fromEntries(settingsDefs.map(s => [s.key, this.get(s.key)])); },
        onChange(fn) { setCbs.push(G(fn, 'настройки')); },
        open: () => self.settingsDialog(P),
      },

      // ---------------------------------------------------------------- ffmpeg
      ffmpeg: {
        run(args, o = {}) { return runFF(P, 'ffmpeg', args, o); },
        probe(args) { return runFF(P, 'ffprobe', args, {}); },
      },

      // прямой доступ ко внутренностям редактора — для всего, чего нет в API (может меняться между версиями)
      internals: { App, store, bus, Player, Timeline, Inspector, Panels, Exporter, Media, Edit, Scopes,
        EFFECTS, EFFECT_BY_ID, FX_CATS, FXOPS, FXEXP, FILTER_PRESETS, TRANSITIONS, VOICE_FX, TEXT_PRESETS, STICKERS, SPEED_CURVES, ICONS,
        ADJUST_DEFS, BLENDS, MASKS, ANIMS_IN, ANIMS_OUT, TEXT_ANIMS_IN, TEXT_ANIMS_OUT, TEXT_LOOPS, RATIOS, DEFAULT_TEXT_STYLE },
    };
    P._settingsApi = lc.settings;
    return lc;
  },

  // ---------------------------------------------------------------- окно «Плагины»
  async manager() {
    const r = await window.api.plugins.list();
    this.info = { ...this.info, ...r, plugins: undefined };
    // включённость, найденные заново папки и ошибки загрузки этого запуска
    const loaded = this.byId;
    const list = r.plugins.map(p => ({ ...p, ...(loaded[p.id] && loaded[p.id].dir === p.dir ? { loaded: loaded[p.id].loaded, error: p.error || loaded[p.id].error, errors: loaded[p.id].errors, api: loaded[p.id].api, manifest: p.manifest } : {}) }));
    const body = h(`<div class="pl-wrap">
      <div class="pl-tools">
        <button class="primary-btn" data-a="shop">${icon('storefront')}Магазин</button>
        <button class="secondary-btn" data-a="install">${icon('download')}Установить…</button>
        <button class="secondary-btn" data-a="create">${icon('code')}Создать…</button>
        <button class="secondary-btn" data-a="folder">${icon('folder')}Папка</button>
        <span class="pl-grow"></span>
        <button class="secondary-btn" data-a="docs">${icon('book')}Как написать плагин</button>
      </div>
      <div class="pl-list"></div>
      <label class="check pl-dev"><input type="checkbox" ${r.dev ? 'checked' : ''}><span></span>Перезагружать плагины при изменении их файлов (для разработки)</label>
      <div class="pl-note muted small"></div>
    </div>`);
    const listEl = $('.pl-list', body), note = $('.pl-note', body);
    const showNote = () => {
      note.innerHTML = this.changed ? `Изменения вступят в силу после перезагрузки плагинов. <button class="link-btn" data-a="reload">Перезагрузить сейчас</button>` : `Папка плагинов: <button class="link-btn" data-a="folder">${esc(r.dir)}</button>`;
    };
    const status = (p) => {
      if (p.error) return `<span class="pl-st err">${icon('alert')}${esc(p.error)}</span>`;
      if (!p.enabled) return `<span class="pl-st">Выключен</span>`;
      if (p.loaded) return `<span class="pl-st ok">${icon('check')}Работает${p.errors && p.errors.length ? ` · ошибок: ${p.errors.length}` : ''}</span>`;
      return `<span class="pl-st">Загрузится после перезагрузки</span>`;
    };
    const render = () => {
      if (!list.length) {
        listEl.innerHTML = `<div class="pl-empty">${icon('puzzle', 28)}<b>Плагинов пока нет</b>
          <span>Установите плагин из .zip-архива или папки, или создайте свой — это обычный JavaScript.</span></div>`;
        return;
      }
      listEl.innerHTML = '';
      for (const p of list) {
        const m = p.manifest || {};
        const row = h(`<div class="pl-item ${p.enabled ? '' : 'off'}">
          <div class="pl-ic">${icon('puzzle')}</div>
          <div class="pl-txt">
            <div class="pl-name"><b>${esc(m.name || p.id)}</b>${m.version ? `<span class="muted">${esc(m.version)}</span>` : ''}${m.author ? `<span class="muted">· ${esc(m.author)}</span>` : ''}</div>
            ${m.description ? `<span class="pl-desc">${esc(m.description)}</span>` : ''}
            ${status(p)}
          </div>
          <button class="switch ${p.enabled ? 'on' : ''}" title="${p.enabled ? 'Выключить' : 'Включить'}"><i></i></button>
          <button class="icon-btn" data-more title="Ещё">${icon('more')}</button>
        </div>`);
        $('.switch', row).onclick = async () => {
          p.enabled = !p.enabled;
          await window.api.plugins.setEnabled(p.id, p.enabled);
          this.changed = true;
          render(); showNote();
        };
        $('[data-more]', row).onclick = (e) => {
          const items = [];
          if (Array.isArray(m.settings) && m.settings.length) items.push({ label: 'Настройки…', icon: 'sliders', disabled: !p.loaded, onClick: () => this.settingsDialog(this.byId[p.id]) });
          if (p.errors && p.errors.length) items.push({ label: 'Журнал ошибок…', icon: 'alert', onClick: () => this.errorsDialog(p) });
          if (m.homepage) items.push({ label: 'Страница плагина', icon: 'link', onClick: () => window.api.plugins.openExternal(m.homepage) });
          items.push({ label: 'Открыть папку плагина', icon: 'folder', onClick: () => window.api.openPath(p.dir) });
          items.push('-', { label: 'Удалить', icon: 'trash', danger: true, onClick: async () => {
            if (!(await confirmDlg('Удалить плагин?', `«${m.name || p.id}» будет перемещён в корзину.`))) return;
            await window.api.plugins.remove(p.id);
            list.splice(list.indexOf(p), 1);
            if (p.loaded) this.changed = true;
            render(); showNote();
          } });
          menuBelow(e.currentTarget, items);
        };
        listEl.appendChild(row);
      }
      hydrateIcons(listEl);
    };
    render(); showNote();
    const dlg = modal({ title: 'Плагины', body, width: 620, cls: 'plugins-modal', buttons: [] });
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'folder') window.api.openPath(r.dir);
      if (a === 'docs') window.api.plugins.openExternal(r.docs);
      if (a === 'reload') this.reload();
      if (a === 'shop') { dlg.close(); Shop.open(); }
      if (a === 'install') { dlg.close(); this.installDialog(); }
      if (a === 'create') { dlg.close(); this.createDialog(); }
    });
    $('.pl-dev input', body).onchange = async (e) => { this.info.dev = await window.api.plugins.setDev(e.target.checked); };
  },

  installDialog() {
    showMenu(innerWidth / 2 - 120, innerHeight / 3, [
      { label: 'Из архива (.zip, .lcplugin)…', icon: 'download', onClick: async () => { const f = await window.api.plugins.pick(); if (f) this.installPath(f); } },
      { label: 'Из папки…', icon: 'folder', onClick: async () => { const f = await window.api.plugins.pickFolder(); if (f) this.installPath(f); } },
    ]);
  },
  async installPath(src) {
    const res = await window.api.plugins.install(src);
    if (!res.ok) { modal({ title: 'Не удалось установить плагин', body: `<p class="muted">${esc(res.error)}</p>`, width: 420, buttons: [{ label: 'OK', primary: true }] }); return; }
    if (res.same) { toast('Этот плагин уже лежит в папке плагинов', 'info'); return; }
    this.changed = true;
    modal({ title: res.updated ? 'Плагин обновлён' : 'Плагин установлен', width: 420,
      body: `<p><b>${esc(res.name)}</b>${res.version ? ' ' + esc(res.version) : ''}</p><p class="muted">Чтобы он заработал, перезагрузите плагины. Открытый проект сохранится и откроется снова.</p>`,
      buttons: [{ label: 'Позже' }, { label: 'Перезагрузить', primary: true, onClick: () => this.reload() }] });
  },

  createDialog() {
    const tr = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
    const slug = (s) => s.toLowerCase().split('').map(c => tr[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const body = h(`<div class="pl-form">
      <label>Название<input class="text-input" data-f="name" placeholder="Мой плагин" spellcheck="false"></label>
      <label>Идентификатор<input class="text-input" data-f="id" placeholder="my-plugin" spellcheck="false"><small class="muted">Латиница, цифры и дефис. По нему LinCut отличает плагины.</small></label>
      <label>Автор<input class="text-input" data-f="author" spellcheck="false"></label>
      <label>Описание<input class="text-input" data-f="description" placeholder="Что делает плагин" spellcheck="false"></label>
    </div>`);
    const f = (k) => $(`[data-f="${k}"]`, body);
    let idTouched = false;
    f('name').oninput = () => { if (!idTouched) f('id').value = slug(f('name').value); };
    f('id').oninput = () => { idTouched = true; };
    for (const i of $$('input', body)) i.addEventListener('keydown', (e) => e.stopPropagation());
    modal({ title: 'Новый плагин', body, width: 440, buttons: [{ label: 'Отмена' }, { label: 'Создать', primary: true, onClick: async () => {
      const o = { name: f('name').value.trim(), id: f('id').value.trim(), author: f('author').value.trim(), description: f('description').value.trim() };
      if (!o.name) { toast('Введите название', 'error'); return false; }
      const res = await window.api.plugins.create(o);
      if (!res.ok) { toast(res.error, 'error', 4000); return false; }
      window.api.openPath(res.dir);
      this.changed = true;
      modal({ title: 'Плагин создан', width: 460,
        body: `<p class="muted">В папке <b>${esc(o.id)}</b> лежат plugin.json и main.js с примером: команда в меню «Плагины» и свой эффект. Откройте main.js в любом редакторе кода, а после правок нажмите «Плагины → Перезагрузить плагины» (Ctrl+Shift+R).</p>`,
        buttons: [{ label: 'Документация', onClick: () => { window.api.plugins.openExternal(this.info.docs); return false; } }, { label: 'Перезагрузить сейчас', primary: true, onClick: () => this.reload() }] });
    } }] });
    setTimeout(() => f('name').focus(), 30);
  },

  // настройки из plugin.json → "settings": [{ key, label, type, default, … }]
  settingsDialog(P) {
    if (!P || !P._settingsApi) return;
    const S = P._settingsApi, defs = P.manifest.settings || [];
    const body = h('<div class="pl-settings"></div>');
    for (const d of defs) {
      const v = S.get(d.key), label = d.label || d.key;
      let el;
      if (d.type === 'toggle' || d.type === 'boolean') el = toggleRow(label, !!v, (x) => S.set(d.key, x));
      else if (d.type === 'number' || d.type === 'range') el = sliderRow({ label, min: d.min ?? 0, max: d.max ?? 100, step: d.step ?? 1, value: +v || 0, def: d.default ?? 0, unit: d.unit || '', onInput: () => { }, onCommit: (x) => S.set(d.key, x) });
      else if (d.type === 'select') {
        el = h(`<div class="prop-row"><label>${esc(label)}</label><select class="text-input">${(d.options || []).map(o => { const [val, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select></div>`);
        $('select', el).onchange = (e) => S.set(d.key, e.target.value);
      } else if (d.type === 'color') {
        el = h(`<div class="prop-row"><label>${esc(label)}</label><input type="color" value="${esc(v || '#ffffff')}"></div>`);
        $('input', el).onchange = (e) => S.set(d.key, e.target.value);
      } else {
        el = h(`<div class="prop-row"><label>${esc(label)}</label><input class="text-input" value="${esc(v ?? '')}" spellcheck="false"></div>`);
        $('input', el).addEventListener('keydown', (e) => e.stopPropagation());
        $('input', el).onchange = (e) => S.set(d.key, e.target.value);
      }
      body.appendChild(el);
      if (d.hint) body.appendChild(h(`<p class="muted small pl-hint">${esc(d.hint)}</p>`));
    }
    modal({ title: 'Настройки — ' + (P.manifest.name || P.id), body, width: 420, buttons: [{ label: 'Готово', primary: true }] });
  },
  errorsDialog(p) {
    const pre = h('<pre class="log"></pre>');
    pre.textContent = (p.errors || []).map(e => new Date(e.t).toLocaleTimeString('ru-RU') + '  ' + e.msg).join('\n');
    modal({ title: 'Ошибки — ' + (p.manifest.name || p.id), body: pre, width: 600, buttons: [{ label: 'Закрыть', primary: true }] });
  },
};

function errText(e) { return e && e.message ? e.message : String(e); }

function runFF(P, prog, args, o) {
  const job = uid();
  let off = null;
  if (o.onProgress) {
    const cb = Plugins.guard(P, o.onProgress, 'ffmpeg');
    off = window.api.plugins.onFfProgress((v) => { if (v.job === job) cb(v.t); });
  }
  return window.api.plugins.ffmpeg(prog, args, { job, progress: !!o.onProgress, cwd: o.cwd }).finally(() => off && off());
}
