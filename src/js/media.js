// Медиатека: импорт, миниатюры, волны, прокси
const assets = {}; // mediaId -> { poster, sprite(Image), meta, wave, src, ready, missing, proxying }

const Media = {
  get(id) { return assets[id] || (assets[id] = {}); },

  async importPaths(paths, opts = {}) {
    const added = [];
    let failed = 0;
    for (const p of paths) {
      let m = store.p.media.find(x => x.path === p);
      if (m) { added.push(m); continue; }
      try {
        const info = await window.api.probe(p);
        m = { id: uid(), ...info, added: Date.now(), voice: !!opts.voice };
        store.p.media.push(m);
        added.push(m);
        this.prepare(m);
      } catch (e) {
        failed++;
        toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 4000);
      }
    }
    if (added.length) {
      store.commit('import');
      bus.emit('media');
    }
    return added;
  },

  async prepareAll() {
    for (const m of store.p.media) this.prepare(m);
  },

  async prepare(m) {
    const a = this.get(m.id);
    if (a.preparing) return;
    a.preparing = true;
    if (!(await window.api.exists(m.path))) { a.missing = true; bus.emit('media'); return; }
    a.src = fileUrl(m.path);
    const tasks = [];
    if (m.type !== 'audio') {
      tasks.push(window.api.thumbs(m).then((t) => {
        if (!t) return;
        a.poster = fileUrl(t.poster) + '?v=' + m.hash;
        a.meta = t;
        const img = new Image();
        img.onload = () => { a.sprite = img; bus.emit('thumbs', m.id); };
        img.src = fileUrl(t.sprite) + '?v=' + m.hash;
        bus.emit('media');
      }).catch((e) => console.warn('thumbs', e)));
    }
    if (m.hasAudio) {
      tasks.push(window.api.waveform(m).then((w) => { a.wave = w; bus.emit('thumbs', m.id); }).catch((e) => console.warn('wave', e)));
    }
    if (m.type !== 'image') {
      tasks.push(this.checkPlayable(m, a.src).then(async (ok) => {
        if (ok) return;
        a.proxying = true; bus.emit('media');
        try {
          const px = await window.api.proxy(m);
          a.src = fileUrl(px);
          Player.dropElementsFor(m.id);
        } catch (e) { toast('Не удалось подготовить превью: ' + m.name, 'error'); }
        a.proxying = false; bus.emit('media'); Player.requestRender();
      }));
    }
    await Promise.all(tasks);
    a.ready = true;
  },

  checkPlayable(m, src) {
    return new Promise((resolve) => {
      const el = document.createElement(m.type === 'audio' ? 'audio' : 'video');
      el.muted = true; el.preload = 'auto';
      let done = false;
      const fin = (v) => { if (done) return; done = true; el.removeAttribute('src'); el.load(); resolve(v); };
      el.onloadeddata = () => fin(m.type === 'audio' || el.videoWidth > 0 || !m.hasVideo);
      el.onerror = () => fin(false);
      setTimeout(() => fin(el.readyState >= 2 && (m.type === 'audio' || el.videoWidth > 0)), 10000);
      el.src = src;
    });
  },

  usedIds() {
    const s = new Set();
    for (const t of store.p.tracks) for (const c of t.clips) if (c.mediaId) s.add(c.mediaId);
    return s;
  },

  // Вставка из буфера: в позицию курсора. Видео — в главную дорожку (со сдвигом соседей), картинка — поверх
  // (наложение), звук — на звуковую дорожку. Пустой проект — как «по кнопке +».
  placeAt(list, t) {
    const main = store.mainTrack();
    let at = t, last = null;
    for (const m of list) {
      if (!['video', 'image', 'audio'].includes(m.type)) continue;
      const c = makeMediaClip(m, at);
      if (m.type === 'audio') store.place(c, 'audio');
      else if (!main.clips.length) {
        if (store.p.ratio === 'original') applyOriginalRatio(m);
        c.start = 0; main.clips.push(c); store.packMain();
      } else if (m.type === 'image') store.place(c, 'video');
      else if (store.magnet) {
        let i = main.clips.findIndex(x => x.start + clipDur(x) / 2 > at);
        if (i < 0) i = main.clips.length;
        main.clips.splice(i, 0, c);
        store.packMain();
      } else store.place(c, 'video');
      at = c.start + clipDur(c);
      last = c;
    }
    if (!last) return null;
    store.select(last.id);
    store.commit('paste-media');
    Timeline.ensureVisible(last.start);
    return last;
  },

  // Добавление медиа в таймлайн «по кнопке +»
  addToTimeline(m, at) {
    const c = makeMediaClip(m, 0);
    if (m.type === 'audio') {
      c.start = at != null ? at : store.time;
      store.place(c, 'audio');
    } else {
      const main = store.mainTrack();
      if (!main.clips.length && store.p.ratio === 'original') applyOriginalRatio(m);
      c.start = main.clips.length ? clipEnd(main.clips[main.clips.length - 1]) : 0;
      main.clips.push(c);
      store.packMain();
    }
    store.select(c.id);
    store.commit('add');
    return c;
  },
};

// Соотношение «Оригинал»: берём размеры первого видео
function applyOriginalRatio(m) {
  if (!m || !m.width || !m.height) return;
  let w = m.width, hh = m.height;
  const short = Math.min(w, hh);
  if (short > 2160) { const k = 2160 / short; w *= k; hh *= k; }
  if (short < 720) { const k = 720 / short; w *= k; hh *= k; }
  store.p.width = Math.round(w / 2) * 2;
  store.p.height = Math.round(hh / 2) * 2;
  if (m.fps && m.fps >= 23 && m.fps <= 61) store.p.fps = Math.round(m.fps) === 30 || Math.round(m.fps) === 60 || Math.round(m.fps) === 25 || Math.round(m.fps) === 24 || Math.round(m.fps) === 50 ? Math.round(m.fps) : 30;
  bus.emit('resize');
}

function projectRatioLabel() {
  const p = store.p;
  if (p.ratio !== 'original') return p.ratio;
  const g = (a, b) => b ? g(b, a % b) : a;
  const d = g(p.width, p.height);
  const a = p.width / d, b = p.height / d;
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  return (p.width / p.height).toFixed(2) + ':1';
}
