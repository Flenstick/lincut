// Функции из After Effects: текстовые аниматоры (по буквам, словам, строкам), размытие в движении,
// маска пером с анимацией формы и слой-маска (Track Matte). Здесь — общая математика превью и экспорта:
// текст с аниматорами и размытием экспорт рисует этим же кодом покадрово, поэтому картинка совпадает.

// ---------------------------------------------------------------- текстовые аниматоры
// c.tanim = { in: { id, dur }, out: { id, dur }, loop: { id, speed, amount }, unit: 'auto'|'char'|'word'|'line' }
// w — доля общего времени, за которую появляется одна единица (остальное — задержка между буквами)
const TEXT_ANIMS_IN = [
  { id: 'none', name: 'Нет' },
  { id: 'type', name: 'Печатная машинка', unit: 'char' },
  { id: 'fade', name: 'Проявление', unit: 'char', w: 0.35 },
  { id: 'rise', name: 'Всплытие', unit: 'char', w: 0.4 },
  { id: 'drop', name: 'Падение', unit: 'char', w: 0.45 },
  { id: 'pop', name: 'По словам', unit: 'word', w: 0.5 },
  { id: 'scatter', name: 'Разлёт', unit: 'char', w: 0.75 },
  { id: 'blur', name: 'Из размытия', unit: 'char', w: 0.5 },
  { id: 'spread', name: 'Сжатие', unit: 'line', w: 1 },
  { id: 'flip', name: 'Переворот', unit: 'char', w: 0.4 },
];
const TEXT_ANIMS_OUT = [
  { id: 'none', name: 'Нет' },
  { id: 'type', name: 'Стирание', unit: 'char' },
  { id: 'fade', name: 'Растворение', unit: 'char', w: 0.35 },
  { id: 'rise', name: 'Улёт вверх', unit: 'char', w: 0.4 },
  { id: 'drop', name: 'Падение', unit: 'char', w: 0.5 },
  { id: 'pop', name: 'По словам', unit: 'word', w: 0.5 },
  { id: 'scatter', name: 'Разлёт', unit: 'char', w: 0.75 },
  { id: 'blur', name: 'В размытие', unit: 'char', w: 0.5 },
  { id: 'spread', name: 'Растяжение', unit: 'line', w: 1 },
  { id: 'flip', name: 'Переворот', unit: 'char', w: 0.4 },
];
const TEXT_LOOPS = [
  { id: 'none', name: 'Нет' },
  { id: 'wave', name: 'Волна' },
  { id: 'bounce', name: 'Прыжки' },
  { id: 'swing', name: 'Качание' },
  { id: 'pulse', name: 'Пульс' },
  { id: 'jitter', name: 'Дрожь' },
];
const TEXT_UNITS = [['auto', 'Авто'], ['char', 'Буквы'], ['word', 'Слова'], ['line', 'Строки']];
const DEFAULT_TANIM = { in: { id: 'none', dur: 1 }, out: { id: 'none', dur: 0.8 }, loop: { id: 'none', speed: 1, amount: 1 }, unit: 'auto' };
const TA_IN = Object.fromEntries(TEXT_ANIMS_IN.map(a => [a.id, a]));
const TA_OUT = Object.fromEntries(TEXT_ANIMS_OUT.map(a => [a.id, a]));

function textAnimOn(c) {
  const a = c && c.kind === 'text' && c.tanim;
  return !!(a && ((a.in && a.in.id !== 'none') || (a.out && a.out.id !== 'none') || (a.loop && a.loop.id !== 'none')));
}

// сглаживания
const easeOut3 = (x) => 1 - Math.pow(1 - x, 3);
const easeIn3 = (x) => x * x * x;
const smooth = (x) => x * x * (3 - 2 * x);
const backOut = (x) => { const s = 1.70158; return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); };
function bounceOut(x) {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}
// детерминированное «случайное» число −1…1 (одинаковое в превью и экспорте)
function hrnd(a, b, c) {
  let h = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b) ^ Math.imul(c + 13, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

// Раскладка по буквам: позиции совпадают с тем, как drawText рисует строку целиком
const glyphCache = new Map();
const graphemes = (s) => {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(s)].map(x => x.segment);
  return [...s];
};
function glyphLayout(c, L) {
  const st = c.style;
  const key = [c.text, st.font, st.size, st.bold, st.italic, st.letterSpacing, st.lineHeight, st.align, st.strokeWidth, st.bgOpacity > 0].join('|');
  if (glyphCache.has(key)) return glyphCache.get(key);
  if (glyphCache.size > 64) glyphCache.delete(glyphCache.keys().next().value);
  measureCtx.font = fontString(st, st.size);
  const ls = st.letterSpacing || 0;
  const x0 = -L.w / 2, y0 = -L.h / 2;
  const lines = [];
  let ci = 0, w = -1;
  for (let li = 0; li < L.lines.length; li++) {
    const line = L.lines[li], lw = L.widths[li];
    let x;
    if (st.align === 'left') x = x0 + L.pad + L.sw;
    else if (st.align === 'right') x = -x0 - L.pad - L.sw - lw;
    else x = -lw / 2;
    const y = y0 + L.pad + L.sw + L.lh * (li + 0.5);
    const out = [];
    // char — номер буквы в тексте, li — в строке, word — номер слова (подряд идущие непробельные буквы)
    let pre = '', cps = 0, pos = 0, prevSpace = true;
    for (const g of graphemes(line)) {
      const space = /^\s+$/.test(g);
      if (!space && prevSpace) w++;
      prevSpace = space;
      const gx = x + measureCtx.measureText(pre).width + cps * ls;
      out.push({ ch: g, x: gx, w: measureCtx.measureText(g).width, space, char: space ? -1 : ci, word: space ? -1 : w, li: pos });
      if (!space) { ci++; pos++; }
      pre += g; cps += [...g].length;
    }
    lines.push({ y, x, w: lw, glyphs: out, n: pos });
  }
  const res = { lines, nChar: ci, nWord: w + 1, nLine: lines.length, underY: st.size * 0.42, underH: Math.max(2, st.size * 0.06) };
  glyphCache.set(key, res);
  return res;
}

const unitOf = (g, li, unit) => unit === 'word' ? g.word : unit === 'line' ? li : g.char;
const unitCount = (G, unit) => unit === 'word' ? G.nWord : unit === 'line' ? G.nLine : G.nChar;

// Видимость единицы i из n: 0 — скрыта, 1 — на месте
function staggerV(p, i, n, w) {
  w = clamp(w ?? 0.4, 0.02, 1);
  const d = n > 1 ? i / (n - 1) * (1 - w) : 0;
  return clamp((p - d) / w, 0, 1);
}

// Применить пресет появления/исчезновения: v — видимость 0…1, out — это исчезновение
function taPreset(id, v, g, ctxI, S, out, o) {
  if (id === 'fade') { o.op *= smooth(v); return; }
  if (id === 'rise') { const e = easeOut3(v); o.dy += (1 - e) * 0.6 * S * (out ? -1 : 1); o.op *= e; return; }
  if (id === 'drop') {
    if (!out) { o.dy -= (1 - bounceOut(v)) * 1.2 * S; o.op *= clamp(v * 4, 0, 1); }
    else { const q = 1 - v; o.dy += easeIn3(q) * 1.6 * S; o.rot += easeIn3(q) * 25 * hrnd(ctxI, 3, 1); o.op *= 1 - clamp((q - 0.6) / 0.4, 0, 1); }
    return;
  }
  if (id === 'pop') { const e = out ? easeOut3(v) : backOut(v); o.sc *= Math.max(0, e); o.op *= clamp(v * 3, 0, 1); return; }
  if (id === 'scatter') {
    const e = easeOut3(v), q = 1 - e;
    o.dx += q * hrnd(ctxI, 1, 7) * 3 * S; o.dy += q * hrnd(ctxI, 2, 7) * 2 * S; o.rot += q * hrnd(ctxI, 3, 7) * 220;
    o.sc *= 1 + q * 0.6 * hrnd(ctxI, 4, 7); o.op *= e;
    return;
  }
  if (id === 'blur') { const e = easeOut3(v); o.blur += (1 - e) * 0.35 * S; o.op *= smooth(v); o.sx *= 1 + (1 - e) * 0.25; return; }
  if (id === 'spread') { const e = easeOut3(v); o.dx += (1 - e) * (g.pos - (g.cnt - 1) / 2) * 0.55 * S * (out ? 1.4 : 1); o.op *= smooth(v); return; }
  if (id === 'flip') { const e = out ? easeOut3(v) : backOut(v); o.sy *= e; o.op *= clamp(v * 2.5, 0, 1); return; }
}
function taLoop(L, lt, g, i, S, o) {
  const sp = L.speed || 1, A = L.amount ?? 1, ph = (x) => 2 * Math.PI * (lt * sp - x);
  if (L.id === 'wave') o.dy -= Math.sin(ph(g.pos * 0.09)) * 0.14 * S * A;
  else if (L.id === 'bounce') o.dy -= Math.abs(Math.sin(ph(g.pos * 0.07) / 2)) * 0.28 * S * A;
  else if (L.id === 'swing') o.rot += Math.sin(ph(g.pos * 0.11)) * 14 * A;
  else if (L.id === 'pulse') o.sc *= 1 + 0.16 * A * (0.5 + 0.5 * Math.sin(ph(g.pos * 0.08)));
  else if (L.id === 'jitter') {
    const f = Math.floor(lt * 12 * sp + 1e-6);
    o.dx += hrnd(i, f, 11) * 0.045 * S * A; o.dy += hrnd(i, f, 12) * 0.045 * S * A; o.rot += hrnd(i, f, 13) * 5 * A;
  }
}

// Рисует буквы текстового клипа с аниматорами; ctx уже в системе текста (центр, поворот, масштаб).
// lt — время от начала клипа (по таймлайну), px — во сколько раз пиксель холста больше единицы текста (для размытия)
function drawTextGlyphs(ctx, c, L, lt, px) {
  const st = c.style, a = Object.assign({}, DEFAULT_TANIM, c.tanim);
  const G = glyphLayout(c, L), d = clipDur(c), S = st.size;
  const aIn = a.in && a.in.id !== 'none' ? a.in : null, aOut = a.out && a.out.id !== 'none' ? a.out : null;
  const loop = a.loop && a.loop.id !== 'none' ? a.loop : null;
  const inDur = aIn ? Math.max(0.05, Math.min(aIn.dur, d)) : 0, outDur = aOut ? Math.max(0.05, Math.min(aOut.dur, d)) : 0;
  const pIn = aIn ? clamp(lt / inDur, 0, 1) : 1, pOut = aOut ? clamp((lt - (d - outDur)) / outDur, 0, 1) : 0;
  const uIn = aIn ? (a.unit && a.unit !== 'auto' ? a.unit : TA_IN[aIn.id].unit) : 'char';
  const uOut = aOut ? (a.unit && a.unit !== 'auto' ? a.unit : TA_OUT[aOut.id].unit) : 'char';
  const nIn = Math.max(1, unitCount(G, uIn)), nOut = Math.max(1, unitCount(G, uOut));
  const base = ctx.globalAlpha;
  // центр масштаба и поворота: у букв — своя середина, у слов и строк — середина слова/строки
  const pu = aIn && pIn < 1 ? uIn : aOut && pOut > 0 ? uOut : 'char';
  const span = new Map();
  if (pu !== 'char') G.lines.forEach((ln, li) => ln.glyphs.forEach((g) => {
    if (g.space) return;
    const key = pu === 'word' ? 'w' + g.word : 'l' + li, r = span.get(key);
    if (r) { r[0] = Math.min(r[0], g.x); r[1] = Math.max(r[1], g.x + g.w); } else span.set(key, [g.x, g.x + g.w]);
  }));
  const pivot = (g, li) => { const r = pu === 'char' ? null : span.get(pu === 'word' ? 'w' + g.word : 'l' + li); return r ? (r[0] + r[1]) / 2 : g.x + g.w / 2; };
  // состояние каждой буквы
  const states = [];
  G.lines.forEach((ln, li) => ln.glyphs.forEach((g) => {
    if (g.space) return;
    const gi = { pos: g.li, cnt: ln.n };
    const o = { op: 1, dx: 0, dy: 0, sc: 1, sx: 1, sy: 1, rot: 0, blur: 0 };
    if (aIn && pIn < 1) {
      const i = unitOf(g, li, uIn);
      if (aIn.id === 'type') { if (i >= Math.floor(pIn * nIn + 1e-6)) o.op = 0; }
      else taPreset(aIn.id, staggerV(pIn, i, nIn, TA_IN[aIn.id].w), gi, g.char, S, false, o);
    }
    if (aOut && pOut > 0) {
      const i = unitOf(g, li, uOut);
      if (aOut.id === 'type') { if (i >= nOut - Math.floor(pOut * nOut + 1e-6)) o.op = 0; }
      else taPreset(aOut.id, 1 - staggerV(pOut, i, nOut, TA_OUT[aOut.id].w), gi, g.char, S, true, o);
    }
    if (loop) taLoop(loop, lt, gi, g.char, S, o);
    if (o.op > 0.002 && Math.abs(o.sc * o.sx) > 1e-4 && Math.abs(o.sc * o.sy) > 1e-4) states.push({ g, y: ln.y, o, pv: pivot(g, li) });
  }));
  const each = (fn) => {
    for (const { g, y, o, pv } of states) {
      ctx.save();
      ctx.globalAlpha = base * clamp(o.op, 0, 1);
      ctx.translate(pv + o.dx, y + o.dy);
      if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
      if (o.sc !== 1 || o.sx !== 1 || o.sy !== 1) ctx.scale(o.sc * o.sx, o.sc * o.sy);
      if (o.blur * px > 0.3) ctx.filter = `blur(${(o.blur * px).toFixed(2)}px)`;
      fn(g, g.x - pv);
      ctx.restore();
    }
  };
  ctx.letterSpacing = '0px';
  if (st.shadow) {
    each((g, x) => {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = S * 0.12 * px; ctx.shadowOffsetY = S * 0.04 * px;
      ctx.fillStyle = st.color; ctx.fillText(g.ch, x, 0);
    });
  }
  if (st.strokeWidth > 0) each((g, x) => { ctx.strokeStyle = st.strokeColor; ctx.lineWidth = st.strokeWidth * 2; ctx.strokeText(g.ch, x, 0); });
  each((g, x) => {
    ctx.fillStyle = st.color; ctx.fillText(g.ch, x, 0);
    if (st.underline) ctx.fillRect(x, G.underY, g.w + (st.letterSpacing || 0), G.underH);
  });
}

// ---------------------------------------------------------------- размытие в движении
// c.mblur = { on, angle (угол затвора, °), samples }: кадр — среднее образцов в пределах открытого затвора.
// Превью копит образцы сложением с весом 1/N (как mix в ffmpeg по premultiplied-цветам).
const DEFAULT_MBLUR = { on: false, angle: 180, samples: 8 };
const mblurOn = (c) => !!(c && c.mblur && c.mblur.on);
function mblurOffsets(c) {
  const m = Object.assign({}, DEFAULT_MBLUR, c.mblur), N = clamp(Math.round(m.samples), 2, 32);
  const sh = clamp(m.angle, 1, 720) / 360 / store.p.fps;
  return Array.from({ length: N }, (_, i) => ((i + 0.5) / N - 0.5) * sh);
}
// есть ли у клипа движение, которое стоит размывать
function mblurActive(c, tr) {
  if (!mblurOn(c) || c.kind === 'effect' || c.kind === 'audio') return false;
  if (c.keys && c.keys.length > 1) return true;
  if (textAnimOn(c)) return true;
  return clipFx(c, tr, store.p.width, store.p.height).moves.length > 0;
}

// служебные холсты-слои (по имени), размером с кадр
const layerCvs = {};
function layerCanvas(name, w, h) {
  let cv = layerCvs[name];
  if (!cv) cv = layerCvs[name] = document.createElement('canvas');
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const x = cv.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.filter = 'none';
  x.clearRect(0, 0, w, h);
  return cv;
}
// среднее N образцов: sample(ctx, dt) рисует клип со сдвигом времени dt на чистый слой
function drawBlurSamples(ctx, c, depth, sample) {
  const offs = mblurOffsets(c), N = offs.length, cv = ctx.canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = 'none';
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 / N;
  for (const dt of offs) {
    const T = layerCanvas('mbs' + depth, cv.width, cv.height);
    sample(T.getContext('2d'), dt);
    ctx.drawImage(T, 0, 0);
  }
  ctx.restore();
}
// образец медиа-клипа: положение — в момент t + dt, прозрачность и кадр источника — в момент t
function blurSampleClip(c, tr, t, dt, W, H) {
  const tf = tfAt(c, t + dt), tf0 = tfAt(c, t);
  const an = animState(c, t, W, H, tr), an2 = animState(c, t + dt, W, H, tr);
  const cs = { ...c, blend: undefined, keys: null, transform: { ...c.transform, x: tf.x, y: tf.y, scale: tf.scale, rotation: tf.rotation }, opacity: tf0.opacity };
  return { cs, an: { alpha: an.alpha, dx: an2.dx, dy: an2.dy } };
}

// ---------------------------------------------------------------- маска пером
// c.mask.type = 'pen': m.pts = [[x, y, ix, iy, ox, oy], …] — вершины (доли размера клипа от центра) и ручки
// Безье (смещения от вершины, тоже в долях). Контур всегда замкнут. Анимация формы — m.keys = [{ s, pts }]
// по времени источника, линейно между ключами (у всех ключей одинаковое число вершин).
function penPtsAt(m, s) {
  const K = m.keys;
  if (!K || !K.length || s == null) return m.pts || [];
  if (K.length === 1 || s <= K[0].s) return K[0].pts;
  const last = K[K.length - 1];
  if (s >= last.s) return last.pts;
  let i = 0;
  while (i < K.length - 2 && K[i + 1].s <= s) i++;
  const a = K[i], b = K[i + 1], f = (s - a.s) / (b.s - a.s);
  return a.pts.map((p, j) => p.map((v, q) => v + ((b.pts[j] || p)[q] - v) * f));
}
function penPath(x, pts, fw, fh) {
  x.beginPath();
  const n = pts.length;
  if (n < 2) return;
  const P = (p) => [p[0] * fw, p[1] * fh];
  x.moveTo(...P(pts[0]));
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    x.bezierCurveTo((a[0] + a[4]) * fw, (a[1] + a[5]) * fh, (b[0] + b[2]) * fw, (b[1] + b[3]) * fh, b[0] * fw, b[1] * fh);
  }
  x.closePath();
}
const penAnimated = (m) => !!(m && m.type === 'pen' && m.keys && m.keys.length > 1);
function penKeyIndex(m, s) {
  if (!m.keys) return -1;
  const tol = 0.5 / (store.p ? store.p.fps : 30);
  return m.keys.findIndex(k => Math.abs(k.s - s) <= tol);
}
// изменить форму в момент s (время источника): с ключами — пишем в ключ (создаём при необходимости)
function penEdit(m, s, fn) {
  if (m.keys && m.keys.length) {
    let i = penKeyIndex(m, s);
    if (i < 0) {
      const pts = deep(penPtsAt(m, s));
      m.keys.push({ s, pts });
      m.keys.sort((a, b) => a.s - b.s);
      i = m.keys.findIndex(k => k.pts === pts);
    }
    fn(m.keys[i].pts);
    m.pts = m.keys[0].pts;
  } else fn(m.pts);
}
// новая вершина — во все ключи сразу, чтобы число вершин совпадало
function penInsert(m, idx, at) {
  const add = (pts, p) => pts.splice(idx, 0, p);
  if (m.keys && m.keys.length) for (const k of m.keys) add(k.pts, at(k.pts));
  else add(m.pts, at(m.pts));
  if (m.keys && m.keys.length) m.pts = m.keys[0].pts;
}
function penRemove(m, idx) {
  if (m.keys && m.keys.length) for (const k of m.keys) k.pts.splice(idx, 1);
  else m.pts.splice(idx, 1);
  if (m.keys && m.keys.length) m.pts = m.keys[0].pts;
}
// точка на кривой Безье сегмента i при параметре u (для вставки вершины на контур)
function penSplit(pts, i, u) {
  const n = pts.length, a = pts[i], b = pts[(i + 1) % n];
  const p0 = [a[0], a[1]], p1 = [a[0] + a[4], a[1] + a[5]], p2 = [b[0] + b[2], b[1] + b[3]], p3 = [b[0], b[1]];
  const L = (p, q) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
  const q0 = L(p0, p1), q1 = L(p1, p2), q2 = L(p2, p3), r0 = L(q0, q1), r1 = L(q1, q2), s = L(r0, r1);
  return { a: [a[0], a[1], a[2], a[3], q0[0] - a[0], q0[1] - a[1]], p: [s[0], s[1], r0[0] - s[0], r0[1] - s[1], r1[0] - s[0], r1[1] - s[1]], b: [b[0], b[1], q2[0] - b[0], q2[1] - b[1], b[4], b[5]] };
}

// ---------------------------------------------------------------- слой-маска (Track Matte)
// c.matte = { id, mode: 'alpha'|'luma', invert }: клип виден только там, где виден клип id (альфа)
// или где он светлый (яркость). Клип-маска сам не рисуется — как в After Effects.
const MATTE_MODES = [['alpha', 'Альфа'], ['luma', 'Яркость']];
const LUMA_K = [0.2125, 0.7154, 0.0721]; // как feColorMatrix luminanceToAlpha
function matteOf(c) {
  if (!c.matte || !c.matte.id || c.kind === 'effect' || c.kind === 'audio') return null;
  // клип-маску удалили — слой-маски больше нет (как в After Effects)
  const f = store.find(c.matte.id);
  return f && f.clip !== c ? { clip: f.clip, track: f.track, mode: c.matte.mode || 'alpha', invert: !!c.matte.invert } : null;
}
// клипы, которые служат маской другим (их не рисуем)
function matteSources() {
  const S = new Set();
  for (const tr of store.p.tracks) for (const c of tr.clips) if (!c.disabled && c.matte && c.matte.id && c.kind !== 'effect') S.add(c.matte.id);
  return S;
}
// кандидаты в маску для клипа: видимые клипы, пересекающиеся по времени
function matteCandidates(c) {
  const out = [];
  store.p.tracks.forEach((tr, ti) => {
    if (tr.kind === 'audio' || tr.kind === 'effect') return;
    for (const x of tr.clips) {
      if (x === c || x.kind === 'effect' || x.kind === 'audio') continue;
      if (x.start >= clipEnd(c) || clipEnd(x) <= c.start) continue;
      if (x.matte && x.matte.id === c.id) continue;
      out.push({ clip: x, track: tr, ti });
    }
  });
  return out;
}
function clipLabel(x) {
  if (x.kind === 'text') return '«' + String(x.text || '').split('\n')[0].slice(0, 24) + '»';
  const m = x.mediaId && store.media(x.mediaId);
  return m ? m.name : x.kind;
}
let lumaSvg = null;
function lumaFilter() {
  if (!lumaSvg) {
    lumaSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lumaSvg.setAttribute('width', '0'); lumaSvg.setAttribute('height', '0');
    lumaSvg.style.position = 'absolute';
    lumaSvg.innerHTML = '<filter id="lcLumaAlpha" color-interpolation-filters="sRGB"><feColorMatrix type="luminanceToAlpha"/></filter>';
    document.body.appendChild(lumaSvg);
  }
  return 'url(#lcLumaAlpha)';
}
// применить маску-слой M (холст того же размера) к слою A
function applyMatte(A, M, mode, invert, depth) {
  const ax = A.getContext('2d');
  let src = M;
  if (mode === 'luma') {
    // прозрачное — как чёрное (яркость клипа-маски поверх чёрного)
    const C = layerCanvas('mtc' + depth, A.width, A.height), cx = C.getContext('2d');
    cx.fillStyle = '#000'; cx.fillRect(0, 0, C.width, C.height); cx.drawImage(M, 0, 0);
    const D = layerCanvas('mtd' + depth, A.width, A.height), dx = D.getContext('2d');
    dx.filter = lumaFilter(); dx.drawImage(C, 0, 0); dx.filter = 'none';
    src = D;
  }
  ax.save();
  ax.setTransform(1, 0, 0, 1, 0, 0); ax.globalAlpha = 1; ax.filter = 'none';
  ax.globalCompositeOperation = invert ? 'destination-out' : 'destination-in';
  ax.drawImage(src, 0, 0);
  ax.restore();
}

// ---------------------------------------------------------------- общий рисовальщик слоя
// Рисует клип со всем «послойным»: размытие в движении, слой-маска, режим наложения.
// drawPlain(ctx, c, t, an) — обычная отрисовка (у превью — видео из <video>, у экспорта — только текст).
function drawClipLayer(ctx, c, tr, t, W, H, k, drawPlain, depth = 0) {
  const mt = depth === 0 ? matteOf(c) : null;
  const blur = mblurActive(c, tr);
  if (!mt && !blur) { drawPlain(ctx, c, t, animState(c, t, W, H, tr)); return; }
  const cv = ctx.canvas, bl = blendOf(c);
  const A = layerCanvas('lyA' + depth, cv.width, cv.height), ax = A.getContext('2d');
  const c0 = bl ? { ...c, blend: undefined } : c;
  if (blur) {
    drawBlurSamples(ax, c, depth, (x, dt) => {
      if (c.kind === 'text') drawPlain(x, c0, t + dt, animState(c, t + dt, W, H, tr), t + dt);
      else { const s = blurSampleClip(c0, tr, t, dt, W, H); drawPlain(x, s.cs, t, s.an); }
    });
  } else drawPlain(ax, c0, t, animState(c, t, W, H, tr));
  if (mt) {
    const M = layerCanvas('lyM' + depth, cv.width, cv.height);
    const m = mt.clip;
    if (m && !m.disabled && t >= m.start && t < clipEnd(m)) drawClipLayer(M.getContext('2d'), { ...m, matte: null }, mt.track, t, W, H, k, drawPlain, depth + 1);
    applyMatte(A, M, mt.mode, mt.invert, depth);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
  ctx.globalCompositeOperation = bl ? bl.css : 'source-over';
  ctx.drawImage(A, 0, 0);
  ctx.restore();
}
