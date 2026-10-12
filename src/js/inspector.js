// Правая панель: свойства выделенного клипа или проекта
const SWATCHES = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0ff', '#5856d6', '#af52de', '#ff2d92', '#a2845e'];

const Inspector = {
  tabs: {},        // запомненная вкладка для каждого типа клипа
  refreshers: [],
  clip: null,

  init() {
    this.root = $('#inspector');
    bus.on('selection', () => this.render());
    bus.on('project', () => {
      const s = store.selected();
      if ((s ? s.clip : null) !== this.clip) this.render();
      else this.refresh();
    });
    bus.on('transform', () => this.refresh());
    bus.on('time', () => { const c = this.clip; if (c && ((c.keys && c.keys.length) || hasCurve(c) || (c.vkeys && c.vkeys.length) || (c.mask && c.mask.keys) || Roto.pick)) this.refresh(); });
    bus.on('resize', () => { if (!store.sel) this.render(); });
  },

  refresh() { for (const f of this.refreshers) f(); },

  render() {
    const s = store.selected();
    const prevKey = this.viewKey;
    if (Player.pick && Player.pick.c !== (s && s.clip)) Player.stopPick();
    if (Roto.pick && Roto.pick.c !== (s && s.clip)) { Roto.stopPick(false); return; }
    this.clip = s ? s.clip : null;
    this.refreshers = [];
    const scroll = $('.insp-body', this.root);
    const st = scroll ? scroll.scrollTop : 0;
    this.root.innerHTML = '';
    if (!store.p) return;
    if (!s) { if (Player.maskEdit) { Player.maskEdit = null; Player.drawOverlay(); } return this.renderProject(); }
    const c = s.clip, m = c.mediaId ? store.media(c.mediaId) : null;
    let tabs;
    if (c.kind === 'effect') tabs = [['effect', 'Эффект']];
    else if (c.kind === 'text') tabs = [['text', 'Текст'], ['anim', 'Анимация']];
    else if (c.kind === 'audio') tabs = [['audio', 'Аудио'], ['speed', 'Скорость']];
    else if (c.kind === 'image') tabs = [['video', 'Изображение'], ['anim', 'Анимация'], ['adjust', 'Цвет'], ['mask', 'Маска']];
    else tabs = [['video', 'Видео'], ...(m && m.hasAudio ? [['audio', 'Аудио']] : []), ['speed', 'Скорость'], ['anim', 'Анимация'], ['adjust', 'Цвет'], ['mask', 'Маска']];
    tabs.push(...Plugins.inspectorTabs(c));
    let tab = this.tabs[c.kind];
    if (!tabs.find(t => t[0] === tab)) tab = tabs[0][0];
    const head = h(`<div class="insp-tabs">${tabs.map(([id, l]) => `<button data-t="${id}" class="${id === tab ? 'active' : ''}">${l}</button>`).join('')}</div>`);
    head.onclick = (e) => { const b = e.target.closest('button'); if (!b || b.dataset.t === tab) return; this.tabs[c.kind] = b.dataset.t; this.render(); };
    this.root.appendChild(head);
    const dir = tabInk.update(head, 'insp');
    const body = h('<div class="insp-body"></div>');
    this.root.appendChild(body);
    const own = ({ video: () => this.videoTab(body, c), audio: () => this.audioTab(body, c), speed: () => this.speedTab(body, c, s.track), anim: () => this.animTab(body, c), adjust: () => this.adjustTab(body, c), mask: () => this.maskTab(body, c), text: () => this.textTab(body, c), effect: () => this.effectTab(body, c) })[tab];
    if (own) own(); else Plugins.renderInspectorTab(tab, body, c);
    Plugins.inspectorSections(tab, body, c);
    hydrateIcons(body);
    if (this.clip === c) body.scrollTop = st;
    // плавная смена содержимого — только при смене клипа или вкладки, не при обновлениях
    this.viewKey = c.id + ':' + tab;
    // на вкладке «Маска» перетаскивание в превью двигает маску, а не клип
    const me = tab === 'mask' ? c.id : null;
    if (Player.maskEdit !== me) { Player.maskEdit = me; Player.penSel = null; Player.drawOverlay(); }
    if (prevKey !== this.viewKey) animIn(body, prevKey && prevKey.startsWith(c.id + ':') ? dir : 0);
  },

  collapsed: new Set(),
  section(body, title, extra) {
    const sec = h(`<div class="insp-sec"><div class="sec-title"><span>${esc(title)}</span></div><div class="sec-body"></div></div>`);
    if (extra) $('.sec-title', sec).appendChild(extra);
    if (this.collapsed.has(title)) sec.classList.add('collapsed');
    $('.sec-title > span', sec).onclick = () => {
      const body = $('.sec-body', sec);
      if (sec.classList.contains('collapsed')) {
        sec.classList.remove('collapsed');
        this.collapsed.delete(title);
        slideToggle(body, true);
      } else {
        this.collapsed.add(title);
        sec.classList.add('closing');
        slideToggle(body, false, () => { sec.classList.remove('closing'); sec.classList.add('collapsed'); });
      }
    };
    body.appendChild(sec);
    return $('.sec-body', sec);
  },
  resetBtn(fn) {
    const b = h(`<button class="icon-btn tiny" title="Сбросить">${icon('reset')}</button>`);
    b.onclick = fn;
    return b;
  },
  live() { Player.requestRender(); Timeline.render(); },

  // ---------------------------------------------------------------- трансформация
  transformSection(body, c) {
    const T = () => store.time;
    const tf = () => tfAt(c, T());
    // кнопки ключевых кадров в заголовке секции
    const kf = h(`<div class="kf-ctl">
      <button class="icon-btn tiny" data-k="prev" title="Предыдущий ключевой кадр">${icon('chevronLeft')}</button>
      <button class="kf-btn" data-k="toggle" title="Ключевой кадр (K)"><i></i></button>
      <button class="icon-btn tiny" data-k="next" title="Следующий ключевой кадр">${icon('chevronRight')}</button>
      <button class="icon-btn tiny" data-k="reset" title="Сбросить">${icon('reset')}</button>
    </div>`);
    const sec = this.section(body, 'Трансформация', kf);
    const updKf = () => {
      const on = keyIndexAt(c, T()) >= 0, has = !!(c.keys && c.keys.length);
      $('.kf-btn', kf).classList.toggle('on', on);
      $('.kf-btn', kf).classList.toggle('has', has);
      const src = srcTime(c, T());
      $('[data-k=prev]', kf).disabled = !has || !c.keys.some(k => k.s < src - 1e-3);
      $('[data-k=next]', kf).disabled = !has || !c.keys.some(k => k.s > src + 1e-3);
    };
    kf.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const k = b.dataset.k, src = srcTime(c, T());
      const toT = (ks) => c.start + ltAt(c, ks);
      if (k === 'toggle') { const added = toggleKey(c, T()); store.commit('keyframe'); toast(added ? 'Ключевой кадр добавлен' : 'Ключевой кадр удалён', 'info', 1200); }
      if (k === 'prev') { const ks = c.keys.filter(x => x.s < src - 1e-3).pop(); if (ks) store.setTime(toT(ks.s)); }
      if (k === 'next') { const ks = c.keys.find(x => x.s > src + 1e-3); if (ks) store.setTime(toT(ks.s)); }
      if (k === 'reset') { c.keys = []; putTf(c, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, sx: 1, sy: 1, rx: 0, ry: 0 }); delete c.transform.free; store.commit('reset'); this.render(); return; }
      Player.requestRender(); this.refresh();
    };
    // масштаб: равномерный (один ползунок) или отдельно по ширине и высоте, как в CapCut.
    // c.transform.free — режим «по ширине и высоте»; ширина = scale·sx, высота = scale·sy
    const free = !!c.transform.free || [c.transform, ...(c.keys || [])].some(o => Math.abs((o.sx ?? 1) - (o.sy ?? 1)) > 1e-4);
    const pctRow = (label, get, set, key) => sliderRow({ label, min: 5, max: 400, value: get() * 100, def: 100, unit: '%', fmt: v => Math.round(v),
      onInput: v => { set(v / 100); Player.requestRender(); updKf(); }, onCommit: () => store.commit(key) });
    const scaleRows = free ? [
      pctRow('Ширина', () => tf().scale * tf().sx, v => setTf(c, { sx: v / tf().scale }, T()), 'scale-w'),
      pctRow('Высота', () => tf().scale * tf().sy, v => setTf(c, { sy: v / tf().scale }, T()), 'scale-h'),
    ] : [pctRow('Масштаб', () => tf().scale, v => setTf(c, { scale: v }, T()), 'scale')];
    scaleRows.forEach(r => sec.appendChild(r));
    sec.appendChild(toggleRow('Равномерное масштабирование', !free, (on) => {
      if (on) {
        // высота становится равной ширине — во всех ключах
        const eq = (o) => { o.scale *= o.sx ?? 1; o.sx = 1; o.sy = 1; };
        eq(c.transform);
        for (const kk of c.keys || []) eq(kk);
        delete c.transform.free;
      } else c.transform.free = true;
      store.commit('scale-mode'); Player.requestRender(); this.render();
    }));
    const pos = h(`<div class="prop-row"><label>Позиция</label><div class="xy">
      <div class="num-box"><span class="unit pre">X</span><input class="num" data-k="x"></div>
      <div class="num-box"><span class="unit pre">Y</span><input class="num" data-k="y"></div></div></div>`);
    const setPos = () => { const v = tf(); $$('input', pos).forEach(i => { if (document.activeElement !== i) i.value = Math.round(v[i.dataset.k]); }); };
    setPos();
    $$('input', pos).forEach(i => {
      i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
      i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) { setTf(c, { [i.dataset.k]: v }, T()); store.commit('pos'); Player.requestRender(); } setPos(); });
      numDrag(i, (d) => { setTf(c, { [i.dataset.k]: Math.round(tf()[i.dataset.k] + d) }, T()); setPos(); Player.requestRender(); updKf(); }, () => store.commit('pos'));
    });
    sec.appendChild(pos);
    const degRow = (label, key, tip) => {
      const r = sliderRow({ label, min: -180, max: 180, value: tf()[key], def: 0, unit: '°', fmt: v => Math.round(v),
        onInput: v => { setTf(c, { [key]: v }, T()); Player.requestRender(); updKf(); }, onCommit: () => store.commit(key) });
      if (tip) $('label', r).title = tip;
      return r;
    };
    const rot = degRow('Поворот', 'rotation');
    sec.appendChild(rot);
    // 3D-поворот, как в Paint 3D (в превью — ручки сверху и справа от рамки)
    const rx = degRow('Наклон X', 'rx', 'Поворот вокруг горизонтальной оси: верх уходит вглубь');
    const ry = degRow('Разворот Y', 'ry', 'Поворот вокруг вертикальной оси: правый край уходит вглубь');
    sec.appendChild(rx); sec.appendChild(ry);
    const op = sliderRow({ label: 'Непрозрачн.', min: 0, max: 100, value: tf().opacity * 100, def: 100, unit: '%', fmt: v => Math.round(v),
      onInput: v => { setTf(c, { opacity: v / 100 }, T()); Player.requestRender(); updKf(); }, onCommit: () => store.commit('opacity') });
    sec.appendChild(op);
    // выравнивание по краям и центру кадра (по видимым габаритам объекта)
    const al = h(`<div class="seg wide align-row">
      <button data-a="l" title="По левому краю">${icon('alL')}</button>
      <button data-a="ch" title="По центру по горизонтали">${icon('alCH')}</button>
      <button data-a="r" title="По правому краю">${icon('alR')}</button>
      <button data-a="t" title="По верхнему краю">${icon('alT')}</button>
      <button data-a="cv" title="По центру по вертикали">${icon('alCV')}</button>
      <button data-a="b" title="По нижнему краю">${icon('alB')}</button></div>`);
    al.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const W = store.p.width, H = store.p.height, a = Player.aabb(clipBox(c, W, H, T())), v = tf();
      const d = { l: [-a.l, 0], ch: [W / 2 - (a.l + a.r) / 2, 0], r: [W - a.r, 0], t: [0, -a.t], cv: [0, H / 2 - (a.t + a.b) / 2], b: [0, H - a.b] }[b.dataset.a];
      setTf(c, { x: Math.round(v.x + d[0]), y: Math.round(v.y + d[1]) }, T());
      store.commit('align'); Player.requestRender(); refresh();
    };
    sec.appendChild(al);
    const hint = h(`<p class="muted small kf-hint"></p>`);
    sec.appendChild(hint);
    const refresh = () => {
      const v = tf();
      if (free) { scaleRows[0].set(v.scale * v.sx * 100); scaleRows[1].set(v.scale * v.sy * 100); } else scaleRows[0].set(v.scale * 100);
      rot.set(v.rotation); rx.set(v.rx); ry.set(v.ry); op.set(v.opacity * 100); setPos(); updKf();
      const n = c.keys ? c.keys.length : 0;
      hint.textContent = n ? `Ключевых кадров: ${n}. Изменения на другой позиции курсора создают новый кадр.` : 'Нажмите ◆, чтобы добавить ключевой кадр и анимировать объект.';
    };
    refresh();
    this.refreshers.push(refresh);
    return sec;
  },

  // открыть эффекты клипа (значок fx на таймлайне, перетаскивание эффекта на клип)
  showFx(c) {
    this.tabs[c.kind] = 'video';
    if (store.sel !== c.id) store.select(c.id);
    this.render();
    const sec = $('.insp-sec.fx-sec', this.root);
    if (!sec) return;
    if (sec.classList.contains('collapsed')) $('.sec-title > span', sec).click();
    sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash');
  },

  // ---------------------------------------------------------------- эффекты на клипе (c.fx)
  clipFxSection(body, c) {
    const add = h(`<button class="icon-btn tiny" title="Добавить эффект">${icon('plus')}</button>`);
    add.onclick = () => { Panels.show('effects'); };
    const sec = this.section(body, 'Эффекты', add);
    sec.parentElement.classList.add('fx-sec');
    const list = c.fx || [];
    if (!list.length) {
      sec.appendChild(h(`<p class="muted small">Перетащите эффект из панели «Эффекты» на клип на таймлайне — он будет действовать только на этот клип.</p>`));
      return;
    }
    const live = () => { Player.requestRender(); Timeline.render(); };
    list.forEach((f, i) => {
      const fx = EFFECT_BY_ID[f.effect];
      f.params = f.params || { strength: 60, speed: 50 };
      const box = h(`<div class="cfx ${f.on === false ? 'off' : ''}">
        <div class="cfx-head">
          <button class="switch ${f.on !== false ? 'on' : ''}" title="Включить / выключить"><i></i></button>
          <b>${esc(fx ? fx.name : 'Неизвестный эффект')}</b>
          <button class="icon-btn tiny" data-a="up" title="Выше" ${i ? '' : 'disabled'}><span style="display:inline-flex;transform:rotate(-90deg)">${icon('chevronRight')}</span></button>
          <button class="icon-btn tiny" data-a="del" title="Удалить эффект">${icon('trash')}</button>
        </div></div>`);
      $('.switch', box).onclick = () => { f.on = f.on === false; store.commit('fx-clip-on'); live(); this.render(); };
      $('[data-a=del]', box).onclick = () => { list.splice(i, 1); if (!list.length) delete c.fx; store.commit('fx-clip-del'); live(); this.render(); };
      $('[data-a=up]', box).onclick = () => { if (!i) return; list.splice(i - 1, 0, list.splice(i, 1)[0]); store.commit('fx-clip-order'); live(); this.render(); };
      if (fx && fx.strength !== false) box.appendChild(sliderRow({ label: 'Сила', min: 0, max: 100, value: f.params.strength ?? 60, def: 60, fmt: v => Math.round(v),
        onInput: v => { f.params.strength = v; Player.requestRender(); }, onCommit: () => store.commit('fx-param') }));
      if (fx && fx.speed !== false) box.appendChild(sliderRow({ label: 'Скорость', min: 0, max: 100, value: f.params.speed ?? 50, def: 50, fmt: v => Math.round(v),
        onInput: v => { f.params.speed = v; Player.requestRender(); }, onCommit: () => store.commit('fx-param') }));
      sec.appendChild(box);
    });
  },

  videoTab(body, c) {
    this.transformSection(body, c);
    this.clipFxSection(body, c);
    const sec = this.section(body, 'Кадрирование и положение');
    const row = h(`<div class="btn-grid">
      <button class="chip-btn" data-a="fit">${icon('fit')}Вписать</button>
      <button class="chip-btn" data-a="fill">${icon('maximize')}Заполнить</button>
      <button class="chip-btn ${c.flipH ? 'on' : ''}" data-a="flipH">${icon('flip')}Отразить</button>
      <button class="chip-btn ${c.flipV ? 'on' : ''}" data-a="flipV"><span style="transform:rotate(90deg);display:inline-flex">${icon('flip')}</span>Перевернуть</button>
      <button class="chip-btn" data-a="rot">${icon('rotate')}Поворот 90°</button>
      <button class="chip-btn" data-a="center">${icon('grid')}По центру</button>
    </div>`);
    row.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const a = b.dataset.a, W = store.p.width, H = store.p.height, ms = mediaSize(c);
      if (a === 'fit') setTf(c, { scale: 1, x: 0, y: 0 }, store.time);
      if (a === 'fill') { const f = Math.min(W / ms.w, H / ms.h); const r = Math.abs(tfAt(c, store.time).rotation) % 180 === 90; const need = r ? Math.max(H / (ms.w * f), W / (ms.h * f)) : Math.max(W / (ms.w * f), H / (ms.h * f)); setTf(c, { scale: need, x: 0, y: 0 }, store.time); }
      if (a === 'flipH') c.flipH = !c.flipH;
      if (a === 'flipV') c.flipV = !c.flipV;
      if (a === 'rot') { const r0 = tfAt(c, store.time).rotation; setTf(c, { rotation: ((Math.round(r0 / 90) * 90 + 90 + 180) % 360) - 180 }, store.time); }
      if (a === 'center') setTf(c, { x: 0, y: 0 }, store.time);
      store.commit('video'); Player.requestRender(); this.render();
    };
    sec.appendChild(row);
    this.trackSection(body, c);
    if (TextEdit.canUse(c)) this.textEditSection(body, c);
    this.blendSection(body, c);
    if (Stab.canUse(c)) this.stabSection(body, c);
    this.chromaSection(body, c);
    if (Roto.canUse(c)) this.rotoSection(body, c);
    if (c.filter && c.filter.name) {
      const f = FILTER_PRESETS.find(x => x.id === c.filter.name);
      const fs = this.section(body, 'Фильтр: ' + (f ? f.name : ''), this.resetBtn(() => { c.filter.name = null; store.commit('filter'); Player.requestRender(); this.render(); }));
      fs.appendChild(sliderRow({ label: 'Сила', min: 0, max: 100, value: c.filter.intensity, def: 100, fmt: v => Math.round(v),
        onInput: v => { c.filter.intensity = v; Player.requestRender(); }, onCommit: () => store.commit('filter') }));
    }
  },

  // Замена текста на кадре (textedit.js)
  textEditSection(body, c) {
    const sec = this.section(body, 'Текст на кадре');
    const row = h(`<div class="btn-grid"><button class="chip-btn ${TextEdit.replaced(c) ? '' : 'span2'}" data-a="edit">${icon('type')}Заменить текст…</button>${TextEdit.replaced(c) ? `<button class="chip-btn" data-a="undo">${icon('undo')}Вернуть исходный</button>` : ''}</div>`);
    row.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.a === 'edit') TextEdit.open(c); else TextEdit.restore(c); };
    sec.appendChild(row);
    sec.appendChild(h(`<p class="muted small">Нейросеть найдёт текст на кадре под курсором, сотрёт его и подберёт тот же шрифт, цвет и размер — останется вписать новый.</p>`));
  },

  // Трекинг: клип следует за объектом, камера следит за объектом или «захват»
  trackSection(body, c) {
    const sec = this.section(body, 'Трекинг');
    const f = c.follow, j = Track.jobFor(c);
    if (j) {
      const st = h(`<div class="vs-state"><i class="spin"></i><span>Ищем объект на кадрах… ${jobPct(j)}</span><button class="link">Отмена</button></div>`);
      $('button', st).onclick = () => Track.cancel(c);
      sec.appendChild(st);
      this.refreshers.push(() => { const jj = Track.jobFor(c); if (jj) $('span', st).textContent = `Ищем объект на кадрах… ${jobPct(jj)}`; });
      return;
    }
    const modes = c.kind === 'video' ? ['attach', 'camera', 'lock'] : ['attach'];
    if (!f) {
      const grid = h(`<div class="track-modes">${modes.map(m => `<button class="chip-btn" data-m="${m}" data-tip="${esc(FOLLOW_MODES[m].hint)}">${icon(FOLLOW_MODES[m].icon)}${FOLLOW_MODES[m].name}</button>`).join('')}</div>`);
      grid.onclick = (e) => { const b = e.target.closest('button'); if (b) Track.start(c, b.dataset.m); };
      sec.appendChild(grid);
      const eng = h(`<div class="prop-row"><label>Трекер</label><div class="seg"><button data-e="sam2" class="${Track.engine === 'sam2' ? 'on' : ''}">Точный</button><button data-e="face" class="${Track.engine === 'face' ? 'on' : ''}">Лицо</button><button data-e="csrt" class="${Track.engine === 'csrt' ? 'on' : ''}">Быстрый</button></div></div>`);
      eng.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; Track.setEngine(b.dataset.e); $$('button', eng).forEach(x => x.classList.toggle('on', x === b)); };
      sec.appendChild(eng);
      sec.appendChild(h(`<p class="muted small">${c.kind === 'video' ? 'Выберите режим и обведите объект рамкой в превью.' : 'Поставьте курсор над видео, нажмите «За объектом» и обведите объект рамкой — клип поедет за ним.'} «Точный» — нейросеть SAM 2 (если обвести лицо, сама включит «Лицо»), «Лицо» — детектор лиц, не слетает и не перескакивает на чужое лицо, «Быстрый» — OpenCV.</p>`));
      return;
    }
    const d = Track.data(c);
    sec.appendChild(h(`<div class="vs-state ok">${icon('check')}<span>${FOLLOW_MODES[f.mode].name} · ${d ? ({ sam2: 'нейросеть', face: 'лицо' }[d.engine] || 'быстрый трекер') : ''} · кадров: ${d ? d.pts.length : 0}</span></div>`));
    const re = () => { Track.apply(c); Player.requestRender(); Timeline.render(); };
    sec.appendChild(sliderRow({ label: 'Сглаживание', min: 0, max: 100, value: f.smooth, def: 35, fmt: v => Math.round(v), onInput: v => { f.smooth = v; re(); }, onCommit: () => store.commit('track-smooth') }));
    if (f.mode === 'camera') sec.appendChild(sliderRow({ label: 'Приближение', min: 100, max: 300, value: f.zoom * 100, def: 150, unit: '%', fmt: v => Math.round(v), onInput: v => { f.zoom = v / 100; re(); }, onCommit: () => store.commit('track-zoom') }));
    sec.appendChild(toggleRow(f.mode === 'attach' ? 'Менять размер с объектом' : f.mode === 'lock' ? 'Держать размер объекта' : 'Следить за размером', !!f.size, (v) => { f.size = v; re(); store.commit('track-size'); }));
    const row = h(`<div class="btn-grid"><button class="chip-btn" data-a="redo">${icon('track')}Выделить заново</button><button class="chip-btn" data-a="off">${icon('x')}Убрать трекинг</button></div>`);
    row.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'redo') Track.start(c, f.mode);
      else { Track.remove(c); this.render(); }
    };
    sec.appendChild(row);
    sec.appendChild(h(`<p class="muted small">Трекинг записан ключевыми кадрами — любой кадр можно поправить вручную.</p>`));
  },

  // Стабилизация: убирает тряску (видео немного приближается, чтобы спрятать края)
  stabSection(body, c) {
    const on = Stab.on(c);
    const sw = h(`<button class="switch ${on ? 'on' : ''}" title="Стабилизация"><i></i></button>`);
    const sec = this.section(body, 'Стабилизация', sw);
    sec.classList.toggle('off', !on);
    sw.onclick = () => { if (on) Stab.cancel(c); else Stab.set([c], true); this.render(); };
    const lv = (c.stab && c.stab.level) || 2;
    const seg = h(`<div class="seg wide">${STAB_LEVELS.map(l => `<button data-l="${l.id}" class="${l.id === lv ? 'on' : ''}">${l.name}</button>`).join('')}</div>`);
    seg.onclick = (e) => { const b = e.target.closest('button'); if (!b || +b.dataset.l === lv) return; Stab.set([c], true, +b.dataset.l); this.render(); };
    sec.appendChild(seg);
    const state = h('<div class="vs-state"></div>');
    const show = () => {
      if (!Stab.on(c)) { state.innerHTML = `${icon('info')}<span>Убирает тряску при съёмке с рук. Чем сильнее — тем плавнее, но кадр сильнее приближается.</span>`; state.classList.remove('ok'); return; }
      const j = Stab.jobFor(c), ready = Stab.fileFor(c);
      state.innerHTML = ready ? `${icon('check')}<span>Видео стабилизировано</span>` : `<i class="spin"></i><span>Стабилизация… ${j ? Math.round(j.p * 100) + '%' : ''}</span>`;
      state.classList.toggle('ok', !!ready);
    };
    show();
    this.refreshers.push(show);
    sec.appendChild(state);
  },

  // Режим наложения: как слой смешивается с тем, что под ним
  blendSection(body, c) {
    const cur = () => BLEND_BY_ID[c.blend] || BLENDS[0];
    const sec = this.section(body, 'Наложение');
    const row = h(`<div class="prop-row blend-row"><label>Режим</label><button class="select-btn"><span></span>${icon('chevronDown')}</button></div>`);
    const btn = $('.select-btn', row);
    const show = () => { $('span', btn).textContent = cur().name; };
    show();
    btn.onclick = () => menuBelow(btn, BLENDS.map(b => ({ label: b.name, checked: cur().id === b.id, onClick: () => { c.blend = b.id === 'normal' ? undefined : b.id; if (!c.blend) delete c.blend; store.commit('blend'); Player.requestRender(); show(); } })));
    sec.appendChild(row);
    sec.appendChild(h(`<p class="muted small">«Экран» убирает чёрный фон (огонь, искры, блики), «Умножение» — белый.</p>`));
  },

  // Маска: видна только часть клипа (линия, зеркало, круг, прямоугольник, сердце, звезда)
  maskTab(body, c) {
    const m = Object.assign({}, DEFAULT_MASK, c.mask || {});
    if (c.mask) c.mask = m;
    const sec = this.section(body, 'Маска', this.resetBtn(() => { c.mask = { ...DEFAULT_MASK, type: m.type }; store.commit('mask'); Player.requestRender(); this.render(); }));
    const grid = h(`<div class="mask-grid">${MASKS.map(t => `<button class="mask-tile ${m.type === t.id ? 'on' : ''}" data-id="${t.id}"><span class="mask-ic">${icon(t.icon)}</span><span>${t.name}</span></button>`).join('')}</div>`);
    grid.onclick = (e) => {
      const b = e.target.closest('.mask-tile'); if (!b) return;
      const was = m.type;
      m.type = b.dataset.id;
      if (m.type === 'pen') { m.x = 0; m.y = 0; m.rot = 0; if (!m.pts) m.pts = []; Player.penSel = null; }
      // у каждой фигуры свой удобный размер по умолчанию
      if (was === 'none' || was === 'line' || was === 'mirror') {
        if (m.type === 'mirror') { m.h = 0.3; m.w = 1; }
        else if (m.type !== 'line') { const ms = mediaSize(c), ar = ms ? ms.w / ms.h : 16 / 9; m.h = 0.5; m.w = m.type === 'rect' ? 0.5 : 0.5 / ar; }
      }
      if (m.type === 'none') delete c.mask; else c.mask = m;
      store.commit('mask'); Player.requestRender(); this.render();
    };
    sec.appendChild(grid);
    if (m.type === 'none') {
      this.matteSection(body, c);
      body.appendChild(h(`<div class="insp-tip">${icon('info')}<span>Маска оставляет видимой только часть клипа. Её можно двигать, вращать и растягивать прямо в превью.</span></div>`));
      return;
    }
    if (m.type === 'pen') {
      this.penSection(body, c, m);
      const s2 = this.section(body, 'Параметры');
      s2.appendChild(sliderRow({ label: 'Растушёвка', min: 0, max: 100, value: m.feather, def: 0, fmt: v => Math.round(v), onInput: v => { m.feather = v; Player.requestRender(); }, onCommit: () => store.commit('mask') }));
      s2.appendChild(toggleRow('Инвертировать', m.invert, (v) => { m.invert = v; store.commit('mask'); Player.requestRender(); }));
      this.matteSection(body, c);
      return;
    }
    const s2 = this.section(body, 'Параметры');
    const live = () => { Player.requestRender(); };
    const pct = (label, key, min, max, def, scale = 100) => sliderRow({ label, min, max, value: m[key] * scale, def, unit: '%', fmt: v => Math.round(v),
      onInput: v => { m[key] = v / scale; live(); }, onCommit: () => store.commit('mask') });
    const rows = [];
    rows.push(pct('Позиция X', 'x', -100, 100, 0), pct('Позиция Y', 'y', -100, 100, 0));
    if (m.type === 'mirror') rows.push(pct('Ширина полосы', 'h', 1, 200, 30));
    else if (m.type !== 'line') rows.push(pct('Ширина', 'w', 1, 300, 50), pct('Высота', 'h', 1, 300, 50));
    rows.push(sliderRow({ label: 'Поворот', min: -180, max: 180, value: m.rot, def: 0, unit: '°', fmt: v => Math.round(v), onInput: v => { m.rot = v; live(); }, onCommit: () => store.commit('mask') }));
    rows.push(sliderRow({ label: 'Растушёвка', min: 0, max: 100, value: m.feather, def: 0, fmt: v => Math.round(v), onInput: v => { m.feather = v; live(); }, onCommit: () => store.commit('mask') }));
    if (m.type === 'rect') rows.push(sliderRow({ label: 'Скругление', min: 0, max: 100, value: m.round, def: 0, fmt: v => Math.round(v), onInput: v => { m.round = v; live(); }, onCommit: () => store.commit('mask') }));
    rows.forEach(r => s2.appendChild(r));
    s2.appendChild(toggleRow('Инвертировать', m.invert, (v) => { m.invert = v; store.commit('mask'); live(); }));
    // ползунки следят за перетаскиванием маски в превью
    const keys = ['x', 'y', ...(m.type === 'mirror' ? ['h'] : m.type !== 'line' ? ['w', 'h'] : []), 'rot'];
    this.refreshers.push(() => keys.forEach((k, i) => rows[i].set(k === 'rot' ? m.rot : m[k] * 100)));
    this.matteSection(body, c);
  },

  // Хромакей: вырезать фон по цвету (зелёный, синий или любой, выбранный пипеткой)
  chromaSection(body, c) {
    const ch = c.chroma;
    const sw = h(`<button class="switch ${ch.on ? 'on' : ''}" title="${ch.on ? 'Выключить' : 'Включить'} хромакей"><i></i></button>`);
    const sec = this.section(body, 'Хромакей', sw);
    sec.classList.toggle('off', !ch.on);
    const upd = () => { Player.requestRender(); };
    const setOn = (v) => { ch.on = v; sw.classList.toggle('on', v); sec.classList.toggle('off', !v); upd(); };
    sw.onclick = () => { setOn(!ch.on); store.commit('chroma'); };
    const presets = [['#00ff00', 'Зелёный фон'], ['#0047ff', 'Синий фон']];
    const row = h(`<div class="prop-row key-row"><label>Цвет</label>
      <label class="key-swatch" title="Свой цвет"><i></i><input type="color"></label>
      <button class="chip-btn key-pick" title="Пипетка: кликните по фону в кадре (Esc — отмена)">${icon('eyedropper')}Пипетка</button>
      ${presets.map(([col, t]) => `<button class="sw key-preset" style="background:${col}" data-c="${col}" title="${t}"></button>`).join('')}
    </div>`);
    const inp = $('input', row), pick = $('.key-pick', row);
    const showColor = () => { $('.key-swatch i', row).style.background = ch.color; inp.value = ch.color; $$('.key-preset', row).forEach(b => b.classList.toggle('on', b.dataset.c === ch.color)); };
    showColor();
    const setColor = (col, commit) => { ch.color = col; showColor(); if (!ch.on) setOn(true); upd(); if (commit) store.commit('chroma'); };
    inp.addEventListener('input', () => setColor(inp.value, false));
    inp.addEventListener('change', () => setColor(inp.value, true));
    row.addEventListener('click', (e) => { const b = e.target.closest('.key-preset'); if (b) setColor(b.dataset.c, true); });
    pick.onclick = () => {
      if (Player.pick) { Player.stopPick(); return; }
      if (store.time < c.start || store.time >= clipEnd(c)) store.setTime(c.start + Math.min(0.5, clipDur(c) / 2));
      pick.classList.add('on');
      Player.startPick(c, (col) => setColor(col, true), () => pick.classList.remove('on'));
    };
    sec.appendChild(row);
    const slider = (label, key, def) => sliderRow({ label, min: 0, max: 100, value: ch[key], def, fmt: v => Math.round(v),
      onInput: v => { ch[key] = v; if (!ch.on) setOn(true); upd(); }, onCommit: () => store.commit('chroma') });
    sec.appendChild(slider('Интенсивность', 'strength', DEFAULT_CHROMA.strength));
    sec.appendChild(slider('Мягкость', 'soft', DEFAULT_CHROMA.soft));
    sec.appendChild(slider('Убрать отсвет', 'spill', DEFAULT_CHROMA.spill));
  },

  // Голос и фон: нейросеть оставляет только голос или только фон (для переозвучки)
  voiceSection(body, c) {
    const sec = this.section(body, 'Голос и фон');
    const seg = h(`<div class="seg wide">
      <button data-m="">Исходный</button><button data-m="bg">Без голоса</button><button data-m="voice">Только голос</button></div>`);
    const state = h('<div class="vs-state"></div>');
    const show = () => {
      $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.m === (c.voiceMode || '')));
      const j = VoiceSep.jobFor(c), ready = VoiceSep.stemFor(c);
      state.innerHTML = !c.voiceMode ? `${icon('info')}<span>Уберите голос, чтобы переозвучить момент, или оставьте только голос без музыки и шумов.</span>`
        : ready ? `${icon('check')}<span>${c.voiceMode === 'bg' ? 'Голос удалён — слышен только фон' : 'Оставлен только голос'}</span>`
        : `<i class="spin"></i><span>Нейросеть обрабатывает звук… ${j ? jobPct(j) : ''}</span>${j ? '<button class="link vs-cancel">Отмена</button>' : ''}`;
      state.classList.toggle('ok', !!(c.voiceMode && ready));
      const cancel = $('.vs-cancel', state);
      if (cancel) cancel.onclick = () => { VoiceSep.cancelAll(); VoiceSep.set([c], null); };
    };
    seg.onclick = (e) => { const b = e.target.closest('button'); if (b) VoiceSep.set([c], b.dataset.m || null).then(show); };
    show();
    this.refreshers.push(show);
    sec.appendChild(seg);
    sec.appendChild(state);
  },

  // Изменение голоса: пресеты VOICE_FX, звук обрабатывается в файл
  voiceFxSection(body, c) {
    const sec = this.section(body, 'Изменение голоса');
    sec.classList.add('vfx-sec');
    const grid = VoiceFx.grid(c.voiceFx, (id) => VoiceFx.set([c], id));
    sec.appendChild(grid);
    const state = h('<div class="vs-state"></div>');
    const show = () => {
      $$('.vfx-tile', grid).forEach(b => b.classList.toggle('on', b.dataset.id === (c.voiceFx || '')));
      const v = VOICE_FX_BY_ID[c.voiceFx], ready = v && VoiceFx.fileFor(c);
      state.classList.toggle('hidden', !v);
      if (!v) return;
      const wait = c.voiceMode && !VoiceSep.stemFor(c);
      state.innerHTML = ready ? `${icon('check')}<span>Голос «${v.name}» готов</span>` : `<i class="spin"></i><span>${wait ? 'Ждём нейросеть «Голос и фон»…' : 'Обработка голоса…'}</span>`;
      state.classList.toggle('ok', !!ready);
    };
    show();
    this.refreshers.push(show);
    sec.appendChild(state);
  },
  // открыть вкладку «Аудио» клипа и прокрутить к голосам
  showVoiceFx(c) {
    store.select(c.id);
    this.tabs[c.kind] = 'audio';
    this.render();
    const s = $('.vfx-sec', this.root);
    if (s) s.parentElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },

  audioTab(body, c) {
    const lt = () => store.time - c.start;
    const inClip = () => lt() >= 0 && lt() < clipDur(c);
    const kf = h(`<div class="kf-ctl">
      <button class="icon-btn tiny" data-k="prev" title="Предыдущий ключевой кадр громкости">${icon('chevronLeft')}</button>
      <button class="kf-btn" data-k="toggle" title="Ключевой кадр громкости"><i></i></button>
      <button class="icon-btn tiny" data-k="next" title="Следующий ключевой кадр громкости">${icon('chevronRight')}</button>
    </div>`);
    const sec = this.section(body, 'Громкость', kf);
    const vol = sliderRow({ label: 'Громкость', min: 0, max: 200, value: volAt(c, clamp(lt(), 0, clipDur(c))) * 100, def: 100, unit: '%', fmt: v => Math.round(v),
      onInput: v => { setVol(c, v / 100, clamp(lt(), 0, clipDur(c))); Timeline.drawCanvases(true); updKf(); }, onCommit: () => store.commit('volume') });
    sec.appendChild(vol);
    const updKf = () => {
      const has = !!(c.vkeys && c.vkeys.length), on = has && volKeyIndex(c, lt()) >= 0, src = srcAt(c, clamp(lt(), 0, clipDur(c)));
      $('.kf-btn', kf).classList.toggle('on', on);
      $('.kf-btn', kf).classList.toggle('has', has);
      $('.kf-btn', kf).disabled = !inClip();
      $('[data-k=prev]', kf).disabled = !has || !c.vkeys.some(k => k.s < src - 1e-3);
      $('[data-k=next]', kf).disabled = !has || !c.vkeys.some(k => k.s > src + 1e-3);
    };
    kf.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const k = b.dataset.k, src = srcAt(c, clamp(lt(), 0, clipDur(c)));
      if (k === 'toggle') { const added = toggleVolKey(c, lt()); store.commit('vol-key'); toast(added ? 'Ключевой кадр громкости добавлен' : 'Ключевой кадр громкости удалён', 'info', 1200); }
      if (k === 'prev') { const x = c.vkeys.filter(q => q.s < src - 1e-3).pop(); if (x) store.setTime(c.start + ltAt(c, x.s)); }
      if (k === 'next') { const x = c.vkeys.find(q => q.s > src + 1e-3); if (x) store.setTime(c.start + ltAt(c, x.s)); }
      Timeline.drawCanvases(true); this.refresh();
    };
    const hint = h(`<p class="muted small kf-hint"></p>`);
    const refresh = () => {
      vol.set(volAt(c, clamp(lt(), 0, clipDur(c))) * 100); updKf();
      hint.textContent = c.vkeys && c.vkeys.length ? `Ключевых кадров громкости: ${c.vkeys.length}. Двигайте ползунок в другом месте клипа — появится новый кадр.` : 'Нажмите ◆, чтобы громкость менялась по ходу клипа.';
    };
    this.refreshers.push(refresh);
    const d = clipDur(c);
    const maxF = Math.min(10, Math.round(d * 10) / 20);
    sec.appendChild(sliderRow({ label: 'Нарастание', min: 0, max: Math.max(0.1, maxF), step: 0.1, value: c.fadeIn, unit: 'с',
      onInput: v => { c.fadeIn = v; Timeline.drawCanvases(true); }, onCommit: () => store.commit('fade') }));
    sec.appendChild(sliderRow({ label: 'Затухание', min: 0, max: Math.max(0.1, maxF), step: 0.1, value: c.fadeOut, unit: 'с',
      onInput: v => { c.fadeOut = v; Timeline.drawCanvases(true); }, onCommit: () => store.commit('fade') }));
    sec.appendChild(toggleRow('Выключить звук', !!c.muted, (v) => { c.muted = v; store.commit('mute'); }));
    sec.appendChild(hint);
    refresh();
    if (c.kind === 'video') {
      const b = h(`<button class="secondary-btn wide">${icon('unlink')}Отделить аудио</button>`);
      b.disabled = !!c.muted;
      b.onclick = () => Timeline.detachAudio();
      sec.appendChild(b);
    }
    this.duckSection(body, c);
    if (VoiceSep.canUse(c)) { this.denoiseSection(body, c); this.voiceFxSection(body, c); this.voiceSection(body, c); }
  },

  // Шумоподавление голоса: гул, ветер, шум компьютера (обработка в файл, как изменение голоса)
  denoiseSection(body, c) {
    const on = c.denoise > 0;
    const sw = h(`<button class="switch ${on ? 'on' : ''}" title="Шумоподавление"><i></i></button>`);
    const sec = this.section(body, 'Шумоподавление', sw);
    sec.classList.toggle('off', !on);
    sw.onclick = () => { VoiceFx.setDenoise([c], on ? 0 : 50); this.render(); };
    let pend = c.denoise || 50;
    sec.appendChild(sliderRow({ label: 'Сила', min: 1, max: 100, value: pend, def: 50, fmt: v => Math.round(v),
      onInput: v => { pend = v; }, onCommit: () => { VoiceFx.setDenoise([c], pend); this.refresh(); } }));
    const state = h('<div class="vs-state"></div>');
    const show = () => {
      state.classList.toggle('hidden', !(c.denoise > 0));
      if (!(c.denoise > 0)) return;
      const ready = VoiceFx.fileFor(c), wait = c.voiceMode && !VoiceSep.stemFor(c);
      state.innerHTML = ready ? `${icon('check')}<span>Шум убран</span>` : `<i class="spin"></i><span>${wait ? 'Ждём нейросеть «Голос и фон»…' : 'Убираем шум…'}</span>`;
      state.classList.toggle('ok', !!ready);
    };
    show();
    this.refreshers.push(show);
    sec.appendChild(state);
  },

  // Приглушение: музыка сама становится тише, пока звучит голос (озвучка, звук видео)
  duckSection(body, c) {
    const d = c.duck || { on: false, amount: -14 };
    const sw = h(`<button class="switch ${d.on ? 'on' : ''}" title="Приглушать под голос"><i></i></button>`);
    const sec = this.section(body, 'Приглушение под голос', sw);
    sec.classList.toggle('off', !d.on);
    sw.onclick = () => {
      c.duck = { ...d, on: !d.on };
      store.commit('duck'); Player.requestRender(); this.render();
    };
    sec.appendChild(sliderRow({ label: 'Глубина', min: -30, max: -3, value: d.amount, def: -14, unit: 'дБ', fmt: v => Math.round(v),
      onInput: v => { c.duck = { ...(c.duck || d), amount: v }; Timeline.drawCanvases(true); }, onCommit: () => store.commit('duck') }));
    const n = d.on ? Duck.intervals().filter(([A, B]) => B > c.start && A < clipEnd(c)).length : 0;
    sec.appendChild(h(`<p class="muted small">${d.on ? (n ? `Голос звучит в ${n} ${plural(n, 'месте', 'местах', 'местах')} клипа — там звук тише.` : 'Под этим клипом пока нет голоса: озвучки или звука видео.') : 'Звук клипа (например, музыка) становится тише, пока звучит озвучка или звук видео.'}</p>`));
  },

  speedTab(body, c, track) {
    const curved = hasCurve(c);
    const modeSeg = h(`<div class="seg wide speed-mode"><button data-m="const" class="${curved ? '' : 'on'}">Обычная</button><button data-m="curve" class="${curved ? 'on' : ''}">Кривая</button></div>`);
    body.appendChild(h('<div class="insp-seg-wrap"></div>')).appendChild(modeSeg);
    const refit = () => {
      if (track.main) store.packMain();
      else if (!Timeline.fits(track, c, c.start, clipDur(c))) { track.clips.splice(track.clips.indexOf(c), 1); store.place(c, Timeline.trackKindOf(c)); }
      store.cleanupTracks();
    };
    modeSeg.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.classList.contains('on')) return;
      if (b.dataset.m === 'curve') { const p = SPEED_CURVES[0]; c.curve = { id: p.id, pts: deep(p.pts) }; c.speed = 1; }
      else delete c.curve;
      refit(); store.commit('speed-mode'); Player.requestRender(); this.render();
    };
    if (curved) return this.curveEditor(body, c, track, refit);
    const sec = this.section(body, 'Скорость воспроизведения');
    const toS = (v) => Math.pow(10, v);  // логарифмическая шкала 0.1x…10x
    const toV = (s) => Math.log10(s);
    const info = h(`<div class="speed-info"></div>`);
    const setInfo = () => info.innerHTML = `<span>Длительность</span><b>${fmtSec((c.out - c.in))}</b> ${icon('chevronRight')} <b>${fmtSec(clipDur(c))}</b>`;
    const apply = (s) => {
      c.speed = Math.round(s * 100) / 100;
      if (track.main) store.packMain();
      setInfo(); Timeline.render(); Player.requestRender();
    };
    const commit = () => { refit(); store.commit('speed'); };
    const sl = sliderRow({ label: 'Скорость', min: -1, max: 1, step: 0.01, value: toV(c.speed), def: 0, unit: 'x',
      fmt: v => +toS(v).toFixed(2), parse: v => toV(clamp(v, 0.1, 10)), onInput: v => apply(toS(v)), onCommit: commit });
    sec.appendChild(sl);
    const pre = h(`<div class="btn-grid five">${[0.25, 0.5, 1, 1.5, 2, 3, 5, 10].map(v => `<button class="chip-btn ${Math.abs(c.speed - v) < 1e-3 ? 'on' : ''}" data-v="${v}">${v}x</button>`).join('')}</div>`);
    pre.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; apply(+b.dataset.v); commit(); this.render(); };
    sec.appendChild(pre);
    setInfo();
    sec.appendChild(info);
    const note = h(`<p class="muted small">Высота звука сохраняется при изменении скорости.</p>`);
    sec.appendChild(note);
  },

  // Кривая скорости: пресеты и график (по горизонтали — клип, по вертикали — скорость 0.1x…10x, логарифмически)
  curveEditor(body, c, track, refit) {
    const sec = this.section(body, 'Кривая скорости', this.resetBtn(() => { const p = SPEED_CURVES.find(x => x.id === c.curve.id) || SPEED_CURVES[0]; c.curve.pts = deep(p.pts); refit(); store.commit('curve'); Player.requestRender(); this.render(); }));
    const grid = h(`<div class="curve-grid">${SPEED_CURVES.map(p => `<button class="curve-tile ${c.curve.id === p.id ? 'on' : ''}" data-id="${p.id}"><canvas></canvas><span>${p.name}</span></button>`).join('')}</div>`);
    sec.appendChild(grid);
    requestAnimationFrame(() => $$('.curve-tile', grid).forEach(b => this.drawCurveThumb($('canvas', b), SPEED_CURVES.find(p => p.id === b.dataset.id).pts)));
    grid.onclick = (e) => {
      const b = e.target.closest('.curve-tile'); if (!b) return;
      const p = SPEED_CURVES.find(x => x.id === b.dataset.id);
      c.curve = { id: p.id, pts: deep(p.pts) };
      refit(); store.commit('curve'); Player.requestRender(); this.render();
    };
    const wrap = h(`<div class="curve-edit"><canvas></canvas></div>`);
    sec.appendChild(wrap);
    const info = h(`<div class="speed-info"></div>`);
    sec.appendChild(info);
    sec.appendChild(h(`<p class="muted small">Тяните точки. Двойной клик — добавить точку или удалить её. Высота звука сохраняется.</p>`));
    const cv = $('canvas', wrap);
    const LO = Math.log(0.1), HI = Math.log(10);
    const geo = () => { const r = cv.getBoundingClientRect(); return { w: r.width, h: r.height, l: 30, r: 10, t: 10, b: 10 }; };
    const X = (g, u) => g.l + u * (g.w - g.l - g.r), Y = (g, v) => g.t + (1 - (Math.log(v) - LO) / (HI - LO)) * (g.h - g.t - g.b);
    const U = (g, x) => clamp((x - g.l) / (g.w - g.l - g.r), 0, 1), V = (g, y) => Math.exp(LO + (1 - clamp((y - g.t) / (g.h - g.t - g.b), 0, 1)) * (HI - LO));
    let hot = -1;
    const draw = () => {
      const g = geo(), dpr = window.devicePixelRatio || 1;
      if (!g.w) return;
      cv.width = Math.round(g.w * dpr); cv.height = Math.round(g.h * dpr);
      const x = cv.getContext('2d');
      x.scale(dpr, dpr);
      x.font = `500 10px "IBM Plex Mono", monospace`; x.textBaseline = 'middle'; x.textAlign = 'right';
      for (const v of [0.1, 0.5, 1, 2, 5, 10]) {
        const y = Math.round(Y(g, v)) + 0.5;
        x.fillStyle = v === 1 ? css('--line-2') : css('--line');
        x.fillRect(g.l, y, g.w - g.l - g.r, 1);
        x.fillStyle = css('--text-3'); x.fillText(v + 'x', g.l - 5, y);
      }
      const P = c.curve.pts;
      // заливка под кривой и сама кривая
      x.beginPath();
      P.forEach(([u, v], i) => i ? x.lineTo(X(g, u), Y(g, v)) : x.moveTo(X(g, u), Y(g, v)));
      x.strokeStyle = css('--accent'); x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
      x.lineTo(X(g, 1), g.h - g.b); x.lineTo(X(g, 0), g.h - g.b); x.closePath();
      x.fillStyle = css('--accent-soft'); x.fill();
      // курсор воспроизведения
      const lt = store.time - c.start;
      if (lt >= 0 && lt <= clipDur(c)) {
        const u = (srcAt(c, lt) - c.in) / Math.max(1e-6, c.out - c.in);
        x.fillStyle = css('--text'); x.fillRect(Math.round(X(g, u)), g.t, 1, g.h - g.t - g.b);
      }
      P.forEach(([u, v], i) => {
        x.beginPath(); x.arc(X(g, u), Y(g, v), i === hot ? 6 : 4.5, 0, Math.PI * 2);
        x.fillStyle = '#fff'; x.fill(); x.lineWidth = 2; x.strokeStyle = css('--accent'); x.stroke();
      });
      if (hot >= 0) {
        const [u, v] = P[hot], t = `${v < 1 ? v.toFixed(2) : v.toFixed(1)}x`;
        x.textAlign = 'center'; x.fillStyle = css('--text'); x.font = `600 11px "IBM Plex Mono", monospace`;
        x.fillText(t, clamp(X(g, u), g.l + 16, g.w - g.r - 16), Math.max(g.t + 6, Y(g, v) - 14));
      }
      info.innerHTML = `<span>Длительность</span><b>${fmtSec(c.out - c.in)}</b> ${icon('chevronRight')} <b>${fmtSec(clipDur(c))}</b>`;
    };
    const near = (e) => {
      const g = geo(), r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = -1, bd = 10;
      c.curve.pts.forEach(([u, v], i) => { const d = Math.hypot(X(g, u) - mx, Y(g, v) - my); if (d < bd) { bd = d; best = i; } });
      return { i: best, g, mx, my };
    };
    const live = () => { if (track.main) store.packMain(); Timeline.render(); Player.requestRender(); draw(); };
    cv.addEventListener('mousemove', (e) => { if (document.body.classList.contains('dragging')) return; const n = near(e); if (n.i !== hot) { hot = n.i; draw(); } cv.style.cursor = n.i >= 0 ? 'grab' : 'crosshair'; });
    cv.addEventListener('mouseleave', () => { if (!document.body.classList.contains('dragging') && hot >= 0) { hot = -1; draw(); } });
    cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const n = near(e); if (n.i < 0) return;
      e.preventDefault();
      const i = n.i, P = c.curve.pts, last = P.length - 1;
      dragMove(e, (ev) => {
        const r = cv.getBoundingClientRect(), g = geo();
        let v = V(g, ev.clientY - r.top);
        if (!ev.altKey) for (const sv of [0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 10]) if (Math.abs(Math.log(v / sv)) < 0.05) v = sv;
        P[i][1] = Math.round(v * 100) / 100;
        if (i > 0 && i < last) P[i][0] = Math.round(clamp(U(g, ev.clientX - r.left), P[i - 1][0] + 0.02, P[i + 1][0] - 0.02) * 1e4) / 1e4;
        c.curve.id = 'custom';
        hot = i; live();
      }, () => { refit(); store.commit('curve'); $$('.curve-tile', grid).forEach(b => b.classList.toggle('on', b.dataset.id === 'custom')); }, 'grabbing');
    });
    cv.addEventListener('dblclick', (e) => {
      const n = near(e), P = c.curve.pts;
      if (n.i > 0 && n.i < P.length - 1) P.splice(n.i, 1);
      else if (n.i < 0) {
        const u = U(n.g, n.mx);
        if (P.some(p => Math.abs(p[0] - u) < 0.02)) return;
        P.push([Math.round(u * 1e4) / 1e4, Math.round(clamp(V(n.g, n.my), 0.1, 10) * 100) / 100]);
        P.sort((a, b) => a[0] - b[0]);
      } else return;
      c.curve.id = 'custom';
      hot = -1; live(); refit(); store.commit('curve');
      $$('.curve-tile', grid).forEach(b => b.classList.toggle('on', b.dataset.id === 'custom'));
    });
    requestAnimationFrame(draw);
    new ResizeObserver(() => draw()).observe(wrap);
    this.refreshers.push(draw);
  },
  drawCurveThumb(cv, P) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const x = cv.getContext('2d'), w = r.width, hh = r.height, LO = Math.log(0.1), HI = Math.log(10);
    x.scale(dpr, dpr);
    x.fillStyle = css('--line'); x.fillRect(4, Math.round(hh / 2) + 0.5, w - 8, 1);
    x.beginPath();
    P.forEach(([u, v], i) => { const px = 4 + u * (w - 8), py = 4 + (1 - (Math.log(v) - LO) / (HI - LO)) * (hh - 8); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.strokeStyle = css('--accent'); x.lineWidth = 1.6; x.lineJoin = 'round'; x.stroke();
  },

  animTab(body, c) {
    const d = clipDur(c);
    const mk = (title, list, key, durKey) => {
      const sec = this.section(body, title);
      const grid = h(`<div class="anim-grid">${list.map(a => `<button class="anim-tile ${c.anim[key] === a.id ? 'on' : ''}" data-id="${a.id}"><span class="anim-ic a-${key}-${a.id}"><i></i></span><span>${a.name}</span></button>`).join('')}</div>`);
      grid.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        c.anim[key] = b.dataset.id;
        if (c.anim[durKey] > d / 2) c.anim[durKey] = Math.round(d / 2 * 10) / 10;
        store.commit('anim');
        // предпросмотр анимации
        const pt = key === 'in' ? c.start : Math.max(c.start, clipEnd(c) - c.anim[durKey] - 0.05);
        store.setTime(pt);
        Player.stopAt = key === 'in' ? Math.min(clipEnd(c), c.start + c.anim[durKey] + 0.3) : clipEnd(c) - 0.001;
        Player.play();
        this.render();
      };
      sec.appendChild(grid);
      if (c.anim[key] !== 'none') {
        sec.appendChild(sliderRow({ label: 'Длительность', min: 0.1, max: Math.max(0.2, Math.min(5, d)), step: 0.1, value: c.anim[durKey], unit: 'с',
          onInput: v => { c.anim[durKey] = v; Player.requestRender(); }, onCommit: () => store.commit('anim') }));
      }
    };
    if (c.kind === 'text') this.textAnimSections(body, c);
    mk(c.kind === 'text' ? 'Клип: появление' : 'Появление', ANIMS_IN, 'in', 'inDur');
    mk(c.kind === 'text' ? 'Клип: исчезновение' : 'Исчезновение', ANIMS_OUT, 'out', 'outDur');
    const f = store.find(c.id);
    this.mblurSection(body, c, f && f.track);
  },

  // ---------------------------------------------------------------- After Effects: аниматоры текста, размытие, слой-маска, ротоскоп
  // Анимация текста по буквам / словам / строкам (c.tanim)
  textAnimSections(body, c) {
    const get = () => (c.tanim = Object.assign(deep(DEFAULT_TANIM), c.tanim || {}));
    const cur = (key) => (c.tanim && c.tanim[key]) || DEFAULT_TANIM[key];
    const d = clipDur(c);
    const thumbs = [];
    const mk = (title, list, key) => {
      const sec = this.section(body, title);
      const grid = h(`<div class="anim-grid">${list.map(a => `<button class="anim-tile ${cur(key).id === a.id ? 'on' : ''}" data-id="${a.id}"><span class="anim-ic ta-ic"><canvas></canvas></span><span>${esc(a.name)}</span></button>`).join('')}</div>`);
      $$('.anim-tile', grid).forEach(b => thumbs.push({ cv: $('canvas', b), tile: b, key, id: b.dataset.id }));
      grid.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const a = get();
        a[key] = { ...a[key], id: b.dataset.id };
        if (key !== 'loop' && a[key].dur > d / 2 && b.dataset.id !== 'none') a[key].dur = Math.max(0.1, Math.round(d / 2 * 10) / 10);
        if (!textAnimOn(c)) delete c.tanim;
        store.commit('tanim');
        // предпросмотр анимации
        if (b.dataset.id !== 'none') {
          const A = c.tanim[key];
          const pt = key === 'out' ? Math.max(c.start, clipEnd(c) - A.dur - 0.1) : c.start;
          store.setTime(pt);
          Player.stopAt = key === 'in' ? Math.min(clipEnd(c), c.start + A.dur + 0.4) : key === 'out' ? clipEnd(c) - 0.001 : Math.min(clipEnd(c), c.start + 2.5);
          Player.play();
        }
        this.render();
      };
      sec.appendChild(grid);
      const A = cur(key);
      if (A.id !== 'none') {
        if (key === 'loop') {
          sec.appendChild(sliderRow({ label: 'Скорость', min: 0.1, max: 4, step: 0.05, value: A.speed ?? 1, def: 1, unit: '×',
            onInput: v => { get().loop.speed = v; Player.requestRender(); }, onCommit: () => store.commit('tanim') }));
          sec.appendChild(sliderRow({ label: 'Сила', min: 0, max: 300, value: (A.amount ?? 1) * 100, def: 100, unit: '%', fmt: v => Math.round(v),
            onInput: v => { get().loop.amount = v / 100; Player.requestRender(); }, onCommit: () => store.commit('tanim') }));
        } else {
          sec.appendChild(sliderRow({ label: 'Длительность', min: 0.1, max: Math.max(0.2, Math.min(10, d)), step: 0.1, value: A.dur, unit: 'с',
            onInput: v => { get()[key].dur = v; Player.requestRender(); }, onCommit: () => store.commit('tanim') }));
        }
      }
      return sec;
    };
    const s1 = mk('Текст: появление', TEXT_ANIMS_IN, 'in');
    mk('Текст: исчезновение', TEXT_ANIMS_OUT, 'out');
    mk('Текст: цикл', TEXT_LOOPS, 'loop');
    const u = (c.tanim && c.tanim.unit) || 'auto';
    const seg = h(`<div class="prop-row"><label>Разбивка</label><div class="seg">${TEXT_UNITS.map(([id, l]) => `<button data-u="${id}" class="${id === u ? 'on' : ''}">${l}</button>`).join('')}</div></div>`);
    seg.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      get().unit = b.dataset.u;
      if (!textAnimOn(c)) delete c.tanim;
      store.commit('tanim'); Player.requestRender(); this.render();
    };
    s1.insertBefore(seg, s1.firstChild);
    // плитки: стоп-кадр в середине анимации, при наведении — проигрывается
    requestAnimationFrame(() => thumbs.forEach(t => this.taThumb(t)));
  },
  taThumb(T) {
    const r = T.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    T.cv.width = Math.round(r.width * dpr); T.cv.height = Math.round(r.height * dpr);
    const st = { ...DEFAULT_TEXT_STYLE, size: 30, bold: true, color: css('--text'), strokeWidth: 0, bgOpacity: 0, shadow: false, letterSpacing: 0, align: 'center' };
    const fake = { kind: 'text', id: 'thumb', text: 'Абвг', start: 0, in: 0, out: 2.2, speed: 1, style: st,
      tanim: { in: { id: T.key === 'in' ? T.id : 'none', dur: 1 }, out: { id: T.key === 'out' ? T.id : 'none', dur: 1 }, loop: { id: T.key === 'loop' ? T.id : 'none', speed: 1, amount: 1.4 }, unit: 'auto' } };
    const L = textLayout(fake), x = T.cv.getContext('2d');
    const draw = (lt) => {
      x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, T.cv.width, T.cv.height);
      const sc = Math.min(T.cv.width * 0.8 / L.w, T.cv.height * 0.7 / L.h);
      x.translate(T.cv.width / 2, T.cv.height / 2); x.scale(sc, sc);
      x.font = fontString(st, st.size); x.textBaseline = 'middle'; x.lineJoin = 'round';
      if (T.id === 'none') { x.globalAlpha = 0.35; x.fillStyle = st.color; x.textAlign = 'center'; x.fillText('—', 0, 0); return; }
      drawTextGlyphs(x, fake, L, lt, sc);
    };
    const still = T.key === 'in' ? 0.55 : T.key === 'out' ? 1.2 + 0.45 : 0.3;
    draw(still);
    let raf = 0, t0 = 0;
    const loop = (now) => {
      const τ = ((now - t0) / 1000) % 1.8;
      draw(T.key === 'in' ? τ : T.key === 'out' ? 1.2 + Math.min(1, τ) : τ * 1.2);
      raf = requestAnimationFrame(loop);
    };
    T.tile.onmouseenter = () => { t0 = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); };
    T.tile.onmouseleave = () => { cancelAnimationFrame(raf); draw(still); };
  },

  // Размытие в движении (Motion Blur)
  mblurSection(body, c, track) {
    const on = mblurOn(c);
    const sw = h(`<button class="switch ${on ? 'on' : ''}" title="Размытие в движении"><i></i></button>`);
    const sec = this.section(body, 'Размытие в движении', sw);
    sec.classList.toggle('off', !on);
    const get = () => (c.mblur = Object.assign({}, DEFAULT_MBLUR, c.mblur || {}));
    sw.onclick = () => { get().on = !on; store.commit('mblur'); Player.requestRender(); this.render(); };
    const m = Object.assign({}, DEFAULT_MBLUR, c.mblur || {});
    sec.appendChild(sliderRow({ label: 'Затвор', min: 10, max: 720, value: m.angle, def: 180, unit: '°', fmt: v => Math.round(v),
      onInput: v => { const x = get(); x.angle = v; x.on = true; Player.requestRender(); }, onCommit: () => { store.commit('mblur'); if (!on) this.render(); } }));
    sec.appendChild(sliderRow({ label: 'Образцы', min: 2, max: 32, value: m.samples, def: 8, fmt: v => Math.round(v),
      onInput: v => { const x = get(); x.samples = Math.round(v); x.on = true; Player.requestRender(); }, onCommit: () => { store.commit('mblur'); if (!on) this.render(); } }));
    const still = on && !mblurActive(c, track);
    sec.appendChild(h(`<p class="muted small">${still ? 'Клип сейчас не двигается — размытие появится на ключевых кадрах, анимации появления или анимации текста.' : 'Смазывает быстрое движение клипа, как настоящая камера. Затвор 180° — как в кино, больше — сильнее смаз.'}</p>`));
  },

  // Слой-маска (Track Matte): клип виден через другой клип
  matteSection(body, c) {
    const mt = c.matte && c.matte.id ? matteOf(c) : null;
    const sec = this.section(body, 'Слой-маска (Track Matte)');
    const row = h(`<div class="prop-row blend-row"><label>Клип-маска</label><button class="select-btn"><span></span>${icon('chevronDown')}</button></div>`);
    const btn = $('.select-btn', row);
    $('span', btn).textContent = mt ? clipLabel(mt.clip) : 'Нет';
    btn.onclick = () => {
      const list = matteCandidates(c);
      const items = [{ label: 'Нет', checked: !mt, onClick: () => { delete c.matte; store.commit('matte'); Player.requestRender(); this.render(); } }];
      if (list.length) items.push('-');
      for (const x of list) items.push({ label: `${clipLabel(x.clip)} · дорожка ${x.ti + 1}`, checked: !!(mt && mt.clip === x.clip),
        onClick: () => { c.matte = { id: x.clip.id, mode: (c.matte && c.matte.mode) || (x.clip.kind === 'text' ? 'alpha' : 'luma'), invert: !!(c.matte && c.matte.invert) }; store.commit('matte'); Player.requestRender(); this.render(); } });
      if (!list.length) items.push({ label: 'Нет клипов в это же время', disabled: true });
      menuBelow(btn, items);
    };
    sec.appendChild(row);
    if (mt) {
      const seg = h(`<div class="prop-row"><label>По</label><div class="seg">${MATTE_MODES.map(([id, l]) => `<button data-m="${id}" class="${mt.mode === id ? 'on' : ''}">${l}</button>`).join('')}</div></div>`);
      seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; c.matte.mode = b.dataset.m; store.commit('matte'); Player.requestRender(); this.render(); };
      sec.appendChild(seg);
      sec.appendChild(toggleRow('Инвертировать', mt.invert, (v) => { c.matte.invert = v; store.commit('matte'); Player.requestRender(); }));
    }
    sec.appendChild(h(`<p class="muted small">${mt ? 'Клип-маска сама не показывается.' : 'Клип будет виден только там, где виден выбранный клип (например, видео внутри букв текста).'}</p>`));
  },

  // Вырезать объект нейросетью (Roto Brush)
  rotoSection(body, c) {
    const has = !!Roto.data(c), j = Roto.jobFor(c), P = Roto.pick && Roto.pick.c === c ? Roto.pick : null;
    const sw = has && !j && !P ? h(`<button class="switch ${c.roto.on ? 'on' : ''}" title="Вырезать объект"><i></i></button>`) : null;
    const sec = this.section(body, 'Вырезать объект', sw);
    if (sw) {
      sec.classList.toggle('off', !c.roto.on);
      sw.onclick = () => { c.roto.on = !c.roto.on; store.commit('roto'); Player.requestRender(); this.render(); };
    }
    if (Stab.on(c)) { sec.appendChild(h(`<div class="vs-state">${icon('info')}<span>Не работает вместе со стабилизацией.</span></div>`)); return; }
    if (j) {
      const st = h(`<div class="vs-state"><i class="spin"></i><span>Нейросеть вырезает объект… ${jobPct(j)}</span><button class="link">Отмена</button></div>`);
      $('button', st).onclick = () => Roto.cancel(c);
      sec.appendChild(st);
      this.refreshers.push(() => { const jj = Roto.jobFor(c); if (jj) $('span', st).textContent = `Нейросеть вырезает объект… ${jobPct(jj)}`; });
      return;
    }
    if (P) {
      const st = h('<div class="vs-state"></div>');
      const show = () => {
        const n = P.pts.length + (P.box ? 1 : 0);
        st.innerHTML = P.busy ? `<i class="spin"></i><span>Нейросеть ищет объект…</span>` : n ? `${icon('check')}<span>Отмечено: ${P.pts.filter(p => p[2]).length} + / ${P.pts.filter(p => !p[2]).length} −${P.box ? ', рамка' : ''}</span>` : `${icon('info')}<span>Щёлкните по объекту в превью</span>`;
        st.classList.toggle('ok', !!n && !P.busy);
      };
      show();
      this.refreshers.push(show);
      sec.appendChild(st);
      const row = h(`<div class="btn-grid"><button class="chip-btn on span2" data-a="go">${icon('magicWand')}Вырезать на всём клипе</button><button class="chip-btn" data-a="clear">${icon('reset')}Сбросить точки</button><button class="chip-btn" data-a="cancel">${icon('x')}Отмена</button></div>`);
      row.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.a === 'go') Roto.stopPick(true); else if (b.dataset.a === 'clear') Roto.clearPoints(); else Roto.stopPick(false);
      };
      sec.appendChild(row);
      sec.appendChild(h(`<p class="muted small">ЛКМ — объект, ПКМ (или Alt) — лишнее, протяните — рамка. Можно перейти на другой кадр и поправить там — нейросеть учтёт все кадры.</p>`));
      return;
    }
    if (!has) {
      const row = h(`<div class="btn-grid"><button class="chip-btn" data-a="pick">${icon('magicWand')}Выделить объект</button></div>`);
      row.onclick = () => Roto.start(c);
      sec.appendChild(row);
      sec.appendChild(h(`<p class="muted small">Как Roto Brush в After Effects: щёлкните по человеку или предмету — нейросеть SAM 2 вырежет его на всём клипе, без зелёного фона.</p>`));
      return;
    }
    const d = Roto.data(c);
    sec.appendChild(h(`<div class="vs-state ok">${icon('check')}<span>Объект вырезан · кадров: ${d.n} · подсказок: ${(c.roto.prompts || []).length}</span></div>`));
    sec.appendChild(toggleRow('Удалить объект, оставить фон', !!c.roto.invert, (v) => { c.roto.invert = v; store.commit('roto'); Player.requestRender(); }));
    const row = h(`<div class="btn-grid"><button class="chip-btn" data-a="redo">${icon('magicWand')}Уточнить на кадре</button><button class="chip-btn" data-a="off">${icon('x')}Убрать</button></div>`);
    row.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.a === 'redo') Roto.start(c); else { Roto.remove(c); this.render(); } };
    sec.appendChild(row);
  },

  // Маска пером: ключевые кадры формы и параметры
  penSection(body, c, m) {
    const T = () => srcTime(c, store.time);
    const kf = h(`<div class="kf-ctl">
      <button class="icon-btn tiny" data-k="prev" title="Предыдущий ключ формы">${icon('chevronLeft')}</button>
      <button class="kf-btn" data-k="toggle" title="Ключ формы маски"><i></i></button>
      <button class="icon-btn tiny" data-k="next" title="Следующий ключ формы">${icon('chevronRight')}</button>
    </div>`);
    const sec = this.section(body, 'Контур', kf);
    const upd = () => {
      const has = !!(m.keys && m.keys.length), on = has && penKeyIndex(m, T()) >= 0, s = T();
      $('.kf-btn', kf).classList.toggle('on', on);
      $('.kf-btn', kf).classList.toggle('has', has);
      $('[data-k=prev]', kf).disabled = !has || !m.keys.some(k => k.s < s - 1e-3);
      $('[data-k=next]', kf).disabled = !has || !m.keys.some(k => k.s > s + 1e-3);
      info.textContent = `Точек: ${(m.pts || []).length}${has ? ` · ключей формы: ${m.keys.length}` : ''}`;
    };
    kf.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const s = T(), toT = (ks) => c.start + ltAt(c, ks);
      if (b.dataset.k === 'toggle') {
        if (!m.keys || !m.keys.length) m.keys = [{ s, pts: deep(m.pts || []) }];
        else {
          const i = penKeyIndex(m, s);
          if (i >= 0) { const pts = m.keys[i].pts; m.keys.splice(i, 1); if (!m.keys.length) { m.pts = pts; delete m.keys; } else m.pts = m.keys[0].pts; }
          else { m.keys.push({ s, pts: deep(penPtsAt(m, s)) }); m.keys.sort((a, b2) => a.s - b2.s); m.pts = m.keys[0].pts; }
        }
        store.commit('mask-key');
      }
      if (b.dataset.k === 'prev') { const ks = m.keys.filter(x => x.s < s - 1e-3).pop(); if (ks) store.setTime(toT(ks.s)); }
      if (b.dataset.k === 'next') { const ks = m.keys.find(x => x.s > s + 1e-3); if (ks) store.setTime(toT(ks.s)); }
      Player.requestRender(); upd();
    };
    const info = h('<div class="muted small"></div>');
    sec.appendChild(info);
    const row = h(`<div class="btn-grid"><button class="chip-btn" data-a="clear">${icon('trash')}Очистить контур</button></div>`);
    row.onclick = () => { m.pts = []; delete m.keys; Player.penSel = null; store.commit('mask'); Player.requestRender(); this.render(); };
    sec.appendChild(row);
    upd();
    this.refreshers.push(upd);
    sec.appendChild(h(`<p class="muted small">Ставьте точки щелчками прямо в превью, тяните — получится кривая. ◆ — запомнить форму в этом месте: между ключами маска плавно меняет форму (можно обвести движущийся объект).</p>`));
  },

  adjustTab(body, c) {
    const sec = this.section(body, 'Коррекция цвета', this.resetBtn(() => { Object.assign(c.adjust, DEFAULT_ADJUST, { tint: 0 }); store.commit('adjust'); Player.requestRender(); this.render(); }));
    for (const a of ADJUST_DEFS) {
      sec.appendChild(sliderRow({ label: a.label, min: a.min ?? -100, max: 100, value: c.adjust[a.key] || 0, def: 0, fmt: v => Math.round(v),
        onInput: v => { c.adjust[a.key] = v; Player.requestRender(); }, onCommit: () => store.commit('adjust') }));
    }
    const note = h(`<p class="muted small">Двойной клик по ползунку — сброс значения.</p>`);
    sec.appendChild(note);
    this.curvesSection(body, c);
  },

  // Кривые RGB (как в Lumetri): общая кривая и по каналам, монотонный сплайн; превью и экспорт — одни таблицы
  curveCh: 'm',
  curvesSection(body, c) {
    const ident = () => [[0, 0], [1, 1]];
    const ensure = () => { c.curves = c.curves || {}; for (const k of CURVE_CH) if (!c.curves[k]) c.curves[k] = ident(); return c.curves; };
    const sec = this.section(body, 'Кривые', this.resetBtn(() => {
      if (!c.curves) return;
      c.curves[this.curveCh] = ident();
      if (!curvesOn(c)) delete c.curves;
      store.commit('curves'); Player.requestRender(); this.render();
    }));
    const COL = { m: '#f4f4f5', r: '#ff5a52', g: '#3ddc84', b: '#4aa3ff' };
    const seg = h(`<div class="seg curve-ch">${[['m', 'Яркость'], ['r', 'Красный'], ['g', 'Зелёный'], ['b', 'Синий']].map(([k, l]) =>
      `<button data-k="${k}" class="${this.curveCh === k ? 'on' : ''}"><i style="background:${COL[k]}"></i>${l}</button>`).join('')}</div>`);
    sec.appendChild(seg);
    const wrap = h(`<div class="rgb-curve"><canvas></canvas></div>`);
    sec.appendChild(wrap);
    sec.appendChild(h(`<p class="muted small">Щелчок по кривой — новая точка, двойной щелчок по точке — удалить. Alt — без привязки к диагонали.</p>`));
    const cv = $('canvas', wrap);
    const PAD = 8;
    let hot = -1;
    const pts = () => (c.curves && c.curves[this.curveCh]) || ident();
    const geo = () => { const r = cv.getBoundingClientRect(); return { r, s: r.width - PAD * 2 }; };
    const X = (g, x) => PAD + x * g.s, Y = (g, y) => PAD + (1 - y) * g.s;
    const draw = () => {
      const g = geo(), dpr = window.devicePixelRatio || 1;
      if (!g.r.width) return;
      cv.width = Math.round(g.r.width * dpr); cv.height = Math.round(g.r.height * dpr);
      const x = cv.getContext('2d');
      x.scale(dpr, dpr);
      // гистограмма яркости текущего кадра — подложкой, как в Lumetri
      const hist = Scopes.lumaHist();
      if (hist) {
        const mx = Math.max(1, ...hist.slice(2, 254));
        x.fillStyle = 'rgba(255,255,255,.07)';
        x.beginPath(); x.moveTo(X(g, 0), Y(g, 0));
        for (let i = 0; i < 256; i++) x.lineTo(X(g, i / 255), Y(g, 0) - Math.min(1, hist[i] / mx) * g.s * 0.9);
        x.lineTo(X(g, 1), Y(g, 0)); x.closePath(); x.fill();
      }
      x.strokeStyle = css('--line'); x.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = Math.round(PAD + i / 4 * g.s) + 0.5;
        x.beginPath(); x.moveTo(PAD, v); x.lineTo(PAD + g.s, v); x.moveTo(v, PAD); x.lineTo(v, PAD + g.s); x.stroke();
      }
      x.strokeStyle = css('--line-2'); x.beginPath(); x.moveTo(X(g, 0), Y(g, 0)); x.lineTo(X(g, 1), Y(g, 1)); x.stroke();
      // остальные каналы — бледно
      const C = c.curves || {};
      for (const k of CURVE_CH) {
        if (k === this.curveCh || curveIdent(C[k])) continue;
        const f = splineFn(C[k]);
        x.globalAlpha = 0.35; x.strokeStyle = COL[k]; x.lineWidth = 1.2; x.beginPath();
        for (let i = 0; i <= 128; i++) { const u = i / 128; i ? x.lineTo(X(g, u), Y(g, f(u))) : x.moveTo(X(g, u), Y(g, f(u))); }
        x.stroke(); x.globalAlpha = 1;
      }
      const P = pts(), f = splineFn(P);
      x.strokeStyle = COL[this.curveCh]; x.lineWidth = 2; x.lineJoin = 'round'; x.beginPath();
      for (let i = 0; i <= 192; i++) { const u = i / 192; i ? x.lineTo(X(g, u), Y(g, f(u))) : x.moveTo(X(g, u), Y(g, f(u))); }
      x.stroke();
      P.forEach(([u, v], i) => {
        x.beginPath(); x.arc(X(g, u), Y(g, v), i === hot ? 5.5 : 4, 0, Math.PI * 2);
        x.fillStyle = i === hot ? COL[this.curveCh] : css('--panel'); x.fill();
        x.lineWidth = 1.6; x.strokeStyle = COL[this.curveCh]; x.stroke();
      });
      if (hot >= 0) {
        const [u, v] = P[hot], t = `${Math.round(u * 255)} → ${Math.round(v * 255)}`;
        x.font = `500 10px "IBM Plex Mono", monospace`; x.textBaseline = 'top'; x.textAlign = 'left';
        x.fillStyle = css('--text-2'); x.fillText(t, PAD + 4, PAD + 3);
      }
    };
    const near = (e) => {
      const g = geo(), mx = e.clientX - g.r.left, my = e.clientY - g.r.top;
      let best = -1, bd = 9;
      pts().forEach(([u, v], i) => { const d = Math.hypot(X(g, u) - mx, Y(g, v) - my); if (d < bd) { bd = d; best = i; } });
      return { i: best, g, u: clamp((mx - PAD) / g.s, 0, 1), v: clamp(1 - (my - PAD) / g.s, 0, 1) };
    };
    seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; this.curveCh = b.dataset.k; $$('button', seg).forEach(x => x.classList.toggle('on', x === b)); hot = -1; draw(); };
    cv.addEventListener('mousemove', (e) => { if (document.body.classList.contains('dragging')) return; const n = near(e); if (n.i !== hot) { hot = n.i; draw(); } cv.style.cursor = n.i >= 0 ? 'grab' : 'crosshair'; });
    cv.addEventListener('mouseleave', () => { if (!document.body.classList.contains('dragging') && hot >= 0) { hot = -1; draw(); } });
    cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const C = ensure(), P = C[this.curveCh];
      let n = near(e), i = n.i;
      if (i < 0) {
        // новая точка — на самой кривой под курсором
        if (P.some(p => Math.abs(p[0] - n.u) < 0.02)) return;
        P.push([Math.round(n.u * 1000) / 1000, Math.round(splineFn(P)(n.u) * 1000) / 1000]);
        P.sort((a, b) => a[0] - b[0]);
        i = P.findIndex(p => Math.abs(p[0] - Math.round(n.u * 1000) / 1000) < 1e-9);
      }
      const last = P.length - 1;
      dragMove(e, (ev) => {
        const q = near(ev);
        let u = q.u, v = q.v;
        if (i > 0 && i < last) u = clamp(u, P[i - 1][0] + 0.01, P[i + 1][0] - 0.01);
        else if (i === 0) u = clamp(u, 0, P[1][0] - 0.01);
        else u = clamp(u, P[last - 1][0] + 0.01, 1);
        if (!ev.altKey && Math.abs(v - u) < 0.015) v = u;
        P[i] = [Math.round(u * 1000) / 1000, Math.round(v * 1000) / 1000];
        hot = i; draw(); Player.requestRender();
      }, () => {
        if (!curvesOn(c)) delete c.curves;
        store.commit('curves'); Player.requestRender();
      }, 'grabbing');
    });
    cv.addEventListener('dblclick', (e) => {
      const n = near(e), P = pts();
      if (n.i <= 0 || n.i >= P.length - 1) return;
      P.splice(n.i, 1);
      if (!curvesOn(c)) delete c.curves;
      hot = -1; draw(); store.commit('curves'); Player.requestRender();
    });
    requestAnimationFrame(draw);
    new ResizeObserver(() => draw()).observe(wrap);
    this.refreshers.push(draw);
    this.curveDraw = draw;
    this.curveCv = cv;
  },

  // ---------------------------------------------------------------- эффект
  effectTab(body, c) {
    const fx = EFFECT_BY_ID[c.effect];
    const cat = fx && FX_CATS.find(x => x.id === fx.cat);
    const sec = this.section(body, fx ? fx.name : 'Эффект');
    sec.appendChild(h(`<div class="kv"><div><span>Категория</span><b>${esc(cat ? cat.name : '—')}</b></div><div><span>Длительность</span><b>${fmtSec(clipDur(c))}</b></div></div>`));
    const live = () => { Player.requestRender(); };
    if (!fx || fx.strength !== false) {
      sec.appendChild(sliderRow({ label: 'Сила', min: 0, max: 100, value: c.params.strength, def: 60, fmt: v => Math.round(v),
        onInput: v => { c.params.strength = v; live(); }, onCommit: () => store.commit('fx-param') }));
    }
    if (!fx || fx.speed !== false) {
      sec.appendChild(sliderRow({ label: 'Скорость', min: 0, max: 100, value: c.params.speed, def: 50, fmt: v => Math.round(v),
        onInput: v => { c.params.speed = v; live(); }, onCommit: () => store.commit('fx-param') }));
    }
    const row = h(`<div class="btn-grid"><button class="chip-btn" data-a="replace">${icon('sparkles')}Заменить</button><button class="chip-btn" data-a="fit">${icon('fit')}На весь клип</button></div>`);
    row.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'replace') { Panels.sub.effects = fx ? fx.cat : 'camera'; Panels.show('effects'); }
      if (b.dataset.a === 'fit') {
        // растянуть эффект на клип главной дорожки под ним
        const m = store.mainTrack().clips.find(x => c.start >= x.start - 1e-3 && c.start < clipEnd(x));
        if (m) { c.start = m.start; c.out = clipDur(m); c.in = 0; store.commit('fx-fit'); } else toast('Под эффектом нет клипа');
      }
    };
    sec.appendChild(row);
    body.appendChild(h(`<div class="insp-tip">${icon('info')}<span>Эффект действует на всё видео под ним на таймлайне. Тяните края, чтобы изменить длительность.</span></div>`));
  },

  // ---------------------------------------------------------------- текст
  textTab(body, c) {
    const st = c.style;
    const sec = this.section(body, 'Текст');
    const ta = h(`<textarea class="text-area" rows="3" spellcheck="false"></textarea>`);
    ta.value = c.text;
    ta.addEventListener('keydown', e => e.stopPropagation());
    ta.addEventListener('input', () => { c.text = ta.value; Player.requestRender(); Timeline.render(); });
    ta.addEventListener('change', () => store.commit('text'));
    sec.appendChild(ta);

    const fontRow = h(`<div class="prop-row"><label>Шрифт</label><button class="select-btn font-btn"><span></span>${icon('chevronDown')}</button></div>`);
    $('.font-btn span', fontRow).textContent = st.font;
    $('.font-btn span', fontRow).style.fontFamily = `"${st.font}"`;
    $('.font-btn', fontRow).onclick = async (e) => {
      const fonts = await App.fonts();
      const m = menuBelow(e.currentTarget, fonts.map(f => ({ label: f, checked: f === st.font, onClick: () => { st.font = f; store.commit('font'); Player.requestRender(); this.render(); } })), { cls: 'font-menu' });
      $$('.ctx-label', m).forEach((l) => l.style.fontFamily = `"${l.textContent}"`);
      const cur = $('.ctx-item.checked', m); if (cur) cur.scrollIntoView({ block: 'center' });
    };
    sec.appendChild(fontRow);
    sec.appendChild(sliderRow({ label: 'Размер', min: 8, max: 400, value: st.size, def: 96, fmt: v => Math.round(v),
      onInput: v => { st.size = v; Player.requestRender(); }, onCommit: () => store.commit('size') }));

    const fmtRow = h(`<div class="prop-row"><label>Стиль</label><div class="seg">
      <button data-k="bold" class="${st.bold ? 'on' : ''}" title="Жирный">${icon('bold')}</button>
      <button data-k="italic" class="${st.italic ? 'on' : ''}" title="Курсив">${icon('italic')}</button>
      <button data-k="underline" class="${st.underline ? 'on' : ''}" title="Подчёркнутый">${icon('underline')}</button>
    </div><div class="seg">
      <button data-al="left" class="${st.align === 'left' ? 'on' : ''}">${icon('alignLeft')}</button>
      <button data-al="center" class="${st.align === 'center' ? 'on' : ''}">${icon('alignCenter')}</button>
      <button data-al="right" class="${st.align === 'right' ? 'on' : ''}">${icon('alignRight')}</button>
    </div></div>`);
    fmtRow.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.k) st[b.dataset.k] = !st[b.dataset.k];
      if (b.dataset.al) st.align = b.dataset.al;
      store.commit('style'); Player.requestRender(); this.render();
    };
    sec.appendChild(fmtRow);
    sec.appendChild(this.colorRow('Цвет', st.color, (v, done) => { st.color = v; Player.requestRender(); if (done) store.commit('color'); }));
    sec.appendChild(sliderRow({ label: 'Интервал', min: -20, max: 60, value: st.letterSpacing, def: 0, fmt: v => Math.round(v),
      onInput: v => { st.letterSpacing = v; Player.requestRender(); }, onCommit: () => store.commit('ls') }));
    sec.appendChild(sliderRow({ label: 'Межстрочн.', min: 0.8, max: 3, step: 0.05, value: st.lineHeight, def: 1.2,
      onInput: v => { st.lineHeight = v; Player.requestRender(); }, onCommit: () => store.commit('lh') }));

    const s2 = this.section(body, 'Обводка');
    s2.appendChild(this.colorRow('Цвет', st.strokeColor, (v, done) => { st.strokeColor = v; if (!st.strokeWidth) st.strokeWidth = 6; Player.requestRender(); if (done) { store.commit('stroke'); this.render(); } }));
    s2.appendChild(sliderRow({ label: 'Толщина', min: 0, max: 40, value: st.strokeWidth, def: 0, fmt: v => Math.round(v),
      onInput: v => { st.strokeWidth = v; Player.requestRender(); }, onCommit: () => store.commit('stroke') }));
    const s3 = this.section(body, 'Фон');
    s3.appendChild(this.colorRow('Цвет', st.bgColor, (v, done) => { st.bgColor = v; if (!st.bgOpacity) st.bgOpacity = 70; Player.requestRender(); if (done) { store.commit('bg'); this.render(); } }));
    s3.appendChild(sliderRow({ label: 'Непрозрачн.', min: 0, max: 100, value: st.bgOpacity, def: 0, unit: '%', fmt: v => Math.round(v),
      onInput: v => { st.bgOpacity = v; Player.requestRender(); }, onCommit: () => store.commit('bg') }));
    s3.appendChild(toggleRow('Тень', st.shadow, (v) => { st.shadow = v; store.commit('shadow'); Player.requestRender(); }));
    this.transformSection(body, c);
    this.trackSection(body, c);
    this.blendSection(body, c);
    this.matteSection(body, c);
  },

  colorRow(label, value, onChange) {
    const row = h(`<div class="prop-row color-row"><label>${esc(label)}</label><div class="swatches">
      ${SWATCHES.map(s => `<button class="sw ${s === value ? 'on' : ''}" style="background:${s}" data-c="${s}"></button>`).join('')}
      <label class="sw custom" title="Свой цвет"><input type="color" value="${value}"></label></div></div>`);
    row.onclick = (e) => { const b = e.target.closest('.sw[data-c]'); if (!b) return; $$('.sw', row).forEach(x => x.classList.remove('on')); b.classList.add('on'); onChange(b.dataset.c, true); };
    const inp = $('input', row);
    inp.addEventListener('input', () => onChange(inp.value, false));
    inp.addEventListener('change', () => onChange(inp.value, true));
    return row;
  },

  // ---------------------------------------------------------------- проект
  renderProject() {
    const p = store.p;
    const tabs = h(`<div class="insp-tabs"><button class="active">Проект</button></div>`);
    this.root.appendChild(tabs);
    tabInk.update(tabs, 'insp');
    const body = h('<div class="insp-body"></div>');
    this.root.appendChild(body);
    if (this.viewKey !== 'project') { this.viewKey = 'project'; animIn(body); }
    const sec = this.section(body, 'Сведения');
    const d = store.duration();
    const n = store.allClips().length;
    sec.appendChild(h(`<div class="kv">
      <div><span>Название</span><b>${esc(p.name)}</b></div>
      <div><span>Разрешение</span><b>${p.width}×${p.height}</b></div>
      <div><span>Длительность</span><b>${fmtDur(d)}</b></div>
      <div><span>Клипов</span><b>${n}</b></div>
      <div><span>Медиафайлов</span><b>${p.media.length}</b></div>
      <div><span>Папка</span><b class="link" id="openProjDir">Открыть</b></div>
    </div>`));
    $('#openProjDir', sec).onclick = () => window.api.openPath(store.dir);
    const s2 = this.section(body, 'Соотношение сторон');
    s2.appendChild(ratioGrid());
    const s3 = this.section(body, 'Частота кадров');
    const fr = h(`<div class="seg wide">${[24, 25, 30, 50, 60].map(f => `<button data-f="${f}" class="${p.fps === f ? 'on' : ''}">${f}</button>`).join('')}</div>`);
    fr.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; p.fps = +b.dataset.f; store.commit('fps'); bus.emit('resize'); this.render(); };
    s3.appendChild(fr);
    const s4 = this.section(body, 'Фон');
    s4.appendChild(this.colorRow('Цвет фона', p.bg, (v, done) => { p.bg = v; Player.requestRender(); if (done) store.commit('bg'); }));
    Plugins.inspectorSections('project', body, null);
    const tip = h(`<div class="insp-tip">${icon('info')}<span>Выберите клип на таймлайне, чтобы настроить его: обрезка, громкость, скорость, фильтры и анимации.</span></div>`);
    body.appendChild(tip);
  },
};

function ratioGrid(onDone) {
  const p = store.p;
  const g = h(`<div class="ratio-grid">${RATIOS.map(r => {
    const w = r.w ? (r.w > r.h ? 28 : 28 * r.w / r.h) : 24, hh = r.w ? (r.w > r.h ? 28 * r.h / r.w : 28) : 18;
    return `<button class="ratio-tile ${p.ratio === r.id ? 'on' : ''}" data-r="${r.id}" title="${r.hint || ''}"><i style="width:${w}px;height:${hh}px" class="${r.w ? '' : 'orig'}"></i><span>${r.label || r.id}</span></button>`;
  }).join('')}</div>`);
  g.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setRatio(b.dataset.r);
    $$('.ratio-tile', g).forEach(x => x.classList.toggle('on', x === b));
    onDone && onDone();
  };
  return g;
}

function setRatio(id) {
  const p = store.p;
  const r = RATIOS.find(x => x.id === id);
  p.ratio = id;
  if (r.w) { p.width = r.w; p.height = r.h; }
  else {
    const first = store.mainTrack().clips.find(c => c.kind !== 'text');
    const m = first && store.media(first.mediaId);
    if (m && m.width) applyOriginalRatio(m);
  }
  store.commit('ratio');
  bus.emit('resize');
}

// Изменение числа перетаскиванием по полю (как в профессиональных редакторах)
function numDrag(input, onDelta, onEnd) {
  input.addEventListener('mousedown', (e) => {
    if (document.activeElement === input) return;
    e.preventDefault();
    let moved = false, last = e.clientX;
    dragMove(e, (ev) => {
      const d = ev.clientX - last; last = ev.clientX;
      if (Math.abs(ev.clientX - e.clientX) > 2) moved = true;
      if (moved && d) onDelta(d * (ev.shiftKey ? 10 : 1));
    }, () => { if (moved) onEnd(); else { input.focus(); input.select(); } }, 'ew-resize');
  });
}
