// Голос и фон: «Удалить голос» (оставить фон) и «Оставить только голос» для клипа.
// Нейросеть BS-Roformer (audio-separator) делит звук используемого куска источника на две дорожки.
// Готовые дорожки лежат в <проект>/stems, их описание — store.p.stems (вне истории отмены).
const VOICE_MODES = {
  bg: { label: 'Удалить голос', short: 'Без голоса', icon: 'micSlash' },
  voice: { label: 'Оставить только голос', short: 'Только голос', icon: 'userSound' },
};

const VoiceSep = {
  jobs: {},        // name -> { name, mediaId, a, b, p }
  ready: null,     // установлена ли нейросеть (null — ещё не проверяли)

  init() {
    window.api.onSepProgress((m) => {
      const j = m.name && this.jobs[m.name];
      if (j) { j.p = m.p; j.pos = m.stage === 'queue' ? m.pos : 0; this.redraw(); }
    });
    bus.on('project', debounce(() => this.autoEnsure(), 400));
  },

  redraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; Timeline.render(); Inspector.refresh(); });
  },

  canUse(c) { return !!c && (c.kind === 'video' || c.kind === 'audio') && hasAudioTrack(c); },
  stemFor(c) {
    if (!c.voiceMode || !store.p.stems) return null;
    return store.p.stems.find(s => s.mediaId === c.mediaId && s.a <= c.in + 0.01 && s.b >= c.out - 0.01) || null;
  },
  stemPath(st, mode) { return store.dir + '/stems/' + st[mode]; },
  jobFor(c) { return Object.values(this.jobs).find(j => j.mediaId === c.mediaId && j.a <= c.in + 0.01 && j.b >= c.out - 0.01) || null; },
  // клипы, которым нужен звук нейросети, а он ещё не готов
  pendingClips() { return store.allClips().map(x => x.clip).filter(c => c.voiceMode && !this.stemFor(c)); },

  async set(clips, mode) {
    clips = clips.filter(c => this.canUse(c));
    if (!clips.length) return;
    if (mode && !(await this.checkReady(true))) return;
    for (const c of clips) { if (mode) c.voiceMode = mode; else delete c.voiceMode; }
    store.commit('voice');
    Player.requestRender();
    if (mode) for (const c of clips) this.ensure(c);
  },

  async checkReady(interactive) {
    if (this.ready) return true;
    const st = await window.api.sepStatus();
    this.ready = st.env && st.model;
    if (this.ready || !interactive) return this.ready;
    return this.installDialog();
  },

  // Автоматически дообрабатываем, если клип растянули за пределы готового куска
  autoEnsure() {
    if (!store.p || !this.ready) return;
    for (const c of this.pendingClips()) if (!this.jobFor(c)) this.ensure(c);
  },

  async ensure(c) {
    if (!c.voiceMode || this.stemFor(c) || this.jobFor(c)) return;
    const m = store.media(c.mediaId);
    if (!m) return;
    const proj = store.p;
    // с запасом в секунду по краям — чтобы небольшая подрезка клипа не требовала новой обработки
    const a = Math.max(0, c.in - 1), b = Math.min(m.duration || c.out + 1, c.out + 1);
    const name = uid();
    this.jobs[name] = { name, mediaId: m.id, a, b, p: 0 };
    this.redraw();
    try {
      const r = await window.api.sepRun({ path: m.path, a, b, outDir: store.dir + '/stems', name });
      if (store.p !== proj) return;
      (proj.stems = proj.stems || []).push({ id: name, mediaId: m.id, a, b, voice: r.voice.split('/').pop(), bg: r.bg.split('/').pop() });
      store.dirty = true;
      bus.emit('changed');
      Player.requestRender();
      toast(`Готово: ${m.name} — голос и фон разделены`, 'ok');
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (store.p === proj && msg !== 'Отменено') {
        for (const x of store.allClips()) if (x.clip.mediaId === m.id && x.clip.voiceMode && !this.stemFor(x.clip)) delete x.clip.voiceMode;
        store.commit('voice-fail');
        const pre = h(`<div><p>Не удалось разделить голос и фон. Клип оставлен с исходным звуком.</p><pre class="log"></pre></div>`);
        $('pre', pre).textContent = msg;
        modal({ title: 'Ошибка нейросети', body: pre, width: 560, buttons: [{ label: 'Закрыть', primary: true }] });
      }
    } finally {
      delete this.jobs[name];
      this.redraw();
    }
  },

  cancelAll() { if (Object.keys(this.jobs).length) window.api.sepCancel(); },

  installDialog() {
    return AiModels.installDialog('voice', 'Нейросеть для голоса', `Чтобы убрать голос или фон, нужна нейросеть <b>BS-Roformer</b> — как в CapCut. Она загружается один раз,
      в систему ничего не устанавливается. Работает на видеокарте NVIDIA; без неё — на процессоре, заметно медленнее.`).then((ok) => { if (ok) this.ready = true; return ok; });
  },
};
