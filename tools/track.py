#!/usr/bin/env python3
"""Трекинг объекта для LinCut.

track.py VIDEO --a A --b B --t0 T0 --box X Y W H --out OUT.json [--engine sam2|csrt] [--fps F] [--models DIR]

Кусок источника [A, B] разбирается на кадры (F кадров/с, длинная сторона ≤ 1024), объект задаётся рамкой
(доли кадра: левый верх X, Y и размер W, H) в момент T0 и отслеживается вперёд и назад до краёв куска.
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
