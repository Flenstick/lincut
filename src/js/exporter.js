// Экспорт: сборка графа фильтров ffmpeg из модели проекта
const RESOLUTIONS = [
  { id: 480, label: '480p' }, { id: 720, label: '720p' }, { id: 1080, label: '1080p' }, { id: 1440, label: '2K' }, { id: 2160, label: '4K' },
];
const QUALITY = [
  { id: 'low', label: 'Низкое', crf: 27, preset: 'veryfast' },
  { id: 'rec', label: 'Рекомендуемое', crf: 21, preset: 'medium' },
  { id: 'high', label: 'Высокое', crf: 17, preset: 'slow' },
];

const num = (v) => (Math.round(v * 10000) / 10000).toString();
// Путь к файлу внутри графа фильтров: прямые слэши и экранированное двоеточие (C\:/…) — иначе на Windows
// «C:» разрезает параметры фильтра. Кавычки — снаружи.
const ffq = (p) => `'${String(p).replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

// Время клипа в выражениях ffmpeg — те же формулы, что srcAt/ltAt (store.js).
// x — выражение: время от начала используемого куска источника (для ltExpr) или от начала клипа (для srcExpr)
function ltExpr(c, x) {
  if (!hasCurve(c)) return `(${x})/${num(c.speed)}`;
  const { segs } = curveSegs(c);
  let e = null;
  for (let i = segs.length - 1; i >= 0; i--) {
    const g = segs[i], d = `(${x}-${g.s0})`;
    const f = g.dv ? `(${g.t0}+${g.Ls / g.dv}*log(max(1e-9,(${g.v0}+${g.dv}*${d}/${g.Ls})/${g.v0})))` : `(${g.t0}+${d}/${g.v0})`;
    e = e == null ? f : `if(lt(${x},${g.s1}),${f},${e})`;
  }
  return e || '0';
}
function srcExpr(c, x) {
  if (!hasCurve(c)) return `(${num(c.in)}+(${x})*${num(c.speed)})`;
  const { segs } = curveSegs(c);
  let e = null;
  for (let i = segs.length - 1; i >= 0; i--) {
    const g = segs[i], tau = `(${x}-${g.t0})`;
    const f = g.dv ? `(${g.s0}+${g.Ls / g.dv * g.v0}*(exp(${tau}*${g.dv / g.Ls})-1))` : `(${g.s0}+${tau}*${g.v0})`;
    e = e == null ? f : `if(lt(${x},${g.t1}),${f},${e})`;
  }
  return `(${num(c.in)}+${e || '0'})`;
}
// setpts для видео клипа: кадр источника → время таймлайна
function clipSetpts(c, s) {
  if (!hasCurve(c)) return `setpts=(PTS-STARTPTS)/${num(c.speed)}+${num(s)}/TB`;
  return `setpts='(${ltExpr(c, '(T-STARTT)')}+${num(s)})/TB'`;
}

const Exporter = {
  opts: null,

  defaults() {
    const p = store.p;
    const short = Math.min(p.width, p.height);
    return this.opts || {
      res: RESOLUTIONS.reduce((a, r) => r.id <= Math.max(720, short) ? r.id : a, 1080),
      quality: 'rec', codec: 'h264', format: 'mp4', fps: p.fps, video: true, audio: true, audioFormat: 'mp3',
      folder: null,
    };
  },

  async open() {
    if (!store.p) return;
    if (Player.playing) Player.pause();
    const dur = store.duration();
    if (dur <= 0) { toast('Таймлайн пуст — нечего экспортировать', 'error'); return; }
    if (VoiceFx.pendingClips().length && !(await confirmDlg('Голос ещё обрабатывается', 'Изменённый голос для некоторых клипов ещё не готов. Экспортировать их с исходным звуком?', 'Экспортировать', false))) return;
    if (Stab.pendingClips().length && !(await confirmDlg('Стабилизация ещё идёт', 'Некоторые клипы ещё стабилизируются. Экспортировать их без стабилизации?', 'Экспортировать', false))) return;
    if (VoiceSep.pendingClips().length && !(await confirmDlg('Нейросеть ещё работает', 'Голос и фон для некоторых клипов ещё не готовы. Экспортировать их с исходным звуком?', 'Экспортировать', false))) return;
    const missing = store.p.media.filter(m => assets[m.id] && assets[m.id].missing && store.allClips().some(x => x.clip.mediaId === m.id));
    if (missing.length) { toast('Отсутствуют файлы: ' + missing.map(m => m.name).join(', '), 'error', 5000); return; }
    const o = { ...this.defaults() };
    const io = Edit.range();
    // поставили точки входа/выхода — по умолчанию экспортируем их, как Premiere
    o.range = io ? (this.opts && this.opts.ioKey === JSON.stringify(io) ? this.opts.range : 'io') : 'all';
    o.ioKey = io ? JSON.stringify(io) : null;
    const paths = await window.api.paths();
    if (!o.folder) o.folder = paths.videos;
    const cover = Player.captureCover();
    const body = h(`<div class="export">
      <div class="ex-cover">
        ${cover ? `<img src="${cover}">` : '<div class="ex-nocover"></div>'}
        <div class="ex-cover-info"><span>${fmtDur(dur)}</span><span class="ex-size"></span></div>
      </div>
      <div class="ex-form">
        <div class="ex-row"><label>Название</label><input class="text-input ex-name" value="${esc(store.p.name)}"></div>
        <div class="ex-row"><label>Сохранить в</label><button class="select-btn ex-folder"><span>${esc(o.folder)}</span>${icon('folder')}</button></div>
        ${io ? `<div class="ex-row"><label>Диапазон</label><div class="seg ex-range"><button data-v="all" class="${o.range !== 'io' ? 'on' : ''}">Весь таймлайн</button><button data-v="io" class="${o.range === 'io' ? 'on' : ''}">Вход — выход · ${fmtDur(io.b - io.a)}</button></div></div>` : ''}
        <div class="ex-sec">
          <label class="check"><input type="checkbox" class="ex-video" ${o.video ? 'checked' : ''}><span></span><b>Видео</b></label>
          <div class="ex-grid ex-vopts">
            <div class="ex-row"><label>Разрешение</label><div class="seg ex-res">${RESOLUTIONS.map(r => `<button data-v="${r.id}" class="${o.res === r.id ? 'on' : ''}">${r.label}</button>`).join('')}</div></div>
            <div class="ex-row"><label>Качество</label><div class="seg ex-q">${QUALITY.map(q => `<button data-v="${q.id}" class="${o.quality === q.id ? 'on' : ''}">${q.label}</button>`).join('')}</div></div>
            <div class="ex-row"><label>Кодек</label><div class="seg ex-codec"><button data-v="h264" class="${o.codec === 'h264' ? 'on' : ''}">H.264</button><button data-v="hevc" class="${o.codec === 'hevc' ? 'on' : ''}">HEVC</button></div></div>
            <div class="ex-row"><label>Формат</label><div class="seg ex-fmt"><button data-v="mp4" class="${o.format === 'mp4' ? 'on' : ''}">MP4</button><button data-v="mov" class="${o.format === 'mov' ? 'on' : ''}">MOV</button></div></div>
            <div class="ex-row"><label>Частота кадров</label><div class="seg ex-fps">${[24, 25, 30, 50, 60].map(f => `<button data-v="${f}" class="${o.fps === f ? 'on' : ''}">${f}</button>`).join('')}</div></div>
          </div>
        </div>
        <div class="ex-sec">
          <label class="check"><input type="checkbox" class="ex-audio" ${o.audio ? 'checked' : ''}><span></span><b>Аудио</b></label>
          <div class="ex-grid ex-aopts">
            <div class="ex-row"><label>Только аудио</label><div class="seg ex-afmt"><button data-v="mp3" class="${o.audioFormat === 'mp3' ? 'on' : ''}">MP3</button><button data-v="wav" class="${o.audioFormat === 'wav' ? 'on' : ''}">WAV</button><button data-v="flac" class="${o.audioFormat === 'flac' ? 'on' : ''}">FLAC</button></div></div>
          </div>
        </div>
      </div>
    </div>`);
    const segs = { '.ex-res': 'res', '.ex-q': 'quality', '.ex-codec': 'codec', '.ex-fmt': 'format', '.ex-fps': 'fps', '.ex-afmt': 'audioFormat', ...(io ? { '.ex-range': 'range' } : {}) };
    const upd = () => {
      $('.ex-vopts', body).classList.toggle('disabled', !o.video);
      $('.ex-aopts', body).classList.toggle('disabled', o.video || !o.audio);
      const d = o.range === 'io' && io ? io.b - io.a : dur;
      $('.ex-cover-info span', body).textContent = fmtDur(d);
      const sz = this.estimate(o, d);
      $('.ex-size', body).textContent = sz ? '≈ ' + fmtSize(sz) : '';
    };
    for (const [sel, key] of Object.entries(segs)) {
      $(sel, body).onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        o[key] = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v;
        $$('button', $(sel, body)).forEach(x => x.classList.toggle('on', x === b));
        upd();
      };
    }
    $('.ex-video', body).onchange = (e) => { o.video = e.target.checked; upd(); };
    $('.ex-audio', body).onchange = (e) => { o.audio = e.target.checked; upd(); };
    $('.ex-folder', body).onclick = async () => {
      const f = await window.api.pickFolder(o.folder);
      if (f) { o.folder = f; $('.ex-folder span', body).textContent = f; }
    };
    $('.ex-name', body).addEventListener('keydown', e => e.stopPropagation());
    upd();
    modal({ title: 'Экспорт', body, width: 760, cls: 'export-modal', buttons: [
      { label: 'Отмена' },
      { label: 'Экспорт', primary: true, onClick: (close) => {
        if (!o.video && !o.audio) { toast('Выберите видео или аудио', 'error'); return false; }
        const name = ($('.ex-name', body).value.trim() || store.p.name).replace(/[\/\\:*?"<>|]/g, '_');
        this.opts = o;
        close();
        this.run(o, name, cover);
        return false;
      } },
    ] });
  },

  estimate(o, dur) {
    if (!o.video) return o.audio ? dur * (o.audioFormat === 'mp3' ? 24000 : o.audioFormat === 'wav' ? 192000 : 110000) : 0;
    const px = o.res * o.res * 16 / 9;
    const bpp = { low: 0.05, rec: 0.09, high: 0.16 }[o.quality] * (o.codec === 'hevc' ? 0.6 : 1);
    return dur * (px * o.fps * bpp / 8 + (o.audio ? 24000 : 0));
  },

  // ---------------------------------------------------------------- сборка команды
  async build(o, outPath, onStatus) {
    const p = store.p;
    const total = store.duration();
    const short = Math.min(p.width, p.height);
    const k = o.res / short;
    const W = Math.round(p.width * k / 2) * 2, H = Math.round(p.height * k / 2) * 2;
    const kx = W / p.width, ky = H / p.height; // почти равны k
    const fps = o.fps;
    const args = [];
    const graph = [];
    let nIn = 0;
    const input = (a) => { args.push(...a); return nIn++; };

    const withVideo = o.video;
    let vcur = null;
    if (withVideo) {
      const bi = input(['-f', 'lavfi', '-i', `color=c=${(p.bg || '#000000').replace('#', '0x')}:s=${W}x${H}:r=${fps}:d=${num(total)}`]);
      graph.push(`[${bi}:v]format=yuv420p[base0]`);
      vcur = 'base0';
    }
    const ai = input(['-f', 'lavfi', '-t', num(total), '-i', 'anullsrc=r=48000:cl=stereo']);
    const audioLabels = [`[${ai}:a]`];
    let lbl = 0;
    const L = (pfx) => `${pfx}${++lbl}`;

    const tracks = p.tracks;
    // Видео/картинки/текст: снизу вверх
    const visualOrder = [];
    for (let i = tracks.length - 1; i >= 0; i--) {
      const tr = tracks[i];
      if (tr.kind === 'audio' || tr.hidden) continue;
      for (const c of tr.clips) if (!c.disabled) visualOrder.push({ c, tr });
      if (tr.main) visualOrder.push({ junction: tr });
    }
    const inputOf = {}; // clipId -> index входа (для видео со звуком)
    // вход картинки видео-клипа: стабилизированный файл (без звука) или исходник (его звук потом используем повторно)
    const videoIn = (c, m) => {
      const st = Stab.altVideo(c);
      if (st) return input(['-ss', num(c.in - st.a), '-t', num(c.out - c.in), '-i', st.path]);
      const idx = input(['-ss', num(c.in), '-t', num(c.out - c.in), '-i', m.path]);
      inputOf[c.id] = idx;
      return idx;
    };

    // Ветка графа с эффектом, действующим только в окне [S, E]
    let fxN = 0;
    const fxBranch = async (inLabel, ops, S, E) => {
      // поток режется на «до | эффект | после» и склеивается — без буферизации кадров
      if (!ops || !ops.length || E - S < 0.01) return inLabel;
      const id = ++fxN;
      S = Math.max(0, S); E = Math.min(total, E);
      if (E - S < 0.01) return inLabel;
      const hasPre = S > 0.5 / fps, hasPost = E < total - 0.5 / fps;
      const pre = L('fp'), b = L('fb'), post = L('fq');
      graph.push(`[${inLabel}]split=${1 + hasPre + hasPost}${hasPre ? `[${pre}_s]` : ''}[${b}]${hasPost ? `[${post}_s]` : ''}`);
      if (hasPre) graph.push(`[${pre}_s]trim=end=${num(S)},setpts=PTS-STARTPTS,setsar=1[${pre}]`);
      if (hasPost) graph.push(`[${post}_s]trim=start=${num(E)},setpts=PTS-STARTPTS,setsar=1[${post}]`);
      const headIdx = graph.length;
      graph.push(null); // заполним после сборки (нужен файл команд)
      const first = Math.ceil(S * fps - 1e-6) / fps;
      const cmds = [];
      const X = {
        W, H, fps, S, E, D: E - S, u: H / 1080, id, first,
        // in у perspective считается с 1
        Tin: `((in-1)/${fps}+${num(first - S)})`, Tt: `(t-${num(S)})`, Tcmd: `(T-${num(S)})`,
        L, graph, input, num,
        // значение параметра фильтра: статическое или покадровое через sendcmd
        // o: { mul, round, floor, min, def }
        val(target, opt, expr, o = {}) {
          const mul = o.mul ?? 1, e0 = expr ?? o.def ?? 0;
          let v = fxVal(e0, 0) * mul;
          if (o.round) v = Math.floor(v + 0.5);
          if (o.floor) v = Math.floor(v);
          if (o.min != null) v = Math.max(o.min, v);
          if (!isStatic(e0)) {
            let fe = `(${fxFF(e0, X.Tcmd)})*${mul}`;
            if (o.round) fe = `floor(${fe}+0.5)`;
            if (o.floor) fe = `floor(${fe})`;
            if (o.min != null) fe = `max(${o.min},${fe})`;
            cmds.push(`${num(S)}-${num(E)} [expr] ${target} ${opt} '${fe}';`);
          }
          return num(v);
        },
      };
      const startLabel = L('fc');
      let cur = startLabel;
      for (const op of ops) cur = await FXEXP[op.type](op, cur, X);
      let head = `[${b}]trim=start=${num(S)}:end=${num(E)}`;
      if (cmds.length) {
        const f = await window.api.writeTemp(`cmd_${id}.txt`, cmds.join('\n'));
        head += `,sendcmd=f=${ffq(f)}`;
      }
      graph[headIdx] = `${head},format=gbrp[${startLabel}]`;
      const fe = L('fe'), out = L('fo');
      graph.push(`[${cur}]trim=end=${num(E)},format=yuv420p,setpts=PTS-STARTPTS,setsar=1[${fe}]`);
      const segs = [hasPre && pre, fe, hasPost && post].filter(Boolean);
      if (segs.length === 1) return fe;
      graph.push(`${segs.map(x => `[${x}]`).join('')}concat=n=${segs.length}:v=1:a=0,setpts=N/(${fps}*TB)[${out}]`);
      return out;
    };

    // Кусочно-линейная интерполяция ключей в выражении ffmpeg: v0 + Σ Δv·clip((s − sᵢ)/Δs, 0, 1).
    // У разборщика выражений ffmpeg предел ≈ 95 слагаемых в одном выражении (и ≈ 100 уровней вложенности),
    // а у трекинга ключей — сотни, поэтому сумма копится в переменной кусками по 40: st(v,…);st(v,ld(v)+…);…
    const kfSt = (K, prop, sx, mul, v) => {
      let out = `st(${v},${num(K[0][prop] * mul)});`, part = '', n = 0;
      for (let i = 0; i < K.length - 1; i++) {
        const a = K[i], b = K[i + 1], dv = (b[prop] - a[prop]) * mul;
        if (Math.abs(dv) < 1e-7) continue;
        part += `+(${num(dv)})*clip((${sx}-${num(a.s)})/${num(Math.max(1e-6, b.s - a.s))},0,1)`;
        if (++n === 40) { out += `st(${v},ld(${v})${part});`; part = ''; n = 0; }
      }
      if (part) out += `st(${v},ld(${v})${part});`;
      return out;
    };
    // то же как самостоятельное выражение (время источника — в переменной 8, результат — в 9)
    const kfExpr = (K, prop, sx, mul = 1) => `(st(8,${sx});${kfSt(K, prop, 'ld(8)', mul, 9)}ld(9))`;
    // Альфа слоя × маска (серый поток той же величины): blend умножением → alphamerge
    const alphaMul = (inL, mk) => {
      const a = L('ma'), b = L('mb'), al = L('mal'), mm = L('mm'), out = L('mo');
      graph.push(`[${inL}]format=rgba,split[${a}][${b}]`);
      graph.push(`[${a}]alphaextract[${al}]`);
      graph.push(`[${al}][${mk}]blend=all_mode=multiply:shortest=1[${mm}]`);
      graph.push(`[${b}][${mm}]alphamerge[${out}]`);
      return out;
    };
    // Вырезанный нейросетью объект: кадры маски идут вместе с кадрами источника (тот же setpts)
    const rotoStep = (inL, c, w, h) => {
      const R = Roto.exportInfo(c);
      const K = clamp(Math.ceil((c.in - R.a) * R.fps - 1e-3), 0, R.n - 1);
      const mi = input(['-framerate', num(R.fps), '-start_number', String(K), '-i', R.pattern]);
      const mk = L('rk');
      const f = [clipSetpts(c, c.start), `scale=${w}:${h}:flags=bicubic`, 'format=rgba', 'alphaextract'];
      if (c.flipH) f.push('hflip');
      if (c.flipV) f.push('vflip');
      if (c.roto.invert) f.push('negate');
      graph.push(`[${mi}:v]${f.join(',')}[${mk}]`);
      return alphaMul(inL, mk);
    };
    // Маска-фигура: та же картинка, что в превью — после отражения, до поворота.
    // Маска пером с анимацией формы — картинка на каждый кадр (одинаковые кадры — один файл)
    let pmN = 0;
    const shapeStep = async (inL, c, w, h, s, d) => {
      const mk = L('mk');
      if (penAnimated(c.mask)) {
        const id = ++pmN, first = Math.ceil(s * fps - 1e-6) / fps, files = [], seen = new Map();
        for (let T = first; T < s + d - 1e-6; T += 1 / fps) {
          const pts = penPtsAt(c.mask, srcTime(c, T)), key = JSON.stringify(pts);
          if (!seen.has(key)) seen.set(key, await window.api.writeTemp(`pm_${id}_${seen.size}.png`, maskLumaPng(c.mask, w, h, srcTime(c, T))));
          files.push(seen.get(key));
        }
        const pat = await window.api.linkSeq(`pms_${id}`, files);
        const mi = input(['-framerate', String(fps), '-i', pat]);
        graph.push(`[${mi}:v]format=gray,setpts=PTS-STARTPTS+${num(first)}/TB[${mk}]`);
        // кадры слоя — на сетке кадров, как и маска
        const g = L('mg');
        graph.push(`[${inL}]fps=${fps}[${g}]`);
        inL = g;
      } else {
        const png = await window.api.writeTemp(`mask_${c.id}_${w}x${h}.png`, maskLumaPng(c.mask, w, h, null));
        const mi = input(['-loop', '1', '-framerate', String(fps), '-t', num(d + 1), '-i', png]);
        graph.push(`[${mi}:v]format=gray,setpts=PTS-STARTPTS+${num(s)}/TB[${mk}]`);
      }
      return alphaMul(inL, mk);
    };
    const maskStep = async (inL, c, w, h, s, d) => {
      let cur = inL;
      if (Roto.on(c)) cur = rotoStep(cur, c, w, h);
      if (maskOn(c)) cur = await shapeStep(cur, c, w, h, s, d);
      return cur;
    };
    const masked = (c) => maskOn(c) || Roto.on(c);
    // Слой на кадр: обычное наложение или режим наложения (смешивание только в окне клипа)
    const place = async (base, v, ox, oy, ev, c, s, e) => {
      const bl = blendOf(c);
      if (!bl) {
        const out = L('o');
        graph.push(`[${base}][${v}]overlay=x='${ox}':y='${oy}':eval=${ev}:eof_action=pass:enable='between(t,${num(s)},${num(e)})'[${out}]`);
        return out;
      }
      return fxBranch(base, [{ type: 'blendLayer', layer: v, x: ox, y: oy, eval: ev, mode: bl.ff }], s, e);
    };
    const moveExpr = (list, kk, T) => list.map(m => `+(${num(m.amt * kk)})*${CURVES[m.curve].x(`clip((${T}-${num(m.from)})/${num(m.dur)},0,1)`)}`).join('');
    let kfN = 0;
    // Слой с ключевыми кадрами: масштабируем один раз до максимума, кладём на прозрачный холст
    // и покадрово раскладываем через perspective (позиция, масштаб, поворот), прозрачность — через sendcmd.
    // Размытие в движении: N копий слоя со сдвигом времени трансформации, среднее по premultiplied (как в превью)
    const keyedLayer = async (c, fx, blur) => {
      const K = c.keys && c.keys.length ? c.keys : [{ s: c.in, ...baseTf(c) }];
      const s = c.start, e = clipEnd(c), d = e - s, id = ++kfN;
      const sPre = clamp(Math.max(...K.map(k => k.scale)), 0.05, 4);
      const chain = [];
      let idx, lw, lh, head = null;
      const cmdName = `colorchannelmixer@kf${id}`;
      const opVaries = K.some(k => Math.abs(k.opacity - K[0].opacity) > 1e-4);
      const sT = srcExpr(c, `(T-${num(s)})`);
      let cmdFile = null;
      if (opVaries) cmdFile = await window.api.writeTemp(`kf_${id}.txt`, `${num(s)}-${num(e + 1)} [expr] ${cmdName} aa '${kfExpr(K, 'opacity', sT)}';`);
      if (c.kind === 'text') {
        const ct = { ...c, keys: null, transform: { x: 0, y: 0, scale: sPre, rotation: 0 }, opacity: 1, blend: null };
        const L = textLayout(ct);
        lw = Math.max(W, Math.ceil(L.w * sPre * kx) + 8); lh = Math.max(H, Math.ceil(L.h * sPre * ky) + 8);
        const cv = document.createElement('canvas'); cv.width = lw; cv.height = lh;
        const cx = cv.getContext('2d');
        cx.translate((lw - W) / 2, (lh - H) / 2);
        drawText(cx, ct, p.width, p.height, kx, { alpha: 1, dx: 0, dy: 0 });
        const png = await window.api.writeTemp(`kft_${id}.png`, cv.toDataURL('image/png'));
        idx = input(['-loop', '1', '-framerate', String(fps), '-t', num(d), '-i', png]);
        chain.push(`setpts=PTS-STARTPTS+${num(s)}/TB`);
        if (cmdFile) chain.push(`sendcmd=f=${ffq(cmdFile)}`);
        chain.push('format=gbrap');
      } else {
        const m = store.media(c.mediaId);
        if (!m) return null;
        if (c.kind === 'image') { idx = input(['-loop', '1', '-framerate', String(fps), '-t', num(d), '-i', m.path]); chain.push(`setpts=PTS-STARTPTS+${num(s)}/TB`); }
        else { idx = videoIn(c, m); chain.push(clipSetpts(c, s)); }
        if (cmdFile) chain.push(`sendcmd=f=${ffq(cmdFile)}`);
        const ms = mediaSize(c), f = Math.min(p.width / ms.w, p.height / ms.h) * sPre;
        const sw = Math.max(2, Math.round(ms.w * f * kx)), sh = Math.max(2, Math.round(ms.h * f * ky));
        chain.push(`scale=${sw}:${sh}:flags=bicubic`, ...chromaFilters(c), 'format=gbrap');
        const lut = clipLUT(c);
        if (lut) chain.push(`lut3d=file=${ffq(await window.api.writeTemp('lut_' + c.id + '.cube', lut))}:interp=tetrahedral`);
        if (c.adjust && c.adjust.blur > 0) chain.push(`gblur=sigma=${num(c.adjust.blur / 100 * 30 * kx)}`);
        if (c.flipH) chain.push('hflip');
        if (c.flipV) chain.push('vflip');
        if (masked(c)) {
          const pre = L('kp');
          graph.push(`[${idx}:v]${chain.join(',')}[${pre}]`);
          head = await maskStep(pre, c, sw, sh, s, d);
          chain.length = 0;
          chain.push('format=gbrap');
        }
        // прозрачный запас по краям обязателен: perspective продолжает крайние пиксели холста за его пределы
        lw = Math.max(W, sw + 4); lh = Math.max(H, sh + 4);
        chain.push(`pad=${lw}:${lh}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      }
      // покадровая трансформация; dt — сдвиг времени образца размытия, mv — сдвиги анимации появления внутри perspective
      const t0 = Math.round(s * fps) / fps;
      const mx = fx.moves.filter(m => m.axis === 'x'), my = fx.moves.filter(m => m.axis === 'y');
      const persp = (dt, mv) => {
        // in у perspective считается с 1
        const T = `((in-1)/${fps}+${num(t0 + dt)})`;
        const sIn = srcExpr(c, `(${T}-${num(s)})`);
        // время источника и параметры кадра считаются один раз в переменные выражения (st/ld)
        const pre = `st(0,${sIn});${kfSt(K, 'x', 'ld(0)', kx, 1)}${kfSt(K, 'y', 'ld(0)', ky, 2)}${kfSt(K, 'rotation', 'ld(0)', Math.PI / 180, 3)}${kfSt(K, 'scale', 'ld(0)', 1 / sPre, 4)}`;
        const ax = mv ? moveExpr(mx, kx, T) : '', ay = mv ? moveExpr(my, ky, T) : '';
        const corners = [[-lw / 2, -lh / 2], [lw / 2, -lh / 2], [-lw / 2, lh / 2], [lw / 2, lh / 2]].map(([dx, dy], i) =>
          `x${i}='${pre}${num(W / 2)}+ld(1)${ax}+((${dx})*cos(ld(3))-(${dy})*sin(ld(3)))*ld(4)':y${i}='${pre}${num(H / 2)}+ld(2)${ay}+((${dx})*sin(ld(3))+(${dy})*cos(ld(3)))*ld(4)'`).join(':');
        return `fps=${fps},perspective=${corners}:sense=destination:interpolation=linear:eval=frame,crop=${W}:${H}:0:0`;
      };
      const tail = [`${cmdName}=aa=${num(K[0].opacity)}`];
      for (const f of fx.fades) tail.push(`fade=t=${f.dir}:st=${num(f.from)}:d=${num(Math.max(0.001, f.dur))}:alpha=1`);
      const v = L('kv');
      if (!blur) {
        graph.push(`[${head || idx + ':v'}]${chain.join(',')},${tail.join(',')},${persp(0, false)}[${v}]`);
        return { v, ox: `0${moveExpr(mx, kx, 't')}`, oy: `0${moveExpr(my, ky, 't')}`, ev: fx.moves.length ? 'frame' : 'init' };
      }
      const offs = mblurOffsets(c), sp = offs.map(() => L('bs')), bo = offs.map(() => L('bo')), mxL = L('bm');
      graph.push(`[${head || idx + ':v'}]${chain.join(',')},premultiply=inplace=1,split=${offs.length}${sp.map(x => `[${x}]`).join('')}`);
      offs.forEach((dt, i) => graph.push(`[${sp[i]}]${persp(dt, true)}[${bo[i]}]`));
      graph.push(`${bo.map(x => `[${x}]`).join('')}mix=inputs=${offs.length}:weights='${offs.map(() => 1).join(' ')}'[${mxL}]`);
      graph.push(`[${mxL}]unpremultiply=inplace=1,${tail.join(',')}[${v}]`);
      return { v, ox: '0', oy: '0', ev: 'init' };
    };
    // Слой, нарисованный покадрово кодом превью (текст с аниматорами или размытием в движении)
    let cvN = 0;
    const canvasLayer = async (c, tr, s, e) => {
      const id = ++cvN, first = Math.ceil(s * fps - 1e-6) / fps;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const x = cv.getContext('2d', { willReadFrequently: true });
      const cc = { ...c, blend: undefined, matte: null };
      const plain = (xx, c2, tt, an) => drawText(xx, c2, p.width, p.height, kx, an, tt);
      const files = [], seen = new Map();
      const n = Math.max(1, Math.ceil((e - first) * fps - 1e-6));
      for (let j = 0; j < n; j++) {
        const T = first + j / fps;
        x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
        x.clearRect(0, 0, W, H);
        drawClipLayer(x, cc, tr, T, p.width, p.height, kx, plain);
        // одинаковые кадры (буквы уже на месте) — один файл
        const u = new Uint32Array(x.getImageData(0, 0, W, H).data.buffer);
        let h1 = 2166136261 >>> 0, h2 = 0;
        for (let i = 0; i < u.length; i++) { const q = u[i]; if (q) { h1 = Math.imul(h1 ^ q ^ i, 16777619) >>> 0; h2 = (h2 + Math.imul(q, i + 1)) >>> 0; } }
        const key = h1 + ':' + h2;
        if (!seen.has(key)) seen.set(key, await window.api.writeTemp(`cl_${id}_${seen.size}.png`, cv.toDataURL('image/png')));
        files.push(seen.get(key));
        if (onStatus && j % 10 === 0) onStatus(`Подготовка анимации текста… ${Math.round(j / n * 100)}%`);
      }
      const pat = await window.api.linkSeq(`cls_${id}`, files);
      const idx = input(['-framerate', String(fps), '-i', pat]);
      const v = L('cv');
      graph.push(`[${idx}:v]format=rgba,setpts=PTS-STARTPTS+${num(first)}/TB[${v}]`);
      return { v, ox: '0', oy: '0', ev: 'init' };
    };

    // Слой клипа (ещё не положенный на кадр): { v, ox, oy, ev }
    const layerOf = async (c, tr) => {
      const s = c.start, e = clipEnd(c), d = e - s;
      const blur = mblurActive(c, tr);
      if (c.kind === 'text' && (blur || textAnimOn(c))) return canvasLayer(c, tr, s, e);
      const fx = clipFx(c, tr, p.width, p.height);
      if ((c.keys && c.keys.length > 1) || blur) return keyedLayer(c, fx, blur);
      // без анимации ключами: берём постоянную трансформацию (или единственный ключ)
      const eff = tfAt(c, s);
      const cs = { ...c, keys: null, transform: { ...c.transform, ...eff }, opacity: eff.opacity };
      const chain = [];
      let idx, head = null;
      let ox = null, oy = null;
      if (c.kind === 'text') {
        const png = await this.textPng(cs, W, H, kx);
        idx = input(['-loop', '1', '-framerate', String(fps), '-t', num(d), '-i', png]);
        chain.push('format=rgba', `setpts=PTS-STARTPTS+${num(s)}/TB`);
        ox = '0'; oy = '0';
      } else {
        const m = store.media(c.mediaId);
        if (!m) return null;
        if (c.kind === 'image') {
          idx = input(['-loop', '1', '-framerate', String(fps), '-t', num(d), '-i', m.path]);
          chain.push(`setpts=PTS-STARTPTS+${num(s)}/TB`);
        } else {
          idx = videoIn(c, m);
          chain.push(clipSetpts(c, s));
        }
        const b = clipBox(cs, p.width, p.height);
        const sw = Math.max(2, Math.round(b.w * kx)), sh = Math.max(2, Math.round(b.h * ky));
        chain.push(`scale=${sw}:${sh}:flags=bicubic`, ...chromaFilters(c), 'format=rgba');
        const lut = clipLUT(c);
        if (lut) chain.push(`lut3d=file=${ffq(await window.api.writeTemp('lut_' + c.id + '.cube', lut))}:interp=tetrahedral`);
        if (c.adjust && c.adjust.blur > 0) chain.push(`gblur=sigma=${num(c.adjust.blur / 100 * 30 * kx)}`);
        if (c.flipH) chain.push('hflip');
        if (c.flipV) chain.push('vflip');
        if (masked(c)) {
          const pre = L('mp');
          graph.push(`[${idx}:v]${chain.join(',')}[${pre}]`);
          head = await maskStep(pre, c, sw, sh, s, d);
          chain.length = 0;
          chain.push('format=rgba');
        }
        if (b.rot) chain.push(`rotate=${num(b.rot * Math.PI / 180)}:ow=rotw(${num(b.rot * Math.PI / 180)}):oh=roth(${num(b.rot * Math.PI / 180)}):c=none`);
        if (cs.opacity < 1) chain.push(`colorchannelmixer=aa=${num(cs.opacity)}`);
        ox = `(W-w)/2+${num(cs.transform.x * kx)}`;
        oy = `(H-h)/2+${num(cs.transform.y * ky)}`;
      }
      for (const f of fx.fades) chain.push(`fade=t=${f.dir}:st=${num(f.from)}:d=${num(Math.max(0.001, f.dur))}:alpha=1`);
      const mx = fx.moves.filter(m => m.axis === 'x'), my = fx.moves.filter(m => m.axis === 'y');
      ox += moveExpr(mx, kx, 't'); oy += moveExpr(my, ky, 't');
      const v = L('v');
      graph.push(`[${head || idx + ':v'}]${chain.join(',')}[${v}]`);
      return { v, ox, oy, ev: fx.moves.length ? 'frame' : 'init' };
    };
    // Слой на прозрачном холсте во весь кадр на время [s, e]
    const fullFrame = (Ly, s, e, c) => {
      const bg = L('fb'), out = L('ff');
      graph.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(e - s + 1)},format=rgba,setpts=PTS-STARTPTS+${num(s)}/TB[${bg}]`);
      graph.push(`[${bg}][${Ly.v}]overlay=x='${Ly.ox}':y='${Ly.oy}':eval=${Ly.ev}:format=rgb:eof_action=pass:enable='between(t,${num(c.start)},${num(clipEnd(c))})'[${out}]`);
      return out;
    };
    // Слой-маска (Track Matte): альфа клипа × альфа (или яркость) клипа-маски
    const matteLayer = async (c, Ly, mt) => {
      const s = c.start, e = clipEnd(c);
      const T = fullFrame(Ly, s, e, c);
      const mg = L('mtg');
      const m = mt.clip;
      const ML = m && !m.disabled ? await layerOf({ ...m, matte: null }, mt.track) : null;
      if (ML) {
        const M = fullFrame(ML, s, e, m);
        if (mt.mode === 'luma') graph.push(`[${M}]premultiply=inplace=1,format=gbrp,colorchannelmixer=rr=${LUMA_K[0]}:rg=${LUMA_K[1]}:rb=${LUMA_K[2]},extractplanes=r${mt.invert ? ',negate' : ''}[${mg}]`);
        else graph.push(`[${M}]alphaextract${mt.invert ? ',negate' : ''}[${mg}]`);
      } else {
        // клипа-маски нет — пусто (или всё видно при инверсии)
        graph.push(`color=c=${mt.invert ? 'white' : 'black'}:s=${W}x${H}:r=${fps}:d=${num(e - s + 1)},format=gray,setpts=PTS-STARTPTS+${num(s)}/TB[${mg}]`);
      }
      return { v: alphaMul(T, mg), ox: '0', oy: '0', ev: 'init' };
    };

    const hideM = matteSources();
    for (const item of visualOrder) {
      if (!withVideo) break;
      if (item.junction) {
        for (const j of junctionFx(item.junction)) vcur = await fxBranch(vcur, j.ops, j.S, j.E);
        continue;
      }
      const { c, tr } = item;
      const s = c.start, e = clipEnd(c), d = e - s;
      if (d <= 0.001) continue;
      if (c.kind === 'effect') { vcur = await fxBranch(vcur, effectOps(c), s, e); continue; }
      if (hideM.has(c.id)) continue;
      let Ly = await layerOf(c, tr);
      if (!Ly) continue;
      const mt = matteOf(c);
      if (mt) Ly = await matteLayer(c, Ly, mt);
      vcur = await place(vcur, Ly.v, Ly.ox, Ly.oy, Ly.ev, c, s, e);
    }

    // Аудио
    if (o.audio) {
      for (const tr of tracks) {
        if (tr.muted) continue;
        for (const c of tr.clips) {
          if (c.muted || c.disabled || !(c.kind === 'audio' || c.kind === 'video')) continue;
          const m = store.media(c.mediaId);
          if (!m || !m.hasAudio || (c.volume <= 0 && !(c.vkeys && c.vkeys.length))) continue;
          if (c.kind === 'video' && tr.hidden) { /* скрытая видеодорожка — звук остаётся */ }
          // голос или фон от нейросети, изменённый голос — берём готовый файл вместо исходного звука
          const st = VoiceFx.altAudio(c);
          let idx = st ? input(['-ss', num(c.in - st.a), '-t', num(c.out - c.in), '-i', st.path]) : inputOf[c.id];
          if (idx == null) idx = input(['-ss', num(c.in), '-t', num(c.out - c.in), '-i', m.path]);
          const chain = ['asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
          if (hasCurve(c)) {
            // кривая скорости: темп меняется на ходу (команды каждые 40 мс времени источника), высота звука сохраняется
            const L = c.out - c.in, cmds = [];
            for (let x = 0; x < L; x += 0.04) cmds.push(`${num(x)} rubberband@sp${c.id.replace(/\W/g, '')} tempo ${num(clamp(curveV(c.curve.pts, x / L), 0.01, 100))};`);
            const f = await window.api.writeTemp(`tempo_${c.id}.txt`, cmds.join('\n'));
            chain.push(`asendcmd=f=${ffq(f)}`, `rubberband@sp${c.id.replace(/\W/g, '')}=tempo=${num(c.curve.pts[0][1])}:pitchq=quality:transients=smooth`, `atrim=0:${num(clipDur(c))}`);
          } else {
            let sp = c.speed;
            while (sp > 2.0001) { chain.push('atempo=2'); sp /= 2; }
            while (sp < 0.4999) { chain.push('atempo=0.5'); sp /= 0.5; }
            if (Math.abs(sp - 1) > 1e-4) chain.push(`atempo=${num(sp)}`);
          }
          if (c.vkeys && c.vkeys.length) chain.push('asetnsamples=n=480:p=0', `volume='${kfExpr(c.vkeys, 'v', srcExpr(c, 't'))}':eval=frame`);
          else if (c.volume !== 1) chain.push(`volume=${num(c.volume)}`);
          for (const f of audioFades(c, tr)) chain.push(`afade=t=${f.dir}:st=${num(Math.max(0, f.from))}:d=${num(Math.max(0.001, f.dur))}`);
          chain.push(`adelay=${Math.round(c.start * 1000)}:all=1`);
          const dk = c.duck && c.duck.on ? Duck.expr(c) : null;
          if (dk) chain.push('asetnsamples=n=480:p=0', `volume='${dk}':eval=frame`);
          const a = L('a');
          graph.push(`[${idx}:a]${chain.join(',')}[${a}]`);
          audioLabels.push(`[${a}]`);
        }
      }
    }
    // только диапазон от входа до выхода — режем уже собранный поток (графу удобнее считать от нуля таймлайна)
    const R = o.range === 'io' ? Edit.range() : null;
    const A = R ? R.a : 0, B = R ? Math.min(R.b, total) : total;
    const aTrim = R ? `atrim=${num(A)}:${num(B)},asetpts=PTS-STARTPTS` : `atrim=0:${num(total)}`;
    const vTrim = R ? `trim=start=${num(A)}:end=${num(B)},setpts=PTS-STARTPTS` : `trim=0:${num(total)}`;
    if (o.audio) graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=first:dropout_transition=0,${aTrim}[aout]`);
    if (withVideo) graph.push(`[${vcur}]fps=${fps},format=yuv420p,${vTrim}[vout]`);

    const script = await window.api.writeTemp('graph.txt', graph.join(';\n'));
    args.push('-/filter_complex', script);
    if (withVideo) {
      const q = QUALITY.find(x => x.id === o.quality);
      args.push('-map', '[vout]');
      if (o.codec === 'hevc') args.push('-c:v', 'libx265', '-preset', q.preset, '-crf', String(q.crf + 4), '-tag:v', 'hvc1', '-x265-params', 'log-level=error');
      else args.push('-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-profile:v', 'high');
      args.push('-pix_fmt', 'yuv420p', '-r', String(fps));
      if (o.audio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
      args.push('-movflags', '+faststart');
    } else {
      args.push('-map', '[aout]');
      if (o.audioFormat === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '192k');
      else if (o.audioFormat === 'flac') args.push('-c:a', 'flac');
      else args.push('-c:a', 'pcm_s16le');
    }
    args.push('-t', num(B - A), outPath);
    return { args, total: B - A };
  },

  async textPng(c, W, H, k) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    drawText(ctx, { ...c, blend: null }, store.p.width, store.p.height, k, { alpha: 1, dx: 0, dy: 0 });
    return window.api.writeTemp('text_' + c.id + '.png', cv.toDataURL('image/png'));
  },

  // ---------------------------------------------------------------- запуск
  async run(o, name, cover) {
    const ext = o.video ? o.format : o.audioFormat;
    let out = `${o.folder}/${name}.${ext}`;
    for (let i = 1; await window.api.exists(out); i++) out = `${o.folder}/${name} (${i}).${ext}`;
    const body = h(`<div class="exporting">
      <div class="exp-cover">${cover ? `<img src="${cover}">` : ''}<div class="exp-pct">0%</div></div>
      <div class="exp-bar"><i></i></div>
      <div class="exp-status">Подготовка…</div>
    </div>`);
    let canceled = false;
    const dlg = modal({ title: 'Экспорт', body, width: 440, cls: 'exporting-modal', buttons: [
      { label: 'Отмена', keep: true, onClick: () => { canceled = true; window.api.cancelExport(); return false; } },
    ] });
    const t0 = performance.now();
    window.api.onExportProgress((v) => {
      $('.exp-bar i', body).style.width = (v * 100).toFixed(1) + '%';
      $('.exp-pct', body).textContent = Math.floor(v * 100) + '%';
      const el = (performance.now() - t0) / 1000;
      const left = v > 0.02 ? el / v - el : null;
      $('.exp-status', body).textContent = 'Экспорт… ' + (left != null ? 'осталось ≈ ' + fmtDur(left) : '');
    });
    let res;
    try {
      const { args, total } = await this.build(o, out, (t) => { $('.exp-status', body).textContent = t; });
      $('.exp-status', body).textContent = 'Экспорт…';
      res = await window.api.runExport(args, total);
    } catch (e) {
      res = { ok: false, log: String(e && e.stack || e) };
    }
    window.api.onExportProgress(() => { });
    dlg.close();
    if (res.ok) {
      const took = (performance.now() - t0) / 1000;
      const done = h(`<div class="export-done">
        <div class="ed-ic">${icon('check')}</div>
        <b>Экспорт завершён</b>
        <span class="muted">${esc(out.split('/').pop())} · ${fmtDur(took)}</span>
      </div>`);
      modal({ title: '', body: done, width: 420, cls: 'done-modal', buttons: [
        { label: 'Открыть папку', onClick: () => { window.api.showItem(out); } },
        { label: 'Воспроизвести', primary: true, onClick: () => { window.api.openPath(out); } },
      ] });
    } else if (canceled || res.canceled) {
      toast('Экспорт отменён');
    } else {
      console.error(res.log);
      const pre = h(`<div><p>Не удалось выполнить экспорт. Журнал ffmpeg:</p><pre class="log"></pre></div>`);
      $('pre', pre).textContent = res.log || '';
      modal({ title: 'Ошибка экспорта', body: pre, width: 640, buttons: [{ label: 'Закрыть', primary: true }] });
    }
  },
};

// ---------------------------------------------------------------- операции эффектов → фильтры ffmpeg
// Каждая функция получает метку входа и возвращает метку выхода (все кадры в gbrp).
let fxOpSeq = 0;
function pgm16(w, h, fn) {
  const head = new TextEncoder().encode(`P5\n${w} ${h}\n65535\n`);
  const out = new Uint8Array(head.length + w * h * 2);
  out.set(head);
  let o = head.length;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y);
    out[o++] = (v >> 8) & 255; out[o++] = v & 255;
  }
  return out;
}
const FXEXP = {
  // слой клипа в режиме наложения: кладём его на прозрачный кадр, смешиваем с кадром под ним
  // и подмешиваем результат по альфе слоя — как canvas: (1 − α)·низ + α·B(низ, слой)
  blendLayer(op, inL, X) {
    // прозрачная подложка — из самого нижнего кадра (те же метки времени: иначе maskedmerge вставляет лишние кадры)
    const tb = X.L('bt'), f1 = X.L('bf'), f2 = X.L('bf'), rgb = X.L('br'), b1 = X.L('bb'), b2 = X.L('bb'), b3 = X.L('bb'), bl = X.L('bl'), ma = X.L('bm'), out = X.L('fx');
    X.graph.push(`[${inL}]split=3[${b1}][${b2}][${b3}]`);
    X.graph.push(`[${b3}]format=rgba,colorchannelmixer=rr=0:gg=0:bb=0:aa=0[${tb}]`);
    X.graph.push(`[${tb}][${op.layer}]overlay=x='${op.x}':y='${op.y}':eval=${op.eval}:format=auto:eof_action=pass,format=rgba,split[${f1}][${f2}]`);
    X.graph.push(`[${f1}]format=gbrp[${rgb}]`);
    X.graph.push(`[${b1}][${rgb}]blend=all_mode=${op.mode}:shortest=1[${bl}]`);
    X.graph.push(`[${f2}]alphaextract,format=gbrp[${ma}]`);
    X.graph.push(`[${b2}][${bl}][${ma}]maskedmerge[${out}]`);
    return out;
  },
  camera(op, inL, X) {
    const { W, H } = X, ar = Math.max(W / H, H / W);
    const R = `(${fxFF(op.r ?? 0, X.Tin)})`, Z0 = `(${fxFF(op.z ?? 1, X.Tin)})`;
    const XX = `(${fxFF(op.x ?? 0, X.Tin)})`, YY = `(${fxFF(op.y ?? 0, X.Tin)})`;
    const Z = op.cover ? `(${Z0}*(abs(cos(${R}))+${num(ar)}*abs(sin(${R}))))` : Z0;
    const c = [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]].map(([du, dv], i) =>
      `x${i}='${num(W / 2)}+((${du})*cos(${R})-(${dv})*sin(${R}))/${Z}+${XX}*${W}':y${i}='${num(H / 2)}+((${du})*sin(${R})+(${dv})*cos(${R}))/${Z}+${YY}*${H}'`).join(':');
    const dyn = ['r', 'z', 'x', 'y'].some(k => !isStatic(op[k]));
    const out = X.L('fx');
    X.graph.push(`[${inL}]perspective=${c}:interpolation=linear:eval=${dyn ? 'frame' : 'init'}[${out}]`);
    return out;
  },
  levels(op, inL, X) {
    const name = `colorlevels@l${X.id}_${++fxOpSeq}`, parts = [];
    for (const ch of ['r', 'g', 'b']) for (const i of ['0', '1']) {
      const expr = op[ch + i] ?? op['o' + i];
      const opt = `${ch}o${i === '0' ? 'min' : 'max'}`;
      parts.push(`${opt}=${X.val(name, opt, expr, { def: i === '0' ? 0 : 1 })}`);
    }
    const out = X.L('fx');
    X.graph.push(`[${inL}]${name}=${parts.join(':')}[${out}]`);
    return out;
  },
  mix(op, inL, X) {
    const name = `colorchannelmixer@m${X.id}_${++fxOpSeq}`;
    const keys = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
    const parts = keys.map((k, i) => `${k}=${X.val(name, k, op.m[i])}`);
    const out = X.L('fx');
    X.graph.push(`[${inL}]${name}=${parts.join(':')}[${out}]`);
    return out;
  },
  async lut(op, inL, X) {
    const f = await window.api.writeTemp(`fxlut_${X.id}_${++fxOpSeq}.cube`, cubeLUT(op.M));
    const out = X.L('fx');
    X.graph.push(`[${inL}]lut3d=file=${ffq(f)}:interp=tetrahedral[${out}]`);
    return out;
  },
  blur(op, inL, X) {
    const name = `gblur@b${X.id}_${++fxOpSeq}`;
    const s = X.val(name, 'sigma', op.s, { mul: X.u, min: 0 });
    const out = X.L('fx');
    X.graph.push(`[${inL}]${name}=sigma=${s}:sigmaV=${op.dir === 'h' ? 0 : -1}[${out}]`);
    return out;
  },
  rgb(op, inL, X) {
    const name = `rgbashift@r${X.id}_${++fxOpSeq}`;
    const parts = ['rh', 'rv', 'gh', 'gv', 'bh', 'bv'].map(k => `${k}=${X.val(name, k, op[k] ?? 0, { mul: X.u, round: true })}`);
    const out = X.L('fx');
    X.graph.push(`[${inL}]${name}=${parts.join(':')}:edge=smear[${out}]`);
    return out;
  },
  noise(op, inL, X) {
    const out = X.L('fx');
    X.graph.push(`[${inL}]noise=alls=${Math.round(clamp(fxVal(op.s, 0), 0, 100))}:allf=t+u[${out}]`);
    return out;
  },
  pixel(op, inL, X) {
    const name = `pixelize@p${X.id}_${++fxOpSeq}`;
    const w = X.val(name, 'w', op.b, { mul: X.u, floor: true, min: 1 });
    if (!isStatic(op.b)) X.val(name, 'h', op.b, { mul: X.u, floor: true, min: 1 });
    const out = X.L('fx');
    X.graph.push(`[${inL}]${name}=w=${w}:h=${w}[${out}]`);
    return out;
  },
  glow(op, inL, X) {
    const a = X.L('ga'), g = X.L('gg'), gb = X.L('gb'), out = X.L('fx');
    const bn = `gblur@gb${X.id}_${++fxOpSeq}`, ln = `blend@gl${X.id}_${fxOpSeq}`;
    X.graph.push(`[${inL}]split[${a}][${g}]`);
    X.graph.push(`[${g}]${bn}=sigma=${X.val(bn, 'sigma', op.s, { mul: X.u, min: 0 })}[${gb}]`);
    X.graph.push(`[${a}][${gb}]${ln}=shortest=1:all_mode=screen:all_opacity=${X.val(ln, 'all_opacity', op.o, { def: 0.5 })}[${out}]`);
    return out;
  },
  async texture(op, inL, X) {
    const { W, H } = X, mw = op.mw || 1, mh = op.mh || 1;
    const c = document.createElement('canvas');
    c.width = Math.round(W * mw); c.height = Math.round(H * mh);
    TEXTURES[op.gen](c.getContext('2d'), c.width, c.height);
    const f = await window.api.writeTemp(`tex_${X.id}_${++fxOpSeq}.png`, c.toDataURL('image/png'));
    const ti = X.input(['-loop', '1', '-framerate', String(X.fps), '-t', num(X.D + 1), '-i', f]);
    const tx = X.L('tx'), out = X.L('fx');
    const sx = `clip((${fxFF(op.sx ?? 0, X.Tt)})*${W},0,${c.width - W})`, sy = `clip((${fxFF(op.sy ?? 0, X.Tt)})*${H},0,${c.height - H})`;
    if (op.mode === 'normal') {
      X.graph.push(`[${ti}:v]setpts=PTS-STARTPTS+${num(X.S)}/TB,crop=${W}:${H}:x='${sx}':y='${sy}',format=rgba,colorchannelmixer=aa=${num(fxVal(op.o ?? 1, 0))}[${tx}]`);
      X.graph.push(`[${inL}][${tx}]overlay=format=gbrp:eof_action=pass[${out}]`);
    } else {
      const ln = `blend@t${X.id}_${fxOpSeq}`;
      X.graph.push(`[${ti}:v]setpts=PTS-STARTPTS+${num(X.S)}/TB,crop=${W}:${H}:x='${sx}':y='${sy}',format=gbrp[${tx}]`);
      X.graph.push(`[${inL}][${tx}]${ln}=shortest=1:all_mode=${op.mode}:all_opacity=${X.val(ln, 'all_opacity', op.o, { def: 1 })}[${out}]`);
    }
    return out;
  },
  layout(op, inL, X) {
    const { W, H } = X, g = X.graph, out = X.L('fx');
    const k = op.kind;
    if (k === 'mirrorH' || k === 'mirrorV') {
      const a = X.L('la'), b = X.L('lb'), l = X.L('ll'), r = X.L('lr');
      g.push(`[${inL}]split[${a}][${b}]`);
      if (k === 'mirrorH') {
        const hw = Math.floor(W / 2);
        g.push(`[${a}]crop=${hw}:${H}:0:0[${l}]`, `[${b}]crop=${hw}:${H}:0:0,hflip[${r}]`, `[${l}][${r}]hstack,pad=${W}:${H}:0:0[${out}]`);
      } else {
        const hh = Math.floor(H / 2);
        g.push(`[${a}]crop=${W}:${hh}:0:0[${l}]`, `[${b}]crop=${W}:${hh}:0:0,vflip[${r}]`, `[${l}][${r}]vstack,pad=${W}:${H}:0:0[${out}]`);
      }
    } else if (k === 'grid2' || k === 'grid3') {
      const n = k === 'grid2' ? 2 : 3, tw = Math.ceil(W / n), th = Math.ceil(H / n);
      const labs = Array.from({ length: n * n }, () => X.L('lg'));
      g.push(`[${inL}]scale=${tw}:${th},split=${n * n}${labs.map(l => `[${l}]`).join('')}`);
      const lay = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) lay.push(`${i * tw}_${j * th}`);
      // порядок меток: столбцы внутри строк
      g.push(`${labs.map(l => `[${l}]`).join('')}xstack=inputs=${n * n}:layout=${lay.join('|')},crop=${W}:${H}:0:0[${out}]`);
    } else if (k === 'triple') {
      const sw = Math.floor(W / 3), x0 = Math.floor((W - sw) / 2);
      const a = X.L('lt'), b = X.L('lt'), c = X.L('lt');
      g.push(`[${inL}]crop=${sw}:${H}:${x0}:0,split=3[${a}][${b}][${c}]`, `[${a}][${b}][${c}]hstack=3,pad=${W}:${H}:0:0[${out}]`);
    }
    return out;
  },
  trail(op, inL, X) {
    const out = X.L('fx');
    X.graph.push(`[${inL}]lagfun=decay=${num(fxVal(op.d, 0))}[${out}]`);
    return out;
  },
  async warp(op, inL, X) {
    if (op.n) return FXEXP.warpAnim(op, inL, X);
    const { W, H } = X;
    const f = WARPS[op.name](op.k), ar = W / H;
    const cx = new Float64Array(W * H), cy = new Float64Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = f((x + 0.5) / W, (y + 0.5) / H, ar);
      cx[y * W + x] = r ? Math.floor(r[0] * W) : -1; cy[y * W + x] = r ? Math.floor(r[1] * H) : -1;
    }
    const bad = (i) => cx[i] < 0 || cy[i] < 0 || cx[i] >= W || cy[i] >= H;
    const xm = pgm16(W, H, (x, y) => { const i = y * W + x; return bad(i) ? 65535 : cx[i]; });
    const ym = pgm16(W, H, (x, y) => { const i = y * W + x; return bad(i) ? 65535 : cy[i]; });
    const n = ++fxOpSeq;
    const fx = await window.api.writeTemp(`xmap_${X.id}_${n}.pgm`, xm), fy = await window.api.writeTemp(`ymap_${X.id}_${n}.pgm`, ym);
    const xi = X.input(['-loop', '1', '-framerate', String(X.fps), '-t', num(X.D + 1), '-i', fx]);
    const yi = X.input(['-loop', '1', '-framerate', String(X.fps), '-t', num(X.D + 1), '-i', fy]);
    const a = X.L('xm'), b = X.L('ym'), out = X.L('fx');
    X.graph.push(`[${xi}:v]setpts=PTS-STARTPTS+${num(X.S)}/TB,format=gray16[${a}]`, `[${yi}:v]setpts=PTS-STARTPTS+${num(X.S)}/TB,format=gray16[${b}]`);
    X.graph.push(`[${inL}][${a}][${b}]remap=fill=black[${out}]`);
    return out;
  },
  // анимированное искажение: n пар карт, кадр карты на каждый кадр видео — по списку (concat)
  async warpAnim(op, inL, X) {
    const { W, H } = X, ar = W / H, seq = ++fxOpSeq;
    const files = {};
    const mapsOf = async (fr) => {
      if (files[fr]) return files[fr];
      const f = WARPS[op.name](op.k, fr / op.n);
      const cx = new Int32Array(W * H), cy = new Int32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const r = f((x + 0.5) / W, (y + 0.5) / H, ar), i = y * W + x;
        cx[i] = r ? Math.floor(r[0] * W) : -1; cy[i] = r ? Math.floor(r[1] * H) : -1;
      }
      const bad = (i) => cx[i] < 0 || cy[i] < 0 || cx[i] >= W || cy[i] >= H;
      const xm = pgm16(W, H, (x, y) => { const i = y * W + x; return bad(i) ? 65535 : cx[i]; });
      const ym = pgm16(W, H, (x, y) => { const i = y * W + x; return bad(i) ? 65535 : cy[i]; });
      return (files[fr] = [await window.api.writeTemp(`wx_${X.id}_${seq}_${fr}.pgm`, xm), await window.api.writeTemp(`wy_${X.id}_${seq}_${fr}.pgm`, ym)]);
    };
    const xi = await frameListInput(X, async (T) => (await mapsOf(warpFrame(op, T)))[0], `wx_${X.id}_${seq}`);
    const yi = await frameListInput(X, async (T) => (await mapsOf(warpFrame(op, T)))[1], `wy_${X.id}_${seq}`);
    const a = X.L('xm'), b = X.L('ym'), out = X.L('fx');
    X.graph.push(`[${xi}:v]${frameListChain(X)},format=gray16[${a}]`, `[${yi}:v]${frameListChain(X)},format=gray16[${b}]`);
    X.graph.push(`[${inL}][${a}][${b}]remap=fill=black[${out}]`);
    return out;
  },
  // локальный контраст: A + (A − размытое)·k
  hdr(op, inL, X) {
    const a = X.L('ha'), b = X.L('hb'), bb = X.L('hc'), out = X.L('fx');
    X.graph.push(`[${inL}]split[${a}][${b}]`);
    X.graph.push(`[${b}]gblur=sigma=${num(Math.max(0.5, fxVal(op.s, 0, 20) * X.u))}:steps=${GBLUR_STEPS}[${bb}]`);
    X.graph.push(`[${a}][${bb}]blend=all_expr='clip(A+(A-B)*${num(fxVal(op.k, 0, 1))},0,255)'[${out}]`);
    return out;
  },
  // светящиеся контуры (как в превью: серое 1/3 → собель → цвет; картинка·base + резкие + размытые)
  edges(op, inL, X) {
    const q = num(GRAY_K), g = X.graph;
    const mix = (k) => `colorchannelmixer=rr=${num(k[0])}:rg=0:rb=0:gr=0:gg=${num(k[1])}:gb=0:br=0:bg=0:bb=${num(k[2])}`;
    const kb = op.base ?? 1;
    const a = X.L('ea'), b = X.L('eb'), base = X.L('ec'), e1 = X.L('ed'), e2 = X.L('ee'), sh = X.L('ef'), gl = X.L('eg'), t = X.L('eh'), out = X.L('fx');
    g.push(`[${inL}]split[${a}][${b}]`);
    g.push(`[${a}]${mix([kb, kb, kb])}[${base}]`);
    const pre = op.pre ? `,gblur=sigma=${num(Math.max(0.5, op.pre * X.u))}:steps=${GBLUR_STEPS}` : '', dl = num(op.cut || 0);
    g.push(`[${b}]colorchannelmixer=rr=${q}:rg=${q}:rb=${q}:gr=${q}:gg=${q}:gb=${q}:br=${q}:bg=${q}:bb=${q}${pre},split[${e1}][${e2}]`);
    g.push(`[${e1}]sobel=scale=${num(n4(op.sharp))}:delta=${dl},${mix(op.c)}[${sh}]`);
    g.push(`[${e2}]sobel=scale=${num(n4(op.glow))}:delta=${dl},${mix(op.c)},gblur=sigma=${num(Math.max(0.5, fxVal(op.s, 0, 8) * X.u))}:steps=${GBLUR_STEPS}[${gl}]`);
    g.push(`[${base}][${sh}]blend=all_mode=addition[${t}]`, `[${t}][${gl}]blend=all_mode=addition[${out}]`);
    return out;
  },
  // среднее копий с разной «камерой»
  accum(op, inL, X) {
    const n = op.copies.length, labs = op.copies.map(() => X.L('ac'));
    X.graph.push(`[${inL}]split=${n}${labs.map(l => `[${l}]`).join('')}`);
    const outs = op.copies.map((cam, i) => FXEXP.camera(cam, labs[i], X));
    const out = X.L('fx');
    X.graph.push(`${outs.map(l => `[${l}]`).join('')}mix=inputs=${n}:weights='${outs.map(() => 1).join(' ')}'[${out}]`);
    return out;
  },
  // последовательность кадров поверх: процедурные (PNG из canvas) или готовые из Blender (fx/<набор>/)
  async seq(op, inL, X) {
    const { W, H } = X, src = op.src, app = (await window.api.paths()).app;
    const files = {};
    const fileOf = async (i) => {
      if (files[i]) return files[i];
      if (!src.gen) return (files[i] = i < 0 ? `${app}/fx/${src.dir}/blank.${src.ext || 'webp'}` : `${app}/${seqPath(src, i)}`);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d');
      if (i >= 0) SEQGEN[src.gen](x, W, H, i);
      else if (op.mode !== 'normal') { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); }
      return (files[i] = await window.api.writeTemp(`seq_${src.gen}_${op.mode}_${i}_${W}x${H}.png`, c.toDataURL('image/png')));
    };
    const n = src.n;
    const si = await frameListInput(X, (T) => fileOf(Math.min(n - 1, Math.max(-1, seqIndex(op, T)))), `seq_${X.id}_${++fxOpSeq}`);
    const o = fxVal(op.o ?? 1, 0), sl = X.L('sq'), out = X.L('fx');
    const fit = src.gen ? '' : `,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    if (op.mode === 'normal') {
      X.graph.push(`[${si}:v]${frameListChain(X)}${fit},format=rgba${o < 1 ? `,colorchannelmixer=aa=${num(o)}` : ''}[${sl}]`);
      X.graph.push(`[${inL}][${sl}]overlay=format=gbrp:eof_action=pass[${out}]`);
    } else {
      X.graph.push(`[${si}:v]${frameListChain(X)}${fit},format=gbrp[${sl}]`);
      X.graph.push(`[${inL}][${sl}]blend=all_mode=${op.mode === 'add' ? 'addition' : 'screen'}:all_opacity=${num(o)}[${out}]`);
    }
    return out;
  },
};
const GBLUR_STEPS = 4;
// Вход «картинка на каждый кадр видео»: для каждого кадра окна эффекта — пронумерованная ссылка на нужный файл,
// читается как последовательность с частотой проекта (concat с картинками округляет время до 1/25 с — кадры уезжали).
// pick(T) → путь к файлу, T — локальное время эффекта.
async function frameListInput(X, pick, name) {
  const cnt = Math.ceil((X.E - X.first) * X.fps - 1e-6) + 2, files = [];
  for (let j = 0; j < cnt; j++) files.push(await pick(X.first - X.S + j / X.fps));
  const pattern = await window.api.linkSeq(name, files);
  return X.input(['-framerate', String(X.fps), '-start_number', '0', '-i', pattern]);
}
const frameListChain = (X) => `setpts=PTS-STARTPTS+${num(X.first)}/TB`;
