// Своя операция эффекта. Операция = две реализации одного и того же:
//   preview(ctx, src, op, env) — рисует кадр превью на canvas,
//   ffmpeg(op, input, X)       — добавляет фильтры в граф экспорта и возвращает метку выхода.
// Они должны давать одинаковую картинку — тогда превью совпадёт с готовым видео.
LinCut.plugin((lc) => {
  // число уровней яркости на канал → одна и та же формула для JS и ffmpeg
  const q = (v, L) => Math.floor(Math.floor(v * (L - 1) / 255 + 0.5) * 255 / (L - 1) + 0.5);
  const qExpr = (L) => `floor(floor(val*${L - 1}/255+0.5)*255/${L - 1}+0.5)`;

  lc.effects.addOp('posterize', {
    // ctx уже содержит кадр (W×H пикселей); src — его копия
    preview(ctx, src, op, env) {
      const L = Math.max(2, Math.round(op.levels));
      const im = ctx.getImageData(0, 0, env.W, env.H), d = im.data;
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) lut[v] = q(v, L);
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
      ctx.putImageData(im, 0, 0);
    },
    // на входе — кадры в формате gbrp размером X.W×X.H; X.L() — новая уникальная метка, X.graph — строки графа
    ffmpeg(op, input, X) {
      const L = Math.max(2, Math.round(op.levels)), e = qExpr(L), out = X.L('post');
      X.graph.push(`[${input}]lutrgb=r='${e}':g='${e}':b='${e}'[${out}]`);
      return out;
    },
  });

  lc.effects.add({
    id: 'poster', name: 'Постеризация', cat: 'color', speed: false,
    ops: (p) => [{ type: 'posterize', levels: Math.round(2 + (1 - p.I) * 10) }],
  });
  lc.effects.add({
    id: 'comic', name: 'Комикс', cat: 'color', speed: false,
    ops: (p) => [
      { type: 'lut', M: lc.effects.colorMatrix({ saturation: 50, contrast: 25 }) },
      { type: 'posterize', levels: Math.round(3 + (1 - p.I) * 4) },
    ],
  });
});
