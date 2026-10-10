// Самый простой плагин: команда в меню «Плагины», горячая клавиша и подписка на события.
LinCut.plugin((lc) => {
  lc.commands.add({
    id: 'hello',
    label: 'Сказать привет',
    icon: 'info',
    key: 'Ctrl+Alt+H',
    run() {
      const clip = lc.project.selected();
      if (!clip) return lc.ui.toast('Привет! Выберите клип на таймлайне.');
      const len = lc.clip.duration(clip).toFixed(1);
      lc.ui.toast(`Выбран клип «${clip.kind}» длиной ${len} с`, 'ok');
    },
  });

  // команда в меню «Клип»: активна, только когда выбран клип
  lc.commands.add({
    id: 'center',
    label: 'Поставить в центр кадра',
    menu: 'clip',
    enabled: () => !!(lc.project.selected() && lc.project.selected().transform),
    run() {
      lc.clip.setTransform(lc.project.selected(), { x: 0, y: 0 });
      lc.project.commit('center'); // шаг отмены (Ctrl+Z) + сохранение + перерисовка
    },
  });

  lc.on('open', (p) => lc.log('Открыт проект', p.name));
  lc.on('export:done', (r) => { if (r.ok) lc.log('Экспортировано в', r.file); });
});
