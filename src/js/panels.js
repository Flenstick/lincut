// Левая панель: медиа, аудио, текст, стикеры, фильтры, переходы
const TEXT_PRESETS = [
  { name: 'Текст', text: 'Введите текст', style: { bold: false, shadow: false, size: 90 } },
  { name: 'Заголовок', text: 'ЗАГОЛОВОК', style: { size: 150, bold: true, letterSpacing: 4, shadow: true } },
  { name: 'Субтитры', text: 'Субтитры к видео', y: 0.36, style: { size: 64, bold: true, strokeWidth: 5, strokeColor: '#000000', shadow: false } },
  { name: 'Жёлтый', text: 'ВАУ!', style: { size: 140, color: '#ffd60a', strokeWidth: 10, strokeColor: '#000000', bold: true, shadow: false } },
  { name: 'Плашка', text: 'Текст на плашке', style: { size: 72, color: '#111111', bgColor: '#ffffff', bgOpacity: 100, bold: true, shadow: false } },
  { name: 'Подпись', text: 'Подпись', y: 0.34, style: { size: 60, color: '#ffffff', bgColor: '#000000', bgOpacity: 65, bold: false, shadow: false } },
  { name: 'Неон', text: 'НЕОН', style: { size: 140, color: '#5ff2ff', strokeWidth: 3, strokeColor: '#ff2bd6', bold: true, shadow: true } },
  { name: 'Красный', text: 'ВНИМАНИЕ', style: { size: 110, color: '#ffffff', bgColor: '#ff2d55', bgOpacity: 100, bold: true, shadow: false, italic: true } },
  { name: 'Мягкий', text: 'нежный текст', style: { size: 96, color: '#ffd1e8', italic: true, bold: false, shadow: true } },
  { name: 'Контур', text: 'КОНТУР', style: { size: 140, color: '#00000000', strokeWidth: 4, strokeColor: '#ffffff', bold: true, shadow: false } },
];
const STICKERS = ['😀', '😂', '🤣', '😍', '🥰', '😎', '🤩', '🥳', '😭', '😱', '🤯', '😡', '🤔', '🙄', '😴', '🤡', '👻', '💀', '👽', '🤖', '👍', '👎', '👏', '🙏', '💪', '👀', '🫶', '✌️', '🤙', '👋', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '🔥', '✨', '⭐', '🌟', '⚡', '💥', '💫', '🎉', '🎊', '🎁', '🏆', '🎮', '🎬', '🎵', '🎶', '📸', '💡', '💰', '🚀', '🌈', '☀️', '🌙', '❄️', '🌸', '🍕', '🍔', '🍿', '☕', '🐱', '🐶', '🦊', '🐸', '🐧', '✅', '❌', '⚠️', '❓', '❗', '➡️', '⬅️', '⬆️', '⬇️', '🔴', '🟢', '🔵'];

const Panels = {
  tab: 'media',
  sub: {},
  init() {
    $('#lpTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) this.show(b.dataset.tab); };
    bus.on('media', () => { if (['media', 'audio'].includes(this.tab)) this.render(); });
    bus.on('project', debounce(() => { if (['media', 'audio', 'transitions', 'filters'].includes(this.tab) && !document.body.classList.contains('dragging')) this.render(); }, 60));
    bus.on('selection', () => { if (['filters', 'transitions', 'effects'].includes(this.tab)) this.render(); });
  },
  show(tab) {
    const changed = this.tab !== tab;
    this.tab = tab;
    $$('#lpTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const dir = tabInk.update($('#lpTabs'), 'lp');
    this.render();
    if (changed) animIn($('#lpContent'), dir);
  },
  render() {
    if (!store.p) return;
    const nav = $('#lpNav'), content = $('#lpContent');
    const navs = {
      media: [['local', 'Импорт'], ['library', 'Цвета']],
      audio: [['music', 'Музыка'], ['voice', 'Озвучка']],
      text: [['add', 'Добавить текст']],
      stickers: [['emoji', 'Эмодзи']],
      filters: [['all', 'Все фильтры']],
      transitions: [['base', 'Базовые'], ['move', 'Движение'], ['edit', 'Эдит']],
      effects: FX_CATS.map(c => [c.id, c.name]),
    }[this.tab] || Plugins.panelNavs(this.tab);
    if (!navs) { this.tab = 'media'; return this.render(); }
    let sub = this.sub[this.tab] || navs[0][0];
    nav.innerHTML = navs.map(([id, l]) => `<button class="${id === sub ? 'active' : ''}" data-s="${id}">${l}</button>`).join('');
    nav.onclick = (e) => { const b = e.target.closest('button'); if (!b || b.classList.contains('active')) return; this.sub[this.tab] = b.dataset.s; this.render(); animIn(content); };
    const st = content.scrollTop;
    const same = content.dataset.view === this.tab + sub;
    content.innerHTML = '';
    content.dataset.view = this.tab + sub;
    // разделы эффектов из плагинов и панели плагинов
    const fn = this[this.tab + '_' + sub] || (this.tab === 'effects' ? (r) => this.effectsCat(r, sub) : Plugins.panelFn(this.tab, sub));
    if (fn) fn.call(this, content);
    hydrateIcons(content);
    if (same) content.scrollTop = st;
  },

  // ---------------------------------------------------------------- медиа
  media_local(root) {
    const list = store.p.media.filter(m => !m.voice && !m.frame);
    const head = h(`<div class="lp-head">
      <button class="import-btn" id="importBtn">${icon('plus')}<span>Импорт</span></button>
      <button class="import-btn url-btn" data-tip="Импорт по ссылке: YouTube, TikTok, VK…">${icon('link')}<span>По ссылке</span></button>
      <span class="muted small">${list.length ? list.length + ' файл(ов)' : ''}</span>
    </div>`);
    $('#importBtn', head).onclick = () => App.importDialog();
    $('.url-btn', head).onclick = () => Links.dialog('', 'video');
    root.appendChild(head);
    const dls = Links.list();
    if (!list.length && !dls.length) {
      const e = h(`<div class="import-zone">
        <div class="iz-ic">${icon('upload')}</div>
        <b>Импортируйте видео, фото или аудио</b>
        <span>Перетащите файлы сюда, нажмите «Импорт» или вставьте из буфера (Ctrl+V)</span>
      </div>`);
      e.onclick = () => App.importDialog();
      root.appendChild(e);
      return;
    }
    const used = Media.usedIds();
    const grid = h('<div class="media-grid"></div>');
    for (const d of dls) grid.appendChild(Links.card(d));
    for (const m of list) grid.appendChild(this.mediaCard(m, used.has(m.id)));
    root.appendChild(grid);
  },
  mediaCard(m, used) {
    const a = assets[m.id] || {};
    const thumb = m.type === 'audio'
      ? `<div class="mc-audio">${icon('music')}</div>`
      : a.poster ? `<img src="${a.poster}" draggable="false">` : `<div class="mc-loading"><i class="spin"></i></div>`;
    const card = h(`<div class="media-card ${a.missing ? 'missing' : ''}" draggable="true" title="${esc(m.name)}">
      <div class="mc-thumb">${thumb}
        ${m.type !== 'image' ? `<span class="mc-dur">${fmtDur(m.duration)}</span>` : ''}
        ${used ? `<span class="mc-used">Добавлено</span>` : ''}
        ${a.missing ? `<span class="mc-missing">${icon('alert')} Нет файла</span>` : ''}
        ${a.proxying ? `<span class="mc-proxy"><i class="spin"></i> Прокси</span>` : ''}
        <button class="mc-add" title="Добавить на таймлайн">${icon('plus')}</button>
      </div>
      <div class="mc-name">${esc(m.name)}</div>
    </div>`);
    if (m.type === 'video') this.hoverScrub($('.mc-thumb', card), m);
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-lincut-media', m.id);
      e.dataTransfer.effectAllowed = 'copy';
      if (a.poster) { const im = $('img', card); if (im) e.dataTransfer.setDragImage(im, 40, 30); }
    });
    $('.mc-add', card).onclick = (e) => { e.stopPropagation(); if (a.missing) return; Media.addToTimeline(m); Timeline.autoFit(); };
    card.ondblclick = () => { if (!a.missing) { Media.addToTimeline(m); Timeline.autoFit(); } };
    card.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Добавить на таймлайн', icon: 'plus', disabled: a.missing, onClick: () => Media.addToTimeline(m) },
        ...(() => { const s = store.selected(); return s && Timeline.canReplace(s.clip) && s.clip.mediaId !== m.id ? [{ label: 'Заменить выделенный клип', icon: 'replace', disabled: a.missing, onClick: () => Timeline.replaceClip(s.clip, m) }] : []; })(),
        { label: 'Показать в папке', icon: 'folder', onClick: () => window.api.showItem(m.path) },
        '-',
        { label: 'Удалить из проекта', icon: 'trash', danger: true, onClick: () => this.removeMedia(m) },
      ]);
    };
    return card;
  },
  // как в CapCut: ведёте мышью по миниатюре видео — она листает кадры из спрайта
  hoverScrub(th, m) {
    let cv = null;
    const stop = () => { if (cv) { cv.remove(); cv = null; } th.classList.remove('scrubbing'); };
    th.addEventListener('mousemove', (e) => {
      const a = assets[m.id];
      if (!a || !a.sprite || !a.meta || document.body.classList.contains('dragging')) return;
      const r = th.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1);
      const dpr = devicePixelRatio || 1, W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (!cv) { cv = document.createElement('canvas'); cv.className = 'mc-scrub'; th.insertBefore(cv, th.firstElementChild.nextSibling); th.classList.add('scrubbing'); }
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const meta = a.meta, idx = Math.min(meta.count - 1, Math.floor(f * meta.count));
      const k = Math.max(W / meta.tw, H / meta.th), dw = meta.tw * k, dh = meta.th * k;
      cv.getContext('2d').drawImage(a.sprite, (idx % meta.cols) * meta.tw, Math.floor(idx / meta.cols) * meta.th, meta.tw, meta.th, (W - dw) / 2, (H - dh) / 2, dw, dh);
      th.style.setProperty('--f', (f * 100).toFixed(2) + '%');
    });
    th.addEventListener('mouseleave', stop);
    th.addEventListener('mousedown', stop);
  },

  async removeMedia(m) {
    const used = store.allClips().filter(x => x.clip.mediaId === m.id);
    if (used.length && !(await confirmDlg('Удалить медиа?', `Файл используется в ${used.length} клип(ах) на таймлайне. Они тоже будут удалены.`))) return;
    for (const x of used) store.removeClip(x.clip.id);
    store.p.media = store.p.media.filter(x => x !== m);
    store.commit('remove-media');
    bus.emit('media');
  },

  // Цветные фоны-заглушки (как «Библиотека» в CapCut)
  media_library(root) {
    const colors = ['#000000', '#ffffff', '#1c1c1e', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f'];
    root.appendChild(h(`<div class="lp-sub">Цветной фон — добавляется как клип на главную дорожку</div>`));
    const grid = h(`<div class="color-grid">${colors.map(c => `<button style="background:${c}" data-c="${c}"></button>`).join('')}</div>`);
    grid.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const png = colorPng(b.dataset.c, store.p.width, store.p.height);
      const file = await window.api.writeProjectFile(store.p.id, `color_${b.dataset.c.slice(1)}_${store.p.width}x${store.p.height}.png`, png);
      const [m] = await Media.importPaths([file]);
      if (m) { m.frame = true; Media.addToTimeline(m); }
    };
    root.appendChild(grid);
  },

  // ---------------------------------------------------------------- аудио
  audio_music(root) {
    const list = store.p.media.filter(m => m.type === 'audio' && !m.voice);
    const vids = store.p.media.filter(m => m.type === 'video' && m.hasAudio);
    const head = h(`<div class="lp-head"><button class="import-btn">${icon('plus')}<span>Импорт аудио</span></button>
      <button class="import-btn url-btn" data-tip="Звук по ссылке: YouTube, TikTok, VK…">${icon('link')}<span>По ссылке</span></button></div>`);
    $('button', head).onclick = () => App.importDialog();
    $('.url-btn', head).onclick = () => Links.dialog('', 'audio');
    root.appendChild(head);
    const dls = Links.list('audio');
    if (dls.length) { const g = h('<div class="media-grid"></div>'); dls.forEach(d => g.appendChild(Links.card(d))); root.appendChild(g); }
    if (!list.length && !vids.length) {
      root.appendChild(h(`<div class="import-zone small-zone"><div class="iz-ic">${icon('music')}</div><b>Добавьте музыку</b><span>MP3, WAV, FLAC, OGG, M4A…</span></div>`));
      $('.import-zone', root).onclick = () => App.importDialog();
    }
    if (list.length) {
      root.appendChild(h(`<div class="lp-sub">Аудиофайлы</div>`));
      for (const m of list) root.appendChild(this.audioRow(m));
    }
    if (vids.length) {
      root.appendChild(h(`<div class="lp-sub">Извлечь звук из видео</div>`));
      for (const m of vids) root.appendChild(this.audioRow(m, true));
    }
  },
  audio_voice(root) {
    const card = h(`<div class="voice-card">
      <div class="vc-ic">${icon('mic')}</div>
      <div><b>Запись озвучки</b><span>Запишите голос прямо поверх видео с позиции курсора</span></div>
      <button class="primary-btn">${icon('record')}Записать</button>
    </div>`);
    $('button', card).onclick = () => Voiceover.open();
    root.appendChild(card);
    const list = store.p.media.filter(m => m.voice);
    if (list.length) {
      root.appendChild(h(`<div class="lp-sub">Записи</div>`));
      for (const m of list) root.appendChild(this.audioRow(m));
    }
  },
  audioRow(m, fromVideo) {
    const a = assets[m.id] || {};
    const row = h(`<div class="audio-row" draggable="true">
      <button class="ar-play" title="Прослушать">${icon('play')}</button>
      <div class="ar-info"><b>${esc(m.voice ? 'Озвучка · ' + new Date(m.added).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : m.name)}</b><span>${fmtDur(m.duration)}${fromVideo ? ' · видео' : ''}</span></div>
      <canvas class="ar-wave" width="120" height="28"></canvas>
      <button class="ar-add" title="Добавить на таймлайн">${icon('plus')}</button>
    </div>`);
    if (a.wave) {
      const cv = $('canvas', row), ctx = cv.getContext('2d');
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      const n = 60;
      for (let i = 0; i < n; i++) {
        const i0 = Math.floor(i / n * a.wave.length), i1 = Math.floor((i + 1) / n * a.wave.length);
        let pk = 0; for (let j = i0; j < i1; j++) pk = Math.max(pk, a.wave[j]);
        const hh = Math.max(1, pk / 255 * 26);
        ctx.fillRect(i * 2, 14 - hh / 2, 1.2, hh);
      }
    }
    row.addEventListener('dragstart', (e) => {
      if (fromVideo) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-lincut-media', m.id);
    });
    const add = () => {
      if (fromVideo) {
        const c = normalizeClip({ id: uid(), kind: 'audio', mediaId: m.id, start: store.time, in: 0, out: m.duration, speed: 1 });
        store.place(c, 'audio');
        store.select(c.id);
        store.commit('add-audio');
      } else Media.addToTimeline(m);
      Timeline.autoFit();
    };
    $('.ar-add', row).onclick = add;
    row.ondblclick = add;
    $('.ar-play', row).onclick = () => this.preview(m, $('.ar-play', row));
    return row;
  },
  preview(m, btn) {
    if (this.pv && this.pv.m === m) { this.pv.el.pause(); this.pv.btn.innerHTML = icon('play'); this.pv = null; return; }
    if (this.pv) { this.pv.el.pause(); this.pv.btn.innerHTML = icon('play'); }
    const el = new Audio(assets[m.id] ? assets[m.id].src : fileUrl(m.path));
    el.play();
    btn.innerHTML = icon('pause');
    el.onended = () => { btn.innerHTML = icon('play'); this.pv = null; };
    this.pv = { m, el, btn };
  },

  // ---------------------------------------------------------------- текст
  text_add(root) {
    root.appendChild(h(`<div class="lp-sub">Нажмите, чтобы добавить на позицию курсора</div>`));
    const grid = h('<div class="text-grid"></div>');
    TEXT_PRESETS.forEach((p, i) => {
      const s = Object.assign({}, DEFAULT_TEXT_STYLE, p.style);
      const css = `font-family:'${s.font}';font-weight:${s.bold ? 700 : 400};font-style:${s.italic ? 'italic' : 'normal'};color:${s.color};` +
        (s.strokeWidth ? `-webkit-text-stroke:${Math.max(1, s.strokeWidth / 5)}px ${s.strokeColor};paint-order:stroke fill;` : '') +
        (s.bgOpacity ? `background:${hexA(s.bgColor, s.bgOpacity / 100)};padding:2px 8px;border-radius:4px;` : '') +
        (s.shadow ? 'text-shadow:0 2px 6px rgba(0,0,0,.6);' : '');
      const tile = h(`<button class="text-tile" title="${esc(p.name)}"><span style="${css}">${i === 0 ? 'Текст' : esc(p.name)}</span><i class="tt-add">${icon('plus')}</i></button>`);
      tile.onclick = () => this.addText(p);
      tile.draggable = false;
      grid.appendChild(tile);
    });
    root.appendChild(grid);
  },
  addText(p) {
    const start = store.time;
    const c = makeTextClip(start, p.text, p.style);
    if (p.y) c.transform.y = Math.round(store.p.height * p.y);
    const dmax = store.duration();
    if (dmax > 0 && start < dmax) c.out = Math.min(3, Math.max(1, dmax - start));
    store.place(c, 'text');
    store.select(c.id);
    store.commit('add-text');
    Player.requestRender();
    setTimeout(() => { const ta = $('#inspector textarea'); if (ta) { ta.focus(); ta.select(); } }, 50);
  },

  stickers_emoji(root) {
    const grid = h(`<div class="sticker-grid">${STICKERS.map(s => `<button>${s}</button>`).join('')}</div>`);
    grid.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const c = makeTextClip(store.time, b.textContent, { size: 220, shadow: false, bold: false, font: EMOJI_FONT });
      store.place(c, 'text');
      store.select(c.id);
      store.commit('sticker');
      Player.requestRender();
    };
    root.appendChild(grid);
  },

  // ---------------------------------------------------------------- фильтры
  filters_all(root) {
    const s = store.selected();
    const c = s && (s.clip.kind === 'video' || s.clip.kind === 'image') ? s.clip : null;
    const target = c || (store.mainTrack().clips.find(x => x.kind !== 'text'));
    const poster = target && assets[target.mediaId] ? assets[target.mediaId].poster : null;
    if (!c) root.appendChild(h(`<div class="lp-hint">${icon('info')}<span>Выберите видео или фото на таймлайне, чтобы применить фильтр</span></div>`));
    const grid = h('<div class="filter-grid"></div>');
    for (const f of FILTER_PRESETS) {
      const M = f.id ? adjustMatrix(f.a) : null;
      const fl = M ? `filter:url(#${svgFilterId(M)})` : '';
      const on = c && (c.filter.name || null) === f.id;
      const t = h(`<button class="filter-tile ${on ? 'on' : ''}" ${!c ? 'disabled' : ''}>
        <div class="ft-img">${poster ? `<img src="${poster}" style="${fl}">` : `<div class="ft-grad" style="${fl}"></div>`}</div>
        <span>${f.name}</span></button>`);
      t.onclick = () => {
        if (!c) return;
        c.filter.name = f.id; c.filter.intensity = c.filter.intensity || 100;
        store.commit('filter');
        Player.requestRender();
        this.render();
      };
      grid.appendChild(t);
    }
    root.appendChild(grid);
    if (c && c.filter.name) {
      root.appendChild(sliderRow({ label: 'Сила', min: 0, max: 100, value: c.filter.intensity, def: 100, fmt: v => Math.round(v),
        onInput: v => { c.filter.intensity = v; Player.requestRender(); }, onCommit: () => store.commit('filter') }));
      const all = h(`<button class="secondary-btn wide">Применить ко всем клипам</button>`);
      all.onclick = () => {
        for (const x of store.allClips()) if (x.clip.filter) Object.assign(x.clip.filter, c.filter);
        store.commit('filter-all'); Player.requestRender(); toast('Фильтр применён ко всем клипам', 'ok');
      };
      root.appendChild(all);
    }
  },

  // ---------------------------------------------------------------- переходы
  transitionTarget() {
    const main = store.mainTrack();
    const s = store.selected();
    if (s && s.track.main) {
      const i = main.clips.indexOf(s.clip);
      if (i > 0) return s.clip;
    }
    // ближайший стык к курсору
    let best = null, bd = Infinity;
    main.clips.forEach((c, i) => { if (i > 0) { const d = Math.abs(c.start - store.time); if (d < bd) { bd = d; best = c; } } });
    return best;
  },
  transitions_base(root) { this.transitionsGroup(root, 'base'); },
  transitions_move(root) { this.transitionsGroup(root, 'move'); },
  transitions_edit(root) { this.transitionsGroup(root, 'edit'); },
  transitionsGroup(root, group) {
    const c = this.transitionTarget();
    if (!c) {
      root.appendChild(h(`<div class="lp-hint">${icon('info')}<span>Добавьте на главную дорожку минимум два клипа — переход ставится на стык между ними</span></div>`));
    } else {
      const i = store.mainTrack().clips.indexOf(c);
      const cur = c.trans && TRANSITIONS.find(t => t.id === c.trans.type);
      root.appendChild(h(`<div class="lp-hint ok">${icon('transition')}<span>Стык ${i} → ${i + 1}${cur ? ' · ' + esc(cur.name) : ''}</span></div>`));
    }
    const grid = h('<div class="fx-grid"></div>');
    const draws = [];
    const list = TRANSITIONS.filter(t => t.group === group);
    if (group === 'base') list.unshift({ id: null, name: 'Нет' });
    for (const tr of list) {
      const on = c && ((c.trans && c.trans.type) || null) === tr.id;
      const t = h(`<button class="fx-tile ${on ? 'on' : ''}" ${!c ? 'disabled' : ''}><canvas></canvas><span>${esc(tr.name)}</span></button>`);
      const cv = $('canvas', t);
      draws.push(() => FxPreview.transition(cv, tr.id));
      t.onmouseenter = () => FxPreview.animate(cv, (T) => FxPreview.transition(cv, tr.id, T), 1.8);
      t.onmouseleave = () => { FxPreview.stop(); FxPreview.transition(cv, tr.id); };
      t.onclick = () => {
        if (!c) return;
        c.trans = tr.id ? { type: tr.id, dur: (c.trans && c.trans.dur) || (OVERLAP_TRANS.has(tr.id) ? 0.6 : 0.5) } : null;
        store.packMain();
        store.select(c.id);
        store.commit('transition');
        if (tr.id) {
          const main = store.mainTrack();
          const prev = main.clips[main.clips.indexOf(c) - 1];
          const td = transDur(prev, c);
          const S = OVERLAP_TRANS.has(tr.id) ? c.start : c.start - td / 2;
          store.setTime(Math.max(0, S - 0.4));
          Player.stopAt = S + td + 0.4;
          Player.play();
        }
        this.render();
      };
      grid.appendChild(t);
    }
    root.appendChild(grid);
    draws.forEach(f => f()); // рисуем после вставки в документ: иначе SVG-фильтры не находятся
    if (c && c.trans) {
      root.appendChild(sliderRow({ label: 'Длительность', min: 0.1, max: 3, step: 0.1, value: c.trans.dur, def: 0.6, unit: 'с',
        onInput: v => { c.trans.dur = v; store.packMain(); Timeline.render(); Player.requestRender(); }, onCommit: () => store.commit('trans-dur') }));
      const all = h(`<button class="secondary-btn wide">Применить ко всем стыкам</button>`);
      all.onclick = () => {
        store.mainTrack().clips.forEach((x, i) => { if (i > 0) x.trans = deep(c.trans); });
        store.packMain(); store.commit('trans-all'); toast('Переход применён ко всем стыкам', 'ok');
      };
      root.appendChild(all);
    }
  },

  // ---------------------------------------------------------------- эффекты
  effects_trend(root) { this.effectsCat(root, 'trend'); },
  effects_camera(root) { this.effectsCat(root, 'camera'); },
  effects_light(root) { this.effectsCat(root, 'light'); },
  effects_glitch(root) { this.effectsCat(root, 'glitch'); },
  effects_retro(root) { this.effectsCat(root, 'retro'); },
  effects_color(root) { this.effectsCat(root, 'color'); },
  effects_split(root) { this.effectsCat(root, 'split'); },
  effects_distort(root) { this.effectsCat(root, 'distort'); },
  effectsCat(root, cat) {
    const s = store.selected();
    const selFx = s && s.clip.kind === 'effect' ? s.clip : null;
    root.appendChild(h(`<div class="lp-sub">${selFx ? 'Нажмите, чтобы заменить выбранный эффект' : 'Нажмите — на позицию курсора · перетащите на клип — только на него'}</div>`));
    const grid = h('<div class="fx-grid"></div>');
    const src = FxPreview.source();
    const draws = [];
    const list = EFFECTS.filter(e => e.cat === cat);
    if (cat === 'trend') list.push(...TREND_MORE.map(id => EFFECT_BY_ID[id]));
    for (const fx of list) {
      const on = selFx && selFx.effect === fx.id;
      const t = h(`<button class="fx-tile ${on ? 'on' : ''}"><canvas></canvas><span>${esc(fx.name)}</span><i class="tt-add">${icon('plus')}</i></button>`);
      const cv = $('canvas', t);
      cv._redraw = () => FxPreview.effect(cv, fx, src, fx.tileT ?? 0.35);
      draws.push(cv._redraw);
      t.onmouseenter = () => { cv._redraw = null; FxPreview.animate(cv, (T) => FxPreview.effect(cv, fx, src, T), 3); };
      t.onmouseleave = () => { FxPreview.stop(); cv._redraw = () => FxPreview.effect(cv, fx, src, fx.tileT ?? 0.35); cv._redraw(); };
      t.onclick = () => this.addEffect(fx.id, selFx);
      // перетаскивание на клип таймлайна — эффект клипа (как в Premiere Pro)
      t.draggable = true;
      t.ondragstart = (e) => {
        FxPreview.stop();
        e.dataTransfer.setData('application/x-lincut-fx', fx.id);
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setDragImage(cv, 40, 24);
      };
      t.oncontextmenu = (e) => {
        e.preventDefault();
        const sc = store.selected(), c = sc && (sc.clip.kind === 'video' || sc.clip.kind === 'image') ? sc.clip : null;
        showMenu(e.clientX, e.clientY, [
          { label: c ? 'Применить к выбранному клипу' : 'Применить к клипу (выберите видео или фото)', icon: 'sparkles', disabled: !c, onClick: () => { addClipFx(c, fx.id); store.commit('fx-clip'); Inspector.showFx(c); Player.requestRender(); } },
          { label: 'Добавить на дорожку эффектов', icon: 'plus', onClick: () => this.addEffect(fx.id, null) },
        ]);
      };
      grid.appendChild(t);
    }
    root.appendChild(grid);
    draws.forEach(f => f());
  },
  addEffect(id, replace, at) {
    if (replace) {
      replace.effect = id;
      store.commit('fx-replace');
      Player.requestRender();
      this.render();
      return;
    }
    const t = at ?? store.time, total = store.duration();
    const dur = total > 0 && t < total ? Math.min(3, Math.max(0.5, total - t)) : 3;
    const c = makeEffectClip(t, id, dur);
    store.place(c, 'effect');
    store.select(c.id);
    store.commit('fx-add');
    Player.requestRender();
  },
};

// ---------------------------------------------------------------- превью эффектов и переходов на плитках
const FxPreview = {
  raf: null,
  scene(kind) {
    // процедурные «кадры» для превью, когда на таймлайне ещё пусто
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 180);
    if (kind === 'b') { g.addColorStop(0, '#0c1b3a'); g.addColorStop(1, '#3b5ea8'); }
    else { g.addColorStop(0, '#f7a35c'); g.addColorStop(0.6, '#f36b6b'); g.addColorStop(1, '#6b3b7a'); }
    x.fillStyle = g; x.fillRect(0, 0, 320, 180);
    x.fillStyle = kind === 'b' ? '#f4f1d0' : '#ffe6a8';
    x.beginPath(); x.arc(kind === 'b' ? 240 : 110, 62, 26, 0, Math.PI * 2); x.fill();
    x.fillStyle = kind === 'b' ? '#101828' : '#3a1f45';
    x.beginPath(); x.moveTo(0, 180); x.lineTo(0, 120); x.lineTo(70, 90); x.lineTo(140, 125); x.lineTo(210, 80); x.lineTo(320, 118); x.lineTo(320, 180); x.fill();
    if (kind === 'b') { x.fillStyle = '#ffd86b'; for (let i = 0; i < 9; i++) x.fillRect(30 + i * 32, 140 - (i % 3) * 12, 6, 8); }
    return c;
  },
  source() {
    // кадр из проигрывателя, если там что-то есть
    if (store.p && store.duration() > 0 && Player.canvas) {
      const c = document.createElement('canvas'); c.width = 320; c.height = Math.round(320 * Player.canvas.height / Player.canvas.width);
      c.getContext('2d').drawImage(Player.canvas, 0, 0, c.width, c.height);
      return c;
    }
    return this.sceneA || (this.sceneA = this.scene('a'));
  },
  size(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((cv.clientWidth || 96) * dpr), hh = Math.round(w * 9 / 16);
    if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
    return cv.getContext('2d');
  },
  effect(cv, fx, src, T) {
    const ctx = this.size(cv);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    const k = Math.min(cv.width / src.width, cv.height / src.height);
    ctx.drawImage(src, (cv.width - src.width * k) / 2, (cv.height - src.height * k) / 2, src.width * k, src.height * k);
    ctx.restore();
    const p = { I: 0.8, V: 1, D: 3, AR: cv.width / cv.height };
    // масштаб эффектов относительно «1080p»: на маленькой плитке усиливаем, чтобы было видно
    FXRun.apply(ctx, fx.ops(p), T, 3, cv._st || (cv._st = {}), 4);
  },
  transition(cv, type, T) {
    const ctx = this.size(cv);
    const W = cv.width, H = cv.height;
    const A = this.sceneA || (this.sceneA = this.scene('a')), B = this.sceneB || (this.sceneB = this.scene('b'));
    const mk = (start, out) => normalizeClip({ id: uid(), kind: 'image', start, in: 0, out, speed: 1 });
    const a = mk(0, 1), b = mk(1, 1);
    const track = { main: true, clips: [a, b] };
    if (type) { b.trans = { type, dur: 0.8 }; b.start = 1 - transOverlap(a, b); }
    const J = b.start + transOverlap(a, b) / 2;
    const ov = transOverlap(a, b);
    // статичный кадр — там, где переход хорошо виден
    const t = T == null ? (ov ? b.start + ov * 0.45 : J - (type === 'flash' || type === 'white' ? 0.15 : 0.1)) : 0.2 + T * ((b.start + 1 - 0.2) - 0.2) / 1.8;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    for (const [c, img] of [[a, A], [b, B]]) {
      if (t < c.start || t >= clipEnd(c)) continue;
      const an = animState(c, t, W, H, track);
      ctx.save();
      ctx.globalAlpha = an.alpha;
      ctx.drawImage(img, an.dx, an.dy, W, H);
      ctx.restore();
    }
    ctx.restore();
    for (const j of junctionFx(track)) if (t >= j.S && t < j.E) FXRun.apply(ctx, j.ops, t - j.S, j.E - j.S, cv._st || (cv._st = {}), 3);
  },
  animate(cv, draw, period) {
    this.stop();
    const t0 = performance.now();
    const loop = () => { draw(((performance.now() - t0) / 1000) % period); this.raf = requestAnimationFrame(loop); };
    loop();
  },
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; },
};

function colorPng(color, w, hh) {
  const c = document.createElement('canvas');
  c.width = Math.min(w, 1920); c.height = Math.round(c.width * hh / w);
  const x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
