#!/usr/bin/env python3
"""Трекинг объекта для LinCut.

track.py VIDEO --a A --b B --t0 T0 --box X Y W H --out OUT.json [--engine sam2|face|csrt] [--fps F] [--models DIR]

Кусок источника [A, B] разбирается на кадры (F кадров/с, длинная сторона ≤ 1024), объект задаётся рамкой
(доли кадра: левый верх X, Y и размер W, H) в момент T0 и отслеживается вперёд и назад до краёв куска.
Движок face — детектор лиц YuNet с привязкой к обведённому лицу; sam2 сам переключается на него,
если рамкой обвели лицо.
Результат: {"fps", "a", "w", "h", "engine", "pts": [[t, cx, cy, bw, bh, score], …]} — центр и размер рамки
объекта в долях кадра источника, t — время источника. Прогресс — строки «PROGRESS 0.42» в stdout.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

SAM2_CKPT = 'sam2.1_hiera_small.pt'
SAM2_CFG = 'configs/sam2.1/sam2.1_hiera_s.yaml'


def progress(p):
    print(f'PROGRESS {max(0.0, min(1.0, p)):.4f}', flush=True)


def extract(video, a, b, fps, out_dir):
    # кадры ровно с шагом 1/fps от A — как их потом считает LinCut
    vf = f'fps={fps}:start_time=0,scale=w=\'if(gt(iw,ih),min(1024,iw),-2)\':h=\'if(gt(iw,ih),-2,min(1024,ih))\''
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(a), '-t', str(b - a), '-i', video, '-an', '-vf', vf,
                    '-q:v', '2', '-start_number', '0', os.path.join(out_dir, '%05d.jpg')], check=True)
    names = sorted(f for f in os.listdir(out_dir) if f.endswith('.jpg'))
    if not names:
        raise SystemExit('Не удалось прочитать кадры видео')
    return names


def box_of_mask(m):
    import numpy as np
    ys, xs = np.nonzero(m)
    if len(xs) < 4:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    # центр — по «массе» маски: устойчивее к рукам/ногам, торчащим из рамки
    return float(xs.mean()), float(ys.mean()), float(x1 - x0), float(y1 - y0)


def track_sam2(frames_dir, n, k0, box_px, models, W, H):
    import numpy as np, torch
    from sam2.build_sam import build_sam2_video_predictor
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    pred = build_sam2_video_predictor(SAM2_CFG, os.path.join(models, SAM2_CKPT), device=dev)
    res = {}
    ctx = torch.autocast('cuda', dtype=torch.bfloat16) if dev == 'cuda' else torch.autocast('cpu', enabled=False)
    with torch.inference_mode(), ctx:
        state = pred.init_state(video_path=frames_dir, offload_video_to_cpu=True, offload_state_to_cpu=dev == 'cpu', async_loading_frames=False)
        x, y, w, h = box_px
        pred.add_new_points_or_box(state, frame_idx=k0, obj_id=1, box=np.array([x, y, x + w, y + h], dtype=np.float32))
        done = 0
        for reverse in (False, True):
            if reverse and k0 == 0:
                continue
            if not reverse and k0 == n - 1:
                continue
            for fi, ids, logits in pred.propagate_in_video(state, start_frame_idx=k0, reverse=reverse):
                m = (logits[0, 0] > 0).cpu().numpy()
                bb = box_of_mask(m)
                score = float(m.mean() > 0)
                res[fi] = (bb, score)
                done += 1
                progress(0.1 + 0.9 * done / (n + 1))
    return res


def track_csrt(frames_dir, names, k0, box_px):
    import cv2
    make = getattr(cv2, 'TrackerCSRT_create', None) or getattr(getattr(cv2, 'legacy', None), 'TrackerCSRT_create', None)
    if make is None:
        make = getattr(cv2, 'TrackerKCF_create', None) or cv2.legacy.TrackerKCF_create
    res, n, done = {}, len(names), 0
    x, y, w, h = [int(round(v)) for v in box_px]
    for order in (range(k0, n), range(k0, -1, -1)):
        tr = make()
        first = True
        for fi in order:
            img = cv2.imread(os.path.join(frames_dir, names[fi]))
            if first:
                tr.init(img, (x, y, max(4, w), max(4, h)))
                res[fi] = ((x + w / 2, y + h / 2, w, h), 1.0)
                first = False
                continue
            ok, bb = tr.update(img)
            if ok:
                bx, by, bw, bh = bb
                res[fi] = ((bx + bw / 2, by + bh / 2, bw, bh), 1.0)
            else:
                res[fi] = (None, 0.0)
            done += 1
            progress(0.1 + 0.9 * done / max(1, n))
    return res


YUNET = 'face_detection_yunet_2023mar.onnx'
YUNET_URL = 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'


def face_detector(models):
    """Детектор лиц: YuNet (маленькая сеть OpenCV, ~230 КБ, качается сама) или каскад Хаара как запасной."""
    import cv2
    path = os.path.join(models, YUNET)
    if not os.path.exists(path) and hasattr(cv2, 'FaceDetectorYN'):
        try:
            import urllib.request
            os.makedirs(models, exist_ok=True)
            urllib.request.urlretrieve(YUNET_URL, path + '.part')
            os.replace(path + '.part', path)
        except Exception as e:
            print(f'YuNet download failed: {e}', file=sys.stderr, flush=True)
    if os.path.exists(path) and hasattr(cv2, 'FaceDetectorYN'):
        net = cv2.FaceDetectorYN.create(path, '', (320, 320), 0.55, 0.3, 50)

        def detect(img):
            h, w = img.shape[:2]
            net.setInputSize((w, h))
            _, faces = net.detect(img)
            return [] if faces is None else [(float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])) for f in faces]
        return detect
    cas = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'))

    def detect(img):
        g = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
        return [(float(x), float(y), float(w), float(h), 0.8) for x, y, w, h in cas.detectMultiScale(g, 1.1, 5, minSize=(24, 24))]
    return detect


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter / max(1e-6, aw * ah + bw * bh - inter)


def pick_face(faces, box):
    """Лицо, которое обвели рамкой: сильнее всего пересекается с ней или лежит внутри."""
    bx, by, bw, bh = box
    best, bs = None, 0.0
    for f in faces:
        x, y, w, h, _ = f
        cx, cy = x + w / 2, y + h / 2
        inside = bx <= cx <= bx + bw and by <= cy <= by + bh
        s = iou(f[:4], box) + (0.5 if inside else 0.0)
        # рамка намного больше лица (обвели всего человека) — это не «лицо»
        if inside and w * h * 12 < bw * bh:
            s -= 0.5
        if s > bs:
            best, bs = f, s
    return best if bs > 0.25 else None


def track_face(frames_dir, names, k0, box_px, models, face0=None):
    """Трекинг лица: детектор на каждом кадре + привязка к «своему» лицу (по предсказанному положению и размеру).
    Короткие пропуски (поворот головы, рука перед лицом) закрывает CSRT, длинные — помечаются потерянными,
    LinCut их интерполирует. К чужому лицу не перескакивает: кандидат должен быть рядом и похожего размера."""
    import cv2
    detect = face_detector(models)
    make = getattr(cv2, 'TrackerCSRT_create', None) or getattr(getattr(cv2, 'legacy', None), 'TrackerCSRT_create', None)
    n = len(names)
    imgs = {}

    def img(i):
        if i not in imgs:
            if len(imgs) > 8:
                imgs.pop(next(iter(imgs)))
            imgs[i] = cv2.imread(os.path.join(frames_dir, names[i]))
        return imgs[i]

    dets = {}

    def faces(i):
        if i not in dets:
            dets[i] = detect(img(i))
        return dets[i]

    if face0 is None:
        face0 = pick_face(faces(k0), box_px)
    start = tuple(face0[:4]) if face0 else tuple(box_px)
    res = {k0: ((start[0] + start[2] / 2, start[1] + start[3] / 2, start[2], start[3]), 1.0)}
    done = 0
    for step in (1, -1):
        cur = start                     # последнее надёжное положение лица (x, y, w, h)
        vel = (0.0, 0.0)                # скорость центра, пикс/кадр
        miss = 0
        tr = None
        i = k0 + step
        while 0 <= i < n:
            cx, cy = cur[0] + cur[2] / 2 + vel[0] * (miss + 1), cur[1] + cur[3] / 2 + vel[1] * (miss + 1)
            size = (cur[2] * cur[3]) ** 0.5
            gate = size * (0.9 + 0.35 * min(miss, 12))
            best, bd = None, 1e9
            for f in faces(i):
                x, y, w, h, sc = f
                d = ((x + w / 2 - cx) ** 2 + (y + h / 2 - cy) ** 2) ** 0.5
                r = (w * h) ** 0.5 / max(1.0, size)
                if d > gate or not (0.6 < r < 1.65):
                    continue
                d += (1 - sc) * size * 0.3
                if d < bd:
                    best, bd = f, d
            if best is not None:
                nb = best[:4]
                ncx, ncy = nb[0] + nb[2] / 2, nb[1] + nb[3] / 2
                k = 1.0 / (miss + 1)
                vel = (0.6 * vel[0] + 0.4 * (ncx - (cur[0] + cur[2] / 2)) * k, 0.6 * vel[1] + 0.4 * (ncy - (cur[1] + cur[3] / 2)) * k)
                cur, miss, tr = nb, 0, None
                res[i] = ((ncx, ncy, nb[2], nb[3]), 1.0)
            else:
                miss += 1
                ok = False
                if make is not None and miss <= 45:
                    if tr is None:
                        tr = make()
                        prev = i - step
                        tr.init(img(prev), tuple(int(round(v)) for v in (cur[0], cur[1], max(8, cur[2]), max(8, cur[3]))))
                    ok, bb = tr.update(img(i))
                    if ok:
                        bx, by, bw, bh = bb
                        # CSRT не должен уползти далеко от места, где лицо видели в последний раз
                        ok = ((bx + bw / 2 - cx) ** 2 + (by + bh / 2 - cy) ** 2) ** 0.5 < size * (1.0 + 0.15 * miss)
                if ok:
                    res[i] = ((bx + bw / 2, by + bh / 2, bw, bh), 0.6)
                else:
                    tr = None if miss > 45 else tr
                    res[i] = (None, 0.0)
            done += 1
            progress(0.1 + 0.9 * done / max(1, n))
            i += step
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--a', type=float, required=True)
    ap.add_argument('--b', type=float, required=True)
    ap.add_argument('--t0', type=float, required=True)
    ap.add_argument('--box', type=float, nargs=4, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--engine', default='sam2')
    ap.add_argument('--fps', type=float, default=30)
    ap.add_argument('--models', default='.')
    ap.add_argument('--check', action='store_true', help='только проверить, что движок доступен')
    o = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix='lincut-track-')
    try:
        progress(0)
        names = extract(o.video, o.a, o.b, o.fps, tmp)
        n = len(names)
        from PIL import Image
        W, H = Image.open(os.path.join(tmp, names[0])).size
        k0 = max(0, min(n - 1, int(round((o.t0 - o.a) * o.fps))))
        bx, by, bw, bh = o.box
        box_px = (bx * W, by * H, bw * W, bh * H)
        progress(0.1)
        engine = o.engine
        face0 = None
        if engine in ('sam2', 'auto'):
            # обвели лицо — следим детектором лиц: SAM 2 на лице часто «расплывается» на голову/тело и слетает
            try:
                import cv2
                face0 = pick_face(face_detector(o.models)(cv2.imread(os.path.join(tmp, names[k0]))), box_px)
                if face0 is not None and face0[2] * face0[3] * 6 >= box_px[2] * box_px[3]:
                    engine = 'face'
            except Exception as e:
                print(f'Face check failed: {e}', file=sys.stderr, flush=True)
        if engine == 'auto':
            engine = 'sam2'
        if engine == 'face':
            res = track_face(tmp, names, k0, box_px, o.models, face0)
        if engine == 'sam2':
            try:
                res = track_sam2(tmp, n, k0, box_px, o.models, W, H)
            except Exception as e:  # нет видеокарты/модели — не бросаем пользователя, пробуем быстрый трекер
                print(f'SAM2 failed: {e}', file=sys.stderr, flush=True)
                engine = 'csrt'
        if engine == 'csrt':
            res = track_csrt(tmp, names, k0, box_px)
        pts = []
        last = (bx * W + bw * W / 2, by * H + bh * H / 2, bw * W, bh * H)
        for fi in range(n):
            bb, sc = res.get(fi, (None, 0.0))
            if bb is None:
                bb, sc = last, 0.0
            else:
                last = bb
            cx, cy, w, h = bb
            pts.append([round(o.a + fi / o.fps, 5), round(cx / W, 5), round(cy / H, 5), round(w / W, 5), round(h / H, 5), round(sc, 3)])
        with open(o.out, 'w') as f:
            json.dump({'fps': o.fps, 'a': o.a, 'w': W, 'h': H, 'engine': engine, 'pts': pts}, f)
        progress(1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
