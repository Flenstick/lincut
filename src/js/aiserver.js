// Где считают нейросети («Голос и фон», трекинг, «Вырезать объект»): на этом компьютере или на сервере
// нейросетей (server/lincut_server.py на другом компьютере с видеокартой). Настройка — localStorage lc.ai.
// Адрес по умолчанию — справочная на сайте: она знает, где сейчас сервер (его адрес в интернете меняется).
const AI_SITE = 'https://hm537533.webhm.cloud/api/ai_server.php';
const AiServer = {
  cfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem('lc.ai') || '{}'); } catch { }
    return Object.assign({ mode: 'local', key: '' }, c, { url: c.url || AI_SITE });
  },
  remote() { const c = this.cfg(); return c.mode === 'remote' && !!c.url; },
  init() { window.api.aiConfig(this.cfg()); },
  save(c) {
    try { localStorage.setItem('lc.ai', JSON.stringify(c)); } catch { }
    window.api.aiConfig(c);
    // готовность нейросетей проверяется заново (на сервере ставить ничего не нужно)
    VoiceSep.ready = null; Track.ready = null;
    Inspector.render();
  },

  dialog() {
    const c = this.cfg();
    let mode = c.mode;
    const body = h(`<div class="ai-srv">
      <div class="seg wide ai-mode"><button data-m="local">${icon('stabilize')}На этом компьютере</button><button data-m="remote">${icon('link')}На сервере</button></div>
      <p class="muted small ai-hint"></p>
      <div class="ai-local-wrap"></div>
      <div class="ai-remote">
        <div class="ex-row"><label>Адрес</label><input class="text-input ai-url" placeholder="${AI_SITE}" spellcheck="false"></div>
        <div class="ex-row"><label>Ключ</label><input class="text-input ai-key" placeholder="lc_…" spellcheck="false"></div>
        <div class="ai-test-row"><button class="chip-btn ai-test">${icon('check')}Проверить</button><span class="ai-state muted small"></span></div>
      </div>
    </div>`);
    const url = $('.ai-url', body), key = $('.ai-key', body), state = $('.ai-state', body);
    const pn = AiModels.panel();
    $('.ai-local-wrap', body).appendChild(pn.el);
    url.value = c.url; key.value = c.key;
    [url, key].forEach(i => i.addEventListener('keydown', (e) => e.stopPropagation()));
    const sync = () => {
      $$('.ai-mode button', body).forEach(b => b.classList.toggle('on', b.dataset.m === mode));
      $('.ai-remote', body).classList.toggle('hidden', mode !== 'remote');
      $('.ai-local-wrap', body).classList.toggle('hidden', mode === 'remote');
      $('.ai-hint', body).textContent = mode === 'remote'
        ? 'Нейросети считает другой компьютер: туда уходит только нужный кусок звука или видео, файлы там удаляются сразу после обработки. Ничего скачивать не нужно.'
        : 'Нейросети работают на этом компьютере. Их можно загрузить заранее одной кнопкой или они загрузятся при первом использовании. Лучше всего — с видеокартой NVIDIA; без неё — на процессоре, медленнее.';
    };
    $('.ai-mode', body).onclick = (e) => { const b = e.target.closest('button'); if (b) { mode = b.dataset.m; sync(); } };
    $('.ai-test', body).onclick = async () => {
      state.textContent = 'Проверяем…'; state.classList.remove('err');
      try {
        const r = await window.api.aiTest({ url: url.value.trim() || AI_SITE, key: key.value });
        if (!r.name) throw new Error('Сервер отвечает, но ключ не принят');
        const g = r.gpu;
        state.textContent = `Подключено: ${g ? `${g.name.replace(/^NVIDIA GeForce /, '')}, ${g.temp}°C` : 'без видеокарты'} · ${r.paused ? 'на паузе' : r.queue ? 'в очереди: ' + r.queue : 'свободен'} · ключ «${r.name}»`;
      } catch (e) {
        state.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        state.classList.add('err');
      }
    };
    modal({ title: 'Нейросети', body, width: 540, onClose: () => pn.dispose(), buttons: [
      { label: 'Отмена' },
      { label: 'Готово', primary: true, onClick: () => {
        const n = { mode, url: url.value.trim() || AI_SITE, key: key.value.trim() };
        if (mode === 'remote' && !n.key) { state.textContent = 'Укажите ключ — его выдаёт владелец сервера'; state.classList.add('err'); return false; }
        this.save(n);
        toast(mode === 'remote' ? 'Нейросети считает сервер' : 'Нейросети считает этот компьютер', 'ok', 1800);
      } },
    ] });
    sync();
  },
};

// Нейросети на этом компьютере: что установлено и загрузка одной кнопкой с прогрессом.
// Загрузка идёт в главном процессе и не зависит от окна: окно можно закрыть — в шапке останется «Нейросети 45%».
const AI_PARTS_UI = {
  voice: { name: 'Голос и фон', model: 'BS-Roformer', icon: 'userSound', hint: 'Удалить голос / оставить только голос' },
  track: { name: 'Трекинг и «Вырезать объект»', model: 'SAM 2', icon: 'track', hint: 'Слежение за объектом, Roto Brush' },
  text: { name: 'Замена текста на кадре', model: 'EasyOCR + LaMa', icon: 'type', hint: 'Найти текст, стереть и вписать новый тем же шрифтом' },
};
const AiModels = {
  prog: null,       // последнее сообщение о загрузке (null — не идёт)
  running: null,    // Promise текущей загрузки
  views: new Set(), // открытые окна, которым нужен прогресс

  init() {
    window.api.onAiInstall((m) => { this.prog = m; this.paint(); });
  },

  // скорость, остаток, «1,2 ГБ из 3,4 ГБ»
  line(m) {
    if (!m) return '';
    const parts = [];
    if (m.known) parts.push(`${fmtSize(m.got)} из ${fmtSize(m.total)}`);
    if (m.speed > 2e4) parts.push(fmtSize(m.speed) + '/с');
    if (m.known && m.speed > 2e4 && m.total > m.got) {
      const s = (m.total - m.got) / m.speed;
      parts.push(s < 60 ? 'меньше минуты' : s < 3600 ? `≈ ${Math.ceil(s / 60)} мин` : `≈ ${Math.floor(s / 3600)} ч ${Math.round(s % 3600 / 60)} мин`);
    }
    return parts.join(' · ');
  },
  pct(m) { return m && m.known && m.total ? Math.min(100, m.got / m.total * 100) : null; },

  paint() {
    const m = this.prog, p = this.pct(m);
    for (const v of this.views) {
      v.wrap.classList.toggle('hidden', !this.running && !v.err);
      v.sync();
      if (!this.running) continue;
      v.bar.classList.toggle('indet', p == null);
      v.bar.firstChild.style.width = p == null ? '' : p.toFixed(1) + '%';
      v.stage.textContent = (m && m.text) || 'Подготовка…';
      v.nums.textContent = (p != null ? Math.floor(p) + '% · ' : '') + this.line(m);
    }
    Tasks.render();
  },

  // parts — что поставить; общий Promise, если загрузка уже идёт
  install(parts) {
    if (this.running) return this.running;
    this.prog = null;
    this.running = window.api.aiInstall(parts).then(() => {
      VoiceSep.ready = null; Track.ready = null;
      return true;
    }).finally(() => { this.running = null; this.paint(); });
    this.paint();
    return this.running;
  },
  cancel() { window.api.aiInstallCancel(); },
  errText: (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),

  // блок «состав + Загрузить все + прогресс» (в окне «Нейросети» и в окнах функций)
  // only — показывать только эти части; onDone — после успешной загрузки
  panel({ only, onDone } = {}) {
    const keys = only || Object.keys(AI_PARTS_UI);
    const el = h(`<div class="ai-local">
      <div class="ai-parts">${keys.map(k => `<div class="ai-part" data-k="${k}">
        <span class="ai-part-ic">${icon(AI_PARTS_UI[k].icon)}</span>
        <div class="ai-part-txt"><b>${esc(AI_PARTS_UI[k].name)}</b><span class="muted small">${esc(AI_PARTS_UI[k].model)} · ${esc(AI_PARTS_UI[k].hint)}</span></div>
        <span class="ai-part-st muted small">…</span></div>`).join('')}</div>
      <div class="ai-dl-row"><button class="primary-btn ai-dl">${icon('download')}<span>Загрузить ${keys.length > 1 ? 'все' : ''}</span></button>
        <button class="secondary-btn ai-stop hidden">Остановить загрузку</button><span class="ai-dl-size muted small"></span></div>
      <div class="ai-prog hidden"><div class="exp-bar"><i></i></div>
        <div class="ai-prog-row"><span class="ai-stage small"></span><span class="ai-nums muted small"></span></div></div>
    </div>`);
    const v = { wrap: $('.ai-prog', el), bar: $('.exp-bar', el), stage: $('.ai-stage', el), nums: $('.ai-nums', el), err: false };
    const btn = $('.ai-dl', el), stop = $('.ai-stop', el);
    let need = keys;
    v.sync = () => sync();
    const refresh = async () => {
      const st = await window.api.aiStatus();
      need = keys.filter(k => !st.parts[k].ready);
      for (const k of keys) {
        const ok = st.parts[k].ready, s = $(`.ai-part[data-k="${k}"] .ai-part-st`, el);
        s.innerHTML = ok ? `${icon('check')}Загружено` : 'Не загружено';
        s.classList.toggle('ok', ok);
      }
      // примерный объём: библиотеки (PyTorch с CUDA ≈ 2,8 ГБ) нужны, если их ещё нет хотя бы для одной части
      const libs = need.some(k => !st.parts[k].pkgs) ? (keys.every(k => !st.parts[k].pkgs) ? 2.8e9 : 0.3e9) : 0;
      const size = libs + need.reduce((s, k) => s + st.parts[k].size, 0);
      $('.ai-dl-size', el).textContent = this.running ? '' : need.length ? `≈ ${fmtSize(size)}, папка ${st.home}` : `Всё загружено · ${st.home}`;
      sync();
    };
    const sync = () => {
      btn.classList.toggle('hidden', !!this.running || !need.length);
      stop.classList.toggle('hidden', !this.running);
      if (this.running) $('.ai-dl-size', el).textContent = '';
    };
    btn.onclick = async () => {
      v.err = false;
      const run = this.install(need);
      sync(); this.paint();
      try {
        await run;
        onDone ? onDone() : refresh();
      } catch (e) {
        const msg = this.errText(e);
        v.err = msg !== 'Отменено';
        v.wrap.classList.toggle('hidden', !v.err);
        v.bar.classList.remove('indet'); v.bar.firstChild.style.width = '0';
        v.stage.textContent = v.err ? 'Ошибка: ' + msg : ''; v.nums.textContent = '';
        $('span', btn).textContent = 'Повторить';
        refresh();
      }
    };
    stop.onclick = () => this.cancel();
    this.views.add(v);
    // окно уже открыто во время загрузки, начатой раньше, — дождаться и обновить состояние
    if (this.running) this.running.then(() => onDone ? onDone() : refresh(), () => refresh());
    refresh();
    this.paint();
    return { el, dispose: () => this.views.delete(v) };
  },

  // окно функции при первом использовании: true — загружено
  installDialog(part, title, text) {
    return new Promise((resolve) => {
      let done = false;
      const body = h(`<div class="sep-install"><p>${text}</p></div>`);
      const pn = this.panel({ only: [part], onDone: () => { done = true; dlg.close(true); } });
      body.appendChild(pn.el);
      const dlg = modal({ title, body, width: 520, onClose: () => { pn.dispose(); resolve(done); }, buttons: [] });
    });
  },
};

// Фоновые задачи в шапке: загрузка нейросетей и обновление программы — кнопкой рядом с кнопками окна
const Tasks = {
  upd: null,
  init() {
    window.api.updState().then((s) => { this.upd = s; this.render(); });
    window.api.onUpdState((s) => { this.upd = s; this.render(); });
    for (const el of $$('[data-tasks]')) el.addEventListener('click', (e) => this.click(e));
  },
  render() {
    const items = [];
    if (AiModels.running) {
      const p = AiModels.pct(AiModels.prog);
      items.push(`<button class="tb-task" data-t="ai" title="${esc((AiModels.prog && AiModels.prog.text) || 'Загрузка нейросетей')}">${icon('sparkles')}Нейросети${p != null ? ' ' + Math.floor(p) + '%' : '…'}</button>`);
    }
    const u = this.upd;
    if (u && u.state === 'downloading') items.push(`<button class="tb-task" data-t="upd" title="Загружается LinCut ${esc(u.version)}">${icon('download')}Обновление ${Math.floor(u.percent || 0)}%</button>`);
    if (u && u.state === 'ready') items.push(`<button class="tb-task ready" data-t="upd" title="Новая версия загружена — LinCut перезапустится, проект сохранится">${icon('download')}Обновить до ${esc(u.version)}</button>`);
    const html = items.join('');
    for (const el of $$('[data-tasks]')) {
      if (el._html === html) continue;
      el._html = html;
      el.innerHTML = html;
    }
  },
  click(e) {
    const b = e.target.closest('.tb-task');
    if (!b) return;
    if (b.dataset.t === 'ai') AiServer.dialog();
    else if (this.upd && this.upd.state === 'ready') this.installUpdate();
    else this.dialog();
  },
  async installUpdate() {
    if (store.p) await App.save();
    window.api.updInstall();
  },
  // «Справка → Проверить обновления»
  async dialog() {
    const body = h(`<div class="upd-dlg"><p class="upd-cur"></p><p class="upd-st muted"></p></div>`);
    const paint = (u) => {
      $('.upd-cur', body).textContent = `Установлена версия ${u.current}`;
      const t = {
        off: 'Автообновление работает в версии для Windows. На Linux LinCut обновляется вместе с исходниками (git pull).',
        idle: 'Проверка…', checking: 'Проверка…',
        none: 'Это последняя версия.',
        downloading: `Загружается версия ${u.version}: ${Math.floor(u.percent || 0)}%${u.speed ? ' · ' + fmtSize(u.speed) + '/с' : ''}. Её можно будет поставить одной кнопкой, или она установится сама при выходе.`,
        ready: `Версия ${u.version} загружена. Нажмите «Перезапустить» — проект сохранится, LinCut откроется уже обновлённым. Или она установится сама при выходе.`,
        error: 'Не удалось проверить обновления: ' + (u.error || 'нет связи с GitHub'),
      }[u.state];
      $('.upd-st', body).textContent = t || '';
      const rb = dlg && $('.modal-foot .primary-btn', dlg.root);
      if (rb) rb.textContent = u.state === 'ready' ? 'Перезапустить' : 'Готово';
    };
    const off = window.api.onUpdState(paint);
    const dlg = modal({ title: 'Обновления', body, width: 440, onClose: () => off(), buttons: [
      { label: 'Готово', primary: true, onClick: () => { if (this.upd && this.upd.state === 'ready') this.installUpdate(); } },
    ] });
    paint(this.upd || await window.api.updState());
    if (this.upd && this.upd.state !== 'off') paint(await window.api.updCheck());
  },
};
