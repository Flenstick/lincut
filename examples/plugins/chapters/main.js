// Главы для YouTube: своя вкладка левой панели, настройки из plugin.json, меню клипа и секция инспектора проекта.
// Главы — это обычные маркеры LinCut (клавиша B), так что они видны и на линейке таймлайна.
LinCut.plugin((lc) => {
  const { h, esc, icon } = lc.ui;
  const markers = () => [...((lc.project.current && lc.project.current.markers) || [])].sort((a, b) => a.t - b.t);

  // 75 → «1:15», 3725 → «1:02:05»
  function tc(t, hours) {
    t = Math.floor(t);
    const hh = Math.floor(t / 3600), mm = Math.floor(t / 60) % 60, ss = String(t % 60).padStart(2, '0');
    return hours ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${Math.floor(t / 60)}:${ss}`;
  }
  const useHours = () => lc.settings.get('hours') === 'always' || lc.project.duration() >= 3600;

  // главы для описания: первая обязательно с 0:00
  function chapters() {
    const list = markers().map(m => ({ t: m.t, name: m.name || lc.settings.get('name'), m }));
    if (!list.length || list[0].t > 0.5) list.unshift({ t: 0, name: 'Начало' });
    return list;
  }
  function problems(list) {
    const out = [], minLen = lc.settings.get('minLen'), end = lc.project.duration();
    if (list.length < 3) out.push('Нужно минимум 3 главы');
    list.forEach((c, i) => {
      const next = i + 1 < list.length ? list[i + 1].t : end;
      if (next - c.t < minLen) { c.short = true; out.push(`«${c.name}» короче ${minLen} с`); }
    });
    return out;
  }
  const text = () => chapters().map(c => `${tc(c.t, useHours())} ${c.name}`).join('\n');

  function addChapter(t) {
    const m = lc.project.addMarker(t, lc.settings.get('name') + ' ' + (markers().length + 1));
    lc.panels.refresh();
    return m;
  }

  // ---- вкладка «Главы» в левой панели
  lc.panels.add({
    id: 'chapters',
    title: 'Главы',
    icon: 'marker',
    render(root) {
      if (!lc.project.current) return;
      const head = h(`<div class="lp-head">
        <button class="import-btn">${icon('plus')}<span>Глава здесь</span></button>
        <span class="muted small">${markers().length} маркер(ов)</span>
      </div>`);
      head.querySelector('button').onclick = () => addChapter(lc.player.time);
      root.appendChild(head);

      const list = chapters(), warn = problems(list);
      const box = h('<div class="chp-list"></div>');
      for (const c of list) {
        const row = h(`<div class="chp-row ${c.short ? 'bad' : ''}">
          <span class="chp-tc" title="Перейти">${tc(c.t, useHours())}</span>
          <input value="${esc(c.name)}" spellcheck="false" ${c.m ? '' : 'disabled'}>
          ${c.m ? `<button class="icon-btn tiny" title="Удалить">${icon('trash')}</button>` : ''}
        </div>`);
        row.querySelector('.chp-tc').onclick = () => lc.player.seek(c.t);
        const inp = row.querySelector('input');
        inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
        inp.onchange = () => { c.m.name = inp.value.trim(); lc.project.commit('chapter-name'); };
        const del = row.querySelector('button');
        if (del) del.onclick = () => {
          const p = lc.project.current;
          p.markers.splice(p.markers.indexOf(c.m), 1);
          lc.project.commit('chapter-del');
          lc.panels.refresh();
        };
        box.appendChild(row);
      }
      root.appendChild(box);
      if (warn.length) root.appendChild(h(`<div class="chp-warn">${warn.map(w => `<span>${esc(w)}</span>`).join('')}</div>`));

      const copy = h(`<button class="secondary-btn wide">${icon('copy')}Копировать для описания YouTube</button>`);
      copy.onclick = async () => { await navigator.clipboard.writeText(text()); lc.ui.toast('Таймкоды скопированы', 'ok', 1400); };
      root.appendChild(copy);
    },
  });
  // список обновляется, когда меняется проект (например, маркер поставили клавишей B)
  let pend = null;
  lc.on('project', () => { clearTimeout(pend); pend = setTimeout(() => { if (lc.panels.isOpen('chapters')) lc.panels.refresh(); }, 80); });

  // ---- пункт в меню клипа (ПКМ на таймлайне)
  lc.timeline.addClipMenu((clip) => [{ label: 'Глава с начала клипа', icon: 'marker', onClick: () => addChapter(clip.start) }]);

  // ---- секция в инспекторе проекта (когда ничего не выбрано)
  lc.inspector.addSection({
    id: 'chapters', tab: 'project', title: 'Главы',
    render(sec) {
      const n = chapters().length, warn = problems(chapters());
      sec.appendChild(h(`<div class="kv"><div><span>Глав</span><b>${n}</b></div><div><span>YouTube</span><b>${warn.length ? 'есть замечания' : 'всё в порядке'}</b></div></div>`));
      const b = h(`<button class="secondary-btn wide">Открыть вкладку «Главы»</button>`);
      b.onclick = () => lc.panels.show('chapters');
      sec.appendChild(b);
    },
  });

  lc.commands.add({ id: 'copy', label: 'Копировать главы для YouTube', icon: 'copy', run: async () => { await navigator.clipboard.writeText(text()); lc.ui.toast('Таймкоды скопированы', 'ok', 1400); } });
  lc.commands.add({ id: 'settings', label: 'Главы: настройки…', icon: 'sliders', run: () => lc.settings.open() });
  lc.settings.onChange(() => lc.panels.refresh());
});
