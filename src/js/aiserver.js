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
      <div class="ai-remote">
        <div class="ex-row"><label>Адрес</label><input class="text-input ai-url" placeholder="${AI_SITE}" spellcheck="false"></div>
        <div class="ex-row"><label>Ключ</label><input class="text-input ai-key" placeholder="lc_…" spellcheck="false"></div>
        <div class="ai-test-row"><button class="chip-btn ai-test">${icon('check')}Проверить</button><span class="ai-state muted small"></span></div>
      </div>
    </div>`);
    const url = $('.ai-url', body), key = $('.ai-key', body), state = $('.ai-state', body);
    url.value = c.url; key.value = c.key;
    [url, key].forEach(i => i.addEventListener('keydown', (e) => e.stopPropagation()));
    const sync = () => {
      $$('.ai-mode button', body).forEach(b => b.classList.toggle('on', b.dataset.m === mode));
      $('.ai-remote', body).classList.toggle('hidden', mode !== 'remote');
      $('.ai-hint', body).textContent = mode === 'remote'
        ? 'Нейросети считает другой компьютер: туда уходит только нужный кусок звука или видео, файлы там удаляются сразу после обработки. Ничего скачивать не нужно.'
        : 'Нейросети ставятся на этот компьютер при первом использовании (несколько ГБ). Лучше всего — с видеокартой NVIDIA.';
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
    modal({ title: 'Нейросети', body, width: 500, buttons: [
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
