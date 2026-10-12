// Трекинг объекта — как в CapCut. Нейросеть SAM 2 (или быстрый трекер OpenCV) находит объект, обведённый рамкой,
// на каждом кадре используемого куска видео. Траектория (store.p.trk, вне истории отмены) превращается
// в обычные ключевые кадры клипа, поэтому превью и экспорт совпадают, а любой кадр можно поправить руками.
// c.follow = { mode, trk, target, smooth, size, zoom, ref: { T0, tf } }:
//   attach — клип (текст, стикер, картинка) едет за объектом видео target;
//   camera — видео приближено и держит объект в центре кадра;
//   lock   — объект стоит на месте, а мир вокруг двигается.
const FOLLOW_MODES = {
  attach: { name: 'За объектом', icon: 'track', hint: 'Клип едет за объектом в видео под ним' },
  camera: { name: 'Камера следит', icon: 'follow', hint: 'Видео приближено, объект всё время в центре кадра' },
  lock: { name: 'Захват', icon: 'lockOn', hint: 'Объект стоит на месте, мир вокруг двигается' },
};

const Track = {
  jobs: {},       // name -> { name, clipId, p }
  ready: null,
  engine: 'sam2',

  init() {
    try { this.engine = localStorage.getItem('lc.trkEngine') || 'sam2'; } catch { }
    window.api.onTrkProgress((m) => {
      const j = m.name && this.jobs[m.name];
      if (j) { j.p = m.p; j.pos = m.stage === 'queue' ? m.pos : 0; VoiceSep.redraw(); }
    });
  },
  setEngine(e) { this.engine = e; try { localStorage.setItem('lc.trkEngine', e); } catch { } },

  jobFor(c) { return Object.values(this.jobs).find(j => j.clipId === c.id) || null; },
  data(c) { return c.follow && store.p.trk ? store.p.trk.find(t => t.id === c.follow.trk) : null; },

  // видео, по которому следим: для «за объектом» — верхнее видео под клипом в момент курсора
  targetFor(c, mode) {
    if (mode !== 'attach') return c.kind === 'video' ? { clip: c, track: store.find(c.id).track } : null;
    const f = store.find(c.id), tr = store.p.tracks, i = tr.indexOf(f.track), t = store.time;
    const inside = (x) => t >= x.start && t < clipEnd(x);
    for (let k = i + 1; k < tr.length; k++) {
      if (tr[k].hidden || tr[k].kind !== 'video') continue;
      const v = tr[k].clips.find(x => x.kind === 'video' && inside(x));
      if (v) return { clip: v, track: tr[k] };
    }
    return null;
  },

  async checkReady(interactive) {
    if (this.ready) return true;
    const st = await window.api.trkStatus();
    this.ready = st.env && st.pkgs && st.model;
    if (this.ready || !interactive) return this.ready;
    return this.installDialog();
  },

  // 1) рамка вокруг объекта в превью → 2) трекинг → 3) ключевые кадры
  async start(c, mode) {
    const tg = this.targetFor(c, mode);
    if (!tg) { toast(mode === 'attach' ? 'Под клипом в этом месте нет видео — поставьте курсор над видео' : 'Трекинг камеры — только для видео', 'error', 3200); return; }
    const V = tg.clip;
    if (!(await this.checkReady(true))) return;
    if (Player.playing) Player.pause();
    if (store.time < V.start || store.time >= clipEnd(V) - 0.05) store.setTime(V.start + Math.min(0.3, clipDur(V) / 2));
    if (store.time < c.start || store.time >= clipEnd(c)) store.setTime(clamp(store.time, c.start, clipEnd(c) - 0.05));
    Player.startBoxPick(V, (box) => this.run(c, mode, V, box));
  },

  async run(c, mode, V, box) {
    const m = store.media(V.mediaId);
    if (!m) return;
    const proj = store.p, T0 = store.time;
    // начальное положение клипа — от него считаем смещение и масштаб (повторное применение не накапливается)
    const prev = c.follow && c.follow.ref;
    const tf = prev ? prev.tf : tfAt(c, T0);
    const name = uid();
    this.jobs[name] = { name, clipId: c.id, p: 0 };
    VoiceSep.redraw();
    try {
      const fps = Math.min(30, m.fps || 30);
      const alt = Stab.altVideo(V);
      const src = alt ? { path: alt.path, off: alt.a } : { path: m.path, off: 0 };
      const t0 = srcAt(V, T0 - V.start);
      const r = await window.api.trkRun({ name, path: src.path, a: V.in - src.off, b: V.out - src.off, t0: t0 - src.off, box, engine: this.engine, fps });
      if (store.p !== proj) return;
      r.pts.forEach(p => { p[0] += src.off; });
      const id = uid();
      // старые траектории не удаляем сразу — на них ссылаются шаги отмены (Ctrl+Z после повторного трекинга)
      proj.trk = this.prune(proj.trk || []);
      proj.trk.push({ id, mediaId: m.id, fps: r.fps, engine: r.engine, pts: r.pts });
      c.follow = { mode, trk: id, target: V.id, smooth: c.follow ? c.follow.smooth : 35, size: c.follow ? c.follow.size : mode !== 'camera', zoom: c.follow ? c.follow.zoom : 1.5, ref: { T0, t0, tf } };
      this.apply(c);
      store.commit('track');
      Player.requestRender();
      toast(r.engine === 'face' ? 'Трекинг готов — лицо найдено на всём клипе' : r.engine === 'csrt' && this.engine === 'sam2' ? 'Готово (нейросеть недоступна — использован быстрый трекер)' : 'Трекинг готов — объект найден на всём клипе', 'ok', 2600);
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (msg !== 'Отменено') {
        const pre = h(`<div><p>Не удалось отследить объект.</p><pre class="log"></pre></div>`);
        $('pre', pre).textContent = msg;
        modal({ title: 'Ошибка трекинга', body: pre, width: 560, buttons: [{ label: 'Закрыть', primary: true }] });
      }
    } finally {
      delete this.jobs[name];
      VoiceSep.redraw();
      Inspector.render();
    }
  },
  cancel(c) { if (this.jobFor(c)) window.api.trkCancel(); },

  remove(c) {
    if (!c.follow) return;
    const tf = c.follow.ref.tf;
    c.keys = [];
    putTf(c, keyPick(tf));
    delete c.follow;
    store.p.trk = this.prune(store.p.trk || []);
    store.commit('track-off');
    Player.requestRender();
  },

  // траектории, на которые не ссылается ни один клип, нужны только для отмены — храним последние 8
  prune(list) {
    const used = new Set();
    for (const tr of store.p.tracks) for (const x of tr.clips) if (x.follow) used.add(x.follow.trk);
    const spare = list.filter(x => !used.has(x.id)).slice(-8);
    return list.filter(x => used.has(x.id) || spare.includes(x));
  },

  // траектория: пропуски (объект потерян) — по соседям, затем сглаживание по Гауссу
  path(d, smooth) {
    const P = d.pts, n = P.length;
    const good = P.map(p => p[5] > 0);
    const val = (k) => P.map(p => p[k]);
    const fill = (a) => {
      const out = a.slice();
      let last = -1;
      for (let i = 0; i < n; i++) {
        if (!good[i]) continue;
        if (last >= 0 && i - last > 1) for (let j = last + 1; j < i; j++) out[j] = a[last] + (a[i] - a[last]) * (j - last) / (i - last);
        if (last < 0) for (let j = 0; j < i; j++) out[j] = a[i];
        last = i;
      }
      if (last >= 0) for (let j = last + 1; j < n; j++) out[j] = a[last];
      return out;
    };
    const sig = clamp(smooth, 0, 100) / 100 * 0.35 * d.fps;
    const blur = (a) => {
      if (sig < 0.3) return a;
      const R = Math.ceil(sig * 3), w = [];
      for (let k = -R; k <= R; k++) w.push(Math.exp(-k * k / (2 * sig * sig)));
      return a.map((_, i) => { let s = 0, ws = 0; for (let k = -R; k <= R; k++) { const j = i + k; if (j < 0 || j >= n) continue; s += a[j] * w[k + R]; ws += w[k + R]; } return s / ws; });
    };
    const cx = blur(fill(val(1))), cy = blur(fill(val(2)));
    const sz = blur(fill(P.map(p => Math.sqrt(Math.max(1e-6, p[3] * p[4])))));
    return P.map((p, i) => ({ s: p[0], cx: cx[i], cy: cy[i], sz: sz[i] }));
  },

  // точка источника V (доли кадра) → координаты проекта в момент T
  project(V, T, u, v) {
    const W = store.p.width, H = store.p.height, b = clipBox(V, W, H, T), r = b.rot * Math.PI / 180;
    let lx = (u - 0.5) * b.w, ly = (v - 0.5) * b.h;
    if (V.flipH) lx = -lx;
    if (V.flipV) ly = -ly;
    return { x: b.cx + lx * Math.cos(r) - ly * Math.sin(r), y: b.cy + lx * Math.sin(r) + ly * Math.cos(r), k: b.w };
  },

  apply(c) {
    const f = c.follow, d = this.data(c);
    if (!f || !d) return;
    const V = f.mode === 'attach' ? (store.find(f.target) || {}).clip : c;
    if (!V) { toast('Видео для трекинга удалено', 'error'); return; }
    const W = store.p.width, H = store.p.height, tf = f.ref.tf;
    const pts = this.path(d, f.smooth);
    // опорный момент — где рисовали рамку
    const near = (s) => pts.reduce((a, p) => Math.abs(p.s - s) < Math.abs(a.s - s) ? p : a, pts[0]);
    const r0 = near(f.ref.t0);
    const keys = [];
    if (f.mode === 'attach') {
      // смещение клипа от объекта в опорный момент сохраняется (и масштабируется вместе с объектом)
      const V0 = { ...V, keys: null, transform: { ...tfAt(V, f.ref.T0) } };
      const P0 = this.project(V0, f.ref.T0, r0.cx, r0.cy), S0 = r0.sz * P0.k;
      const off = { x: W / 2 + tf.x - P0.x, y: H / 2 + tf.y - P0.y };
      for (const p of pts) {
        if (p.s < V.in - 1e-6 || p.s > V.out + 1e-6) continue;
        const T = V.start + ltAt(V, p.s);
        if (T < c.start - 1e-6 || T > clipEnd(c) + 1e-6) continue;
        const P = this.project(V, T, p.cx, p.cy), k = f.size ? (p.sz * P.k) / Math.max(1e-6, S0) : 1;
        keys.push({ s: srcTime(c, T), x: P.x - W / 2 + off.x * k, y: P.y - H / 2 + off.y * k, scale: tf.scale * k, rotation: tf.rotation, opacity: tf.opacity, sx: tf.sx, sy: tf.sy, rx: tf.rx, ry: tf.ry });
      }
    } else {
      // видео двигается само: положение, при котором объект оказывается в точке Q
      const ms = mediaSize(V), fit = Math.min(W / ms.w, H / ms.h), rot = tf.rotation * Math.PI / 180;
      const Z0 = f.mode === 'camera' ? tf.scale * f.zoom : tf.scale;
      const base = { ...V, keys: null, transform: { ...tf } };
      const Q = f.mode === 'camera' ? { x: W / 2, y: H / 2 } : this.project(base, f.ref.T0, r0.cx, r0.cy);
      for (const p of pts) {
        if (p.s < V.in - 1e-6 || p.s > V.out + 1e-6) continue;
        const Z = f.size ? Z0 * r0.sz / Math.max(1e-6, p.sz) : Z0;
        const bw = ms.w * fit * Z, bh = ms.h * fit * Z;
        let lx = (p.cx - 0.5) * bw, ly = (p.cy - 0.5) * bh;
        if (V.flipH) lx = -lx;
        if (V.flipV) ly = -ly;
        let x = Q.x - W / 2 - (lx * Math.cos(rot) - ly * Math.sin(rot));
        let y = Q.y - H / 2 - (lx * Math.sin(rot) + ly * Math.cos(rot));
        // «камера» не показывает края кадра, если видео больше кадра
        if (f.mode === 'camera' && Math.abs(Math.sin(rot)) < 1e-3) {
          if (bw >= W) x = clamp(x, -(bw - W) / 2, (bw - W) / 2);
          if (bh >= H) y = clamp(y, -(bh - H) / 2, (bh - H) / 2);
        }
        keys.push({ s: p.s, x, y, scale: Z, rotation: tf.rotation, opacity: tf.opacity, sx: tf.sx, sy: tf.sy, rx: tf.rx, ry: tf.ry });
      }
    }
    c.keys = this.simplify(keys);
  },

  // Прореживание ключей (Рамер — Дуглас — Пекер): допуск пиксель кадра и 0,4% масштаба
  simplify(K) {
    if (K.length <= 2) return K.map(k => ({ ...k, x: Math.round(k.x * 10) / 10, y: Math.round(k.y * 10) / 10 }));
    const keep = new Uint8Array(K.length); keep[0] = keep[K.length - 1] = 1;
    const tolXY = 1, tolS = 0.004;
    const rec = (a, b) => {
      let worst = -1, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const f = (K[i].s - K[a].s) / Math.max(1e-9, K[b].s - K[a].s);
        const ex = K[a].x + (K[b].x - K[a].x) * f, ey = K[a].y + (K[b].y - K[a].y) * f, es = K[a].scale + (K[b].scale - K[a].scale) * f;
        const e = Math.max(Math.hypot(K[i].x - ex, K[i].y - ey) / tolXY, Math.abs(K[i].scale - es) / tolS);
        if (e > worst) { worst = e; wi = i; }
      }
      if (worst > 1) { keep[wi] = 1; rec(a, wi); rec(wi, b); }
    };
    rec(0, K.length - 1);
    return K.filter((_, i) => keep[i]).map(k => ({ ...k, x: Math.round(k.x * 10) / 10, y: Math.round(k.y * 10) / 10, scale: Math.round(k.scale * 1e4) / 1e4 }));
  },

  installDialog() {
    return AiModels.installDialog('track', 'Нейросеть для трекинга', `Для трекинга и «Вырезать объект» нужна нейросеть <b>SAM 2</b> — она находит объект на каждом кадре, даже если он
      поворачивается или ненадолго скрывается. Загружается один раз, в систему ничего не устанавливается. Вместе с ней ставится быстрый трекер OpenCV.`).then((ok) => { if (ok) this.ready = true; return ok; });
  },
};
