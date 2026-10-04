// Главный экран со списком проектов
const Home = {
  list: [],
  view: (() => { try { return localStorage.getItem('lc.view') || 'grid'; } catch { return 'grid'; } })(),

  init() {
    $('#projSearch').addEventListener('input', () => this.draw());
    $('#projSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; this.draw(); } });
    $('#projView').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      this.view = b.dataset.v;
      try { localStorage.setItem('lc.view', this.view); } catch { }
      this.draw();
    };
    $('#homeAi').onclick = () => AiServer.dialog();
    $('#projectsPath').onclick = async () => window.api.openPath((await window.api.paths()).projects);
    this.drawThemes();
    bus.on('theme', () => this.drawThemes());
  },

  drawThemes() {
    const cur = Theme.current(), el = $('#themeList');
    el.innerHTML = THEMES.map(t => `<button data-t="${t.id}" class="${t.id === cur ? 'on' : ''}"${t.id === 'system' && !Theme.palette ? ' disabled data-tip="Палитра angelOS не найдена"' : ''}><i style="background:${Theme.swatch(t.id)}"></i>${t.name}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (b) Theme.apply(b.dataset.t); };
  },

  async render() {
    const paths = await window.api.paths();
    $('#projectsPath').textContent = paths.projects.replace(paths.home, '~');
    this.list = await window.api.listProjects();
    this.draw();
  },

  draw() {
    const q = $('#projSearch').value.trim().toLowerCase();
    const list = q ? this.list.filter(p => p.name.toLowerCase().includes(q)) : this.list;
    const grid = $('#projects');
    grid.className = 'projects ' + this.view;
    grid.innerHTML = '';
    $$('#projView button').forEach(b => b.classList.toggle('on', b.dataset.v === this.view));
    $('#projCount').textContent = this.list.length ? this.list.length : '';
    const empty = $('#emptyProjects');
    empty.classList.toggle('hidden', list.length > 0);
    $('div', empty).textContent = q ? 'Ничего не найдено' : 'Проектов пока нет';
    $('small', empty).textContent = q ? `По запросу «${$('#projSearch').value.trim()}» проектов нет` : 'Нажмите «Создать проект», чтобы начать';
    if (!list.length) return;

    if (this.view === 'list') grid.appendChild(h(`<div class="proj-row head"><span></span><span>Название</span><span>Длительность</span><span>Разрешение</span><span>Изменён</span><span></span></div>`));
    for (const p of list) {
      const ratio = p.width && p.height ? p.width / p.height : 16 / 9;
      const cover = p.cover ? `<img src="${fileUrl(p.cover)}?t=${p.updated}" class="${ratio < 1 ? 'portrait' : ''}">` : `<div class="pc-empty">${icon('film')}</div>`;
      const card = this.view === 'list'
        ? h(`<div class="proj-row">
            <div class="pr-cover">${p.cover ? `<img src="${fileUrl(p.cover)}?t=${p.updated}">` : icon('film')}</div>
            <span class="pr-name">${esc(p.name)}</span>
            <span>${p.duration ? fmtDur(p.duration) : '—'}</span>
            <span>${p.width ? p.width + '×' + p.height : '—'}</span>
            <span>${fmtDate(p.updated)}</span>
            <button class="pc-more icon-btn" title="Действия">${icon('more')}</button>
          </div>`)
        : h(`<div class="proj-card">
            <div class="pc-cover">${cover}
              ${p.duration ? `<span class="pc-dur">${fmtDur(p.duration)}</span>` : ''}
              <button class="pc-more" title="Действия">${icon('more')}</button>
            </div>
            <div class="pc-name">${esc(p.name)}</div>
            <div class="pc-meta">${fmtDate(p.updated)}${p.width ? ' · ' + p.width + '×' + p.height : ''}</div>
          </div>`);
      card.onclick = (e) => { if (!e.target.closest('.pc-more')) App.openProject(p.id); };
      const menu = (x, y) => showMenu(x, y, [
        { label: 'Открыть', icon: 'pencil', onClick: () => App.openProject(p.id) },
        { label: 'Переименовать', icon: 'type', onClick: async () => { const n = await promptDlg('Переименовать проект', p.name); if (n) { await window.api.renameProject(p.id, n); this.render(); } } },
        { label: 'Дублировать', icon: 'copy', onClick: async () => { await window.api.duplicateProject(p.id); this.render(); } },
        { label: 'Показать в папке', icon: 'folder', onClick: async () => { const pp = await window.api.paths(); window.api.openPath(pp.projects + '/' + p.id); } },
        '-',
        { label: 'Удалить', icon: 'trash', danger: true, onClick: async () => { if (await confirmDlg('Удалить проект?', `«${p.name}» будет удалён без возможности восстановления. Исходные медиафайлы не пострадают.`)) { await window.api.deleteProject(p.id); this.render(); } } },
      ]);
      $('.pc-more', card).onclick = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4); };
      card.oncontextmenu = (e) => { e.preventDefault(); menu(e.clientX, e.clientY); };
      grid.appendChild(card);
    }
  },
};
