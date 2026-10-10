// Магазин плагинов: каталог с поиском и сортировкой, страница плагина с оценками и отзывами,
// установка и обновление в один клик, публикация своих плагинов. Вход — ник без пароля
// (LinCut хранит секретный ключ у себя). Сервер — api/lcstore.php на сайте TrollLand, запросы идут
// через главный процесс (main-shop.js).
const Shop = {
  sort: 'popular',
  q: '',
  dlg: null,

  // сравнение версий «1.10.2» > «1.9»
  cmp(a, b) {
    const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
    for (let i = 0; i < 4; i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p > q ? 1 : -1; }
    return 0;
  },
  stars(v, cls = '') {
    const w = Math.max(0, Math.min(5, v)) / 5 * 100;
    return `<span class="sh-stars ${cls}"><span class="sh-st-bg">★★★★★</span><span class="sh-st-fg" style="width:${w.toFixed(1)}%">★★★★★</span></span>`;
  },
  date: (t) => new Date(t * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }),
  size: (b) => b < 1024 ? b + ' Б' : b < 1048576 ? (b / 1024).toFixed(0) + ' КБ' : (b / 1048576).toFixed(1) + ' МБ',
  plural: (n, a, b, c) => { const m = n % 10, mm = n % 100; return m === 1 && mm !== 11 ? a : m >= 2 && m <= 4 && (mm < 12 || mm > 14) ? b : c; },

  async installed() {
    const r = await window.api.plugins.list();
    this.local = new Map(r.plugins.map(p => [p.id, p]));
    return this.local;
  },

  // ---------------------------------------------------------------- окно
  async open(id) {
    if (this.dlg) this.dlg.close();
    this.account = await window.api.shop.account();
    await this.installed();
    const body = h(`<div class="sh-wrap">
      <div class="sh-top">
        <label class="sh-search">${icon('search')}<input class="text-input" placeholder="Поиск плагинов" spellcheck="false"></label>
        <div class="seg sh-sort"><button data-sort="popular">Популярные</button><button data-sort="top">Лучшие</button><button data-sort="new">Новые</button></div>
        <span class="pl-grow"></span>
        <button class="secondary-btn sh-acc" data-a="account"></button>
        <button class="primary-btn" data-a="publish">${icon('upload')}Опубликовать</button>
      </div>
      <div class="sh-main"></div>
      <div class="sh-foot muted small"></div>
    </div>`);
    this.body = body;
    this.main = $('.sh-main', body);
    this.dlg = modal({ title: 'Магазин плагинов', body, width: 880, cls: 'shop-modal', buttons: [], onClose: () => { this.dlg = null; } });
    const inp = $('.sh-search input', body);
    inp.value = this.q;
    let t = null;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { this.q = inp.value.trim(); this.list(); }, 300); };
    inp.onkeydown = (e) => e.stopPropagation();
    $('.sh-sort', body).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; this.sort = b.dataset.sort; this.list(); };
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      if (b.dataset.a === 'account') this.accountMenu(b);
      if (b.dataset.a === 'publish') this.publishDialog();
      if (b.dataset.a === 'reload') Plugins.reload();
    });
    this.renderAccount();
    this.renderFoot();
    if (id) this.detail(id); else this.list();
  },

  renderAccount() {
    const b = $('.sh-acc', this.body);
    b.innerHTML = this.account ? `${icon('userCircle')}${esc(this.account.nick)}` : `${icon('userCircle')}Войти`;
    hydrateIcons(this.body);
  },
  renderFoot() {
    const f = $('.sh-foot', this.body);
    f.innerHTML = Plugins.changed
      ? `${icon('info')}Изменения вступят в силу после перезагрузки плагинов. <button class="link-btn" data-a="reload">Перезагрузить сейчас</button>`
      : `${icon('warnCircle')}Плагины работают с правами LinCut. Ставьте плагины с пометкой «Не проверен» только от авторов, которым доверяете.`;
    hydrateIcons(f);
  },

  // ---------------------------------------------------------------- каталог
  async list(more) {
    $$('.sh-sort button', this.body).forEach(b => b.classList.toggle('on', b.dataset.sort === this.sort));
    if (!more) { this.page = 0; this.items = []; this.main.innerHTML = `<div class="sh-empty muted">Загрузка…</div>`; }
    const seq = this.seq = (this.seq || 0) + 1;
    const d = await window.api.shop.call('list', { params: { sort: this.sort, q: this.q, page: this.page } });
    if (seq !== this.seq || !this.dlg) return;
    if (d.error) {
      this.main.innerHTML = `<div class="sh-empty">${icon('warnCircle', 28)}<b>${esc(d.error)}</b><button class="secondary-btn" data-r>Повторить</button></div>`;
      $('[data-r]', this.main).onclick = () => this.list();
      hydrateIcons(this.main);
      return;
    }
    this.items.push(...d.items);
    if (!this.items.length) {
      this.main.innerHTML = `<div class="sh-empty">${icon('storefront', 28)}<b>${this.q ? 'Ничего не нашлось' : 'Пока здесь пусто'}</b>
        <span>${this.q ? 'Попробуйте другие слова.' : 'Опубликуйте первый плагин — кнопка «Опубликовать» справа сверху.'}</span></div>`;
      hydrateIcons(this.main);
      return;
    }
    const box = h(`<div class="sh-list"></div>`);
    for (const p of this.items) box.appendChild(this.row(p));
    if (d.more) {
      const mb = h(`<button class="ghost-btn sh-more">Показать ещё</button>`);
      mb.onclick = () => { this.page++; this.list(true); };
      box.appendChild(mb);
    }
    const top = this.main.scrollTop;
    this.main.innerHTML = '';
    this.main.appendChild(box);
    this.main.scrollTop = more ? top : 0;
    hydrateIcons(this.main);
  },

  badge(p) {
    return p.verified
      ? `<span class="sh-badge ok">${icon('sealCheck')}Проверен</span>`
      : `<span class="sh-badge warn">Не проверен</span>`;
  },
  row(p) {
    const r = h(`<div class="sh-item">
      <div class="pl-ic">${icon('puzzle')}</div>
      <div class="pl-txt">
        <div class="pl-name"><b>${esc(p.name)}</b><span class="muted">${esc(p.version)}</span><span class="muted">· ${esc(p.author)}</span></div>
        ${p.description ? `<span class="pl-desc sh-clamp">${esc(p.description)}</span>` : ''}
        <div class="sh-meta">${this.stars(p.rating)}<span>${p.votes ? p.rating.toFixed(1).replace('.', ',') + ` (${p.votes})` : 'нет оценок'}</span>
          <span class="sh-dot"></span>${icon('download')}<span>${p.downloads}</span><span class="sh-dot"></span>${this.badge(p)}</div>
      </div>
      <div class="sh-act"></div>
    </div>`);
    this.actButton($('.sh-act', r), p);
    r.onclick = (e) => { if (!e.target.closest('button')) this.detail(p.id); };
    return r;
  },

  // кнопка «Установить / Обновить / Установлен»
  actButton(box, p, big) {
    const have = this.local.get(p.id);
    box.innerHTML = '';
    let b;
    if (!have) b = h(`<button class="primary-btn">${icon('download')}Установить</button>`);
    else if (this.cmp(p.version, have.manifest && have.manifest.version) > 0) b = h(`<button class="primary-btn">${icon('download')}Обновить до ${esc(p.version)}</button>`);
    else b = h(`<button class="secondary-btn" disabled>${icon('check')}Установлен</button>`);
    if (!b.disabled) b.onclick = () => this.install(p, b);
    box.appendChild(b);
    if (big && have) {
      const rm = h(`<button class="secondary-btn">${icon('trash')}Удалить</button>`);
      rm.onclick = () => this.uninstall(p);
      box.appendChild(rm);
    }
    hydrateIcons(box);
  },

  async install(p, btn) {
    if (!p.verified && !(await confirmDlg('Плагин не проверен', `«${p.name}» от ${p.author} ещё не проверял администратор магазина. Плагин работает с теми же правами, что и LinCut: может читать и менять файлы. Установить?`, 'Установить', false))) return;
    btn.disabled = true;
    btn.innerHTML = 'Установка…';
    const res = await window.api.shop.install(p.id, p.sha256);
    if (!res.ok) {
      btn.disabled = false;
      modal({ title: 'Не удалось установить плагин', body: `<p class="muted">${esc(res.error)}</p>`, width: 420, buttons: [{ label: 'OK', primary: true }] });
      this.refreshButtons();
      return;
    }
    Plugins.changed = true;
    await this.installed();
    toast(`${res.updated ? 'Обновлён' : 'Установлен'}: ${p.name}. Перезагрузите плагины, чтобы он заработал`, 'ok', 3500);
    this.refreshButtons();
    this.renderFoot();
  },
  async uninstall(p) {
    if (!(await confirmDlg('Удалить плагин?', `«${p.name}» будет перемещён в корзину.`))) return;
    await window.api.plugins.remove(p.id);
    if (Plugins.byId[p.id] && Plugins.byId[p.id].loaded) Plugins.changed = true;
    await this.installed();
    this.refreshButtons();
    this.renderFoot();
  },
  refreshButtons() {
    if (this.cur) this.actButton($('.sh-dact', this.main), this.cur, true);
    else $$('.sh-item', this.main).forEach((r, i) => this.items[i] && this.actButton($('.sh-act', r), this.items[i]));
  },

  // ---------------------------------------------------------------- страница плагина
  async detail(id) {
    this.main.innerHTML = `<div class="sh-empty muted">Загрузка…</div>`;
    const d = await window.api.shop.call('get', { params: { id } });
    if (!this.dlg) return;
    if (d.error) {
      this.main.innerHTML = `<div class="sh-empty">${icon('warnCircle', 28)}<b>${esc(d.error)}</b><button class="secondary-btn" data-b>К списку</button></div>`;
      $('[data-b]', this.main).onclick = () => { this.cur = null; this.list(); };
      hydrateIcons(this.main);
      return;
    }
    const p = d.plugin;
    this.cur = p;
    const hist = d.hist || {};
    const admin = this.account && this.account.admin;
    const el = h(`<div class="sh-detail">
      <button class="ghost-btn sh-back">${icon('chevronLeft')}Все плагины</button>
      <div class="sh-head">
        <div class="pl-ic big">${icon('puzzle')}</div>
        <div class="sh-htxt">
          <h2>${esc(p.name)}</h2>
          <div class="sh-sub muted">${esc(p.author)} · версия ${esc(p.version)} · ${this.date(p.updated)} · ${this.size(p.size)}${p.lincut ? ` · LinCut ${esc(p.lincut.replace(/^[>=\s^~]+/, ''))}+` : ''}</div>
          <div class="sh-meta">${this.badge(p)}<span class="sh-dot"></span>${icon('download')}<span>${p.downloads} ${this.plural(p.downloads, 'скачивание', 'скачивания', 'скачиваний')}</span></div>
        </div>
        <div class="sh-dact"></div>
        <button class="icon-btn" data-more title="Ещё">${icon('more')}</button>
      </div>
      ${p.description ? `<p class="sh-desc">${esc(p.description)}</p>` : ''}
      <div class="sh-cols">
        <div class="sh-sum">
          <div class="sh-big">${p.votes ? p.rating.toFixed(1).replace('.', ',') : '—'}</div>
          ${this.stars(p.rating, 'lg')}
          <div class="muted small">${p.votes} ${this.plural(p.votes, 'оценка', 'оценки', 'оценок')}</div>
          <div class="sh-hist">${[5, 4, 3, 2, 1].map(s => { const n = hist[s] || 0, w = p.votes ? n / p.votes * 100 : 0; return `<div><span>${s}</span><i><b style="width:${w.toFixed(1)}%"></b></i><span class="muted">${n}</span></div>`; }).join('')}</div>
        </div>
        <div class="sh-my"></div>
      </div>
      <div class="sh-revs"></div>
    </div>`);
    $('.sh-back', el).onclick = () => { this.cur = null; this.list(); };
    $('[data-more]', el).onclick = (e) => {
      const items = [];
      if (p.homepage) items.push({ label: 'Страница плагина', icon: 'link', onClick: () => window.api.plugins.openExternal(p.homepage) });
      items.push({ label: 'Скопировать id', icon: 'copy', onClick: () => { navigator.clipboard.writeText(p.id); toast('Скопировано: ' + p.id, 'ok', 1400); } });
      if (admin) items.push('-', { label: p.verified ? 'Снять отметку «Проверен»' : 'Отметить «Проверен»', icon: 'sealCheck', onClick: async () => {
        const r = await window.api.shop.call('verify', { json: { id: p.id, on: !p.verified } });
        if (r.error) toast(r.error, 'error', 4000); else this.detail(p.id);
      } });
      if (p.mine || admin) items.push('-', { label: 'Убрать из магазина', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmDlg('Убрать плагин из магазина?', `«${p.name}» исчезнет из магазина вместе с оценками и отзывами. У тех, кто его уже установил, он останется.`, 'Убрать'))) return;
        const r = await window.api.shop.call('delete', { json: { id: p.id } });
        if (r.error) toast(r.error, 'error', 4000); else { toast('Плагин убран из магазина', 'ok'); this.cur = null; this.list(); }
      } });
      menuBelow(e.currentTarget, items);
    };
    this.main.innerHTML = '';
    this.main.appendChild(el);
    this.main.scrollTop = 0;
    this.actButton($('.sh-dact', el), p, true);
    this.renderMine($('.sh-my', el), p, d.mine);
    this.renderReviews($('.sh-revs', el), p, d.reviews, admin);
    hydrateIcons(el);
  },

  // своя оценка
  renderMine(box, p, mine) {
    if (!this.account) {
      box.innerHTML = `<b>Оцените плагин</b><p class="muted small">Чтобы ставить оценки и писать отзывы, войдите в магазин — нужен только ник.</p><button class="secondary-btn">${icon('userCircle')}Войти</button>`;
      $('button', box).onclick = () => this.loginDialog(() => this.detail(p.id));
      return;
    }
    if (p.mine) { box.innerHTML = `<b>Это ваш плагин</b><p class="muted small">Новую версию можно выложить кнопкой «Опубликовать» — увеличьте "version" в plugin.json.</p>`; return; }
    let stars = mine ? mine.stars : 0;
    box.innerHTML = `<b>${mine ? 'Ваша оценка' : 'Оцените плагин'}</b>
      <div class="sh-pick">${[1, 2, 3, 4, 5].map(i => `<button data-s="${i}" title="${i}">★</button>`).join('')}</div>
      <textarea class="text-input sh-text" maxlength="600" placeholder="Отзыв — необязательно"></textarea>
      <div class="sh-myact"><button class="primary-btn" data-send>${mine ? 'Сохранить' : 'Отправить'}</button>${mine ? '<button class="ghost-btn" data-del>Убрать оценку</button>' : ''}</div>`;
    const ta = $('.sh-text', box);
    ta.value = mine ? mine.text : '';
    ta.onkeydown = (e) => e.stopPropagation();
    const paint = (n) => $$('.sh-pick button', box).forEach(b => b.classList.toggle('on', +b.dataset.s <= n));
    paint(stars);
    $('.sh-pick', box).onmouseover = (e) => { const b = e.target.closest('button'); if (b) paint(+b.dataset.s); };
    $('.sh-pick', box).onmouseleave = () => paint(stars);
    $('.sh-pick', box).onclick = (e) => { const b = e.target.closest('button'); if (b) { stars = +b.dataset.s; paint(stars); } };
    $('[data-send]', box).onclick = async () => {
      if (!stars) { toast('Выберите от 1 до 5 звёзд', 'info'); return; }
      const r = await window.api.shop.call('rate', { json: { id: p.id, stars, text: ta.value.trim() } });
      if (r.error) { toast(r.error, 'error', 4000); return; }
      toast('Спасибо за оценку!', 'ok', 1600);
      this.detail(p.id);
    };
    const del = $('[data-del]', box);
    if (del) del.onclick = async () => {
      const r = await window.api.shop.call('rate', { json: { id: p.id, stars: 0 } });
      if (r.error) toast(r.error, 'error', 4000); else this.detail(p.id);
    };
  },

  renderReviews(box, p, list, admin) {
    const withText = list.filter(r => r.text);
    if (!withText.length) { box.innerHTML = `<div class="sh-rh">Отзывы</div><p class="muted small">Отзывов пока нет.</p>`; return; }
    box.innerHTML = `<div class="sh-rh">Отзывы <span class="muted">${withText.length}</span></div>`;
    for (const r of withText) {
      const el = h(`<div class="sh-rev">
        <div class="sh-rtop"><b>${esc(r.nick)}</b>${this.stars(r.stars)}<span class="muted small">${this.date(r.updated)}${r.version ? ' · версия ' + esc(r.version) : ''}</span>
          ${admin ? `<button class="icon-btn tiny" title="Удалить отзыв">${icon('x')}</button>` : ''}</div>
        <p>${esc(r.text)}</p>
      </div>`);
      const x = $('.icon-btn', el);
      if (x) x.onclick = async () => {
        if (!(await confirmDlg('Удалить отзыв?', `Отзыв ${r.nick} и его оценка будут удалены.`))) return;
        const res = await window.api.shop.call('unreview', { json: { id: p.id, nick: r.nick } });
        if (res.error) toast(res.error, 'error', 4000); else this.detail(p.id);
      };
      box.appendChild(el);
    }
  },

  // ---------------------------------------------------------------- аккаунт
  accountMenu(btn) {
    if (!this.account) { this.loginDialog(); return; }
    menuBelow(btn, [
      { label: 'Скопировать ключ для входа на другом компьютере', icon: 'copy', onClick: async () => {
        const k = await window.api.shop.key();
        if (k) { navigator.clipboard.writeText(k); toast('Ключ скопирован. Никому его не показывайте', 'ok', 3000); }
      } },
      '-',
      { label: 'Выйти', icon: 'x', onClick: async () => {
        if (!(await confirmDlg('Выйти из магазина?', 'Без ключа вернуться к этому нику не получится. Если хотите войти позже — сначала скопируйте ключ.', 'Выйти'))) return;
        await window.api.shop.logout();
        this.account = null;
        this.renderAccount();
        if (this.cur) this.detail(this.cur.id);
      } },
    ]);
  },
  loginDialog(after) {
    const body = h(`<div class="sh-login">
      <p class="muted">Пароль не нужен: придумайте ник, а LinCut запомнит секретный ключ на этом компьютере. Ник видят все — под ним выходят ваши плагины и отзывы.</p>
      <input class="text-input" data-nick maxlength="24" placeholder="Ник">
      <div class="sh-err small"></div>
      <button class="link-btn" data-k>У меня уже есть ключ</button>
      <div class="sh-keyrow" hidden><input class="text-input" data-key maxlength="48" placeholder="Ключ (48 знаков)" spellcheck="false"></div>
    </div>`);
    const nick = $('[data-nick]', body), key = $('[data-key]', body), err = $('.sh-err', body);
    [nick, key].forEach(i => i.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); });
    $('[data-k]', body).onclick = () => { $('.sh-keyrow', body).hidden = false; nick.parentElement && (nick.hidden = true); $('[data-k]', body).hidden = true; key.focus(); };
    modal({ title: 'Вход в магазин', body, width: 420, buttons: [
      { label: 'Отмена' },
      { label: 'Войти', primary: true, onClick: async () => {
        const r = key.offsetParent ? await window.api.shop.login(key.value) : await window.api.shop.register(nick.value.trim());
        if (r.error) { err.textContent = r.error; return false; }
        this.account = r;
        if (this.body) this.renderAccount();
        toast('Вы вошли как ' + r.nick, 'ok', 1800);
        if (after) after();
      } },
    ] });
    setTimeout(() => nick.focus(), 50);
  },

  // ---------------------------------------------------------------- публикация
  async publishDialog() {
    if (!this.account) { this.loginDialog(() => this.publishDialog()); return; }
    const local = [...(await this.installed()).values()].filter(p => !p.error);
    if (!local.length) {
      modal({ title: 'Опубликовать плагин', width: 440, body: `<p class="muted">В папке плагинов нет ни одного рабочего плагина. Создайте свой («Плагины → Создать плагин…») или установите его из папки — и возвращайтесь.</p>`, buttons: [{ label: 'OK', primary: true }] });
      return;
    }
    const body = h(`<div class="sh-pub">
      <p class="muted small">Выберите плагин из папки плагинов. Он сразу появится в магазине с пометкой «Не проверен». Чтобы выложить новую версию, увеличьте "version" в plugin.json.</p>
      <div class="sh-plist">${local.map(p => `<label class="sh-prow"><input type="radio" name="shp" value="${esc(p.id)}"><span><b>${esc(p.manifest.name || p.id)}</b> <span class="muted">${esc(p.manifest.version || 'без версии')} · ${esc(p.id)}</span></span></label>`).join('')}</div>
      <div class="sh-pstate small muted">&nbsp;</div>
    </div>`);
    const st = $('.sh-pstate', body);
    let sel = null, ok = false;
    $('.sh-plist', body).onchange = async (e) => {
      sel = local.find(p => p.id === e.target.value);
      ok = false;
      st.className = 'sh-pstate small muted'; st.textContent = 'Проверяем…';
      const v = sel.manifest.version;
      if (!/^\d+(\.\d+){0,3}$/.test(String(v || ''))) { st.className = 'sh-pstate small sh-err'; st.textContent = 'В plugin.json нет поля "version" вида 1.0.0 — по нему LinCut находит обновления.'; return; }
      const d = await window.api.shop.call('get', { params: { id: sel.id } });
      if (!sel || sel.id !== e.target.value) return;
      if (d.error && !/нет в магазине/i.test(d.error)) { st.className = 'sh-pstate small sh-err'; st.textContent = d.error; return; }
      if (d.plugin && !d.plugin.mine) { st.className = 'sh-pstate small sh-err'; st.textContent = `id «${sel.id}» уже занят плагином автора ${d.plugin.author}. Поменяйте id в plugin.json.`; return; }
      if (d.plugin && this.cmp(v, d.plugin.version) <= 0) { st.className = 'sh-pstate small sh-err'; st.textContent = `В магазине уже версия ${d.plugin.version}. Увеличьте "version" в plugin.json.`; return; }
      ok = true;
      st.className = 'sh-pstate small muted';
      st.textContent = d.plugin ? `Обновление: ${d.plugin.version} → ${v}` : 'Новый плагин в магазине';
    };
    modal({ title: 'Опубликовать плагин', body, width: 520, buttons: [
      { label: 'Отмена' },
      { label: 'Опубликовать', primary: true, onClick: async (close, root) => {
        if (!sel) { st.className = 'sh-pstate small sh-err'; st.textContent = 'Выберите плагин'; return false; }
        if (!ok) return false;
        const btn = $('.primary-btn', root);
        btn.disabled = true; btn.textContent = 'Загрузка…';
        const r = await window.api.shop.publish(sel.id);
        btn.disabled = false; btn.textContent = 'Опубликовать';
        if (r.error) { st.className = 'sh-pstate small sh-err'; st.textContent = r.error; return false; }
        toast(r.updated ? `Новая версия ${r.plugin.version} опубликована` : 'Плагин опубликован', 'ok', 2500);
        if (this.dlg) this.detail(r.plugin.id);
      } },
    ] });
  },
};
