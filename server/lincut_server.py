#!/usr/bin/env python3
"""Сервер нейросетей LinCut: «Голос и фон», трекинг и «Вырезать объект» на видеокарте этого компьютера —
чтобы у остальных LinCut ничего не скачивал. Задачи идут по очереди (видеокарта одна), доступ — по ключам.

  lincut_server.py serve [--host 0.0.0.0] [--port 8765] [--tunnel]
                                         — --tunnel: доступ из интернета через Cloudflare Tunnel, адрес
                                           сообщается сайту (справочная), LinCut берёт его оттуда
  lincut_server.py keys add ИМЯ          — выдать ключ (печатает его)
  lincut_server.py keys list             — ключи и сколько по ним посчитано
  lincut_server.py keys revoke ИМЯ|КЛЮЧ  — отозвать
  lincut_server.py pause | resume        — не брать новые задачи / снова брать
  lincut_server.py status                — состояние (очередь, видеокарта)

Работает внутри окружения Python нейросетей LinCut (~/.local/share/lincut/sep) и запускает те же скрипты,
что и LinCut на компьютере пользователя (tools/separate.py, track.py, roto.py). Присланные файлы удаляются
сразу после обработки, результаты — после скачивания (или через час).
"""
import argparse, asyncio, hashlib, io, json, os, re, secrets, shutil, signal, subprocess, sys, tarfile, time, urllib.request, uuid

VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(os.path.dirname(HERE), 'tools')
PY = sys.executable
HOME = os.path.expanduser('~')
MODELS = os.path.join(HOME, '.local', 'share', 'lincut', 'models')
SEP_MODEL = 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'
CONF = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config'), 'lincut-server')
DATA = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.join(HOME, '.cache'), 'lincut-server')
KEYS = os.path.join(CONF, 'keys.json')
STATE = os.path.join(CONF, 'state.json')
LOG = os.path.join(CONF, 'server.log')
SITE = 'https://hm537533.webhm.cloud/api/ai_server.php'   # справочная: где сейчас сервер
SITE_SECRET = os.path.join(CONF, 'site_secret')            # им подписывается адрес для справочной

MAX_UPLOAD = 400 << 20          # 400 МБ на запрос
MAX_QUEUED_PER_KEY = 3          # задач в очереди на один ключ
RESULT_TTL = 3600               # неполученные результаты живут час
TEMP_HOT, TEMP_OK = 86, 76      # перегрев видеокарты: ждём остывания


def jload(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def jsave(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def log(*a):
    line = time.strftime('%Y-%m-%d %H:%M:%S ') + ' '.join(str(x) for x in a)
    print(line, flush=True)
    try:
        os.makedirs(CONF, exist_ok=True)
        with open(LOG, 'a') as f:
            f.write(line + '\n')
    except Exception:
        pass


def gpu_info():
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,memory.used,temperature.gpu,utilization.gpu',
                              '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5).stdout.strip().split('\n')[0]
        n, mt, mu, t, u = [x.strip() for x in out.split(',')]
        return {'name': n, 'mem': int(mt), 'used': int(mu), 'temp': int(t), 'load': int(u)}
    except Exception:
        return None


# ---------------------------------------------------------------- туннель и справочная
def http(url, data=None, timeout=20):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json', 'User-Agent': f'LinCut-Server/{VERSION}'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def announce(url):
    """Сообщить справочной текущий адрес ('' — сервер выключается)."""
    with open(SITE_SECRET) as f:
        secret = f.read().strip()
    return http(SITE, {'secret': secret, 'url': url}).get('ok')


async def tunnel(port):
    """Cloudflare Tunnel без регистрации: адрес *.trycloudflare.com новый при каждом запуске cloudflared —
    его сообщаем справочной и напоминаем каждые 5 минут. Туннель перестал отвечать — поднимаем новый."""
    while True:
        p = url = drain = None
        try:
            p = await asyncio.create_subprocess_exec('cloudflared', 'tunnel', '--no-autoupdate', '--url', f'http://127.0.0.1:{port}',
                                                     stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                                                     stderr=asyncio.subprocess.PIPE)
            deadline = time.time() + 90
            while not url and time.time() < deadline:
                line = await asyncio.wait_for(p.stderr.readline(), 90)
                if not line:
                    break
                m = re.search(rb'https://[a-z0-9-]+\.trycloudflare\.com', line)
                if m and not m.group().startswith(b'https://api.'):
                    url = m.group().decode()
            if not url:
                raise RuntimeError('cloudflared не выдал адрес')

            async def drain_err():
                while await p.stderr.readline():
                    pass
            drain = asyncio.create_task(drain_err())
            # адрес начинает работать не сразу (DNS) — ждём, пока сервер станет виден через него
            for _ in range(30):
                try:
                    if (await asyncio.to_thread(http, url + '/api/status', None, 10)).get('app') == 'lincut-ai':
                        break
                except Exception:
                    pass
                await asyncio.sleep(3)
            else:
                raise RuntimeError('туннель не отвечает: ' + url)
            log('туннель:', url)
            fails, last = 0, 0
            while p.returncode is None:
                if time.time() - last > 300:
                    try:
                        await asyncio.to_thread(announce, url)
                        last = time.time()
                    except Exception as e:
                        log('справочная недоступна:', e)
                await asyncio.sleep(60)
                try:
                    await asyncio.to_thread(http, url + '/api/status', None, 15)
                    fails = 0
                except Exception:
                    fails += 1
                    if fails >= 3:
                        raise RuntimeError('туннель перестал отвечать')
            raise RuntimeError(f'cloudflared завершился (код {p.returncode})')
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log('туннель:', e, '— перезапуск через 15 с')
        finally:
            if drain:
                drain.cancel()
            if p and p.returncode is None:
                p.terminate()
                try:
                    await asyncio.wait_for(p.wait(), 5)
                except Exception:
                    p.kill()
        await asyncio.sleep(15)


# ---------------------------------------------------------------- ключи
class Keys:
    def __init__(self):
        self.d = jload(KEYS, {'keys': []})

    def save(self):
        jsave(KEYS, self.d)

    def find(self, key):
        for k in self.d['keys']:
            if not k.get('revoked') and secrets.compare_digest(k['key'], key):
                return k
        return None

    def add(self, name):
        k = {'key': 'lc_' + secrets.token_urlsafe(24), 'name': name, 'created': int(time.time()), 'jobs': 0, 'gpu_sec': 0}
        self.d['keys'].append(k)
        self.save()
        return k

    def note(self, key, sec):
        self.d = jload(KEYS, self.d)
        for k in self.d['keys']:
            if k['key'] == key:
                k['jobs'] = k.get('jobs', 0) + 1
                k['gpu_sec'] = round(k.get('gpu_sec', 0) + sec, 1)
                k['last'] = int(time.time())
        self.save()


# ---------------------------------------------------------------- задачи
class Job:
    def __init__(self, kind, key, params, dir_):
        self.id = uuid.uuid4().hex[:16]
        self.kind, self.key, self.params, self.dir = kind, key, params, dir_
        self.state, self.p, self.error, self.result = 'queued', 0.0, None, None
        self.created, self.done_at, self.proc, self.canceled = time.time(), None, None, False

    def view(self, pos=None):
        v = {'id': self.id, 'kind': self.kind, 'state': self.state, 'p': round(self.p, 4)}
        if pos is not None:
            v['pos'] = pos
        if self.error:
            v['error'] = self.error
        if self.result:
            v['files'] = sorted(self.result)
        return v


class Server:
    def __init__(self):
        self.keys = Keys()
        self.jobs = {}
        self.queue = []
        self.wake = asyncio.Event()
        self.gpu = asyncio.Lock()
        self.serve = None            # живой процесс roto.py serve (выделение щелчками)
        self.serve_used = 0
        self.serve_lock = asyncio.Lock()
        self.frames = {}             # id кадра → путь (кадры для выделения щелчками)
        self.state = 'idle'
        os.makedirs(DATA, exist_ok=True)
        shutil.rmtree(os.path.join(DATA, 'jobs'), ignore_errors=True)
        shutil.rmtree(os.path.join(DATA, 'frames'), ignore_errors=True)

    @property
    def paused(self):
        return bool(jload(STATE, {}).get('paused'))

    def pos(self, job):
        return self.queue.index(job) + 1 if job in self.queue else 0

    # ------------------------------------------------ выполнение
    async def worker(self):
        while True:
            if not self.queue or self.paused:
                self.state = 'paused' if self.paused and self.queue else 'idle'
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), 5)
                except asyncio.TimeoutError:
                    pass
                continue
            g = gpu_info()
            if g and g['temp'] >= TEMP_HOT:
                self.state = 'cooling'
                log('видеокарта', g['temp'], '°C — ждём остывания')
                while (g := gpu_info()) and g['temp'] > TEMP_OK:
                    await asyncio.sleep(5)
            job = self.queue.pop(0)
            async with self.gpu:
                await self.stop_serve()      # видеопамяти 4 ГБ — живой процесс выделения уступает место
                self.state = 'busy'
                job.state = 'running'
                t0 = time.time()
                try:
                    await getattr(self, 'run_' + job.kind)(job)
                    job.state, job.p = 'done', 1.0
                    log('готово', job.kind, job.id, self.keys.find(job.key)['name'] if self.keys.find(job.key) else '?', f'{time.time() - t0:.1f} с')
                except Exception as e:
                    job.state = 'canceled' if job.canceled else 'error'
                    job.error = 'Отменено' if job.canceled else str(e)[-1500:]
                    log('ошибка', job.kind, job.id, job.error.splitlines()[-1] if job.error else '')
                finally:
                    job.proc, job.done_at = None, time.time()
                    for f in os.listdir(job.dir):          # присланное — сразу удаляем
                        if f.startswith('in.'):
                            os.remove(os.path.join(job.dir, f))
                    self.keys.note(job.key, time.time() - t0)

    async def proc(self, job, args, on_line=None):
        p = await asyncio.create_subprocess_exec(PY, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                 env={**os.environ, 'PYTHONUNBUFFERED': '1'})
        job.proc = p
        tail, buf = '', b''
        while True:
            chunk = await p.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            parts = re.split(rb'[\r\n]', buf)
            buf = parts.pop()
            for raw in parts:
                line = raw.decode('utf-8', 'replace')
                if line.strip():
                    tail = (tail + '\n' + line)[-3000:]
                    if on_line:
                        on_line(line)
        code = await p.wait()
        if job.canceled:
            raise RuntimeError('Отменено')
        if code != 0:
            lines = [l for l in tail.split('\n') if l.strip() and not re.search(r'Warning|warn\(|propagate in video|it/s', l)]
            raise RuntimeError('\n'.join(lines[-6:]) or 'Нейросеть завершилась с ошибкой')
        return tail

    def progress(self, job, lo=0.0, hi=1.0):
        def on(line):
            m = re.search(r'^PROGRESS ([\d.]+)', line) or re.search(r'(\d{1,3})%\|', line)
            if m:
                v = float(m.group(1))
                if '%' in line and 'PROGRESS' not in line:
                    v /= 100
                job.p = lo + (hi - lo) * max(0.0, min(1.0, v))
        return on

    async def run_sep(self, job):
        inp = os.path.join(job.dir, 'in.audio')
        out = os.path.join(job.dir, 'out')
        await self.proc(job, [os.path.join(TOOLS, 'separate.py'), inp, out, '--models', MODELS, '--model', SEP_MODEL, '--name', 'stem'],
                        self.progress(job))
        voice, bg = os.path.join(out, 'stem_voice.flac'), os.path.join(out, 'stem_bg.flac')
        if not (os.path.exists(voice) and os.path.exists(bg)):
            raise RuntimeError('Нейросеть не вернула файлы')
        job.result = {'voice.flac': voice, 'bg.flac': bg}

    async def run_trk(self, job):
        P = job.params
        inp, out = os.path.join(job.dir, 'in.video'), os.path.join(job.dir, 'track.json')
        await self.proc(job, [os.path.join(TOOLS, 'track.py'), inp, '--a', '0', '--b', str(float(P['dur'])), '--t0', str(float(P['t0'])),
                              '--box', *[str(float(x)) for x in P['box']], '--out', out, '--engine', str(P.get('engine', 'sam2')),
                              '--fps', str(float(P.get('fps', 30))), '--models', MODELS], self.progress(job))
        job.result = {'track.json': out}

    async def run_roto(self, job):
        P = job.params
        inp, out = os.path.join(job.dir, 'in.video'), os.path.join(job.dir, 'masks')
        prompts = [{'k': int(p['k']), 'pts': [[float(a), float(b), int(c)] for a, b, c in (p.get('pts') or [])],
                    'box': [float(x) for x in p['box']] if p.get('box') else None} for p in P['prompts']]
        await self.proc(job, [os.path.join(TOOLS, 'roto.py'), 'run', inp, '--a', '0', '--b', str(float(P['dur'])), '--fps', str(float(P['fps'])),
                              '--prompts', json.dumps(prompts), '--out', out, '--models', MODELS], self.progress(job))
        tar = os.path.join(job.dir, 'masks.tar')
        with tarfile.open(tar, 'w', format=tarfile.USTAR_FORMAT) as t:
            for f in sorted(os.listdir(out)):
                t.add(os.path.join(out, f), arcname=f)
        shutil.rmtree(out, ignore_errors=True)
        job.result = {'masks.tar': tar}

    # ------------------------------------------------ выделение щелчками (живой SAM 2)
    async def start_serve(self):
        if self.serve and self.serve.returncode is None:
            return
        self.serve = await asyncio.create_subprocess_exec(PY, os.path.join(TOOLS, 'roto.py'), 'serve', '--models', MODELS,
                                                          stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                          stderr=asyncio.subprocess.DEVNULL, env={**os.environ, 'PYTHONUNBUFFERED': '1'})
        line = await asyncio.wait_for(self.serve.stdout.readline(), 120)
        if b'ready' not in line:
            raise RuntimeError('Нейросеть выделения не запустилась')
        log('выделение: модель загружена')

    async def stop_serve(self):
        s, self.serve = self.serve, None
        if s and s.returncode is None:
            try:
                s.stdin.write(b'{"cmd":"quit"}\n')
                await s.stdin.drain()
                await asyncio.wait_for(s.wait(), 5)
            except Exception:
                s.kill()

    async def mask(self, frame, pts, box):
        out = os.path.join(DATA, 'frames', uuid.uuid4().hex + '.png')
        async with self.gpu:
            async with self.serve_lock:
                await self.start_serve()
                self.serve_used = time.time()
                q = {'id': 1, 'cmd': 'mask', 'image': frame, 'pts': pts, 'box': box, 'maxside': 1024, 'out': out}
                self.serve.stdin.write((json.dumps(q) + '\n').encode())
                await self.serve.stdin.drain()
                r = json.loads(await asyncio.wait_for(self.serve.stdout.readline(), 60))
        if not r.get('ok'):
            raise RuntimeError(r.get('error') or 'Ошибка нейросети')
        with open(out, 'rb') as f:
            data = f.read()
        os.remove(out)
        return data, r.get('score', 0)

    async def janitor(self):
        while True:
            await asyncio.sleep(30)
            now = time.time()
            for j in list(self.jobs.values()):
                if j.done_at and now - j.done_at > RESULT_TTL:
                    self.drop(j)
            fdir = os.path.join(DATA, 'frames')
            if os.path.isdir(fdir):
                for f in os.listdir(fdir):
                    p = os.path.join(fdir, f)
                    if now - os.path.getmtime(p) > 1800:
                        os.remove(p)
                        self.frames.pop(f.split('.')[0], None)
            if self.serve and now - self.serve_used > 180 and not self.serve_lock.locked():
                await self.stop_serve()
                log('выделение: модель выгружена (простой)')

    def drop(self, job):
        shutil.rmtree(job.dir, ignore_errors=True)
        self.jobs.pop(job.id, None)
        if job in self.queue:
            self.queue.remove(job)


# ---------------------------------------------------------------- HTTP
def make_app(S, tunnel_port=None):
    from aiohttp import web

    def auth(req):
        h = req.headers.get('Authorization', '')
        k = S.keys.find(h[7:].strip()) if h.startswith('Bearer ') else None
        if not k:
            S.keys = Keys()                       # ключ могли выдать только что — перечитываем
            k = S.keys.find(h[7:].strip()) if h.startswith('Bearer ') else None
        if not k:
            raise web.HTTPUnauthorized(text=json.dumps({'error': 'Неверный ключ доступа'}), content_type='application/json')
        return k

    def err(status, text):
        return web.json_response({'error': text}, status=status)

    async def status(req):
        v = {'ok': True, 'app': 'lincut-ai', 'version': VERSION}
        if req.headers.get('Authorization'):
            k = auth(req)
            v.update({'name': k['name'], 'state': S.state, 'paused': S.paused, 'queue': len(S.queue), 'gpu': gpu_info(),
                      'features': ['sep', 'trk', 'roto', 'mask']})
        return web.json_response(v)

    async def create(req):
        k = auth(req)
        if S.paused:
            return err(503, 'Сервер на паузе — владелец временно закрыл приём задач')
        if sum(1 for j in S.queue if j.key == k['key']) >= MAX_QUEUED_PER_KEY:
            return err(429, 'Слишком много задач в очереди с этого ключа — дождитесь готовых')
        reader = await req.multipart()
        meta, job = None, None
        while (part := await reader.next()) is not None:
            if part.name == 'meta':
                meta = json.loads(await part.text())
                if meta.get('kind') not in ('sep', 'trk', 'roto'):
                    return err(400, 'Неизвестная задача')
                d = os.path.join(DATA, 'jobs', uuid.uuid4().hex)
                os.makedirs(d)
                job = Job(meta['kind'], k['key'], meta.get('params') or {}, d)
            elif part.name == 'file' and job:
                dst = os.path.join(job.dir, 'in.audio' if job.kind == 'sep' else 'in.video')
                size = 0
                with open(dst, 'wb') as f:
                    while chunk := await part.read_chunk(1 << 20):
                        size += len(chunk)
                        if size > MAX_UPLOAD:
                            shutil.rmtree(job.dir, ignore_errors=True)
                            return err(413, 'Файл слишком большой')
                        f.write(chunk)
        if not job or not any(f.startswith('in.') for f in os.listdir(job.dir)):
            if job:
                shutil.rmtree(job.dir, ignore_errors=True)
            return err(400, 'Нет файла')
        S.jobs[job.id] = job
        S.queue.append(job)
        S.wake.set()
        log('задача', job.kind, job.id, 'от', k['name'], 'в очереди', len(S.queue))
        return web.json_response(job.view(S.pos(job)))

    def own(req, k):
        j = S.jobs.get(req.match_info['id'])
        if not j or j.key != k['key']:
            raise web.HTTPNotFound(text=json.dumps({'error': 'Задача не найдена'}), content_type='application/json')
        return j

    async def job_get(req):
        j = own(req, auth(req))
        return web.json_response(j.view(S.pos(j)))

    async def job_file(req):
        j = own(req, auth(req))
        name = req.match_info['name']
        if j.state != 'done' or not j.result or name not in j.result:
            return err(404, 'Результата нет')
        return web.FileResponse(j.result[name])

    async def job_delete(req):
        j = own(req, auth(req))
        if j.state == 'running':
            j.canceled = True
            if j.proc and j.proc.returncode is None:
                j.proc.kill()
        else:
            S.drop(j)
        return web.json_response({'ok': True})

    # кадр для выделения щелчками: присылается один раз, дальше — только точки
    async def frame_put(req):
        auth(req)
        fid = req.match_info['fid']
        if not re.fullmatch(r'[0-9a-f]{40}', fid):
            return err(400, 'Плохой id кадра')
        data = await req.read()
        if len(data) > 20 << 20 or hashlib.sha1(data).hexdigest() != fid:
            return err(400, 'Кадр повреждён')
        d = os.path.join(DATA, 'frames')
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, fid + '.img')
        with open(p, 'wb') as f:
            f.write(data)
        S.frames[fid] = p
        return web.json_response({'ok': True})

    async def mask(req):
        auth(req)
        q = await req.json()
        fid = q.get('fid', '')
        p = S.frames.get(fid)
        if not p or not os.path.exists(p):
            return err(409, 'need-frame')
        os.utime(p)
        if S.queue or S.state == 'busy':
            if S.gpu.locked():
                return err(503, 'Сервер занят чужой задачей — выделение будет доступно через минуту')
        try:
            png, score = await S.mask(p, q.get('pts') or [], q.get('box'))
        except Exception as e:
            return err(500, str(e)[-500:])
        return web.Response(body=png, content_type='image/png', headers={'X-Score': str(score)})

    app = web.Application(client_max_size=MAX_UPLOAD + (1 << 20))
    app.router.add_get('/api/status', status)
    app.router.add_post('/api/jobs', create)
    app.router.add_get('/api/jobs/{id}', job_get)
    app.router.add_get('/api/jobs/{id}/files/{name}', job_file)
    app.router.add_delete('/api/jobs/{id}', job_delete)
    app.router.add_put('/api/frames/{fid}', frame_put)
    app.router.add_post('/api/mask', mask)

    async def bg(app):
        app['w'] = asyncio.create_task(S.worker())
        app['j'] = asyncio.create_task(S.janitor())
        app['t'] = asyncio.create_task(tunnel(tunnel_port)) if tunnel_port else None
        yield
        app['w'].cancel(); app['j'].cancel()
        if app['t']:
            app['t'].cancel()
            await asyncio.gather(app['t'], return_exceptions=True)
            try:
                await asyncio.to_thread(announce, '')   # справочная: сервер выключен
            except Exception:
                pass
        await S.stop_serve()
    app.cleanup_ctx.append(bg)
    return app


def main():
    ap = argparse.ArgumentParser(description='Сервер нейросетей LinCut')
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve')
    s.add_argument('--host', default='0.0.0.0')
    s.add_argument('--port', type=int, default=8765)
    s.add_argument('--tunnel', action='store_true', help='доступ из интернета через Cloudflare Tunnel + справочная на сайте')
    k = sub.add_parser('keys')
    k.add_argument('action', choices=['add', 'list', 'revoke'])
    k.add_argument('name', nargs='?')
    sub.add_parser('pause'); sub.add_parser('resume'); sub.add_parser('status')
    o = ap.parse_args()
    if o.cmd == 'keys':
        K = Keys()
        if o.action == 'add':
            if not o.name:
                sys.exit('Укажите имя: keys add Вася')
            print(K.add(o.name)['key'])
        elif o.action == 'list':
            for x in K.d['keys']:
                print(f"{'ОТОЗВАН ' if x.get('revoked') else ''}{x['name']:<20} задач: {x.get('jobs', 0):<5} видеокарта: {x.get('gpu_sec', 0) / 60:.1f} мин   {x['key']}")
        else:
            n = 0
            for x in K.d['keys']:
                if o.name in (x['name'], x['key']):
                    x['revoked'] = True
                    n += 1
            K.save()
            print(f'Отозвано ключей: {n}')
        return
    if o.cmd in ('pause', 'resume'):
        st = jload(STATE, {})
        st['paused'] = o.cmd == 'pause'
        jsave(STATE, st)
        print('Пауза: новые задачи не берутся (текущая доделается)' if st['paused'] else 'Задачи снова принимаются')
        return
    if o.cmd == 'status':
        g = gpu_info()
        print('Пауза' if jload(STATE, {}).get('paused') else 'Работает', '·', f"{g['name']}, {g['temp']}°C, память {g['used']}/{g['mem']} МБ" if g else 'видеокарта не найдена')
        print('Ключей:', sum(1 for x in Keys().d['keys'] if not x.get('revoked')))
        return
    from aiohttp import web
    S = Server()
    log('сервер нейросетей LinCut на порту', o.port, '·', (gpu_info() or {}).get('name', 'без видеокарты'))
    if o.tunnel and not os.path.exists(SITE_SECRET):
        sys.exit('Нет ' + SITE_SECRET + ' — без него справочная не примет адрес')
    web.run_app(make_app(S, o.port if o.tunnel else None), host=o.host, port=o.port, print=None, access_log=None)


if __name__ == '__main__':
    main()
