// Изменение голоса: пресеты («Спрингтрап», «Робот», «Бурундук»…) — цепочки фильтров ffmpeg от [in] до [out]
// (вход — моно 48 кГц). Используемый кусок звука обрабатывается в файл <проект>/voicefx, поэтому превью
// и экспорт звучат одинаково. Если у клипа включён «Голос и фон», обрабатывается дорожка нейросети.
// Готовые файлы описаны в store.p.vfx (вне истории отмены), как и дорожки нейросети.
const VOICE_FX = [
  { id: 'springtrap', name: 'Спрингтрап', icon: 'rabbit', hint: 'Низкий хриплый голос аниматроника: рычание, механический динамик, металлическое эхо',
    // ниже на ~5 полутонов + подголосок октавой ниже, «рык» (быстрая амплитудная модуляция), перегруз,
    // узкая полоса старого динамика и короткое металлическое эхо корпуса + отражение от стен
    graph: '[in]highpass=f=80,rubberband=pitch=0.74:formant=shifted:pitchq=quality,asplit=2[m][s];'
      + '[s]rubberband=pitch=0.5:formant=shifted,lowpass=f=900,volume=0.45[sub];'
      + '[m][sub]amix=inputs=2:normalize=0,tremolo=f=42:d=0.35,asoftclip=type=atan:threshold=0.5:output=1.6,'
      + 'highpass=f=140,lowpass=f=5200,equalizer=f=1700:t=q:w=1.2:g=5,equalizer=f=380:t=q:w=1:g=-3,'
      + 'aecho=0.9:0.6:9|17:0.35|0.25,aecho=0.8:0.5:170|320:0.22|0.12,acompressor=threshold=0.1:ratio=4:attack=5:release=120:makeup=2[out]' },
  { id: 'robot', name: 'Робот', icon: 'robot', hint: 'Ровный металлический голос без интонаций',
    graph: '[in]afftfilt=real=\'hypot(re,im)\':imag=\'0\':win_size=512:overlap=0.75,flanger=delay=1:depth=1:regen=30:speed=0.3,'
      + 'highpass=f=120,equalizer=f=2000:t=q:w=1:g=3[out]' },
  { id: 'demon', name: 'Демон', icon: 'skull', hint: 'Очень низкий голос с подголоском, перегрузом и эхом',
    graph: '[in]rubberband=pitch=0.6:formant=shifted:pitchq=quality,asplit=2[a][b];[b]rubberband=pitch=0.5:formant=shifted,volume=0.5[b2];'
      + '[a][b2]amix=inputs=2:normalize=0,asoftclip=type=tanh:threshold=0.6,lowpass=f=4500,aecho=0.8:0.7:60|120|240:0.4|0.3|0.2[out]' },
  { id: 'giant', name: 'Великан', icon: 'footprints', hint: 'Большой и гулкий голос',
    graph: '[in]rubberband=pitch=0.7:formant=shifted:pitchq=quality,equalizer=f=120:t=q:w=1:g=4,aecho=0.8:0.6:90|180:0.3|0.2[out]' },
  { id: 'deep', name: 'Низкий', icon: 'waveform', hint: 'Тот же голос, только ниже',
    graph: '[in]rubberband=pitch=0.84:formant=preserved:pitchq=quality,equalizer=f=150:t=q:w=1:g=2[out]' },
  { id: 'chipmunk', name: 'Бурундук', icon: 'smileyWink', hint: 'Высокий быстрый мультяшный голос',
    graph: '[in]rubberband=pitch=1.75:formant=shifted:pitchq=quality,highpass=f=150[out]' },
  { id: 'cartoon', name: 'Мультяшный', icon: 'micStage', hint: 'Выше обычного, с лёгким дрожанием',
    graph: '[in]rubberband=pitch=1.35:formant=shifted:pitchq=quality,vibrato=f=6:d=0.15,chorus=0.6:0.8:30:0.3:0.3:1.5[out]' },
  { id: 'alien', name: 'Пришелец', icon: 'alien', hint: 'Неземной голос со сдвигом частот и переливами',
    graph: '[in]rubberband=pitch=1.15:formant=shifted,afreqshift=shift=-180,vibrato=f=9:d=0.3,flanger=delay=3:depth=3:regen=50:speed=1[out]' },
  { id: 'ghost', name: 'Призрак', icon: 'ghost', hint: 'Дрожащий голос в пустом зале',
    graph: '[in]rubberband=pitch=0.92:formant=shifted,chorus=0.5:0.9:50|70:0.4|0.3:0.25|0.4:2|1.5,tremolo=f=4:d=0.3,'
      + 'aecho=0.8:0.7:120|260|500:0.5|0.35|0.25,highpass=f=200[out]' },
  { id: 'radio', name: 'Рация', icon: 'radio', hint: 'Узкая полоса, перегруз и шипение эфира',
    graph: '[in]highpass=f=500,lowpass=f=3000,acompressor=threshold=0.05:ratio=8:makeup=4,asoftclip=type=hard:threshold=0.5,'
      + 'acrusher=bits=8:mix=0.4:mode=log:aa=1[v];anoisesrc=c=pink:a=0.015:r=48000,highpass=f=500,lowpass=f=3000[n];'
      + '[v][n]amix=inputs=2:normalize=0:duration=first[out]' },
  { id: 'phone', name: 'Телефон', icon: 'phone', hint: 'Как по телефонной линии',
    graph: '[in]highpass=f=350,lowpass=f=3400,equalizer=f=1500:t=q:w=1:g=6,acrusher=bits=10:mix=0.3:mode=log:aa=1[out]' },
  { id: 'cave', name: 'Пещера', icon: 'mountains', hint: 'Долгое эхо',
    graph: '[in]aecho=0.8:0.8:180|370|620|900:0.45|0.33|0.24|0.15[out]' },
];
const VOICE_FX_BY_ID = Object.fromEntries(VOICE_FX.map(v => [v.id, v]));
// Шумоподавление (c.denoise — сила 1–100): спектральное вычитание с отслеживанием шума, до изменения голоса
const denoiseGraph = (lv) => `highpass=f=70,afftdn=nr=${Math.round(6 + clamp(lv, 1, 100) * 0.34)}:nf=-50:tn=1`;
const needsProc = (c) => !!((c.voiceFx && VOICE_FX_BY_ID[c.voiceFx]) || c.denoise > 0);

const VoiceFx = {
  jobs: {},   // name -> { name, mediaId, fx, mode, a, b }

  init() {
    // клип растянули, сменили голос или нейросеть закончила дорожку — дообрабатываем
    const kick = debounce(() => this.autoEnsure(), 300);
    bus.on('project', kick);
    bus.on('changed', kick);
  },

  canUse(c) { return VoiceSep.canUse(c); },
  fileFor(c) {
    if (!needsProc(c) || !store.p.vfx) return null;
    const mode = c.voiceMode || '', fx = c.voiceFx || '', dn = c.denoise || 0;
    return store.p.vfx.find(v => v.mediaId === c.mediaId && (v.fx || '') === fx && (v.dn || 0) === dn && v.mode === mode && v.a <= c.in + 0.01 && v.b >= c.out - 0.01) || null;
  },
  jobFor(c) {
    const mode = c.voiceMode || '', fx = c.voiceFx || '', dn = c.denoise || 0;
    return Object.values(this.jobs).find(j => j.mediaId === c.mediaId && (j.fx || '') === fx && (j.dn || 0) === dn && j.mode === mode && j.a <= c.in + 0.01 && j.b >= c.out - 0.01) || null;
  },
  pendingClips() { return store.allClips().map(x => x.clip).filter(c => needsProc(c) && !this.fileFor(c)); },

  // Чем заменить звук клипа: { path, a } — файл и время источника, с которого он начинается; null — исходный звук.
  // Пока голос обрабатывается, играет то, что уже есть (дорожка нейросети или исходник).
  altAudio(c) {
    const v = needsProc(c) && this.fileFor(c);
    if (v) return { path: store.dir + '/voicefx/' + v.file, a: v.a };
    const st = c.voiceMode && VoiceSep.stemFor(c);
    if (st) return { path: VoiceSep.stemPath(st, c.voiceMode), a: st.a };
    return null;
  },

  set(clips, fx) {
    clips = clips.filter(c => this.canUse(c));
    if (!clips.length) return;
    for (const c of clips) { if (fx) c.voiceFx = fx; else delete c.voiceFx; }
    store.commit('voice-fx');
    Player.requestRender();
    if (fx) for (const c of clips) this.ensure(c);
  },

  setDenoise(clips, lv) {
    clips = clips.filter(c => this.canUse(c));
    for (const c of clips) { if (lv > 0) c.denoise = Math.round(lv); else delete c.denoise; }
    store.commit('denoise');
    Player.requestRender();
    for (const c of clips) this.ensure(c);
  },

  autoEnsure() {
    if (!store.p) return;
    for (const c of this.pendingClips()) if (!this.jobFor(c)) this.ensure(c);
  },

  async ensure(c) {
    const preset = VOICE_FX_BY_ID[c.voiceFx] || null, dn = c.denoise || 0;
    if (!needsProc(c) || this.fileFor(c) || this.jobFor(c)) return;
    const m = store.media(c.mediaId);
    if (!m) return;
    const mode = c.voiceMode || '';
    // «Голос и фон»: ждём дорожку нейросети и берём звук из неё
    let src = m.path, lo = 0, hi = m.duration || c.out + 1;
    if (mode) {
      const st = VoiceSep.stemFor(c);
      if (!st) return;
      src = VoiceSep.stemPath(st, mode); lo = st.a; hi = st.b;
    }
    const proj = store.p;
    // с запасом в секунду по краям, как у нейросети
    const a = Math.max(lo, c.in - 1), b = Math.min(hi, c.out + 1);
    const name = uid();
    const fx = preset ? preset.id : '';
    this.jobs[name] = { name, mediaId: m.id, fx, dn, mode, a, b };
    VoiceSep.redraw();
    try {
      const file = `${name}_${fx || 'clean'}${dn ? '_dn' + dn : ''}.flac`;
      // шумоподавление — перед голосом; без изменения голоса громкость не выравниваем (шум ушёл, голос тот же)
      let graph = preset ? preset.graph : '[in]anull[out]';
      if (dn) graph = `[in]${denoiseGraph(dn)}[dn0];` + graph.replace('[in]', '[dn0]');
      await window.api.vfxRender({ path: src, ss: a - lo, t: b - a, graph, out: store.dir + '/voicefx/' + file, norm: !!preset });
      if (store.p !== proj) return;
      (proj.vfx = proj.vfx || []).push({ id: name, mediaId: m.id, fx, dn, mode, a, b, file });
      store.dirty = true;
      bus.emit('changed');
      Player.requestRender();
    } catch (e) {
      if (store.p !== proj) return;
      for (const x of store.allClips()) if (x.clip.mediaId === m.id && (x.clip.voiceFx || '') === fx && (x.clip.denoise || 0) === dn && !this.fileFor(x.clip)) { delete x.clip.voiceFx; delete x.clip.denoise; }
      store.commit('voice-fx-fail');
      const pre = h(`<div><p>Не удалось изменить голос. Клип оставлен с исходным звуком.</p><pre class="log"></pre></div>`);
      $('pre', pre).textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      modal({ title: 'Ошибка обработки звука', body: pre, width: 560, buttons: [{ label: 'Закрыть', primary: true }] });
    } finally {
      delete this.jobs[name];
      VoiceSep.redraw();
    }
  },

  // Сетка выбора голоса (инспектор и окно озвучки); onPick(id | null)
  grid(cur, onPick) {
    const tiles = [{ id: '', name: 'Обычный', icon: 'userSound', hint: 'Без изменений' }, ...VOICE_FX];
    const g = h(`<div class="vfx-grid">${tiles.map(v => `<button class="vfx-tile ${v.id === (cur || '') ? 'on' : ''}" data-id="${v.id}" data-tip="${esc(v.hint)}"><span class="vfx-ic">${icon(v.icon)}</span><span>${v.name}</span></button>`).join('')}</div>`);
    g.onclick = (e) => {
      const b = e.target.closest('.vfx-tile'); if (!b) return;
      $$('.vfx-tile', g).forEach(x => x.classList.toggle('on', x === b));
      onPick(b.dataset.id || null);
    };
    return g;
  },
};
