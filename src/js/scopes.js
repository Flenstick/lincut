// Видеоскопы (как Lumetri Scopes) и индикатор громкости (как Audio Meters в Premiere).
// Скопы считаются по кадру превью: он уменьшается до SW×SH и разбирается по пикселям.
const SCOPE_MODES = [
  { id: 'wave', name: 'Волна' },
  { id: 'parade', name: 'RGB-парад' },
  { id: 'vector', name: 'Вектор' },
  { id: 'hist', name: 'Гистограмма' },
];
const SW = 480, SH = 270;

const Scopes = {
  on: false,
  mode: 'wave',
  data: null,      // последний разобранный кадр { px, w, h }
  dirty: true,

  init() {
    try {
      this.on = localStorage.getItem('lc.scopes') === '1';
      this.mode = SCOPE_MODES.some(m => m.id === localStorage.getItem('lc.scopeMode')) ? localStorage.getItem('lc.scopeMode') : 'wave';
      this.meterOn = localStorage.getItem('lc.meter') !== '0';
    } catch { this.meterOn = true; }
    this.cv = $('#scCanvas');
    const seg = $('#scMode');
    seg.innerHTML = SCOPE_MODES.map(m => `<button data-m="${m.id}" class="${m.id === this.mode ? 'on' : ''}">${m.name}</button>`).join('');
    seg.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      this.mode = b.dataset.m;
      try { localStorage.setItem('lc.scopeMode', this.mode); } catch { }
      $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
      this.draw();
    };
    $('#btnScopes').onclick = () => this.toggle();
    new ResizeObserver(() => this.draw()).observe($('.sc-body'));
    bus.on('theme', () => { this.draw(); this.drawMeter(true); });
    this.apply();
    this.meterCv = $('#auMeter canvas');
    new ResizeObserver(() => this.drawMeter(true)).observe($('#auMeter'));
    this.applyMeter();
  },
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem('lc.scopes', this.on ? '1' : '0'); } catch { }
    this.apply();
  },
  apply() {
    $('#scopes').classList.toggle('hidden', !this.on);
    $('#btnScopes').classList.toggle('on', this.on);
    this.dirty = true;
    if (this.on) requestAnimationFrame(() => this.frame(true));
  },

  // ---------------------------------------------------------------- кадр
  // Вызывается после каждой отрисовки превью; во время воспроизведения — не чаще ~12 раз в секунду
  frame(force) {
    this.dirty = true;
    const curves = Inspector.curveCv && Inspector.curveCv.isConnected;
    if (!this.on && !curves) return;
    const now = performance.now();
    if (!force && Player.playing && now - (this.last || 0) < 80) return;
    this.last = now;
    this.sample();
    if (this.on) this.draw();
    if (curves && !Player.playing) Inspector.curveDraw();
  },
  sample() {
    if (!store.p || !Player.canvas || !Player.canvas.width) { this.data = null; return; }
    if (!this.sc) { this.sc = document.createElement('canvas'); this.sc.width = SW; this.sc.height = SH; this.sx = this.sc.getContext('2d', { willReadFrequently: true }); }
    const ar = store.p.width / store.p.height;
    const w = ar >= SW / SH ? SW : Math.max(16, Math.round(SH * ar)), hh = ar >= SW / SH ? Math.max(16, Math.round(SW / ar)) : SH;
    this.sx.clearRect(0, 0, SW, SH);
    this.sx.drawImage(Player.canvas, 0, 0, w, hh);
    this.data = { px: this.sx.getImageData(0, 0, w, hh).data, w, h: hh };
    this.dirty = false;
    this.hist = null;
  },
  // гистограмма яркости (Rec.709) текущего кадра — подложка редактора кривых
  lumaHist() {
    if (this.dirty || !this.data) this.sample();
    if (!this.data) return null;
    if (this.hist) return this.hist;
    const { px } = this.data, H = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) H[(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722 + 0.5) | 0]++;
    return (this.hist = H);
  },

  // ---------------------------------------------------------------- отрисовка
  draw() {
    if (!this.on || !this.cv) return;
    const r = this.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    const x = this.cv.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, W, H);
    if (!this.data) return;
    x.font = `500 ${10 * dpr}px "IBM Plex Mono", ui-monospace, monospace`;
    ({ wave: () => this.drawWave(x, W, H, dpr, false), parade: () => this.drawWave(x, W, H, dpr, true), vector: () => this.drawVector(x, W, H, dpr), hist: () => this.drawHist(x, W, H, dpr) })[this.mode]();
  },
  // область графика с полями под подписи
  box(W, H, dpr) { const l = 30 * dpr, t = 10 * dpr, rr = 8 * dpr, b = 10 * dpr; return { l, t, w: W - l - rr, h: H - t - b }; },
  gridIRE(x, B, dpr) {
    x.textAlign = 'right'; x.textBaseline = 'middle';
    for (let v = 0; v <= 100; v += 10) {
      const y = Math.round(B.t + (1 - v / 100) * B.h) + 0.5;
      x.fillStyle = v % 50 === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.07)';
      x.fillRect(B.l, y, B.w, dpr);
      if (v % 20 === 0) { x.fillStyle = 'rgba(255,255,255,.4)'; x.fillText(String(v), B.l - 5 * dpr, y); }
    }
  },
  // Форма волны: по горизонтали — столбец кадра, по вертикали — яркость (0–100 IRE), яркость точки — сколько пикселей
  drawWave(x, W, H, dpr, parade) {
    const B = this.box(W, H, dpr), { px, w, h } = this.data;
    this.gridIRE(x, B, dpr);
    const chans = parade ? [[0, [255, 90, 82]], [1, [61, 220, 132]], [2, [74, 163, 255]]] : [[-1, [190, 255, 205]]];
    const cols = w;
    const LV = 200; // уровней по вертикали в буфере
    const pw = Math.max(1, Math.floor(B.w / chans.length)), ph = Math.max(1, Math.floor(B.h));
    const img = x.createImageData(pw * chans.length, ph);
    const d = img.data;
    // столбцы кадра собираются в столбцы графика (pw), уровни — в LV ячеек; плотность → яркость точки
    const nb = Math.min(pw, cols), per = h * cols / nb / LV;
    chans.forEach(([ch, col], ci) => {
      const acc = new Float32Array(nb * LV);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const i = (yy * w + xx) * 4;
        const v = ch < 0 ? px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722 : px[i + ch];
        acc[Math.min(nb - 1, (xx * nb / cols) | 0) * LV + Math.min(LV - 1, (v / 255 * (LV - 1) + 0.5) | 0)]++;
      }
      for (let X = 0; X < pw; X++) {
        const bx = Math.min(nb - 1, (X * nb / pw) | 0);
        for (let Y = 0; Y < ph; Y++) {
          const lv = Math.min(LV - 1, Math.floor((1 - Y / ph) * LV));
          const n = acc[bx * LV + lv];
          if (!n) continue;
          const a = Math.min(1, 0.18 + Math.sqrt(n / per) * 0.5);
          const o = (Y * pw * chans.length + ci * pw + X) * 4;
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = Math.round(a * 255);
        }
      }
    });
    const tmp = this.tmp || (this.tmp = document.createElement('canvas'));
    tmp.width = img.width; tmp.height = img.height;
    tmp.getContext('2d').putImageData(img, 0, 0);
    x.drawImage(tmp, B.l, B.t);
    if (parade) {
      x.fillStyle = 'rgba(255,255,255,.12)';
      for (let i = 1; i < 3; i++) x.fillRect(Math.round(B.l + i * pw), B.t, dpr, B.h);
    }
  },
  // Вектороскоп: цветность Cb/Cr (BT.709), мишени 75% основных цветов и линия тона кожи
  drawVector(x, W, H, dpr) {
    const { px } = this.data;
    const R = Math.min(W, H) / 2 - 14 * dpr, cx = W / 2, cy = H / 2;
    x.strokeStyle = 'rgba(255,255,255,.14)'; x.lineWidth = dpr;
    x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.arc(cx, cy, R * 0.5, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.moveTo(cx - R, cy); x.lineTo(cx + R, cy); x.moveTo(cx, cy - R); x.lineTo(cx, cy + R); x.stroke();
    const uv = (r, g, b) => { const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [(b - Y) / 1.8556, (r - Y) / 1.5748]; };
    // точка: Cb вправо, Cr вверх; полный размах ±0.5 → радиус R
    const P = (u, v) => [cx + u * 2 * R, cy - v * 2 * R];
    // линия тона кожи (≈ 123°)
    x.strokeStyle = 'rgba(255,200,150,.35)';
    const sk = 123 * Math.PI / 180;
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(sk) * R, cy - Math.sin(sk) * R); x.stroke();
    const T = [['R', [.75, 0, 0], '#ff5a52'], ['Mg', [.75, 0, .75], '#e05ce0'], ['B', [0, 0, .75], '#4aa3ff'], ['Cy', [0, .75, .75], '#38d6d6'], ['G', [0, .75, 0], '#3ddc84'], ['Yl', [.75, .75, 0], '#e8d84a']];
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (const [n, c, col] of T) {
      const [u, v] = uv(...c), [X, Y] = P(u, v), s = 5 * dpr;
      x.strokeStyle = col; x.globalAlpha = 0.7; x.strokeRect(X - s, Y - s, s * 2, s * 2); x.globalAlpha = 1;
      const [X2, Y2] = P(u * 1.28, v * 1.28);
      x.fillStyle = col; x.fillText(n, X2, Y2);
    }
    const img = x.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const [u, v] = uv(r, g, b), [X, Y] = P(u, v);
      const o = ((Y | 0) * W + (X | 0)) * 4;
      if (o < 0 || o >= d.length) continue;
      // точка окрашена своим цветом, повторы накапливаются
      d[o] = Math.min(255, d[o] + 40 + r * 60); d[o + 1] = Math.min(255, d[o + 1] + 40 + g * 60); d[o + 2] = Math.min(255, d[o + 2] + 40 + b * 60); d[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
  },
  // Гистограмма: каналы R, G, B и яркость
  drawHist(x, W, H, dpr) {
    const B = this.box(W, H, dpr), { px } = this.data;
    const hs = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < px.length; i += 4) { hs[0][px[i]]++; hs[1][px[i + 1]]++; hs[2][px[i + 2]]++; }
    const L = this.lumaHist();
    let mx = 1;
    for (const a of [...hs, L]) for (let i = 2; i < 254; i++) mx = Math.max(mx, a[i]);
    x.textAlign = 'right'; x.textBaseline = 'middle';
    for (let v = 0; v <= 4; v++) {
      const X = Math.round(B.l + v / 4 * B.w) + 0.5;
      x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(X, B.t, dpr, B.h);
    }
    x.fillStyle = 'rgba(255,255,255,.16)'; x.fillRect(B.l, B.t + B.h, B.w, dpr);
    x.globalCompositeOperation = 'lighter';
    for (const [a, col] of [[hs[0], 'rgba(255,90,82,.55)'], [hs[1], 'rgba(61,220,132,.55)'], [hs[2], 'rgba(74,163,255,.6)']]) {
      x.fillStyle = col; x.beginPath(); x.moveTo(B.l, B.t + B.h);
      for (let i = 0; i < 256; i++) x.lineTo(B.l + i / 255 * B.w, B.t + B.h - Math.min(1, a[i] / mx) * B.h);
      x.lineTo(B.l + B.w, B.t + B.h); x.closePath(); x.fill();
    }
    x.globalCompositeOperation = 'source-over';
    x.strokeStyle = 'rgba(255,255,255,.75)'; x.lineWidth = dpr; x.beginPath();
    for (let i = 0; i < 256; i++) { const X = B.l + i / 255 * B.w, Y = B.t + B.h - Math.min(1, L[i] / mx) * B.h; i ? x.lineTo(X, Y) : x.moveTo(X, Y); }
    x.stroke();
  },

  // ---------------------------------------------------------------- индикатор громкости
  toggleMeter() {
    this.meterOn = !this.meterOn;
    try { localStorage.setItem('lc.meter', this.meterOn ? '1' : '0'); } catch { }
    this.applyMeter();
  },
  applyMeter() {
    $('#auMeter').classList.toggle('hidden', !this.meterOn);
    $('#tlBody').classList.toggle('with-meter', this.meterOn);
    if (store.p) Timeline.render();
    this.drawMeter(true);
  },
  lv: [-Infinity, -Infinity], peak: [-Infinity, -Infinity], peakT: [0, 0], clip: [false, false],
  meterLoop() {
    if (this.meterRaf || !this.meterOn) return;
    const tick = () => {
      this.meterRaf = null;
      if (!this.meterOn) return;
      const live = this.readLevels();
      this.drawMeter();
      // после остановки даём уровням спокойно упасть
      if (Player.playing || live) this.meterRaf = requestAnimationFrame(tick);
    };
    this.meterRaf = requestAnimationFrame(tick);
  },
  readLevels() {
    const M = Player.meters, now = performance.now();
    let live = false;
    for (let i = 0; i < 2; i++) {
      let db = -Infinity;
      if (M && Player.playing) {
        const buf = this.buf || (this.buf = new Float32Array(M[i].fftSize));
        M[i].getFloatTimeDomainData(buf);
        let pk = 0; for (let k = 0; k < buf.length; k++) { const a = Math.abs(buf[k]); if (a > pk) pk = a; }
        db = pk > 0 ? 20 * Math.log10(pk) : -Infinity;
      }
      // плавное падение 24 дБ/с, мгновенный подъём
      const prev = this.lv[i], fall = isFinite(prev) ? prev - 24 * (now - (this.lt || now)) / 1000 : -Infinity;
      this.lv[i] = Math.max(db, fall);
      if (this.lv[i] < -60) this.lv[i] = -Infinity;
      if (db >= this.peak[i] || now - this.peakT[i] > 1500) { this.peak[i] = Math.max(db, isFinite(this.lv[i]) ? this.lv[i] : -Infinity); this.peakT[i] = now; }
      if (db >= -0.1) this.clip[i] = true;
      if (isFinite(this.lv[i]) || isFinite(this.peak[i])) live = true;
    }
    this.lt = now;
    return live;
  },
  drawMeter(force) {
    const cv = this.meterCv;
    if (!cv || !this.meterOn) return;
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const x = cv.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, W, H);
    const top = 30 * dpr, bot = 8 * dpr, hh = H - top - bot, bw = 6 * dpr, gap = 2 * dpr;
    const x0 = W - 8 * dpr - bw * 2 - gap;
    const Y = (db) => top + (-Math.max(-60, Math.min(0, db)) / 60) * hh;
    // шкала дБ
    x.font = `500 ${8.5 * dpr}px "IBM Plex Mono", ui-monospace, monospace`; x.textAlign = 'right'; x.textBaseline = 'middle';
    for (const db of [0, -6, -12, -18, -24, -36, -48, -60]) {
      const y = Math.round(Y(db)) + 0.5;
      x.fillStyle = css('--text-3'); x.fillText(String(-db), x0 - 3 * dpr, y);
      x.fillStyle = css('--line-2'); x.fillRect(x0, y, bw * 2 + gap, dpr * 0.5);
    }
    for (let i = 0; i < 2; i++) {
      const bx = x0 + i * (bw + gap);
      x.fillStyle = css('--panel-3'); x.fillRect(bx, top, bw, hh);
      const v = this.lv[i];
      if (isFinite(v)) {
        // зелёный до −12, жёлтый до −6, красный выше — сегменты, как у Premiere
        for (const [a, b, col] of [[-60, -12, '#3ddc84'], [-12, -6, '#e8d84a'], [-6, 0, '#ff5a52']]) {
          if (v <= a) continue;
          const y1 = Y(Math.min(v, b)), y0 = Y(a);
          x.fillStyle = col; x.fillRect(bx, y1, bw, y0 - y1);
        }
      }
      const p = this.peak[i];
      if (isFinite(p) && p > -60) { x.fillStyle = p > -6 ? '#ff5a52' : p > -12 ? '#e8d84a' : '#3ddc84'; x.fillRect(bx, Y(p) - dpr, bw, 2 * dpr); }
      // индикатор перегрузки — щелчок по индикатору сбрасывает
      x.fillStyle = this.clip[i] ? '#ff453a' : css('--panel-3');
      x.fillRect(bx, top - 9 * dpr, bw, 5 * dpr);
    }
    x.textAlign = 'center'; x.fillStyle = css('--text-3');
    x.fillText('L', x0 + bw / 2, 12 * dpr); x.fillText('R', x0 + bw * 1.5 + gap, 12 * dpr);
    if (!this.meterClick) {
      this.meterClick = true;
      cv.addEventListener('click', () => { this.clip = [false, false]; this.drawMeter(true); });
    }
  },
};
