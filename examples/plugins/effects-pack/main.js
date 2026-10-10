// Пример «каталожного» плагина. Эффекты собираются из операций (camera, levels, blur, rgb, glow…),
// поэтому сразу работают и в превью, и при экспорте — ничего про ffmpeg писать не нужно.
LinCut.plugin((lc) => {
  const n = lc.effects.n; // округление чисел для формул

  // своя категория во вкладке «Эффекты»
  lc.effects.addCategory({ id: 'pack', name: 'Набор' });

  // p.I — сила 0…1, p.V — скорость (0,25…4), p.D — длительность клипа эффекта, p.AR — ширина/высота кадра.
  // Строки — формулы от T (секунды от начала эффекта): sin, cos, abs, pow, exp, floor, mod, clip, if, lt, gt, rnd(x), sm(x)…
  lc.effects.add({
    id: 'heartbeat', cat: 'pack', name: 'Сердцебиение',
    ops: (p) => {
      // два толчка подряд, как «тук-тук», раз в 1/V секунды
      const B = `mod(T*${n(p.V)},1)`;
      const K = `(exp(-${B}*30)+0.6*exp(-abs(${B}-0.22)*30))`;
      return [
        { type: 'camera', z: `1+${n(0.12 * p.I)}*${K}` },
        { type: 'texture', gen: 'vignette', mode: 'multiply', o: `${n(0.3 + 0.5 * p.I)}*${K}` },
        { type: 'levels', r0: `${n(0.12 * p.I)}*${K}` },
      ];
    },
  });

  lc.effects.add({
    id: 'drunk', cat: 'pack', name: 'Пьяная камера',
    ops: (p) => [
      { type: 'camera', cover: true, z: n(1.08 + 0.06 * p.I),
        x: `${n(0.03 * p.I)}*sin(T*${n(1.3 * p.V)})`, y: `${n(0.02 * p.I)}*sin(T*${n(1.7 * p.V)}+1)`,
        r: `${n(0.05 * p.I)}*sin(T*${n(0.9 * p.V)})` },
      { type: 'accum', copies: [{ type: 'camera', z: 1.02 }, { type: 'camera', z: n(1.02 + 0.04 * p.I), x: `${n(0.02 * p.I)}*sin(T*${n(2.1 * p.V)})` }] },
      { type: 'blur', s: n(1 + 3 * p.I) },
    ],
  });

  lc.effects.add({
    id: 'cyber', cat: 'pack', name: 'Киберпанк', speed: false,
    ops: (p) => [
      { type: 'lut', M: lc.effects.colorMatrix({ saturation: 40 * p.I, contrast: 20, tint: 30 * p.I, warmth: -30 * p.I }) },
      { type: 'rgb', rh: n(-6 * p.I), bh: n(6 * p.I) },
      { type: 'glow', s: 18, o: n(0.25 + 0.4 * p.I) },
    ],
  });

  // фильтр (вкладка «Фильтры»): те же ползунки, что во вкладке «Цвет»
  lc.filters.add({ id: 'matrix', name: 'Матрица', a: { tint: -60, saturation: -20, contrast: 25, brightness: -6 } });
  lc.filters.add({ id: 'peach', name: 'Персик', a: { warmth: 35, tint: 18, brightness: 8, contrast: -10 } });

  // переход «эдит» на стыке клипов: p.D — длительность, p.U — положение (-1…1), p.A — близость к стыку (0…1…0)
  lc.transitions.add({
    id: 'flashZoom', name: 'Вспышка-зум',
    ops: (p) => [
      { type: 'camera', z: `1+0.6*pow(${p.A},3)` },
      { type: 'levels', o0: `0.9*pow(${p.A},4)` },
      { type: 'blur', s: `10*pow(${p.A},2)` },
    ],
  });

  // голос (вкладка «Аудио» → «Изменить голос»): цепочка фильтров ffmpeg от [in] до [out]
  lc.voices.add({
    id: 'megaphone', name: 'Мегафон', icon: 'volume', hint: 'Резкий голос из рупора',
    graph: '[in]highpass=f=600,lowpass=f=3500,acompressor=threshold=0.08:ratio=6:makeup=3,asoftclip=type=atan:threshold=0.6,aecho=0.6:0.4:40:0.2[out]',
  });

  // стиль текста (вкладка «Текст») и стикеры
  lc.text.addPreset({ name: 'Мем', text: 'КОГДА МОНТИРУЕШЬ В LINCUT', y: -0.38,
    style: { size: 96, bold: true, color: '#ffffff', strokeWidth: 8, strokeColor: '#000000', shadow: false } });
  lc.text.addStickers(['🦄', '🧠', '🗿', '🤌']);

  // кривая скорости (вкладка «Скорость» → «Кривая»): точки [доля клипа 0…1, скорость]
  lc.speedCurves.add({ id: 'pulse', name: 'Пульс', pts: [[0, 1], [0.2, 3], [0.4, 0.5], [0.6, 3], [0.8, 0.5], [1, 1]] });
});
