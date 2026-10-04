// Ротоскоп — как Roto Brush в After Effects: щелчками в превью отмечаем объект (ЛКМ) и лишнее (ПКМ),
// нейросеть SAM 2 сразу показывает маску кадра, а потом протягивает её по всему клипу.
// Маски — PNG на каждый кадр источника в <проект>/roto/<id>/ (белый с прозрачностью, мягкий край),
// описание — store.p.roto [{ id, mediaId, a, b, fps, n, dir }] (вне истории отмены).
// c.roto = { on, id, invert, prompts: [{ s, pts: [[u, v, 1|0]], box }] } — s — время источника кадра подсказки.
const Roto = {
  jobs: {},          // name -> { name, clipId, p }
  cache: new Map(),  // `${id}:${idx}` -> Image
  pick: null,

  init() {
    window.api.onRotoProgress((m) => {
      const j = this.jobs[m.name];
      if (j) { j.p = m.p; VoiceSep.redraw(); }
    });
    bus.on('time', () => { if (this.pick && !Player.playing) this.retarget(); });
  },
  // курсор ушёл на другой кадр — подсказки этого кадра (если были), маска — заново
  retarget() {
    const P = this.pick, c = P.c;
    if (store.time < c.start || store.time >= clipEnd(c)) { this.stopPick(false); return; }
    const s = srcAt(c, store.time - c.start), k = Math.floor((s - P.R.a) * P.R.fps + 1e-3), fs = P.R.a + k / P.R.fps;
    if (Math.abs(fs - P.fs) < 1e-6) return;
    P.edits.set(P.fs, { pts: P.pts, box: P.box });
    const ed = [...P.edits].find(([x]) => Math.abs(x - fs) < 0.5 / P.R.fps);
    const prev = ed ? ed[1] : (c.roto && c.roto.prompts || []).find(p => Math.abs(p.s - fs) < 0.5 / P.R.fps);
    Object.assign(P, { fs, ss: Math.max(0, fs - 0.25 / P.R.fps), pts: prev ? deep(prev.pts) : [], box: prev ? prev.box || null : null, mask: null });
    this.update();
  },

  canUse(c) { return !!c && c.kind === 'video'; },
  data(c) {
    if (!c.roto || !c.roto.id || !store.p.roto) return null;
    const d = store.p.roto.find(x => x.id === c.roto.id);
    return d && d.mediaId === c.mediaId ? d : null;
  },
  // маска действует: включена, посчитана и покрывает клип; со стабилизацией не сочетается (другие кадры)
  on(c) {
    if (!c || !c.roto || !c.roto.on || Stab.on(c)) return false;
    const d = this.data(c);
    return !!d && d.a <= c.in + 0.5 / d.fps && d.b >= c.out - 0.5 / d.fps;
  },
  jobFor(c) { return Object.values(this.jobs).find(j => j.clipId === c.id) || null; },
  dirOf(d) { return store.dir + '/roto/' + d.dir; },
  // номер кадра маски для времени источника (тот кадр, что показывает <video>)
  idxOf(d, s) { return clamp(Math.floor((s - d.a) * d.fps + 1e-3), 0, d.n - 1); },

  img(d, i) {
    const key = d.id + ':' + i;
    let im = this.cache.get(key);
    if (im) return im;
    if (this.cache.size > 360) this.cache.delete(this.cache.keys().next().value);
    im = new Image();
    im.decoding = 'async';
    im.onload = () => { im.ok = true; if (!Player.playing) Player.requestRender(); };
    im.src = fileUrl(this.dirOf(d) + '/' + String(i).padStart(6, '0') + '.png');
    this.cache.set(key, im);
    return im;
  },
  // картинка маски для момента time таймлайна; пока нужный кадр грузится — ближайший готовый
  frameFor(c, time) {
    const d = this.data(c);
    if (!d) return null;
    const t = time != null ? time : store.time;
    const i = this.idxOf(d, srcAt(c, t - c.start));
    const im = this.img(d, i);
    if (Player.playing) for (let j = 1; j <= 24; j++) if (i + j < d.n) this.img(d, i + j);
    if (im.ok) return im;
    for (let r = 1; r <= 20; r++) {
      for (const j of [i - r, i + r]) {
        const x = j >= 0 && j < d.n && this.cache.get(d.id + ':' + j);
        if (x && x.ok) return x;
      }
    }
    return null;
  },

  // кусок источника для нейросети: используемый ±0,5 с, начало — ровно на кадре
  range(c) {
    const m = store.media(c.mediaId), fps = (m && m.fps) || 30;
    const a = Math.max(0, Math.floor((c.in - 0.5) * fps + 1e-6) / fps);
    const b = Math.min((m && m.duration) || c.out + 0.5, c.out + 0.5);
    return { a, b, fps };
  },

  // ---------------------------------------------------------------- выделение в превью
  async start(c) {
    if (!this.canUse(c)) return;
    if (Stab.on(c)) { toast('Вырезание объекта не работает вместе со стабилизацией — выключите её', 'error', 3200); return; }
    if (!(await Track.checkReady(true))) return;
    if (Player.playing) Player.pause();
    if (store.time < c.start || store.time >= clipEnd(c)) store.setTime(c.start + Math.min(0.3, clipDur(c) / 2));
    const m = store.media(c.mediaId);
    const R = this.range(c);
    const s = srcAt(c, store.time - c.start), k = Math.floor((s - R.a) * R.fps + 1e-3), fs = R.a + k / R.fps;
    const prev = (c.roto && c.roto.prompts || []).find(p => Math.abs(p.s - fs) < 0.5 / R.fps);
    this.pick = { c, R, fs, ss: Math.max(0, fs - 0.25 / R.fps), video: m.path, pts: prev ? deep(prev.pts) : [], box: prev ? prev.box || null : null, mask: null, busy: false, seq: 0, edits: new Map() };
    Player.startRotoPick(this.pick);
    Inspector.render();
    if (this.pick.pts.length || this.pick.box) this.update();
  },
  async update() {
    const P = this.pick;
    if (!P) return;
    if (!P.pts.length && !P.box) { P.mask = null; Player.drawOverlay(); Inspector.refresh(); return; }
    const seq = ++P.seq;
    P.busy = true; Inspector.refresh(); Player.drawOverlay();
    try {
      const r = await window.api.rotoMask({ video: P.video, ss: P.ss, pts: P.pts, box: P.box });
      if (this.pick !== P || seq !== P.seq) return;
      const im = new Image();
      im.onload = () => { if (this.pick === P && seq === P.seq) { P.mask = im; P.score = r.score; Player.drawOverlay(); } };
      im.src = fileUrl(r.out) + '?' + seq;
    } catch (e) {
      if (this.pick === P) toast('Нейросеть: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 4000);
    } finally {
      if (this.pick === P && seq === P.seq) { P.busy = false; Inspector.refresh(); Player.drawOverlay(); }
    }
  },
  addPoint(u, v, label) { const P = this.pick; if (!P) return; P.pts.push([+u.toFixed(4), +v.toFixed(4), label]); this.update(); },
  setBox(box) { const P = this.pick; if (!P) return; P.box = box.map(x => +x.toFixed(4)); this.update(); },
  undoPoint() { const P = this.pick; if (!P) return; if (P.pts.length) P.pts.pop(); else P.box = null; this.update(); },
  clearPoints() { const P = this.pick; if (!P) return; P.pts = []; P.box = null; this.update(); },
  stopPick(apply) {
    const P = this.pick;
    if (!P) return;
    this.pick = null;
    Player.stopRotoPick();
    if (!apply) window.api.rotoStop();
    Inspector.render();
    if (apply) this.run(P);
  },

  // ---------------------------------------------------------------- проход по всем кадрам
  async run(P) {
    const c = P.c, proj = store.p, R = this.range(c);
    // подсказки отредактированных кадров заменяют прежние на тех же кадрах
    P.edits.set(P.fs, { pts: P.pts, box: P.box });
    const tol = 0.5 / R.fps, ed = [...P.edits];
    const prompts = (c.roto && c.roto.prompts || []).filter(p => !ed.some(([x]) => Math.abs(p.s - x) < tol));
    for (const [x, e] of ed) if (e.pts.length || e.box) prompts.push({ s: x, pts: e.pts, box: e.box });
    prompts.sort((a, b) => a.s - b.s);
    if (!prompts.length) { toast('Отметьте объект хотя бы одной точкой', 'info'); return; }
    const name = uid();
    this.jobs[name] = { name, clipId: c.id, p: 0 };
    VoiceSep.redraw(); Inspector.render();
    try {
      const m = store.media(c.mediaId);
      const job = { name, video: m.path, a: R.a, b: R.b, fps: R.fps, out: store.dir + '/roto/' + name,
        prompts: prompts.map(p => ({ k: Math.round((p.s - R.a) * R.fps), pts: p.pts, box: p.box || null })) };
      const meta = await window.api.rotoRun(job);
      if (store.p !== proj) return;
      const old = c.roto && c.roto.id;
      proj.roto = (proj.roto || []).filter(x => x.id !== old || store.allClips().some(y => y.clip !== c && y.clip.roto && y.clip.roto.id === old));
      proj.roto.push({ id: name, mediaId: m.id, a: R.a, b: R.b, fps: R.fps, n: meta.n, dir: name });
      c.roto = { on: true, id: name, invert: !!(c.roto && c.roto.invert), prompts };
      store.commit('roto');
      Player.requestRender();
      toast('Готово — объект вырезан на всём клипе', 'ok', 2600);
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (msg !== 'Отменено') {
        const pre = h(`<div><p>Не удалось вырезать объект.</p><pre class="log"></pre></div>`);
        $('pre', pre).textContent = msg;
        modal({ title: 'Ошибка нейросети', body: pre, width: 560, buttons: [{ label: 'Закрыть', primary: true }] });
      }
    } finally {
      delete this.jobs[name];
      VoiceSep.redraw();
      Inspector.render();
    }
  },
  cancel(c) { if (this.jobFor(c)) window.api.rotoCancel(); },
  remove(c) {
    delete c.roto;
    store.commit('roto-off');
    Player.requestRender();
  },
  // для экспорта: шаблон файлов кадров и их соответствие времени источника
  exportInfo(c) {
    const d = this.data(c);
    return d ? { pattern: this.dirOf(d) + '/%06d.png', a: d.a, fps: d.fps, n: d.n } : null;
  },
};
