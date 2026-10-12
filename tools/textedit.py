#!/usr/bin/env python3
"""Замена текста на картинке и в видео для LinCut.

textedit.py analyze --image IMG | --video VIDEO --t T  --models DIR --out OUT.json [--frame-out PNG]
    Находит строки текста (EasyOCR, русский + английский), для каждой — текст, цвет, размер и самый похожий
    шрифт из установленных в системе (рендер строки каждым шрифтом и сравнение с кадром).
textedit.py erase --image IMG --blocks BLOCKS.json --models DIR --out OUT.png
    Стирает выбранные строки (LaMa дорисовывает фон; без модели — OpenCV inpaint).
textedit.py fetch --models DIR — загрузить модели EasyOCR (при установке)
textedit.py video VIDEO --a A --b B --t0 T0 --fps F --blocks BLOCKS.json --models DIR --out OUT.mp4 --track OUT.json
    То же на каждом кадре куска [A, B]: строка ищется на каждом кадре по маске букв, маска стирания едет за ней.
    Пишет видео без звука (кадры ровно с шагом 1/F от A) и траекторию в формате track.py — по ней новый текст
    в LinCut едет за местом старого.
Прогресс — строки «PROGRESS 0.42» в stdout.
"""
import argparse, json, math, os, subprocess, sys

import numpy as np
import cv2


LAMA = 'big-lama.pt'
JUNK = ('Nerd Font', 'Symbols', 'Emoji', 'icomoon', 'FontAwesome', 'Material', 'Misc', 'cursor', 'Fangsong', 'OpenSymbol', 'Dingbat', 'Webdings', 'Wingdings')
STYLES = {'regular': (False, False), 'book': (False, False), 'normal': (False, False), 'roman': (False, False), 'medium': None,
          'bold': (True, False), 'italic': (False, True), 'oblique': (False, True), 'bold italic': (True, True), 'bold oblique': (True, True)}


def progress(p):
    print(f'PROGRESS {max(0.0, min(1.0, p)):.4f}', flush=True)


def device():
    try:
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    except Exception:
        return 'cpu'


# ---------------------------------------------------------------- распознавание
def ocr(img, models):
    import easyocr
    d = os.path.join(models, 'easyocr')
    os.makedirs(d, exist_ok=True)
    rd = easyocr.Reader(['ru', 'en'], gpu=device() == 'cuda', model_storage_directory=d, user_network_directory=d, verbose=False)
    out = []
    for quad, text, conf in rd.readtext(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), width_ths=0.6, decoder='greedy'):
        text = text.strip()
        if text and conf > 0.15:
            out.append((np.array(quad, dtype=np.float32), text, float(conf)))
    return out


def straighten(img, quad, grow):
    """Строка текста в прямоугольник: квадрат EasyOCR (лв, пв, пн, лн) расширяется и разворачивается.
    Возвращает кадр строки, матрицу, угол и прямоугольник самой строки (без запаса) внутри кадра строки."""
    tl, tr, br, bl = quad
    w = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2
    h = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2
    ux = (tr - tl) / max(1e-6, np.linalg.norm(tr - tl))
    uy = np.array([-ux[1], ux[0]], dtype=np.float32)
    c = quad.mean(axis=0)
    mx, my = h * grow, h / 2 * grow
    gw, gh = w / 2 + mx, h / 2 + my
    src = np.array([c - ux * gw - uy * gh, c + ux * gw - uy * gh, c + ux * gw + uy * gh, c - ux * gw + uy * gh], dtype=np.float32)
    W, H = max(4, int(round(2 * gw))), max(4, int(round(2 * gh)))
    dst = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    crop = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return crop, M, math.degrees(math.atan2(ux[1], ux[0])), (int(mx), int(my), int(round(W - mx)), int(round(H - my)))


def text_mask(crop, inner):
    """Пиксели букв. Буквы обычно одного цвета: ищем цвет (k-средние в Lab), который есть внутри строки
    и почти не встречается в запасе вокруг неё, затем берём все пиксели, близкие к нему по цвету."""
    H, W = crop.shape[:2]
    x0, y0, x1, y1 = inner
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    inside = np.zeros((H, W), bool)
    inside[y0:y1, x0:x1] = True
    ring = ~inside
    ins, rin = inside.reshape(-1), ring.reshape(-1)
    best, bs = None, -1e9
    for k in (2, 3, 4, 5):
        _, lbl, cen = cv2.kmeans(lab, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 0.5), 2, cv2.KMEANS_PP_CENTERS)
        lbl = lbl.reshape(-1)
        for j in range(k):
            m = lbl == j
            fi = m[ins].mean()
            fr = m[rin].mean() if rin.any() else 0
            if not 0.03 < fi < 0.75:
                continue
            sc = fi - 2.5 * fr - 0.01 * k
            if sc > bs:
                bs, best = sc, cen[j]
    if best is None:   # запасной путь — Оцу по яркости
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if (b[ring] > 0).mean() > 0.5:
            b = 255 - b
        return (b > 0) & inside
    d = np.linalg.norm(lab - best, axis=1).reshape(H, W)
    near = d < max(14.0, np.percentile(d[inside], 8) * 2.2)
    # только внутри строки (с небольшим запасом на выносные элементы)
    lim = np.zeros((H, W), bool)
    py, px = max(1, (y1 - y0) // 8), max(1, (y1 - y0) // 8)
    lim[max(0, y0 - py):y1 + py, max(0, x0 - px):x1 + px] = True
    m = (near & lim).astype(np.uint8)
    # отдельные крошки фона того же цвета — прочь
    n, lab_cc, st, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros(n, bool)
    minA = max(3, (y1 - y0) ** 2 // 400)
    for i in range(1, n):
        keep[i] = st[i, cv2.CC_STAT_AREA] >= minA
    return keep[lab_cc]


# ---------------------------------------------------------------- шрифты системы
def font_dirs():
    if os.name == 'nt':
        return [os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts'), os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'Windows', 'Fonts')]
    h = os.path.expanduser('~')
    return ['/usr/share/fonts', '/usr/local/share/fonts', os.path.join(h, '.local/share/fonts'), os.path.join(h, '.fonts')]


def font_list(models):
    """[{file, index, family, bold, italic, cyr, lat}] — только начертания, которые LinCut умеет выбрать
    (обычное/жирное × курсив). Кэш по времени изменения папок шрифтов."""
    dirs = [d for d in font_dirs() if os.path.isdir(d)]
    files = []
    for d in dirs:
        for root, _, names in os.walk(d):
            for n in names:
                if n.lower().endswith(('.ttf', '.otf', '.ttc')):
                    files.append(os.path.join(root, n))
    stamp = f'{len(files)}:{max([os.path.getmtime(f) for f in files] or [0]):.0f}'
    cache = os.path.join(models, 'textedit-fonts.json')
    try:
        c = json.load(open(cache, encoding='utf-8'))
        if c.get('stamp') == stamp:
            return c['fonts']
    except Exception:
        pass
    from fontTools.ttLib import TTFont, TTCollection
    out = []
    for f in files:
        try:
            fonts = TTCollection(f, lazy=True).fonts if f.lower().endswith('.ttc') else [TTFont(f, lazy=True)]
        except Exception:
            continue
        for idx, ft in enumerate(fonts):
            try:
                nm = ft['name']
                fam = nm.getDebugName(1) or ''
                sub = (nm.getDebugName(2) or '').lower()
                if nm.getDebugName(16):   # типографское семейство: «Roboto» + «Medium» → не наше начертание
                    fam, sub = nm.getDebugName(16), (nm.getDebugName(17) or sub).lower()
                st = STYLES.get(sub)
                if not fam or st is None or any(j.lower() in fam.lower() for j in JUNK):
                    continue
                cmap = ft.getBestCmap() or {}
                cyr = all(cp in cmap for cp in range(0x430, 0x450))
                lat = all(cp in cmap for cp in range(0x61, 0x7B))
                if not (cyr or lat):
                    continue
                out.append({'file': f, 'index': idx, 'family': fam, 'bold': st[0], 'italic': st[1], 'cyr': cyr, 'lat': lat})
            except Exception:
                continue
    try:
        json.dump({'stamp': stamp, 'fonts': out}, open(cache, 'w', encoding='utf-8'))
    except Exception:
        pass
    return out


def render(font, text, size=64):
    """Строка шрифтом: маска чернил (обрезанная) и метрики относительно точки привязки 'lm' (как textBaseline middle)."""
    from PIL import Image, ImageDraw, ImageFont
    f = ImageFont.truetype(font['file'], size, index=font['index'])
    l, t, r, b = f.getbbox(text, anchor='lm')
    if r - l < 1 or b - t < 1:
        return None
    im = Image.new('L', (int(r - l) + 4, int(b - t) + 4), 0)
    ImageDraw.Draw(im).text((2 - l, 2 - t), text, font=f, fill=255, anchor='lm')
    a = np.array(im) > 96
    ys, xs = np.nonzero(a)
    if len(xs) < 3:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    adv = f.getlength(text)
    # центр чернил относительно центра строки, какой рисует холст LinCut (x — середина ширины, y — middle)
    icx = (x0 + x1) / 2 - 2 + l - adv / 2
    icy = (y0 + y1) / 2 - 2 + t
    return a[y0:y1, x0:x1], (x1 - x0), (y1 - y0), adv, icx, icy


def match_font(fonts, text, ink):
    """Шрифт, которым строка выглядит так же: IoU масок, приведённых к одному размеру, со штрафом за пропорции."""
    has_cyr = any('\u0400' <= ch <= '\u04ff' for ch in text)
    has_lat = any('a' <= ch.lower() <= 'z' for ch in text)
    th, tw = ink.shape
    tar = tw / max(1, th)
    tgt = cv2.resize(ink.astype(np.uint8), (min(tw, 400), min(th, 100)) if tw > 400 or th > 100 else (tw, th), interpolation=cv2.INTER_AREA) > 0
    seen, scored = set(), []
    for f in fonts:
        if (has_cyr and not f['cyr']) or (has_lat and not f['lat']):
            continue
        key = (f['family'], f['bold'], f['italic'])
        if key in seen:
            continue
        seen.add(key)
        try:
            r = render(f, text)
        except Exception:
            continue
        if r is None:
            continue
        m, w, h = r[0], r[1], r[2]
        cand = cv2.resize(m.astype(np.uint8), (tgt.shape[1], tgt.shape[0]), interpolation=cv2.INTER_AREA) > 0
        inter = np.logical_and(cand, tgt).sum()
        uni = np.logical_or(cand, tgt).sum()
        iou = inter / max(1, uni)
        ar = (w / max(1, h)) / max(1e-6, tar)
        # курсив встречается реже — при почти равном сходстве берём прямое начертание
        scored.append((iou * math.exp(-abs(math.log(ar)) * 1.5) * (0.9 if f['italic'] else 1.0), f))
    scored.sort(key=lambda x: -x[0])
    return scored


def analyze_block(img, quad, text, fonts):
    crop, M, angle, inner = straighten(img, quad, 0.3)
    mask = text_mask(crop, inner)
    ys, xs = np.nonzero(mask)
    if len(xs) < 6:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    ink = mask[y0:y1, x0:x1]
    # цвет: середина букв (без сглаженных краёв)
    core = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    px = crop[core] if core.sum() > 20 else crop[mask]
    bgr = np.median(px, axis=0)
    color = '#%02x%02x%02x' % (int(bgr[2]), int(bgr[1]), int(bgr[0]))
    # EasyOCR путает регистр («ПОдпишись») — сравниваем и варианты регистра, лучший заодно и подсказка текста
    best = None
    for v in dict.fromkeys([text, text.upper(), text.lower(), text[:1].upper() + text[1:].lower()]):
        sc = match_font(fonts, v, ink)
        if sc and (best is None or sc[0][0] > best[1][0][0] + 0.02):
            best = (v, sc)
    text, scored = best if best else (text, [])
    font = scored[0][1] if scored else None
    size, spacing, cx, cy = (y1 - y0) * 1.4, 0.0, (x0 + x1) / 2, (y0 + y1) / 2
    if font:
        r = render(font, text)
        if r:
            _, w64, h64, adv64, icx, icy = r
            size = 64 * (y1 - y0) / max(1, h64)
            k = size / 64
            n = len(text)
            if n > 1:
                spacing = max(-0.25 * size, min(0.4 * size, ((x1 - x0) - w64 * k) / (n - 1)))
            # центр строки LinCut = центр чернил − смещение чернил от центра строки
            cx = (x0 + x1) / 2 - icx * k
            cy = (y0 + y1) / 2 - icy * k
    # из выпрямленной строки обратно в кадр
    Mi = np.linalg.inv(M)
    p = Mi @ np.array([cx, cy, 1.0])
    p = p[:2] / p[2]
    return {
        'text': text, 'color': color, 'size': round(float(size), 2), 'spacing': round(float(spacing), 2), 'angle': round(float(angle), 2),
        'cx': round(float(p[0]), 2), 'cy': round(float(p[1]), 2),
        'font': {'family': font['family'], 'bold': font['bold'], 'italic': font['italic']} if font else None,
        'alts': [{'family': f['family'], 'bold': f['bold'], 'italic': f['italic'], 'score': round(float(s), 3)} for s, f in scored[:6]],
    }


def erase_mask(img, quads, grow=0.14):
    """Маска стирания в координатах кадра: буквы строк, расширенные на ~15% высоты строки (сглаживание, тени)."""
    H, W = img.shape[:2]
    out = np.zeros((H, W), np.uint8)
    for q in quads:
        q = np.array(q, dtype=np.float32)
        crop, M, _, inner = straighten(img, q, 0.3)
        m = text_mask(crop, inner).astype(np.uint8) * 255
        hh = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
        r = max(2, int(round(hh * grow))) if grow > 0 else 0
        if r: m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
        back = cv2.warpPerspective(m, np.linalg.inv(M), (W, H), flags=cv2.INTER_LINEAR)
        out = np.maximum(out, back)
    return (out > 64).astype(np.uint8) * 255


# ---------------------------------------------------------------- стирание
class Inpainter:
    def __init__(self, models):
        self.net = None
        path = os.path.join(models, LAMA)
        if os.path.exists(path):
            try:
                import torch
                self.torch = torch
                self.dev = device()
                self.net = torch.jit.load(path, map_location=self.dev).eval()
            except Exception as e:
                print(f'LaMa failed: {e}', file=sys.stderr, flush=True)

    def __call__(self, img, mask):
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            return img
        H, W = img.shape[:2]
        bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
        pad = int(max(48, 0.6 * max(bw, bh)))
        x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + 1 + pad)
        y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + 1 + pad)
        crop, cm = img[y0:y1, x0:x1], mask[y0:y1, x0:x1]
        if self.net is None:
            res = cv2.inpaint(crop, cm, 5, cv2.INPAINT_TELEA)
        else:
            ch, cw = crop.shape[:2]
            k = min(1.0, 1024 / max(ch, cw))
            sw, sh = max(8, int(round(cw * k / 8)) * 8), max(8, int(round(ch * k / 8)) * 8)
            ci = cv2.resize(crop, (sw, sh), interpolation=cv2.INTER_AREA)
            mi = (cv2.resize(cm, (sw, sh), interpolation=cv2.INTER_NEAREST) > 0).astype(np.float32)
            t = self.torch
            with t.inference_mode():
                x = t.from_numpy(cv2.cvtColor(ci, cv2.COLOR_BGR2RGB)).permute(2, 0, 1)[None].float().div(255).to(self.dev)
                m = t.from_numpy(mi)[None, None].to(self.dev)
                y = self.net(x, m)[0].permute(1, 2, 0).clamp(0, 1).mul(255).byte().cpu().numpy()
            res = cv2.resize(cv2.cvtColor(y, cv2.COLOR_RGB2BGR), (cw, ch), interpolation=cv2.INTER_CUBIC)
        # мягкий край маски, вне маски — исходные пиксели
        a = cv2.GaussianBlur(cm.astype(np.float32) / 255, (0, 0), 1.2)[..., None]
        a = np.maximum(a, (cm > 0)[..., None].astype(np.float32))
        out = img.copy()
        out[y0:y1, x0:x1] = (res.astype(np.float32) * a + crop.astype(np.float32) * (1 - a)).astype(np.uint8)
        return out


# ---------------------------------------------------------------- команды
def read_image(path):
    data = np.fromfile(path, dtype=np.uint8)   # cv2.imread не открывает пути с кириллицей на Windows
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit('Не удалось открыть картинку')
    alpha = None
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        alpha = img[:, :, 3]
        img = img[:, :, :3]
    return img, alpha


def frame_at(video, t):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True)
    img = cv2.imdecode(np.frombuffer(r.stdout, np.uint8), cv2.IMREAD_COLOR) if r.stdout else None
    if img is None:
        raise SystemExit('Не удалось прочитать кадр видео')
    return img


def cmd_fetch(o):
    # установка: EasyOCR сам качает свои модели (поиск строк + кириллица/латиница)
    import easyocr
    d = os.path.join(o.models, 'easyocr')
    os.makedirs(d, exist_ok=True)
    easyocr.Reader(['ru', 'en'], gpu=False, model_storage_directory=d, user_network_directory=d, verbose=False)


def cmd_analyze(o):
    progress(0)
    img = frame_at(o.video, o.t) if o.video else read_image(o.image)[0]
    if o.frame_out:
        cv2.imencode('.png', img)[1].tofile(o.frame_out)
    H, W = img.shape[:2]
    progress(0.05)
    found = ocr(img, o.models)
    progress(0.5)
    fonts = font_list(o.models)
    progress(0.6)
    blocks = []
    for i, (quad, text, conf) in enumerate(found):
        b = analyze_block(img, quad, text, fonts)
        if b:
            b['quad'] = [[round(float(x), 1), round(float(y), 1)] for x, y in quad]
            b['conf'] = round(conf, 3)
            blocks.append(b)
        progress(0.6 + 0.4 * (i + 1) / max(1, len(found)))
    blocks.sort(key=lambda b: (b['quad'][0][1], b['quad'][0][0]))
    json.dump({'w': W, 'h': H, 'blocks': blocks}, open(o.out, 'w', encoding='utf-8'), ensure_ascii=False)
    progress(1)


def cmd_erase(o):
    progress(0)
    img, alpha = read_image(o.image)
    quads = json.load(open(o.blocks, encoding='utf-8'))
    mask = erase_mask(img, quads)
    progress(0.2)
    res = Inpainter(o.models)(img, mask)
    if alpha is not None:
        res = np.dstack([res, alpha])
    cv2.imencode('.png', res)[1].tofile(o.out)
    progress(1)


class TextFinder:
    """Где строка на кадре: шаблон — буквы с кадра T0, сравниваются только пиксели букв (маска), поэтому
    неподвижный фон не тянет. Буквы жёсткие — сдвиг находится точно; сначала по уменьшенному кадру, потом уточнение."""
    def __init__(self, f0, mask0, box):
        x0, y0, x1, y1 = box
        self.box = box
        g = cv2.cvtColor(f0, cv2.COLOR_BGR2GRAY)
        self.t = g[y0:y1, x0:x1].copy()
        self.m = (mask0[y0:y1, x0:x1] > 0).astype(np.uint8) * 255
        self.area = max(1, int((self.m > 0).sum()))
        self.ts = cv2.resize(self.t, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        self.ms = (cv2.resize(self.m, (self.ts.shape[1], self.ts.shape[0]), interpolation=cv2.INTER_NEAREST) > 0).astype(np.uint8) * 255
        self.last = (0, 0)

    def __call__(self, fr):
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        H, W = g.shape
        th, tw = self.t.shape
        gs = cv2.resize(g, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        r = cv2.matchTemplate(gs, self.ts, cv2.TM_SQDIFF, mask=self.ms)
        r[~np.isfinite(r)] = np.inf
        _, _, (lx, ly), _ = cv2.minMaxLoc(r)
        ex, ey = lx * 2, ly * 2
        # уточнение по полному кадру в окне ±4 пикселя
        R = 4
        wx0, wy0 = max(0, ex - R), max(0, ey - R)
        wx1, wy1 = min(W, ex + tw + R), min(H, ey + th + R)
        win = g[wy0:wy1, wx0:wx1]
        if win.shape[0] >= th and win.shape[1] >= tw:
            r2 = cv2.matchTemplate(win, self.t, cv2.TM_SQDIFF, mask=self.m)
            r2[~np.isfinite(r2)] = np.inf
            mv, _, (lx2, ly2), _ = cv2.minMaxLoc(r2)
            ex, ey = wx0 + lx2, wy0 + ly2
            # средняя разница по буквам: больше ~45 уровней — строки на кадре нет (ушла, закрыта) → прежнее место
            if mv / self.area > 45 ** 2:
                return self.last
        self.last = (ex - self.box[0], ey - self.box[1])
        return self.last


def cmd_video(o):
    progress(0)
    quads = [np.array(q, dtype=np.float32) for q in json.load(open(o.blocks, encoding='utf-8'))]
    n_est = max(1, int(round((o.b - o.a) * o.fps)))
    k0 = max(0, min(n_est - 1, int(round((o.t0 - o.a) * o.fps))))
    f0 = frame_at(o.video, o.a + k0 / o.fps)
    FH, FW = f0.shape[:2]
    mask0 = erase_mask(f0, quads)
    allq = np.concatenate(quads)
    x0, y0 = allq.min(axis=0)
    x1, y1 = allq.max(axis=0)
    pad = int(0.2 * (y1 - y0)) + 2
    box = (max(0, int(x0) - pad), max(0, int(y0) - pad), min(FW, int(x1) + pad), min(FH, int(y1) + pad))
    find = TextFinder(f0, erase_mask(f0, quads, 0), box)   # искать — только по самим буквам, без фона вокруг
    inp = Inpainter(o.models)
    progress(0.05)
    dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(o.a), '-t', str(o.b - o.a), '-i', o.video, '-an', '-vf', f'fps={o.fps}:start_time=0',
                            '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{FW}x{FH}', '-r', str(o.fps), '-i', '-',
                            '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', o.out], stdin=subprocess.PIPE)
    size = FW * FH * 3
    shifts = []
    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        fr = np.frombuffer(buf, np.uint8).reshape(FH, FW, 3)
        dx, dy = find(fr)
        shifts.append((dx, dy))
        m = mask0 if (dx, dy) == (0, 0) else cv2.warpAffine(mask0, np.float32([[1, 0, dx], [0, 1, dy]]), (FW, FH))
        enc.stdin.write(inp(fr, m).tobytes())
        progress(0.05 + 0.95 * min(1.0, len(shifts) / n_est))
    enc.stdin.close()
    dec.wait()
    if enc.wait() != 0 or not shifts:
        raise SystemExit('Не удалось записать видео')
    cx0, cy0 = float(x0 + x1) / 2, float(y0 + y1) / 2
    pts = [[round(o.a + j / o.fps, 5), round((cx0 + dx) / FW, 5), round((cy0 + dy) / FH, 5),
            round(float(x1 - x0) / FW, 5), round(float(y1 - y0) / FH, 5), 1.0] for j, (dx, dy) in enumerate(shifts)]
    json.dump({'fps': o.fps, 'a': o.a, 'w': FW, 'h': FH, 'engine': 'text', 'frames': len(shifts), 'pts': pts}, open(o.track, 'w'))
    progress(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['analyze', 'erase', 'video', 'fetch'])
    ap.add_argument('video', nargs='?')
    ap.add_argument('--video', dest='video_opt')
    ap.add_argument('--image')
    ap.add_argument('--t', type=float, default=0)
    ap.add_argument('--a', type=float, default=0)
    ap.add_argument('--b', type=float, default=0)
    ap.add_argument('--t0', type=float, default=0)
    ap.add_argument('--fps', type=float, default=30)
    ap.add_argument('--blocks')
    ap.add_argument('--models', default='.')
    ap.add_argument('--out')
    ap.add_argument('--frame-out')
    ap.add_argument('--track')
    o = ap.parse_args()
    o.video = o.video_opt or o.video
    {'analyze': cmd_analyze, 'erase': cmd_erase, 'video': cmd_video, 'fetch': cmd_fetch}[o.cmd](o)


if __name__ == '__main__':
    main()
