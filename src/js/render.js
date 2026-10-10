// Общая математика отрисовки: цвет, геометрия, анимации, текст.
// Используется и в превью (canvas), и при экспорте (ffmpeg), чтобы результат совпадал.

const ADJUST_DEFS = [
  { key: 'brightness', label: 'Яркость' },
  { key: 'contrast', label: 'Контраст' },
  { key: 'saturation', label: 'Насыщенность' },
  { key: 'warmth', label: 'Температура' },
  { key: 'tint', label: 'Оттенок' },
  { key: 'hue', label: 'Тон' },
  { key: 'sepia', label: 'Сепия', min: 0 },
  { key: 'blur', label: 'Размытие', min: 0 },
];

const FILTER_PRESETS = [
  { id: null, name: 'Нет' },
  { id: 'vivid', name: 'Яркий', a: { saturation: 45, contrast: 12 } },
  { id: 'warm', name: 'Тёплый', a: { warmth: 55, saturation: 10, brightness: 4 } },
  { id: 'cool', name: 'Холодный', a: { warmth: -55, tint: -8, contrast: 5 } },
  { id: 'bw', name: 'Ч/Б', a: { saturation: -100, contrast: 15 } },
  { id: 'noir', name: 'Нуар', a: { saturation: -100, contrast: 55, brightness: -10 } },
  { id: 'vintage', name: 'Винтаж', a: { sepia: 45, contrast: -12, saturation: -15, brightness: 6 } },
  { id: 'retro', name: 'Ретро', a: { sepia: 30, warmth: 30, hue: -8, saturation: 20, contrast: 8 } },
  { id: 'faded', name: 'Выцветший', a: { contrast: -35, saturation: -30, brightness: 12 } },
  { id: 'cinema', name: 'Кино', a: { contrast: 22, saturation: -18, warmth: -18, tint: 6 } },
  { id: 'teal', name: 'Бирюза', a: { hue: -10, warmth: -35, saturation: 25, contrast: 10 } },
  { id: 'sunset', name: 'Закат', a: { warmth: 70, tint: 25, saturation: 15 } },
  { id: 'dream', name: 'Мечта', a: { brightness: 14, contrast: -18, tint: 18, saturation: 12 } },
  { id: 'forest', name: 'Лес', a: { tint: -35, saturation: 15, contrast: 8 } },
  { id: 'moody', name: 'Мрачный', a: { brightness: -18, contrast: 25, saturation: -35, warmth: -20 } },
  { id: 'pop', name: 'Поп', a: { saturation: 80, contrast: 20, brightness: 5 } },
];

const ANIMS_IN = [
  { id: 'none', name: 'Нет' },
  { id: 'fade', name: 'Появление' },
  { id: 'slideLeft', name: 'Слева' },
  { id: 'slideRight', name: 'Справа' },
  { id: 'slideUp', name: 'Снизу' },
  { id: 'slideDown', name: 'Сверху' },
];
const ANIMS_OUT = [
  { id: 'none', name: 'Нет' },
  { id: 'fade', name: 'Исчезание' },
  { id: 'slideLeft', name: 'Влево' },
  { id: 'slideRight', name: 'Вправо' },
  { id: 'slideUp', name: 'Вверх' },
  { id: 'slideDown', name: 'Вниз' },
];

// ---------------------------------------------------------------- цвет
// Аффинная матрица 3×4 (строки R,G,B; столбцы r,g,b,offset)
const I3 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function mul(A, B) { // A ∘ B (сначала B, потом A)
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c];
    o[r * 4 + 3] = A[r * 4] * B[3] + A[r * 4 + 1] * B[7] + A[r * 4 + 2] * B[11] + A[r * 4 + 3];
  }
  return o;
}
function mat3(m, off = [0, 0, 0]) { return [m[0], m[1], m[2], off[0], m[3], m[4], m[5], off[1], m[6], m[7], m[8], off[2]]; }

function adjustMatrix(a, k = 1) {
  let M = I3();
  const v = (key) => ((a[key] || 0) / 100) * k;
  const sep = clamp(v('sepia'), 0, 1);
  if (sep) {
    const i = 1 - sep;
    M = mul(mat3([0.393 + 0.607 * i, 0.769 - 0.769 * i, 0.189 - 0.189 * i, 0.349 - 0.349 * i, 0.686 + 0.314 * i, 0.168 - 0.168 * i, 0.272 - 0.272 * i, 0.534 - 0.534 * i, 0.131 + 0.869 * i]), M);
  }
  const s = 1 + v('saturation');
  if (s !== 1) {
    M = mul(mat3([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]), M);
  }
  const hue = v('hue') * Math.PI;
  if (hue) {
    const c = Math.cos(hue), n = Math.sin(hue);
    M = mul(mat3([
      0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
      0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.140, 0.072 - c * 0.072 - n * 0.283,
      0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072]), M);
  }
  const w = v('warmth');
  if (w) M = mul(mat3([1 + 0.16 * w, 0, 0, 0, 1 + 0.03 * w, 0, 0, 0, 1 - 0.16 * w]), M);
  const t = v('tint');
  if (t) M = mul(mat3([1 + 0.07 * t, 0, 0, 0, 1 - 0.12 * t, 0, 0, 0, 1 + 0.07 * t]), M);
  const ct = v('contrast');
  if (ct) {
    const f = ct > 0 ? 1 + ct * 0.8 : 1 + ct * 0.6;
    M = mul(mat3([f, 0, 0, 0, f, 0, 0, 0, f], [0.5 - 0.5 * f, 0.5 - 0.5 * f, 0.5 - 0.5 * f]), M);
  }
  const b = v('brightness');
  if (b) M = mul(mat3([1 + 0.25 * b, 0, 0, 0, 1 + 0.25 * b, 0, 0, 0, 1 + 0.25 * b], [0.12 * b, 0.12 * b, 0.12 * b]), M);
  return M;
}

function clipColorMatrix(c) {
  if (!c.adjust) return null;
  let M = I3();
  if (c.filter && c.filter.name) {
    const p = FILTER_PRESETS.find(f => f.id === c.filter.name);
    if (p) M = adjustMatrix(p.a, (c.filter.intensity ?? 100) / 100);
  }
  M = mul(adjustMatrix(c.adjust), M);
  const id = I3();
  if (M.every((x, i) => Math.abs(x - id[i]) < 1e-4)) return null;
  return M;
}

// ---------------------------------------------------------------- кривые (как «Кривые» в Lumetri)
// c.curves = { m, r, g, b } — точки [[x, y], …] в долях 0…1 (m — общая кривая для всех каналов).
// Сначала цветовая матрица, потом общая кривая, потом кривая канала. Между точками — монотонный
// кубический сплайн (Фриче — Карлсон): без выбросов за соседние точки.
const CURVE_CH = ['m', 'r', 'g', 'b'];
const curveIdent = (P) => !P || P.length < 2 || P.every(([x, y]) => Math.abs(x - y) < 1e-4);
function curvesOn(c) { return !!(c.curves && CURVE_CH.some(k => !curveIdent(c.curves[k]))); }
function splineFn(P) {
  const n = P.length, xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  if (n === 2) { m[0] = m[1] = d[0]; }
  else {
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(d[i]) < 1e-9) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], q = a * a + b * b;
      if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
  }
  return (x) => {
    if (x <= xs[0]) return clamp(ys[0], 0, 1);
    if (x >= xs[n - 1]) return clamp(ys[n - 1], 0, 1);
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const hh = xs[i + 1] - xs[i], t = (x - xs[i]) / hh, t2 = t * t, t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1];
    return clamp(v, 0, 1);
  };
}
// функции каналов: x (0…1) → y (0…1); null — кривых нет
function curveFns(c) {
  if (!curvesOn(c)) return null;
  const C = c.curves, f = (k) => curveIdent(C[k]) ? (x) => x : splineFn(C[k]);
  const m = f('m');
  return ['r', 'g', 'b'].map(k => { const ch = f(k); return (x) => ch(m(x)); });
}
// таблицы по 256 значений для feComponentTransfer (между значениями браузер интерполирует линейно)
function curveTables(c) {
  const F = curveFns(c);
  if (!F) return null;
  return F.map(fn => Array.from({ length: 256 }, (_, i) => fn(i / 255)));
}

// SVG-фильтры для canvas (feColorMatrix + feComponentTransfer в sRGB)
const svgFilterCache = new Map();
let svgRoot = null, svgFilterSeq = 0;
const svgPinned = new Set();
function svgFilterId(M, T) {
  const key = (M ? M.map(x => x.toFixed(4)).join(',') : '') + (T ? '|' + T.map(t => t.map(v => v.toFixed(4)).join(',')).join('/') : '');
  if (svgFilterCache.has(key)) return svgFilterCache.get(key);
  if (svgFilterCache.size > 3000 && svgRoot) {
    // чистим только динамические фильтры, постоянные (каналы RGB и т.п.) оставляем
    for (const [k, id] of svgFilterCache) if (!svgPinned.has(id)) { const el = svgRoot.querySelector('#' + id); if (el) el.remove(); svgFilterCache.delete(k); }
  }
  if (!svgRoot) {
    svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgRoot.setAttribute('width', '0'); svgRoot.setAttribute('height', '0');
    svgRoot.style.position = 'absolute';
    document.body.appendChild(svgRoot);
  }
  const NS = 'http://www.w3.org/2000/svg';
  const id = 'cm' + (++svgFilterSeq);
  const f = document.createElementNS(NS, 'filter');
  f.setAttribute('id', id);
  f.setAttribute('color-interpolation-filters', 'sRGB');
  if (M) {
    const cm = document.createElementNS(NS, 'feColorMatrix');
    cm.setAttribute('type', 'matrix');
    cm.setAttribute('values', [M[0], M[1], M[2], 0, M[3], M[4], M[5], M[6], 0, M[7], M[8], M[9], M[10], 0, M[11], 0, 0, 0, 1, 0].map(x => +x.toFixed(5)).join(' '));
    f.appendChild(cm);
  }
  if (T) {
    const ct = document.createElementNS(NS, 'feComponentTransfer');
    ['R', 'G', 'B'].forEach((ch, i) => {
      const fn = document.createElementNS(NS, 'feFunc' + ch);
      fn.setAttribute('type', 'table');
      fn.setAttribute('tableValues', T[i].map(v => +v.toFixed(5)).join(' '));
      ct.appendChild(fn);
    });
    f.appendChild(ct);
  }
  svgRoot.appendChild(f);
  svgFilterCache.set(key, id);
  svgRoot.getBoundingClientRect(); // заставляем браузер сразу подхватить новый фильтр
  return id;
}

function canvasFilter(c, k) {
  const parts = [];
  const M = clipColorMatrix(c), T = curveTables(c);
  if (M || T) parts.push(`url(#${svgFilterId(M, T)})`);
  const blur = c.adjust ? (c.adjust.blur || 0) : 0;
  if (blur > 0) parts.push(`blur(${(blur / 100 * 30 * k).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// 3D LUT (.cube) из аффинной матрицы (и кривых, если есть) — совпадение с превью
function cubeLUT(M, N = 17, T = null) {
  const lines = ['TITLE "LinCut"', `LUT_3D_SIZE ${N}`];
  M = M || I3();
  // таблица кривых — с той же линейной интерполяцией, что у feComponentTransfer
  const tab = (t, x) => { const p = clamp(x, 0, 1) * 255, i = Math.min(254, Math.floor(p)); return t[i] + (t[i + 1] - t[i]) * (p - i); };
  for (let bi = 0; bi < N; bi++) for (let gi = 0; gi < N; gi++) for (let ri = 0; ri < N; ri++) {
    const r = ri / (N - 1), g = gi / (N - 1), b = bi / (N - 1);
    const o = [0, 1, 2].map(i => {
      let v = clamp(M[i * 4] * r + M[i * 4 + 1] * g + M[i * 4 + 2] * b + M[i * 4 + 3], 0, 1);
      if (T) v = tab(T[i], v);
      return v.toFixed(5);
    });
    lines.push(o.join(' '));
  }
  return lines.join('\n');
}
// LUT цвета клипа для экспорта (null — цвет не меняется)
function clipLUT(c) {
  const M = clipColorMatrix(c), T = curveTables(c);
  if (!M && !T) return null;
  return cubeLUT(M, T ? 33 : 17, T);
}

// ---------------------------------------------------------------- геометрия
function mediaSize(c) {
  if (c.kind === 'text') return null;
  const m = store.media(c.mediaId);
  return m ? { w: m.width || 1920, h: m.height || 1080 } : { w: 1920, h: 1080 };
}

// ---------------------------------------------------------------- ключевые кадры
// c.keys = [{ s: время в источнике, x, y, scale, rotation, opacity, sx, sy, rx, ry }] — по возрастанию s
// sx/sy — растяжение по ширине/высоте (множители к scale), rx/ry — 3D-поворот вокруг осей X и Y (градусы)
const KEY_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'sx', 'sy', 'rx', 'ry'];
function baseTf(c) { const t = c.transform; return { x: t.x, y: t.y, scale: t.scale, rotation: t.rotation, opacity: c.opacity ?? 1, sx: t.sx ?? 1, sy: t.sy ?? 1, rx: t.rx || 0, ry: t.ry || 0 }; }
function srcTime(c, t) { return srcAt(c, t - c.start); }
function keyPick(k) { return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity, sx: k.sx ?? 1, sy: k.sy ?? 1, rx: k.rx || 0, ry: k.ry || 0 }; }
// записать трансформацию (без прозрачности) в c.transform и прозрачность в c.opacity
function putTf(c, v) {
  Object.assign(c.transform, { x: v.x, y: v.y, scale: v.scale, rotation: v.rotation, sx: v.sx, sy: v.sy, rx: v.rx, ry: v.ry });
  c.opacity = v.opacity;
}
// Трансформация клипа в момент t (время таймлайна)
function tfAt(c, t) {
  const K = c.keys;
  if (!c.transform) return null;
  if (!K || !K.length) return baseTf(c);
  if (t == null || K.length === 1) return keyPick(K[0]);
  const s = srcTime(c, t);
  if (s <= K[0].s) return keyPick(K[0]);
  const last = K[K.length - 1];
  if (s >= last.s) return keyPick(last);
  let i = 0;
  while (i < K.length - 2 && K[i + 1].s <= s) i++;
  const a = keyPick(K[i]), b = keyPick(K[i + 1]), f = (s - K[i].s) / (K[i + 1].s - K[i].s);
  const o = {};
  for (const p of KEY_PROPS) o[p] = a[p] + (b[p] - a[p]) * f;
  return o;
}
function keyIndexAt(c, t) {
  if (!c.keys) return -1;
  const s = srcTime(c, t), tol = 0.5 / (store.p ? store.p.fps : 30) * rateAt(c, t - c.start);
  return c.keys.findIndex(k => Math.abs(k.s - s) <= tol);
}
// Изменить трансформацию: если есть ключевые кадры — пишем в кадр на позиции t (создаём при необходимости)
function setTf(c, patch, t) {
  if (c.keys && c.keys.length) {
    let i = keyIndexAt(c, t);
    if (i < 0) {
      c.keys.push({ s: srcTime(c, t), ...tfAt(c, t) });
      c.keys.sort((a, b) => a.s - b.s);
      i = keyIndexAt(c, t);
    }
    Object.assign(c.keys[i], patch);
    return;
  }
  for (const [k, v] of Object.entries(patch)) { if (k === 'opacity') c.opacity = v; else c.transform[k] = v; }
}
function toggleKey(c, t) {
  c.keys = c.keys || [];
  const i = keyIndexAt(c, t);
  if (i >= 0) {
    const cur = keyPick(c.keys[i]);
    c.keys.splice(i, 1);
    if (!c.keys.length) putTf(c, cur);
    return false;
  }
  c.keys.push({ s: srcTime(c, t), ...tfAt(c, t) });
  c.keys.sort((a, b) => a.s - b.s);
  return true;
}
// Сдвиг ключей при нормализации клипов без источника (фото, текст)
function shiftKeys(c, d) { if (c.keys) for (const k of c.keys) k.s += d; }

// Коробка клипа в координатах проекта (без анимации); t — время для ключевых кадров.
// w/h — уже с растяжением sx/sy; rx/ry — 3D-поворот (см. proj3)
function clipBox(c, W, H, time) {
  const t = tfAt(c, time);
  if (c.kind === 'text') {
    const tm = measureText(c);
    return { cx: W / 2 + t.x, cy: H / 2 + t.y, w: tm.w * t.scale * t.sx, h: tm.h * t.scale * t.sy, rot: t.rotation, rx: t.rx, ry: t.ry, op: t.opacity };
  }
  const s = mediaSize(c);
  const f = Math.min(W / s.w, H / s.h) * t.scale;
  return { cx: W / 2 + t.x, cy: H / 2 + t.y, w: s.w * f * t.sx, h: s.h * f * t.sy, rot: t.rotation, rx: t.rx, ry: t.ry, op: t.opacity };
}

// ---------------------------------------------------------------- 3D-поворот (как в Paint 3D)
// Плоский объект (после масштаба и поворота в плоскости) поворачивается вокруг своей оси X (rx: верх уходит вглубь),
// затем Y (ry: правый край уходит вглубь) и смотрится камерой на расстоянии D от плоскости кадра.
// Та же формула — в превью (warp3d, WebGL) и в экспорте (perspective, exporter.js keyedLayer).
const PERSP_K = 1.2;
function is3d(t) { return !!t && (Math.abs(t.rx || 0) > 0.01 || Math.abs(t.ry || 0) > 0.01); }
// расстояние камеры: от размера кадра, но не ближе 1,5 полудиагонали объекта (иначе края уходят за камеру)
function perspDist(b, W, H) { return Math.max(PERSP_K * Math.hypot(W, H), 0.75 * Math.hypot(b.w, b.h)); }
// точка (u, v) плоскости объекта (от центра, уже с поворотом Z) → [x, y] от центра на экране и w = (D + z) / D
function proj3(rx, ry, D) {
  const ax = rx * Math.PI / 180, ay = ry * Math.PI / 180;
  const cX = Math.cos(ax), sX = Math.sin(ax), cY = Math.cos(ay), sY = Math.sin(ay);
  return (u, v) => {
    const y = v * cX, z1 = -v * sX;
    const x = u * cY - z1 * sY, z = u * sY + z1 * cY;
    const w = (D + z) / D;
    return [x / w, y / w, w];
  };
}
// точка (u, v) в осях объекта (до поворота Z) → координаты проекта
function boxPoint(b, u, v, W, H) {
  const r = b.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
  const x = u * cs - v * sn, y = u * sn + v * cs;
  if (!is3d(b)) return [b.cx + x, b.cy + y];
  const P = proj3(b.rx, b.ry, perspDist(b, W, H))(x, y);
  return [b.cx + P[0], b.cy + P[1]];
}

// Превью 3D-поворота: объект рисуется плоским на отдельный холст (flat(ctx, клип без 3D, анимация)),
// затем этот холст кладётся на кадр четырёхугольником с перспективой (WebGL — точная перспективная
// интерполяция, как у perspective в ffmpeg). Прозрачность и режим наложения — при выводе на кадр.
const Warp3d = {
  gl: null, cv: null, prog: null, buf: null, tex: null, failed: false,
  init() {
    if (this.gl || this.failed) return !!this.gl;
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) { this.failed = true; return false; }
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec4 p;attribute vec2 uv;varying vec2 v;void main(){v=uv;gl_Position=p;}'));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, 'precision highp float;varying vec2 v;uniform sampler2D t;void main(){gl_FragColor=texture2D(t,v);}'));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { this.failed = true; return false; }
    this.cv = cv; this.gl = gl; this.prog = pr;
    this.buf = gl.createBuffer();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return true;
  },
  // src — холст объекта; quad — 4 угла [x, y, w] в пикселях целевого холста (лв, пв, пн, лн)
  draw(ctx, src, quad, alpha, comp) {
    const gl = this.gl, cv = this.cv, W = ctx.canvas.width, H = ctx.canvas.height;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]], d = [];
    // w в четвёртой координате — видеокарта сама делит и интерполирует текстуру с перспективой
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y, w] = quad[i];
      d.push((x / W * 2 - 1) * w, (1 - y / H * 2) * w, 0, w, uv[i][0], uv[i][1]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d), gl.STREAM_DRAW);
    const ap = gl.getAttribLocation(this.prog, 'p'), au = gl.getAttribLocation(this.prog, 'uv');
    gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(au); gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 24, 16);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = 'none';
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.globalCompositeOperation = comp || 'source-over';
    ctx.drawImage(cv, 0, 0);
    ctx.restore();
  },
};
let flat3dCv = null;
function draw3d(ctx, c, W, H, k, anim, time, flat) {
  const t = tfAt(c, time), b = clipBox(c, W, H, time);
  const a = anim || { alpha: 1, dx: 0, dy: 0 };
  const flatClip = (x, y) => ({ ...c, keys: null, blend: undefined, opacity: 1, _fxPre: c.kind !== 'text' ? fxPreScale(c) : null,
    transform: { ...c.transform, x, y, scale: t.scale, sx: t.sx, sy: t.sy, rotation: 0, rx: 0, ry: 0 } });
  if (!Warp3d.init()) { flat(ctx, flatClip(t.x, t.y), a); return; }
  // плоский объект — на холст по своему размеру с запасом (тень и обводка текста)
  const pad = Math.ceil(Math.max(b.w, b.h) * k * 0.08 + 6);
  const LW = Math.min(8192, Math.ceil(b.w * k + pad * 2)), LH = Math.min(8192, Math.ceil(b.h * k + pad * 2));
  if (!flat3dCv) flat3dCv = document.createElement('canvas');
  const F = flat3dCv;
  if (F.width !== LW || F.height !== LH) { F.width = LW; F.height = LH; }
  const fx = F.getContext('2d');
  fx.setTransform(1, 0, 0, 1, 0, 0); fx.globalAlpha = 1; fx.globalCompositeOperation = 'source-over'; fx.filter = 'none';
  fx.clearRect(0, 0, LW, LH);
  flat(fx, flatClip(LW / (2 * k) - W / 2, LH / (2 * k) - H / 2), { alpha: 1, dx: 0, dy: 0 });
  // углы холста объекта → 3D → экран (с учётом текущей матрицы ctx)
  const P = proj3(b.rx, b.ry, perspDist(b, W, H));
  const r = b.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
  const U = LW / (2 * k), V = LH / (2 * k), M = ctx.getTransform();
  const cx = b.cx + a.dx, cy = b.cy + a.dy;
  const quad = [[-U, -V], [U, -V], [U, V], [-U, V]].map(([u, v]) => {
    const [x, y, w] = P(u * cs - v * sn, u * sn + v * cs);
    const X = (cx + x) * k, Y = (cy + y) * k;
    return [M.a * X + M.c * Y + M.e, M.b * X + M.d * Y + M.f, w];
  });
  const bl = blendOf(c);
  Warp3d.draw(ctx, F, quad, ctx.globalAlpha * b.op * a.alpha, bl ? bl.css : null);
}

const TRANSITIONS = [
  { id: 'dissolve', name: 'Растворение', group: 'base' },
  { id: 'black', name: 'Через чёрный', group: 'base' },
  { id: 'white', name: 'Через белый', group: 'base' },
  { id: 'flash', name: 'Вспышка', group: 'base' },
  { id: 'pushLeft', name: 'Сдвиг влево', group: 'move' },
  { id: 'pushRight', name: 'Сдвиг вправо', group: 'move' },
  { id: 'pushUp', name: 'Сдвиг вверх', group: 'move' },
  { id: 'pushDown', name: 'Сдвиг вниз', group: 'move' },
  { id: 'whipLeft', name: 'Рывок влево', group: 'move' },
  { id: 'whipRight', name: 'Рывок вправо', group: 'move' },
  { id: 'zoomIn', name: 'Наезд', group: 'edit' },
  { id: 'zoomOut', name: 'Отъезд', group: 'edit' },
  { id: 'spin', name: 'Вращение', group: 'edit' },
  { id: 'zoomSpin', name: 'Вихрь', group: 'edit' },
  { id: 'glitchT', name: 'Глитч', group: 'edit' },
  { id: 'rgbT', name: 'RGB-разлом', group: 'edit' },
  { id: 'shakeT', name: 'Тряска', group: 'edit' },
  { id: 'blurT', name: 'Размытие', group: 'edit' },
  { id: 'pixelT', name: 'Пиксели', group: 'edit' },
];
const OVERLAP_TRANS = new Set(['dissolve', 'pushLeft', 'pushRight', 'pushUp', 'pushDown', 'whipLeft', 'whipRight']);

// Длительность перехода между prev и c (с ограничением по длине клипов)
function transDur(prev, c) {
  if (!prev || !c.trans) return 0;
  return Math.max(0.05, Math.min(c.trans.dur, clipDur(prev) * 0.5, clipDur(c) * 0.5));
}
function transOverlap(prev, c) { return c.trans && OVERLAP_TRANS.has(c.trans.type) ? transDur(prev, c) : 0; }

// Эффекты на стыках главной дорожки: [{ S, E, ops }]
function junctionFx(track) {
  const out = [];
  if (!track) return out;
  track.clips.forEach((c, i) => {
    if (!i || !c.trans) return;
    const td = transDur(track.clips[i - 1], c);
    const ops = transFxOps(c.trans.type, td);
    if (!ops) return;
    const S = OVERLAP_TRANS.has(c.trans.type) ? c.start : c.start - td / 2;
    out.push({ S, E: S + td, ops, id: c.id });
  });
  return out;
}

// Кривые движения; одинаковые формулы в JS и в выражениях ffmpeg
const CURVES = {
  arrive: { f: (p) => Math.pow(1 - p, 3), x: (P) => `pow(1-${P},3)` },
  leave: { f: (p) => Math.pow(p, 3), x: (P) => `pow(${P},3)` },
  pushIn: { f: (p) => 1 - (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2), x: (P) => `(1-if(lt(${P},0.5),4*pow(${P},3),1-pow(-2*${P}+2,3)/2))` },
  pushOut: { f: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2), x: (P) => `if(lt(${P},0.5),4*pow(${P},3),1-pow(-2*${P}+2,3)/2)` },
};

function slideVec(type, W, H) {
  const dx = W * 0.3, dy = H * 0.3;
  return { slideLeft: [-dx, 0], slideRight: [dx, 0], slideUp: [0, dy], slideDown: [0, -dy] }[type] || [0, 0];
}
const PUSH = { pushLeft: [1, 0], pushRight: [-1, 0], pushUp: [0, 1], pushDown: [0, -1], whipLeft: [1, 0], whipRight: [-1, 0] };

// Описание эффектов клипа во времени: затухания альфы и сдвиги.
// fades: [{dir:'in'|'out', from, dur}] (абсолютное время); moves: [{axis, amt, from, dur, curve}]
function clipFx(c, track, W, H) {
  const fx = { fades: [], moves: [] };
  const s = c.start, e = clipEnd(c), d = e - s;
  const a = c.anim;
  if (a) {
    if (a.in !== 'none' && a.inDur > 0) {
      const dur = Math.min(a.inDur, d);
      fx.fades.push({ dir: 'in', from: s, dur });
      const [vx, vy] = slideVec(a.in, W, H);
      if (vx) fx.moves.push({ axis: 'x', amt: vx, from: s, dur, curve: 'arrive' });
      if (vy) fx.moves.push({ axis: 'y', amt: vy, from: s, dur, curve: 'arrive' });
    }
    if (a.out !== 'none' && a.outDur > 0) {
      const dur = Math.min(a.outDur, d);
      fx.fades.push({ dir: 'out', from: e - dur, dur });
      const [vx, vy] = slideVec(a.out, W, H);
      if (vx) fx.moves.push({ axis: 'x', amt: vx, from: e - dur, dur, curve: 'leave' });
      if (vy) fx.moves.push({ axis: 'y', amt: -vy, from: e - dur, dur, curve: 'leave' });
    }
  }
  if (track && track.main) {
    const i = track.clips.indexOf(c);
    const prev = track.clips[i - 1], next = track.clips[i + 1];
    if (prev && c.trans) {
      const td = transDur(prev, c), ty = c.trans.type;
      if (ty === 'dissolve') fx.fades.push({ dir: 'in', from: s, dur: td });
      else if (ty === 'black') fx.fades.push({ dir: 'in', from: s, dur: td / 2 });
      else if (PUSH[ty]) {
        const [ux, uy] = PUSH[ty];
        if (ux) fx.moves.push({ axis: 'x', amt: ux * W, from: s, dur: td, curve: 'pushIn' });
        if (uy) fx.moves.push({ axis: 'y', amt: uy * H, from: s, dur: td, curve: 'pushIn' });
      }
    }
    if (next && next.trans) {
      const td = transDur(c, next), ty = next.trans.type;
      if (ty === 'black') fx.fades.push({ dir: 'out', from: e - td / 2, dur: td / 2 });
      else if (PUSH[ty]) {
        const [ux, uy] = PUSH[ty];
        if (ux) fx.moves.push({ axis: 'x', amt: -ux * W, from: e - td, dur: td, curve: 'pushOut' });
        if (uy) fx.moves.push({ axis: 'y', amt: -uy * H, from: e - td, dur: td, curve: 'pushOut' });
      }
    }
  }
  return fx;
}

// Состояние в момент t (для превью)
function animState(c, t, W, H, track) {
  const fx = clipFx(c, track, W, H);
  const out = { alpha: 1, dx: 0, dy: 0 };
  for (const f of fx.fades) {
    const p = clamp((t - f.from) / f.dur, 0, 1);
    out.alpha *= f.dir === 'in' ? p : 1 - p;
  }
  for (const m of fx.moves) {
    const p = clamp((t - m.from) / m.dur, 0, 1);
    out[m.axis === 'x' ? 'dx' : 'dy'] += m.amt * CURVES[m.curve].f(p);
  }
  return out;
}

// Затухания звука (локальное время клипа): собственные + от переходов
function audioFades(c, track) {
  const d = clipDur(c);
  const res = [];
  if (c.fadeIn > 0) res.push({ dir: 'in', from: 0, dur: Math.min(c.fadeIn, d) });
  if (c.fadeOut > 0) res.push({ dir: 'out', from: d - Math.min(c.fadeOut, d), dur: Math.min(c.fadeOut, d) });
  if (track && track.main) {
    const i = track.clips.indexOf(c);
    const prev = track.clips[i - 1], next = track.clips[i + 1];
    if (prev && c.trans) { const td = transDur(prev, c); res.push({ dir: 'in', from: 0, dur: c.trans.type === 'black' ? td / 2 : td }); }
    if (next && next.trans) { const td = transDur(c, next); const dd = next.trans.type === 'black' ? td / 2 : td; res.push({ dir: 'out', from: d - dd, dur: dd }); }
  }
  return res;
}
function audioGainAt(c, track, lt) {
  let g = 1;
  for (const f of audioFades(c, track)) {
    const p = clamp((lt - f.from) / f.dur, 0, 1);
    g *= f.dir === 'in' ? p : 1 - p;
  }
  return g;
}

// ---------------------------------------------------------------- громкость: ключевые кадры
// c.vkeys = [{ s: время источника, v: громкость 0–2 }] по возрастанию s; без кадров — c.volume
function volAt(c, lt) {
  const K = c.vkeys;
  if (!K || !K.length) return c.volume;
  if (K.length === 1) return K[0].v;
  const s = srcAt(c, lt);
  if (s <= K[0].s) return K[0].v;
  const last = K[K.length - 1];
  if (s >= last.s) return last.v;
  let i = 0;
  while (i < K.length - 2 && K[i + 1].s <= s) i++;
  const A = K[i], B = K[i + 1];
  return A.v + (B.v - A.v) * (s - A.s) / Math.max(1e-6, B.s - A.s);
}
function volKeyIndex(c, lt) {
  if (!c.vkeys) return -1;
  const s = srcAt(c, lt), tol = 0.5 / (store.p ? store.p.fps : 30) * rateAt(c, lt);
  return c.vkeys.findIndex(k => Math.abs(k.s - s) <= tol);
}
function setVol(c, v, lt) {
  if (!c.vkeys || !c.vkeys.length) { c.volume = v; return; }
  let i = volKeyIndex(c, lt);
  if (i < 0) { c.vkeys.push({ s: srcAt(c, lt), v }); c.vkeys.sort((a, b) => a.s - b.s); i = volKeyIndex(c, lt); }
  c.vkeys[i].v = v;
}
function toggleVolKey(c, lt) {
  c.vkeys = c.vkeys || [];
  const i = volKeyIndex(c, lt);
  if (i >= 0) { const v = c.vkeys[i].v; c.vkeys.splice(i, 1); if (!c.vkeys.length) { c.volume = v; delete c.vkeys; } return false; }
  c.vkeys.push({ s: srcAt(c, lt), v: volAt(c, lt) });
  c.vkeys.sort((a, b) => a.s - b.s);
  return true;
}

// ---------------------------------------------------------------- авто-приглушение музыки
// c.duck = { on, amount (дБ, отрицательное) }: клип тише, пока звучит голос — озвучка, звук видео,
// «только голос» нейросети. Голос ищем по волне (100 пиков/с, нормирована по пику файла).
// Отрезки голоса склеиваются через короткие паузы; спад 0,12 с до начала и подъём 0,35 с после конца.
const DUCK_ATTACK = 0.12, DUCK_RELEASE = 0.35;
const Duck = {
  cache: null,
  isVoice(c, tr) {
    if (tr.muted || c.muted || c.disabled || (c.duck && c.duck.on)) return false;
    if (!(c.kind === 'video' || c.kind === 'audio')) return false;
    const m = store.media(c.mediaId);
    if (!m || !m.hasAudio || c.voiceMode === 'bg') return false;
    return !!(m.voice || m.type === 'video' || c.voiceMode === 'voice');
  },
  // отрезки голоса на таймлайне [[a, b], …]
  intervals() {
    if (this.cache) return this.cache;
    const BIN = 0.01, THR = 40;
    const dur = store.duration(), n = Math.ceil(dur / BIN) + 1;
    const act = new Uint8Array(n);
    for (const tr of store.p.tracks) for (const c of tr.clips) {
      if (!this.isVoice(c, tr)) continue;
      const w = assets[c.mediaId] && assets[c.mediaId].wave;
      if (!w) continue;
      const i0 = Math.max(0, Math.floor(c.start / BIN)), i1 = Math.min(n, Math.ceil(clipEnd(c) / BIN));
      for (let i = i0; i < i1; i++) {
        const lt = i * BIN - c.start;
        if (volAt(c, lt) < 0.05) continue;
        const k = Math.floor(srcAt(c, lt) * 100);
        if (w[k] > THR) act[i] = 1;
      }
    }
    const out = [], gap = DUCK_ATTACK + DUCK_RELEASE + 0.05;
    let a = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && act[i]) { if (a < 0) a = i; continue; }
      if (a >= 0) {
        const A = a * BIN, B = i * BIN;
        const last = out[out.length - 1];
        if (last && A - last[1] < gap) last[1] = B; else out.push([A, B]);
        a = -1;
      }
    }
    return (this.cache = out.filter(([A, B]) => B - A >= 0.08));
  },
  gainAt(c, t) {
    if (!c.duck || !c.duck.on) return 1;
    const G = Math.pow(10, (c.duck.amount ?? -14) / 20);
    let env = 0;
    for (const [A, B] of this.intervals()) {
      if (t < A - DUCK_ATTACK) break;
      if (t > B + DUCK_RELEASE) continue;
      env = Math.max(env, clamp((t - A + DUCK_ATTACK) / DUCK_ATTACK, 0, 1) * clamp((B + DUCK_RELEASE - t) / DUCK_RELEASE, 0, 1));
    }
    return 1 - (1 - G) * env;
  },
  // то же для ffmpeg (t — время таймлайна)
  expr(c) {
    const G = Math.pow(10, (c.duck.amount ?? -14) / 20);
    const s = c.start, e = clipEnd(c);
    const parts = this.intervals().filter(([A, B]) => B + DUCK_RELEASE > s && A - DUCK_ATTACK < e)
      .map(([A, B]) => `clip((t-${(A - DUCK_ATTACK).toFixed(3)})/${DUCK_ATTACK},0,1)*clip((${(B + DUCK_RELEASE).toFixed(3)}-t)/${DUCK_RELEASE},0,1)`);
    return parts.length ? `1-${(1 - G).toFixed(5)}*(${parts.join('+')})` : null;
  },
};
['project', 'thumbs', 'media'].forEach(ev => bus.on(ev, () => { Duck.cache = null; }));

// ---------------------------------------------------------------- текст
const measureCtx = document.createElement('canvas').getContext('2d');
function fontString(st, size) {
  return `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : '400 '}${size}px "${st.font}", "Adwaita Sans", "Segoe UI", sans-serif`;
}
function textLayout(c) {
  const st = c.style;
  const lines = String(c.text || ' ').split('\n');
  measureCtx.font = fontString(st, st.size);
  const ls = st.letterSpacing || 0;
  const widths = lines.map(l => measureCtx.measureText(l).width + Math.max(0, [...l].length - 1) * ls);
  const lh = st.size * (st.lineHeight || 1.2);
  const pad = st.bgOpacity > 0 ? st.size * 0.28 : st.size * 0.08;
  const sw = st.strokeWidth > 0 ? st.strokeWidth : 0;
  const w = Math.max(10, ...widths) + pad * 2 + sw * 2;
  const hh = lines.length * lh + pad * 2 + sw * 2;
  return { lines, widths, lh, pad, w, h: hh, sw };
}
function measureText(c) { return textLayout(c); }

// Рисует текстовый клип; ctx в координатах проекта, умноженных на k
let textLayer = null;
function drawText(ctx, c, W, H, k, anim, time) {
  const st = c.style, L = textLayout(c), t = tfAt(c, time);
  const a = anim || { alpha: 1, dx: 0, dy: 0 };
  if (is3d(t)) { draw3d(ctx, c, W, H, k, a, time, (x, cs, an) => drawText(x, cs, W, H, k, an, time)); return; }
  const bl = blendOf(c);
  if (bl) {
    // тень, обводка и заливка смешиваются с кадром один раз, целым слоем — как в экспорте
    const cv = ctx.canvas;
    if (!textLayer) textLayer = document.createElement('canvas');
    if (textLayer.width !== cv.width || textLayer.height !== cv.height) { textLayer.width = cv.width; textLayer.height = cv.height; }
    const x = textLayer.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
    x.setTransform(ctx.getTransform());
    drawText(x, { ...c, blend: null }, W, H, k, anim, time);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
    ctx.globalCompositeOperation = bl.css; ctx.drawImage(textLayer, 0, 0);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.globalAlpha = clamp(t.opacity * a.alpha, 0, 1);
  ctx.translate((W / 2 + t.x + a.dx) * k, (H / 2 + t.y + a.dy) * k);
  ctx.rotate(t.rotation * Math.PI / 180);
  ctx.scale(t.scale * t.sx * k, t.scale * t.sy * k);
  const x0 = -L.w / 2, y0 = -L.h / 2;
  if (st.bgOpacity > 0) {
    ctx.fillStyle = hexA(st.bgColor, st.bgOpacity / 100);
    roundRect(ctx, x0, y0, L.w, L.h, st.size * 0.18);
    ctx.fill();
  }
  ctx.font = fontString(st, st.size);
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = (st.letterSpacing || 0) + 'px';
  ctx.lineJoin = 'round';
  // текстовые аниматоры: каждая буква рисуется отдельно (ae.js)
  if (time != null && textAnimOn(c)) { drawTextGlyphs(ctx, c, L, time - c.start, t.scale * k); ctx.restore(); return; }
  for (let i = 0; i < L.lines.length; i++) {
    const lw = L.widths[i];
    let x;
    if (st.align === 'left') x = x0 + L.pad + L.sw;
    else if (st.align === 'right') x = -x0 - L.pad - L.sw - lw;
    else x = -lw / 2;
    const y = y0 + L.pad + L.sw + L.lh * (i + 0.5);
    if (st.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = st.size * 0.12 * t.scale * k;
      ctx.shadowOffsetY = st.size * 0.04 * t.scale * k;
      ctx.fillStyle = st.color;
      ctx.fillText(L.lines[i], x, y);
      ctx.restore();
    }
    if (st.strokeWidth > 0) {
      ctx.strokeStyle = st.strokeColor;
      ctx.lineWidth = st.strokeWidth * 2;
      ctx.strokeText(L.lines[i], x, y);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(L.lines[i], x, y);
    if (st.underline) ctx.fillRect(x, y + st.size * 0.42, lw, Math.max(2, st.size * 0.06));
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

// Рисует медиа-клип (видео/картинку) на ctx
// ---------------------------------------------------------------- хромакей
// c.chroma = { on, color: '#00ff00', strength 0–100, soft 0–100, spill 0–100 }
// Превью повторяет ffmpeg: chromakey (расстояние по UV в BT.601, среднее по окну 3×3, мягкий край) + despill.
// UV — полный диапазон, целочисленно как RGB_TO_U/RGB_TO_V в ffmpeg (им же ffmpeg переводит цвет ключа).
const keyU = (r, g, b) => ((-173 * r - 339 * g + 512 * b + 511) >> 10) + 128;
const keyV = (r, g, b) => ((512 * r - 429 * g - 83 * b + 511) >> 10) + 128;
const DEFAULT_CHROMA = { on: false, color: '#00ff00', strength: 40, soft: 20, spill: 50 };
function chromaParams(ch) {
  const n = parseInt(ch.color.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  return {
    hex: ch.color.slice(1),
    ku: keyU(r, g, b),
    kv: keyV(r, g, b),
    sim: Math.max(0.00001, ch.strength / 100 * 0.3),
    blend: ch.soft / 100 * 0.2,
    // отсвет убираем для зелёного или синего фона — как у ffmpeg despill
    spill: ch.spill > 0 && Math.max(g, b) > r ? { green: g >= b, amt: ch.spill / 100 } : null,
  };
}
function chromaOn(c) { return !!(c.chroma && c.chroma.on); }

const keyCv = document.createElement('canvas');
const keyCtx = keyCv.getContext('2d', { willReadFrequently: true });
let keyBuf = null, keyBuf2 = null;
function chromaKeyed(src, srcRect, w, h, ch) {
  w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
  if (w > 1280) { h = Math.round(h * 1280 / w); w = 1280; }
  if (keyCv.width !== w || keyCv.height !== h) { keyCv.width = w; keyCv.height = h; } else keyCtx.clearRect(0, 0, w, h);
  if (srcRect) keyCtx.drawImage(src, srcRect[0], srcRect[1], srcRect[2], srcRect[3], 0, 0, w, h);
  else keyCtx.drawImage(src, 0, 0, w, h);
  const img = keyCtx.getImageData(0, 0, w, h), d = img.data, N = w * h;
  if (!keyBuf || keyBuf.length < N) { keyBuf = new Float32Array(N); keyBuf2 = new Float32Array(N); }
  const P = chromaParams(ch), D = keyBuf, T = keyBuf2, norm = 1 / (255 * 255 * 2);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const du = keyU(r, g, b) - P.ku, dv = keyV(r, g, b) - P.kv;
    D[i] = Math.sqrt((du * du + dv * dv) * norm);
  }
  // среднее по 3×3 (края — повтор крайних пикселей), раздельно по строкам и столбцам
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) T[o + x] = D[o + (x ? x - 1 : 0)] + D[o + x] + D[o + (x < w - 1 ? x + 1 : x)];
  }
  const blend = P.blend, sim = P.sim, sp = P.spill;
  for (let y = 0; y < h; y++) {
    const up = (y ? y - 1 : 0) * w, o = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const diff = (T[up + x] + T[o + x] + T[dn + x]) / 9;
      const a = blend > 0.0001 ? Math.min(1, Math.max(0, (diff - sim) / blend)) : (diff > sim ? 1 : 0);
      const j = (o + x) * 4;
      if (sp) {
        const r = d[j], g = d[j + 1], b = d[j + 2];
        if (sp.green) { const m = g - (r + b) * 0.5; if (m > 0) d[j + 1] = Math.max(0, g - m * sp.amt); }
        else { const m = b - (r + g) * 0.5; if (m > 0) d[j + 2] = Math.max(0, b - m * sp.amt); }
      }
      d[j + 3] = Math.round(d[j + 3] * a);
    }
  }
  keyCtx.putImageData(img, 0, 0);
  return keyCv;
}
// цепочка ffmpeg для экспорта (после scale до размера слоя)
function chromaFilters(c) {
  if (!chromaOn(c)) return [];
  const P = chromaParams(c.chroma);
  // через RGB, как браузер в превью (цвета вне охвата обрезаются одинаково), затем YUV BT.601 для chromakey
  const out = ['format=rgb24', 'scale=out_color_matrix=bt601:out_range=pc', 'format=yuva444p',
    `chromakey=color=0x${P.hex}:similarity=${P.sim.toFixed(5)}:blend=${P.blend.toFixed(5)}`, 'format=rgba'];
  if (P.spill) out.push(`despill=type=${P.spill.green ? 'green' : 'blue'}:mix=0.5:expand=0:red=0:blue=${P.spill.green ? 0 : -P.spill.amt}:green=${P.spill.green ? -P.spill.amt : 0}:brightness=0:alpha=0`);
  return out;
}

// ---------------------------------------------------------------- режимы наложения
// css — операция canvas для превью, ff — режим фильтра blend в ffmpeg (формулы совпадают с W3C Compositing)
const BLENDS = [
  { id: 'normal', name: 'Обычный', css: 'source-over' },
  { id: 'screen', name: 'Экран', css: 'screen', ff: 'screen' },
  { id: 'multiply', name: 'Умножение', css: 'multiply', ff: 'multiply' },
  { id: 'overlay', name: 'Перекрытие', css: 'overlay', ff: 'overlay' },
  { id: 'lighten', name: 'Осветление', css: 'lighten', ff: 'lighten' },
  { id: 'darken', name: 'Затемнение', css: 'darken', ff: 'darken' },
  { id: 'add', name: 'Сложение', css: 'lighter', ff: 'addition' },
  { id: 'difference', name: 'Разница', css: 'difference', ff: 'difference' },
];
const BLEND_BY_ID = Object.fromEntries(BLENDS.map(b => [b.id, b]));
const blendOf = (c) => BLEND_BY_ID[c.blend] && c.blend !== 'normal' ? BLEND_BY_ID[c.blend] : null;

// ---------------------------------------------------------------- маски
// c.mask = { type, x, y, w, h, rot, feather, round, invert }: центр (x, y) и размер (w, h) — доли размера клипа,
// поворот в градусах, растушёвка и скругление 0–100. Маска считается в кадре клипа после отражения
// и двигается вместе с клипом. Одна и та же картинка маски (maskCanvas) идёт и в превью, и в экспорт.
const MASKS = [
  { id: 'none', name: 'Нет', icon: 'maskNone' },
  { id: 'line', name: 'Линия', icon: 'maskLine' },
  { id: 'mirror', name: 'Зеркало', icon: 'maskMirror' },
  { id: 'circle', name: 'Круг', icon: 'maskCircle' },
  { id: 'rect', name: 'Прямоуг.', icon: 'maskRect' },
  { id: 'heart', name: 'Сердце', icon: 'maskHeart' },
  { id: 'star', name: 'Звезда', icon: 'maskStar' },
  { id: 'pen', name: 'Перо', icon: 'maskPen' },
];
const DEFAULT_MASK = { type: 'none', x: 0, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0, round: 0, invert: false };
const maskOn = (c) => !!(c.mask && c.mask.type && c.mask.type !== 'none' && (c.mask.type !== 'pen' || (c.mask.pts && c.mask.pts.length >= 3)));
const maskTyped = (c) => !!(c.mask && c.mask.type && c.mask.type !== 'none');
// контур фигуры в координатах: центр (0,0), размер фигуры fw × fh
function maskPath(x, m, fw, fh, big) {
  x.beginPath();
  if (m.type === 'circle') x.ellipse(0, 0, Math.max(0.5, fw / 2), Math.max(0.5, fh / 2), 0, 0, Math.PI * 2);
  else if (m.type === 'rect') { const r = clamp(m.round / 100, 0, 1) * Math.min(fw, fh) / 2; roundRect(x, -fw / 2, -fh / 2, fw, fh, Math.max(0.01, r)); }
  else if (m.type === 'line') x.rect(-big, 0, big * 2, big);
  else if (m.type === 'mirror') x.rect(-big, -fh / 2, big * 2, fh);
  else if (m.type === 'heart') {
    const w = fw / 2, h = fh / 2;
    x.moveTo(0, h);
    x.bezierCurveTo(-w * 0.3, h * 0.72, -w, h * 0.25, -w, -h * 0.3);
    x.bezierCurveTo(-w, -h * 0.85, -w * 0.3, -h * 1.05, 0, -h * 0.5);
    x.bezierCurveTo(w * 0.3, -h * 1.05, w, -h * 0.85, w, -h * 0.3);
    x.bezierCurveTo(w, h * 0.25, w * 0.3, h * 0.72, 0, h);
    x.closePath();
  } else if (m.type === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.4 : 1;
      const px = Math.cos(a) * r * fw / 2, py = Math.sin(a) * r * fh / 2 + fh * 0.05;
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    }
    x.closePath();
  }
}
// Картинка маски w × h: белый с прозрачностью (1 — видно). Кэш по параметрам и размеру.
const maskCache = new Map();
// s — время источника (для анимированной маски пером)
function maskCanvas(m, w, h, s) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const pts = m.type === 'pen' ? penPtsAt(m, s) : null;
  const key = [m.type, m.x, m.y, m.w, m.h, m.rot, m.feather, m.round, m.invert, w, h, pts ? JSON.stringify(pts) : ''].join();
  if (maskCache.has(key)) return maskCache.get(key);
  if (maskCache.size > 24) maskCache.delete(maskCache.keys().next().value);
  const sig = clamp(m.feather / 100, 0, 1) * 0.12 * Math.min(w, h), pad = Math.ceil(sig * 3) + 2;
  const A = document.createElement('canvas'); A.width = w + pad * 2; A.height = h + pad * 2;
  const x = A.getContext('2d');
  if (sig > 0.3) x.filter = `blur(${sig.toFixed(2)}px)`;
  x.translate(pad + w / 2 + m.x * w, pad + h / 2 + m.y * h);
  x.rotate(m.rot * Math.PI / 180);
  x.fillStyle = '#fff';
  if (pts) penPath(x, pts, w, h);
  else maskPath(x, m, Math.abs(m.w) * w, Math.abs(m.h) * h, (w + h + pad * 2) * 2);
  x.fill();
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const o = out.getContext('2d');
  if (m.invert) { o.fillStyle = '#fff'; o.fillRect(0, 0, w, h); o.globalCompositeOperation = 'destination-out'; }
  o.drawImage(A, -pad, -pad);
  maskCache.set(key, out);
  return out;
}
// для ffmpeg: маска яркостью на чёрном (белый — видно)
function maskLumaPng(m, w, h, s) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const x = cv.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.drawImage(maskCanvas(m, w, h, s), 0, 0);
  return cv.toDataURL('image/png');
}

let maskLayer = null;
function drawMedia(ctx, c, src, W, H, k, anim, srcRect, time) {
  const b = clipBox(c, W, H, time);
  const a = anim || { alpha: 1, dx: 0, dy: 0 };
  if (is3d(b)) { draw3d(ctx, c, W, H, k, a, time, (x, cs, an) => drawMedia(x, cs, src, W, H, k, an, srcRect, time)); return; }
  const bl = blendOf(c);
  ctx.save();
  ctx.globalAlpha = clamp(b.op * a.alpha, 0, 1);
  if (bl) ctx.globalCompositeOperation = bl.css;
  ctx.translate((b.cx + a.dx) * k, (b.cy + a.dy) * k);
  ctx.rotate(b.rot * Math.PI / 180);
  if (chromaOn(c) && !Player.pickingRaw) { src = chromaKeyed(src, srcRect, b.w * k, b.h * k, c.chroma); srcRect = null; }
  const dw = b.w * k, dh = b.h * k;
  const roto = Roto.on(c) && !Player.pickingRaw ? Roto.frameFor(c, time) : null;
  const fxOn = clipFxOn(c);
  if ((maskOn(c) || roto || fxOn) && !Player.pickingRaw) {
    // слой клипа: цвет, размытие, отражение — затем маска и эффекты клипа (как в экспорте), и уже слой — на кадр
    let w = Math.max(1, Math.round(dw)), hh = Math.max(1, Math.round(dh));
    const pre = fxOn ? fxPreScale(c) : null;
    if (pre) { const ms = mediaSize(c), f = Math.min(W / ms.w, H / ms.h) * pre * k; w = Math.max(1, Math.round(ms.w * f)); hh = Math.max(1, Math.round(ms.h * f)); }
    if (!maskLayer) maskLayer = document.createElement('canvas');
    if (maskLayer.width !== w || maskLayer.height !== hh) { maskLayer.width = w; maskLayer.height = hh; }
    const x = maskLayer.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
    x.clearRect(0, 0, w, hh);
    x.translate(w / 2, hh / 2);
    x.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
    x.filter = canvasFilter(c, k);
    if (srcRect) x.drawImage(src, srcRect[0], srcRect[1], srcRect[2], srcRect[3], -w / 2, -hh / 2, w, hh);
    else x.drawImage(src, -w / 2, -hh / 2, w, hh);
    x.filter = 'none';
    // вырезанный нейросетью объект: маска в кадре источника (до отражения)
    if (roto) { x.globalCompositeOperation = c.roto.invert ? 'destination-out' : 'destination-in'; x.drawImage(roto, -w / 2, -hh / 2, w, hh); }
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = 'destination-in';
    if (maskOn(c)) x.drawImage(maskCanvas(c.mask, w, hh, time != null ? srcTime(c, time) : null), 0, 0);
    x.globalCompositeOperation = 'source-over';
    if (fxOn) applyClipFx(x, c, time);
    ctx.drawImage(maskLayer, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    return;
  }
  ctx.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
  ctx.filter = canvasFilter(c, k);
  if (srcRect) ctx.drawImage(src, srcRect[0], srcRect[1], srcRect[2], srcRect[3], -dw / 2, -dh / 2, dw, dh);
  else ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
