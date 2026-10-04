// Монтаж как в Premiere Pro: инструменты таймлайна, точки входа/выхода (In/Out), Lift/Extract,
// ripple-операции со сдвигом всех дорожек, отключение клипов, J/K/L, раскладки горячих клавиш.
// Заблокированные дорожки (замок) в ripple-операциях не участвуют — как sync lock в Premiere.
const TOOLS = [
  { id: 'select', name: 'Выделение', icon: 'toolSelect', keys: { lincut: 'V', premiere: 'V' }, hint: 'Выбор, перемещение и обрезка клипов' },
  { id: 'razor', name: 'Лезвие', icon: 'toolRazor', keys: { lincut: 'C', premiere: 'C' }, hint: 'Щелчок по клипу — разрезать. Shift — на всех дорожках' },
  { id: 'ripple', name: 'Обрезка со сдвигом', icon: 'toolRipple', keys: { lincut: 'Shift+B', premiere: 'B' }, hint: 'Тяните край клипа — всё, что правее, сдвигается следом' },
  { id: 'roll', name: 'Сдвиг склейки', icon: 'toolRoll', keys: { lincut: 'Shift+N', premiere: 'N' }, hint: 'Тяните стык двух клипов — один удлиняется, другой укорачивается' },
  { id: 'stretch', name: 'Растяжение скорости', icon: 'toolStretch', keys: { lincut: 'Shift+R', premiere: 'R' }, hint: 'Тяните край клипа — меняется скорость, а не обрезка' },
  { id: 'slip', name: 'Сдвиг содержимого', icon: 'toolSlip', keys: { lincut: 'Y', premiere: 'Y' }, hint: 'Тяните клип — меняется кусок источника, место и длина остаются' },
  { id: 'slide', name: 'Сдвиг клипа', icon: 'toolSlide', keys: { lincut: 'U', premiere: 'U' }, hint: 'Тяните клип — соседи подрезаются, общая длина не меняется' },
  { id: 'hand', name: 'Рука', icon: 'toolHand', keys: { lincut: 'H', premiere: 'H' }, hint: 'Прокрутка таймлайна' },
];
const TOOL_BY_ID = Object.fromEntries(TOOLS.map(t => [t.id, t]));
const KEYMAPS = [
  { id: 'lincut', name: 'LinCut' },
  { id: 'premiere', name: 'Premiere Pro' },
];
const EDGE_PX = 7;
const UNBOUNDED = (c) => c.kind === 'image' || c.kind === 'text' || c.kind === 'effect';

const Edit = {
  tool: 'select',

  init() {
    try { this.keymap = localStorage.getItem('lc.keys') === 'premiere' ? 'premiere' : 'lincut'; } catch { this.keymap = 'lincut'; }
    const box = $('#tlToolsBox');
    box.innerHTML = TOOLS.map(t => `<button class="icon-btn tool-btn" data-tool="${t.id}">${icon(t.icon)}</button>`).join('');
    box.onclick = (e) => { const b = e.target.closest('[data-tool]'); if (b) this.setTool(b.dataset.tool); };
    this.updateToolTips();
    this.setTool('select');
    bus.on('project', () => this.renderRange());
    bus.on('io', () => this.renderRange());
  },
  updateToolTips() {
    for (const b of $$('#tlToolsBox [data-tool]')) {
      const t = TOOL_BY_ID[b.dataset.tool];
      setTip(b, `${t.name}. ${t.hint} (${t.keys[this.keymap]})`);
    }
  },
  setTool(id) {
    if (!TOOL_BY_ID[id]) return;
    this.tool = id;
    $$('#tlToolsBox [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === id));
    const tr = $('#tlTracks');
    if (tr) tr.dataset.tool = id;
    Timeline.hideCut();
  },
  setKeymap(id) {
    this.keymap = id;
    try { localStorage.setItem('lc.keys', id); } catch { }
    this.updateToolTips();
    App.updateTips();
    toast('Горячие клавиши: ' + KEYMAPS.find(k => k.id === id).name, 'ok', 1600);
  },
  // подписи клавиш, которые различаются в раскладках
  K(name) {
    const P = this.keymap === 'premiere';
    return ({
      split: P ? 'Ctrl+K' : 'Ctrl+B', splitAll: P ? 'Ctrl+Shift+K' : 'Ctrl+Shift+B', marker: P ? 'M' : 'B', magnet: P ? 'Shift+M' : 'M',
      snap: P ? 'S' : 'N', voice: P ? 'Shift+R' : 'R', keyframe: P ? 'Shift+K' : 'K',
    })[name];
  },

  // ---------------------------------------------------------------- клавиши
  // Вызывается из App.bindKeys до общих клавиш; true — клавиша обработана
  key(e) {
    const ctrl = e.ctrlKey || e.metaKey, code = e.code, sh = e.shiftKey, alt = e.altKey, P = this.keymap === 'premiere';
    const plain = !ctrl && !alt;
    // инструменты
    if (plain) {
      for (const t of TOOLS) {
        const k = t.keys[this.keymap], wantShift = k.startsWith('Shift+'), letter = k.replace('Shift+', '');
        if (code === 'Key' + letter && sh === wantShift) { this.setTool(t.id); return true; }
      }
    }
    // раскладка Premiere: свои места для маркера, привязки, озвучки, ключевого кадра
    if (P) {
      if (plain && !sh && code === 'KeyM') { Timeline.addMarker(); return true; }
      if (plain && sh && code === 'KeyM') { $('#tMagnet').click(); return true; }
      if (plain && !sh && code === 'KeyS') { $('#tSnap').click(); return true; }
      if (plain && sh && code === 'KeyR') { Voiceover.open(); return true; }
      if (plain && !sh && code === 'KeyK') { this.shuttle(0); return true; }
      if (plain && sh && code === 'KeyK') { App.toggleKeyframe(); return true; }
      if (ctrl && !sh && code === 'KeyK') { Timeline.split(); return true; }
      if (ctrl && sh && code === 'KeyK') { this.splitAll(); return true; }
    } else if (ctrl && sh && code === 'KeyB') { this.splitAll(); return true; }
    // J / L — челнок (K — стоп в раскладке Premiere; в LinCut K — ключевой кадр)
    if (plain && !sh && code === 'KeyJ') { this.shuttle(-1); return true; }
    if (plain && !sh && code === 'KeyL') { this.shuttle(1); return true; }
    // точки входа и выхода
    if (plain && code === 'KeyI') { sh ? this.goIO('a') : this.markIO('a'); return true; }
    if (plain && code === 'KeyO') { sh ? this.goIO('b') : this.markIO('b'); return true; }
    if (plain && !sh && code === 'KeyX') { this.markClip(); return true; }
    if (ctrl && sh && code === 'KeyX') { this.clearIO(); return true; }
    if (ctrl && sh && code === 'KeyI') { this.clearIO('a'); return true; }
    if (ctrl && sh && code === 'KeyO') { this.clearIO('b'); return true; }
    if (plain && !sh && code === 'Semicolon') { this.lift(); return true; }
    if (plain && !sh && code === 'Quote') { this.extract(); return true; }
    if (ctrl && sh && code === 'Space') { this.playIO(); return true; }
    // правка
    if (!ctrl && !alt && sh && (code === 'Delete' || code === 'Backspace')) { this.rippleDelete(); return true; }
    if (plain && sh && code === 'KeyE') { this.toggleEnabled(); return true; }
    if (plain && !sh && code === 'KeyD') { this.selectAtPlayhead(); return true; }
    if (ctrl && !sh && code === 'KeyR') { this.speedDialog(); return true; }
    if (alt && !ctrl && (code === 'ArrowLeft' || code === 'ArrowRight')) { this.nudge((code === 'ArrowLeft' ? -1 : 1) * (sh ? 5 : 1)); return true; }
    return false;
  },

  // ---------------------------------------------------------------- J / K / L
  // Скорости челнока: ±1, 2, 4, 8. Назад — покадровая перемотка без звука (как в Premiere на длинных GOP)
  shuttle(dir) {
    if (!store.p) return;
    if (dir === 0) { if (Player.playing) Player.pause(); return; }
    let r = Player.playing ? Player.rate : 0;
    r = Math.sign(r) === dir ? clamp(Math.abs(r) * 2, 1, 8) * dir : dir;
    if (!Player.playing) Player.play(r); else Player.setRate(r);
  },

  // ---------------------------------------------------------------- In / Out
  io() { return store.p && store.p.io ? store.p.io : null; },
  range() {
    const io = this.io();
    if (!io || (io.a == null && io.b == null)) return null;
    const a = io.a ?? 0, b = io.b ?? store.duration();
    return b - a > 1e-3 ? { a, b } : null;
  },
  frameT(t) { return Math.round(t * store.p.fps) / store.p.fps; },
  markIO(which, t = store.time) {
    if (!store.p) return;
    const io = store.p.io = store.p.io || {};
    io[which] = this.frameT(t);
    // вход после выхода (и наоборот) — сбрасываем другую точку, как в Premiere
    if (io.a != null && io.b != null && io.b <= io.a) delete io[which === 'a' ? 'b' : 'a'];
    store.dirty = true; bus.emit('io'); bus.emit('changed');
  },
  clearIO(which) {
    if (!store.p || !store.p.io) return;
    if (which) delete store.p.io[which]; else delete store.p.io;
    store.dirty = true; bus.emit('io'); bus.emit('changed');
  },
  goIO(which) {
    const io = this.io();
    if (!io || io[which] == null) return;
    if (Player.playing) Player.pause();
    store.setTime(io[which]); Timeline.ensureVisible(io[which]);
  },
  markClip() {
    const s = store.selected() || this.clipAtPlayhead();
    if (!s) return;
    store.p.io = { a: this.frameT(s.clip.start), b: this.frameT(clipEnd(s.clip)) };
    store.dirty = true; bus.emit('io'); bus.emit('changed');
  },
  playIO() {
    const r = this.range();
    if (!r) { toast('Сначала поставьте точки входа (I) и выхода (O)', 'info'); return; }
    if (Player.playing) Player.pause();
    store.setTime(r.a);
    Player.play();
    Player.stopAt = r.b;
  },
  renderRange(noRuler) {
    const el = $('#tlRange');
    if (!el || !store.p) return;
    const r = this.range(), io = this.io();
    el.classList.toggle('hidden', !r);
    if (r) {
      el.style.transform = `translateX(${HEAD_W + r.a * Timeline.pps}px)`;
      el.style.width = Math.max(1, (r.b - r.a) * Timeline.pps) + 'px';
      el.classList.toggle('open-a', io.a == null);
      el.classList.toggle('open-b', io.b == null);
      el.title = `Вход ${fmtTC(r.a, store.p.fps)} · Выход ${fmtTC(r.b, store.p.fps)} · ${fmtSec(r.b - r.a)}`;
    }
    if (!noRuler) Timeline.drawRuler();
  },

  // ---------------------------------------------------------------- ripple
  // Дорожки, которые участвуют в правке (без замка). Главная с авто-склейкой сдвигается сама (packMain)
  editTracks() { return store.p.tracks.filter(t => !t.locked); },
  // Закрыть пробел [a, b]: всё, что начинается не раньше b, сдвигается влево на всех незаблокированных дорожках.
  // Если на какой-то дорожке мешает клип — сдвигаем, сколько можно везде одинаково (синхронность важнее)
  closeGap(a, b, skipMain) {
    const eps = 1e-4, want = b - a;
    let can = want;
    const moves = [];
    for (const tr of this.editTracks()) {
      if (tr.main && store.magnet) continue;
      if (skipMain && tr.main) continue;
      const F = tr.clips.filter(c => c.start >= b - eps);
      if (!F.length) continue;
      const block = Math.max(0, ...tr.clips.filter(c => c.start < b - eps).map(clipEnd));
      can = Math.min(can, Math.min(...F.map(c => c.start)) - Math.max(a, block));
      moves.push(...F);
    }
    can = Math.max(0, can);
    for (const c of moves) c.start = Math.max(0, c.start - can);
    store.packMain();
    return can;
  },
  // сдвиг всего, что правее точки P, на d (для обрезки со сдвигом); followers запоминаются в начале перетаскивания
  followers(P, except, exceptTrack) {
    const eps = 1e-4, out = [];
    let maxShrink = Infinity;
    for (const tr of this.editTracks()) {
      if (tr.main && store.magnet) continue;
      const F = tr.clips.filter(c => c !== except && c.start >= P - eps);
      if (!F.length) continue;
      const block = Math.max(0, ...tr.clips.filter(c => c !== except && c.start < P - eps).map(clipEnd));
      if (tr !== exceptTrack) maxShrink = Math.min(maxShrink, Math.min(...F.map(c => c.start)) - block);
      for (const c of F) out.push({ c, s0: c.start });
    }
    return { list: out, maxShrink };
  },

  rippleDelete() {
    const s = store.selected();
    if (!s) return;
    if (s.track.locked) { toast('Дорожка заблокирована', 'info'); return; }
    const a = s.clip.start, b = clipEnd(s.clip);
    store.removeClip(s.clip.id);
    const got = this.closeGap(a, b);
    store.cleanupTracks();
    store.commit('ripple-delete');
    if (got < b - a - 1e-3 && !(s.track.main && store.magnet)) toast('Пробел закрыт не полностью: мешает клип на другой дорожке', 'info', 2600);
  },
  // пробел между клипами на дорожке под точкой t
  gapAt(tr, t) {
    if (tr.main && store.magnet) return null;
    let a = 0, b = Infinity;
    for (const c of tr.clips) {
      if (t >= c.start && t < clipEnd(c)) return null;
      if (clipEnd(c) <= t) a = Math.max(a, clipEnd(c));
      if (c.start > t) b = Math.min(b, c.start);
    }
    return b < Infinity && b - a > 1e-3 ? { a, b } : null;
  },
  deleteGap(g) {
    const got = this.closeGap(g.a, g.b);
    store.commit('ripple-gap');
    if (got < g.b - g.a - 1e-3) toast(got > 1e-3 ? 'Пробел закрыт не полностью: мешает клип на другой дорожке' : 'Нельзя закрыть пробел: мешает клип на другой дорожке', 'info', 2600);
  },

  // Убрать содержимое между In и Out на всех незаблокированных дорожках. ripple — со сдвигом (Extract), иначе пробел (Lift)
  removeRange(ripple) {
    const r = this.range();
    if (!r) { toast('Поставьте точки входа (I) и выхода (O)', 'info'); return; }
    const { a, b } = r, eps = 1e-4;
    const main = store.mainTrack();
    let touched = false;
    if (!ripple && store.magnet && !main.locked && main.clips.some(c => c.start < b - eps && clipEnd(c) > a + eps)) {
      // на главной дорожке с авто-склейкой пробел сразу бы закрылся — выключаем её, как в Premiere
      store.magnet = false;
      Timeline.updateToolbar();
      toast('Авто-склейка выключена, чтобы на главной дорожке остался пробел', 'info', 2800);
    }
    for (const tr of this.editTracks()) {
      for (const c of [...tr.clips]) {
        if (clipEnd(c) <= a + eps || c.start >= b - eps) continue;
        let mid = c;
        if (c.start < a - eps) mid = Timeline.splitAt(c, tr, a);
        if (clipEnd(mid) > b + eps) Timeline.splitAt(mid, tr, b);
        tr.clips.splice(tr.clips.indexOf(mid), 1);
        if (store.sel === mid.id) store.sel = null;
        touched = true;
      }
    }
    if (!touched) { toast('Между входом и выходом пусто', 'info'); return; }
    if (ripple) this.closeGap(a, b);
    store.packMain();
    store.cleanupTracks();
    if (ripple) { store.p.io = { a }; store.setTime(a); }
    bus.emit('selection');
    store.commit(ripple ? 'extract' : 'lift');
    bus.emit('io');
  },
  lift() { this.removeRange(false); },
  extract() { this.removeRange(true); },

  // разрезать все клипы под курсором на всех незаблокированных дорожках
  splitAll(t = store.time) {
    const f = Timeline.frame() / 2;
    let n = 0;
    for (const tr of this.editTracks()) for (const c of [...tr.clips]) {
      if (t > c.start + f && t < clipEnd(c) - f) { Timeline.splitAt(c, tr, t); n++; }
    }
    if (!n) return;
    store.packMain();
    store.commit('split-all');
  },

  // ---------------------------------------------------------------- клипы
  clipAtPlayhead() {
    const t = store.time;
    for (const tr of store.p.tracks) for (const c of tr.clips) if (t >= c.start && t < clipEnd(c) && isVisual(c)) return { clip: c, track: tr };
    for (const tr of store.p.tracks) for (const c of tr.clips) if (t >= c.start && t < clipEnd(c)) return { clip: c, track: tr };
    return null;
  },
  selectAtPlayhead() { const s = this.clipAtPlayhead(); if (s) store.select(s.clip.id); },
  toggleEnabled() {
    const s = store.selected();
    if (!s) return;
    if (s.clip.disabled) delete s.clip.disabled; else s.clip.disabled = true;
    store.commit('enable');
    Player.requestRender();
    toast(s.clip.disabled ? 'Клип отключён' : 'Клип включён', 'info', 1200);
  },
  // сдвиг выделенного клипа на n кадров (Alt+← / →)
  nudge(n) {
    const s = store.selected();
    if (!s || s.track.locked) return;
    const { clip: c, track: tr } = s, d = n / store.p.fps;
    if (tr.main && store.magnet) {
      // на главной дорожке с авто-склейкой — меняем местами с соседом
      const i = tr.clips.indexOf(c), j = i + Math.sign(n);
      if (j < 0 || j >= tr.clips.length) return;
      tr.clips.splice(i, 1); tr.clips.splice(j, 0, c);
      let x = 0; for (const k of tr.clips) { k.start = x; x += clipDur(k); }
      store.packMain();
    } else {
      let st = Math.max(0, c.start + d);
      const others = tr.clips.filter(x => x !== c);
      const prevEnd = Math.max(0, ...others.filter(x => clipEnd(x) <= c.start + 1e-6).map(clipEnd));
      const nextStart = Math.min(Infinity, ...others.filter(x => x.start >= clipEnd(c) - 1e-6).map(x => x.start));
      st = clamp(st, prevEnd, nextStart - clipDur(c));
      if (Math.abs(st - c.start) < 1e-6) return;
      c.start = this.frameT(st);
      tr.clips.sort((a, b) => a.start - b.start);
    }
    store.commit('nudge');
    Player.requestRender();
  },

  // Скорость и длительность (Ctrl+R)
  speedDialog() {
    const s = store.selected();
    if (!s) return;
    const { clip: c, track: tr } = s;
    if (!(c.kind === 'video' || c.kind === 'audio' || UNBOUNDED(c))) return;
    const fps = store.p.fps, timed = !UNBOUNDED(c), curved = hasCurve(c);
    const body = h(`<div class="speed-dlg">
      ${timed ? `<div class="ex-row"><label>Скорость</label><div class="num-unit"><input class="text-input sd-speed" inputmode="decimal"><span>%</span></div></div>` : ''}
      <div class="ex-row"><label>Длительность</label><div class="num-unit"><input class="text-input sd-dur" spellcheck="false"><span class="muted">ЧЧ:ММ:СС:КК</span></div></div>
      ${tr.main && store.magnet ? '' : `<label class="check"><input type="checkbox" class="sd-ripple" checked><span></span>Сдвинуть следующие клипы</label>`}
      ${curved ? '<p class="muted small">У клипа кривая скорости — она ускорится или замедлится целиком.</p>' : ''}
    </div>`);
    const sp = $('.sd-speed', body), du = $('.sd-dur', body), rp = $('.sd-ripple', body);
    const D0 = clipDur(c), base = curved ? 1 : c.speed;
    let k = 1; // во сколько раз ускоряем
    const show = (from) => {
      if (sp && from !== 'sp') sp.value = String(Math.round(base * k * 1000) / 10);
      if (from !== 'du') du.value = fmtTC(D0 / k, fps);
    };
    show();
    if (sp) sp.addEventListener('input', () => { const v = parseFloat(sp.value.replace(',', '.')); if (v > 0) { k = clamp(v / 100, 0.1, 10) / base; show('sp'); } });
    du.addEventListener('input', () => { const t = parseTC(du.value, fps); if (t > 0) { k = timed ? clamp(D0 / t, 0.1 / base, 10 / base) : D0 / t; show('du'); } });
    modal({ title: 'Скорость и длительность', body, width: 400, buttons: [{ label: 'Отмена' }, { label: 'OK', primary: true, onClick: () => {
      if (Math.abs(k - 1) < 1e-6) return;
      const end0 = clipEnd(c);
      if (!timed) { c.out = c.in + D0 / k; }
      else if (curved) c.curve.pts = c.curve.pts.map(([u, v]) => [u, clamp(Math.round(v * k * 1000) / 1000, 0.1, 10)]);
      else c.speed = clamp(Math.round(c.speed * k * 1e4) / 1e4, 0.1, 10);
      const delta = clipEnd(c) - end0;
      if (tr.main && store.magnet) store.packMain();
      else if (rp && rp.checked) {
        if (delta > 0) for (const t of this.editTracks()) { if (t.main && store.magnet) continue; for (const o of t.clips) if (o !== c && o.start >= end0 - 1e-4) o.start += delta; }
        else this.closeGap(end0 + delta, end0);
        store.packMain();
      } else if (!Timeline.fits(tr, c, c.start, clipDur(c))) {
        // не влезает до следующего клипа — урезаем длительность по месту
        const next = Math.min(...tr.clips.filter(o => o !== c && o.start >= c.start).map(o => o.start));
        if (!timed) c.out = c.in + (next - c.start);
        else { const f = clipDur(c) / (next - c.start); if (curved) c.curve.pts = c.curve.pts.map(([u, v]) => [u, clamp(v * f, 0.1, 10)]); else c.speed = clamp(Math.round(c.speed * f * 1e4) / 1e4, 0.1, 10); }
        toast('Клип упёрся в следующий — длительность ограничена', 'info');
      }
      if (c.anim) { const d = clipDur(c); c.anim.inDur = Math.min(c.anim.inDur, d); c.anim.outDur = Math.min(c.anim.outDur, d); }
      store.commit('speed-duration');
      Player.requestRender(); Inspector.render();
    } }] });
    setTimeout(() => { const f = sp || du; f.focus(); f.select(); }, 50);
  },

  // ---------------------------------------------------------------- инструменты на клипах
  snapshot(c) { return { in: c.in, out: c.out, speed: c.speed, curve: c.curve ? deep(c.curve) : null, start: c.start }; },
  // Край клипа на dt секунд таймлайна от исходного состояния O. Возвращает, на сколько изменилась длина
  // (для правого края — прирост, для левого — сколько срезано)
  edgeTrim(c, O, side, dt) {
    const D0 = clipDur(O), unb = UNBOUNDED(c);
    const m = c.mediaId ? store.media(c.mediaId) : null;
    const maxOut = unb ? Infinity : (m ? m.duration : Infinity);
    const minLen = Timeline.frame() * Math.max(rateAt(O, 0), rateAt(O, D0));
    if (side === 'r') { c.in = O.in; c.out = clamp(srcAtExt(O, D0 + dt), O.in + minLen, maxOut); }
    else {
      let nin = srcAtExt(O, dt);
      if (!unb) nin = Math.max(0, nin);
      c.in = Math.min(nin, O.out - minLen); c.out = O.out;
    }
    if (O.curve) c.curve = curveRange(O.curve, O.in, O.out, c.in, c.out);
    const D = clipDur(c);
    return side === 'r' ? D - D0 : D0 - D;
  },
  // у картинок, текста и эффектов источник начинается с нуля
  normalize(c) {
    if (UNBOUNDED(c) && c.in !== 0) { c.out -= c.in; shiftKeys(c, -c.in); c.in = 0; }
    if (c.anim) { const d = clipDur(c); c.anim.inDur = Math.min(c.anim.inDur, d); c.anim.outDur = Math.min(c.anim.outDur, d); }
  },
  // край клипа под курсором — по модели, а не по элементу (после правки элементы ещё доезжают анимацией)
  edgeSide(e, c) {
    const x = (Timeline.timeAt(e.clientX) - c.start) * Timeline.pps, w = clipDur(c) * Timeline.pps;
    const k = Math.min(EDGE_PX, w / 3);
    if (x <= k) return 'l';
    if (w - x <= k) return 'r';
    return null;
  },
  // соседний клип вплотную (на главной с авто-склейкой — просто соседний по порядку)
  neighbor(tr, c, side) {
    const i = tr.clips.indexOf(c);
    const n = side === 'l' ? tr.clips[i - 1] : tr.clips[i + 1];
    if (!n) return null;
    if (tr.main && store.magnet) return n;
    const f = Timeline.frame() / 2;
    return side === 'l' ? (Math.abs(clipEnd(n) - c.start) < f ? n : null) : (Math.abs(n.start - clipEnd(c)) < f ? n : null);
  },
  tip(ev, text) {
    if (!this.tipEl) { this.tipEl = h('<div class="tl-tip"></div>'); document.body.appendChild(this.tipEl); }
    this.tipEl.textContent = text;
    this.tipEl.style.left = ev.clientX + 12 + 'px';
    this.tipEl.style.top = ev.clientY - 30 + 'px';
  },
  tipOff() { if (this.tipEl) { this.tipEl.remove(); this.tipEl = null; } },
  snapEdge(t, ids, ev) {
    if (!store.snap || ev.altKey) { Timeline.showSnap(null); return t; }
    const s = Timeline.snapPoint(t, ids, 8 / Timeline.pps);
    Timeline.showSnap(s);
    return s != null ? s : t;
  },

  // Нажатие на клип инструментом, отличным от «Выделения». true — обработано
  clipDown(e, f, el) {
    const tool = this.tool, { clip: c, track: tr } = f;
    if (tool === 'select') return false;
    if (tool === 'hand') { this.pan(e); return true; }
    if (tool === 'razor') { this.razor(e, c, tr); return true; }
    store.select(c.id);
    if (tr.locked) return true;
    const side = this.edgeSide(e, c);
    if (tool === 'ripple') { if (side) this.rippleTrim(e, c, tr, side); else Timeline.startMove(e, c, tr); return true; }
    if (tool === 'stretch') { if (side) this.stretch(e, c, tr, side); else Timeline.startMove(e, c, tr); return true; }
    if (tool === 'roll') {
      if (!side) { Timeline.startMove(e, c, tr); return true; }
      const n = this.neighbor(tr, c, side);
      if (!n) { Timeline.startTrim(e, c, tr, side); return true; }
      if (side === 'r') this.roll(e, c, n, tr); else this.roll(e, n, c, tr);
      return true;
    }
    if (tool === 'slip') { this.slip(e, c, tr); return true; }
    if (tool === 'slide') { this.slide(e, c, tr); return true; }
    return false;
  },

  pan(e) {
    const sc = Timeline.scroll, l0 = sc.scrollLeft, t0 = sc.scrollTop;
    dragMove(e, (ev, dx, dy) => { sc.scrollLeft = l0 - dx; sc.scrollTop = t0 - dy; }, () => { }, 'grabbing');
  },

  razorTime(e, c) {
    let t = Timeline.timeAt(e.clientX);
    if (store.snap && !e.altKey) { const s = Timeline.snapPoint(t, null, 6 / Timeline.pps); if (s != null) t = s; }
    return this.frameT(t);
  },
  razor(e, c, tr) {
    const t = this.razorTime(e, c);
    if (e.shiftKey) { this.splitAll(t); return; }
    if (tr.locked) return;
    const f = Timeline.frame() / 2;
    if (!(t > c.start + f && t < clipEnd(c) - f)) return;
    const c2 = Timeline.splitAt(c, tr, t);
    store.packMain();
    store.select(c2.id);
    store.commit('razor');
  },

  rippleTrim(e, c, tr, side) {
    const O = this.snapshot(c), D0 = clipDur(O), s0 = c.start;
    const isMain = tr.main && store.magnet;
    const P = side === 'r' ? s0 + D0 : s0;
    const F = this.followers(P, c, isMain ? null : tr);
    // клипы той же дорожки правее — всегда едут следом
    if (!isMain) for (const o of tr.clips) if (o !== c && o.start >= s0 + D0 - 1e-4 && !F.list.some(x => x.c === o)) F.list.push({ c: o, s0: o.start });
    dragMove(e, (ev, dx) => {
      let dt = dx / Timeline.pps;
      if (side === 'r') dt = this.snapEdge(s0 + D0 + dt, c.id, ev) - (s0 + D0);
      else dt = this.snapEdge(s0 + dt, c.id, ev) - s0;
      dt = this.frameT(dt);
      this.edgeTrim(c, O, side, dt);
      let delta = clipDur(c) - D0;
      if (delta < -F.maxShrink) { this.edgeTrim(c, O, side, side === 'r' ? -F.maxShrink : F.maxShrink); delta = clipDur(c) - D0; }
      c.start = s0;
      for (const x of F.list) x.c.start = Math.max(0, x.s0 + delta);
      if (tr.main) store.packMain();
      Timeline.render(); Player.requestRender();
      this.tip(ev, `${fmtSec(clipDur(c))} · ${delta >= 0 ? '+' : '−'}${fmtTC(Math.abs(delta), store.p.fps)}`);
    }, () => {
      this.tipOff(); Timeline.showSnap(null);
      this.normalize(c);
      for (const t of store.p.tracks) t.clips.sort((a, b) => a.start - b.start);
      store.packMain();
      store.commit('ripple-trim');
    }, 'ew-resize');
  },

  roll(e, A, B, tr) {
    const OA = this.snapshot(A), OB = this.snapshot(B), sB = B.start, edge = clipEnd(A);
    const isMain = tr.main && store.magnet;
    dragMove(e, (ev, dx) => {
      const dt = this.frameT(this.snapEdge(edge + dx / Timeline.pps, null, ev) - edge);
      let a = this.edgeTrim(A, OA, 'r', dt);
      const b = this.edgeTrim(B, OB, 'l', a);
      if (Math.abs(b - a) > 1e-6) { a = this.edgeTrim(A, OA, 'r', b); this.edgeTrim(B, OB, 'l', a); }
      if (!isMain) B.start = sB + a;
      if (tr.main) store.packMain();
      Timeline.render(); Player.requestRender();
      this.tip(ev, `${a >= 0 ? '+' : '−'}${fmtTC(Math.abs(a), store.p.fps)}`);
    }, () => {
      this.tipOff(); Timeline.showSnap(null);
      this.normalize(A); this.normalize(B);
      store.packMain();
      store.commit('roll');
    }, 'col-resize');
  },

  stretch(e, c, tr, side) {
    if (UNBOUNDED(c)) { Timeline.startTrim(e, c, tr, side); return; }
    const O = this.snapshot(c), D0 = clipDur(O), s0 = c.start;
    const isMain = tr.main && store.magnet;
    const others = tr.clips.filter(x => x !== c);
    const prevEnd = isMain ? 0 : Math.max(0, ...others.filter(x => clipEnd(x) <= s0 + 1e-6).map(clipEnd));
    const nextStart = isMain ? Infinity : Math.min(Infinity, ...others.filter(x => x.start >= s0 + D0 - 1e-6).map(x => x.start));
    const f0 = Timeline.frame();
    dragMove(e, (ev, dx) => {
      let dt = dx / Timeline.pps;
      if (side === 'r') dt = this.snapEdge(s0 + D0 + dt, c.id, ev) - (s0 + D0);
      else if (!isMain) dt = this.snapEdge(s0 + dt, c.id, ev) - s0;
      let D = side === 'r' ? D0 + dt : D0 - dt;
      if (!isMain) D = side === 'r' ? Math.min(D, nextStart - s0) : Math.min(D, s0 + D0 - prevEnd);
      const k = D0 / Math.max(f0, D);
      if (O.curve) c.curve = { ...O.curve, pts: O.curve.pts.map(([u, v]) => [u, clamp(Math.round(v * k * 1000) / 1000, 0.1, 10)]) };
      else c.speed = clamp(Math.round(O.speed * k * 1e4) / 1e4, 0.1, 10);
      if (side === 'l' && !isMain) c.start = s0 + D0 - clipDur(c);
      if (tr.main) store.packMain();
      Timeline.render(); Player.requestRender();
      this.tip(ev, `${O.curve ? 'Кривая ×' + (Math.round(k * 100) / 100) : Math.round(c.speed * 1000) / 10 + '%'} · ${fmtSec(clipDur(c))}`);
    }, () => {
      this.tipOff(); Timeline.showSnap(null);
      this.normalize(c);
      store.packMain();
      store.commit('rate-stretch');
      Inspector.render();
    }, 'ew-resize');
  },

  slip(e, c, tr) {
    if (!(c.kind === 'video' || c.kind === 'audio')) { toast('Сдвиг содержимого работает с видео и аудио', 'info'); return; }
    const m = store.media(c.mediaId);
    if (!m) return;
    const O = this.snapshot(c), K0 = c.keys ? deep(c.keys) : null, V0 = c.vkeys ? deep(c.vkeys) : null;
    const rate = (O.out - O.in) / Math.max(1e-6, clipDur(c)), fps = store.p.fps;
    dragMove(e, (ev, dx) => {
      // тянем вправо — показываем более ранний кусок источника (как в Premiere)
      const s = clamp(this.frameT(-dx / Timeline.pps) * rate, -O.in, m.duration - O.out);
      c.in = O.in + s; c.out = O.out + s;
      if (K0) c.keys = K0.map(k => ({ ...k, s: k.s + s }));
      if (V0) c.vkeys = V0.map(k => ({ ...k, s: k.s + s }));
      Timeline.drawCanvases(true); Player.requestRender();
      this.tip(ev, `${fmtTC(c.in, fps)} — ${fmtTC(c.out, fps)}`);
    }, () => {
      this.tipOff();
      store.commit('slip');
    }, 'ew-resize');
  },

  slide(e, c, tr) {
    const isMain = tr.main && store.magnet;
    const A = this.neighbor(tr, c, 'l'), B = this.neighbor(tr, c, 'r');
    if (isMain && !A) { toast('Первый клип главной дорожки сдвинуть нельзя — слева нет соседа', 'info'); return; }
    const OA = A && this.snapshot(A), OB = B && this.snapshot(B), s0 = c.start, D = clipDur(c);
    const others = tr.clips.filter(x => x !== c && x !== A && x !== B);
    const lo = isMain ? -Infinity : (A ? -Infinity : Math.max(0, ...others.filter(x => clipEnd(x) <= s0 + 1e-6).map(clipEnd)) - s0);
    const hi = isMain ? Infinity : (B ? Infinity : Math.min(Infinity, ...others.filter(x => x.start >= s0 + D - 1e-6).map(x => x.start)) - (s0 + D));
    dragMove(e, (ev, dx) => {
      let dt = clamp(this.frameT(dx / Timeline.pps), lo, hi);
      if (!isMain) dt = Math.max(dt, -s0);
      // соседи: левый удлиняется/укорачивается справа, правый — слева; берём сдвиг, возможный для обоих
      if (A) dt = this.edgeTrim(A, OA, 'r', dt);
      if (B) {
        const b = this.edgeTrim(B, OB, 'l', dt);
        if (Math.abs(b - dt) > 1e-6) { dt = b; if (A) dt = this.edgeTrim(A, OA, 'r', dt); this.edgeTrim(B, OB, 'l', dt); }
      }
      if (!isMain) { c.start = s0 + dt; if (B) B.start = OB.start + dt; }
      if (tr.main) store.packMain();
      Timeline.render(); Player.requestRender();
      this.tip(ev, `${dt >= 0 ? '+' : '−'}${fmtTC(Math.abs(dt), store.p.fps)}`);
    }, () => {
      this.tipOff();
      if (A) this.normalize(A);
      if (B) this.normalize(B);
      tr.clips.sort((a, b) => a.start - b.start);
      store.packMain();
      store.commit('slide');
    }, 'move');
  },

  // Курсор и линия лезвия при наведении на дорожки
  hover(e) {
    const tool = this.tool, tl = $('#tlTracks');
    if (document.body.classList.contains('dragging')) return;
    const el = e.target.closest('.clip');
    let cur = '';
    if (tool === 'hand') cur = 'grab';
    else if (tool === 'razor') {
      if (el) {
        const f = store.find(el.dataset.id);
        if (f) { Timeline.showCut(this.razorTime(e, f.clip), e.shiftKey ? null : f.track); cur = 'crosshair'; }
      } else Timeline.hideCut();
    } else if (el && (tool === 'ripple' || tool === 'stretch' || tool === 'roll')) {
      const f = store.find(el.dataset.id);
      const side = f && this.edgeSide(e, f.clip);
      cur = side ? (tool === 'roll' ? 'col-resize' : side === 'l' ? 'w-resize' : 'e-resize') : '';
    } else if (el && tool === 'slip') cur = 'ew-resize';
    else if (el && tool === 'slide') cur = 'move';
    if (tl.style.cursor !== cur) tl.style.cursor = cur;
  },
};

// «ЧЧ:ММ:СС:КК», «ММ:СС», «СС.доли» → секунды
function parseTC(s, fps) {
  s = String(s).trim().replace(',', '.');
  if (!s) return NaN;
  if (!s.includes(':')) return parseFloat(s);
  const p = s.split(':').map(x => parseFloat(x) || 0);
  if (p.length === 4) return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / fps;
  if (p.length === 3) return p[0] * 60 + p[1] + p[2] / fps;
  return p[0] * 60 + p[1];
}
