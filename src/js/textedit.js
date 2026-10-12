// Замена текста на кадре — как «Изменить текст» в Photoshop / CapCut. Нейросеть находит строки текста на картинке
// или кадре видео под курсором (EasyOCR), подбирает тот же шрифт из установленных (сравнение отрисовки строки
// каждым шрифтом с кадром), цвет и размер, стирает старый текст (LaMa дорисовывает фон) и ставит обычные
// текстовые клипы LinCut с новым текстом — их потом можно менять как угодно.
//   картинка — стёртая копия становится новым файлом медиатеки, клип переключается на неё (c.txeSrc — исходный файл);
//   видео    — стирается каждый кадр куска клипа: файл <проект>/textedit/…mp4 без звука, как у стабилизации
//              (store.p.txe вне истории отмены, c.txe — id файла). Область текста отслеживается, и новый текст
//              едет за ней ключевыми кадрами («За объектом» из трекинга).
const TextEdit = {
  job: null,   // { name, clipId, p, text }

  init() {
    window.api.onTxeProgress((m) => {
      const j = this.job;
      if (j && m.name === j.name) { j.p = m.p; if (j.paint) j.paint(); }
    });
  },

  canUse(c) { return !!c && (c.kind === 'image' || c.kind === 'video'); },
  // картинка видео-клипа со стёртым текстом: { path, a } или null
  altVideo(c) {
    if (!c.txe || !store.p || !store.p.txe) return null;
    const e = store.p.txe.find(x => x.id === c.txe);
    if (!e || e.mediaId !== c.mediaId || e.a > c.in + 0.01 || e.b < c.out - 0.01) return null;
    return { path: store.dir + '/textedit/' + e.file, a: e.a };
  },
  replaced(c) { return !!(c.txe || c.txeSrc); },

  async ready() {
    const st = await window.api.txeStatus();
    if (st.ready) return true;
    return AiModels.installDialog('text', 'Нейросеть для замены текста', `Чтобы заменить текст на кадре, нужны нейросети <b>EasyOCR</b> (находит и читает текст,
      русский и английский) и <b>LaMa</b> (стирает старый текст и дорисовывает фон). Загружаются один раз, в систему ничего не устанавливается.`);
  },

  // окно с прогрессом и отменой; set(p, text) — обновить
  progress(title, text) {
    const body = h(`<div class="sep-progress"><div class="sep-line muted">${esc(text)}</div><div class="exp-bar indet"><i></i></div></div>`);
    const bar = $('.exp-bar', body);
    let canceled = false;
    const dlg = modal({ title, body, width: 420, onClose: (v) => { if (v !== 'done') { canceled = true; window.api.txeCancel(); } }, buttons: [{ label: 'Отмена' }] });
    return {
      set: (p, t) => {
        if (t) $('.sep-line', body).textContent = t;
        if (p != null) { bar.classList.remove('indet'); bar.firstChild.style.width = (p * 100).toFixed(1) + '%'; }
      },
      close: () => dlg.close('done'),
      get canceled() { return canceled; },
    };
  },

  // запуск tools/textedit.py с окном прогресса; null — отменено
  async run(job, title, text, fmt) {
    const name = uid();
    const pr = this.progress(title, text);
    this.job = { name, clipId: job.clipId, p: 0, paint: () => pr.set(this.job.p, fmt ? fmt(this.job.p) : null) };
    try {
      return await window.api.txeRun({ ...job, name });
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (msg === 'Отменено' || pr.canceled) return null;
      const pre = h(`<div><p>${esc(title)}: ошибка.</p><pre class="log"></pre></div>`);
      $('pre', pre).textContent = msg;
      modal({ title: 'Замена текста', body: pre, width: 560, buttons: [{ label: 'Закрыть', primary: true }] });
      return null;
    } finally {
      this.job = null;
      pr.close();
    }
  },

  // 1) найти текст на кадре под курсором
  async open(c) {
    if (!this.canUse(c)) return;
    if (!(await this.ready())) return;
    if (Player.playing) Player.pause();
    if (store.time < c.start || store.time >= clipEnd(c)) store.setTime(clamp(store.time, c.start, clipEnd(c) - 0.05));
    const m = store.media(c.mediaId);
    if (!m) return;
    // сначала рамка вокруг нужного текста в превью — ищем только внутри неё («Весь кадр» — всё подряд)
    Player.startBoxPick(c, (box) => this.find(c, box), { what: 'текст', whole: 'Весь кадр' });
  },

  async find(c, region) {
    const m = store.media(c.mediaId);
    if (!m) return;
    const proj = store.p, T = store.time, isV = c.kind === 'video';
    // уже стёртое (повторная замена) или стабилизированное видео — ищем на нём
    const alt = isV ? Stab.altVideo(c) : null;
    const src = alt ? { path: alt.path, off: alt.a } : { path: m.path, off: 0 };
    const ts = isV ? srcAt(c, T - c.start) : 0;
    const job = isV ? { cmd: 'analyze', video: src.path, t: ts - src.off, clipId: c.id } : { cmd: 'analyze', image: m.path, clipId: c.id };
    if (region) job.region = region;
    const r = await this.run(job, 'Поиск текста', region ? 'Читаем выделенный текст и подбираем шрифт…' : 'Ищем текст на кадре и подбираем шрифт…');
    if (!r || store.p !== proj) return;
    if (!r.blocks.length) { toast(region ? 'В рамке не нашлось текста — обведите надпись чуть свободнее' : 'На кадре не нашлось текста', 'info', 3000); return; }
    this.editor(c, { T, ts, src, frame: isV ? r.frame : m.path, r, region });
  },

  // 2) окно: кадр с найденными строками и поля для нового текста
  editor(c, ctx) {
    const { r } = ctx;
    // обвели рамкой — найденное и есть нужное; весь кадр — отмечаете сами (щелчок по надписи на кадре)
    const pre = !!ctx.region || r.blocks.length === 1;
    const fontLabel = (f) => f ? `${f.family}${f.bold ? ' Bold' : ''}${f.italic ? ' Italic' : ''}` : 'Шрифт по умолчанию';
    const body = h(`<div class="txe">
      <div class="txe-pic"><img alt=""><svg viewBox="0 0 ${r.w} ${r.h}" preserveAspectRatio="none"></svg></div>
      <div class="txe-list"></div>
      <p class="muted small">${pre ? '' : 'Щёлкните по надписям, которые нужно заменить. '}Впишите новый текст — старый сотрётся, а новый встанет тем же шрифтом, цветом и размером.
        ${c.kind === 'video' ? 'На видео текст стирается на каждом кадре клипа, а новый едет за местом старого.' : ''} Потом его можно менять как обычный текст.</p>
    </div>`);
    $('img', body).src = fileUrl(ctx.frame);
    const svg = $('svg', body), list = $('.txe-list', body);
    const rows = r.blocks.map((b, i) => {
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', b.quad.map(p => p.join(',')).join(' '));
      svg.appendChild(poly);
      const opts = [b.font, ...b.alts.filter(a => !b.font || a.family !== b.font.family || a.bold !== b.font.bold || a.italic !== b.font.italic)].filter(Boolean);
      const row = h(`<div class="txe-row">
        <label class="check"><input type="checkbox" ${pre ? 'checked' : ''}><span></span></label>
        <b class="txe-n">${i + 1}</b>
        <input class="text-input txe-text" spellcheck="false">
        <select class="select txe-font">${opts.map((f, k) => `<option value="${k}">${esc(fontLabel(f))}</option>`).join('')}</select>
        <input type="color" class="txe-color" value="${esc(b.color)}" data-tip="Цвет текста">
      </div>`);
      $('.txe-text', row).value = b.text;
      const on = $('input[type=checkbox]', row);
      const sync = () => { poly.classList.toggle('off', !on.checked); row.classList.toggle('off', !on.checked); };
      on.onchange = sync;
      poly.onclick = () => { on.checked = true; sync(); $('.txe-text', row).focus(); };
      row.onmouseenter = () => poly.classList.add('hot');
      row.onmouseleave = () => poly.classList.remove('hot');
      list.appendChild(row);
      sync();
      return { b, row, on, opts };
    });
    modal({ title: 'Заменить текст на кадре', body, width: 760, cls: 'txe-modal', buttons: [
      { label: 'Отмена' },
      { label: 'Заменить', primary: true, onClick: () => {
        const pick = rows.filter(x => x.on.checked).map(x => ({
          ...x.b, text: $('.txe-text', x.row).value, color: $('.txe-color', x.row).value, font: x.opts[Number($('.txe-font', x.row).value)] || x.b.font,
        }));
        if (!pick.length) { toast('Отметьте хотя бы одну строку', 'info'); return false; }
        this.apply(c, ctx, pick);
      } },
    ] });
    if (pre) setTimeout(() => { const t = $('.txe-text', rows[0].row); t.focus(); t.select(); }, 60);
  },

  // 3) стереть старый текст и поставить новый
  async apply(c, ctx, blocks) {
    const proj = store.p, m = store.media(c.mediaId);
    if (!m) return;
    const quads = blocks.map(b => b.quad);
    let trk = null;
    if (c.kind === 'image') {
      const out = `${store.dir}/textedit/${uid()}.png`;
      const ok = await this.run({ cmd: 'erase', image: m.path, quads, out, clipId: c.id }, 'Замена текста', 'Стираем старый текст…');
      if (!ok || store.p !== proj) return;
      const [nm] = await Media.importPaths([out]);
      if (!nm) return;
      nm.name = m.name.replace(/(\.[^.]+)?$/, ' (без текста)$1');
      if (!c.txeSrc) c.txeSrc = m.id;
      c.mediaId = nm.id;
      // у картинки с ключевыми кадрами текст должен двигаться вместе с ней — «траектория» неподвижной точки
      if (c.keys && c.keys.length) {
        const pts = [];
        for (let s = c.in; s <= c.out + 1e-6; s += 0.1) pts.push([Math.round(s * 1e4) / 1e4, 0.5, 0.5, 1, 1, 1]);
        trk = { id: uid(), mediaId: nm.id, fps: 10, engine: 'text', pts };
      }
    } else {
      const fps = m.fps || 30, src = ctx.src;
      const a = Math.max(0, Math.floor(c.in * fps) / fps), b = c.out;
      const file = `${uid()}.mp4`;
      const res = await this.run({ cmd: 'video', video: src.path, a: a - src.off, b: b - src.off, t0: ctx.ts - src.off, fps, quads, out: `${store.dir}/textedit/${file}`, clipId: c.id },
        'Замена текста', 'Стираем текст на кадрах видео…', (p) => `Стираем текст на кадрах видео… ${Math.round(p * 100)}%`);
      if (!res || store.p !== proj) return;
      res.pts.forEach(p => { p[0] = Math.round((p[0] + src.off) * 1e5) / 1e5; });
      (proj.txe = proj.txe || []).push({ id: file.replace('.mp4', ''), mediaId: m.id, a, b, file });
      c.txe = file.replace('.mp4', '');
      trk = { id: uid(), mediaId: m.id, fps: res.fps, engine: 'text', pts: res.pts };
      // старый элемент проигрывателя держит исходный файл — пусть возьмёт новый
      Player.dropEl && Player.dropEl(c.id);
    }
    if (trk) proj.trk = [...Track.prune(proj.trk || []), trk];
    const added = this.addTexts(c, ctx, blocks, trk);
    store.commit('text-replace');
    if (added.length) store.selectMany(added.map(x => x.id), added[0].id);
    Player.requestRender();
    Inspector.render();
    toast(added.length > 1 ? `Текст заменён — строк: ${added.length}` : 'Текст заменён', 'ok', 2200);
  },

  // текстовые клипы на месте старых строк: размер и положение — из пикселей кадра в координаты проекта
  addTexts(c, ctx, blocks, trk) {
    const W = store.p.width, H = store.p.height, T = ctx.T, r = ctx.r;
    const base = { ...c, keys: null, transform: { ...tfAt(c, T) } };
    const out = [];
    for (const b of blocks) {
      if (!b.text.trim()) continue;
      const P = Track.project(base, T, b.cx / r.w, b.cy / r.h), k = P.k / r.w;
      const f = b.font || {};
      const tc = makeTextClip(c.start, b.text, {
        font: f.family || DEFAULT_TEXT_STYLE.font, bold: !!f.bold, italic: !!f.italic, color: b.color,
        size: Math.max(4, Math.round(b.size * k * 10) / 10), letterSpacing: Math.round(b.spacing * k * 10) / 10,
        shadow: false, strokeWidth: 0, bgOpacity: 0, align: 'center', lineHeight: 1.2,
      });
      tc.out = clipEnd(c) - c.start;
      tc.name = b.text;
      tc.transform = { ...tc.transform, x: Math.round((P.x - W / 2) * 10) / 10, y: Math.round((P.y - H / 2) * 10) / 10, rotation: base.transform.rotation + b.angle };
      store.place(tc, 'text');
      if (trk) {
        tc.follow = { mode: 'attach', trk: trk.id, target: c.id, smooth: trk.fps > 10 ? 35 : 0, size: true, zoom: 1.5, ref: { T0: T, t0: c.kind === 'video' ? ctx.ts : srcAt(c, T - c.start), tf: tfAt(tc, T) } };
        Track.apply(tc);
      }
      out.push(tc);
    }
    return out;
  },

  // вернуть исходную картинку / видео (новый текст остаётся — его можно удалить)
  restore(c) {
    if (c.txeSrc && store.media(c.txeSrc)) { c.mediaId = c.txeSrc; delete c.txeSrc; }
    if (c.txe) { delete c.txe; Player.dropEl && Player.dropEl(c.id); }
    store.commit('text-restore');
    Player.requestRender();
    Inspector.render();
  },
};
