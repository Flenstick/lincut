#!/usr/bin/env python3
"""Ротоскоп (Roto Brush) для LinCut: нейросеть SAM 2 вырезает объект из видео без зелёного фона.

roto.py serve --models DIR
    Живой режим для выделения: модель загружается один раз, команды — строки JSON в stdin:
    {"id": 1, "cmd": "mask", "video": PATH, "ss": SEC, "pts": [[u, v, label], …], "box": [x, y, w, h] | null,
     "maxside": 1024, "out": PNG}
    → в stdout {"id": 1, "ok": true, "out": PNG, "score": 0.97}. Маска одного кадра (точки и рамка — доли кадра).

roto.py run VIDEO --a A --b B --fps F --prompts JSON --out DIR --models DIR [--maxside 1024]
    Кусок источника с A (ровно на кадре) до B разбирается на кадры, подсказки ({"k": номер кадра,
    "pts": [[u, v, label]], "box": [x, y, w, h] | null}) задают объект, SAM 2 протягивает маску по всем кадрам.
    В DIR: 000000.png … — белый с прозрачностью (мягкий край из логитов), meta.json {a, fps, n, w, h}.
    Прогресс — строки «PROGRESS 0.42».
"""
import argparse, io, json, os, shutil, subprocess, sys, tempfile

SAM2_CKPT = 'sam2.1_hiera_small.pt'
SAM2_CFG = 'configs/sam2.1/sam2.1_hiera_s.yaml'


def progress(p):
    print(f'PROGRESS {max(0.0, min(1.0, p)):.4f}', flush=True)


def scale_vf(maxside):
    return f"scale=w='if(gt(iw,ih),min({maxside},iw),-2)':h='if(gt(iw,ih),-2,min({maxside},ih))'"


def save_alpha(path, logits):
    import numpy as np
    from PIL import Image
    a = 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))
    a = (a * 255.0 + 0.5).astype(np.uint8)
    img = np.dstack([np.full_like(a, 255), a])
    tmp = path + '.tmp.png'
    Image.fromarray(img, 'LA').save(tmp, compress_level=1)
    os.replace(tmp, path)


def device():
    import torch
    return 'cuda' if torch.cuda.is_available() else 'cpu'


def autocast(dev):
    import torch
    return torch.autocast('cuda', dtype=torch.bfloat16) if dev == 'cuda' else torch.autocast('cpu', enabled=False)


def serve(models):
    import numpy as np, torch
    from PIL import Image
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    dev = device()
    pred = SAM2ImagePredictor(build_sam2(SAM2_CFG, os.path.join(models, SAM2_CKPT), device=dev))
    print(json.dumps({'ready': True, 'device': dev}), flush=True)
    cur = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            q = json.loads(line)
        except Exception:
            continue
        if q.get('cmd') == 'quit':
            break
        try:
            key = (q['video'], round(float(q['ss']), 4), int(q.get('maxside', 1024)))
            if cur != key:
                png = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(q['ss']), '-i', q['video'], '-frames:v', '1', '-an',
                                      '-vf', scale_vf(key[2]), '-f', 'image2pipe', '-c:v', 'png', '-'], check=True, capture_output=True).stdout
                img = np.array(Image.open(io.BytesIO(png)).convert('RGB'))
                with torch.inference_mode(), autocast(dev):
                    pred.set_image(img)
                cur = key
                W, H = img.shape[1], img.shape[0]
                cur_size = (W, H)
            W, H = cur_size
            pts = q.get('pts') or []
            box = q.get('box')
            kw = {}
            if pts:
                kw['point_coords'] = np.array([[p[0] * W, p[1] * H] for p in pts], dtype=np.float32)
                kw['point_labels'] = np.array([int(p[2]) for p in pts], dtype=np.int32)
            if box:
                kw['box'] = np.array([box[0] * W, box[1] * H, (box[0] + box[2]) * W, (box[1] + box[3]) * H], dtype=np.float32)
            # одна точка без рамки неоднозначна (рубашка / человек целиком) — берём лучший из трёх вариантов
            multi = len(pts) == 1 and not box
            with torch.inference_mode(), autocast(dev):
                masks, scores, _ = pred.predict(multimask_output=multi, return_logits=True, **kw)
            i = 0
            if multi:
                # из почти равных по уверенности — самый крупный: щелчок обычно значит «объект целиком»
                best = float(np.max(scores))
                areas = [(masks[j] > 0).sum() if scores[j] >= best - 0.12 else -1 for j in range(len(scores))]
                i = int(np.argmax(areas))
            save_alpha(q['out'], masks[i].astype(np.float32))
            print(json.dumps({'id': q.get('id'), 'ok': True, 'out': q['out'], 'score': float(scores[i]), 'w': W, 'h': H}), flush=True)
        except Exception as e:
            print(json.dumps({'id': q.get('id'), 'ok': False, 'error': str(e)[-400:]}), flush=True)


def run(o):
    import numpy as np, torch
    from PIL import Image
    from sam2.build_sam import build_sam2_video_predictor
    prompts = json.loads(o.prompts)
    tmp = tempfile.mkdtemp(prefix='lincut-roto-')
    out_tmp = o.out + '.part'
    shutil.rmtree(out_tmp, ignore_errors=True)
    os.makedirs(out_tmp)
    try:
        progress(0)
        # чуть раньше A: точный поиск ffmpeg отбрасывает кадры раньше -ss, а A стоит ровно на кадре
        ss = max(0.0, o.a - 0.25 / o.fps)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(ss), '-t', str(o.b - ss), '-i', o.video, '-an',
                        '-vf', scale_vf(o.maxside), '-fps_mode', 'passthrough', '-q:v', '2', '-start_number', '0',
                        os.path.join(tmp, '%05d.jpg')], check=True)
        names = sorted(f for f in os.listdir(tmp) if f.endswith('.jpg'))
        n = len(names)
        if not n:
            raise SystemExit('Не удалось прочитать кадры видео')
        W, H = Image.open(os.path.join(tmp, names[0])).size
        progress(0.05)
        dev = device()
        pred = build_sam2_video_predictor(SAM2_CFG, os.path.join(o.models, SAM2_CKPT), device=dev)
        done = 0
        with torch.inference_mode(), autocast(dev):
            state = pred.init_state(video_path=tmp, offload_video_to_cpu=True, offload_state_to_cpu=dev == 'cpu', async_loading_frames=False)
            ks = []
            for p in prompts:
                k = max(0, min(n - 1, int(p['k'])))
                kw = {}
                if p.get('pts'):
                    kw['points'] = np.array([[q[0] * W, q[1] * H] for q in p['pts']], dtype=np.float32)
                    kw['labels'] = np.array([int(q[2]) for q in p['pts']], dtype=np.int32)
                if p.get('box'):
                    b = p['box']
                    kw['box'] = np.array([b[0] * W, b[1] * H, (b[0] + b[2]) * W, (b[1] + b[3]) * H], dtype=np.float32)
                if not kw:
                    continue
                pred.add_new_points_or_box(state, frame_idx=k, obj_id=1, **kw)
                ks.append(k)
            if not ks:
                raise SystemExit('Нет подсказок: отметьте объект точками')
            k0 = min(ks)
            progress(0.1)
            for reverse in (False, True):
                if reverse and k0 == 0:
                    continue
                for fi, ids, logits in pred.propagate_in_video(state, start_frame_idx=k0, reverse=reverse):
                    save_alpha(os.path.join(out_tmp, f'{fi:06d}.png'), logits[0, 0].float().cpu().numpy())
                    done += 1
                    progress(0.1 + 0.9 * done / (n + 1))
        # кадры, до которых нейросеть не дошла, — пустые (на всякий случай)
        for fi in range(n):
            f = os.path.join(out_tmp, f'{fi:06d}.png')
            if not os.path.exists(f):
                save_alpha(f, np.full((H, W), -30.0, dtype=np.float32))
        with open(os.path.join(out_tmp, 'meta.json'), 'w') as f:
            json.dump({'a': o.a, 'fps': o.fps, 'n': n, 'w': W, 'h': H}, f)
        shutil.rmtree(o.out, ignore_errors=True)
        os.replace(out_tmp, o.out)
        progress(1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(out_tmp, ignore_errors=True)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'serve':
        ap = argparse.ArgumentParser()
        ap.add_argument('mode')
        ap.add_argument('--models', default='.')
        serve(ap.parse_args().models)
        return
    ap = argparse.ArgumentParser()
    ap.add_argument('mode')
    ap.add_argument('video')
    ap.add_argument('--a', type=float, required=True)
    ap.add_argument('--b', type=float, required=True)
    ap.add_argument('--fps', type=float, required=True)
    ap.add_argument('--prompts', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--models', default='.')
    ap.add_argument('--maxside', type=int, default=1024)
    run(ap.parse_args())


if __name__ == '__main__':
    main()
