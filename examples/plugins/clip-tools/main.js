// Встраивание в инспектор: секция во встроенной вкладке, своя вкладка и секция в свойствах проекта.
LinCut.plugin((lc) => {
  const { h, esc } = lc.ui;
  const visual = (c) => c && (c.kind === 'video' || c.kind === 'image');

  // ---- секция во вкладке «Видео» / «Изображение»
  lc.inspector.addSection({
    id: 'quick', tab: 'video', title: 'Быстрые действия', when: visual,
    render(sec, clip) {
      const row = h(`<div class="seg wide">
        <button data-a="fit">Вписать</button><button data-a="fill">Заполнить</button>
        <button data-a="center">По центру</button><button data-a="level">Выровнять</button>
      </div>`);
      row.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const s = lc.clip.mediaSize(clip), W = lc.project.width, H = lc.project.height;
        // масштаб 1 = картинка вписана в кадр; «заполнить» — без чёрных полос
        const fill = Math.max(W / s.w, H / s.h) / Math.min(W / s.w, H / s.h);
        const v = { fit: { scale: 1, x: 0, y: 0 }, fill: { scale: fill, x: 0, y: 0 }, center: { x: 0, y: 0 }, level: { rotation: 0, rx: 0, ry: 0 } }[b.dataset.a];
        lc.clip.setTransform(clip, v);
        lc.project.commit('quick-' + b.dataset.a);
        lc.inspector.refresh();
      };
      sec.appendChild(row);
    },
  });

  // ---- вкладка «JSON»: все свойства клипа как есть — можно поменять что угодно
  lc.inspector.addTab({
    id: 'json', title: 'JSON',
    render(body, clip) {
      const sec = h(`<div class="insp-sec"><div class="sec-title"><span>Свойства клипа</span></div><div class="sec-body"></div></div>`);
      const area = h(`<textarea class="text-input" spellcheck="false" style="width:100%;height:340px;padding:8px;font:11.5px/1.45 'IBM Plex Mono',monospace;resize:vertical"></textarea>`);
      area.value = JSON.stringify(clip, null, 2);
      area.onkeydown = (e) => e.stopPropagation();
      const err = h('<p class="muted small" style="min-height:16px;margin:6px 0 0"></p>');
      const apply = h('<button class="primary-btn wide">Применить</button>');
      apply.onclick = () => {
        let v;
        try { v = JSON.parse(area.value); } catch (e) { err.textContent = 'Ошибка JSON: ' + e.message; return; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) { err.textContent = 'Нужен объект { … }'; return; }
        v.id = clip.id; v.kind = clip.kind; // id и тип менять нельзя
        for (const k of Object.keys(clip)) if (!(k in v)) delete clip[k];
        Object.assign(clip, v);
        lc.project.commit('json'); // Ctrl+Z вернёт как было
        lc.ui.toast('Свойства применены', 'ok', 1200);
      };
      const b = sec.querySelector('.sec-body');
      b.append(area, err, apply);
      body.appendChild(sec);
    },
  });

  // ---- статистика в свойствах проекта
  lc.inspector.addSection({
    id: 'stats', tab: 'project', title: 'Статистика',
    render(sec) {
      const count = {};
      let fx = 0;
      for (const { clip } of lc.project.clips()) { count[clip.kind] = (count[clip.kind] || 0) + 1; fx += (clip.fx || []).length; }
      const names = { video: 'Видео', image: 'Картинки', text: 'Текст', audio: 'Звук', effect: 'Эффекты на дорожке' };
      const rows = Object.entries(count).map(([k, n]) => `<div><span>${esc(names[k] || k)}</span><b>${n}</b></div>`).join('');
      sec.appendChild(h(`<div class="kv">${rows || '<div><span>Клипов</span><b>0</b></div>'}<div><span>Эффекты на клипах</span><b>${fx}</b></div></div>`));
    },
  });
});
