// Точка входа: экраны, горячие клавиши, автосохранение
const App = {
  fontsList: null,
  clipboard: null,

  async init() {
    Theme.init();
    Theme.apply(Theme.current());
    Motion.apply(Motion.current());
    hydrateIcons();
    Tip.init();
    VoiceSep.init();
    VoiceFx.init();
    Stab.init();
    Track.init();
    Roto.init();
    Links.init();
    AiServer.init();
    AiModels.init();
    Tasks.init();
    this.bindWindow();
    Home.init();
    Player.init();
    Timeline.init();
    Edit.init();
    Scopes.init();
    Inspector.init();
    Panels.init();
    this.bindUI();
    this.bindKeys();
    this.updateTips();
    this.bindSplitters();
    this.bindDrop();
    bus.on('changed', debounce(() => this.save(), 900));
    bus.on('project', () => { if (store.p) $('#tcTotal').textContent = fmtTC(store.duration(), store.p.fps); });
    bus.on('time', () => { if (store.p) $('#tcCur').textContent = fmtTC(store.time, store.p.fps); });
    window.addEventListener('beforeunload', () => { if (store.dirty) this.save(); });
    await Home.render();
    if (window.LINCUT_AUTOTEST) window.LINCUT_AUTOTEST();
  },

  async fonts() {
    if (!this.fontsList) {
      let list = await window.api.fonts();
      // Windows: список шрифтов системы — через Chromium
      if (!list && window.queryLocalFonts) {
        try {
          const f = await window.queryLocalFonts();
          list = [...new Set(f.map(x => x.family))].filter(n => !/^(Marlett|Webdings|Wingdings.*|Symbol|MT Extra|HoloLens.*|Segoe (MDL2|Fluent).*)$/.test(n)).sort((a, b) => a.localeCompare(b));
        } catch { }
      }
      this.fontsList = list && list.length ? list : ['Segoe UI', 'Arial', 'Times New Roman', 'Consolas'];
    }
    return this.fontsList;
  },

  // ---------------------------------------------------------------- проекты
  async newProject() {
    const { id, dir } = await window.api.createProject();
    const p = newProject(id);
    await window.api.saveProject(id, JSON.stringify(p));
    this.enter(p, dir);
  },
  async openProject(id) {
    try {
      const { data, dir } = await window.api.loadProject(id);
      data.id = id;
      this.enter(data, dir);
    } catch (e) {
      toast('Не удалось открыть проект: ' + e.message, 'error');
    }
  },
  enter(p, dir) {
    $('#home').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    for (const k of Object.keys(assets)) delete assets[k];
    store.load(p, dir);
    $('#projectName').value = p.name;
    window.api.setTitle(p.name + ' — LinCut');
    Media.prepareAll();
    Panels.show(store.p.media.length ? Panels.tab : 'media');
    Player.resize();
    requestAnimationFrame(() => { Timeline.fit(); Inspector.render(); });
    this.setSaved('Сохранено');
    VoiceSep.checkReady(false).then(() => VoiceSep.autoEnsure());
  },
  async goHome() {
    Player.pause();
    Player.stopPick();
    VoiceSep.cancelAll();
    await this.save();
    Player.releaseAll();
    store.p = null;
    $('#editor').classList.add('hidden');
    $('#home').classList.remove('hidden');
    window.api.setTitle('LinCut');
    Home.render();
  },
  async save() {
    if (!store.p) return;
    store.p.updated = Date.now();
    store.p.durationCache = store.duration();
    const cover = store.duration() > 0 ? Player.captureCover() : null;
    try {
      await window.api.saveProject(store.p.id, JSON.stringify(store.p), cover);
      store.dirty = false;
      this.setSaved('Сохранено');
    } catch (e) {
      this.setSaved('Ошибка сохранения');
    }
  },
  setSaved(t) {
    const el = $('#autosave');
    el.innerHTML = icon('check') + t;
    el.classList.add('show');
  },

  async importDialog() {
    const paths = await window.api.openMedia();
    if (!paths.length) return;
    const added = await Media.importPaths(paths);
    if (added.length) Panels.show(added.every(m => m.type === 'audio') && Panels.tab === 'audio' ? 'audio' : Panels.tab === 'audio' ? 'audio' : 'media');
  },

  // ---------------------------------------------------------------- интерфейс
  bindUI() {
    // кнопки и ползунки не держат фокус — иначе пробел/стрелки срабатывают дважды
    document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });
    document.addEventListener('change', (e) => { if (e.target.type === 'range' || e.target.type === 'checkbox') e.target.blur(); });
    $('#btnCreate').onclick = () => this.newProject();
    $('#btnHome').onclick = () => this.goHome();
    $('#btnExport').onclick = () => Exporter.open();
    $('#btnPlay').onclick = () => Player.toggle();
    $('#btnPrevFrame').onclick = () => this.step(-1);
    $('#btnNextFrame').onclick = () => this.step(1);
    $('#btnFullscreen').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else $('#stage').requestFullscreen();
    };
    document.addEventListener('fullscreenchange', () => setTimeout(() => Player.resize(), 60));
    $('#btnRatio').onclick = (e) => {
      menuBelow(e.currentTarget, RATIOS.map(r => ({ label: (r.label || r.id) + (r.hint ? '  ·  ' + r.hint : ''), checked: store.p.ratio === r.id, onClick: () => { setRatio(r.id); Inspector.render(); } })));
    };
    const nm = $('#projectName');
    nm.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') nm.blur(); });
    nm.addEventListener('change', () => {
      const v = nm.value.trim();
      if (!v) { nm.value = store.p.name; return; }
      store.p.name = v; store.dirty = true; this.save(); window.api.setTitle(v + ' — LinCut');
    });
    this.bindMenubar();
    $('#btnShortcuts').onclick = () => this.shortcuts();

    $('#tUndo').onclick = () => store.undo();
    $('#tRedo').onclick = () => store.redo();
    $('#tSplit').onclick = () => Timeline.split();
    $('#tTrimL').onclick = () => Timeline.trimTo('l');
    $('#tTrimR').onclick = () => Timeline.trimTo('r');
    $('#tDelete').onclick = () => Timeline.deleteSel();
    $('#tDup').onclick = () => Timeline.duplicate();
    $('#tDetach').onclick = () => Timeline.detachAudio();
    $('#tFreeze').onclick = () => Timeline.freeze();
    $('#tMirror').onclick = () => { const s = store.selected(); if (s && s.clip.transform) { if (s.clip.kind === 'text') s.clip.transform.scale *= 1; else s.clip.flipH = !s.clip.flipH; store.commit('mirror'); Player.requestRender(); } };
    $('#tRotate').onclick = () => { const s = store.selected(); if (s && s.clip.transform) { const r0 = tfAt(s.clip, store.time).rotation; setTf(s.clip, { rotation: ((Math.round(r0 / 90) * 90 + 90 + 180) % 360) - 180 }, store.time); store.commit('rotate'); Player.requestRender(); } };
    $('#tRecord').onclick = () => Voiceover.open();
    $('#tMarker').onclick = () => Timeline.addMarker();
    $('#tMarkIn').onclick = () => Edit.markIO('a');
    $('#tMarkOut').onclick = () => Edit.markIO('b');
    $('#tLift').onclick = () => Edit.lift();
    $('#tExtract').onclick = () => Edit.extract();
    $('#tMagnet').onclick = () => { store.magnet = !store.magnet; store.packMain(); store.commit('magnet'); Timeline.updateToolbar(); toast(store.magnet ? 'Авто-склейка главной дорожки включена' : 'Авто-склейка выключена'); };
    $('#tSnap').onclick = () => { store.snap = !store.snap; Timeline.updateToolbar(); };
    bus.on('selection', () => Timeline.updateToolbar());
    bus.on('time', () => Timeline.updateToolbar());
  },

  // подсказки кнопок с клавишами, которые зависят от раскладки (LinCut / Premiere Pro)
  updateTips() {
    const K = (n) => Edit.K(n);
    setTip($('#tSplit'), `Разделить (${K('split')})`);
    setTip($('#tMarker'), `Маркер (${K('marker')})`);
    setTip($('#tMagnet'), `Главная дорожка: авто-склейка (${K('magnet')})`);
    setTip($('#tSnap'), `Привязка (${K('snap')})`);
    setTip($('#tRecord'), `Записать озвучку (${K('voice')})`);
  },
  toggleKeyframe() {
    const s = store.selected();
    if (s && s.clip.transform && store.time >= s.clip.start && store.time < clipEnd(s.clip)) { const on = toggleKey(s.clip, store.time); store.commit('keyframe'); Player.requestRender(); toast(on ? 'Ключевой кадр добавлен' : 'Ключевой кадр удалён', 'info', 1200); }
  },

  // Строка меню: Файл / Правка / Клип / Вид / Справка
  menus() {
    const s = store.selected(), c = s && s.clip, vis = c && c.transform;
    const inClip = c && store.time >= c.start && store.time < clipEnd(c);
    return {
      file: [
        { label: 'Новый проект', icon: 'plus', onClick: async () => { await this.save(); Player.releaseAll(); this.newProject(); } },
        { label: 'Импорт медиа…', icon: 'download', key: 'Ctrl+I', onClick: () => this.importDialog() },
        { label: 'Импорт по ссылке…', icon: 'link', key: 'Ctrl+Shift+I', onClick: () => Links.dialog() },
        { label: 'Экспорт…', icon: 'upload', key: 'Ctrl+E', onClick: () => Exporter.open() },
        '-',
        { label: 'Сохранить', key: 'Ctrl+S', onClick: () => { this.save(); toast('Проект сохранён', 'ok', 1400); } },
        { label: 'Открыть папку проекта', icon: 'folder', onClick: () => window.api.openPath(store.dir) },
        { label: AiServer.remote() ? 'Нейросети: на сервере…' : 'Нейросети: на этом компьютере…', icon: 'sparkles', onClick: () => AiServer.dialog() },
        '-',
        { label: 'На главную', icon: 'home', onClick: () => this.goHome() },
        { label: 'Выход', key: 'Ctrl+Q', onClick: async () => { await this.save(); window.api.winClose(); } },
      ],
      edit: [
        { label: 'Отменить', icon: 'undo', key: 'Ctrl+Z', disabled: !store.undoStack.length, onClick: () => store.undo() },
        { label: 'Повторить', icon: 'redo', key: 'Ctrl+Shift+Z', disabled: !store.redoStack.length, onClick: () => store.redo() },
        '-',
        { label: 'Вырезать', key: 'Ctrl+X', disabled: !c, onClick: () => { this.copy(); Timeline.deleteSel(); } },
        { label: 'Копировать', icon: 'copy', key: 'Ctrl+C', disabled: !c, onClick: () => this.copy() },
        { label: 'Вставить', key: 'Ctrl+V', onClick: () => this.paste() },
        { label: 'Дублировать', key: 'Ctrl+D', disabled: !c, onClick: () => Timeline.duplicate() },
        { label: 'Копировать атрибуты', key: 'Ctrl+Alt+C', disabled: !c, onClick: () => this.copyAttrs() },
        { label: 'Вставить атрибуты…', icon: 'pasteAttr', key: 'Ctrl+Alt+V', disabled: !(c && this.attrs), onClick: () => this.pasteAttrs() },
        { label: 'Удалить', icon: 'trash', key: 'Del', disabled: !c, onClick: () => Timeline.deleteSel() },
        { label: 'Удалить со сдвигом', key: 'Shift+Del', disabled: !c, onClick: () => Edit.rippleDelete() },
        { label: 'Выделить всё', key: 'Ctrl+A', onClick: () => Timeline.selectAll() },
        '-',
        { label: 'Разделить', icon: 'split', key: Edit.K('split'), disabled: !Timeline.splitTarget(), onClick: () => Timeline.split() },
        { label: 'Разделить на всех дорожках', key: Edit.K('splitAll'), onClick: () => Edit.splitAll() },
        { label: 'Удалить слева от курсора', icon: 'trimLeft', key: 'Q', disabled: !Timeline.splitTarget(), onClick: () => Timeline.trimTo('l') },
        { label: 'Удалить справа от курсора', icon: 'trimRight', key: 'W', disabled: !Timeline.splitTarget(), onClick: () => Timeline.trimTo('r') },
        '-',
        { label: 'Маркер', icon: 'marker', key: Edit.K('marker'), onClick: () => Timeline.addMarker() },
        { label: 'Удалить все маркеры', disabled: !(store.p.markers && store.p.markers.length), onClick: () => { store.p.markers = []; store.commit('markers-clear'); } },
        '-',
        { label: 'Точка входа', icon: 'markIn', key: 'I', onClick: () => Edit.markIO('a') },
        { label: 'Точка выхода', icon: 'markOut', key: 'O', onClick: () => Edit.markIO('b') },
        { label: 'Отметить клип', icon: 'brackets', key: 'X', disabled: !(c || Edit.clipAtPlayhead()), onClick: () => Edit.markClip() },
        { label: 'Очистить вход и выход', key: 'Ctrl+Shift+X', disabled: !Edit.range(), onClick: () => Edit.clearIO() },
        { label: 'Убрать (Lift) — оставить пробел', icon: 'lift', key: ';', disabled: !Edit.range(), onClick: () => Edit.lift() },
        { label: 'Извлечь (Extract) — со сдвигом', icon: 'extract', key: "'", disabled: !Edit.range(), onClick: () => Edit.extract() },
        { label: 'Воспроизвести от входа до выхода', icon: 'play', key: 'Ctrl+Shift+Пробел', disabled: !Edit.range(), onClick: () => Edit.playIO() },
      ],
      clip: [
        { label: 'Ключевой кадр', icon: 'diamond', key: Edit.K('keyframe'), disabled: !(vis && inClip), onClick: () => { toggleKey(c, store.time); store.commit('keyframe'); Player.requestRender(); } },
        { label: 'Удалить все ключевые кадры', disabled: !(vis && c.keys && c.keys.length), onClick: () => { const t = tfAt(c, store.time); c.keys = []; putTf(c, t); store.commit('keys-clear'); Player.requestRender(); } },
        '-',
        { label: 'Отделить аудио', icon: 'unlink', disabled: !(c && c.kind === 'video' && hasAudioTrack(c) && !c.muted), onClick: () => Timeline.detachAudio() },
        { label: 'Стоп-кадр', icon: 'snow', disabled: !(c && c.kind === 'video'), onClick: () => Timeline.freeze() },
        { label: 'Заменить клип…', icon: 'replace', disabled: !Timeline.canReplace(c), onClick: () => Timeline.replaceDialog(c) },
        { label: 'Отразить', icon: 'flip', disabled: !(c && (c.kind === 'video' || c.kind === 'image')), onClick: () => $('#tMirror').click() },
        { label: 'Повернуть на 90°', icon: 'rotate', disabled: !vis, onClick: () => $('#tRotate').click() },
        { label: c && c.muted ? 'Включить звук' : 'Выключить звук', icon: 'volumeX', disabled: !(c && hasAudioTrack(c)), onClick: () => { c.muted = !c.muted; store.commit('mute'); } },
        { label: c && c.disabled ? 'Включить клип' : 'Отключить клип', icon: 'prohibit', key: 'Shift+E', disabled: !c, onClick: () => Edit.toggleEnabled() },
        { label: 'Скорость и длительность…', icon: 'speed', key: 'Ctrl+R', disabled: !(c && c.kind !== 'text' && c.kind !== 'image'), onClick: () => Edit.speedDialog() },
        { label: 'Выбрать клип под курсором', key: 'D', onClick: () => Edit.selectAtPlayhead() },
        '-',
        { label: 'Записать озвучку', icon: 'mic', key: Edit.K('voice'), onClick: () => Voiceover.open() },
        { label: 'Добавить текст', icon: 'type', key: 'T', onClick: () => Panels.addText(TEXT_PRESETS[0]) },
      ],
      view: [
        ...RATIOS.map(r => ({ label: 'Соотношение ' + (r.label || r.id), checked: store.p.ratio === r.id, onClick: () => { setRatio(r.id); Inspector.render(); } })),
        '-',
        { label: 'Превью на весь экран', icon: 'maximize', onClick: () => $('#btnFullscreen').click() },
        { label: 'Вписать таймлайн', icon: 'fit', key: 'Shift+Z', onClick: () => Timeline.fit() },
        { label: 'Увеличить таймлайн', icon: 'zoomIn', key: '+', onClick: () => Timeline.zoomAt(Timeline.pps * 1.4, store.time) },
        { label: 'Уменьшить таймлайн', icon: 'zoomOut', key: '−', onClick: () => Timeline.zoomAt(Timeline.pps / 1.4, store.time) },
        '-',
        { label: 'Привязка', checked: store.snap, key: Edit.K('snap'), onClick: () => $('#tSnap').click() },
        { label: 'Авто-склейка главной дорожки', checked: store.magnet, key: Edit.K('magnet'), onClick: () => $('#tMagnet').click() },
        '-',
        { label: 'Видеоскопы Lumetri', icon: 'scopes', checked: Scopes.on, onClick: () => Scopes.toggle() },
        { label: 'Индикатор громкости', icon: 'meter', checked: Scopes.meterOn, onClick: () => Scopes.toggleMeter() },
        '-',
        ...THEMES.map(t => ({ label: 'Тема: ' + t.name, checked: Theme.current() === t.id, disabled: t.id === 'system' && !Theme.palette, onClick: () => Theme.apply(t.id) })),
        '-',
        ...MOTIONS.map(t => ({ label: 'Вкладки: ' + t.name, checked: Motion.current() === t.id, onClick: () => Motion.apply(t.id) })),
      ],
      help: [
        { label: 'Горячие клавиши', icon: 'keyboard', onClick: () => this.shortcuts() },
        ...KEYMAPS.map(k => ({ label: 'Раскладка: ' + k.name, checked: Edit.keymap === k.id, onClick: () => Edit.setKeymap(k.id) })),
        '-',
        { label: 'Проверить обновления…', icon: 'download', onClick: () => Tasks.dialog() },
        { label: 'О программе', icon: 'info', onClick: () => modal({ title: 'LinCut', width: 380, body: `<p>Видеоредактор для Linux и Windows.</p><p class="muted">Версия ${esc((Tasks.upd && Tasks.upd.current) || '')}. Electron + FFmpeg. Эффекты и ключевые кадры рендерятся одинаково в превью и при экспорте.</p>`, buttons: [{ label: 'OK', primary: true }] }) },
      ],
    };
  },
  bindMenubar() {
    const bar = $('#menubar');
    let openKey = null;
    const open = (btn, instant) => {
      const key = btn.dataset.m;
      $$('button', bar).forEach(b => b.classList.toggle('open', b === btn));
      openKey = key;
      const m = menuBelow(btn, this.menus()[key], { instant });
      // закрытие меню снимает подсветку
      const obs = new MutationObserver(() => { if (!m.isConnected) { obs.disconnect(); if (openKey === key) { openKey = null; btn.classList.remove('open'); } } });
      obs.observe($('#menuRoot'), { childList: true });
    };
    bar.addEventListener('mousedown', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      e.stopPropagation();
      if (openKey === b.dataset.m) { closeMenu(); return; }
      open(b);
    });
    // как в настоящих программах: при открытом меню наведение переключает соседнее
    bar.addEventListener('mouseover', (e) => {
      const b = e.target.closest('button');
      if (b && openKey && openKey !== b.dataset.m) { closeMenu(); open(b, true); }
    });
  },

  step(n) {
    if (Player.playing) Player.pause();
    const f = 1 / store.p.fps;
    store.setTime(Math.round((store.time + n * f) * store.p.fps) / store.p.fps);
    Timeline.ensureVisible(store.time);
  },
  jumpEdit(dir) {
    const pts = new Set([0, store.duration()]);
    for (const t of store.p.tracks) for (const c of t.clips) { pts.add(c.start); pts.add(clipEnd(c)); }
    for (const m of store.p.markers || []) pts.add(m.t);
    const arr = [...pts].sort((a, b) => a - b);
    const t = store.time;
    const nx = dir > 0 ? arr.find(x => x > t + 1e-3) : [...arr].reverse().find(x => x < t - 1e-3);
    if (nx != null) { store.setTime(nx); Timeline.ensureVisible(nx); }
  },

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (!store.p || $('#editor').classList.contains('hidden')) return;
      if ($('.modal-back')) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' && !['range', 'checkbox'].includes(e.target.type) || tag === 'textarea' || tag === 'select') return;
      const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), code = e.code;
      if (Edit.key(e)) { e.preventDefault(); return; }
      let handled = true;
      if (code === 'Space') Player.toggle();
      else if (ctrl && code === 'KeyZ' && !e.shiftKey) store.undo();
      else if (ctrl && (code === 'KeyZ' && e.shiftKey || code === 'KeyY')) store.redo();
      else if (ctrl && code === 'KeyB') Timeline.split();
      else if (ctrl && code === 'KeyD') Timeline.duplicate();
      else if (ctrl && code === 'KeyS') { this.save(); toast('Проект сохранён', 'ok', 1400); }
      else if (ctrl && e.shiftKey && code === 'KeyI') Links.dialog();
      else if (ctrl && code === 'KeyI') this.importDialog();
      else if (ctrl && code === 'KeyE') Exporter.open();
      else if (ctrl && e.altKey && code === 'KeyC') this.copyAttrs();
      else if (ctrl && e.altKey && code === 'KeyV') this.pasteAttrs();
      else if (ctrl && code === 'KeyC') this.copy();
      else if (ctrl && code === 'KeyX') { this.copy(); Timeline.deleteSel(); }
      else if (ctrl && code === 'KeyV') this.paste();
      else if (ctrl && !e.shiftKey && code === 'KeyA') Timeline.selectAll();
      else if (ctrl && code === 'KeyQ') { this.save().then(() => window.api.winClose()); }
      else if (ctrl) handled = false;
      else if (k === 'delete' || k === 'backspace') Timeline.deleteSel();
      else if (code === 'KeyQ') Timeline.trimTo('l');
      else if (code === 'KeyW') Timeline.trimTo('r');
      else if (code === 'KeyR') Voiceover.open();
      else if (code === 'KeyB') Timeline.addMarker();
      else if (code === 'KeyM') $('#tMagnet').click();
      else if (code === 'KeyN') $('#tSnap').click();
      else if (code === 'KeyT') Panels.addText(TEXT_PRESETS[0]);
      else if (code === 'KeyK') this.toggleKeyframe();
      else if (k === 'arrowleft') this.step(e.shiftKey ? -store.p.fps : -1);
      else if (k === 'arrowright') this.step(e.shiftKey ? store.p.fps : 1);
      else if (k === 'arrowup') this.jumpEdit(-1);
      else if (k === 'arrowdown') this.jumpEdit(1);
      else if (k === 'home') { store.setTime(0); Timeline.ensureVisible(0); }
      else if (k === 'end') { store.setTime(store.duration()); Timeline.ensureVisible(store.time); }
      else if (k === '=' || k === '+') Timeline.zoomAt(Timeline.pps * 1.4, store.time);
      else if (k === '-') Timeline.zoomAt(Timeline.pps / 1.4, store.time);
      else if (e.shiftKey && code === 'KeyZ') Timeline.fit();
      else if (k === 'escape') store.select(null);
      else handled = false;
      if (handled) e.preventDefault();
    });
  },
  // ---------------------------------------------------------------- атрибуты клипа
  // Группы настроек, которые можно перенести с клипа на клип (ключевые кадры — на те же места клипа)
  ATTR_GROUPS: [
    { id: 'tf', name: 'Трансформация и ключевые кадры', ok: c => !!c.transform, keys: ['transform', 'opacity', 'keys', 'flipH', 'flipV'] },
    { id: 'color', name: 'Цвет и фильтр', ok: c => !!c.adjust, keys: ['adjust', 'filter', 'curves'] },
    { id: 'chroma', name: 'Хромакей', ok: c => !!c.chroma, keys: ['chroma'] },
    { id: 'mask', name: 'Маска', ok: c => c.kind === 'video' || c.kind === 'image', keys: ['mask'] },
    { id: 'fx', name: 'Эффекты клипа', ok: c => c.kind === 'video' || c.kind === 'image', keys: ['fx'] },
    { id: 'blend', name: 'Наложение', ok: c => isVisual(c), keys: ['blend'] },
    { id: 'anim', name: 'Анимации и размытие в движении', ok: c => !!c.anim, keys: ['anim', 'tanim', 'mblur'] },
    { id: 'matte', name: 'Слой-маска (Track Matte)', ok: c => isVisual(c), keys: ['matte'] },
    { id: 'speed', name: 'Скорость и кривая', ok: c => c.kind === 'video' || c.kind === 'audio', keys: ['speed', 'curve'] },
    { id: 'vol', name: 'Громкость и приглушение', ok: c => hasAudioTrack(c), keys: ['volume', 'vkeys', 'fadeIn', 'fadeOut', 'duck'] },
    { id: 'voice', name: 'Шумоподавление и голос', ok: c => VoiceSep.canUse(c), keys: ['denoise', 'voiceFx'] },
    { id: 'text', name: 'Стиль текста', ok: c => c.kind === 'text', keys: ['style'] },
    { id: 'stab', name: 'Стабилизация', ok: c => c.kind === 'video', keys: ['stab'] },
  ],
  copyAttrs() {
    const s = store.selected();
    if (!s) return;
    const c = s.clip;
    this.attrs = { clip: deep(c), keysLt: (c.keys || []).map(k => ltAt(c, k.s)), vkeysLt: (c.vkeys || []).map(k => ltAt(c, k.s)),
      maskKeysLt: (c.mask && c.mask.keys || []).map(k => ltAt(c, k.s)), groups: this.ATTR_GROUPS.filter(g => g.ok(c)).map(g => g.id) };
    toast('Атрибуты скопированы — выберите клип и вставьте их (Ctrl+Alt+V)', 'info', 2200);
  },
  pasteAttrs() {
    const s = store.selected();
    if (!s || !this.attrs) return;
    const c = s.clip, A = this.attrs;
    if (A.clip.id === c.id) { toast('Выберите другой клип', 'info'); return; }
    const groups = this.ATTR_GROUPS.filter(g => A.groups.includes(g.id) && g.ok(c));
    if (!groups.length) { toast('Этому клипу нечего передать', 'info'); return; }
    this.lastAttrSel = this.lastAttrSel || new Set(['tf', 'color', 'mask', 'blend', 'anim', 'vol', 'chroma', 'text']);
    const body = h(`<div class="attr-pick">${groups.map(g => `<label class="check"><input type="checkbox" data-g="${g.id}" ${this.lastAttrSel.has(g.id) ? 'checked' : ''}><span></span>${g.name}</label>`).join('')}</div>`);
    modal({ title: 'Вставить атрибуты', body, width: 380, buttons: [{ label: 'Отмена' }, { label: 'Вставить', primary: true, onClick: () => {
      const sel = new Set($$('input:checked', body).map(i => i.dataset.g));
      this.lastAttrSel = sel;
      const src = A.clip;
      for (const g of groups) {
        if (!sel.has(g.id)) continue;
        for (const k of g.keys) { if (src[k] === undefined) delete c[k]; else c[k] = deep(src[k]); }
      }
      // ключевые кадры — по месту в клипе, а не по времени источника
      if (sel.has('tf') && A.keysLt.length) c.keys = src.keys.map((k, i) => ({ ...k, s: srcAt(c, Math.min(A.keysLt[i], clipDur(c))) }));
      if (sel.has('vol') && A.vkeysLt.length) c.vkeys = src.vkeys.map((k, i) => ({ ...k, s: srcAt(c, Math.min(A.vkeysLt[i], clipDur(c))) }));
      if (sel.has('mask') && A.maskKeysLt.length && c.mask) { c.mask.keys = src.mask.keys.map((k, i) => ({ s: srcAt(c, Math.min(A.maskKeysLt[i], clipDur(c))), pts: deep(k.pts) })); c.mask.pts = c.mask.keys[0].pts; }
      if (sel.has('matte') && c.matte && c.matte.id === c.id) delete c.matte;
      if (sel.has('speed')) {
        if (hasCurve(src)) c.curve = deep(src.curve); else delete c.curve;
        if (s.track.main) store.packMain();
        else if (!Timeline.fits(s.track, c, c.start, clipDur(c))) { s.track.clips.splice(s.track.clips.indexOf(c), 1); store.place(c, Timeline.trackKindOf(c)); }
        store.cleanupTracks();
      }
      store.commit('paste-attrs');
      Player.requestRender();
      toast('Атрибуты вставлены', 'ok', 1400);
    } }] });
  },

  copy() {
    const list = store.selectedAll();
    if (!list.length) return;
    // несколько клипов — с взаимным расположением во времени (off — от начала первого)
    const a = Math.min(...list.map(x => x.clip.start));
    const cb = this.clipboard = { items: list.map(x => ({ clip: deep(x.clip), off: x.clip.start - a, kind: Timeline.trackKindOf(x.clip), main: x.track.main })) };
    // отпечаток системного буфера: пока он не сменился, Ctrl+V вставляет этот клип, а не картинку/файл из буфера
    cb.sigP = window.api.clipRead().then(r => { cb.sig = r.sig; }).catch(() => { });
    toast(list.length > 1 ? `Скопировано клипов: ${list.length}` : 'Клип скопирован', 'info', 1200);
  },
  // Ctrl+V: свой скопированный клип, файлы из файлового менеджера, картинка (скриншот) или ссылка на видео
  async paste() {
    if (this.pasting || !store.p) return;
    this.pasting = true;
    try {
      const cb = this.clipboard;
      if (cb && cb.sigP) await cb.sigP;
      let snap = null;
      try { snap = await window.api.clipRead(); } catch { }
      if (cb && (!snap || snap.sig === cb.sig)) { this.pasteClip(); return; }
      if (snap && snap.files.length) {
        const added = await Media.importPaths(snap.files);
        if (added.length) { Media.placeAt(added, store.time); Panels.show('media'); toast(added.length > 1 ? `Вставлено файлов: ${added.length}` : `Вставлено: ${added[0].name}`, 'ok', 1800); }
        return;
      }
      if (snap && snap.image) {
        const f = await window.api.clipSaveImage(store.p.id);
        const [m] = f ? await Media.importPaths([f]) : [];
        if (m) { Media.placeAt([m], store.time); Panels.show('media'); toast('Картинка из буфера вставлена', 'ok', 1800); }
        return;
      }
      const url = snap && Links.urlIn(snap.text);
      if (url) { Links.dialog(url); return; }
      if (cb) { this.pasteClip(); return; }
      toast('В буфере обмена нет клипа, файла, картинки или ссылки', 'info', 2200);
    } finally { this.pasting = false; }
  },
  pasteClip() {
    if (!this.clipboard) return;
    const ids = [];
    let mi = null; // место вставки на главной дорожке (клипы группы идут подряд)
    this.clipboard.items.forEach((it) => {
      const c = deep(it.clip);
      c.id = uid();
      c.start = store.time + it.off;
      if (it.main && store.magnet) {
        const mc = store.mainTrack().clips;
        if (mi == null) { mi = mc.findIndex(x => x.start + clipDur(x) / 2 > store.time); if (mi < 0) mi = mc.length; c.trans = null; }
        mc.splice(mi++, 0, c);
      } else { c.trans = null; store.place(c, it.kind); }
      ids.push(c.id);
    });
    store.packMain();
    store.selectMany(ids);
    store.commit('paste');
  },

  shortcuts() {
    const K = (n) => Edit.K(n), P = Edit.keymap === 'premiere';
    const groups = [
      ['Воспроизведение', [
        ['Пробел', 'Воспроизведение / пауза'], ['J / L', 'Челнок назад / вперёд (ещё раз — быстрее)'], ...(P ? [['K', 'Стоп']] : []),
        ['← / →', 'Кадр назад / вперёд'], ['Shift+← / →', 'Секунда назад / вперёд'], ['↑ / ↓', 'К предыдущей / следующей склейке'],
        ['Home / End', 'В начало / в конец'], ['Ctrl+Shift+Пробел', 'От входа до выхода'],
      ]],
      ['Инструменты', TOOLS.map(t => [t.keys[Edit.keymap], t.name])],
      ['Вход и выход', [
        ['I / O', 'Точка входа / выхода'], ['Shift+I / Shift+O', 'Перейти к входу / выходу'], ['X', 'Отметить клип'],
        ['Ctrl+Shift+X', 'Очистить вход и выход'], [';', 'Убрать (Lift), оставить пробел'], ["'", 'Извлечь (Extract) со сдвигом'],
      ]],
      ['Монтаж', [
        [K('split'), 'Разделить клип'], [K('splitAll'), 'Разделить на всех дорожках'], ['Q / W', 'Удалить слева / справа от курсора'],
        ['Delete', 'Удалить клип'], ['Shift+Delete', 'Удалить со сдвигом'], ['Shift+E', 'Включить / отключить клип'], ['Ctrl+R', 'Скорость и длительность'],
        ['D', 'Выбрать клип под курсором'], ['Протянуть по пустому месту', 'Выделить рамкой несколько клипов'], ['Ctrl / Shift+щелчок', 'Добавить клип к выделению'], ['Ctrl+A', 'Выделить все клипы'], ['Alt+← / →', 'Сдвинуть клип на кадр (Shift — на 5)'], ['Ctrl+D', 'Дублировать'],
        ['Ctrl+C / Ctrl+V', 'Копировать / вставить (клип, файлы, картинку или ссылку из буфера)'], ['Ctrl+Shift+I', 'Импорт по ссылке (YouTube, TikTok…)'], ['Ctrl+Alt+C / Ctrl+Alt+V', 'Копировать / вставить атрибуты'], ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'],
        [K('marker'), 'Маркер (ещё раз — удалить)'], ['T', 'Добавить текст'], [K('keyframe'), 'Ключевой кадр'], [K('voice'), 'Записать озвучку'],
      ]],
      ['Вид и файл', [
        ['+ / −', 'Масштаб таймлайна'], ['Shift+Z', 'Вписать таймлайн'], ['Ctrl+колесо', 'Масштаб таймлайна'], ['Alt при перетаскивании', 'Без привязки'],
        [K('magnet'), 'Авто-склейка главной дорожки'], [K('snap'), 'Привязка'], ['Ctrl+I', 'Импорт медиа'], ['Ctrl+E', 'Экспорт'], ['Ctrl+S', 'Сохранить'],
      ]],
    ];
    const body = h(`<div class="keys-wrap">
      <div class="ex-row"><label>Раскладка</label><div class="seg km-seg">${KEYMAPS.map(k => `<button data-k="${k.id}" class="${Edit.keymap === k.id ? 'on' : ''}">${k.name}</button>`).join('')}</div></div>
      <div class="keys">${groups.map(([g, rows]) => `<div class="keys-group">${esc(g)}</div>` + rows.map(([k, d]) => `<div><span>${esc(d)}</span><span>${k.split(' / ').map(x => `<kbd>${esc(x)}</kbd>`).join(' / ')}</span></div>`).join('')).join('')}</div>
    </div>`);
    const dlg = modal({ title: 'Горячие клавиши', width: 560, body });
    $('.km-seg', body).onclick = (e) => { const b = e.target.closest('button'); if (!b || b.dataset.k === Edit.keymap) return; Edit.setKeymap(b.dataset.k); dlg.close(); this.shortcuts(); };
  },

  // Свои кнопки окна (системная рамка отключена)
  bindWindow() {
    const ctl = $('#winCtl');
    ctl.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.w === 'min') window.api.winMinimize();
      if (b.dataset.w === 'max') window.api.winToggleMax();
      if (b.dataset.w === 'close') window.api.winClose();
    };
    const setMax = (m) => {
      $('[data-w="max"]', ctl).innerHTML = m
        ? '<svg viewBox="0 0 12 12"><rect x="2.5" y="3.5" width="6" height="6" rx="1"/><path d="M4.5 3.5V2.8a.8.8 0 0 1 .8-.8h4a.8.8 0 0 1 .8.8v4a.8.8 0 0 1-.8.8h-.8"/></svg>'
        : '<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>';
      $('[data-w="max"]', ctl).title = m ? 'Восстановить' : 'Развернуть';
    };
    window.api.onMaximized(setMax);
    window.api.winIsMax().then(setMax);
    // двойной клик по пустому месту шапки — развернуть окно
    $$('.topbar, .titlebar').forEach(el => el.addEventListener('dblclick', (e) => {
      if (e.target === el || e.target.classList.contains('tb-left') || e.target.classList.contains('tb-right') || e.target.classList.contains('tb-center')) window.api.winToggleMax();
    }));
  },

  bindSplitters() {
    const ws = $('#workspace');
    const get = (k, d) => { try { return +localStorage.getItem(k) || d; } catch { return d; } };
    const set = (k, v) => { try { localStorage.setItem(k, v); } catch { } };
    let lw = get('lc.lw', 390), rw = get('lc.rw', 350), th = get('lc.th', 320);
    const apply = () => {
      ws.style.gridTemplateColumns = `${lw}px var(--gap) 1fr var(--gap) ${rw}px`;
      $('#timeline').style.height = th + 'px';
    };
    apply();
    $$('.splitter-v').forEach((sp) => {
      sp.addEventListener('mousedown', (e) => {
        const l0 = lw, r0 = rw, left = sp.dataset.split === 'left';
        dragMove(e, (ev, dx) => {
          if (left) lw = clamp(l0 + dx, 260, 640); else rw = clamp(r0 - dx, 260, 560);
          apply();
        }, () => { set('lc.lw', lw); set('lc.rw', rw); }, 'col-resize');
      });
    });
    $('#splitterH').addEventListener('mousedown', (e) => {
      const t0 = th;
      dragMove(e, (ev, dx, dy) => { th = clamp(t0 - dy, 180, innerHeight - 320); apply(); }, () => set('lc.th', th), 'row-resize');
    });
  },

  bindDrop() {
    // Файлы из файлового менеджера — в медиатеку
    const ed = $('#editor');
    let depth = 0;
    ed.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth++; $('#dropHint').classList.remove('hidden'); } });
    ed.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('#dropHint').classList.add('hidden'); });
    ed.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    ed.addEventListener('drop', async (e) => {
      depth = 0;
      $('#dropHint').classList.add('hidden');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map(f => window.api.pathForFile(f)).filter(Boolean);
      const added = await Media.importPaths(paths);
      if (added.length) { Panels.show('media'); toast(`Импортировано: ${added.length}`, 'ok'); }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
