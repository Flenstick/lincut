// Стабилизация видео (c.stab = { on, level }). Используемый кусок источника ±1 с проходит vidstab
// в файл <проект>/stab/…mp4 (без звука); превью и экспорт берут картинку из него, звук — из исходника.
// Готовые файлы описаны в store.p.stab (вне истории отмены), как дорожки нейросети.
const STAB_LEVELS = [
  { id: 1, name: 'Слабая', smooth: 10 },
  { id: 2, name: 'Обычная', smooth: 22 },
  { id: 3, name: 'Сильная', smooth: 45 },
];

const Stab = {
  jobs: {},   // name -> { name, mediaId, level, a, b, p }

  init() {
    window.api.onStabProgress((m) => {
      const j = this.jobs[m.name];
      if (j) { j.p = m.p; VoiceSep.redraw(); }
    });
    bus.on('project', debounce(() => this.autoEnsure(), 400));
  },

  canUse(c) { return !!c && c.kind === 'video'; },
  on(c) { return !!(c.stab && c.stab.on); },
  fileFor(c) {
    if (!this.on(c) || !store.p.stab) return null;
    const lv = c.stab.level || 2;
    return store.p.stab.find(s => s.mediaId === c.mediaId && s.level === lv && s.a <= c.in + 0.01 && s.b >= c.out - 0.01) || null;
  },
  jobFor(c) {
    const lv = (c.stab && c.stab.level) || 2;
    return Object.values(this.jobs).find(j => j.mediaId === c.mediaId && j.level === lv && j.a <= c.in + 0.01 && j.b >= c.out - 0.01) || null;
  },
  pendingClips() { return store.allClips().map(x => x.clip).filter(c => this.on(c) && !this.fileFor(c)); },
  // картинка клипа: { path, a } — файл и время источника, с которого он начинается; null — исходник
  altVideo(c) {
    // видео со стёртым текстом (textedit.js) сделано уже из стабилизированного, если стабилизация была
    const te = TextEdit.altVideo(c);
    if (te) return te;
    const st = this.fileFor(c);
    return st ? { path: store.dir + '/stab/' + st.file, a: st.a } : null;
  },

  set(clips, on, level) {
    clips = clips.filter(c => this.canUse(c));
    if (!clips.length) return;
    for (const c of clips) { if (on) c.stab = { on: true, level: level || (c.stab && c.stab.level) || 2 }; else delete c.stab; }
    store.commit('stab');
    Player.requestRender();
    if (on) for (const c of clips) this.ensure(c);
  },

  autoEnsure() {
    if (!store.p) return;
    for (const c of this.pendingClips()) if (!this.jobFor(c)) this.ensure(c);
  },

  async ensure(c) {
    if (!this.on(c) || this.fileFor(c) || this.jobFor(c)) return;
    const m = store.media(c.mediaId);
    if (!m) return;
    const proj = store.p, lv = c.stab.level || 2, L = STAB_LEVELS.find(x => x.id === lv) || STAB_LEVELS[1];
    // начало — ровно на кадре источника, чтобы кадры файла совпадали с кадрами исходника
    const fps = m.fps || 30;
    const a = Math.max(0, Math.floor((c.in - 1) * fps) / fps), b = Math.min(m.duration || c.out + 1, c.out + 1);
    const name = uid();
    this.jobs[name] = { name, mediaId: m.id, level: lv, a, b, p: 0 };
    VoiceSep.redraw();
    try {
      const file = `${name}_s${lv}.mp4`;
      await window.api.stabRun({ name, path: m.path, a, b, smooth: L.smooth, out: store.dir + '/stab/' + file });
      if (store.p !== proj) return;
      (proj.stab = proj.stab || []).push({ id: name, mediaId: m.id, level: lv, a, b, file });
      store.dirty = true;
      bus.emit('changed');
      Player.requestRender();
      toast(`Готово: ${m.name} — видео стабилизировано`, 'ok');
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (store.p === proj && msg !== 'Отменено') {
        for (const x of store.allClips()) if (x.clip.mediaId === m.id && this.on(x.clip) && !this.fileFor(x.clip)) delete x.clip.stab;
        store.commit('stab-fail');
        const pre = h(`<div><p>Не удалось стабилизировать видео.</p><pre class="log"></pre></div>`);
        $('pre', pre).textContent = msg;
        modal({ title: 'Ошибка стабилизации', body: pre, width: 560, buttons: [{ label: 'Закрыть', primary: true }] });
      }
    } finally {
      delete this.jobs[name];
      VoiceSep.redraw();
    }
  },

  cancel(c) {
    if (this.jobFor(c)) window.api.stabCancel();
    this.set([c], false);
  },
};
