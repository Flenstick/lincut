// Импорт по ссылке: YouTube, TikTok, VK, Rutube и всё, что умеет yt-dlp. Видео или только звук;
// файл скачивается в папку проекта и попадает в медиатеку. Загрузки показываются карточками в медиатеке.
const Links = {
  downloads: [],   // { name, url, title, thumb, mode, p, stage, proj }

  init() {
    window.api.onUrlProgress((m) => {
      const d = this.downloads.find(x => x.name === m.name);
      if (d) { d.p = m.p; d.stage = m.stage; this.paint(d); }
    });
  },

  urlIn(text) {
    const m = /https?:\/\/[^\s<>"'`]+/i.exec(String(text || ''));
    return m ? m[0].replace(/[),.;!?]+$/, '') : null;
  },
  pref(k, def) { try { return localStorage.getItem('lc.url.' + k) ?? def; } catch { return def; } },
  setPref(k, v) { try { localStorage.setItem('lc.url.' + k, v); } catch { } },

  // ---------------------------------------------------------------- окно «Импорт по ссылке»
  dialog(url = '', mode) {
    if (!store.p) return;
    let info = null, busy = 0, lastUrl = null;
    mode = mode || this.pref('mode', 'video');
    let quality = +this.pref('q', 1080);
    const body = h(`<div class="url-imp">
      <input class="text-input url-in" placeholder="Ссылка на YouTube, TikTok, VK, Rutube…" spellcheck="false">
      <div class="url-info"></div>
      <div class="prop-row"><label>Скачать</label><div class="seg wide url-mode">
        <button data-m="video">${icon('film')}Видео</button><button data-m="audio">${icon('music')}Только звук</button></div></div>
      <div class="prop-row url-q"><label>Качество</label><div class="seg wide">
        <button data-q="720">720p</button><button data-q="1080">1080p</button><button data-q="0">Максимум</button></div></div>
    </div>`);
    const inp = $('.url-in', body), box = $('.url-info', body);
    let root = null;
    const okBtn = () => root && $('.modal-foot .primary-btn', root);
    const syncSeg = () => {
      $$('.url-mode button', body).forEach(b => b.classList.toggle('on', b.dataset.m === mode));
      $$('.url-q button', body).forEach(b => b.classList.toggle('on', +b.dataset.q === quality));
      $('.url-q', body).classList.toggle('hidden', mode === 'audio');
    };
    const show = (state, text) => {
      if (state === 'empty') box.innerHTML = `<div class="url-hint">${icon('link')}<span>Вставьте ссылку на видео — можно прямо из буфера (Ctrl+V).</span></div>`;
      else if (state === 'load') box.innerHTML = `<div class="url-hint"><i class="spin"></i><span>Читаем ссылку…</span></div>`;
      else if (state === 'err') { box.innerHTML = `<div class="url-hint err">${icon('alert')}<span></span></div>`; $('span', box).textContent = text; }
      else {
        const i = info;
        box.innerHTML = `<div class="url-card">
          <div class="uc-thumb">${i.thumb ? `<img src="${i.thumb}">` : icon('film')}${i.duration ? `<span class="mc-dur">${fmtDur(i.duration)}</span>` : ''}</div>
          <div class="uc-meta"><b></b><span class="muted small"></span></div></div>`;
        $('.uc-meta b', box).textContent = i.title;
        $('.uc-meta span', box).textContent = [i.site, i.uploader].filter(Boolean).join(' · ');
      }
      const ok = okBtn(); if (ok) ok.disabled = state !== 'ok';
    };
    const check = async () => {
      const u = this.urlIn(inp.value);
      if (u === lastUrl) return;
      lastUrl = u; info = null;
      if (!u) { show(inp.value.trim() ? 'err' : 'empty', 'Это не похоже на ссылку'); return; }
      const my = ++busy;
      show('load');
      try {
        const r = await window.api.urlInfo(u);
        if (my !== busy) return;
        if (r.entries) { show('err', 'Это ссылка на плейлист — вставьте ссылку на одно видео'); return; }
        if (r.live) { show('err', 'Это прямая трансляция — её нельзя скачать целиком'); return; }
        info = { ...r, url: u };
        show('ok');
      } catch (e) {
        if (my !== busy) return;
        show('err', String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'Не удалось прочитать ссылку');
      }
    };
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('input', debounce(check, 450));
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.m) { mode = b.dataset.m; this.setPref('mode', mode); }
      if (b.dataset.q != null) { quality = +b.dataset.q; this.setPref('q', quality); }
      syncSeg();
    });
    const dlg = modal({ title: 'Импорт по ссылке', body, width: 480, buttons: [
      { label: 'Отмена' },
      { label: 'Скачать', primary: true, onClick: () => {
        if (!info) return false;
        this.start({ url: info.url, mode, quality, title: info.title, thumb: info.thumb, duration: info.duration });
      } },
    ] });
    root = dlg.root;
    syncSeg();
    show('empty');
    inp.value = url;
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
    window.api.urlStatus().then((v) => { if (!v) { busy++; show('err', 'Не найден yt-dlp — установите пакет yt-dlp (sudo pacman -S yt-dlp)'); inp.disabled = true; } else if (url) check(); });
  },

  // ---------------------------------------------------------------- загрузка
  async start(o) {
    const name = uid(), proj = store.p;
    const d = { name, ...o, p: 0, stage: 'download', proj };
    this.downloads.push(d);
    Panels.show(o.mode === 'audio' && Panels.tab === 'audio' ? 'audio' : 'media');
    bus.emit('media');
    try {
      const file = await window.api.urlDownload({ name, url: o.url, mode: o.mode, quality: o.quality, id: proj.id });
      if (store.p !== proj) return;
      const [m] = await Media.importPaths([file]);
      if (m) {
        // имя — по заголовку, без «[id]» из имени файла
        const ext = file.split('.').pop();
        m.name = `${o.title}.${ext}`;
        store.commit('media-name');
        toast(`Загружено: ${o.title}`, 'ok', 2600);
      }
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (msg !== 'Отменено') {
        const pre = h(`<div><p>Не удалось скачать «${esc(o.title)}».</p><pre class="log"></pre></div>`);
        $('pre', pre).textContent = msg;
        modal({ title: 'Ошибка загрузки', body: pre, width: 560, buttons: [{ label: 'Закрыть', primary: true }] });
      }
    } finally {
      this.downloads = this.downloads.filter(x => x !== d);
      bus.emit('media');
    }
  },
  cancel(name) { window.api.urlCancel(name); },
  list(mode) { return this.downloads.filter(d => d.proj === store.p && (!mode || d.mode === mode)); },

  // карточка загрузки в медиатеке (обновляется на месте, без перерисовки панели)
  card(d) {
    const el = h(`<div class="media-card dl-card" data-dl="${d.name}" title="${esc(d.title)}">
      <div class="mc-thumb">${d.thumb ? `<img src="${d.thumb}" draggable="false">` : `<div class="mc-audio">${icon(d.mode === 'audio' ? 'music' : 'film')}</div>`}
        <div class="dl-shade"><b class="dl-pct"></b></div>
        <div class="dl-bar"><i></i></div>
        <button class="mc-add dl-x" title="Отменить загрузку">${icon('x')}</button>
      </div>
      <div class="mc-name"></div>
    </div>`);
    $('.mc-name', el).textContent = d.title;
    $('.dl-x', el).onclick = (e) => { e.stopPropagation(); this.cancel(d.name); };
    this.paint(d, el);
    return el;
  },
  paint(d, el) {
    for (const x of el ? [el] : $$(`[data-dl="${d.name}"]`)) {
      $('.dl-bar i', x).style.width = Math.round(d.p * 100) + '%';
      $('.dl-pct', x).textContent = d.stage === 'merge' ? 'Склейка…' : Math.round(d.p * 100) + '%';
    }
  },
};
