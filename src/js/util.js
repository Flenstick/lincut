// Общие утилиты интерфейса
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const uid = () => Math.random().toString(36).slice(2, 10);
const deep = (o) => JSON.parse(JSON.stringify(o));
// 1 месте, 2 местах, 5 местах
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const node = t.content.firstElementChild;
  hydrateIcons(t.content);
  return node;
}

function pad(n, l = 2) { return String(Math.floor(n)).padStart(l, '0'); }

// 00:00:05:12 (часы:минуты:секунды:кадры)
function fmtTC(t, fps = 30) {
  t = Math.max(0, t);
  const f = Math.floor((t % 1) * fps + 1e-6);
  return `${pad(t / 3600)}:${pad((t / 60) % 60)}:${pad(t % 60)}:${pad(f)}`;
}
// 1:05 / 01:02:03
function fmtDur(t) {
  t = Math.max(0, Math.round(t));
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}
function fmtSec(t) { return t < 10 ? t.toFixed(1) + 'с' : fmtDur(t); }
function fmtSize(b) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' ГБ';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' МБ';
  return Math.max(1, Math.round(b / 1e3)) + ' КБ';
}
function fmtDate(ms) {
  const d = new Date(ms), now = new Date();
  const same = d.toDateString() === now.toDateString();
  if (same) return 'Сегодня, ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const fileUrl = (p) => window.api.fileUrl(p);

// ---------------------------------------------------------------- оформление
// Раскладка у обеих тем одна (data-theme="capcut" в styles.css), отличаются только цвета:
// «Как в системе» подставляет токены из палитры angelOS поверх стандартных.
const THEMES = [
  { id: 'standard', name: 'Стандартная' },
  { id: 'system', name: 'Как в системе' },
];

const SysTheme = {
  hex(c) { c = String(c || '').replace('#', ''); return [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) || 0); },
  mix(a, b, t) { a = this.hex(a); b = this.hex(b); return '#' + a.map((x, i) => Math.round(x + (b[i] - x) * t).toString(16).padStart(2, '0')).join(''); },
  rgba(c, a) { return `rgba(${this.hex(c).join(', ')}, ${a})`; },
  luma(c) { const [r, g, b] = this.hex(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; },

  // палитра angelOS → токены LinCut. Светлая палитра — тёмная основа в её оттенках (монтажке нужен тёмный фон, как в Клипере)
  tokens(p) {
    let bg, face, alt, text, dim;
    if (p.mode === 'dark') {
      bg = p.bg || p.desk; face = p.face; alt = p.faceAlt; text = p.text; dim = p.textDim;
    } else {
      const tint = p.accent4 || p.accent;
      bg = this.mix('#0c0810', tint, .09); face = this.mix('#120c18', tint, .13); alt = this.mix('#19111f', tint, .17);
      text = this.mix('#f7eff4', p.accent, .05); dim = this.mix('#a99bb3', tint, .28);
    }
    const acc = p.accent, ink = p.selectText || (this.luma(acc) > 140 ? '#16081c' : '#ffffff');
    const m = (a, b, t) => this.mix(a, b, t);
    const p3 = m(alt, text, .08), p4 = m(alt, text, .14);
    const clip = (c, fb) => m(p[c] || fb, bg, .55);
    return {
      '--bg': bg, '--bar': bg, '--panel': face, '--head': face,
      '--panel-2': alt, '--panel-3': p3, '--panel-4': p4,
      '--field': alt, '--field-focus': m(alt, text, .22),
      '--line': m(face, text, .06), '--line-2': m(alt, text, .12),
      '--text': text, '--text-2': dim, '--text-3': m(dim, bg, .4),
      '--accent': acc, '--accent-text': ink, '--accent-soft': this.rgba(acc, .14),
      '--primary': acc, '--primary-text': ink,
      '--sel': text, '--playhead': text,
      '--danger': p.danger || '#f2555a', '--rec': p.danger || '#f2474d', '--ok': p.ok || '#3ccf7a',
      '--stage': m(bg, '#000000', .3), '--tl-bg': m(bg, face, .5),
      '--lane-main': m(face, alt, .4), '--track-head': face,
      '--menu': alt, '--menu-hover': p3, '--menu-hover-text': text,
      '--clip-video': clip('color6', acc), '--clip-image': clip('color4', acc), '--clip-audio': clip('color2', acc),
      '--clip-voice': clip('color5', acc), '--clip-text': clip('color3', acc), '--clip-effect': clip('accent2', acc),
      '--wave': this.rgba(text, .6), '--wave-strip': this.rgba(text, .7),
      '--ruler': m(face, text, .22), '--ruler-text': m(dim, bg, .15),
      '--thumb-empty': m(face, p.color6 || acc, .12),
    };
  },

  render(p) {
    let st = document.getElementById('sysTheme');
    if (!st) { st = document.createElement('style'); st.id = 'sysTheme'; document.head.appendChild(st); }
    st.textContent = p ? `:root[data-scheme="system"] {\n${Object.entries(this.tokens(p)).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`
      + `:root[data-scheme="system"] ::selection { background: ${p.accent}; color: ${this.tokens(p)['--accent-text']}; }` : '';
  },
};

const Theme = {
  cache: {},
  palette: null,
  current() { try { return localStorage.getItem('lc.scheme') || 'standard'; } catch { return 'standard'; } },
  swatch(id) { return id === 'system' ? (this.palette?.accent || '#808080') : '#1fcfe0'; },
  init() {
    this.palette = window.api.systemPalette();
    SysTheme.render(this.palette);
    window.api.onSystemPalette((p) => {
      this.palette = p;
      SysTheme.render(p);
      this.apply(this.current());
    });
  },
  apply(id) {
    if (!THEMES.find(t => t.id === id)) id = 'standard';
    const root = document.documentElement;
    root.dataset.theme = 'capcut';
    root.dataset.scheme = id;
    try { localStorage.setItem('lc.scheme', id); } catch { }
    this.cache = {};
    if (typeof bus !== 'undefined') bus.emit('theme', id);
  },
};
// значение CSS-переменной темы (для отрисовки на canvas)
function css(name) {
  if (!(name in Theme.cache)) Theme.cache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return Theme.cache[name];
}

// ---------------------------------------------------------------- тосты
function toast(msg, kind = 'info', ms = 2600) {
  const n = h(`<div class="toast ${kind}"><span data-i="${kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'}"></span><span>${esc(msg)}</span></div>`);
  $('#toastRoot').appendChild(n);
  requestAnimationFrame(() => n.classList.add('in'));
  setTimeout(() => { n.classList.remove('in'); setTimeout(() => n.remove(), 300); }, ms);
}

// ---------------------------------------------------------------- модальные окна
function modal({ title, body, width = 460, buttons = [], onClose, cls = '' }) {
  const root = h(`<div class="modal-back"><div class="modal ${cls}" style="width:${width}px">
    <div class="modal-head"><b>${esc(title || '')}</b><button class="icon-btn m-close"><span data-i="x"></span></button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div></div></div>`);
  const b = $('.modal-body', root);
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
  hydrateIcons(b);
  const foot = $('.modal-foot', root);
  if (!buttons.length) foot.remove();
  const close = (v) => { root.classList.remove('in'); setTimeout(() => root.remove(), 160); document.removeEventListener('keydown', onKey, true); onClose && onClose(v); };
  for (const bt of buttons) {
    const el = h(`<button class="${bt.primary ? 'primary-btn' : bt.danger ? 'danger-btn' : 'secondary-btn'}">${esc(bt.label)}</button>`);
    el.onclick = async () => { const r = bt.onClick ? await bt.onClick(close, root) : undefined; if (r !== false && !bt.keep) close(bt.value); };
    foot.appendChild(el);
  }
  $('.m-close', root).onclick = () => close(null);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(null); });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    if (e.key === 'Enter' && buttons.find(b => b.primary) && e.target.tagName !== 'TEXTAREA') { e.stopPropagation(); e.preventDefault(); $('.primary-btn', foot).click(); }
  };
  document.addEventListener('keydown', onKey, true);
  $('#modalRoot').appendChild(root);
  requestAnimationFrame(() => root.classList.add('in'));
  return { root, close };
}

function confirmDlg(title, text, okLabel = 'Удалить', danger = true) {
  return new Promise((res) => {
    modal({ title, body: `<p class="muted">${esc(text)}</p>`, width: 400, onClose: (v) => res(!!v), buttons: [
      { label: 'Отмена', value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ] });
  });
}

function promptDlg(title, value = '', placeholder = '') {
  return new Promise((res) => {
    const body = h(`<div><input class="text-input" style="width:100%" placeholder="${esc(placeholder)}" value="${esc(value)}"></div>`);
    let out = null;
    modal({ title, body, width: 400, onClose: () => res(out), buttons: [
      { label: 'Отмена' },
      { label: 'OK', primary: true, onClick: () => { out = $('input', body).value.trim(); } },
    ] });
    setTimeout(() => { const i = $('input', body); i.focus(); i.select(); }, 30);
  });
}

// ---------------------------------------------------------------- контекстные меню
let openMenu = null;
function closeMenu() { if (openMenu) { document.removeEventListener('keydown', openMenu._keys, true); openMenu.remove(); openMenu = null; } }
function showMenu(x, y, items, opts = {}) {
  closeMenu();
  const m = h(`<div class="ctx-menu ${opts.cls || ''} ${opts.instant ? 'instant' : ''}"></div>`);
  for (const it of items) {
    if (it === '-') { m.appendChild(h('<div class="ctx-sep"></div>')); continue; }
    const row = h(`<div class="ctx-item ${it.disabled ? 'disabled' : ''} ${it.checked ? 'checked' : ''} ${it.danger ? 'danger' : ''}">
      <span class="ctx-ic">${it.swatch ? `<i class="ctx-sw" style="background:${it.swatch}"></i>` : it.icon ? icon(it.icon) : it.checked ? icon('check') : ''}</span>
      <span class="ctx-label">${esc(it.label)}</span>${it.key ? `<span class="ctx-key">${esc(it.key)}</span>` : ''}</div>`);
    if (!it.disabled) {
      row.onclick = (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); };
      row.onmouseenter = () => hot(row);
    }
    m.appendChild(row);
  }
  // подсветка пункта общая для мыши и клавиатуры
  const rows = () => $$('.ctx-item:not(.disabled)', m);
  const hot = (r) => { $$('.ctx-item.hot', m).forEach(x => x !== r && x.classList.remove('hot')); if (r) { r.classList.add('hot'); r.scrollIntoView({ block: 'nearest' }); } };
  m.onmouseleave = () => hot(null);
  m._keys = (e) => {
    const list = rows(), i = list.findIndex(r => r.classList.contains('hot'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const d = e.key === 'ArrowDown' ? 1 : -1;
      hot(list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length]);
    } else if (e.key === 'Enter' || e.key === ' ') { if (i >= 0) list[i].click(); }
    else if (e.key === 'Escape') closeMenu();
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  document.addEventListener('keydown', m._keys, true);
  $('#menuRoot').appendChild(m);
  const r = m.getBoundingClientRect();
  if (x + r.width > innerWidth - 6) x = innerWidth - r.width - 6;
  if (y + r.height > innerHeight - 6) { y = Math.max(6, (opts.above != null ? opts.above : y) - r.height - (opts.above != null ? 4 : 0)); m.classList.add('up'); }
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  openMenu = m;
  Tip.hide();
  return m;
}
function menuBelow(btn, items, opts) {
  const r = btn.getBoundingClientRect();
  return showMenu(r.left, r.bottom + 4, items, { above: r.top, ...opts });
}
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.menubar')) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ---------------------------------------------------------------- перетаскивание мышью
function dragMove(e, onMove, onUp, cursor) {
  const sx = e.clientX, sy = e.clientY;
  if (cursor) document.body.style.cursor = cursor;
  document.body.classList.add('dragging');
  const mv = (ev) => onMove(ev, ev.clientX - sx, ev.clientY - sy);
  const up = (ev) => {
    document.removeEventListener('mousemove', mv);
    document.removeEventListener('mouseup', up);
    document.body.style.cursor = '';
    document.body.classList.remove('dragging');
    onUp && onUp(ev, ev.clientX - sx, ev.clientY - sy);
  };
  document.addEventListener('mousemove', mv);
  document.addEventListener('mouseup', up);
}

// Поле-ползунок в стиле CapCut: подпись, слайдер, числовое поле
function sliderRow({ label, min, max, step = 1, value, unit = '', def = 0, onInput, onCommit, fmt, parse }) {
  const row = h(`<div class="prop-row slider-row">
    <label>${esc(label)}</label>
    <input type="range" min="${min}" max="${max}" step="${step}">
    <div class="num-box"><input type="text" class="num"><span class="unit">${esc(unit)}</span></div>
  </div>`);
  const range = $('input[type=range]', row), num = $('.num', row);
  const show = (v) => {
    range.value = v;
    num.value = fmt ? fmt(v) : (Math.round(v * 100) / 100);
    const p = (v - min) / (max - min) * 100;
    range.style.setProperty('--p', clamp(p, 0, 100) + '%');
  };
  show(value);
  range.addEventListener('input', () => { const v = +range.value; show(v); onInput && onInput(v); });
  range.addEventListener('change', () => onCommit && onCommit(+range.value));
  range.addEventListener('dblclick', () => { show(def); onInput && onInput(def); onCommit && onCommit(def); });
  num.addEventListener('change', () => {
    let v = parseFloat(num.value.replace(',', '.'));
    if (!isFinite(v)) v = +range.value;
    else if (parse) v = parse(v);
    v = clamp(v, min, max);
    show(v); onInput && onInput(v); onCommit && onCommit(v);
  });
  num.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') num.blur(); });
  row.set = show;
  return row;
}

function toggleRow(label, value, onChange) {
  const row = h(`<div class="prop-row toggle-row"><label>${esc(label)}</label><button class="switch ${value ? 'on' : ''}"><i></i></button></div>`);
  const b = $('.switch', row);
  b.onclick = () => { b.classList.toggle('on'); onChange(b.classList.contains('on')); };
  return row;
}

// ---------------------------------------------------------------- подсказки
// Сменить текст подсказки (Tip переносит title в data-tip при первом наведении)
function setTip(el, text) { if (!el) return; el.removeAttribute('title'); el.dataset.tip = text; }

// Вместо системных title: своя подсказка с задержкой, как в нативных программах.
// «Разделить (Ctrl+B)» → текст + клавиша отдельным блоком. Пока подсказка «прогрета»,
// соседние кнопки показывают её сразу.
const Tip = {
  el: null, target: null, timer: 0, warmUntil: 0,
  init() {
    this.el = h('<div class="tip"></div>');
    document.body.appendChild(this.el);
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest && e.target.closest('[title], [data-tip]');
      if (t && t.hasAttribute('title')) { t.dataset.tip = t.getAttribute('title'); t.removeAttribute('title'); }
      if (t === this.target) return;
      this.hide(true);
      if (!t || !t.dataset.tip || document.body.classList.contains('dragging')) return;
      this.target = t;
      this.timer = setTimeout(() => this.show(t), performance.now() < this.warmUntil ? 0 : 550);
    });
    for (const ev of ['mousedown', 'wheel', 'keydown', 'blur']) window.addEventListener(ev, () => this.hide(), true);
  },
  show(t) {
    if (!t.isConnected || !t.matches(':hover')) return;
    const m = /^(.*?)\s*\(([^()]+)\)$/.exec(t.dataset.tip);
    const text = m && /^(Ctrl|Shift|Alt|Пробел|Delete|[A-Z←→+−\-])/.test(m[2]) ? m[1] : t.dataset.tip;
    const key = text !== t.dataset.tip ? m[2] : '';
    this.el.innerHTML = esc(text) + (key ? `<kbd>${esc(key)}</kbd>` : '');
    const r = t.getBoundingClientRect(), tr = this.el.getBoundingClientRect();
    let y = r.bottom + 6, up = false;
    if (y + tr.height > innerHeight - 4) { y = r.top - tr.height - 6; up = true; }
    const x = clamp(r.left + r.width / 2 - tr.width / 2, 4, innerWidth - tr.width - 4);
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
    this.el.classList.toggle('up', up);
    this.el.classList.add('show');
  },
  hide(keepWarm) {
    clearTimeout(this.timer);
    if (this.el && this.el.classList.contains('show')) {
      this.el.classList.remove('show');
      this.warmUntil = keepWarm ? performance.now() + 400 : 0;
    }
    if (!keepWarm) this.warmUntil = 0;
    this.target = null;
  },
};

// ---------------------------------------------------------------- анимации
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Варианты анимации смены вкладок (пока выбираем — переключаются в меню «Вид»):
// fade — плашка проявляется на новой вкладке, содержимое проявляется на месте;
// shift — плашка быстро переходит, содержимое чуть сдвигается со стороны вкладки;
// snap — мгновенно, как в Resolve; slide — прежний вариант (плашка «переезжает»).
const MOTIONS = [
  { id: 'fade', name: 'проявление на месте' },
  { id: 'shift', name: 'сдвиг в сторону вкладки' },
  { id: 'snap', name: 'мгновенно' },
  { id: 'slide', name: 'переезд плашки (прежняя)' },
];
const Motion = {
  current() { try { const m = localStorage.getItem('lc.motion'); return MOTIONS.find(t => t.id === m) ? m : 'fade'; } catch { return 'fade'; } },
  apply(id) {
    if (!MOTIONS.find(t => t.id === id)) id = 'fade';
    document.documentElement.dataset.motion = id;
    try { localStorage.setItem('lc.motion', id); } catch { }
  },
  mode() { return reducedMotion() ? 'snap' : this.current(); },
};

// появление содержимого при смене вкладки; dir — с какой стороны пришла вкладка (-1, 0, 1)
function animIn(el, dir = 0) {
  if (!el) return;
  el.getAnimations().forEach(a => a.id === 'swap' && a.cancel());
  const m = Motion.mode();
  let kf, opt;
  if (m === 'fade') { kf = [{ opacity: 0 }, { opacity: 1 }]; opt = { duration: 130, easing: 'cubic-bezier(.2,0,0,1)' }; }
  else if (m === 'shift') { kf = [{ opacity: 0, transform: `translateX(${dir * 14}px)` }, { opacity: 1, transform: 'none' }]; opt = { duration: 170, easing: 'cubic-bezier(.2,0,0,1)' }; }
  else if (m === 'slide') { kf = [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }]; opt = { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' }; }
  else return;
  el.animate(kf, opt).id = 'swap';
}

// Индикатор активной вкладки. key — чтобы помнить прошлую позицию, даже когда
// полоса вкладок пересоздаётся заново (инспектор). Возвращает направление смены.
const tabInk = {
  last: {},
  update(bar, key) {
    let ink = $(':scope > .tab-ink', bar);
    const fresh = !ink;
    if (fresh) {
      ink = document.createElement('i'); ink.className = 'tab-ink'; bar.appendChild(ink); bar.classList.add('has-ink');
      // при изменении размера панели — переставить без анимации
      let first = true;
      new ResizeObserver(() => {
        const a = $(':scope > button.active', bar);
        if (first) { first = false; return; } // первый вызов приходит сразу после observe — не сбиваем анимацию
        if (!a || !bar.isConnected) return;
        ink.style.transition = 'none';
        ink.style.transform = `translateX(${a.offsetLeft}px)`; ink.style.width = a.offsetWidth + 'px';
        this.last[key] = { x: a.offsetLeft, w: a.offsetWidth };
        void ink.offsetWidth; ink.style.transition = '';
      }).observe(bar);
    }
    const a = $(':scope > button.active', bar);
    if (!a) { ink.style.opacity = 0; return 0; }
    const pos = { x: a.offsetLeft, w: a.offsetWidth };
    const prev = this.last[key];
    this.last[key] = pos;
    const moved = !!prev && (prev.x !== pos.x || prev.w !== pos.w);
    const dir = moved ? Math.sign(pos.x - prev.x) : 0;
    const put = (p) => { ink.style.transform = `translateX(${p.x}px)`; ink.style.width = p.w + 'px'; };
    const jump = (p) => { ink.style.transition = 'none'; put(p); void ink.offsetWidth; ink.style.transition = ''; };
    const m = Motion.mode();
    ink.style.opacity = 1;
    if (m === 'slide' || m === 'shift') {
      if (fresh) jump(prev || pos);
      put(pos);
      return dir;
    }
    jump(pos);
    if (m === 'fade' && moved) {
      // старая плашка гаснет на своём месте, новая проявляется на новой вкладке
      const g = ink.cloneNode();
      g.style.transition = 'none'; g.style.transform = `translateX(${prev.x}px)`; g.style.width = prev.w + 'px';
      ink.after(g);
      g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out' }).onfinish = () => g.remove();
      ink.animate([{ opacity: 0, transform: `translateX(${pos.x}px) scale(.92)` }, { opacity: 1, transform: `translateX(${pos.x}px)` }],
        { duration: 140, easing: 'cubic-bezier(.2,0,0,1)' });
    }
    return dir;
  },
};

// плавное сворачивание/разворачивание блока по высоте
function slideToggle(el, show, done) {
  if (reducedMotion()) { done && done(); return; }
  const full = el.scrollHeight;
  el.style.overflow = 'hidden';
  const a = el.animate(
    show ? [{ height: '0px', opacity: 0 }, { height: full + 'px', opacity: 1 }] : [{ height: full + 'px', opacity: 1 }, { height: '0px', opacity: 0 }],
    { duration: Math.min(260, 120 + full * 0.3), easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
  a.onfinish = () => { done && done(); a.cancel(); el.style.overflow = ''; };
}
