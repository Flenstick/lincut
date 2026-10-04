// Проигрыватель: синхронизация медиаэлементов и отрисовка кадра на canvas
const Player = {
  playing: false,
  els: {},        // clipId -> { el, gain, src }
  imgs: {},       // mediaId -> Image
  k: 1,
  guides: null,
  muted: false,

  init() {
    this.canvas = $('#preview');
    this.ctx = this.canvas.getContext('2d');
    this.ov = $('#overlay');
    this.octx = this.ov.getContext('2d');
    this.stage = $('#stage');
    new ResizeObserver(() => this.resize()).observe(this.stage);
    bus.on('project', () => { this.gc(); this.requestRender(); });
    bus.on('resize', () => this.resize());
    bus.on('selection', () => this.drawOverlay());
    bus.on('theme', () => this.drawOverlay());
    bus.on('time', (src) => { if (src !== 'play') this.requestRender(); });
    this.initInteraction();
  },

  audio() {
    if (!this.actx) {
      this.actx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.actx.createGain();
      this.master.connect(this.actx.destination);
      // индикатор громкости: левый и правый каналы после общего сведения
      const sp = this.actx.createChannelSplitter(2);
      this.master.connect(sp);
      this.meters = [0, 1].map(i => { const a = this.actx.createAnalyser(); a.fftSize = 2048; sp.connect(a, i); return a; });
    }
    return this.actx;
  },

  resize() {
    if (!store.p) return;
    const r = this.stage.getBoundingClientRect();
    const W = store.p.width, H = store.p.height;
    const pad = document.fullscreenElement ? 0 : 16;
    const aw = Math.max(50, r.width - pad * 2), ah = Math.max(50, r.height - pad * 2);
    const s = Math.min(aw / W, ah / H);
    const cw = Math.floor(W * s), ch = Math.floor(H * s);
    const inner = $('#stageInner');
    inner.style.width = cw + 'px';
    inner.style.height = ch + 'px';
    const dpr = window.devicePixelRatio || 1;
    const iw = Math.min(W, Math.round(cw * dpr)), ih = Math.round(iw * H / W);
    this.canvas.width = iw; this.canvas.height = ih;
    this.ov.width = Math.round(r.width * dpr); this.ov.height = Math.round(r.height * dpr);
    const ir = inner.getBoundingClientRect();
    this.offX = ir.left - r.left; this.offY = ir.top - r.top;
    this.k = iw / W;
    this.cssScale = cw / W;
    this.ok = this.cssScale * dpr;
    this.frameW = cw; this.frameH = ch;
    $('#ratioLabel').textContent = projectRatioLabel();
    $('#playerInfo').textContent = `${W}×${H} · ${store.p.fps} к/с`;
    this.requestRender();
  },

  // ---------------------------------------------------------------- элементы
  srcFor(c) { const a = assets[c.mediaId]; return a && !a.missing ? a.src : null; },

  el(c) {
    // стабилизированное видео — свой файл, начинается с времени источника alt.a
    const alt = c.kind === 'video' ? Stab.altVideo(c) : null;
    const src = alt ? fileUrl(alt.path) : this.srcFor(c);
    if (!src) return null;
    let e = this.els[c.id];
    if (e && e.src === src) return e;
    if (e) this.dropEl(c.id);
    const m = store.media(c.mediaId);
    const el = document.createElement(c.kind === 'audio' || (m && !m.hasVideo) ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.src = src;
    el.addEventListener('seeked', () => { if (!this.playing) this.requestRender(); });
    el.addEventListener('loadeddata', () => { if (!this.playing) this.requestRender(); });
    e = { el, src, mediaId: c.mediaId, off: alt ? alt.a : 0 };
    if (m && m.hasAudio) {
      const ac = this.audio();
      e.node = ac.createMediaElementSource(el);
      e.gain = ac.createGain();
      e.gain.gain.value = 0;
      e.node.connect(e.gain).connect(this.master);
    } else el.muted = true;
    this.els[c.id] = e;
    return e;
  },
  // Замена звука клипа (дорожка нейросети или изменённый голос) — отдельный <audio>, картинка остаётся у основного элемента
  stemEls: {},
  stemEl(c, st) {
    const src = fileUrl(st.path);
    let e = this.stemEls[c.id];
    if (e && e.src === src) return e;
    if (e) this.dropStem(c.id);
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.src = src;
    const ac = this.audio();
    e = { el, src, a: st.a, node: ac.createMediaElementSource(el), gain: ac.createGain() };
    e.gain.gain.value = 0;
    e.node.connect(e.gain).connect(this.master);
    this.stemEls[c.id] = e;
    return e;
  },
  dropStem(id) {
    const e = this.stemEls[id];
    if (!e) return;
    try { e.el.pause(); e.node.disconnect(); e.gain.disconnect(); } catch { }
    e.el.removeAttribute('src'); e.el.load();
    delete this.stemEls[id];
  },
  // подвести элемент к нужному месту источника (воспроизведение или стоп)
  drive(el, target, playing, speed, fps) {
    if (playing) {
      const rate = clamp(speed, 0.0625, 16);
      el.preservesPitch = true;
      if (el.paused) {
        if (el.playbackRate !== rate) el.playbackRate = rate;
        if (Math.abs(el.currentTime - target) > 0.04) this.seekEl(el, target, 0);
        el.play().catch(() => { });
      } else if (!el.seeking) {
        // Перемотка во время воспроизведения глушит звук, а в файлах с редкими ключевыми кадрами длится
        // дольше допуска: раньше элемент приходил на уже устаревшее место и перематывался снова — по кругу, без звука.
        // Поэтому небольшой уход догоняем скоростью, а при большом прыгаем с запасом на время прошлой перемотки.
        const d = target - el.currentTime;
        if (Math.abs(d) > 0.6 * Math.max(1, speed)) this.seekEl(el, target, Math.min(1.5, el._lag || 0.25) * speed);
        else {
          const k = Math.abs(d) > 0.03 ? clamp(d * 0.5, -0.08, 0.08) : 0;
          const r = clamp(rate * (1 + k), 0.0625, 16);
          if (Math.abs(el.playbackRate - r) > 0.002) el.playbackRate = r;
        }
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.5 / fps && !el.seeking) el.currentTime = target;
    }
  },
  // перемотка с запоминанием, сколько она заняла (el._lag, сглаженно) — чтобы в следующий раз прыгнуть с запасом
  seekEl(el, target, ahead) {
    if (!el._lagHook) {
      el._lagHook = true;
      el.addEventListener('seeked', () => {
        if (!el._seekAt) return;
        const lag = (performance.now() - el._seekAt) / 1000;
        el._seekAt = 0;
        el._lag = el._lag ? el._lag * 0.5 + lag * 0.5 : lag;
      });
    }
    el._seekAt = performance.now();
    const end = isFinite(el.duration) ? el.duration - 0.05 : Infinity;
    el.currentTime = Math.max(0, Math.min(target + ahead, end));
  },

  dropEl(id) {
    this.dropStem(id);
    const e = this.els[id];
    if (!e) return;
    try { e.el.pause(); } catch { }
    if (e.gain) try { e.node.disconnect(); e.gain.disconnect(); } catch { }
    e.el.removeAttribute('src'); e.el.load();
    delete this.els[id];
  },
  dropElementsFor(mediaId) {
    for (const id of Object.keys(this.els)) if (this.els[id].mediaId === mediaId) this.dropEl(id);
  },
  gc() {
    if (!store.p) return;
    const ids = new Set(store.allClips().map(x => x.clip.id));
    for (const id of Object.keys(this.els)) if (!ids.has(id)) this.dropEl(id);
    for (const id of Object.keys(this.stemEls)) if (!ids.has(id)) this.dropStem(id);
  },
  img(mediaId) {
    let i = this.imgs[mediaId];
    const a = assets[mediaId];
    if (!a || !a.src) return null;
    if (!i || i._src !== a.src) {
      i = new Image();
      i._src = a.src;
      i.onload = () => this.requestRender();
      i.src = a.src;
      this.imgs[mediaId] = i;
    }
    return i.complete && i.naturalWidth ? i : null;
  },
  releaseAll() {
    for (const id of Object.keys(this.els)) this.dropEl(id);
    for (const id of Object.keys(this.stemEls)) this.dropStem(id);
    this.imgs = {};
  },

  // ---------------------------------------------------------------- синхронизация
  sync(t, playing) {
    const fps = store.p.fps;
    // челнок назад (J): элементы не играют, а перематываются на каждый кадр, звука нет
    const back = playing && this.rate < 0;
    if (back) playing = false;
    const rate0 = playing ? this.rate || 1 : 1;
    for (const tr of store.p.tracks) {
      for (const c of tr.clips) {
        if (c.kind !== 'video' && c.kind !== 'audio') continue;
        const s = c.start, e = clipEnd(c);
        const active = t >= s && t < e && !c.disabled;
        const soon = playing && t >= s - 1.2 && t < s && !c.disabled;
        let x = this.els[c.id], y = this.stemEls[c.id];
        if (!active && !soon) {
          if (x && !x.el.paused) x.el.pause();
          if (x && x.gain) x.gain.gain.value = 0;
          if (y) { if (!y.el.paused) y.el.pause(); y.gain.gain.value = 0; }
          continue;
        }
        x = this.el(c);
        if (!x) continue;
        const el = x.el, off = x.off || 0;
        // у стабилизированного файла нет звука — звук играет исходник
        const st = VoiceFx.altAudio(c) || (x.src !== this.srcFor(c) && hasAudioTrack(c) ? { path: store.media(c.mediaId).path, a: 0 } : null);
        y = st ? this.stemEl(c, st) : null;
        if (!st && this.stemEls[c.id]) this.dropStem(c.id);
        if (soon) {
          for (const [e2, t2] of [[el, c.in - off], ...(y ? [[y.el, c.in - y.a]] : [])]) {
            if (!e2.paused) e2.pause();
            if (Math.abs(e2.currentTime - t2) > 0.05 && !e2.seeking) e2.currentTime = t2;
          }
          continue;
        }
        const target = srcAt(c, t - s), rate = rateAt(c, t - s) * rate0;
        this.drive(el, target - off, playing, rate, fps);
        if (y) this.drive(y.el, target - y.a, playing, rate, fps);
        let g = volAt(c, t - s) * audioGainAt(c, tr, t - s) * Duck.gainAt(c, t);
        if (tr.muted || c.muted || this.muted || !playing) g = 0;
        // при готовой замене звука исходный глушим
        if (x.gain) x.gain.gain.setTargetAtTime(y ? 0 : g, this.actx.currentTime, 0.015);
        if (y) y.gain.gain.setTargetAtTime(g, this.actx.currentTime, 0.015);
      }
    }
  },

  // ---------------------------------------------------------------- отрисовка
  requestRender() {
    if (this.playing || this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (!store.p) return;
      this.sync(store.time, false);
      this.render(store.time);
    });
  },

  render(t) {
    const ctx = this.ctx, W = store.p.width, H = store.p.height, k = this.k;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.fillStyle = store.p.bg || '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingQuality = 'high';
    const tracks = store.p.tracks;
    this.fxState = this.fxState || {};
    // обычная отрисовка клипа; размытие в движении и слой-маска — в drawClipLayer (ae.js)
    const plain = (x, c, tt, an) => {
      if (c.kind === 'text') drawText(x, c, W, H, k, an, tt);
      else if (c.kind === 'image') { const im = this.img(c.mediaId); if (im) drawMedia(x, c, im, W, H, k, an, null, tt); }
      else if (c.kind === 'video') this.drawVideo(x, c, tt, W, H, k, an);
    };
    const hideM = matteSources();
    for (let i = tracks.length - 1; i >= 0; i--) {
      const tr = tracks[i];
      if (tr.kind === 'audio' || tr.hidden) continue;
      for (const c of tr.clips) {
        if (t < c.start || t >= clipEnd(c) || c.disabled) continue;
        if (c.kind === 'effect') {
          FXRun.apply(ctx, effectOps(c), t - c.start, clipDur(c), this.fxState[c.id] || (this.fxState[c.id] = {}));
          continue;
        }
        if (hideM.has(c.id)) continue;
        drawClipLayer(ctx, c, tr, t, W, H, k, plain);
      }
      // эффекты переходов применяются к главной дорожке
      if (tr.main) for (const j of junctionFx(tr)) if (t >= j.S && t < j.E) FXRun.apply(ctx, j.ops, t - j.S, j.E - j.S, this.fxState['j' + j.id] || (this.fxState['j' + j.id] = {}));
    }
    ctx.restore();
    this.drawOverlay();
    Scopes.frame();
  },

  // Кадр видео. Пока элемент ищет нужное место — показываем последний кадр или миниатюру, а не чёрный экран
  drawVideo(ctx, c, t, W, H, k, an) {
    const x = this.els[c.id];
    const srcT = srcAt(c, t - c.start), target = srcT - (x ? x.off || 0 : 0);
    const ready = x && x.el.readyState >= 2 && x.el.videoWidth;
    const fresh = ready && !x.el.seeking && Math.abs(x.el.currentTime - target) < 0.35;
    const snap = x && x.snap;
    if (ready && (fresh || !snap || Math.abs(snap.t - target) >= Math.abs(x.el.currentTime - target))) {
      drawMedia(ctx, c, x.el, W, H, k, an, null, t);
      if (!this.playing && !x.el.seeking) this.saveSnap(x, x.el.currentTime);
      return;
    }
    if (snap && Math.abs(snap.t - target) < 0.6) { drawMedia(ctx, c, snap.cv, W, H, k, an, null, t); return; }
    const a = assets[c.mediaId];
    if (a && a.sprite && a.meta) {
      const m = a.meta, idx = clamp(Math.floor(srcT / m.interval), 0, m.count - 1);
      drawMedia(ctx, c, a.sprite, W, H, k, an, [(idx % m.cols) * m.tw, Math.floor(idx / m.cols) * m.th, m.tw, m.th], t);
      return;
    }
    if (snap) { drawMedia(ctx, c, snap.cv, W, H, k, an, null, t); return; }
    if (ready) { drawMedia(ctx, c, x.el, W, H, k, an, null, t); return; }
    if (a && a.proxying) this.drawBadge('Подготовка превью…');
  },
  saveSnap(x, time) {
    const el = x.el;
    if (!x.snap) x.snap = { cv: document.createElement('canvas'), t: -1 };
    const s = x.snap;
    if (Math.abs(s.t - time) < 1e-3) return;
    const w = Math.min(el.videoWidth, 960), hh = Math.round(w * el.videoHeight / el.videoWidth);
    if (s.cv.width !== w || s.cv.height !== hh) { s.cv.width = w; s.cv.height = hh; }
    s.cv.getContext('2d').drawImage(el, 0, 0, w, hh);
    s.t = time;
  },

  drawBadge(txt) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `600 ${Math.round(14 * (window.devicePixelRatio || 1))}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.textAlign = 'center';
    ctx.fillText(txt, this.canvas.width / 2, this.canvas.height / 2);
    ctx.restore();
  },

  // Рамка выделения с ручками
  selBox() {
    const s = store.selected();
    if (!s || !isVisual(s.clip) || s.track.hidden || s.track.locked) return null;
    const c = s.clip;
    if (store.time < c.start || store.time >= clipEnd(c)) return null;
    return { c, b: clipBox(c, store.p.width, store.p.height, store.time) };
  },
  corners(b) {
    const r = b.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const x = sx * b.w / 2, y = sy * b.h / 2;
      return [b.cx + x * cs - y * sn, b.cy + x * sn + y * cs];
    });
  },
  // габариты повёрнутой коробки по осям
  aabb(b) {
    const pts = this.corners(b);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys), cx: b.cx, cy: b.cy };
  },
  rotHandle(b) {
    const r = b.rot * Math.PI / 180;
    const d = b.h / 2 + 26 / this.cssScale;
    return [b.cx - Math.sin(r) * d, b.cy + Math.cos(r) * d];
  },
  // Направляющие: края и центр кадра + края и центры других видимых объектов
  snapTargets(exceptId) {
    const W = store.p.width, H = store.p.height, t = store.time;
    const xs = [{ v: 0, k: 'edge' }, { v: W / 2, k: 'center' }, { v: W, k: 'edge' }];
    const ys = [{ v: 0, k: 'edge' }, { v: H / 2, k: 'center' }, { v: H, k: 'edge' }];
    for (const tr of store.p.tracks) {
      if (tr.kind === 'audio' || tr.kind === 'effect' || tr.hidden) continue;
      for (const c of tr.clips) {
        if (c.id === exceptId || t < c.start || t >= clipEnd(c)) continue;
        const a = this.aabb(clipBox(c, W, H, t));
        xs.push({ v: a.l, k: 'obj', a }, { v: a.cx, k: 'obj', a }, { v: a.r, k: 'obj', a });
        ys.push({ v: a.t, k: 'obj', a }, { v: a.cy, k: 'obj', a }, { v: a.b, k: 'obj', a });
      }
    }
    return { xs, ys };
  },
  drawOverlay() {
    const o = this.octx, k = this.ok;
    if (!o) return;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.ov.width, this.ov.height);
    const dpr = window.devicePixelRatio || 1;
    o.translate(this.offX * dpr, this.offY * dpr);
    const fw = this.frameW * dpr, fh = this.frameH * dpr;
    const acc = css('--accent');
    if (this.pick) { this.drawPick(o, k, dpr); return; }
    if (this.boxPick) { this.drawBoxPick(o, k, dpr); return; }
    if (this.rotoPick) { this.drawRotoPick(o, k, dpr); return; }
    // направляющие привязки
    if (this.guides) {
      o.lineWidth = 1.5 * dpr;
      o.shadowColor = 'rgba(0,0,0,.6)'; o.shadowBlur = 2 * dpr;
      for (const g of this.guides) {
        o.strokeStyle = g.k === 'obj' ? '#ff4fa0' : acc;
        o.setLineDash(g.k === 'obj' ? [5 * dpr, 4 * dpr] : []);
        o.beginPath();
        if (g.axis === 'x') { o.moveTo(g.v * k, 0); o.lineTo(g.v * k, fh); }
        else { o.moveTo(0, g.v * k); o.lineTo(fw, g.v * k); }
        o.stroke();
      }
      o.setLineDash([]);
      o.shadowBlur = 0;
    }
    // контур объекта под курсором
    if (this.hoverClip && (!store.sel || this.hoverClip.id !== store.sel) && !this.guides) {
      const hb = clipBox(this.hoverClip, store.p.width, store.p.height, store.time);
      const pts = this.corners(hb).map(([x, y]) => [x * k, y * k]);
      o.strokeStyle = 'rgba(255,255,255,.45)'; o.lineWidth = dpr;
      o.beginPath(); pts.forEach(([x, y], i) => i ? o.lineTo(x, y) : o.moveTo(x, y)); o.closePath(); o.stroke();
    }
    const s = this.selBox();
    if (!s) return;
    if (this.maskEdit === s.c.id && s.c.mask && s.c.mask.type === 'pen') { this.drawPenEdit(o, s, k, dpr); return; }
    if (this.maskEdit === s.c.id && maskOn(s.c)) { this.drawMaskEdit(o, s, k, dpr); return; }
    const pts = this.corners(s.b).map(([x, y]) => [x * k, y * k]);
    o.strokeStyle = '#ffffff'; o.lineWidth = 1.5 * dpr;
    o.shadowColor = 'rgba(0,0,0,.6)'; o.shadowBlur = 3 * dpr;
    o.beginPath(); pts.forEach(([x, y], i) => i ? o.lineTo(x, y) : o.moveTo(x, y)); o.closePath(); o.stroke();
    o.shadowBlur = 0;
    // угловые ручки — квадратики, как в редакторах
    for (const [x, y] of pts) {
      o.fillStyle = '#fff'; o.fillRect(x - 4.5 * dpr, y - 4.5 * dpr, 9 * dpr, 9 * dpr);
      o.strokeStyle = 'rgba(0,0,0,.45)'; o.lineWidth = dpr; o.strokeRect(x - 4.5 * dpr, y - 4.5 * dpr, 9 * dpr, 9 * dpr);
    }
    const [rx, ry] = this.rotHandle(s.b);
    o.fillStyle = '#fff'; o.beginPath(); o.arc(rx * k, ry * k, 8 * dpr, 0, Math.PI * 2); o.fill();
    o.strokeStyle = '#222'; o.lineWidth = 1.5 * dpr;
    o.beginPath(); o.arc(rx * k, ry * k, 4 * dpr, -Math.PI * 0.9, Math.PI * 0.55); o.stroke();
    // подсказка во время перетаскивания
    if (this.badge) {
      o.font = `600 ${11 * dpr}px "Golos Text", "Adwaita Sans", sans-serif`;
      const tw = o.measureText(this.badge).width + 12 * dpr;
      const bx = clamp(s.b.cx * k - tw / 2, 2, fw - tw - 2), by = clamp(Math.min(...pts.map(p => p[1])) - 26 * dpr, 2, fh - 22 * dpr);
      o.fillStyle = 'rgba(0,0,0,.78)'; roundRect(o, bx, by, tw, 20 * dpr, 4 * dpr); o.fill();
      o.fillStyle = '#fff'; o.textBaseline = 'middle'; o.fillText(this.badge, bx + 6 * dpr, by + 10 * dpr);
    }
  },

  // ---------------------------------------------------------------- маска в превью
  // геометрия маски в координатах проекта: центр, оси фигуры (с поворотом клипа и маски), ручки
  maskGeo(c, b) {
    const m = c.mask, r = b.rot * Math.PI / 180;
    const lx = m.x * b.w, ly = m.y * b.h;
    const cx = b.cx + lx * Math.cos(r) - ly * Math.sin(r), cy = b.cy + lx * Math.sin(r) + ly * Math.cos(r);
    const a = r + m.rot * Math.PI / 180;
    const fw = Math.abs(m.w) * b.w, fh = Math.abs(m.h) * b.h;
    const at = (u, v) => [cx + u * Math.cos(a) - v * Math.sin(a), cy + u * Math.sin(a) + v * Math.cos(a)];
    const hasSize = m.type !== 'line';
    const size = hasSize ? at(m.type === 'mirror' ? 0 : fw / 2, fh / 2) : null;
    const rotH = at(0, -(m.type === 'line' || m.type === 'mirror' ? Math.max(40 / this.cssScale, fh / 2 + 26 / this.cssScale) : fh / 2 + 26 / this.cssScale));
    return { cx, cy, a, fw, fh, size, rotH, at };
  },
  drawMaskEdit(o, s, k, dpr) {
    const c = s.c, m = c.mask, g = this.maskGeo(c, s.b);
    // рамка клипа — тонко, маска — пунктиром
    const pts = this.corners(s.b).map(([x, y]) => [x * k, y * k]);
    o.strokeStyle = 'rgba(255,255,255,.35)'; o.lineWidth = dpr;
    o.beginPath(); pts.forEach(([x, y], i) => i ? o.lineTo(x, y) : o.moveTo(x, y)); o.closePath(); o.stroke();
    o.save();
    o.beginPath(); pts.forEach(([x, y], i) => i ? o.lineTo(x, y) : o.moveTo(x, y)); o.closePath(); o.clip();
    o.translate(g.cx * k, g.cy * k); o.rotate(g.a);
    o.shadowColor = 'rgba(0,0,0,.6)'; o.shadowBlur = 3 * dpr;
    o.strokeStyle = '#fff'; o.lineWidth = 1.5 * dpr; o.setLineDash([6 * dpr, 4 * dpr]);
    const big = (s.b.w + s.b.h) * k * 2;
    if (m.type === 'line') { o.beginPath(); o.moveTo(-big, 0); o.lineTo(big, 0); o.stroke(); }
    else if (m.type === 'mirror') { o.beginPath(); o.moveTo(-big, -g.fh * k / 2); o.lineTo(big, -g.fh * k / 2); o.moveTo(-big, g.fh * k / 2); o.lineTo(big, g.fh * k / 2); o.stroke(); }
    else { maskPath(o, m, g.fw * k, g.fh * k, big); o.stroke(); }
    o.restore();
    const dot = (p, r, fill) => { o.beginPath(); o.arc(p[0] * k, p[1] * k, r * dpr, 0, Math.PI * 2); o.fillStyle = fill; o.fill(); o.lineWidth = 1.5 * dpr; o.strokeStyle = 'rgba(0,0,0,.5)'; o.stroke(); };
    dot([g.cx, g.cy], 5, css('--accent'));
    if (g.size) { o.fillStyle = '#fff'; o.fillRect(g.size[0] * k - 4.5 * dpr, g.size[1] * k - 4.5 * dpr, 9 * dpr, 9 * dpr); }
    dot(g.rotH, 6, '#fff');
    if (this.badge) {
      o.font = `600 ${11 * dpr}px "Golos Text", "Adwaita Sans", sans-serif`;
      const tw = o.measureText(this.badge).width + 12 * dpr, bx = g.cx * k - tw / 2, by = g.cy * k - 34 * dpr;
      o.fillStyle = 'rgba(0,0,0,.78)'; roundRect(o, bx, by, tw, 20 * dpr, 4 * dpr); o.fill();
      o.fillStyle = '#fff'; o.textBaseline = 'middle'; o.fillText(this.badge, bx + 6 * dpr, by + 10 * dpr);
    }
  },
  maskHandleAt(px, py) {
    const s = this.selBox();
    if (!s || this.maskEdit !== s.c.id || !maskOn(s.c) || s.c.mask.type === 'pen') return null;
    const g = this.maskGeo(s.c, s.b), hr = 11 / this.cssScale;
    if (Math.hypot(g.rotH[0] - px, g.rotH[1] - py) < hr) return 'mrot';
    if (g.size && Math.hypot(g.size[0] - px, g.size[1] - py) < hr) return 'msize';
    if (inBox(s.b, px, py)) return 'mmove';
    return null;
  },
  dragMask(e, mode, px, py) {
    const s = this.selBox(), c = s.c, m = c.mask, b = s.b, r = b.rot * Math.PI / 180;
    const m0 = { ...m }, g0 = this.maskGeo(c, b);
    const d0 = Math.hypot(px - g0.cx, py - g0.cy);
    dragMove(e, (ev) => {
      const [qx, qy] = this.toProject(ev);
      if (mode === 'mmove') {
        // сдвиг — в осях клипа
        const dx = qx - px, dy = qy - py;
        const lx = dx * Math.cos(-r) - dy * Math.sin(-r), ly = dx * Math.sin(-r) + dy * Math.cos(-r);
        m.x = Math.round((m0.x + lx / b.w) * 1000) / 1000; m.y = Math.round((m0.y + ly / b.h) * 1000) / 1000;
        if (!ev.altKey) { if (Math.abs(m.x) < 0.015) m.x = 0; if (Math.abs(m.y) < 0.015) m.y = 0; }
        this.badge = null;
      } else if (mode === 'msize') {
        // растяжение: проекция курсора на оси фигуры; Shift — пропорционально
        const dx = qx - g0.cx, dy = qy - g0.cy;
        const u = dx * Math.cos(-g0.a) - dy * Math.sin(-g0.a), v = dx * Math.sin(-g0.a) + dy * Math.cos(-g0.a);
        if (ev.shiftKey && m.type !== 'mirror') { const f = Math.hypot(qx - g0.cx, qy - g0.cy) / Math.max(1, d0); m.w = m0.w * f; m.h = m0.h * f; }
        else { if (m.type !== 'mirror') m.w = Math.max(0.01, Math.abs(u) * 2 / b.w); m.h = Math.max(0.01, Math.abs(v) * 2 / b.h); }
        m.w = Math.round(m.w * 1000) / 1000; m.h = Math.round(m.h * 1000) / 1000;
        this.badge = `${Math.round(m.w * 100)} × ${Math.round(m.h * 100)}%`;
      } else {
        const ang = Math.atan2(qy - g0.cy, qx - g0.cx) + Math.PI / 2 - r;
        let deg = ((ang * 180 / Math.PI % 360) + 540) % 360 - 180;
        if (!ev.altKey) for (const sn of [-180, -90, 0, 90, 180]) if (Math.abs(deg - sn) < 3) deg = sn;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        m.rot = Math.round(deg * 10) / 10;
        this.badge = Math.round(deg) + '°';
      }
      bus.emit('transform');
      this.requestRender();
    }, () => { this.badge = null; store.commit('mask'); this.requestRender(); }, mode === 'mmove' ? 'move' : mode === 'mrot' ? 'grabbing' : 'nwse-resize');
  },

  // ---------------------------------------------------------------- рамка вокруг объекта (трекинг)
  startBoxPick(V, onBox) {
    this.stopPick(); this.stopBoxPick();
    const stage = this.stage, B = this.boxPick = { V, r: null };
    const down = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.button !== 0) { this.stopBoxPick(); return; }
      const [px, py] = this.toProject(e);
      B.r = [px, py, px, py];
      dragMove(e, (ev) => { const [qx, qy] = this.toProject(ev); B.r[2] = qx; B.r[3] = qy; this.drawOverlay(); }, () => {
        const r = B.r;
        this.stopBoxPick();
        const box = Math.abs(r[2] - r[0]) > 6 && Math.abs(r[3] - r[1]) > 6 ? this.boxToSource(V, r) : null;
        if (box) onBox(box); else toast('Обведите объект рамкой побольше', 'info');
      }, 'crosshair');
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.stopBoxPick(); } };
    stage.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    B.off = () => { stage.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); this.ov.style.cursor = ''; };
    this.ov.style.cursor = 'crosshair';
    this.drawOverlay();
  },
  stopBoxPick() {
    if (!this.boxPick) return;
    const B = this.boxPick; this.boxPick = null; B.off(); this.drawOverlay();
  },
  // прямоугольник в координатах проекта → рамка в долях кадра источника видео V [x, y, w, h]
  boxToSource(V, r) {
    const W = store.p.width, H = store.p.height, b = clipBox(V, W, H, store.time), a = -b.rot * Math.PI / 180;
    const us = [], vs = [];
    for (const [px, py] of [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]]) {
      let lx = (px - b.cx) * Math.cos(a) - (py - b.cy) * Math.sin(a), ly = (px - b.cx) * Math.sin(a) + (py - b.cy) * Math.cos(a);
      if (V.flipH) lx = -lx;
      if (V.flipV) ly = -ly;
      us.push(clamp(lx / b.w + 0.5, 0, 1)); vs.push(clamp(ly / b.h + 0.5, 0, 1));
    }
    const x0 = Math.min(...us), x1 = Math.max(...us), y0 = Math.min(...vs), y1 = Math.max(...vs);
    if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return null;
    return [x0, y0, x1 - x0, y1 - y0];
  },
  drawBoxPick(o, k, dpr) {
    const B = this.boxPick, fw = this.frameW * dpr, fh = this.frameH * dpr;
    o.fillStyle = 'rgba(0,0,0,.35)'; o.fillRect(0, 0, fw, fh);
    const vb = this.corners(clipBox(B.V, store.p.width, store.p.height, store.time)).map(([x, y]) => [x * k, y * k]);
    o.strokeStyle = 'rgba(255,255,255,.5)'; o.lineWidth = dpr; o.setLineDash([4 * dpr, 4 * dpr]);
    o.beginPath(); vb.forEach(([x, y], i) => i ? o.lineTo(x, y) : o.moveTo(x, y)); o.closePath(); o.stroke(); o.setLineDash([]);
    if (B.r) {
      const [x0, y0, x1, y1] = B.r.map(v => v * k);
      o.clearRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      o.strokeStyle = css('--accent'); o.lineWidth = 2 * dpr; o.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    const txt = 'Обведите объект рамкой · Esc — отмена';
    o.font = `600 ${12 * dpr}px "Golos Text", "Adwaita Sans", sans-serif`;
    const tw = o.measureText(txt).width + 20 * dpr;
    o.fillStyle = 'rgba(0,0,0,.8)'; roundRect(o, (fw - tw) / 2, 12 * dpr, tw, 26 * dpr, 6 * dpr); o.fill();
    o.fillStyle = '#fff'; o.textBaseline = 'middle'; o.textAlign = 'center'; o.fillText(txt, fw / 2, 25 * dpr); o.textAlign = 'left';
  },

  // ---------------------------------------------------------------- пипетка (хромакей)
  // Цвет берётся из исходного кадра клипа (до цветокоррекции) — как и сам ключ.
  startPick(c, onPick, onEnd) {
    this.stopPick();
    if (this.playing) this.pause();
    const stage = this.stage;
    const P = this.pick = { c, color: null, px: 0, py: 0 };
    this.pickingRaw = true;
    const move = (e) => {
      e.stopPropagation();
      [P.px, P.py] = this.toProject(e);
      P.color = this.sampleSource(c, P.px, P.py);
      this.ov.style.cursor = P.color ? 'crosshair' : 'not-allowed';
      this.drawOverlay();
    };
    const down = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.button === 0 && P.color) { const col = P.color; this.stopPick(); onPick(col); }
      else if (e.button !== 0) this.stopPick();
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.stopPick(); } };
    stage.addEventListener('mousemove', move, true);
    stage.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    P.off = () => {
      stage.removeEventListener('mousemove', move, true);
      stage.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
      this.ov.style.cursor = '';
      onEnd && onEnd();
    };
    this.ov.style.cursor = 'crosshair';
    this.requestRender();
  },
  stopPick() {
    if (!this.pick) return;
    const P = this.pick;
    this.pick = null; this.pickingRaw = false;
    P.off();
    this.requestRender();
  },
  sampleSource(c, px, py) {
    const W = store.p.width, H = store.p.height, t = store.time;
    if (t < c.start || t >= clipEnd(c)) return null;
    const b = clipBox(c, W, H, t), r = -b.rot * Math.PI / 180;
    let lx = (px - b.cx) * Math.cos(r) - (py - b.cy) * Math.sin(r);
    let ly = (px - b.cx) * Math.sin(r) + (py - b.cy) * Math.cos(r);
    if (c.flipH) lx = -lx;
    if (c.flipV) ly = -ly;
    const u = lx / b.w + 0.5, v = ly / b.h + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    let src = null;
    if (c.kind === 'image') src = this.img(c.mediaId);
    else { const x = this.els[c.id]; src = x && x.el.readyState >= 2 ? x.el : x && x.snap ? x.snap.cv : null; }
    if (!src) return null;
    const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
    if (!this.pickCv) { this.pickCv = document.createElement('canvas'); this.pickCv.width = this.pickCv.height = 5; this.pickCtx = this.pickCv.getContext('2d', { willReadFrequently: true }); }
    const sx = clamp(Math.round(u * sw) - 2, 0, Math.max(0, sw - 5)), sy = clamp(Math.round(v * sh) - 2, 0, Math.max(0, sh - 5));
    this.pickCtx.clearRect(0, 0, 5, 5);
    this.pickCtx.drawImage(src, sx, sy, 5, 5, 0, 0, 5, 5);
    const d = this.pickCtx.getImageData(0, 0, 5, 5).data;
    let R = 0, G = 0, B = 0;
    for (let i = 0; i < 100; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
    const hx = (n) => Math.round(n / 25).toString(16).padStart(2, '0');
    return '#' + hx(R) + hx(G) + hx(B);
  },
  drawPick(o, k, dpr) {
    const P = this.pick;
    if (!P.color) return;
    const x = P.px * k, y = P.py * k, R = 22 * dpr;
    // лупа с цветом под курсором, смещена вверх-вправо, чтобы не закрывать точку
    const cx = x + R + 10 * dpr, cy = y - R - 10 * dpr;
    o.save();
    o.shadowColor = 'rgba(0,0,0,.5)'; o.shadowBlur = 8 * dpr;
    o.fillStyle = P.color; o.beginPath(); o.arc(cx, cy, R, 0, Math.PI * 2); o.fill();
    o.shadowBlur = 0;
    o.lineWidth = 3 * dpr; o.strokeStyle = '#fff'; o.stroke();
    o.lineWidth = 1 * dpr; o.strokeStyle = 'rgba(0,0,0,.35)'; o.beginPath(); o.arc(cx, cy, R + 1.5 * dpr, 0, Math.PI * 2); o.stroke();
    o.font = `600 ${10 * dpr}px "Golos Text", Inter, sans-serif`; o.textAlign = 'center'; o.textBaseline = 'top';
    const label = P.color.toUpperCase(), tw = o.measureText(label).width + 10 * dpr;
    o.fillStyle = 'rgba(0,0,0,.75)'; roundRect(o, cx - tw / 2, cy + R + 6 * dpr, tw, 16 * dpr, 4 * dpr); o.fill();
    o.fillStyle = '#fff'; o.fillText(label, cx, cy + R + 9 * dpr);
    o.restore();
  },

  // ---------------------------------------------------------------- мышь в превью
  toProject(e) {
    const r = this.ov.getBoundingClientRect();
    return [(e.clientX - r.left - this.offX) / this.cssScale, (e.clientY - r.top - this.offY) / this.cssScale];
  },
  hitClip(px, py) {
    const W = store.p.width, H = store.p.height, t = store.time;
    for (const tr of store.p.tracks) {
      if (tr.kind === 'audio' || tr.kind === 'effect' || tr.hidden || tr.locked) continue;
      for (const c of tr.clips) {
        if (t < c.start || t >= clipEnd(c)) continue;
        if (inBox(clipBox(c, W, H, t), px, py)) return c;
      }
    }
    return null;
  },
  handleAt(px, py) {
    const s = this.selBox();
    if (!s) return null;
    const hr = 11 / this.cssScale;
    if (this.corners(s.b).some(([x, y]) => Math.hypot(x - px, y - py) < hr)) return 'scale';
    const [rx, ry] = this.rotHandle(s.b);
    if (Math.hypot(rx - px, ry - py) < hr) return 'rotate';
    if (inBox(s.b, px, py)) return 'move';
    return null;
  },
  initInteraction() {
    const ov = this.ov;
    ov.addEventListener('mousemove', (e) => {
      if (document.body.classList.contains('dragging') || !store.p) return;
      const [px, py] = this.toProject(e);
      const pen = this.penActive();
      if (pen) {
        const hit = this.penHit(pen.c, pen.b, px, py);
        ov.style.cursor = hit.kind === 'add' ? 'crosshair' : hit.kind === 'seg' ? 'copy' : hit.kind === 'shape' ? 'move' : 'pointer';
        if (this.penHover !== hit.kind + (hit.i ?? '')) { this.penHover = hit.kind + (hit.i ?? ''); this.drawOverlay(); }
        return;
      }
      const mh = this.maskHandleAt(px, py);
      if (mh) { ov.style.cursor = mh === 'mmove' ? 'move' : mh === 'mrot' ? 'grab' : 'nwse-resize'; return; }
      const h_ = this.handleAt(px, py);
      const hc = h_ ? null : this.hitClip(px, py);
      ov.style.cursor = h_ === 'scale' ? 'nwse-resize' : h_ === 'rotate' ? 'grab' : h_ === 'move' ? 'move' : hc ? 'pointer' : 'default';
      if (hc !== this.hoverClip) { this.hoverClip = hc; this.drawOverlay(); }
    });
    ov.addEventListener('mouseleave', () => { if (this.hoverClip) { this.hoverClip = null; this.drawOverlay(); } });
    ov.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !store.p) return;
      if (this.playing) this.pause();
      const [px, py] = this.toProject(e);
      const pen = this.penActive();
      if (pen) { this.penDown(e, pen, px, py); return; }
      const mh = this.maskHandleAt(px, py);
      if (mh) { this.dragMask(e, mh, px, py); return; }
      let mode = this.handleAt(px, py);
      if (!mode) {
        const c = this.hitClip(px, py);
        if (!c) { store.select(null); return; }
        store.select(c.id);
        mode = 'move';
      }
      const s = this.selBox();
      if (!s) return;
      const c = s.c, T = store.time, t0 = tfAt(c, T), b0 = s.b;
      const d0 = Math.hypot(px - b0.cx, py - b0.cy);
      const targets = this.snapTargets(c.id);
      this.hoverClip = null;
      dragMove(e, (ev) => {
        const [qx, qy] = this.toProject(ev);
        const th = 7 / this.cssScale;
        if (mode === 'move') {
          let x = t0.x + qx - px, y = t0.y + qy - py;
          const guides = [];
          if (!ev.altKey) {
            // проверяем левый край, центр и правый край объекта против всех направляющих
            const a = this.aabb({ ...b0, cx: b0.cx + (x - t0.x), cy: b0.cy + (y - t0.y) });
            const snap1 = (vals, list, axis) => {
              let best = null;
              for (const v of vals) for (const g of list) { const d = g.v - v; if (Math.abs(d) < th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, g }; }
              if (best) guides.push({ axis, v: best.g.v, k: best.g.k });
              return best ? best.d : 0;
            };
            x += snap1([a.l, a.cx, a.r], targets.xs, 'x');
            y += snap1([a.t, a.cy, a.b], targets.ys, 'y');
          }
          this.guides = guides;
          setTf(c, { x: Math.round(x), y: Math.round(y) }, T);
          this.badge = null;
        } else if (mode === 'scale') {
          const d = Math.hypot(qx - b0.cx, qy - b0.cy);
          let sc = clamp(t0.scale * d / Math.max(1, d0), 0.05, 20);
          // привязка к 100% и к размеру кадра
          if (!ev.altKey && Math.abs(sc - 1) < 0.03) sc = 1;
          setTf(c, { scale: sc }, T);
          this.badge = Math.round(sc * 100) + '%';
        } else if (mode === 'rotate') {
          const ang = Math.atan2(qy - b0.cy, qx - b0.cx) - Math.PI / 2;
          let deg = ang * 180 / Math.PI;
          deg = ((deg % 360) + 540) % 360 - 180;
          if (!ev.altKey) for (const sn of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) if (Math.abs(deg - sn) < 3) deg = sn;
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          setTf(c, { rotation: Math.round(deg * 10) / 10 }, T);
          this.badge = Math.round(deg) + '°';
        }
        bus.emit('transform');
        this.requestRender();
      }, () => {
        this.guides = null;
        this.badge = null;
        store.commit('transform');
        this.requestRender();
      }, mode === 'move' ? 'move' : mode === 'rotate' ? 'grabbing' : 'nwse-resize');
    });
    // Delete — удалить выбранную вершину маски пером (а не клип)
    document.addEventListener('keydown', (e) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || this.penSel == null) return;
      if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
      const pen = this.penActive();
      if (!pen) return;
      e.preventDefault(); e.stopImmediatePropagation();
      penRemove(pen.c.mask, this.penSel);
      this.penSel = null;
      store.commit('mask'); this.requestRender();
    }, true);
    ov.addEventListener('dblclick', () => {
      const s = store.selected();
      if (s && s.clip.kind === 'text') { const ta = $('#inspector textarea'); if (ta) { ta.focus(); ta.select(); } }
    });
    ov.addEventListener('wheel', (e) => {
      const s = this.selBox();
      if (!s || !e.ctrlKey) return;
      e.preventDefault();
      const cur = tfAt(s.c, store.time);
      setTf(s.c, { scale: clamp(cur.scale * (e.deltaY < 0 ? 1.05 : 0.95), 0.05, 20) }, store.time);
      bus.emit('transform'); this.requestRender();
      clearTimeout(this.wheelT); this.wheelT = setTimeout(() => store.commit('scale'), 400);
    }, { passive: false });
  },

  // ---------------------------------------------------------------- маска пером
  penSel: null,
  penActive() {
    const s = this.selBox();
    if (!s || this.maskEdit !== s.c.id || !s.c.mask || s.c.mask.type !== 'pen' || this.rotoPick) return null;
    return s;
  },
  // доли размера клипа (от центра) ↔ координаты проекта
  penGeo(b) {
    const r = b.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    return {
      toP: (u, v) => { const lx = u * b.w, ly = v * b.h; return [b.cx + lx * cs - ly * sn, b.cy + lx * sn + ly * cs]; },
      toM: (px, py) => { const dx = px - b.cx, dy = py - b.cy; return [(dx * cs + dy * sn) / b.w, (-dx * sn + dy * cs) / b.h]; },
    };
  },
  penPath2D(pts, g, k = 1) {
    const P = new Path2D(), n = pts.length;
    if (n < 2) return P;
    const at = (u, v) => g.toP(u, v).map(x => x * k);
    P.moveTo(...at(pts[0][0], pts[0][1]));
    for (let i = 0; i < (n >= 3 ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      P.bezierCurveTo(...at(a[0] + a[4], a[1] + a[5]), ...at(b[0] + b[2], b[1] + b[3]), ...at(b[0], b[1]));
    }
    if (n >= 3) P.closePath();
    return P;
  },
  penHit(c, b, px, py) {
    const m = c.mask, pts = penPtsAt(m, srcTime(c, store.time)) || [], g = this.penGeo(b), hr = 9 / this.cssScale, n = pts.length;
    const sel = this.penSel;
    if (sel != null && pts[sel]) {
      const p = pts[sel];
      for (const [kind, ix] of [['hout', 4], ['hin', 2]]) {
        if (!p[ix] && !p[ix + 1]) continue;
        const q = g.toP(p[0] + p[ix], p[1] + p[ix + 1]);
        if (Math.hypot(q[0] - px, q[1] - py) < hr) return { kind, i: sel };
      }
    }
    for (let i = 0; i < n; i++) { const q = g.toP(pts[i][0], pts[i][1]); if (Math.hypot(q[0] - px, q[1] - py) < hr) return { kind: 'v', i }; }
    let best = null;
    for (let i = 0; i < (n >= 3 ? n : n - 1); i++) {
      const a = pts[i], bb = pts[(i + 1) % n];
      const P0 = g.toP(a[0], a[1]), P1 = g.toP(a[0] + a[4], a[1] + a[5]), P2 = g.toP(bb[0] + bb[2], bb[1] + bb[3]), P3 = g.toP(bb[0], bb[1]);
      for (let j = 1; j < 32; j++) {
        const u = j / 32, w = 1 - u;
        const x = w * w * w * P0[0] + 3 * w * w * u * P1[0] + 3 * w * u * u * P2[0] + u * u * u * P3[0];
        const y = w * w * w * P0[1] + 3 * w * w * u * P1[1] + 3 * w * u * u * P2[1] + u * u * u * P3[1];
        const d = Math.hypot(x - px, y - py);
        if (d < hr * 0.8 && (!best || d < best.d)) best = { kind: 'seg', i, u, d };
      }
    }
    if (best) return best;
    if (n >= 3 && measureCtx.isPointInPath(this.penPath2D(pts, g), px, py)) return { kind: 'shape' };
    return { kind: 'add' };
  },
  penDown(e, s, px, py) {
    const c = s.c, m = c.mask, g = this.penGeo(s.b), S = srcTime(c, store.time);
    if (!m.pts) m.pts = [];
    const hit = this.penHit(c, s.b, px, py);
    const P0 = deep(penPtsAt(m, S));
    const done = () => { this.badge = null; store.commit('mask'); this.requestRender(); };
    const delta = (ev) => { const [u, v] = g.toM(...this.toProject(ev)), [u0, v0] = g.toM(px, py); return [u - u0, v - v0]; };
    if (hit.kind === 'v' && e.altKey) {
      // Alt — угол ↔ сглаженная вершина
      penEdit(m, S, (pts) => {
        const n = pts.length, p = pts[hit.i];
        if (p[2] || p[3] || p[4] || p[5]) { p[2] = p[3] = p[4] = p[5] = 0; return; }
        const a = pts[(hit.i - 1 + n) % n], b = pts[(hit.i + 1) % n];
        const dx = +((b[0] - a[0]) / 6).toFixed(4), dy = +((b[1] - a[1]) / 6).toFixed(4);
        p[2] = -dx; p[3] = -dy; p[4] = dx; p[5] = dy;
      });
      this.penSel = hit.i; done();
      return;
    }
    if (hit.kind === 'add') {
      const [u, v] = g.toM(px, py), idx = P0.length;
      penInsert(m, idx, () => [+u.toFixed(4), +v.toFixed(4), 0, 0, 0, 0]);
      this.penSel = idx;
      this.requestRender();
      // тянем сразу после щелчка — вытягиваем ручки кривой
      dragMove(e, (ev) => {
        const [du, dv] = delta(ev);
        if (Math.hypot(du * s.b.w, dv * s.b.h) * this.cssScale < 3) return;
        penEdit(m, S, (pts) => { const p = pts[idx]; p[4] = du; p[5] = dv; p[2] = -du; p[3] = -dv; });
        this.requestRender();
      }, done, 'crosshair');
      return;
    }
    if (hit.kind === 'seg') {
      const ins = (pts) => { const n = pts.length, sp = penSplit(pts, hit.i, hit.u); pts[hit.i] = sp.a; pts[(hit.i + 1) % n] = sp.b; pts.splice(hit.i + 1, 0, sp.p); };
      if (m.keys && m.keys.length) { m.keys.forEach(kf => ins(kf.pts)); m.pts = m.keys[0].pts; } else ins(m.pts);
      this.penSel = hit.i + 1;
      hit.kind = 'v'; hit.i = hit.i + 1;
      P0.splice(0, P0.length, ...deep(penPtsAt(m, S)));
    }
    if (hit.kind === 'v') {
      this.penSel = hit.i;
      this.requestRender();
      dragMove(e, (ev) => {
        const [du, dv] = delta(ev);
        penEdit(m, S, (pts) => { const p = pts[hit.i]; p[0] = +(P0[hit.i][0] + du).toFixed(4); p[1] = +(P0[hit.i][1] + dv).toFixed(4); });
        bus.emit('transform'); this.requestRender();
      }, done, 'move');
      return;
    }
    if (hit.kind === 'hin' || hit.kind === 'hout') {
      const ix = hit.kind === 'hin' ? 2 : 4, ox = hit.kind === 'hin' ? 4 : 2;
      dragMove(e, (ev) => {
        const [u, v] = g.toM(...this.toProject(ev));
        penEdit(m, S, (pts) => {
          const p = pts[hit.i];
          p[ix] = +(u - p[0]).toFixed(4); p[ix + 1] = +(v - p[1]).toFixed(4);
          // без Alt ручки остаются на одной прямой (сглаженная вершина)
          if (!ev.altKey) { p[ox] = -p[ix]; p[ox + 1] = -p[ix + 1]; }
        });
        this.requestRender();
      }, done, 'grabbing');
      return;
    }
    if (hit.kind === 'shape') {
      this.penSel = null;
      dragMove(e, (ev) => {
        const [du, dv] = delta(ev);
        penEdit(m, S, (pts) => pts.forEach((p, j) => { p[0] = +(P0[j][0] + du).toFixed(4); p[1] = +(P0[j][1] + dv).toFixed(4); }));
        bus.emit('transform'); this.requestRender();
      }, done, 'move');
    }
  },
  drawPenEdit(o, s, k, dpr) {
    const c = s.c, m = c.mask, pts = penPtsAt(m, srcTime(c, store.time)) || [], g = this.penGeo(s.b), n = pts.length;
    const box = this.corners(s.b).map(([x, y]) => [x * k, y * k]);
    o.strokeStyle = 'rgba(255,255,255,.35)'; o.lineWidth = dpr;
    o.beginPath(); box.forEach(([x, y], i) => i ? o.lineTo(x, y) : o.moveTo(x, y)); o.closePath(); o.stroke();
    const col = '#ffd60a';
    o.save();
    o.shadowColor = 'rgba(0,0,0,.65)'; o.shadowBlur = 3 * dpr;
    o.strokeStyle = col; o.lineWidth = 1.5 * dpr;
    if (n >= 2) o.stroke(this.penPath2D(pts, g, k));
    o.restore();
    const sel = this.penSel != null && pts[this.penSel] ? this.penSel : null;
    if (sel != null) {
      const p = pts[sel], v = g.toP(p[0], p[1]).map(x => x * k);
      for (const ix of [2, 4]) {
        if (!p[ix] && !p[ix + 1]) continue;
        const q = g.toP(p[0] + p[ix], p[1] + p[ix + 1]).map(x => x * k);
        o.strokeStyle = 'rgba(255,255,255,.8)'; o.lineWidth = dpr;
        o.beginPath(); o.moveTo(...v); o.lineTo(...q); o.stroke();
        o.beginPath(); o.arc(q[0], q[1], 4 * dpr, 0, Math.PI * 2); o.fillStyle = '#fff'; o.fill(); o.strokeStyle = 'rgba(0,0,0,.5)'; o.stroke();
      }
    }
    pts.forEach((p, i) => {
      const [x, y] = g.toP(p[0], p[1]).map(v => v * k), r = 4 * dpr;
      o.fillStyle = i === sel ? col : 'rgba(20,20,22,.9)';
      o.fillRect(x - r, y - r, r * 2, r * 2);
      o.strokeStyle = col; o.lineWidth = 1.5 * dpr; o.strokeRect(x - r, y - r, r * 2, r * 2);
    });
    const kf = m.keys && m.keys.length ? penKeyIndex(m, srcTime(c, store.time)) >= 0 : false;
    const txt = n < 3 ? 'Щёлкайте по кадру, чтобы ставить точки контура · тяните — кривая'
      : 'Тяните точки и ручки · щелчок по контуру — новая точка · Alt+щелчок — угол/кривая · Delete — удалить точку' + (kf ? ' · ◆ ключ формы' : '');
    this.drawHint(o, txt, dpr);
  },
  drawHint(o, txt, dpr) {
    const fw = this.frameW * dpr;
    o.font = `600 ${11.5 * dpr}px "Golos Text", "Adwaita Sans", sans-serif`;
    let t = txt;
    while (o.measureText(t).width > fw - 40 * dpr && t.includes(' · ')) t = t.slice(0, t.lastIndexOf(' · '));
    const tw = o.measureText(t).width + 20 * dpr;
    o.fillStyle = 'rgba(0,0,0,.8)'; roundRect(o, (fw - tw) / 2, 10 * dpr, tw, 24 * dpr, 6 * dpr); o.fill();
    o.fillStyle = '#fff'; o.textBaseline = 'middle'; o.textAlign = 'center'; o.fillText(t, fw / 2, 22 * dpr); o.textAlign = 'left';
  },

  // ---------------------------------------------------------------- ротоскоп: выделение объекта
  pointToSource(V, px, py) {
    const W = store.p.width, H = store.p.height, b = clipBox(V, W, H, store.time), a = -b.rot * Math.PI / 180;
    let lx = (px - b.cx) * Math.cos(a) - (py - b.cy) * Math.sin(a), ly = (px - b.cx) * Math.sin(a) + (py - b.cy) * Math.cos(a);
    if (V.flipH) lx = -lx;
    if (V.flipV) ly = -ly;
    const u = lx / b.w + 0.5, v = ly / b.h + 0.5;
    return u < 0 || u > 1 || v < 0 || v > 1 ? null : [u, v];
  },
  startRotoPick(P) {
    this.stopPick(); this.stopBoxPick();
    this.rotoPick = P;
    this.pickingRaw = true;
    const stage = this.stage;
    const down = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.button === 1) return;
      const [px, py] = this.toProject(e);
      const neg = e.button === 2 || e.altKey;
      let r = null;
      dragMove(e, (ev) => {
        const [qx, qy] = this.toProject(ev);
        if (!neg && Math.hypot(qx - px, qy - py) * this.cssScale > 8) { r = [px, py, qx, qy]; P.drag = r; this.drawOverlay(); }
      }, () => {
        P.drag = null;
        if (r) { const box = this.boxToSource(P.c, r); if (box) Roto.setBox(box); else this.drawOverlay(); return; }
        const uv = this.pointToSource(P.c, px, py);
        if (uv) Roto.addPoint(uv[0], uv[1], neg ? 0 : 1);
      }, 'crosshair');
    };
    const menu = (e) => { e.preventDefault(); e.stopPropagation(); };
    const key = (e) => {
      if (e.target.closest && e.target.closest('input, textarea')) return;
      if (e.key === 'Escape') Roto.stopPick(false);
      else if (e.key === 'Enter') Roto.stopPick(true);
      else if (e.key === 'Backspace' || (e.ctrlKey && (e.key === 'z' || e.key === 'я'))) Roto.undoPoint();
      else return;
      e.stopPropagation(); e.preventDefault();
    };
    stage.addEventListener('mousedown', down, true);
    stage.addEventListener('contextmenu', menu, true);
    document.addEventListener('keydown', key, true);
    P.off = () => {
      stage.removeEventListener('mousedown', down, true);
      stage.removeEventListener('contextmenu', menu, true);
      document.removeEventListener('keydown', key, true);
      this.ov.style.cursor = '';
    };
    this.ov.style.cursor = 'crosshair';
    this.requestRender();
  },
  stopRotoPick() {
    const P = this.rotoPick;
    if (!P) return;
    this.rotoPick = null; this.pickingRaw = false;
    P.off();
    this.requestRender();
  },
  drawRotoPick(o, k, dpr) {
    const P = this.rotoPick, c = P.c, fw = this.frameW * dpr, fh = this.frameH * dpr;
    const b = clipBox(c, store.p.width, store.p.height, store.time);
    const place = (x) => {
      x.translate(b.cx * k, b.cy * k); x.rotate(b.rot * Math.PI / 180); x.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
    };
    if (P.mask) {
      // вне объекта — затемнение, сам объект — лёгкая подсветка
      const L = layerCanvas('rotoOv', Math.ceil(fw), Math.ceil(fh)), x = L.getContext('2d');
      x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, 0, L.width, L.height);
      x.save(); place(x); x.globalCompositeOperation = 'destination-out';
      x.drawImage(P.mask, -b.w * k / 2, -b.h * k / 2, b.w * k, b.h * k); x.restore();
      o.drawImage(L, 0, 0);
      const T = layerCanvas('rotoTint', Math.ceil(fw), Math.ceil(fh)), y = T.getContext('2d');
      y.save(); place(y); y.drawImage(P.mask, -b.w * k / 2, -b.h * k / 2, b.w * k, b.h * k); y.restore();
      y.globalCompositeOperation = 'source-in'; y.fillStyle = css('--accent'); y.fillRect(0, 0, T.width, T.height);
      o.save(); o.globalAlpha = 0.28; o.drawImage(T, 0, 0); o.restore();
    } else { o.fillStyle = 'rgba(0,0,0,.25)'; o.fillRect(0, 0, fw, fh); }
    const toP = (u, v) => { const q = Track.project(c, store.time, u, v); return [q.x * k, q.y * k]; };
    if (P.box) {
      const [x0, y0, w, hh] = P.box, pts = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + hh], [x0, y0 + hh]].map(([u, v]) => toP(u, v));
      o.strokeStyle = css('--accent'); o.lineWidth = 1.5 * dpr; o.setLineDash([5 * dpr, 4 * dpr]);
      o.beginPath(); pts.forEach(([x, y], i) => i ? o.lineTo(x, y) : o.moveTo(x, y)); o.closePath(); o.stroke(); o.setLineDash([]);
    }
    if (P.drag) {
      const [x0, y0, x1, y1] = P.drag.map(v => v * k);
      o.strokeStyle = css('--accent'); o.lineWidth = 2 * dpr; o.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    for (const [u, v, l] of P.pts) {
      const [x, y] = toP(u, v), r = 7 * dpr;
      o.beginPath(); o.arc(x, y, r, 0, Math.PI * 2);
      o.fillStyle = l ? '#30c75e' : '#ff453a'; o.fill();
      o.lineWidth = 2 * dpr; o.strokeStyle = '#fff'; o.stroke();
      o.strokeStyle = '#fff'; o.lineWidth = 1.8 * dpr; o.beginPath();
      o.moveTo(x - r * 0.45, y); o.lineTo(x + r * 0.45, y);
      if (l) { o.moveTo(x, y - r * 0.45); o.lineTo(x, y + r * 0.45); }
      o.stroke();
    }
    this.drawHint(o, P.busy ? 'Нейросеть ищет объект…' : 'ЛКМ — объект · ПКМ — убрать лишнее · тяните — рамка · Enter — вырезать на всём клипе · Esc — отмена', dpr);
  },

  // ---------------------------------------------------------------- транспорт
  // rate — скорость челнока J/K/L: 1, 2, 4, 8 вперёд или −1…−8 назад
  rate: 1,
  play(rate = 1) {
    if (!store.p) return;
    const dur = store.duration();
    if (dur <= 0) return;
    if (rate > 0 && store.time >= dur - 0.02) store.setTime(0);
    if (rate < 0 && store.time <= 0.001) return;
    this.audio().resume();
    this.playing = true;
    this.setRate(rate);
    $('#btnPlay').innerHTML = icon('pause');
    bus.emit('play', true);
    Scopes.meterLoop();
    const loop = () => {
      if (!this.playing) return;
      let t = this.t0 + (performance.now() - this.n0) / 1000 * this.rate;
      if (this.rate < 0 && t <= 0) {
        store.setTime(0, 'play');
        this.pause();
        return;
      }
      const end = this.stopAt != null ? this.stopAt : store.duration();
      if (t >= end && !this.noStop) {
        t = end;
        store.setTime(t, 'play');
        this.pause();
        return;
      }
      store.time = t;
      bus.emit('time', 'play');
      this.sync(t, true);
      this.render(t);
      requestAnimationFrame(loop);
    };
    this.sync(store.time, true);
    requestAnimationFrame(loop);
  },
  setRate(r) {
    this.rate = r;
    this.t0 = store.time;
    this.n0 = performance.now();
    const el = $('#shuttle');
    if (el) { el.classList.toggle('hidden', r === 1); el.textContent = (r < 0 ? '◀ ' : '▶ ') + Math.abs(r) + '×'; }
  },
  pause() {
    this.stopAt = null;
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    $('#shuttle').classList.add('hidden');
    for (const x of [...Object.values(this.els), ...Object.values(this.stemEls)]) { try { x.el.pause(); } catch { } if (x.gain) x.gain.gain.value = 0; }
    $('#btnPlay').innerHTML = icon('play');
    bus.emit('play', false);
    store.setTime(store.time);
  },
  toggle() { this.playing ? this.pause() : this.play(); },

  captureCover() {
    try {
      const c = document.createElement('canvas');
      const w = 360, hh = Math.round(360 * store.p.height / store.p.width);
      c.width = w; c.height = hh;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(this.canvas, 0, 0, w, hh);
      // пустой чёрный кадр (превью ещё не отрисовано) обложкой не сохраняем
      const d = x.getImageData(0, 0, w, hh).data;
      let lit = 0; for (let i = 0; i < d.length; i += 4 * 53) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
      if (!lit) return null;
      return c.toDataURL('image/jpeg', 0.8);
    } catch (e) { return null; }
  },
};

function inBox(b, px, py) {
  const r = -b.rot * Math.PI / 180;
  const dx = px - b.cx, dy = py - b.cy;
  const x = dx * Math.cos(r) - dy * Math.sin(r), y = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(x) <= b.w / 2 && Math.abs(y) <= b.h / 2;
}
