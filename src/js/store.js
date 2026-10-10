// Модель проекта, история изменений, выделение
const bus = {
  h: {},
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); },
  emit(ev, ...a) { (this.h[ev] || []).forEach(fn => fn(...a)); },
  off(ev, fn) { if (this.h[ev]) this.h[ev] = this.h[ev].filter(f => f !== fn); },
};

const RATIOS = [
  { id: 'original', label: 'Оригинал' },
  { id: '16:9', w: 1920, h: 1080 },
  { id: '9:16', w: 1080, h: 1920, hint: 'TikTok, Shorts, Reels' },
  { id: '1:1', w: 1080, h: 1080, hint: 'Instagram' },
  { id: '4:3', w: 1440, h: 1080 },
  { id: '3:4', w: 1080, h: 1440 },
  { id: '4:5', w: 1080, h: 1350 },
  { id: '21:9', w: 2560, h: 1080 },
  { id: '2.35:1', w: 2538, h: 1080 },
];

const DEFAULT_ADJUST = { brightness: 0, contrast: 0, saturation: 0, hue: 0, warmth: 0, sepia: 0, blur: 0 };
const IS_WIN = !!(window.api && window.api.platform === 'win32');
const EMOJI_FONT = IS_WIN ? 'Segoe UI Emoji' : 'Noto Color Emoji';
const DEFAULT_TEXT_STYLE = {
  font: IS_WIN ? 'Segoe UI' : 'Adwaita Sans', size: 96, color: '#ffffff', bold: true, italic: false, underline: false, align: 'center',
  strokeColor: '#000000', strokeWidth: 0, bgColor: '#000000', bgOpacity: 0, shadow: true, letterSpacing: 0, lineHeight: 1.2,
};

function newProject(id, name) {
  return {
    id, name: name || defaultProjectName(), version: 1,
    width: 1920, height: 1080, fps: 30, ratio: 'original', bg: '#000000',
    media: [],
    tracks: [{ id: uid(), kind: 'video', main: true, muted: false, hidden: false, clips: [] }],
    markers: [],
    created: Date.now(), updated: Date.now(),
  };
}
function defaultProjectName() {
  const d = new Date();
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const store = {
  p: null,             // текущий проект
  dir: null,           // папка проекта
  sel: null,           // id выделенного клипа (главного — его показывает инспектор и превью)
  sels: [],            // все выделенные клипы (рамкой, Ctrl/Shift+клик); sel — один из них
  time: 0,             // позиция курсора
  magnet: true,
  snap: true,
  undoStack: [],
  redoStack: [],
  last: null,
  dirty: false,

  load(p, dir) {
    this.p = p; this.dir = dir; this.sel = null; this.sels = []; this.time = 0;
    p.markers = p.markers || [];
    for (const t of p.tracks) for (const c of t.clips) normalizeClip(c);
    this.undoStack = []; this.redoStack = [];
    this.last = this.snap_();
    bus.emit('project');
    bus.emit('selection');
    bus.emit('time');
  },
  snap_() { return JSON.stringify({ media: this.p.media, tracks: this.p.tracks, markers: this.p.markers, width: this.p.width, height: this.p.height, ratio: this.p.ratio, bg: this.p.bg, fps: this.p.fps }); },
  commit(label) {
    if (!this.p) return;
    const s = this.snap_();
    if (s === this.last) { bus.emit('project'); return; }
    this.undoStack.push(this.last);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.last = s;
    this.dirty = true;
    bus.emit('edit');
    bus.emit('project');
    bus.emit('changed');
  },
  restore_(s) {
    const o = JSON.parse(s);
    Object.assign(this.p, o);
    this.last = s;
    this.sels = this.sels.filter(id => this.find(id));
    if (this.sel && !this.find(this.sel)) this.sel = this.sels[this.sels.length - 1] || null;
    this.dirty = true;
    bus.emit('edit'); bus.emit('project'); bus.emit('selection'); bus.emit('changed');
  },
  undo() { if (!this.undoStack.length) return; this.redoStack.push(this.last); this.restore_(this.undoStack.pop()); },
  redo() { if (!this.redoStack.length) return; this.undoStack.push(this.last); this.restore_(this.redoStack.pop()); },

  // --- поиск
  media(id) { return this.p.media.find(m => m.id === id); },
  find(id) {
    for (const t of this.p.tracks) { const c = t.clips.find(c => c.id === id); if (c) return { clip: c, track: t }; }
    return null;
  },
  selected() { return this.sel ? this.find(this.sel) : null; },
  select(id) {
    if (this.sel === id && this.sels.length === (id ? 1 : 0)) return;
    this.sel = id; this.sels = id ? [id] : [];
    bus.emit('selection');
  },
  // несколько клипов; primary — главный (по умолчанию последний)
  selectMany(ids, primary) {
    ids = [...new Set(ids)];
    const sel = ids.includes(primary) ? primary : ids[ids.length - 1] || null;
    if (sel === this.sel && ids.length === this.sels.length && ids.every(id => this.sels.includes(id))) return;
    this.sel = sel; this.sels = ids;
    bus.emit('selection');
  },
  toggleSel(id) {
    if (this.sels.includes(id)) this.selectMany(this.sels.filter(x => x !== id), this.sel === id ? undefined : this.sel);
    else this.selectMany([...this.sels, id], id);
  },
  isSel(id) { return this.sels.includes(id); },
  // все выделенные клипы { clip, track } в порядке дорожек и времени
  selectedAll() { return this.allClips().filter(f => this.sels.includes(f.clip.id)); },
  mainTrack() { return this.p.tracks.find(t => t.main); },
  allClips() { return this.p.tracks.flatMap(t => t.clips.map(c => ({ clip: c, track: t }))); },
  duration() {
    let d = 0;
    for (const t of this.p.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
    return d;
  },
  setTime(t, src) {
    this.time = clamp(t, 0, Math.max(0, this.duration()));
    bus.emit('time', src);
  },

  // Главная дорожка: клипы идут встык без пробелов
  packMain() {
    const t = this.mainTrack();
    if (!t) return;
    t.clips.sort((a, b) => a.start - b.start);
    if (!this.magnet) return;
    let x = 0, prev = null;
    for (const c of t.clips) {
      if (!prev) c.trans = null;
      c.start = Math.max(0, x - transOverlap(prev, c));
      x = c.start + clipDur(c);
      prev = c;
    }
  },

  // Размещение клипа на дорожке нужного типа (или создание новой)
  place(clip, kind, preferTrackId) {
    const fits = (t) => t.kind === kind && !t.main && t.clips.every(o => clipEnd(o) <= clip.start + 1e-6 || o.start >= clipEnd(clip) - 1e-6);
    let t = this.p.tracks.find(t => t.id === preferTrackId);
    if (!t || !fits(t)) t = this.p.tracks.find(fits);
    if (!t) t = this.addTrack(kind);
    t.clips.push(clip);
    t.clips.sort((a, b) => a.start - b.start);
    return t;
  },
  addTrack(kind, index) {
    const t = { id: uid(), kind, muted: false, hidden: false, clips: [] };
    if (index != null) this.p.tracks.splice(index, 0, t);
    else if (kind === 'effect') {
      // эффекты — над видеодорожками, но под текстом
      const i = this.p.tracks.findIndex(x => x.kind === 'video' || x.kind === 'effect');
      this.p.tracks.splice(i < 0 ? 0 : i, 0, t);
    }
    else if (kind === 'audio') this.p.tracks.push(t);
    else this.p.tracks.unshift(t);
    return t;
  },
  cleanupTracks() {
    this.p.tracks = this.p.tracks.filter(t => t.main || t.clips.length);
  },
  removeClip(id) {
    for (const t of this.p.tracks) {
      const i = t.clips.findIndex(c => c.id === id);
      if (i >= 0) { t.clips.splice(i, 1); break; }
    }
    // событие выделения — после commit вызывающего кода, чтобы таймлайн успел анимировать перестройку
    if (this.sels.includes(id)) {
      this.sels = this.sels.filter(x => x !== id);
      if (this.sel === id) this.sel = this.sels[this.sels.length - 1] || null;
      queueMicrotask(() => bus.emit('selection'));
    }
    this.packMain();
    this.cleanupTracks();
  },
};

// ---------------------------------------------------------------- время клипа
// Постоянная скорость (c.speed) или кривая скорости c.curve = { id, pts: [[u, v], …] }:
// u ∈ [0, 1] — доля используемого куска источника [in, out], v — скорость в этой точке (0.1–10),
// между точками скорость меняется линейно по источнику. Отсюда точные формулы (и те же — в выражениях ffmpeg):
// на отрезке длины L со скоростью v0 → v1 (dv = v1 − v0) время t(s) = L/dv · ln(v(s)/v0), источник s(t) = L/dv · v0 · (e^(t·dv/L) − 1).
function curveSegs(c) {
  const key = c.in + ':' + c.out + ':' + JSON.stringify(c.curve.pts);
  if (c._cs && c._cs.key === key) return c._cs;
  const L = Math.max(1e-6, c.out - c.in), P = c.curve.pts, segs = [];
  let t = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const s0 = P[i][0] * L, s1 = P[i + 1][0] * L, v0 = P[i][1], v1 = P[i + 1][1], Ls = s1 - s0;
    if (Ls <= 1e-9) continue;
    const dv = Math.abs(v1 - v0) < 1e-6 ? 0 : v1 - v0;
    const d = dv ? Ls / dv * Math.log(v1 / v0) : Ls / v0;
    segs.push({ s0, s1, v0, v1, dv, Ls, t0: t, t1: t + d });
    t += d;
  }
  const cs = { key, segs, T: t };
  Object.defineProperty(c, '_cs', { value: cs, writable: true, configurable: true, enumerable: false });
  return cs;
}
const hasCurve = (c) => !!(c.curve && c.curve.pts && c.curve.pts.length > 1);
function clipDur(c) { return hasCurve(c) ? curveSegs(c).T : (c.out - c.in) / (c.speed || 1); }
function clipEnd(c) { return c.start + clipDur(c); }
// время источника в момент lt от начала клипа
function srcAt(c, lt) {
  if (!hasCurve(c)) return c.in + lt * (c.speed || 1);
  const { segs, T } = curveSegs(c);
  if (!segs.length) return c.in;
  lt = clamp(lt, 0, T);
  const g = segs.find(x => lt < x.t1) || segs[segs.length - 1];
  const tau = lt - g.t0;
  return c.in + g.s0 + (g.dv ? g.Ls / g.dv * g.v0 * (Math.exp(tau * g.dv / g.Ls) - 1) : tau * g.v0);
}
// обратное: момент от начала клипа для времени источника s
function ltAt(c, s) {
  if (!hasCurve(c)) return (s - c.in) / (c.speed || 1);
  const { segs, T } = curveSegs(c);
  if (!segs.length) return 0;
  const x = s - c.in;
  if (x <= 0) return 0;
  const g = segs.find(q => x < q.s1);
  if (!g) return T;
  const d = x - g.s0;
  return g.t0 + (g.dv ? g.Ls / g.dv * Math.log((g.v0 + g.dv * d / g.Ls) / g.v0) : d / g.v0);
}
// мгновенная скорость в момент lt
function rateAt(c, lt) {
  if (!hasCurve(c)) return c.speed || 1;
  const x = srcAt(c, lt) - c.in;
  return curveV(c.curve.pts, x / Math.max(1e-6, c.out - c.in));
}
function curveV(P, u) {
  if (u <= P[0][0]) return P[0][1];
  for (let i = 0; i < P.length - 1; i++) if (u <= P[i + 1][0]) {
    const f = (u - P[i][0]) / Math.max(1e-9, P[i + 1][0] - P[i][0]);
    return P[i][1] + (P[i + 1][1] - P[i][1]) * f;
  }
  return P[P.length - 1][1];
}
// за краями клипа — с крайней скоростью (для обрезки перетаскиванием)
function srcAtExt(c, lt) {
  const D = clipDur(c);
  if (lt < 0) return c.in + lt * rateAt(c, 0);
  if (lt > D) return c.out + (lt - D) * rateAt(c, D);
  return srcAt(c, lt);
}
function ltAtExt(c, s) {
  if (s < c.in) return (s - c.in) / rateAt(c, 0);
  if (s > c.out) { const D = clipDur(c); return D + (s - c.out) / rateAt(c, D); }
  return ltAt(c, s);
}
// Готовые кривые — как в CapCut (скорость в долях исходного куска)
const SPEED_CURVES = [
  { id: 'custom', name: 'Своя', pts: [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]] },
  { id: 'montage', name: 'Монтаж', pts: [[0, 0.8], [0.18, 0.8], [0.3, 3.5], [0.42, 3.5], [0.54, 0.8], [0.7, 0.8], [0.82, 3.5], [1, 3.5]] },
  { id: 'hero', name: 'Герой', pts: [[0, 3], [0.32, 3], [0.44, 0.3], [0.56, 0.3], [0.68, 3], [1, 3]] },
  { id: 'bullet', name: 'Пуля', pts: [[0, 1.6], [0.38, 1.6], [0.5, 0.15], [0.62, 1.6], [1, 1.6]] },
  { id: 'jump', name: 'Прыжок', pts: [[0, 0.6], [0.3, 0.6], [0.44, 4], [0.56, 4], [0.7, 0.6], [1, 0.6]] },
  { id: 'flashIn', name: 'Влёт', pts: [[0, 5], [0.3, 5], [0.5, 1], [1, 1]] },
  { id: 'flashOut', name: 'Разгон', pts: [[0, 1], [0.5, 1], [0.7, 5], [1, 5]] },
];
const curveName = (cv) => (SPEED_CURVES.find(x => x.id === cv.id) || SPEED_CURVES[0]).name;

// Кривая для другого куска того же источника (обрезка, разделение): форма сохраняется по источнику,
// за пределами старого куска скорость продолжается крайним значением
function curveRange(curve, in0, out0, in1, out1) {
  const L0 = Math.max(1e-6, out0 - in0), u0 = (in1 - in0) / L0, u1 = (out1 - in0) / L0, P = curve.pts;
  const v = (u) => curveV(P, clamp(u, 0, 1));
  const pts = [[u0, v(u0)], ...P.filter(p => p[0] > u0 + 1e-6 && p[0] < u1 - 1e-6), [u1, v(u1)]];
  const k = 1 / Math.max(1e-9, u1 - u0);
  return { ...curve, pts: pts.map(([u, s]) => [Math.round((u - u0) * k * 1e5) / 1e5, s]) };
}
function isVisual(c) { return c.kind === 'video' || c.kind === 'image' || c.kind === 'text'; }
function hasAudioTrack(c) {
  if (c.kind === 'audio') return true;
  if (c.kind !== 'video') return false;
  const m = store.media(c.mediaId);
  return !!(m && m.hasAudio);
}

function normalizeClip(c) {
  c.speed = c.speed || 1;
  if (c.volume == null) c.volume = 1;
  c.fadeIn = c.fadeIn || 0;
  c.fadeOut = c.fadeOut || 0;
  if (c.kind === 'effect') {
    c.params = Object.assign({ strength: 60, speed: 50 }, c.params || {});
    return c;
  }
  if (c.kind !== 'audio') {
    c.transform = Object.assign({ x: 0, y: 0, scale: 1, rotation: 0 }, c.transform || {});
    if (c.opacity == null) c.opacity = 1;
    c.anim = Object.assign({ in: 'none', inDur: 0.5, out: 'none', outDur: 0.5 }, c.anim || {});
  }
  if (c.kind === 'video' || c.kind === 'image') {
    c.adjust = Object.assign({}, DEFAULT_ADJUST, c.adjust || {});
    c.filter = Object.assign({ name: null, intensity: 100 }, c.filter || {});
    c.flipH = !!c.flipH; c.flipV = !!c.flipV;
    c.chroma = Object.assign({}, DEFAULT_CHROMA, c.chroma || {});
  }
  if (c.kind === 'text') c.style = Object.assign({}, DEFAULT_TEXT_STYLE, c.style || {});
  return c;
}

function makeMediaClip(m, start) {
  const kind = m.type;
  const dur = kind === 'image' ? 5 : m.duration;
  return normalizeClip({ id: uid(), kind, mediaId: m.id, start: start || 0, in: 0, out: dur, speed: 1, name: m.name });
}
function makeEffectClip(start, effect, dur = 3) {
  return normalizeClip({ id: uid(), kind: 'effect', effect, start, in: 0, out: dur, speed: 1 });
}
function makeTextClip(start, text, style) {
  return normalizeClip({ id: uid(), kind: 'text', start, in: 0, out: 3, speed: 1, text: text || 'Введите текст', style: Object.assign({}, DEFAULT_TEXT_STYLE, style || {}) });
}
