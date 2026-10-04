// Таймлайн: дорожки, клипы, перетаскивание, обрезка, привязка
const HEAD_W = 124;
const ROW_H = { main: 64, video: 50, text: 30, effect: 30, audio: 46, rec: 46 };
const PPS_MIN = 1.5, PPS_MAX = 700;

const Timeline = {
  pps: 60,
  rows: {},   // trackId -> { row, head, lane, clips: {clipId: el} }
  rec: null,  // { start, end } — идущая запись озвучки
  userZoomed: false,

  init() {
    this.scroll = $('#tlScroll');
    this.canvasEl = $('#tlCanvas');
    this.tracksEl = $('#tlTracks');
    this.ruler = $('#rulerCanvas');
    this.playhead = $('#playhead');
    this.snapLine = $('#snapLine');
    this.insertLine = $('#insertLine');

    // после правки (удаление, перестановка, отмена) клипы доезжают на новые места, а не прыгают
    bus.on('edit', () => {
      if (reducedMotion()) return;
      this.tracksEl.classList.add('tl-anim');
      clearTimeout(this.animT);
      this.animT = setTimeout(() => this.tracksEl.classList.remove('tl-anim'), 240);
    });
    bus.on('project', () => this.render());
    bus.on('selection', () => this.render());
    bus.on('thumbs', () => this.drawCanvases(true));
    bus.on('media', () => this.render());
    bus.on('theme', () => { this.drawRuler(); this.drawCanvases(true); });
    bus.on('time', (src) => { this.updatePlayhead(); if (src === 'play') this.follow(); });

    this.scroll.addEventListener('scroll', () => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = null; this.drawRuler(); this.drawCanvases(); });
    });
    new ResizeObserver(() => this.render()).observe(this.scroll);

    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const r = this.laneLeft();
        this.zoomAt(this.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), (e.clientX - r) / this.pps);
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.scroll.scrollLeft += e.deltaY;
      } else if (e.shiftKey) {
        e.preventDefault();
        this.scroll.scrollTop += e.deltaY;
      }
    }, { passive: false });

    // Клик по линейке / пустому месту — перемещение курсора
    $('#tlRuler').addEventListener('mousedown', (e) => this.scrub(e));
    this.playhead.addEventListener('mousedown', (e) => { e.stopPropagation(); this.scrub(e); });
    this.tracksEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.clip') || e.target.closest('.tl-head')) return;
      if (Edit.tool === 'hand') { Edit.pan(e); return; }
      store.select(null);
      this.scrub(e);
    });
    // ПКМ по пустому месту дорожки — закрыть пробел (ripple delete), как в Premiere
    this.tracksEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.clip') || e.target.closest('.tl-head')) return;
      const row = e.target.closest('.tl-row');
      const tr = row && store.p.tracks.find(t => t.id === row.dataset.track);
      if (!tr) return;
      e.preventDefault();
      const g = Edit.gapAt(tr, this.timeAt(e.clientX));
      showMenu(e.clientX, e.clientY, [
        { label: 'Удалить пробел со сдвигом', icon: 'trash', disabled: !g || tr.locked, onClick: () => Edit.deleteGap(g) },
        { label: 'Вставить', onClick: () => { store.setTime(this.timeAt(e.clientX)); App.paste(); } },
        '-',
        { label: 'Добавить маркер', icon: 'marker', onClick: () => this.addMarker(this.timeAt(e.clientX)) },
      ]);
    });
    this.tracksEl.addEventListener('mousemove', (e) => Edit.hover(e));
    this.tracksEl.addEventListener('mouseleave', () => this.hideCut());

    // Перетаскивание из медиатеки и из файлового менеджера
    this.scroll.addEventListener('dragover', (e) => this.onDragOver(e));
    this.scroll.addEventListener('dragleave', (e) => { if (!this.scroll.contains(e.relatedTarget)) this.clearDropHint(); });
    this.scroll.addEventListener('drop', (e) => this.onDrop(e));

    // Зум
    const zr = $('#tZoom');
    zr.addEventListener('input', () => { this.userZoomed = true; this.zoomAt(this.sliderToPps(+zr.value), store.time); });
    $('#tZoomIn').onclick = () => this.zoomAt(this.pps * 1.4, store.time);
    $('#tZoomOut').onclick = () => this.zoomAt(this.pps / 1.4, store.time);
    $('#tZoomFit').onclick = () => this.fit();
  },

  sliderToPps(v) { return Math.exp(Math.log(PPS_MIN) + (Math.log(PPS_MAX) - Math.log(PPS_MIN)) * v / 100); },
  ppsToSlider(p) { return (Math.log(p) - Math.log(PPS_MIN)) / (Math.log(PPS_MAX) - Math.log(PPS_MIN)) * 100; },
  zoomAt(pps, anchorT) {
    this.userZoomed = true;
    const old = this.pps;
    this.pps = clamp(pps, PPS_MIN, PPS_MAX);
    const ax = anchorT * old - this.scroll.scrollLeft;
    this.render();
    this.scroll.scrollLeft = anchorT * this.pps - ax;
    $('#tZoom').value = this.ppsToSlider(this.pps);
    $('#tZoom').style.setProperty('--p', this.ppsToSlider(this.pps) + '%');
  },
  fit() {
    const d = Math.max(5, store.duration());
    const vw = this.scroll.clientWidth - HEAD_W - 60;
    this.pps = clamp(vw / d, PPS_MIN, PPS_MAX);
    this.userZoomed = false;
    $('#tZoom').value = this.ppsToSlider(this.pps);
    $('#tZoom').style.setProperty('--p', this.ppsToSlider(this.pps) + '%');
    this.render();
    this.scroll.scrollLeft = 0;
  },
  autoFit() { if (!this.userZoomed) this.fit(); },

  laneLeft() { return this.canvasEl.getBoundingClientRect().left + HEAD_W; },
  // линия разреза под курсором (инструмент «Лезвие»); tr = null — через все дорожки
  showCut(t, tr) {
    const el = $('#cutLine');
    const ct = this.canvasEl.getBoundingClientRect().top;
    let top = 24, hh = this.tracksEl.getBoundingClientRect().height;
    if (tr && this.rows[tr.id]) { const r = this.rows[tr.id].row.getBoundingClientRect(); top = r.top - ct; hh = r.height; }
    el.classList.remove('hidden');
    el.style.transform = `translate(${HEAD_W + t * this.pps}px, ${top}px)`;
    el.style.height = hh + 'px';
  },
  hideCut() { const el = $('#cutLine'); if (el) el.classList.add('hidden'); },
  timeAt(clientX) { return Math.max(0, (clientX - this.laneLeft()) / this.pps); },
  frame() { return 1 / (store.p ? store.p.fps : 30); },

  // ---------------------------------------------------------------- рендер
  render() {
    const p = store.p;
    if (!p) return;
    const dur = store.duration();
    const vw = this.scroll.clientWidth - HEAD_W;
    const contentW = Math.max(vw, (dur + Math.max(20, dur * 0.35)) * this.pps, ((this.rec ? this.rec.end : 0) + 20) * this.pps);
    this.canvasEl.style.width = (HEAD_W + contentW) + 'px';
    const sel = store.sel;
    const used = new Set();

    const rowsOrder = [...p.tracks];
    const rowEls = [];
    for (const t of rowsOrder) {
      used.add(t.id);
      let R = this.rows[t.id];
      if (!R) {
        const row = h(`<div class="tl-row"><div class="tl-head"></div><div class="tl-lane"></div></div>`);
        R = this.rows[t.id] = { row, head: $('.tl-head', row), lane: $('.tl-lane', row), clips: {}, headKey: '' };
        R.row.dataset.track = t.id;
      }
      const kind = t.main ? 'main' : t.kind;
      R.row.className = `tl-row k-${kind}${t.hidden ? ' hidden-track' : ''}${t.muted ? ' muted-track' : ''}${t.locked ? ' locked-track' : ''}`;
      R.row.style.height = ROW_H[kind] + 'px';
      this.renderHead(R, t);
      const seen = new Set();
      for (const c of t.clips) {
        seen.add(c.id);
        let el = R.clips[c.id];
        if (!el) {
          el = this.makeClipEl(c);
          R.clips[c.id] = el;
          R.lane.appendChild(el);
        } else if (el.parentNode !== R.lane) R.lane.appendChild(el);
        this.updateClipEl(el, c, t, c.id === sel);
      }
      for (const id of Object.keys(R.clips)) if (!seen.has(id)) { R.clips[id].remove(); delete R.clips[id]; }
      if (t.main) this.renderTransMarks(R, t);
      rowEls.push(R.row);
    }
    // Строка записи озвучки
    if (this.rec) {
      if (!this.recRow) this.recRow = h(`<div class="tl-row k-rec"><div class="tl-head"><span class="th-name rec-dot">Запись</span></div><div class="tl-lane"><div class="clip k-rec"><div class="clip-label"><span>● Запись…</span></div></div></div></div>`);
      this.recRow.style.height = ROW_H.rec + 'px';
      const ce = $('.clip', this.recRow);
      ce.style.left = this.rec.start * this.pps + 'px';
      ce.style.width = Math.max(2, (this.rec.end - this.rec.start) * this.pps) + 'px';
      rowEls.push(this.recRow);
    }
    // Порядок строк
    const cur = [...this.tracksEl.children];
    if (cur.length !== rowEls.length || cur.some((r, i) => r !== rowEls[i])) {
      this.tracksEl.replaceChildren(...rowEls);
    }
    for (const id of Object.keys(this.rows)) if (!used.has(id)) { this.rows[id].row.remove(); delete this.rows[id]; }

    $('#tlEmpty').classList.toggle('hidden', p.tracks.some(t => t.clips.length) || !!this.rec);
    this.renderMarkers();
    Edit.renderRange(true);
    this.updatePlayhead();
    this.drawRuler();
    this.drawCanvases();
    this.updateToolbar();
  },

  renderTransMarks(R, t) {
    R.marks = R.marks || [];
    const need = [];
    t.clips.forEach((c, i) => { if (i > 0 && c.trans) need.push({ c, x: c.start + transOverlap(t.clips[i - 1], c) / 2 }); });
    while (R.marks.length > need.length) R.marks.pop().remove();
    while (R.marks.length < need.length) {
      const m = h(`<div class="trans-mark" title="Переход">${icon('transition')}</div>`);
      m.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        store.select(m.dataset.id);
        Panels.show('transitions');
      });
      R.lane.appendChild(m);
      R.marks.push(m);
    }
    need.forEach((n, i) => {
      const m = R.marks[i];
      m.dataset.id = n.c.id;
      m.style.left = n.x * this.pps + 'px';
      m.classList.toggle('sel', store.sel === n.c.id);
      if (m.parentNode !== R.lane || m.nextSibling) R.lane.appendChild(m);
    });
  },

  // ---------------------------------------------------------------- маркеры
  // store.p.markers = [{ id, t, color, name }] — флажки на линейке (входят в историю отмены)
  MARKER_COLORS: ['#1fcfe0', '#ffcc00', '#ff453a', '#30d158', '#bf5af2', '#ff9f0a', '#f4f4f5'],
  renderMarkers() {
    const box = $('#tlMarks');
    if (!box || !store.p) return;
    const list = store.p.markers || [];
    const els = [...box.children];
    while (els.length > list.length) els.pop().remove();
    while (els.length < list.length) {
      const m = h(`<div class="tl-mark">${icon('markerFill')}<span></span></div>`);
      m.addEventListener('mousedown', (e) => this.onMarkerDown(e, m.dataset.id));
      m.addEventListener('dblclick', (e) => { e.stopPropagation(); this.renameMarker(m.dataset.id); });
      m.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.markerMenu(m.dataset.id, e.clientX, e.clientY); });
      box.appendChild(m); els.push(m);
    }
    list.forEach((mk, i) => {
      const m = els[i];
      m.dataset.id = mk.id;
      m.style.left = (HEAD_W + mk.t * this.pps) + 'px';
      m.style.setProperty('--mc', mk.color || this.MARKER_COLORS[0]);
      const nm = $('span', m);
      if (nm.textContent !== (mk.name || '')) nm.textContent = mk.name || '';
      m.title = (mk.name ? mk.name + ' · ' : '') + fmtDur(mk.t);
    });
  },
  addMarker(t = store.time) {
    if (!store.p) return;
    t = Math.round(t * store.p.fps) / store.p.fps;
    const ex = store.p.markers.find(m => Math.abs(m.t - t) < 0.5 / store.p.fps);
    if (ex) { store.p.markers.splice(store.p.markers.indexOf(ex), 1); store.commit('marker-del'); toast('Маркер удалён', 'info', 1200); return; }
    const last = store.p.markers[store.p.markers.length - 1];
    store.p.markers.push({ id: uid(), t, color: last ? last.color : this.MARKER_COLORS[0], name: '' });
    store.p.markers.sort((a, b) => a.t - b.t);
    store.commit('marker');
  },
  onMarkerDown(e, id) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const mk = store.p.markers.find(m => m.id === id);
    if (!mk) return;
    if (Player.playing) Player.pause();
    const t0 = mk.t, x0 = e.clientX;
    let moved = false;
    dragMove(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      let t = Math.max(0, t0 + (ev.clientX - x0) / this.pps);
      if (store.snap && !ev.altKey) { const s = this.snapPoint(t, null, 8 / this.pps, false, id); this.showSnap(s); if (s != null) t = s; }
      mk.t = Math.round(t * store.p.fps) / store.p.fps;
      this.renderMarkers();
    }, () => {
      this.showSnap(null);
      if (moved) { store.p.markers.sort((a, b) => a.t - b.t); store.commit('marker-move'); }
      else { store.setTime(mk.t); this.ensureVisible(mk.t); }
    }, 'ew-resize');
  },
  renameMarker(id) {
    const mk = store.p.markers.find(m => m.id === id);
    if (!mk) return;
    const body = h(`<div class="ex-row"><label>Название</label><input class="text-input" maxlength="60"></div>`);
    const inp = $('input', body);
    inp.value = mk.name || '';
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('.modal-foot .primary-btn').click(); });
    modal({ title: 'Маркер', body, width: 360, buttons: [{ label: 'Отмена' }, { label: 'Сохранить', primary: true, onClick: () => { mk.name = inp.value.trim(); store.commit('marker-name'); } }] });
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  },
  markerMenu(id, x, y) {
    const mk = store.p.markers.find(m => m.id === id);
    if (!mk) return;
    showMenu(x, y, [
      { label: 'Перейти к маркеру', onClick: () => { store.setTime(mk.t); this.ensureVisible(mk.t); } },
      { label: 'Переименовать…', icon: 'pencil', onClick: () => this.renameMarker(id) },
      '-',
      ...this.MARKER_COLORS.map((c, i) => ({ label: ['Бирюзовый', 'Жёлтый', 'Красный', 'Зелёный', 'Фиолетовый', 'Оранжевый', 'Белый'][i], swatch: c, checked: (mk.color || this.MARKER_COLORS[0]) === c, onClick: () => { mk.color = c; store.commit('marker-color'); } })),
      '-',
      { label: 'Удалить маркер', icon: 'trash', danger: true, onClick: () => { store.p.markers.splice(store.p.markers.indexOf(mk), 1); store.commit('marker-del'); } },
      { label: 'Удалить все маркеры', danger: true, disabled: store.p.markers.length < 2, onClick: () => { store.p.markers = []; store.commit('markers-clear'); } },
    ]);
  },

  trackName(t) {
    if (t.main) return 'Главная';
    const names = { video: 'Видео', audio: 'Аудио', text: 'Текст', effect: 'Эффекты' };
    const same = store.p.tracks.filter(x => x.kind === t.kind && !x.main);
    // нумерация снизу вверх для видео/текста/эффектов, сверху вниз для аудио
    const i = t.kind === 'audio' ? same.indexOf(t) + 1 : same.length - same.indexOf(t);
    return `${names[t.kind] || 'Дорожка'} ${i + (t.kind === 'video' ? 1 : 0)}`;
  },
  renderHead(R, t) {
    const name = this.trackName(t);
    const key = [t.main, t.kind, t.muted, t.hidden, t.locked, name].join();
    if (R.headKey === key) return;
    R.headKey = key;
    const kindIcon = t.kind === 'audio' ? 'music' : t.kind === 'text' ? 'type' : t.kind === 'effect' ? 'sparkles' : 'video';
    let html = `<span class="th-kind">${icon(kindIcon)}</span><span class="th-name">${name}</span>`;
    html += '<span class="th-btns">';
    html += `<button class="th-btn ${t.locked ? 'off' : ''}" data-act="lock" title="${t.locked ? 'Разблокировать' : 'Заблокировать'} дорожку">${icon('lock')}</button>`;
    if (t.kind !== 'audio') html += `<button class="th-btn ${t.hidden ? 'off' : ''}" data-act="hide" title="${t.hidden ? 'Показать' : 'Скрыть'} дорожку">${icon(t.hidden ? 'eyeOff' : 'eye')}</button>`;
    if (t.kind !== 'text' && t.kind !== 'effect') html += `<button class="th-btn ${t.muted ? 'off' : ''}" data-act="mute" title="${t.muted ? 'Включить' : 'Выключить'} звук дорожки">${icon(t.muted ? 'volumeX' : 'volume')}</button>`;
    html += '</span>';
    R.head.innerHTML = html;
    R.head.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'hide') t.hidden = !t.hidden;
      if (b.dataset.act === 'mute') t.muted = !t.muted;
      if (b.dataset.act === 'lock') t.locked = !t.locked;
      store.commit('track');
      Player.requestRender();
    };
  },

  makeClipEl(c) {
    const el = h(`<div class="clip">
      <canvas class="clip-cv"></canvas>
      <div class="clip-label"><span class="cl-badges"></span><span class="cl-name"></span><span class="cl-dur"></span></div>
      <div class="clip-h l"></div><div class="clip-h r"></div>
    </div>`);
    el.dataset.id = c.id;
    el.addEventListener('mousedown', (e) => this.onClipDown(e, el.dataset.id));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); store.select(el.dataset.id); this.clipMenu(e.clientX, e.clientY); });
    return el;
  },

  updateClipEl(el, c, t, selected) {
    const m = c.mediaId ? store.media(c.mediaId) : null;
    const voice = m && m.voice;
    const kind = c.kind === 'audio' ? (voice ? 'voice' : 'audio') : c.kind;
    el.className = `clip k-${kind}${selected ? ' sel' : ''}${c.disabled ? ' disabled' : ''}${m && assets[m.id] && assets[m.id].missing ? ' missing' : ''}`;
    el.style.left = (c.start * this.pps) + 'px';
    el.style.width = Math.max(3, clipDur(c) * this.pps) + 'px';
    let name = c.kind === 'text' ? c.text.split('\n')[0] : c.kind === 'effect' ? (EFFECT_BY_ID[c.effect] ? EFFECT_BY_ID[c.effect].name : 'Эффект') : (m ? m.name : 'Медиа');
    if (voice) name = 'Озвучка';
    const nm = $('.cl-name', el);
    if (nm.textContent !== name) nm.textContent = name;
    $('.cl-dur', el).textContent = fmtSec(clipDur(c));
    let badges = '';
    if (c.disabled) badges += icon('prohibit');
    if (c.kind === 'text') badges += icon('type');
    if (c.kind === 'effect') badges += icon('sparkles');
    if (hasCurve(c)) badges += `<b class="vs-badge">${icon('curve')}${esc(curveName(c.curve))}</b>`;
    else if (c.speed !== 1) badges += `<b>${+c.speed.toFixed(2)}x</b>`;
    if (c.muted || (c.kind === 'video' && m && !m.hasAudio)) badges += c.muted ? icon('volumeX') : '';
    if ((c.filter && c.filter.name) || curvesOn(c)) badges += icon('filters');
    if (c.anim && (c.anim.in !== 'none' || c.anim.out !== 'none')) badges += icon('sparkles');
    if (c.voiceMode) {
      const j = VoiceSep.jobFor(c), ready = VoiceSep.stemFor(c);
      badges += `<b class="vs-badge ${ready ? '' : 'busy'}">${icon(VOICE_MODES[c.voiceMode].icon)}${ready ? VOICE_MODES[c.voiceMode].short : j ? 'Нейросеть ' + jobPct(j) : 'Ожидание…'}</b>`;
    }
    if (textAnimOn(c)) badges += icon('textAnim');
    if (mblurOn(c)) badges += icon('wind');
    if (c.matte && c.matte.id && matteOf(c)) badges += icon('matte');
    // клип служит слоем-маской другому — сам не показывается
    if (store.p && matteSources().has(c.id)) { badges += `<b class="vs-badge">${icon('matte')}Маска</b>`; el.classList.add('matte-src'); }
    const rj = Roto.jobFor(c);
    if (rj) badges += `<b class="vs-badge busy">${icon('magicWand')}Вырезание ${jobPct(rj)}</b>`;
    else if (Roto.on(c)) badges += icon('magicWand');
    const tj = Track.jobFor(c);
    if (tj) badges += `<b class="vs-badge busy">${icon('track')}Трекинг ${jobPct(tj)}</b>`;
    else if (c.follow) badges += icon('track');
    if (Stab.on(c)) {
      const j = Stab.jobFor(c), ready = Stab.fileFor(c);
      badges += `<b class="vs-badge ${ready ? '' : 'busy'}">${icon('stabilize')}${ready ? 'Стабилизация' : j ? 'Стабилизация ' + Math.round(j.p * 100) + '%' : 'Ожидание…'}</b>`;
    }
    if (c.denoise > 0 && !c.voiceFx) {
      const ready = VoiceFx.fileFor(c);
      badges += `<b class="vs-badge ${ready ? '' : 'busy'}">${icon('denoise')}${ready ? 'Без шума' : 'Обработка…'}</b>`;
    }
    if (c.duck && c.duck.on) badges += icon('duck');
    if (c.voiceFx && VOICE_FX_BY_ID[c.voiceFx]) {
      const ready = VoiceFx.fileFor(c), v = VOICE_FX_BY_ID[c.voiceFx];
      badges += `<b class="vs-badge ${ready ? '' : 'busy'}">${icon(v.icon)}${ready ? v.name : 'Обработка…'}</b>`;
    }
    const bEl = $('.cl-badges', el);
    if (bEl.innerHTML !== badges) bEl.innerHTML = badges;
    // ключевые кадры — ромбики внизу клипа (громкость — отдельным цветом)
    const inside = (x) => x >= -1e-3 && x <= clipDur(c) + 1e-3;
    // ключи трекинга (десятки на секунду) не рисуем — клип помечен значком трекинга
    const keys = c.follow ? [] : (c.keys || []).map(k => ltAt(c, k.s)).filter(inside);
    const vkeys = (c.vkeys || []).map(k => ltAt(c, k.s)).filter(inside);
    const kk = keys.map(x => x.toFixed(3)).join() + '|' + vkeys.map(x => x.toFixed(3)).join() + '|' + this.pps + '|' + selected;
    if (el._kk !== kk) {
      el._kk = kk;
      el.querySelectorAll('.kf').forEach(n => n.remove());
      for (const [list, cls] of [[keys, 'kf'], [vkeys, 'kf v']]) for (const x of list) {
        const d = document.createElement('i');
        d.className = cls;
        d.style.left = (x * this.pps) + 'px';
        d.dataset.t = x;
        el.appendChild(d);
      }
    }
  },

  // Холсты клипов рисуем только в видимой области
  drawCanvases(force) {
    if (!store.p) return;
    const sl = this.scroll.scrollLeft, vw = this.scroll.clientWidth - HEAD_W;
    const dpr = window.devicePixelRatio || 1;
    for (const t of store.p.tracks) {
      const R = this.rows[t.id];
      if (!R) continue;
      for (const c of t.clips) {
        const el = R.clips[c.id];
        if (!el) continue;
        const L = c.start * this.pps, Wd = clipDur(c) * this.pps;
        const a = Math.max(L, sl - 50), b = Math.min(L + Wd, sl + vw + 50);
        const cv = el.firstElementChild;
        if (b <= a || c.kind === 'text' || c.kind === 'effect') { cv.style.display = 'none'; continue; }
        const x0 = a - L, w = b - a;
        const Hh = el.clientHeight || ROW_H[t.main ? 'main' : t.kind];
        const a_ = assets[c.mediaId] || {};
        const key = [x0 | 0, w | 0, Hh, this.pps, c.in, c.out, c.speed, c.curve ? JSON.stringify(c.curve.pts) : '', c.volume, c.vkeys ? JSON.stringify(c.vkeys) : '', c.duck && c.duck.on ? c.duck.amount + ':' + c.start + ':' + Duck.intervals().length : '', c.muted, !!a_.sprite, !!a_.wave, t.muted].join();
        if (!force && cv._key === key) continue;
        cv._key = key;
        cv.style.display = '';
        cv.style.left = x0 + 'px';
        cv.style.width = w + 'px';
        cv.style.height = Hh + 'px';
        cv.width = Math.ceil(w * dpr); cv.height = Math.ceil(Hh * dpr);
        const ctx = cv.getContext('2d');
        ctx.scale(dpr, dpr);
        if (c.kind === 'video' || c.kind === 'image') this.drawThumbs(ctx, c, a_, x0, w, Hh, t);
        else if (c.kind === 'audio') this.drawWave(ctx, c, a_, x0, w, Hh, Hh - 16, 16, t.muted || c.muted);
      }
    }
  },
  drawThumbs(ctx, c, a, x0, w, Hh, t) {
    const sp = a.sprite, meta = a.meta;
    const m = store.media(c.mediaId);
    const hasWave = c.kind === 'video' && m && m.hasAudio && a.wave && !c.muted;
    const th = hasWave ? Hh - 12 : Hh;
    if (sp && meta) {
      const tw = th * meta.tw / meta.th;
      const first = Math.floor(x0 / tw) * tw;
      for (let x = first; x < x0 + w; x += tw) {
        let idx = 0;
        if (c.kind === 'video') {
          const src = srcAt(c, (x + tw / 2) / this.pps);
          idx = clamp(Math.floor(src / meta.interval), 0, meta.count - 1);
        }
        const sx = (idx % meta.cols) * meta.tw, sy = Math.floor(idx / meta.cols) * meta.th;
        ctx.drawImage(sp, sx, sy, meta.tw, meta.th, x - x0, 0, tw + 0.5, th);
      }
    } else {
      ctx.fillStyle = css('--thumb-empty');
      ctx.fillRect(0, 0, w, th);
    }
    if (hasWave) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(0, th, w, Hh - th);
      this.drawWave(ctx, c, a, x0, w, Hh, 12, 0, t.muted, th, css('--wave-strip'));
    }
  },
  drawWave(ctx, c, a, x0, w, Hh, waveH, top, muted, yOff, color) {
    const wave = a.wave;
    if (!wave) return;
    const base = (yOff != null ? yOff : top) + waveH;
    ctx.fillStyle = color || (muted ? 'rgba(255,255,255,.22)' : css('--wave'));
    const lt0 = c.start;
    for (let x = 0; x < w; x += 2) {
      const s0 = srcAt(c, (x0 + x) / this.pps), s1 = srcAt(c, (x0 + x + 2) / this.pps);
      let i0 = Math.floor(s0 * 100), i1 = Math.max(i0 + 1, Math.ceil(s1 * 100));
      let pk = 0;
      for (let i = i0; i < i1 && i < wave.length; i++) if (wave[i] > pk) pk = wave[i];
      const lt = (x0 + x) / this.pps, d = clipDur(c);
      let g = muted ? 0.3 : Math.min(1.6, volAt(c, lt) * Duck.gainAt(c, c.start + lt));
      if (c.fadeIn > 0 && lt < c.fadeIn) g *= lt / c.fadeIn;
      if (c.fadeOut > 0 && lt > d - c.fadeOut) g *= Math.max(0, (d - lt) / c.fadeOut);
      const hh = Math.max(1, Math.min(1, pk / 255 * g) * waveH * 0.95);
      ctx.fillRect(x, base - hh, 1.4, hh);
    }
  },

  drawRuler() {
    if (!store.p) return;
    const cv = this.ruler, dpr = window.devicePixelRatio || 1;
    const vw = this.scroll.clientWidth - HEAD_W;
    const Hh = 26;
    cv.style.width = vw + 'px';
    if (cv.width !== Math.round(vw * dpr)) { cv.width = Math.round(vw * dpr); cv.height = Hh * dpr; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, Hh);
    const sl = this.scroll.scrollLeft, pps = this.pps, fps = store.p.fps;
    const io = Edit.range();
    if (io) {
      const x0 = io.a * pps - sl, x1 = io.b * pps - sl;
      ctx.fillStyle = css('--io-fill'); ctx.fillRect(x0, 0, x1 - x0, Hh);
      ctx.fillStyle = css('--io');
      if (store.p.io.a != null) { ctx.fillRect(Math.round(x0), 0, 2, Hh); ctx.fillRect(Math.round(x0), 0, 6, 2); ctx.fillRect(Math.round(x0), Hh - 2, 6, 2); }
      if (store.p.io.b != null) { ctx.fillRect(Math.round(x1) - 2, 0, 2, Hh); ctx.fillRect(Math.round(x1) - 6, 0, 6, 2); ctx.fillRect(Math.round(x1) - 6, Hh - 2, 6, 2); }
    }
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
    let major = steps.find(s => s * pps >= 80) || 3600;
    const minorN = major <= 10 / fps ? (major * fps > 1 ? Math.round(major * fps) : 1) : [0.5, 5, 15, 30, 60, 300, 1800].some(v => Math.abs(v - major) < 1e-6) ? 5 : 10;
    const minor = major / Math.max(1, minorN);
    const t0 = Math.floor(sl / pps / major) * major, t1 = (sl + vw) / pps;
    ctx.fillStyle = css('--ruler');
    ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = 'top';
    for (let tm = t0; tm <= t1 + major; tm += minor) {
      const x = Math.round(tm * pps - sl) + 0.5;
      const isMajor = Math.abs(tm / major - Math.round(tm / major)) < 1e-6;
      ctx.fillRect(x, isMajor ? Hh - 9 : Hh - 5, 1, isMajor ? 9 : 5);
      if (isMajor) {
        const fr = Math.round((tm % 1) * fps);
        const label = fr && major < 1 ? fr + 'f' : fmtDur(tm);
        ctx.fillStyle = css('--ruler-text');
        ctx.fillText(label, x + 4, 4);
        ctx.fillStyle = css('--ruler');
      }
    }
  },

  updatePlayhead() {
    this.playhead.style.transform = `translateX(${HEAD_W + store.time * this.pps}px)`;
  },
  follow() {
    const x = store.time * this.pps, sl = this.scroll.scrollLeft, vw = this.scroll.clientWidth - HEAD_W;
    if (x > sl + vw - 30 || x < sl) this.scroll.scrollLeft = x - 40;
  },
  ensureVisible(t) {
    const x = t * this.pps, sl = this.scroll.scrollLeft, vw = this.scroll.clientWidth - HEAD_W;
    if (x > sl + vw - 30 || x < sl) this.scroll.scrollLeft = x - vw / 3;
  },

  scrub(e) {
    if (e.button !== 0) return;
    const was = Player.playing;
    if (was) Player.pause();
    const set = (ev) => {
      let t = this.timeAt(ev.clientX);
      if (store.snap && !ev.altKey) {
        const s = this.snapPoint(t, -1, 6 / this.pps, true);
        if (s != null) t = s;
      }
      store.setTime(Math.round(t * store.p.fps) / store.p.fps);
    };
    set(e);
    dragMove(e, set, () => { }, 'ew-resize');
  },

  updateToolbar() {
    $('#tUndo').disabled = !store.undoStack.length;
    $('#tRedo').disabled = !store.redoStack.length;
    const s = store.selected();
    $('#tDelete').disabled = !s;
    $('#tDup').disabled = !s;
    $('#tDetach').disabled = !(s && s.clip.kind === 'video' && hasAudioTrack(s.clip) && !s.clip.muted);
    $('#tMirror').disabled = $('#tRotate').disabled = !(s && isVisual(s.clip));
    $('#tFreeze').disabled = !(s && s.clip.kind === 'video');
    const tgt = this.splitTarget();
    $('#tSplit').disabled = $('#tTrimL').disabled = $('#tTrimR').disabled = !tgt;
    $('#tMagnet').classList.toggle('on', store.magnet);
    $('#tSnap').classList.toggle('on', store.snap);
  },

  // ---------------------------------------------------------------- привязка
  snapPoint(t, excludeId, th, noPlayhead, excludeMarker) {
    let best = null, bd = th;
    const test = (v) => { const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; } };
    test(0);
    if (!noPlayhead) test(store.time);
    for (const m of store.p.markers || []) if (m.id !== excludeMarker) test(m.t);
    for (const t_ of store.p.tracks) for (const c of t_.clips) {
      if (c.id === excludeId) continue;
      test(c.start); test(clipEnd(c));
    }
    return best;
  },
  showSnap(t) {
    if (t == null) { this.snapLine.classList.add('hidden'); return; }
    this.snapLine.classList.remove('hidden');
    this.snapLine.style.transform = `translateX(${HEAD_W + t * this.pps}px)`;
  },

  rowAt(clientY) {
    const rows = store.p.tracks.map(t => ({ t, r: this.rows[t.id] && this.rows[t.id].row.getBoundingClientRect() })).filter(x => x.r);
    if (!rows.length) return { zone: 'below' };
    if (clientY < rows[0].r.top) return { zone: 'above', r: rows[0].r };
    for (const x of rows) if (clientY >= x.r.top && clientY < x.r.bottom) return { track: x.t, r: x.r };
    return { zone: 'below', r: rows[rows.length - 1].r };
  },
  trackKindOf(c) { return c.kind === 'audio' ? 'audio' : c.kind === 'text' ? 'text' : c.kind === 'effect' ? 'effect' : 'video'; },

  // ---------------------------------------------------------------- мышь на клипах
  onClipDown(e, id) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const f = store.find(id);
    if (!f) return;
    if (e.target.classList.contains('kf')) {
      // клик по ромбику — перейти к ключевому кадру
      store.select(id);
      store.setTime(f.clip.start + parseFloat(e.target.dataset.t));
      return;
    }
    if (Player.playing) Player.pause();
    if (Edit.clipDown(e, f, e.currentTarget)) return;
    store.select(id);
    if (f.track.locked) return; // заблокированная дорожка: только выделение
    const side = e.target.classList.contains('clip-h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    if (side) this.startTrim(e, f.clip, f.track, side);
    else this.startMove(e, f.clip, f.track);
  },

  startTrim(e, c, t, side) {
    const o = { start: c.start, in: c.in, out: c.out };
    // исходное состояние клипа: по нему пересчитываем время источника (и кривую скорости) при любом сдвиге края
    const O = { in: c.in, out: c.out, speed: c.speed, curve: c.curve ? deep(c.curve) : null };
    const D0 = clipDur(O);
    const m = c.mediaId ? store.media(c.mediaId) : null;
    const unbounded = c.kind === 'image' || c.kind === 'text' || c.kind === 'effect';
    const maxOut = unbounded ? Infinity : (m ? m.duration : Infinity);
    const minLen = this.frame() * Math.max(rateAt(O, 0), rateAt(O, D0));
    const isMain = t.main && store.magnet;
    const others = t.clips.filter(x => x !== c);
    const prevEnd = isMain ? 0 : Math.max(0, ...others.filter(x => clipEnd(x) <= o.start + 1e-6).map(clipEnd));
    const nextStart = isMain ? Infinity : Math.min(Infinity, ...others.filter(x => x.start >= o.start + D0 - 1e-6).map(x => x.start));
    const tip = h('<div class="tl-tip"></div>');
    document.body.appendChild(tip);
    dragMove(e, (ev, dx) => {
      let dt = dx / this.pps;
      if (side === 'l') {
        let edge = o.start + dt;
        if (store.snap && !isMain) { const s = this.snapPoint(edge, c.id, 8 / this.pps); if (s != null) { dt = s - o.start; } this.showSnap(s); }
        let nin = srcAtExt(O, dt);
        if (!unbounded) nin = Math.max(0, nin);
        nin = Math.min(nin, o.out - minLen);
        let nstart = o.start + ltAtExt(O, nin);
        if (!isMain && nstart < prevEnd) { nstart = prevEnd; nin = srcAtExt(O, nstart - o.start); }
        if (!isMain && nstart < 0) { nstart = 0; nin = srcAtExt(O, -o.start); }
        c.in = nin;
        if (!isMain) c.start = nstart;
      } else {
        let edge = o.start + D0 + dt;
        if (store.snap) { const s = this.snapPoint(edge, c.id, 8 / this.pps); if (s != null) dt = s - (o.start + D0); this.showSnap(s); }
        let nout = clamp(srcAtExt(O, D0 + dt), o.in + minLen, maxOut);
        if (nextStart < Infinity) nout = Math.min(nout, srcAtExt(O, nextStart - o.start));
        c.out = nout;
      }
      if (O.curve) c.curve = curveRange(O.curve, O.in, O.out, c.in, c.out);
      if (t.main) store.packMain();
      this.render();
      tip.textContent = fmtSec(clipDur(c));
      tip.style.left = ev.clientX + 12 + 'px';
      tip.style.top = ev.clientY - 30 + 'px';
      Player.requestRender();
    }, () => {
      tip.remove();
      this.showSnap(null);
      Edit.normalize(c);
      store.packMain();
      store.commit('trim');
    }, 'ew-resize');
  },

  startMove(e, c, t) {
    const el = this.rows[t.id].clips[c.id];
    const grab = this.timeAt(e.clientX) - c.start;
    const len = clipDur(c);
    const kind = this.trackKindOf(c);
    let ghost = null, moved = false, st = c.start, target = null, insertIdx = null;
    const canvasTop = () => this.canvasEl.getBoundingClientRect().top;
    dragMove(e, (ev, dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        ghost = el.cloneNode(true);
        ghost.classList.add('ghost');
        ghost.style.width = el.style.width;
        ghost.style.height = el.getBoundingClientRect().height + 'px';
        this.canvasEl.appendChild(ghost);
        el.classList.add('moving');
      }
      st = Math.max(0, this.timeAt(ev.clientX) - grab);
      let snapped = null;
      if (store.snap) {
        const th = 8 / this.pps;
        const a = this.snapPoint(st, c.id, th), b = this.snapPoint(st + len, c.id, th);
        if (a != null && (b == null || Math.abs(a - st) <= Math.abs(b - st - len))) { st = a; snapped = a; }
        else if (b != null) { st = b - len; snapped = b; }
      }
      target = this.rowAt(ev.clientY);
      const ct = canvasTop();
      insertIdx = null;
      this.insertLine.classList.add('hidden');
      if (target.track && target.track.main && kind === 'video' && store.magnet) {
        // Вставка в главную дорожку: показываем линию между клипами
        const mc = target.track.clips.filter(x => x !== c);
        const pt = this.timeAt(ev.clientX);
        insertIdx = mc.findIndex(x => x.start + clipDur(x) / 2 > pt);
        if (insertIdx < 0) insertIdx = mc.length;
        let x = 0;
        for (let i = 0; i < insertIdx; i++) x += clipDur(mc[i]);
        this.insertLine.classList.remove('hidden');
        this.insertLine.style.transform = `translate(${HEAD_W + x * this.pps}px, ${target.r.top - ct}px)`;
        this.insertLine.style.height = target.r.height + 'px';
        snapped = null;
      }
      this.showSnap(snapped);
      let top;
      if (target.track) top = target.r.top - ct + 3;
      else if (target.zone === 'above') top = target.r ? target.r.top - ct - 24 : 30;
      else top = target.r ? target.r.bottom - ct + 4 : 40;
      ghost.style.left = (HEAD_W + st * this.pps) + 'px';
      ghost.style.top = top + 'px';
      const ok = !target.track || this.trackKindOf(c) === target.track.kind;
      ghost.classList.toggle('bad', !ok);
    }, () => {
      this.showSnap(null);
      this.insertLine.classList.add('hidden');
      if (!moved) return;
      ghost.remove();
      el.classList.remove('moving');
      this.applyMove(c, t, st, target, insertIdx);
    }, 'grabbing');
  },

  fits(track, c, start, len) {
    return track.clips.every(o => o === c || clipEnd(o) <= start + 1e-6 || o.start >= start + len - 1e-6);
  },

  applyMove(c, from, st, target, insertIdx) {
    const kind = this.trackKindOf(c);
    const len = clipDur(c);
    from.clips.splice(from.clips.indexOf(c), 1);
    c.start = st;
    const tr = target && target.track;
    if (tr && tr.main && kind === 'video') {
      if (store.magnet) {
        const mc = tr.clips;
        const idx = insertIdx == null ? mc.length : clamp(insertIdx, 0, mc.length);
        mc.splice(idx, 0, c);
        let x = 0; for (const k of mc) { k.start = x; x += clipDur(k); }
      } else if (this.fits(tr, c, st, len)) { tr.clips.push(c); }
      else store.place(c, 'video');
    } else if (tr && tr.kind === kind) {
      if (this.fits(tr, c, st, len)) tr.clips.push(c);
      else {
        const i = store.p.tracks.indexOf(tr);
        const nt = store.addTrack(kind, kind === 'audio' ? i + 1 : i);
        nt.clips.push(c);
      }
    } else if (target && target.zone === 'above' && kind !== 'audio') {
      store.addTrack(kind, 0).clips.push(c);
    } else if (target && target.zone === 'below' && kind === 'audio') {
      store.addTrack('audio').clips.push(c);
    } else {
      store.place(c, kind);
    }
    for (const t of store.p.tracks) t.clips.sort((a, b) => a.start - b.start);
    store.packMain();
    store.cleanupTracks();
    store.commit('move');
  },

  // ---------------------------------------------------------------- drop из медиатеки
  dropPos(e) {
    const target = this.rowAt(e.clientY);
    return { target, t: Math.max(0, this.timeAt(e.clientX)) };
  },
  onDragOver(e) {
    const types = e.dataTransfer.types;
    if (!types.includes('application/x-lincut-media') && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { target, t } = this.dropPos(e);
    const ct = this.canvasEl.getBoundingClientRect().top;
    this.insertLine.classList.remove('hidden');
    let top, hh;
    if (target.track) { top = target.r.top - ct; hh = target.r.height; }
    else { top = target.r ? (target.zone === 'above' ? target.r.top - ct - 20 : target.r.bottom - ct) : 30; hh = 20; }
    let x = t;
    if (target.track && target.track.main && store.magnet) {
      const mc = target.track.clips;
      let i = mc.findIndex(c => c.start + clipDur(c) / 2 > t); if (i < 0) i = mc.length;
      x = 0; for (let k = 0; k < i; k++) x += clipDur(mc[k]);
    }
    this.insertLine.style.transform = `translate(${HEAD_W + x * this.pps}px, ${top}px)`;
    this.insertLine.style.height = hh + 'px';
  },
  clearDropHint() { this.insertLine.classList.add('hidden'); },
  async onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    this.clearDropHint();
    $('#dropHint').classList.add('hidden');
    const { target, t } = this.dropPos(e);
    let medias = [];
    const mid = e.dataTransfer.getData('application/x-lincut-media');
    if (mid) { const m = store.media(mid); if (m) medias = [m]; }
    else if (e.dataTransfer.files.length) {
      const paths = [...e.dataTransfer.files].map(f => window.api.pathForFile(f)).filter(Boolean);
      medias = await Media.importPaths(paths);
    }
    if (!medias.length) return;
    let at = t;
    let last = null;
    for (const m of medias) {
      const c = makeMediaClip(m, at);
      const kind = this.trackKindOf(c);
      if (kind === 'video' && store.mainTrack().clips.length === 0 && store.p.ratio === 'original') applyOriginalRatio(m);
      this.applyMoveNew(c, target, at, kind);
      at = clipEnd(c);
      last = c;
    }
    store.select(last.id);
    store.commit('drop');
    this.autoFit();
  },
  applyMoveNew(c, target, t, kind) {
    const tr = target && target.track;
    const main = store.mainTrack();
    if (kind === 'video' && ((tr && tr.main) || !main.clips.length)) {
      const mc = main.clips;
      let i = mc.findIndex(x => x.start + clipDur(x) / 2 > t); if (i < 0) i = mc.length;
      mc.splice(i, 0, c);
      if (!store.magnet) c.start = t;
      store.packMain();
      return;
    }
    c.start = t;
    if (tr && tr.kind === kind && !tr.main && this.fits(tr, c, t, clipDur(c))) { tr.clips.push(c); tr.clips.sort((a, b) => a.start - b.start); return; }
    if (target && target.zone === 'above' && kind !== 'audio') { store.addTrack(kind, 0).clips.push(c); return; }
    store.place(c, kind, tr && tr.id);
  },

  // ---------------------------------------------------------------- операции
  splitTarget() {
    if (!store.p) return null;
    const t = store.time, f = this.frame() / 2;
    const inside = (c) => t > c.start + f && t < clipEnd(c) - f;
    const s = store.selected();
    if (s && inside(s.clip)) return s;
    const main = store.mainTrack();
    const mc = main && main.clips.find(inside);
    if (mc) return { clip: mc, track: main };
    return null;
  },
  split() {
    const s = this.splitTarget();
    if (!s) return;
    const c2 = this.splitAt(s.clip, s.track, store.time);
    store.packMain();
    store.select(c2.id);
    store.commit('split');
  },
  // Разрезать клип c дорожки tr в момент таймлайна t; возвращает правую часть (встаёт сразу после c)
  splitAt(c, tr, t) {
    const c2 = deep(c);
    c2.id = uid();
    const cut = srcAt(c, t - c.start);
    if (hasCurve(c)) { c2.curve = curveRange(c.curve, c.in, c.out, cut, c.out); c.curve = curveRange(c.curve, c.in, c.out, c.in, cut); }
    c.out = cut;
    c2.in = cut;
    c2.start = t;
    c2.trans = null;
    if (c2.kind === 'image' || c2.kind === 'text' || c2.kind === 'effect') { c2.out -= c2.in; shiftKeys(c2, -c2.in); c2.in = 0; }
    if (c.anim) { c.anim.out = 'none'; c2.anim.in = 'none'; }
    c.fadeOut = 0; c2.fadeIn = 0;
    tr.clips.splice(tr.clips.indexOf(c) + 1, 0, c2);
    return c2;
  },
  trimTo(side) {
    const s = this.splitTarget();
    if (!s) return;
    const { clip: c, track: tr } = s;
    const t = store.time;
    const cut = srcAt(c, t - c.start);
    if (hasCurve(c)) c.curve = side === 'l' ? curveRange(c.curve, c.in, c.out, cut, c.out) : curveRange(c.curve, c.in, c.out, c.in, cut);
    if (side === 'l') {
      if (c.kind === 'image' || c.kind === 'text' || c.kind === 'effect') { c.out -= (t - c.start); shiftKeys(c, -(t - c.start)); } else c.in = cut;
      if (!tr.main || !store.magnet) c.start = t;
    } else {
      c.out = cut;
    }
    store.packMain();
    if (tr.main && store.magnet && side === 'l') store.setTime(c.start);
    store.commit('trim');
  },
  deleteSel() {
    const s = store.selected();
    if (!s) return;
    store.removeClip(s.clip.id);
    store.commit('delete');
  },
  duplicate() {
    const s = store.selected();
    if (!s) return;
    const c2 = deep(s.clip);
    c2.id = uid();
    if (s.track.main && store.magnet) {
      const mc = s.track.clips;
      mc.splice(mc.indexOf(s.clip) + 1, 0, c2);
      store.packMain();
    } else {
      c2.start = clipEnd(s.clip);
      if (this.fits(s.track, c2, c2.start, clipDur(c2))) { s.track.clips.push(c2); s.track.clips.sort((a, b) => a.start - b.start); }
      else store.place(c2, s.track.kind);
    }
    store.select(c2.id);
    store.commit('duplicate');
  },
  detachAudio() {
    const s = store.selected();
    if (!s || s.clip.kind !== 'video') return;
    const c = s.clip;
    const a = normalizeClip({ id: uid(), kind: 'audio', mediaId: c.mediaId, start: c.start, in: c.in, out: c.out, speed: c.speed, curve: c.curve ? deep(c.curve) : undefined, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, voiceMode: c.voiceMode, voiceFx: c.voiceFx });
    store.place(a, 'audio');
    c.muted = true;
    store.commit('detach');
    toast('Аудио отделено на отдельную дорожку', 'ok');
  },
  async freeze() {
    const s = store.selected();
    if (!s || s.clip.kind !== 'video') return;
    const c = s.clip, m = store.media(c.mediaId);
    const t = clamp(store.time, c.start, clipEnd(c) - this.frame());
    const src = srcAt(c, t - c.start);
    try {
      const file = await window.api.frame(m.path, src, store.p.id);
      const [im] = await Media.importPaths([file]);
      if (!im) return;
      im.frame = true;
      const fc = makeMediaClip(im, t);
      fc.out = 3;
      fc.transform = deep(c.transform); fc.opacity = c.opacity; fc.adjust = deep(c.adjust); fc.filter = deep(c.filter); fc.flipH = c.flipH; fc.flipV = c.flipV;
      const tr = s.track;
      // разрезаем и вставляем стоп-кадр
      if (t > c.start + this.frame() / 2) {
        const c2 = deep(c); c2.id = uid();
        if (hasCurve(c)) { c2.curve = curveRange(c.curve, c.in, c.out, src, c.out); c.curve = curveRange(c.curve, c.in, c.out, c.in, src); }
        c.out = src; c2.in = src; c2.start = t + 3; c2.trans = null;
        if (c.anim) { c.anim.out = 'none'; c2.anim.in = 'none'; }
        tr.clips.splice(tr.clips.indexOf(c) + 1, 0, fc, c2);
        if (!tr.main || !store.magnet) for (const o of tr.clips) if (o !== c2 && o !== fc && o.start >= t + 1e-6 && o !== c) o.start += 3;
      } else {
        tr.clips.splice(tr.clips.indexOf(c), 0, fc);
        if (!tr.main || !store.magnet) for (const o of tr.clips) if (o !== fc && o.start >= t - 1e-6) o.start += 3;
      }
      fc.start = t;
      store.packMain();
      store.select(fc.id);
      store.commit('freeze');
    } catch (e) { toast('Не удалось сделать стоп-кадр', 'error'); }
  },

  // ---------------------------------------------------------------- замена клипа
  // Новое медиа встаёт на место клипа: длина, эффекты, цвет, маска, анимации и ключевые кадры сохраняются
  canReplace(c) { return !!c && (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio'); },
  replaceClip(c, m) {
    const f = store.find(c.id);
    if (!f || !m) return;
    if (c.kind === 'audio' ? !m.hasAudio : m.type === 'audio') { toast(c.kind === 'audio' ? 'В файле нет звука' : 'Видео или фото нельзя заменить звуком', 'error'); return; }
    const D = clipDur(c), need = c.out - c.in;
    const toLt = (s) => ltAt(c, s);
    const lks = (c.keys || []).map(k => ({ ...k, lt: toLt(k.s) })), lvk = (c.vkeys || []).map(k => ({ ...k, lt: toLt(k.s) }));
    let short = false;
    if (m.type === 'image') {
      c.kind = 'image'; c.in = 0; c.out = D; c.speed = 1; delete c.curve;
      delete c.voiceMode; delete c.voiceFx; delete c.denoise;
    } else {
      if (c.kind === 'image') { c.kind = m.type === 'audio' ? 'audio' : 'video'; c.speed = 1; c.in = 0; c.out = Math.min(m.duration, D); short = m.duration < D - 1e-3; }
      else {
        // берём тот же кусок, если он есть в новом файле; иначе — с начала
        const a = c.in + need <= m.duration + 1e-3 ? c.in : Math.max(0, m.duration - need);
        c.out = Math.min(m.duration, a + need); c.in = a;
        short = m.duration < need - 1e-3;
        if (hasCurve(c) && short) delete c.curve;
      }
    }
    c.mediaId = m.id; c.name = m.name;
    if (!m.hasAudio) { delete c.voiceMode; delete c.voiceFx; delete c.denoise; }
    // ключевые кадры остаются на тех же местах клипа
    if (lks.length) c.keys = lks.map(({ lt, ...k }) => ({ ...k, s: srcAt(c, Math.min(lt, clipDur(c))) }));
    if (lvk.length) c.vkeys = lvk.map(({ lt, ...k }) => ({ ...k, s: srcAt(c, Math.min(lt, clipDur(c))) }));
    Player.dropEl(c.id);
    if (f.track.main) store.packMain();
    else if (!this.fits(f.track, c, c.start, clipDur(c))) { f.track.clips.splice(f.track.clips.indexOf(c), 1); store.place(c, this.trackKindOf(c)); }
    store.cleanupTracks();
    store.commit('replace');
    Player.requestRender();
    toast(short ? `Заменено. Файл короче — клип стал ${fmtSec(clipDur(c))}` : 'Клип заменён', short ? 'info' : 'ok', 2600);
  },
  replaceDialog(c) {
    if (!this.canReplace(c)) return;
    const list = store.p.media.filter(m => !m.frame && m.id !== c.mediaId && (c.kind === 'audio' ? m.hasAudio : m.type !== 'audio'));
    const body = h(`<div class="replace-pick">
      <p class="muted small">Новый файл встанет на место клипа. Сохранятся длина, эффекты, цвет, маска, анимации и ключевые кадры.</p>
      <div class="media-grid rp-grid">${list.map(m => {
        const a = assets[m.id] || {};
        const th = m.type === 'audio' ? `<div class="mc-audio">${icon('music')}</div>` : a.poster ? `<img src="${a.poster}" draggable="false">` : '<div class="mc-loading"></div>';
        return `<div class="media-card" data-id="${m.id}"><div class="mc-thumb">${th}${m.type !== 'image' ? `<span class="mc-dur">${fmtDur(m.duration)}</span>` : ''}</div><div class="mc-name">${esc(m.name)}</div></div>`;
      }).join('')}</div>
      ${list.length ? '' : '<div class="muted small rp-empty">В медиатеке нет других подходящих файлов.</div>'}
    </div>`);
    let dlg = null;
    $('.rp-grid', body).onclick = (e) => {
      const card = e.target.closest('.media-card'); if (!card) return;
      dlg.close(); this.replaceClip(c, store.media(card.dataset.id));
    };
    dlg = modal({ title: 'Заменить клип', body, width: 620, buttons: [
      { label: 'Отмена' },
      { label: 'Выбрать файл…', primary: true, onClick: async (close) => {
        close();
        const paths = await window.api.openMedia();
        if (!paths.length) return;
        const [m] = await Media.importPaths([paths[0]]);
        if (m) this.replaceClip(c, m);
        return false;
      } },
    ] });
  },

  clipMenu(x, y) {
    const s = store.selected();
    if (!s) return;
    const c = s.clip;
    const items = [
      { label: 'Разделить', icon: 'split', key: Edit.K('split'), disabled: !this.splitTarget(), onClick: () => this.split() },
      { label: 'Дублировать', icon: 'copy', key: 'Ctrl+D', onClick: () => this.duplicate() },
    ];
    if (c.kind === 'video') {
      items.push({ label: 'Отделить аудио', icon: 'unlink', disabled: !hasAudioTrack(c) || c.muted, onClick: () => this.detachAudio() });
      items.push({ label: 'Стоп-кадр', icon: 'snow', onClick: () => this.freeze() });
      items.push({ label: Stab.on(c) ? 'Выключить стабилизацию' : 'Стабилизировать', icon: 'stabilize', onClick: () => Stab.on(c) ? Stab.cancel(c) : Stab.set([c], true) });
    }
    if (c.kind !== 'text' && hasAudioTrack(c)) items.push({ label: c.muted ? 'Включить звук' : 'Выключить звук', icon: c.muted ? 'volume' : 'volumeX', onClick: () => { c.muted = !c.muted; store.commit('mute'); } });
    if (VoiceSep.canUse(c)) {
      items.push('-');
      for (const [mode, v] of Object.entries(VOICE_MODES)) items.push({ label: v.label, icon: v.icon, checked: c.voiceMode === mode, onClick: () => VoiceSep.set([c], c.voiceMode === mode ? null : mode) });
      if (c.voiceMode) items.push({ label: 'Вернуть исходный звук', icon: 'volume', onClick: () => VoiceSep.set([c], null) });
      items.push({ label: c.voiceFx ? 'Голос: ' + (VOICE_FX_BY_ID[c.voiceFx] || { name: '?' }).name + '…' : 'Изменить голос…', icon: 'micStage', onClick: () => Inspector.showVoiceFx(c) });
    }
    items.push('-');
    if (this.canReplace(c)) items.push({ label: 'Заменить клип…', icon: 'replace', onClick: () => this.replaceDialog(c) });
    items.push({ label: 'Копировать атрибуты', icon: 'copy', key: 'Ctrl+Alt+C', onClick: () => App.copyAttrs() });
    items.push({ label: 'Вставить атрибуты…', icon: 'pasteAttr', key: 'Ctrl+Alt+V', disabled: !App.attrs, onClick: () => App.pasteAttrs() });
    if (c.mediaId) items.push({ label: 'Показать в папке', icon: 'folder', onClick: () => window.api.showItem(store.media(c.mediaId).path) });
    items.push({ label: c.disabled ? 'Включить клип' : 'Отключить клип', icon: 'prohibit', key: 'Shift+E', onClick: () => Edit.toggleEnabled() });
    if (c.kind !== 'text' && c.kind !== 'image') items.push({ label: 'Скорость и длительность…', icon: 'speed', key: 'Ctrl+R', onClick: () => Edit.speedDialog() });
    items.push({ label: 'Отметить клип (вход/выход)', icon: 'brackets', key: 'X', onClick: () => Edit.markClip() });
    items.push('-', { label: 'Удалить', icon: 'trash', key: 'Del', danger: true, onClick: () => this.deleteSel() });
    items.push({ label: 'Удалить со сдвигом', icon: 'trash', key: 'Shift+Del', danger: true, onClick: () => Edit.rippleDelete() });
    showMenu(x, y, items);
  },
};
