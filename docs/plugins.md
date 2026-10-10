# Плагины LinCut

Плагин — это папка с `plugin.json` и JavaScript-файлом. Через плагин можно добавить команды и горячие клавиши,
эффекты, фильтры, переходы, голоса, стили текста, кривые скорости, свои панели, вкладки и секции инспектора,
пункты контекстного меню — и вообще изменить что угодно в редакторе.

Эффекты, фильтры и переходы из плагинов **одинаково выглядят в превью и в готовом видео**.

## Быстрый старт

1. **Плагины → Создать плагин…** — LinCut создаст папку с примером и откроет её.
2. Откройте `main.js` в любом редакторе кода, поменяйте что-нибудь.
3. **Плагины → Перезагрузить плагины** (`Ctrl+Shift+R`). Открытый проект сохранится и откроется снова.
   Или включите в окне «Плагины» галочку «Перезагружать при изменении файлов».

Папка плагинов: Linux — `~/.config/LinCut/plugins`, Windows — `%APPDATA%\LinCut\plugins`.
Установить чужой плагин: **Плагины → Установить плагин…** (`.zip`, `.lcplugin` или папка) или перетащить `.lcplugin` в окно.
`.lcplugin` — это обычный zip-архив с папкой плагина. Подойдёт и архив «Download ZIP» с GitHub.

Готовые примеры — в [`examples/plugins`](../examples/plugins):

| Пример | Что показывает |
|---|---|
| `hello` | команда в меню, горячая клавиша, события |
| `effects-pack` | эффекты, категория, фильтры, переход, голос, стиль текста, стикеры, кривая скорости |
| `posterize` | своя операция эффекта: рисование в превью + фильтр ffmpeg для экспорта |
| `chapters` | своя панель слева, настройки, меню клипа, секция в свойствах проекта, свой CSS |
| `clip-tools` | секция и своя вкладка инспектора, правка любого свойства клипа через JSON |

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "Мой плагин",
  "version": "1.0.0",
  "author": "Имя",
  "description": "Что делает плагин",
  "main": "main.js",
  "style": "style.css",
  "lincut": ">=1.2.0",
  "homepage": "https://github.com/…",
  "settings": [
    { "key": "size", "label": "Размер", "type": "number", "min": 1, "max": 100, "default": 50, "unit": "%" },
    { "key": "mode", "label": "Режим", "type": "select", "default": "a", "options": [["a", "Первый"], ["b", "Второй"]] },
    { "key": "on", "label": "Включено", "type": "toggle", "default": true },
    { "key": "name", "label": "Текст", "type": "text", "default": "" },
    { "key": "color", "label": "Цвет", "type": "color", "default": "#ffcc00" }
  ]
}
```

* `id` — строчные латинские буквы, цифры и дефис. Обязателен вместе с `name`.
* `style` — необязательный CSS. Используйте токены LinCut: `var(--panel-2)`, `var(--text)`, `var(--accent)`…
* `settings` — окно настроек строится само (меню «⋯» у плагина в окне «Плагины»), значения — `lc.settings.get(key)`.

## main.js

```js
LinCut.plugin((lc) => {
  lc.commands.add({ id: 'hi', label: 'Привет', key: 'Ctrl+Alt+H', run: () => lc.ui.toast('Привет!') });
});
```

Функция получает объект `lc` — API плагина. Она может быть `async`. Ошибки в коде плагина не роняют редактор:
они видны в окне «Плагины» («Журнал ошибок») и в консоли (`LINCUT_DEVTOOLS=1 lincut`).

Id, которые вы передаёте в `effects.add`, `filters.add` и т. п., получают приставку `ваш-id:` (например, `my-plugin:glow`),
чтобы плагины не мешали друг другу. Внутри своего плагина можно писать короткий id.

## API `lc`

### Общее
| | |
|---|---|
| `lc.id`, `lc.manifest`, `lc.dir`, `lc.version` | id, plugin.json, папка плагина, версия LinCut |
| `lc.url(путь)` | адрес файла плагина (`lincut-plugin://id/…`) для `<img>`, `fetch` |
| `await lc.readText(путь)`, `await lc.readJSON(путь)` | прочитать файл из папки плагина |
| `lc.addStyle(css)` | добавить CSS |
| `lc.on(событие, fn)` → `off()` | события: `selection`, `time`, `project`, `edit`, `changed`, `open`, `close`, `export:start`, `export:done`, `play`, `plugins:ready` |
| `lc.log(...)`, `lc.openExternal(url)` | |

### Интерфейс — `lc.ui`
`toast(текст, 'info'|'ok'|'error', мс)`, `modal({ title, body, buttons, width })`, `await confirm(title, text)`,
`await prompt(title, value)`, `menu(x, y, items)`, `h(html)` → элемент, `esc(s)`, `icon(имя)`, `addIcon(имя, svg-пути 256×256)`,
`slider({ label, min, max, value, onInput, onCommit })`, `toggle(label, value, onChange)`.
Иконки — [Phosphor](https://phosphoricons.com), список имён — `lc.internals.ICONS`.

### Команды — `lc.commands`
```js
lc.commands.add({
  id: 'center', label: 'В центр', icon: 'fit',
  key: 'Ctrl+Alt+C',            // буквы работают и в русской раскладке
  menu: 'clip',                 // plugins (по умолчанию) | file | edit | clip | view | help | none
  enabled: () => !!lc.project.selected(),
  run() { … },
});
lc.commands.run('center');
```
Горячая клавиша плагина важнее встроенной.

### Эффекты — `lc.effects`
Эффект — список **операций**. Каждая операция уже умеет рисовать превью и собирать фильтр ffmpeg.
```js
lc.effects.addCategory({ id: 'mine', name: 'Мои' });
lc.effects.add({
  id: 'pulse', name: 'Пульс', cat: 'mine',   // cat: своя категория или trend/camera/light/glitch/retro/color/split/distort
  speed: true, strength: true,                // показывать ли ползунки «Скорость»/«Сила»
  ops: (p) => [                               // p.I — сила 0…1, p.V — скорость 0.25…4, p.D — длительность, p.AR — W/H
    { type: 'camera', z: `1+${0.2 * p.I}*abs(sin(T*${3 * p.V}))` },
  ],
});
```
Числа в операциях можно задавать формулой-строкой от `T` (секунды от начала эффекта). Функции:
`sin cos tan abs pow exp sqrt floor ceil min max clip(x,a,b) if(c,a,b) lt gt lte gte mod PI`,
макросы `rnd(x)` (псевдослучайное 0…1) и `sm(x)` (плавный шаг 0…1). Свой макрос — `lc.effects.addMacro(имя, x => 'формула')`.

Операции (единица размера `u` = 1 пиксель кадра 1080p):

| type | параметры |
|---|---|
| `camera` | `z` зум, `x`,`y` сдвиг (доля кадра), `r` поворот (рад), `cover` — без чёрных углов |
| `levels` | `o0`/`o1` — уровни выхода всех каналов, или `r0 r1 g0 g1 b0 b1` |
| `mix` | `m` — матрица 3×3 (9 формул): `lc.effects.hueMatrix(a)`, `lc.effects.satMatrix(s)` |
| `lut` | `M` — цветовая матрица: `lc.effects.colorMatrix({ brightness, contrast, saturation, hue, warmth, tint, sepia })` |
| `blur` | `s` — сила, `dir: 'h'` — только по горизонтали |
| `rgb` | сдвиг каналов `rh rv gh gv bh bv` |
| `noise` | `s` — сила |
| `pixel` | `b` — размер блока |
| `glow` | `s` — радиус, `o` — сила |
| `texture` | `gen`: vignette, leak, scan, bars; `mode`: multiply/screen/normal; `o`, `sx`, `sy`, `mw`, `mh` |
| `layout` | `kind`: mirrorH, mirrorV, grid2, grid3, triple |
| `trail` | `d` — шлейф 0…1 |
| `warp` | `name`: fisheye, bulge, pinch, swirl, kaleido, ripple, barrel; `k` |
| `hdr` | `s`, `k` |
| `edges` | `c` [r,g,b], `pre`, `cut`, `sharp`, `glow`, `s`, `base` |
| `accum` | `copies` — массив операций `camera`, усреднение копий кадра |

Готовые эффекты LinCut (`lc.effects.list`, файл `src/js/effects.js`) — лучшая шпаргалка.

#### Своя операция
Нужны две реализации, дающие одинаковую картинку (пример — `examples/plugins/posterize`):
```js
lc.effects.addOp('posterize', {
  preview(ctx, src, op, env) { … },     // ctx уже содержит кадр env.W×env.H, src — его копия; env.T — время, env.u — единица
  ffmpeg(op, input, X) {                 // input — метка входа (gbrp, X.W×X.H)
    const out = X.L('post');             // новая метка
    X.graph.push(`[${input}]lutrgb=…[${out}]`);
    return out;                          // метка выхода, тот же размер, формат gbrp
  },
  readsPixels: false,
});
```
В `X`: `W H fps S E D u`, `L(префикс)`, `graph`, `val(имя_фильтра, опция, формула, { mul, min, round })` —
анимированный параметр через sendcmd, `Tin`/`Tt` — выражение времени для подстановки (`lc.effects.ff(формула, X.Tt)`).

### Другие каталоги
```js
lc.filters.add({ id: 'teal', name: 'Бирюза', a: { warmth: -30, saturation: 20 } });
lc.transitions.add({ id: 'zoom', name: 'Зум', ops: (p) => [{ type: 'camera', z: `1+0.5*pow(${p.A},2)` }] });
//   p.D — длительность, p.U — положение -1…1 относительно стыка, p.A — близость к стыку 0…1…0
lc.voices.add({ id: 'robot2', name: 'Робот 2', icon: 'robot', hint: '…', graph: '[in]…фильтры ffmpeg…[out]' });
lc.text.addPreset({ name: 'Мем', text: 'ТЕКСТ', y: -0.38, style: { size: 96, bold: true, strokeWidth: 8 } });
lc.text.addStickers(['🦄', '🗿']);
lc.speedCurves.add({ id: 'pulse', name: 'Пульс', pts: [[0, 1], [0.5, 3], [1, 1]] });
```

### Панели и инспектор
```js
// панель слева (все панели плагинов — во вкладке-значке «Плагины»)
lc.panels.add({ id: 'list', title: 'Список', render(root, sub) { root.append(lc.ui.h('<div>…</div>')); } });
lc.panels.show('list'); lc.panels.refresh(); lc.panels.isOpen('list');

// секция во вкладке инспектора: video audio speed anim adjust mask text effect project — или в своей вкладке
lc.inspector.addSection({ id: 'q', tab: 'video', title: 'Быстрые действия', when: (clip) => clip.kind === 'video',
  render(sec, clip, ctx) { ctx.onRefresh(() => { /* обновить при перемотке */ }); } });
lc.inspector.addTab({ id: 'json', title: 'JSON', when: (clip) => true, render(body, clip) { … } });

// пункты в меню клипа (правая кнопка на таймлайне)
lc.timeline.addClipMenu((clip) => [{ label: 'Что-то сделать', icon: 'sparkles', onClick() { … } }]);
```

### Проект — `lc.project`, `lc.clip`, `lc.player`
```js
lc.project.current            // весь проект (объект, его можно менять)
lc.project.clips()            // [{ clip, track }]
lc.project.selected()         // выбранный клип или null; selectedAll()
lc.project.select(id | [ids])
lc.project.commit('метка')    // после любых изменений: шаг отмены Ctrl+Z, автосохранение, перерисовка
lc.project.addText({ text, start, duration, style, x, y })
lc.project.addEffect('pulse', { start, duration })      // эффект на дорожке эффектов
lc.project.addClipEffect(clip, 'pulse', { strength: 80 })
lc.project.addMarker(t, 'Имя')
await lc.project.importFiles(['/путь/файл.mp4']); lc.project.place(media, t)

lc.clip.transformAt(clip)     // { x, y, scale, rotation, opacity, sx, sy, rx, ry } на курсоре (с ключевыми кадрами)
lc.clip.setTransform(clip, { x: 0, y: 0 })
lc.clip.duration(clip), lc.clip.end(clip), lc.clip.box(clip), lc.clip.mediaSize(clip)

lc.player.time; lc.player.seek(2.5); lc.player.play(); lc.player.pause(); lc.player.render(); lc.player.snapshot()
```

### Хранилище, настройки, ffmpeg
```js
lc.storage.set('k', { любое: 'значение' }); lc.storage.get('k', поУмолчанию);
lc.settings.get('size'); lc.settings.set('size', 10); lc.settings.onChange((key, v) => …); lc.settings.open();
const r = await lc.ffmpeg.run(['-i', 'in.mp4', 'out.gif'], { onProgress: (сек) => … }); // { code, stdout, stderr }
const p = await lc.ffmpeg.probe(['-v', 'quiet', '-print_format', 'json', '-show_format', file]);
```

### Всё остальное — `lc.internals`
`App, store, bus, Player, Timeline, Inspector, Panels, Exporter, Media, Edit, EFFECTS, FXOPS, FXEXP, FILTER_PRESETS,
TRANSITIONS, VOICE_FX, ICONS…` — прямой доступ к внутренностям редактора (исходники — `src/js`).
Через них можно поменять что угодно, но эти объекты могут меняться между версиями — где хватает `lc`, лучше `lc`.

## Безопасность
Плагин работает с теми же правами, что и сам LinCut (может читать и писать файлы через редактор).
Ставьте плагины только из источников, которым доверяете, — как расширения браузера.

## Магазин плагинов
**Плагины → Магазин плагинов…** — каталог плагинов от других людей: поиск, сортировка (популярные, лучшие, новые),
установка и обновление в один клик, оценки от 1 до 5 звёзд и отзывы.

* **Вход** — только ник, без пароля. LinCut хранит секретный ключ у себя (`store-account.json` рядом с папкой плагинов).
  Чтобы войти с другого компьютера, скопируйте ключ в меню аккаунта и вставьте его в «У меня уже есть ключ».
* **Опубликовать** — выберите плагин из папки плагинов. В `plugin.json` нужен `version` вида `1.0.0`;
  новая версия публикуется, только если номер стал больше. id плагина закрепляется за автором.
* Архив — до 4 МБ. Папки и файлы, начинающиеся с точки, и `node_modules` в архив не попадают.
* Новые плагины видны всем сразу, с пометкой «Не проверен». Отметку «Проверен» ставит администратор магазина;
  после выхода новой версии она снимается до следующей проверки.

## Как поделиться плагином
Упакуйте папку плагина в zip и переименуйте в `.lcplugin` (или выложите на GitHub — подойдёт «Download ZIP»).
