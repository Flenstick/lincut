// Эффекты и «эдит»-переходы.
// Каждый эффект = список операций (ops). Операции анимируются выражениями от T (локальное время, с).
// Выражения пишутся в общем синтаксисе, который одинаково понимают JS (превью) и ffmpeg (экспорт).

// ---------------------------------------------------------------- выражения
const FXF = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, pow: Math.pow, exp: Math.exp, sqrt: Math.sqrt,
  floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max,
  clip: (x, a, b) => Math.min(Math.max(x, a), b),
  iff: (c, a, b) => (c ? a : b),
  lt: (a, b) => (a < b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0), lte: (a, b) => (a <= b ? 1 : 0), gte: (a, b) => (a >= b ? 1 : 0),
  mod: (a, b) => a - Math.floor(a / b) * b,
  PI: Math.PI,
};

// Макросы разворачиваются в обычные функции (одинаково для JS и ffmpeg)
const FX_MACROS = {
  rnd: (x) => `(sin((${x})*12.9898)*43758.5453-floor(sin((${x})*12.9898)*43758.5453))`,
  sm: (x) => `(clip(${x},0,1)*clip(${x},0,1)*(3-2*clip(${x},0,1)))`,
};
function fxExpand(s) {
  s = String(s);
  for (const [name, fn] of Object.entries(FX_MACROS)) {
    for (;;) {
      const re = new RegExp(`(^|[^A-Za-z_])${name}\\(`);
      const m = re.exec(s);
      if (!m) break;
      const start = m.index + m[1].length, open = start + name.length;
      let depth = 0, i = open;
      for (; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && --depth === 0) break; }
      const arg = fxExpand(s.slice(open + 1, i));
      s = s.slice(0, start) + fn(arg) + s.slice(i + 1);
    }
  }
  return s;
}
// Мини-компилятор выражений (без eval: CSP запрещает new Function)
function fxCompile(src) {
  const toks = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|(.))/gy;
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] != null) toks.push({ t: 'n', v: parseFloat(m[1]) });
    else if (m[2] != null) toks.push({ t: 'id', v: m[2] });
    else if (m[3] != null && m[3].trim()) toks.push({ t: 'op', v: m[3] });
  }
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const expect = (v) => { const t = next(); if (!t || t.v !== v) throw new Error('Ожидалось ' + v + ' в ' + src); };
  function primary() {
    const t = next();
    if (!t) throw new Error('Неожиданный конец: ' + src);
    if (t.t === 'n') { const v = t.v; return () => v; }
    if (t.t === 'op' && t.v === '(') { const e = expr(); expect(')'); return e; }
    if (t.t === 'op' && t.v === '-') { const e = unary(); return (T) => -e(T); }
    if (t.t === 'op' && t.v === '+') return unary();
    if (t.t === 'id') {
      if (t.v === 'T') return (T) => T;
      if (t.v === 'PI') return () => Math.PI;
      const fname = t.v === 'if' ? 'iff' : t.v;
      const f = FXF[fname];
      if (typeof f !== 'function') throw new Error('Неизвестно: ' + t.v);
      expect('(');
      const args = [];
      if (!(peek() && peek().v === ')')) { args.push(expr()); while (peek() && peek().v === ',') { next(); args.push(expr()); } }
      expect(')');
      if (args.length === 1) { const [a0] = args; return (T) => f(a0(T)); }
      if (args.length === 2) { const [a0, a1] = args; return (T) => f(a0(T), a1(T)); }
      if (args.length === 3) { const [a0, a1, a2] = args; return (T) => f(a0(T), a1(T), a2(T)); }
      return (T) => f(...args.map(a => a(T)));
    }
    throw new Error('Неожиданный символ ' + t.v + ' в ' + src);
  }
  const unary = primary;
  function term() {
    let l = unary();
    while (peek() && (peek().v === '*' || peek().v === '/')) {
      const op = next().v, r = unary(), a = l;
      l = op === '*' ? (T) => a(T) * r(T) : (T) => a(T) / r(T);
    }
    return l;
  }
  function expr() {
    let l = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) {
      const op = next().v, r = term(), a = l;
      l = op === '+' ? (T) => a(T) + r(T) : (T) => a(T) - r(T);
    }
    return l;
  }
  const e = expr();
  if (i < toks.length) throw new Error('Лишние символы в ' + src);
  return e;
}
const fxFnCache = new Map();
function fxFn(expr) {
  if (typeof expr === 'number') return () => expr;
  let f = fxFnCache.get(expr);
  if (!f) {
    const raw = fxCompile(fxExpand(expr));
    f = (T) => { const v = raw(T); return isFinite(v) ? v : 0; };
    fxFnCache.set(expr, f);
  }
  return f;
}
const fxVal = (expr, T, def = 0) => (expr == null ? def : fxFn(expr)(T));
// Для ffmpeg: подставляем выражение времени вместо T
function fxFF(expr, Tsub) {
  if (typeof expr === 'number') return String(expr);
  return fxExpand(expr).replace(/(^|[^A-Za-z_])T(?![A-Za-z_0-9])/g, `$1${Tsub}`);
}
const isStatic = (expr) => expr == null || typeof expr === 'number' || !/(^|[^A-Za-z_])T(?![A-Za-z_0-9])/.test(String(expr));
const n4 = (v) => +(+v).toFixed(4);

// Матрицы цвета для анимированного микшера
function satMatrixExpr(s) {
  const S = `(${s})`;
  return [`0.213+0.787*${S}`, `0.715-0.715*${S}`, `0.072-0.072*${S}`, `0.213-0.213*${S}`, `0.715+0.285*${S}`, `0.072-0.072*${S}`, `0.213-0.213*${S}`, `0.715-0.715*${S}`, `0.072+0.928*${S}`];
}
function hueMatrixExpr(a) {
  const c = `cos(${a})`, s = `sin(${a})`;
  return [
    `0.213+${c}*0.787-${s}*0.213`, `0.715-${c}*0.715-${s}*0.715`, `0.072-${c}*0.072+${s}*0.928`,
    `0.213-${c}*0.213+${s}*0.143`, `0.715+${c}*0.285+${s}*0.140`, `0.072-${c}*0.072-${s}*0.283`,
    `0.213-${c}*0.213-${s}*0.787`, `0.715-${c}*0.715+${s}*0.715`, `0.072+${c}*0.928+${s}*0.072`,
  ];
}

// ---------------------------------------------------------------- текстуры (общие для превью и экспорта)
const TEXTURES = {
  // затемнение краёв
  vignette(ctx, w, h, p) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#e6e6e6'); g.addColorStop(1, '#2a2a2a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  },
  // тёплая засветка плёнки (ширина 2×, прокручивается)
  leak(ctx, w, h) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const blobs = [[0.12, 0.3, 0.55, '255,120,40'], [0.35, 0.8, 0.45, '255,60,90'], [0.6, 0.2, 0.5, '255,190,80'], [0.85, 0.7, 0.55, '255,90,30'], [1.0, 0.35, 0.4, '255,140,60']];
    ctx.globalCompositeOperation = 'lighter';
    for (const [x, y, r, c] of blobs) {
      const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * h * 1.4);
      g.addColorStop(0, `rgba(${c},0.95)`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  },
  // строки развёртки (высота 2×, прокручивается)
  scan(ctx, w, h) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    const step = Math.max(2, Math.round(h / 540 * 3));
    ctx.fillStyle = '#5a5a5a';
    for (let y = 0; y < h; y += step * 2) ctx.fillRect(0, y, w, step);
  },
  // кинематографичные полосы 2.39:1
  bars(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const bh = Math.max(0, Math.round((h - w / 2.39) / 2));
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, bh); ctx.fillRect(0, h - bh, w, bh);
  },
};
const texCache = new Map();
function textureCanvas(gen, w, h, mw = 1, mh = 1) {
  const key = [gen, w, h, mw, mh].join();
  let c = texCache.get(key);
  if (!c) {
    if (texCache.size > 40) texCache.clear();
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * mw)); c.height = Math.max(1, Math.round(h * mh));
    TEXTURES[gen](c.getContext('2d'), c.width, c.height);
    texCache.set(key, c);
  }
  return c;
}

// ---------------------------------------------------------------- искажения (карты пикселей)
// f(nx, ny, ar) -> [sx, sy] в долях кадра (или null — за пределами)
const WARPS = {
  fisheye: (k) => (nx, ny, ar) => polar(nx, ny, ar, (rn, th) => [Math.pow(rn, 1 + k), th]),
  bulge: (k) => (nx, ny, ar) => polar(nx, ny, ar, (rn, th) => [rn < 0.7 ? rn * (1 - k * Math.pow(1 - rn / 0.7, 2)) : rn, th]),
  pinch: (k) => (nx, ny, ar) => polar(nx, ny, ar, (rn, th) => [rn < 0.7 ? rn * (1 + k * Math.pow(1 - rn / 0.7, 2)) : rn, th]),
  swirl: (k) => (nx, ny, ar) => polar(nx, ny, ar, (rn, th) => [rn, rn < 0.8 ? th - k * 4 * Math.pow(1 - rn / 0.8, 2) : th]),
  // калейдоскоп: зеркальные сектора, берём картинку из верхней половины кадра
  kaleido: (k) => (nx, ny, ar) => polar(nx, ny, ar, (rn, th, R) => {
    const n = Math.round(6 + k * 6), seg = Math.PI * 2 / n;
    const a = Math.abs(FXF.mod(th, seg) - seg / 2);
    // зеркальный отскок радиуса, чтобы не выходить за кадр
    let r = FXF.mod(rn * 1.2, 2); if (r > 1) r = 2 - r;
    return [r * 0.49 / R, -Math.PI / 2 - seg / 2 + a];
  }),
  ripple: (k) => (nx, ny) => [nx + 0.012 * k * Math.sin(ny * 40), ny + 0.012 * k * Math.sin(nx * 40)],
  // широкоугольник: бочка, растянутая так, чтобы края кадра остались заполнены
  barrel: (k) => (nx, ny, ar) => polar(nx, ny, ar, (rn, th) => [rn * (1 + k * rn * rn) / (1 + k), th]),
  // ---- анимированные (ph — фаза 0..1, кадры карты меняются по времени)
  // желе: кадр качается и сминается волной, края прибиты
  jelly: (k, ph) => (nx, ny) => {
    const a = 2 * Math.PI * ph, e = Math.sin(Math.PI * nx) * Math.sin(Math.PI * ny);
    return [nx + 0.035 * k * e * Math.sin(a + ny * 5), ny + 0.035 * k * e * Math.sin(a * 2 + nx * 4 + 1)];
  },
  // растянутые полосы: в нескольких полосах строки «тянутся» от точки вправо или влево
  stretch: (k, ph) => {
    const seed = Math.round(ph * 997) + 1, R = (i) => FXF.mod(Math.sin((seed * 7.13 + i) * 12.9898) * 43758.5453, 1);
    const bands = [];
    const n = 2 + Math.round(3 * R(0));
    for (let i = 0; i < n; i++) bands.push([R(i * 4 + 1), 0.02 + (0.05 + 0.1 * k) * R(i * 4 + 2), 0.15 + 0.7 * R(i * 4 + 3), R(i * 4 + 4) < 0.5]);
    return (nx, ny) => {
      for (const [y0, hgt, x0, right] of bands) {
        if (ny < y0 || ny >= y0 + hgt) continue;
        if (right ? nx > x0 : nx < x0) return [x0, ny];
      }
      return [nx, ny];
    };
  },
  // срыв синхронизации кассеты: пара полос съезжает вбок
  tracking: (k, ph) => {
    const y0 = FXF.mod(ph * 1.7 + 0.35, 1.2) - 0.1, y1 = FXF.mod(ph * 0.9 + 0.8, 1.1) - 0.05;
    return (nx, ny) => {
      let dx = 0;
      if (ny > y0 && ny < y0 + 0.035) dx += 0.03 * k * Math.sin((ny - y0) / 0.035 * Math.PI);
      if (ny > y1 && ny < y1 + 0.012) dx -= 0.02 * k;
      return [nx - dx, ny];
    };
  },
};
const WARP_ANIM = new Set(['jelly', 'stretch', 'tracking']);
// кадр анимированной карты в момент T: floor(T·rate) mod n (одинаково в превью и экспорте)
const warpFrame = (op, T) => FXF.mod(Math.floor(T * op.rate + 1e-6), op.n);
function polar(nx, ny, ar, fn) {
  const dx = (nx - 0.5) * ar, dy = ny - 0.5;
  const R = Math.hypot(ar / 2, 0.5);
  const rn = Math.hypot(dx, dy) / R, th = Math.atan2(dy, dx);
  const [r2, t2] = fn(rn, th, R);
  return [0.5 + Math.cos(t2) * r2 * R / ar, 0.5 + Math.sin(t2) * r2 * R];
}
const warpCache = new Map();
function warpMap(name, k, w, h, fr = 0, n = 1) {
  const key = [name, k, w, h, fr, n].join();
  let m = warpCache.get(key);
  if (!m) {
    if (warpCache.size > 32) warpCache.clear();
    const f = WARPS[name](k, fr / n), ar = w / h;
    // индекс исходного пикселя (−1 — за кадром): один массив вместо двух — кадров у анимированных карт много
    m = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = f((x + 0.5) / w, (y + 0.5) / h, ar);
      const sx = r ? Math.floor(r[0] * w) : -1, sy = r ? Math.floor(r[1] * h) : -1;
      m[y * w + x] = sx < 0 || sy < 0 || sx >= w || sy >= h ? -1 : sy * w + sx;
    }
    warpCache.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------- операции: превью (canvas)
// env: { W, H (пиксели холста), u (пикселей на единицу = H/1080), T, D, fps, state }
const chanFilterIds = {};
function chanFilter(ch) {
  const M = { r: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], g: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0] }[ch];
  const id = svgFilterId(M);
  svgPinned.add(id);
  return id;
}
function levelsOf(op, T) {
  const g = (ch, i) => fxVal(op[ch + i] ?? op['o' + i], T, i === '0' ? 0 : 1);
  return [g('r', '0'), g('r', '1'), g('g', '0'), g('g', '1'), g('b', '0'), g('b', '1')];
}
function camValues(op, T, W, H) {
  const z0 = fxVal(op.z, T, 1), x = fxVal(op.x, T, 0), y = fxVal(op.y, T, 0), r = fxVal(op.r, T, 0);
  const ar = Math.max(W / H, H / W);
  const z = op.cover ? z0 * (Math.abs(Math.cos(r)) + ar * Math.abs(Math.sin(r))) : z0;
  return { z, x, y, r };
}

// Размытие с продолжением краёв (как gblur в ffmpeg; у canvas за краем прозрачно — края темнели бы)
const padC = {};
function padBlur(src, W, H, px) {
  const p = Math.ceil(px * 3) + 2, PW = W + 2 * p, PH = H + 2 * p;
  const a = padC.a || (padC.a = document.createElement('canvas'));
  if (a.width !== PW || a.height !== PH) { a.width = PW; a.height = PH; }
  const x = a.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(src, 0, 0, W, H, p, p, W, H);
  x.drawImage(src, 0, 0, 1, H, 0, p, p, H);
  x.drawImage(src, W - 1, 0, 1, H, p + W, p, p, H);
  x.drawImage(a, 0, p, PW, 1, 0, 0, PW, p);
  x.drawImage(a, 0, p + H - 1, PW, 1, 0, p + H, PW, p);
  const b = padC.b || (padC.b = document.createElement('canvas'));
  if (b.width !== W || b.height !== H) { b.width = W; b.height = H; }
  const y = b.getContext('2d', { willReadFrequently: true });
  y.clearRect(0, 0, W, H);
  y.filter = `blur(${px.toFixed(2)}px)`;
  y.drawImage(a, -p, -p);
  y.filter = 'none';
  return b;
}
// Собель как в ffmpeg (vf_convolution: зеркальные края, sqrt(gx²+gy²) с отбрасыванием дроби)
// (возвращает модуль градиента без округления — усиление scale применяется потом, как параметр sobel=scale)
function sobel(g, W, H) {
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const ym = (y === 0 ? 1 : y - 1) * W, yp = (y + 1 >= H ? H - 2 : y + 1) * W, y0 = y * W;
    for (let x = 0; x < W; x++) {
      const xm = x === 0 ? 1 : x - 1, xp = x + 1 >= W ? W - 2 : x + 1;
      const a = -g[ym + xm] - 2 * g[ym + x] - g[ym + xp] + g[yp + xm] + 2 * g[yp + x] + g[yp + xp];
      const b = -g[ym + xm] + g[ym + xp] - 2 * g[y0 + xm] + 2 * g[y0 + xp] - g[yp + xm] + g[yp + xp];
      o[y0 + x] = Math.sqrt(a * a + b * b);
    }
  }
  return o;
}
const GRAY_K = 0.3333;
// яркость для контуров — как colorchannelmixer с коэффициентами 1/3 (каждое слагаемое округляется отдельно)
function grayOf(d, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = Math.round(d[j] * GRAY_K) + Math.round(d[j + 1] * GRAY_K) + Math.round(d[j + 2] * GRAY_K);
    g[i] = v > 255 ? 255 : v;
  }
  return g;
}
const ownC = {};
function ownCanvas(key, W, H, read) {
  let c = ownC[key];
  if (!c) { c = ownC[key] = document.createElement('canvas'); c.getContext('2d', { willReadFrequently: !!read }); }
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  return c;
}

// ---------------------------------------------------------------- кадры-наложения (процедурные и готовые из Blender)
// Процедурные рисуются в размер кадра одинаково для превью и экспорта (в экспорте — в PNG).
const seedRnd = (s) => () => { s = (s * 16807 + 11) % 2147483647; return s / 2147483647; };
function pixelText(ctx, text, cx, cy, hgt, color, font = '700 10px "IBM Plex Mono", monospace') {
  // «пиксельный» шрифт: рисуем крошечными буквами и увеличиваем без сглаживания
  const t = document.createElement('canvas'); const tx = t.getContext('2d');
  tx.font = font; const w = Math.ceil(tx.measureText(text).width) + 2;
  t.width = w; t.height = 14;
  tx.font = font; tx.textBaseline = 'middle'; tx.fillStyle = color; tx.fillText(text, 1, 7);
  // обрезаем полупрозрачные пиксели — края букв ступеньками
  const d = tx.getImageData(0, 0, t.width, t.height);
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] > 110 ? 255 : 0;
  tx.putImageData(d, 0, 0);
  const k = hgt / 14;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(t, Math.round(cx - w * k / 2), Math.round(cy - 7 * k), Math.round(w * k), Math.round(14 * k));
  ctx.restore();
}
const SEQGEN = {
  // экран ошибки: знак «!», надпись ERROR и красные полосы; кадры отличаются полосами и сдвигом
  error(ctx, w, h, i) {
    const r = seedRnd(1234 + i * 77), u = h / 1080, cx = w / 2 + (i === 1 ? 10 * u : 0), cy = h * 0.44;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(160,0,0,0.28)'; ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 7; k++) {
      ctx.fillStyle = `rgba(255,${40 + r() * 60 | 0},${40 + r() * 40 | 0},${0.25 + r() * 0.4})`;
      ctx.fillRect(0, r() * h, w, (4 + r() * 26) * u);
    }
    const s = 150 * u;
    ctx.lineJoin = 'round'; ctx.lineWidth = 18 * u; ctx.strokeStyle = '#ff2a2a'; ctx.fillStyle = 'rgba(255,40,40,0.25)';
    ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s * 1.1, cy + s * 0.8); ctx.lineTo(cx - s * 1.1, cy + s * 0.8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ff2a2a';
    ctx.fillRect(cx - 11 * u, cy - s * 0.45, 22 * u, s * 0.75); ctx.fillRect(cx - 11 * u, cy + s * 0.43, 22 * u, 22 * u);
    pixelText(ctx, 'ERROR', cx, cy + s * 1.45, 110 * u, '#ff2a2a');
  },
  // «GAME OVER» пиксельным шрифтом; второй кадр — со сдвигом каналов
  gameover(ctx, w, h, i) {
    const u = h / 1080, cy = h * 0.46, sz = Math.min(170 * u, w / 7.5);
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, cy - sz, 0, cy + sz);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, cy - sz * 1.2, w, sz * 2.4);
    if (i === 1) { pixelText(ctx, 'GAME OVER', w / 2 - 8 * u, cy, sz, '#00e5ff'); pixelText(ctx, 'GAME OVER', w / 2 + 8 * u, cy, sz, '#ff1744'); }
    pixelText(ctx, 'GAME OVER', w / 2, cy + 6 * u, sz, '#3a0000');
    pixelText(ctx, 'GAME OVER', w / 2, cy, sz, '#e8141c');
    pixelText(ctx, 'PRESS ANY KEY', w / 2, cy + sz * 0.95, sz * 0.26, 'rgba(255,255,255,0.85)');
  },
  // молнии на чёрном (накладываются «экраном»)
  bolt(ctx, w, h, i) {
    const r = seedRnd(9001 + i * 131), u = h / 1080;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const path = (x0, y0, x1, y1, dev, depth, out) => {
      if (depth === 0) { out.push([x1, y1]); return; }
      const mx = (x0 + x1) / 2 + (r() - 0.5) * dev, my = (y0 + y1) / 2 + (r() - 0.5) * dev * 0.3;
      path(x0, y0, mx, my, dev / 2, depth - 1, out); path(mx, my, x1, y1, dev / 2, depth - 1, out);
    };
    const bolts = [];
    const x0 = w * (0.2 + r() * 0.6), x1 = x0 + (r() - 0.5) * w * 0.5, y1 = h * (0.65 + r() * 0.35);
    const main = [[x0, -10 * u]]; path(x0, -10 * u, x1, y1, w * 0.18, 7, main); bolts.push([main, 1]);
    for (let b = 0; b < 3; b++) {
      const s = main[4 + Math.floor(r() * (main.length - 8))], L = h * (0.15 + r() * 0.25), a = Math.PI / 2 + (r() - 0.5) * 1.6;
      const br = [s]; path(s[0], s[1], s[0] + Math.cos(a) * L, s[1] + Math.sin(a) * L, L * 0.5, 5, br); bolts.push([br, 0.55]);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [pts, k] of bolts) {
      for (const [lw, col, blur] of [[26, 'rgba(90,120,255,0.35)', 40], [10, 'rgba(150,180,255,0.8)', 16], [3.5, '#ffffff', 4]]) {
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = blur * u; ctx.strokeStyle = col; ctx.lineWidth = lw * u * k;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const [x, y] of pts) ctx.lineTo(x, y); ctx.stroke(); ctx.restore();
      }
    }
  },
};
const seqCache = new Map();
function seqFrame(op, i, W, H) {
  const src = op.src;
  if (src.gen) {
    const key = [src.gen, i, W, H].join();
    let c = seqCache.get(key);
    if (!c) {
      if (seqCache.size > 60) for (const k of seqCache.keys()) { if (!k.startsWith('dir:')) seqCache.delete(k); }
      c = document.createElement('canvas'); c.width = W; c.height = H;
      SEQGEN[src.gen](c.getContext('2d'), W, H, i);
      seqCache.set(key, c);
    }
    return c;
  }
  const key = `dir:${src.dir}/${i}`;
  let im = seqCache.get(key);
  if (!im) {
    im = new Image();
    im.onload = () => { im._ok = true; seqLoaded(); };
    im.src = seqPath(src, i);
    seqCache.set(key, im);
  }
  return im._ok ? im : null;
}
// кадр подгрузился — перерисовать проигрыватель и плитки эффектов (не чаще раза в 150 мс)
let seqLoadT = null;
function seqLoaded() {
  if (seqLoadT) return;
  seqLoadT = setTimeout(() => {
    seqLoadT = null;
    if (typeof Player !== 'undefined' && store.p) Player.requestRender();
    document.querySelectorAll('.fx-tile canvas').forEach(c => c._redraw && c._redraw());
  }, 150);
}
const seqPath = (src, i, base = '') => `${base}fx/${src.dir}/${String(i).padStart(4, '0')}.${src.ext || 'webp'}`;
// заранее подгрузить кадры набора (чтобы при первом проигрывании не было пропусков)
function seqPreload(op) { if (op.src && op.src.dir) for (let i = 0; i < op.src.n; i++) seqFrame(op, i, 1, 1); }
const seqIndex = (op, T) => Math.round(fxVal(op.idx, T, -1));
const shiftT = (expr, dt) => typeof expr === 'number' || expr == null ? expr : String(expr).replace(/(^|[^A-Za-z_])T(?![A-Za-z_0-9])/g, `$1(T-${dt})`);

const FXOPS = {
  camera: {
    pre(ctx, src, op, e) {
      const { z, x, y, r } = camValues(op, e.T, e.W, e.H);
      ctx.save();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, e.W, e.H);
      ctx.translate(e.W / 2, e.H / 2); ctx.scale(z, z); ctx.rotate(-r); ctx.translate(-e.W / 2 - x * e.W, -e.H / 2 - y * e.H);
      ctx.drawImage(src, 0, 0, e.W, e.H);
      ctx.restore();
    },
  },
  levels: {
    pre(ctx, src, op, e) {
      const L = levelsOf(op, e.T);
      const [r0, r1, g0, g1, b0, b1] = L;
      ctx.save();
      ctx.filter = `url(#${svgFilterId([r1 - r0, 0, 0, r0, 0, g1 - g0, 0, g0, 0, 0, b1 - b0, b0].map(q => Math.round(q * 400) / 400))})`;
      ctx.drawImage(src, 0, 0, e.W, e.H);
      ctx.restore();
    },
  },
  mix: {
    pre(ctx, src, op, e) {
      const m = op.m.map(x => Math.round(fxVal(x, e.T) * 400) / 400);
      ctx.save();
      ctx.filter = `url(#${svgFilterId([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0])})`;
      ctx.drawImage(src, 0, 0, e.W, e.H);
      ctx.restore();
    },
  },
  lut: {
    pre(ctx, src, op, e) {
      ctx.save();
      ctx.filter = `url(#${svgFilterId(op.M)})`;
      ctx.drawImage(src, 0, 0, e.W, e.H);
      ctx.restore();
    },
  },
  blur: {
    pre(ctx, src, op, e) {
      const px = Math.max(0, fxVal(op.s, e.T) * e.u);
      ctx.drawImage(src, 0, 0, e.W, e.H);
      if (px < 0.05) return;
      ctx.save();
      if (op.dir === 'h') {
        // гауссово размытие по горизонтали — усреднение сдвинутых копий
        const n = 15; let acc = 0;
        for (let i = 0; i < n; i++) {
          const off = (i / (n - 1) * 2 - 1) * 2.5 * px;
          const w = Math.exp(-(off * off) / (2 * px * px));
          acc += w;
          ctx.globalAlpha = w / acc;
          ctx.drawImage(src, off, 0, e.W, e.H);
        }
      } else {
        ctx.filter = `blur(${px.toFixed(2)}px)`;
        ctx.drawImage(src, 0, 0, e.W, e.H);
      }
      ctx.restore();
    },
  },
  rgb: {
    pre(ctx, src, op, e) {
      const o = (k) => Math.round(fxVal(op[k], e.T) * e.u);
      const rh = o('rh'), rv = o('rv'), gh = o('gh'), gv = o('gv'), bh = o('bh'), bv = o('bv');
      if (!rh && !rv && !gh && !gv && !bh && !bv) { ctx.drawImage(src, 0, 0, e.W, e.H); return; }
      ctx.save();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, e.W, e.H);
      ctx.globalCompositeOperation = 'lighter';
      for (const [ch, dx, dy] of [['r', rh, rv], ['g', gh, gv], ['b', bh, bv]]) {
        ctx.filter = `url(#${chanFilter(ch)})`;
        ctx.drawImage(src, dx, dy, e.W, e.H);
      }
      ctx.restore();
    },
  },
  // как noise=alls=s:allf=t+u в ffmpeg: равномерный шум ±s/2, свой у каждого канала и кадра
  noise: {
    pre(ctx, src, op, e) {
      const s = Math.round(clamp(fxVal(op.s, e.T), 0, 100));
      if (s <= 0) { ctx.drawImage(src, 0, 0, e.W, e.H); return; }
      const W = e.W, H = e.H, A = src.getContext('2d').getImageData(0, 0, W, H), a = A.data, h = s >> 1;
      let x = (Math.floor(e.T * e.fps) * 2654435761 + 1) >>> 0 || 1;
      for (let i = 0; i < a.length; i += 4) {
        for (let c = i; c < i + 3; c++) {
          x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
          const v = a[c] + ((x >>> 0) % s) - h;
          a[c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
      ctx.putImageData(A, 0, 0);
    },
  },
  pixel: {
    pre(ctx, src, op, e) {
      const b = Math.max(1, Math.floor(fxVal(op.b, e.T) * e.u));
      if (b <= 1) { ctx.drawImage(src, 0, 0, e.W, e.H); return; }
      const sw = Math.ceil(e.W / b), sh = Math.ceil(e.H / b);
      const t = e.scratch(sw, sh), tx = t.getContext('2d');
      tx.imageSmoothingEnabled = true; tx.imageSmoothingQuality = 'high';
      tx.drawImage(src, 0, 0, sw * b, sh * b, 0, 0, sw, sh);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(t, 0, 0, sw, sh, 0, 0, sw * b, sh * b);
      ctx.restore();
    },
  },
  glow: {
    pre(ctx, src, op, e) {
      ctx.drawImage(src, 0, 0, e.W, e.H);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = clamp(fxVal(op.o, e.T, 0.5), 0, 1);
      ctx.filter = `blur(${(fxVal(op.s, e.T, 10) * e.u).toFixed(2)}px)`;
      ctx.drawImage(src, 0, 0, e.W, e.H);
      ctx.restore();
    },
  },
  texture: {
    pre(ctx, src, op, e) {
      ctx.drawImage(src, 0, 0, e.W, e.H);
      const tex = textureCanvas(op.gen, e.W, e.H, op.mw || 1, op.mh || 1);
      const sx = fxVal(op.sx, e.T, 0) * e.W, sy = fxVal(op.sy, e.T, 0) * e.H;
      ctx.save();
      ctx.globalCompositeOperation = op.mode === 'normal' ? 'source-over' : op.mode;
      ctx.globalAlpha = clamp(fxVal(op.o, e.T, 1), 0, 1);
      ctx.drawImage(tex, sx, sy, e.W, e.H, 0, 0, e.W, e.H);
      ctx.restore();
    },
  },
  layout: {
    pre(ctx, src, op, e) {
      const { W, H } = e;
      ctx.save();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      const k = op.kind;
      if (k === 'mirrorH') {
        const hw = W / 2;
        ctx.drawImage(src, 0, 0, hw, H, 0, 0, hw, H);
        ctx.translate(W, 0); ctx.scale(-1, 1);
        ctx.drawImage(src, 0, 0, hw, H, 0, 0, hw, H);
      } else if (k === 'mirrorV') {
        const hh = H / 2;
        ctx.drawImage(src, 0, 0, W, hh, 0, 0, W, hh);
        ctx.translate(0, H); ctx.scale(1, -1);
        ctx.drawImage(src, 0, 0, W, hh, 0, 0, W, hh);
      } else if (k === 'grid2' || k === 'grid3') {
        const n = k === 'grid2' ? 2 : 3, tw = Math.ceil(W / n), th = Math.ceil(H / n);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) ctx.drawImage(src, 0, 0, W, H, i * tw, j * th, tw, th);
      } else if (k === 'triple') {
        const sw = Math.floor(W / 3), x0 = Math.floor((W - sw) / 2);
        for (let i = 0; i < 3; i++) ctx.drawImage(src, x0, 0, sw, H, i * sw, 0, sw, H);
      }
      ctx.restore();
    },
  },
  trail: {
    pre(ctx, src, op, e) {
      const st = e.state;
      const d = fxVal(op.d, e.T, 0.9);
      const fresh = !st.hist || st.hist.width !== e.W || st.hist.height !== e.H || st.lastT == null || e.T < st.lastT || e.T - st.lastT > 0.25;
      if (fresh) {
        st.hist = document.createElement('canvas'); st.hist.width = e.W; st.hist.height = e.H;
        st.hist.getContext('2d').drawImage(src, 0, 0);
      } else if (e.T !== st.lastT) {
        const hx = st.hist.getContext('2d');
        const tmp = e.scratch(e.W, e.H), tx = tmp.getContext('2d');
        // hist × decay: рисуем с прозрачностью поверх чёрного (SVG-фильтры на отсоединённом canvas не работают)
        tx.save(); tx.fillStyle = '#000'; tx.fillRect(0, 0, e.W, e.H); tx.globalAlpha = d; tx.drawImage(st.hist, 0, 0); tx.restore();
        hx.save(); hx.globalCompositeOperation = 'copy'; hx.drawImage(tmp, 0, 0, e.W, e.H, 0, 0, e.W, e.H); hx.restore();
        hx.save(); hx.globalCompositeOperation = 'lighten'; hx.drawImage(src, 0, 0); hx.restore();
      }
      st.lastT = e.T;
      ctx.drawImage(st.hist, 0, 0, e.W, e.H);
    },
  },
  warp: {
    pre(ctx, src, op, e) {
      const w = Math.round(e.W), h = Math.round(e.H);
      const map = op.n ? warpMap(op.name, op.k, w, h, warpFrame(op, e.T), op.n) : warpMap(op.name, op.k, w, h);
      const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
      const out = ctx.createImageData(w, h), od = out.data;
      for (let i = 0, n = w * h; i < n; i++) {
        const q = map[i], o = i * 4;
        if (q < 0) { od[o + 3] = 255; continue; }
        const s = q * 4;
        od[o] = sd[s]; od[o + 1] = sd[s + 1]; od[o + 2] = sd[s + 2]; od[o + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    },
  },
  // локальный контраст (HDR): A + (A − размытое)·k
  hdr: {
    pre(ctx, src, op, e) {
      const W = e.W, H = e.H, k = fxVal(op.k, e.T, 1);
      const A = src.getContext('2d').getImageData(0, 0, W, H), a = A.data;
      const B = padBlur(src, W, H, Math.max(0.5, fxVal(op.s, e.T, 20) * e.u)).getContext('2d').getImageData(0, 0, W, H).data;
      for (let i = 0; i < a.length; i += 4) {
        for (let c = i; c < i + 3; c++) { const v = a[c] + (a[c] - B[c]) * k; a[c] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0; }
      }
      ctx.putImageData(A, 0, 0);
    },
  },
  // светящиеся контуры: картинка·base + контуры·цвет·sharp + размытые контуры·цвет·glow
  edges: {
    pre(ctx, src, op, e) {
      const W = e.W, H = e.H, n = W * H;
      const A = src.getContext('2d').getImageData(0, 0, W, H), a = A.data;
      let gr = grayOf(a, n);
      if (op.pre) {
        // размыть серое перед поиском контуров — остаются крупные линии, а не шум текстур
        const pc = ownCanvas('edgePre', W, H), px = pc.getContext('2d'), P = px.createImageData(W, H), pd = P.data;
        for (let i = 0, j = 0; i < n; i++, j += 4) { pd[j] = pd[j + 1] = pd[j + 2] = gr[i]; pd[j + 3] = 255; }
        px.putImageData(P, 0, 0);
        const bd = padBlur(pc, W, H, Math.max(0.5, op.pre * e.u)).getContext('2d').getImageData(0, 0, W, H).data;
        for (let i = 0, j = 0; i < n; i++, j += 4) gr[i] = bd[j];
      }
      const E = sobel(gr, W, H);
      // sobel=scale=k:delta=d в ffmpeg: min(255, ⌊|∇|·k + d⌋), потом цвет (коэффициенты ≤ 1)
      const c = op.c, kb = op.base ?? 1, ss = n4(op.sharp), sg = n4(op.glow), dl = op.cut || 0;
      const cut = (v) => { v = Math.floor(v + dl); return v > 255 ? 255 : v < 0 ? 0 : v; };
      const gc = ownCanvas('edgeGlow', W, H), gx = gc.getContext('2d');
      const G = gx.createImageData(W, H), g = G.data;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = cut(E[i] * sg);
        g[j] = Math.round(v * c[0]); g[j + 1] = Math.round(v * c[1]); g[j + 2] = Math.round(v * c[2]); g[j + 3] = 255;
      }
      gx.putImageData(G, 0, 0);
      const B = padBlur(gc, W, H, Math.max(0.5, fxVal(op.s, e.T, 8) * e.u)).getContext('2d').getImageData(0, 0, W, H).data;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = cut(E[i] * ss);
        for (let q = 0; q < 3; q++) {
          const s = Math.round(a[j + q] * kb) + Math.round(v * c[q]) + B[j + q];
          a[j + q] = s > 255 ? 255 : s;
        }
      }
      ctx.putImageData(A, 0, 0);
    },
  },
  // среднее нескольких копий кадра с разной «камерой» (круговое/радиальное размытие, смаз, двоение)
  accum: {
    pre(ctx, src, op, e) {
      const t = ownCanvas('accum', e.W, e.H), tx = t.getContext('2d');
      ctx.save();
      op.copies.forEach((cam, i) => {
        FXOPS.camera.pre(tx, src, cam, e);
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(t, 0, 0);
      });
      ctx.restore();
    },
  },
  // последовательность кадров поверх (номер кадра — выражение от T; −1 — ничего)
  seq: {
    pre(ctx, src, op, e) {
      ctx.drawImage(src, 0, 0, e.W, e.H);
      if (op.src.dir && !seqCache.has(`dir:${op.src.dir}/0`)) seqPreload(op);
      const i = seqIndex(op, e.T);
      if (i < 0) return;
      const im = seqFrame(op, i, Math.round(e.W), Math.round(e.H));
      if (!im) return;
      const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
      const k = Math.max(e.W / iw, e.H / ih), dw = iw * k, dh = ih * k;
      ctx.save();
      ctx.globalCompositeOperation = op.mode === 'add' ? 'lighter' : op.mode === 'screen' ? 'screen' : 'source-over';
      ctx.globalAlpha = clamp(fxVal(op.o, e.T, 1), 0, 1);
      ctx.drawImage(im, (e.W - dw) / 2, (e.H - dh) / 2, dw, dh);
      ctx.restore();
    },
  },
};
const READS = new Set(['warp', 'hdr', 'edges', 'noise']);

// Применить набор операций к ctx (canvas в пикселях W×H)
const FXRun = {
  tmp: null, scratchC: null,
  copy(canvas) {
    if (!this.tmp) this.tmp = document.createElement('canvas');
    const t = this.tmp;
    if (t.width !== canvas.width || t.height !== canvas.height) { t.width = canvas.width; t.height = canvas.height; }
    const x = t.getContext('2d', { willReadFrequently: false });
    x.globalCompositeOperation = 'copy';
    x.drawImage(canvas, 0, 0);
    x.globalCompositeOperation = 'source-over';
    return t;
  },
  scratch(w, h) {
    if (!this.scratchC) this.scratchC = document.createElement('canvas');
    const c = this.scratchC;
    if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
    c.getContext('2d').clearRect(0, 0, w, h);
    return c;
  },
  apply(ctx, ops, T, D, state, boost = 1) {
    const canvas = ctx.canvas;
    const env = { W: canvas.width, H: canvas.height, u: canvas.height / 1080 * boost, T, D, fps: store.p ? store.p.fps : 30, state: state || {}, scratch: (w, h) => this.scratch(w, h) };
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    for (const op of ops) {
      const src = READS.has(op.type) ? this.copyReadable(canvas) : this.copy(canvas);
      FXOPS[op.type].pre(ctx, src, op, env);
    }
    ctx.restore();
  },
  copyReadable(canvas) {
    if (!this.rd) this.rd = document.createElement('canvas');
    const t = this.rd;
    if (t.width !== canvas.width || t.height !== canvas.height) { t.width = canvas.width; t.height = canvas.height; }
    const x = t.getContext('2d', { willReadFrequently: true });
    x.drawImage(canvas, 0, 0);
    return t;
  },
};

// ---------------------------------------------------------------- каталог эффектов
const FX_CATS = [
  { id: 'trend', name: 'В\u00a0тренде' },
  { id: 'camera', name: 'Камера' },
  { id: 'light', name: 'Свет' },
  { id: 'glitch', name: 'Глитч' },
  { id: 'retro', name: 'Ретро' },
  { id: 'color', name: 'Цвет' },
  { id: 'split', name: 'Экран' },
  { id: 'distort', name: 'Искажение' },
];
const SPEEDLESS = { speed: false };

// камера «Трясущаяся камера»: рывки + смаз движения (копии кадра чуть в прошлом)
function shakyCam(p) {
  const A = n4(0.03 * p.I), f = (k) => n4(k * p.V);
  const cam = { type: 'camera', z: n4(1.1 + 0.06 * p.I),
    x: `${A}*(sin(T*${f(19)})*0.55+sin(T*${f(31)}+1.3)*0.3+(rnd(floor(T*${f(9)}))-0.5)*0.5)`,
    y: `${A}*(sin(T*${f(23)}+0.7)*0.55+sin(T*${f(41)}+2.1)*0.3+(rnd(floor(T*${f(9)})+5)-0.5)*0.5)`,
    r: `${n4(0.012 * p.I)}*sin(T*${f(13)}+0.4)` };
  return [{ type: 'accum', copies: [0, 1, 2, 3, 4].map(i => ({ type: 'camera', z: cam.z, x: shiftT(cam.x, n4(i * 0.012)), y: shiftT(cam.y, n4(i * 0.012)), r: shiftT(cam.r, n4(i * 0.012)) })) }];
}
// n копий: i-я получает t = 0..1
const copiesOf = (n, fn) => Array.from({ length: n }, (_, i) => ({ type: 'camera', ...fn(i / (n - 1)) }));
const CURTAIN = { dir: 'curtain', n: 48, fps: 30, ext: 'webp' };
const BOOM = { dir: 'explosion', n: 60, fps: 30, ext: 'webp' };

// p: { I: сила 0..1, V: скорость (0.25..4), D: длительность, AR: W/H }
const EFFECTS = [
  // --- в тренде (как в CapCut)
  { id: 'edgeGlow', cat: 'trend', name: 'Сияние по контуру', speed: false, ops: p => [{ type: 'edges', c: [1, 0.93, 0.8], pre: 1.5, cut: -30, sharp: n4(0.3 + 0.4 * p.I), glow: n4(0.8 + 1.2 * p.I), s: 10, base: 1 }, { type: 'glow', s: 22, o: n4(0.12 + 0.2 * p.I) }] },
  { id: 'neonEdge', cat: 'trend', name: 'Неоновый контур', speed: false, ops: p => [{ type: 'edges', c: [1, 0.22, 0.9], pre: 2, cut: -45, sharp: n4(0.6 + 0.6 * p.I), glow: n4(1.5 + 1.5 * p.I), s: 12, base: n4(0.55 - 0.3 * p.I) }] },
  { id: 'shakyCam', cat: 'trend', name: 'Трясущаяся камера', ops: shakyCam },
  { id: 'darkVignette', cat: 'trend', name: 'Тёмная виньетка', speed: false, ops: p => [
    { type: 'lut', M: adjustMatrix({ saturation: -100, contrast: 20, brightness: -6 }) },
    { type: 'texture', gen: 'vignette', mode: 'multiply', o: 1 },
    { type: 'texture', gen: 'vignette', mode: 'multiply', o: n4(0.4 + 0.6 * p.I) }] },
  { id: 'stretch', cat: 'trend', name: 'Растянутый', ops: p => [{ type: 'warp', name: 'stretch', k: n4(0.4 + 0.6 * p.I), n: 8, rate: n4(8 * p.V) }] },
  { id: 'hdr', cat: 'trend', name: 'HDR', speed: false, ops: p => [{ type: 'hdr', s: 30, k: n4(0.5 + 1.0 * p.I) }, { type: 'lut', M: adjustMatrix({ saturation: 25 * p.I, contrast: 6 * p.I }) }] },
  { id: 'hdr2', cat: 'trend', name: 'HDR 2', speed: false, ops: p => [{ type: 'hdr', s: 6, k: n4(0.8 + 1.2 * p.I) }, { type: 'hdr', s: 45, k: n4(0.5 * p.I) }, { type: 'lut', M: adjustMatrix({ saturation: 35 * p.I, warmth: 10 * p.I, contrast: 8 }) }] },
  { id: 'ghost', cat: 'trend', name: 'Дрожащее изображение', ops: p => {
    const N = `floor(T*${n4(16 * p.V)})`, A = n4(0.035 * p.I);
    return [{ type: 'accum', copies: [{ type: 'camera', z: 1.04 }, { type: 'camera', z: n4(1.04 + 0.03 * p.I), x: `${A}*(rnd(${N})-0.5)`, y: `${A}*(rnd(${N}+7)-0.5)` }] },
      { type: 'rgb', rh: `${n4(-10 * p.I)}*rnd(${N}+3)`, bh: `${n4(10 * p.I)}*rnd(${N}+4)` }];
  } },
  { id: 'spinBlur', cat: 'trend', name: 'Круговое размытие', speed: false, ops: p => {
    const a = 0.02 + 0.08 * p.I;
    return [{ type: 'accum', copies: copiesOf(9, t => ({ cover: true, r: n4(a * (t * 2 - 1)) })) }];
  } },
  { id: 'zoomBlur', cat: 'trend', name: 'Радиальное размытие', speed: false, ops: p => [{ type: 'accum', copies: copiesOf(10, t => ({ z: n4(1 + (0.04 + 0.2 * p.I) * t) })) }] },
  { id: 'flashBlur', cat: 'trend', name: 'Вспышка-размытие', ops: p => {
    const E = `exp(-mod(T,${n4(0.8 / p.V)})*${n4(6 * p.V)})`;
    return [{ type: 'accum', copies: copiesOf(8, t => ({ z: `1+${n4((0.1 + 0.25 * p.I) * t)}*${E}` })) }, { type: 'levels', o0: `${n4(0.7 * p.I)}*${E}` }];
  } },
  { id: 'error', cat: 'trend', name: 'Ошибка', ops: p => {
    const N = `floor(T*${n4(8 * p.V)})`, G = `lt(rnd(${N}+1),0.4)`;
    return [
      { type: 'lut', M: adjustMatrix({ saturation: -70, contrast: 25 }) },
      { type: 'levels', r0: 0.08, g1: n4(1 - 0.6 * p.I), b1: n4(1 - 0.6 * p.I) },
      { type: 'camera', z: 1.05, x: `${G}*(rnd(${N}+11)-0.5)*${n4(0.06 * p.I)}` },
      { type: 'rgb', rh: `${G}*(rnd(${N}+3)-0.5)*${n4(70 * p.I)}`, bh: `${G}*(rnd(${N}+5)-0.5)*${n4(70 * p.I)}` },
      { type: 'seq', src: { gen: 'error', n: 3 }, mode: 'normal', idx: `if(lt(rnd(${N}+9),0.15),-1,mod(${N},3))` }];
  } },
  { id: 'gameOver', cat: 'trend', name: 'Конец игры', ops: p => {
    const N = `floor(T*${n4(8 * p.V)})`;
    return [
      { type: 'lut', M: adjustMatrix({ saturation: -85, contrast: 15 }) },
      { type: 'levels', o1: `1-${n4(0.25 + 0.3 * p.I)}*sm(T*3)` },
      { type: 'texture', gen: 'scan', mode: 'multiply', mh: 2, o: 0.35, sy: `mod(T*0.2,1)` },
      { type: 'seq', src: { gen: 'gameover', n: 2 }, mode: 'normal', idx: `if(lt(T,0.2),-1,lt(rnd(${N}),0.18))` }];
  } },
  { id: 'betamax', cat: 'trend', name: 'Betamax', ops: p => [
    { type: 'lut', M: adjustMatrix({ saturation: -12, contrast: -10, warmth: 18, tint: 8, brightness: 4 }) },
    { type: 'blur', s: 1.3 },
    { type: 'rgb', rh: n4(-5 - 5 * p.I), bh: n4(3 + 3 * p.I), rv: 1 },
    { type: 'warp', name: 'tracking', k: n4(0.5 + p.I), n: 16, rate: n4(12 * p.V) },
    { type: 'noise', s: Math.round(8 + 10 * p.I) },
    { type: 'texture', gen: 'vignette', mode: 'multiply', o: 0.55 }] },
  { id: 'lightning', cat: 'trend', tileT: 0.05, name: 'Молния', ops: p => {
    const N = `floor(T*${n4(2.5 * p.V)})`, U = `mod(T*${n4(2.5 * p.V)},1)`;
    const S = `lt(rnd(${N}+2),0.7)*(lt(${U},0.06)+gt(${U},0.1)*lt(${U},0.22))`;
    return [
      { type: 'lut', M: adjustMatrix({ brightness: -18 * p.I, saturation: -25 * p.I, warmth: -20 * p.I, contrast: 10 }) },
      { type: 'levels', o0: `${n4(0.3 * p.I)}*${S}` },
      { type: 'seq', src: { gen: 'bolt', n: 6 }, mode: 'screen', idx: `if(${S},mod(${N},6),-1)` }];
  } },
  { id: 'showtime', cat: 'trend', name: 'Время показа', strength: false, ops: p => {
    // шторы открываются в начале; если эффект длинный — закрываются в конце
    const F = n4(CURTAIN.fps * p.V), L = CURTAIN.n - 1, open = `if(gte(floor(T*${F}),${L}),-1,floor(T*${F}))`;
    const back = p.D - L / F;
    return [{ type: 'seq', src: CURTAIN, mode: 'normal',
      idx: back > L / F + 0.3 ? `if(gt(T,${n4(back)}),min(floor((${n4(p.D)}-T)*${F}),${L}),${open})` : open }];
  } },
  { id: 'explosion', cat: 'trend', name: 'Взрыв', ops: p => {
    const F = n4(BOOM.fps * p.V), E = `exp(-T*${n4(3 * p.V)})`;
    return [
      { type: 'camera', z: n4(1.05 + 0.05 * p.I), x: `${n4(0.03 * p.I)}*${E}*sin(T*57)`, y: `${n4(0.03 * p.I)}*${E}*sin(T*71+1)` },
      { type: 'levels', o0: `${n4(0.6 * p.I)}*exp(-T*${n4(12 * p.V)})` },
      { type: 'seq', src: BOOM, mode: 'screen', o: n4(0.6 + 0.4 * p.I), idx: `if(lt(T*${F},${BOOM.n}),floor(T*${F}),-1)` }];
  } },
  { id: 'jelly', cat: 'trend', name: 'Желейное', ops: p => [{ type: 'warp', name: 'jelly', k: n4(0.4 + 0.9 * p.I), n: 24, rate: n4(24 * p.V) }] },
  { id: 'darken', cat: 'trend', tileT: 2.4, name: 'Затемнение', ops: p => [
    { type: 'levels', o1: `1-${n4(0.3 + 0.55 * p.I)}*sm(T/${n4(p.D)}*${n4(p.V)})` },
    { type: 'texture', gen: 'vignette', mode: 'multiply', o: `sm(T/${n4(p.D)}*${n4(1.5 * p.V)})` }] },
  { id: 'wideAngle', cat: 'trend', name: 'Широкоугольный', speed: false, ops: p => [{ type: 'warp', name: 'barrel', k: n4(0.15 + 0.45 * p.I) }, { type: 'texture', gen: 'vignette', mode: 'multiply', o: 0.45 }] },
  { id: 'brighten', cat: 'trend', tileT: 2.4, name: 'Осветление', ops: p => [
    { type: 'lut', M: adjustMatrix({ saturation: -15, contrast: -8 }) },
    { type: 'glow', s: 20, o: `${n4(0.3 + 0.4 * p.I)}*sm(T/${n4(p.D)}*${n4(2 * p.V)})` },
    { type: 'levels', o0: `${n4(0.3 * p.I)}*sm(T/${n4(p.D)}*${n4(p.V)})` }] },

  // --- камера
  { id: 'zoomPulse', cat: 'camera', name: 'Зум-пульс', ops: p => [{ type: 'camera', z: `1+${n4(0.18 * p.I)}*(0.5-0.5*cos(2*PI*T*${n4(1.2 * p.V)}))` }] },
  { id: 'beatZoom', cat: 'camera', name: 'Бит-зум', ops: p => [{ type: 'camera', z: `1+${n4(0.3 * p.I)}*exp(-mod(T,${n4(0.5 / p.V)})*${n4(9 * p.V)})` }] },
  { id: 'zoomKick', cat: 'camera', name: 'Зум-рывок', ops: p => [
    { type: 'camera', z: `1+${n4(0.35 * p.I)}*exp(-mod(T,${n4(0.6 / p.V)})*${n4(7 * p.V)})` },
    { type: 'blur', s: `${n4(14 * p.I)}*exp(-mod(T,${n4(0.6 / p.V)})*${n4(12 * p.V)})` }] },
  { id: 'shake', cat: 'camera', name: 'Тряска', ops: p => [{ type: 'camera', z: n4(1.06 + 0.06 * p.I), x: `${n4(0.025 * p.I)}*(sin(T*${n4(37 * p.V)})*0.6+sin(T*${n4(61 * p.V)}+1.7)*0.4)`, y: `${n4(0.025 * p.I)}*(sin(T*${n4(43 * p.V)}+0.5)*0.6+sin(T*${n4(71 * p.V)}+2.3)*0.4)` }] },
  { id: 'quake', cat: 'camera', name: 'Землетрясение', ops: p => [{ type: 'camera', cover: true, z: n4(1.12 + 0.08 * p.I), x: `${n4(0.05 * p.I)}*(sin(T*${n4(47 * p.V)})*0.6+sin(T*${n4(83 * p.V)}+1.1)*0.4)`, y: `${n4(0.05 * p.I)}*(sin(T*${n4(53 * p.V)}+0.4)*0.6+sin(T*${n4(97 * p.V)}+2.2)*0.4)`, r: `${n4(0.04 * p.I)}*sin(T*${n4(59 * p.V)}+0.9)` }] },
  { id: 'handheld', cat: 'camera', name: 'С рук', ops: p => [{ type: 'camera', cover: true, z: 1.06, x: `${n4(0.012 * p.I)}*(sin(T*${n4(1.3 * p.V)})+0.5*sin(T*${n4(2.9 * p.V)}+1))`, y: `${n4(0.012 * p.I)}*(sin(T*${n4(1.7 * p.V)}+2)+0.5*sin(T*${n4(3.3 * p.V)}))`, r: `${n4(0.008 * p.I)}*sin(T*${n4(1.1 * p.V)}+0.3)` }] },
  { id: 'sway', cat: 'camera', name: 'Покачивание', ops: p => [{ type: 'camera', cover: true, r: `${n4(0.07 * p.I)}*sin(2*PI*T*${n4(0.5 * p.V)})` }] },
  { id: 'kenIn', cat: 'camera', name: 'Наезд', ops: p => [{ type: 'camera', z: `1+${n4(0.3 * p.I)}*sm(T/${n4(p.D)})` }] },
  { id: 'kenOut', cat: 'camera', name: 'Отъезд', ops: p => [{ type: 'camera', z: `1+${n4(0.3 * p.I)}*(1-sm(T/${n4(p.D)}))` }] },
  { id: 'spin', cat: 'camera', name: 'Вращение', ops: p => [{ type: 'camera', cover: true, r: `T*${n4(2 * Math.PI * 0.5 * p.V * (0.3 + 0.7 * p.I))}` }] },
  { id: 'bounce', cat: 'camera', name: 'Прыжок', ops: p => [{ type: 'camera', z: n4(1 + 0.14 * p.I), y: `${n4(-0.06 * p.I)}*abs(sin(PI*T*${n4(2 * p.V)}))` }] },
  { id: 'drift', cat: 'camera', name: 'Дрейф', ops: p => [{ type: 'camera', z: n4(1.08 + 0.1 * p.I), x: `${n4(0.06 * p.I)}*sin(T*${n4(0.7 * p.V)})`, y: `${n4(0.03 * p.I)}*sin(T*${n4(0.5 * p.V)}+1)` }] },

  // --- свет
  { id: 'flash', cat: 'light', name: 'Вспышка', ops: p => [{ type: 'levels', o0: `${n4(0.95 * p.I)}*exp(-mod(T,${n4(0.5 / p.V)})*${n4(10 * p.V)})` }] },
  { id: 'strobe', cat: 'light', name: 'Стробоскоп', ops: p => [{ type: 'levels', o1: `1-${n4(0.9 * p.I)}*lt(mod(T*${n4(6 * p.V)},1),0.5)` }] },
  { id: 'flicker', cat: 'light', name: 'Мерцание', ops: p => [{ type: 'levels', o1: `1-${n4(0.45 * p.I)}*rnd(floor(T*${n4(14 * p.V)}))` }] },
  { id: 'glow', cat: 'light', name: 'Свечение', ops: p => [{ type: 'glow', s: n4(8 + 18 * p.I), o: n4(0.35 + 0.5 * p.I) }] },
  { id: 'dream', cat: 'light', name: 'Мечта', ops: p => [{ type: 'glow', s: 22, o: n4(0.7 * p.I) }, { type: 'levels', o0: n4(0.06 * p.I) }] },
  { id: 'leak', cat: 'light', name: 'Засветка', ops: p => [{ type: 'texture', gen: 'leak', mode: 'screen', mw: 2, o: `${n4(0.45 + 0.45 * p.I)}*(0.75+0.25*sin(T*${n4(1.3 * p.V)}))`, sx: `0.5+0.5*sin(T*${n4(0.35 * p.V)})` }] },
  { id: 'pulse', cat: 'light', name: 'Пульс света', ops: p => [{ type: 'levels', o0: `${n4(0.3 * p.I)}*(0.5-0.5*cos(2*PI*T*${n4(p.V)}))` }] },
  { id: 'darkPulse', cat: 'light', name: 'Тёмный пульс', ops: p => [{ type: 'levels', o1: `1-${n4(0.65 * p.I)}*(0.5-0.5*cos(2*PI*T*${n4(p.V)}))` }] },
  { id: 'vignette', cat: 'light', name: 'Виньетка', speed: false, ops: p => [{ type: 'texture', gen: 'vignette', mode: 'multiply', o: n4(0.4 + 0.6 * p.I) }] },
  { id: 'neon', cat: 'light', name: 'Неон', speed: false, ops: p => [{ type: 'lut', M: adjustMatrix({ saturation: 70 * p.I, contrast: 25 * p.I }) }, { type: 'glow', s: 16, o: n4(0.4 + 0.5 * p.I) }] },

  // --- глитч
  { id: 'rgbSplit', cat: 'glitch', name: 'RGB-сдвиг', speed: false, ops: p => [{ type: 'rgb', rh: n4(-14 * p.I), bh: n4(14 * p.I) }] },
  { id: 'rgbWave', cat: 'glitch', name: 'RGB-волна', ops: p => [{ type: 'rgb', rh: `${n4(-22 * p.I)}*sin(2*PI*T*${n4(1.5 * p.V)})`, bh: `${n4(22 * p.I)}*sin(2*PI*T*${n4(1.5 * p.V)})`, gv: `${n4(6 * p.I)}*cos(2*PI*T*${n4(1.5 * p.V)})` }] },
  { id: 'glitch', cat: 'glitch', name: 'Глитч', ops: p => {
    const N = `floor(T*${n4(12 * p.V)})`, G = `lt(rnd(${N}),0.45)`;
    return [
      { type: 'camera', z: 1.04, x: `${G}*(rnd(${N}+11)-0.5)*${n4(0.05 * p.I)}` },
      { type: 'rgb', rh: `${G}*(rnd(${N}+3)-0.5)*${n4(90 * p.I)}`, bh: `${G}*(rnd(${N}+5)-0.5)*${n4(90 * p.I)}`, gv: `${G}*(rnd(${N}+9)-0.5)*${n4(18 * p.I)}` },
      { type: 'levels', o1: `1-${G}*${n4(0.25 * p.I)}*rnd(${N}+13)` },
    ];
  } },
  { id: 'digital', cat: 'glitch', name: 'Цифровой шум', ops: p => [
    { type: 'noise', s: Math.round(10 + 30 * p.I) },
    { type: 'rgb', rh: `${n4(-8 * p.I)}*rnd(floor(T*${n4(20 * p.V)}))`, bh: `${n4(8 * p.I)}*rnd(floor(T*${n4(20 * p.V)})+1)` }] },
  { id: 'pixelGlitch', cat: 'glitch', name: 'Пиксель-глитч', ops: p => {
    const N = `floor(T*${n4(10 * p.V)})`;
    return [{ type: 'pixel', b: `1+lt(rnd(${N}),0.4)*${n4(4 + 40 * p.I)}*rnd(${N}+2)` }, { type: 'rgb', rh: `lt(rnd(${N}),0.4)*${n4(-10 * p.I)}`, bh: `lt(rnd(${N}),0.4)*${n4(10 * p.I)}` }];
  } },
  { id: 'vhs', cat: 'glitch', name: 'VHS', ops: p => [
    { type: 'lut', M: adjustMatrix({ saturation: 25, contrast: -10, warmth: 15 }) },
    { type: 'blur', s: 0.9 },
    { type: 'rgb', rh: n4(-4 - 5 * p.I), bh: n4(4 + 5 * p.I) },
    { type: 'noise', s: Math.round(6 + 12 * p.I) },
    { type: 'texture', gen: 'scan', mode: 'multiply', mh: 2, o: n4(0.3 + 0.3 * p.I), sy: `mod(T*${n4(0.15 * p.V)},1)` },
    { type: 'levels', o1: `1-0.07*rnd(floor(T*24))` }] },
  { id: 'scanlines', cat: 'glitch', name: 'Развёртка', ops: p => [{ type: 'texture', gen: 'scan', mode: 'multiply', mh: 2, o: n4(0.3 + 0.5 * p.I), sy: `mod(T*${n4(0.4 * p.V)},1)` }] },
  { id: 'tvStatic', cat: 'glitch', name: 'Помехи ТВ', ops: p => [{ type: 'lut', M: adjustMatrix({ saturation: -60 }) }, { type: 'noise', s: Math.round(25 + 50 * p.I) }, { type: 'levels', o1: `1-${n4(0.2 * p.I)}*rnd(floor(T*${n4(20 * p.V)}))` }] },

  // --- ретро
  { id: 'oldFilm', cat: 'retro', name: 'Старое кино', ops: p => [
    { type: 'lut', M: adjustMatrix({ sepia: 60, contrast: 10, saturation: -20 }) },
    { type: 'noise', s: Math.round(10 + 14 * p.I) },
    { type: 'texture', gen: 'vignette', mode: 'multiply', o: 0.8 },
    { type: 'levels', o1: `1-${n4(0.15 * p.I)}*rnd(floor(T*${n4(16 * p.V)}))` },
    { type: 'camera', z: 1.02, y: `${n4(0.004 * p.I)}*rnd(floor(T*24))` }] },
  { id: 'grain', cat: 'retro', name: 'Зерно', speed: false, ops: p => [{ type: 'noise', s: Math.round(8 + 32 * p.I) }] },
  { id: 'vintage', cat: 'retro', name: 'Винтаж', speed: false, ops: p => [
    { type: 'lut', M: adjustMatrix({ sepia: 35 * p.I + 10, contrast: -12, saturation: -15, brightness: 6 }) },
    { type: 'texture', gen: 'vignette', mode: 'multiply', o: n4(0.5 + 0.4 * p.I) },
    { type: 'noise', s: 8 }] },
  { id: 'cinema', cat: 'retro', name: 'Кино-кадр', speed: false, ops: p => [
    { type: 'lut', M: adjustMatrix({ contrast: 20 * p.I, saturation: -15 * p.I, warmth: -15 * p.I, tint: 6 * p.I }) },
    { type: 'texture', gen: 'bars', mode: 'normal', o: 1 }] },
  { id: 'pixelate', cat: 'retro', name: 'Пикселизация', speed: false, ops: p => [{ type: 'pixel', b: Math.round(6 + 44 * p.I) }] },
  { id: 'blur', cat: 'retro', name: 'Размытие', speed: false, ops: p => [{ type: 'blur', s: n4(3 + 27 * p.I) }] },
  { id: 'blurPulse', cat: 'retro', name: 'Размытие-пульс', ops: p => [{ type: 'blur', s: `${n4(25 * p.I)}*(0.5-0.5*cos(2*PI*T*${n4(p.V)}))` }] },
  { id: 'trail', cat: 'retro', name: 'Шлейф', speed: false, ops: p => [{ type: 'trail', d: n4(0.85 + 0.13 * p.I) }] },

  // --- цвет
  { id: 'bw', cat: 'color', name: 'Ч/Б', speed: false, ops: p => [{ type: 'lut', M: adjustMatrix({ saturation: -100 * p.I, contrast: 15 * p.I }) }] },
  { id: 'invert', cat: 'color', name: 'Негатив', speed: false, ops: p => [{ type: 'levels', o0: n4(p.I), o1: n4(1 - p.I) }] },
  { id: 'rainbow', cat: 'color', name: 'Радуга', ops: p => [{ type: 'mix', m: hueMatrixExpr(`T*${n4(2 * Math.PI * 0.5 * p.V)}`) }, { type: 'lut', M: adjustMatrix({ saturation: 40 * p.I }) }] },
  { id: 'bwFlash', cat: 'color', name: 'Ч/Б мигание', ops: p => [{ type: 'mix', m: satMatrixExpr(`1-${n4(p.I)}*lt(mod(T*${n4(3 * p.V)},1),0.5)`) }] },
  { id: 'invertFlash', cat: 'color', name: 'Негатив-мигание', ops: p => [{ type: 'levels', o0: `${n4(p.I)}*lt(mod(T*${n4(3 * p.V)},1),0.5)`, o1: `1-${n4(p.I)}*lt(mod(T*${n4(3 * p.V)},1),0.5)` }] },
  { id: 'acid', cat: 'color', name: 'Кислота', ops: p => [{ type: 'lut', M: adjustMatrix({ saturation: 100, contrast: 30 }) }, { type: 'mix', m: hueMatrixExpr(`${n4(1.2 * p.I)}*sin(T*${n4(3 * p.V)})`) }] },

  // --- экран
  { id: 'mirrorH', cat: 'split', name: 'Зеркало', speed: false, strength: false, ops: () => [{ type: 'layout', kind: 'mirrorH' }] },
  { id: 'mirrorV', cat: 'split', name: 'Зеркало ↕', speed: false, strength: false, ops: () => [{ type: 'layout', kind: 'mirrorV' }] },
  { id: 'grid2', cat: 'split', name: '4 экрана', speed: false, strength: false, ops: () => [{ type: 'layout', kind: 'grid2' }] },
  { id: 'grid3', cat: 'split', name: '9 экранов', speed: false, strength: false, ops: () => [{ type: 'layout', kind: 'grid3' }] },
  { id: 'triple', cat: 'split', name: '3 полосы', speed: false, strength: false, ops: () => [{ type: 'layout', kind: 'triple' }] },

  // --- искажения
  { id: 'fisheye', cat: 'distort', name: 'Рыбий глаз', speed: false, ops: p => [{ type: 'warp', name: 'fisheye', k: n4(0.2 + 0.9 * p.I) }] },
  { id: 'bulge', cat: 'distort', name: 'Выпуклость', speed: false, ops: p => [{ type: 'warp', name: 'bulge', k: n4(0.2 + 0.6 * p.I) }] },
  { id: 'pinch', cat: 'distort', name: 'Сжатие', speed: false, ops: p => [{ type: 'warp', name: 'pinch', k: n4(0.2 + 0.6 * p.I) }] },
  { id: 'swirl', cat: 'distort', name: 'Водоворот', speed: false, ops: p => [{ type: 'warp', name: 'swirl', k: n4(0.2 + 0.8 * p.I) }] },
  { id: 'kaleido', cat: 'distort', name: 'Калейдоскоп', speed: false, ops: p => [{ type: 'warp', name: 'kaleido', k: n4(p.I) }] },
  { id: 'ripple', cat: 'distort', name: 'Рябь', speed: false, ops: p => [{ type: 'warp', name: 'ripple', k: n4(0.3 + p.I) }] },
];
const EFFECT_BY_ID = Object.fromEntries(EFFECTS.map(e => [e.id, e]));
// во вкладке «В тренде» после новых — уже знакомые эффекты из других разделов
const TREND_MORE = ['shake', 'vignette', 'pixelate', 'ripple', 'glitch', 'vhs'];

function fxParams(c, W, H) {
  const pr = c.params || {};
  return { I: (pr.strength ?? 60) / 100, V: Math.pow(4, ((pr.speed ?? 50) - 50) / 50), D: Math.max(0.05, clipDur(c)), AR: W / H };
}
function effectOps(c) {
  const e = EFFECT_BY_ID[c.effect];
  if (!e) return [];
  return e.ops(fxParams(c, store.p.width, store.p.height));
}

// ---------------------------------------------------------------- «эдит»-переходы (эффект на стыке)
// U — положение относительно стыка (-1..1), A — близость к стыку (0..1..0)
function transFxOps(type, D) {
  const h = n4(D / 2);
  const U = `((T-${h})/${h})`, A = `(1-abs(${U}))`;
  switch (type) {
    case 'zoomIn': return [{ type: 'camera', z: `1+1.2*pow(${A},2)` }, { type: 'blur', s: `14*pow(${A},3)` }];
    case 'zoomOut': return [{ type: 'camera', z: `if(lt(${U},0),1+0.3*pow(1+${U},2),1+1.2*pow(1-${U},2))` }, { type: 'blur', s: `12*pow(${A},3)` }];
    case 'spin': return [{ type: 'camera', cover: true, r: `2*PI*sm((${U}+1)/2)` }, { type: 'blur', s: `10*pow(${A},2)` }];
    case 'zoomSpin': return [{ type: 'camera', cover: true, z: `1+0.8*pow(${A},2)`, r: `PI*sm((${U}+1)/2)` }, { type: 'blur', s: `12*pow(${A},2)` }];
    case 'flash': return [{ type: 'levels', o0: `exp(-abs(${U})*5)` }];
    case 'white': return [{ type: 'levels', o0: `sm(${A}*1.25)` }];
    case 'glitchT': {
      const N = 'floor(T*20)';
      return [
        { type: 'camera', z: `1+0.06*${A}`, x: `(rnd(${N}+11)-0.5)*0.08*${A}` },
        { type: 'rgb', rh: `(rnd(${N}+3)-0.5)*110*${A}`, bh: `(rnd(${N}+5)-0.5)*110*${A}`, gv: `(rnd(${N}+9)-0.5)*20*${A}` },
        { type: 'levels', o1: `1-0.3*${A}*rnd(${N}+13)` }];
    }
    case 'blurT': return [{ type: 'blur', s: `24*pow(${A},2)` }];
    case 'shakeT': return [{ type: 'camera', z: `1+0.16*pow(${A},1.5)`, x: `0.06*pow(${A},1.5)*sin(T*63)`, y: `0.06*pow(${A},1.5)*sin(T*71+1)` }];
    case 'pixelT': return [{ type: 'pixel', b: `1+70*pow(${A},2)` }];
    case 'rgbT': return [{ type: 'camera', z: `1+0.1*pow(${A},2)` }, { type: 'rgb', rh: `-45*pow(${A},2)`, bh: `45*pow(${A},2)` }];
    case 'whipLeft': case 'whipRight': return [{ type: 'blur', dir: 'h', s: `30*sin(PI*clip(T/${n4(D)},0,1))` }];
  }
  return null;
}
