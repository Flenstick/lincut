# Театральный занавес для эффекта «Время показа»: 48 кадров, шторы разъезжаются и уходят за кадр.
import bpy, math, sys, os, random
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0]; FR = int(argv[1]) if len(argv) > 1 else 48
RX, RY = (int(argv[2]), int(argv[3])) if len(argv) > 3 else (1920, 1080)
ONLY = [int(x) for x in argv[4].split(',')] if len(argv) > 4 else None
SAMPLES = int(os.environ.get('SAMPLES', '96'))

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'; prefs.get_devices()
for d in prefs.devices: d.use = d.type == 'OPTIX'
sc.cycles.device = 'GPU'
sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = True
sc.render.film_transparent = True
sc.render.resolution_x, sc.render.resolution_y = RX, RY
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
sc.view_settings.view_transform = 'Standard'

# камера: ортографическая, кадр 16×9 единиц
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 16
cam.location = (0, -20, 0); cam.rotation_euler = (math.pi / 2, 0, 0)
sc.collection.objects.link(cam); sc.camera = cam

# свет: сверху-спереди тёплый прожектор + мягкий заполняющий
def light(kind, loc, rot, energy, color, size=None, spot=None):
    L = bpy.data.lights.new(kind, kind); L.energy = energy; L.color = color
    if size is not None: L.size = size
    if spot is not None: L.spot_size = spot; L.spot_blend = 0.6
    o = bpy.data.objects.new(kind, L); o.location = loc; o.rotation_euler = rot
    sc.collection.objects.link(o)
# прожектор сверху-спереди (круг света по центру), два боковых скользящих — рисуют складки
light('SPOT', (0, -16, 6), (math.radians(70), 0, 0), 14000, (1.0, 0.88, 0.72), spot=math.radians(48))
light('SPOT', (-14, -6, 3), (math.radians(80), 0, math.radians(-68)), 6000, (1.0, 0.75, 0.6), spot=math.radians(70))
light('SPOT', (14, -6, 3), (math.radians(80), 0, math.radians(68)), 6000, (1.0, 0.75, 0.6), spot=math.radians(70))

# бархат
mat = bpy.data.materials.new('velvet'); mat.use_nodes = True
nt = mat.node_tree; bsdf = nt.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (0.2, 0.002, 0.006, 1)
bsdf.inputs['Roughness'].default_value = 0.62
bsdf.inputs['Sheen Weight'].default_value = 0.6
bsdf.inputs['Sheen Roughness'].default_value = 0.35
bsdf.inputs['Sheen Tint'].default_value = (0.9, 0.25, 0.25, 1)
# лёгкая неровность ткани
tex = nt.nodes.new('ShaderNodeTexNoise'); tex.inputs['Scale'].default_value = 90; tex.inputs['Detail'].default_value = 6
bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.08
nt.links.new(tex.outputs['Fac'], bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

NU, NV, K = 320, 90, 13  # сетка и число складок на полотне
TOP, BOT = 4.9, -4.9
def ease(x): x = min(1, max(0, x)); return x * x * (3 - 2 * x)
rnd = random.Random(7)
phase = [rnd.uniform(0, 1) for _ in range(8)]

def panel(side):
    me = bpy.data.meshes.new('curtain')
    verts, faces = [], []
    for j in range(NV + 1):
        for i in range(NU + 1): verts.append((0, 0, 0))
    for j in range(NV):
        for i in range(NU):
            a = j * (NU + 1) + i; faces.append((a, a + 1, a + NU + 2, a + NU + 1))
    me.from_pydata(verts, [], faces); me.update()
    for p in me.polygons: p.use_smooth = True
    o = bpy.data.objects.new('curtain', me); o.data.materials.append(mat)
    sc.collection.objects.link(o)
    return o

def shape(o, side, t):
    # t 0..1 — ход открытия; низ отстаёт от верха
    me = o.data
    for j in range(NV + 1):
        v = j / NV; y = BOT + (TOP - BOT) * v
        p = ease((t - 0.14 * (1 - v)) / 0.86)
        w = 8.6 * (1 - p) + 2.2 * p            # ширина собранного полотна
        xi = 0.25 - 10.8 * p                   # внутренний край уходит за кадр
        A = 0.2 + 0.3 * p                    # складки глубже, когда полотно собрано
        sway = 0.12 * math.sin(math.pi * p) * (1 - v) ** 2
        for i in range(NU + 1):
            u = i / NU                          # 0 — внешний край, 1 — внутренний
            x = xi - (1 - u) * w + sway
            f = 2 * math.pi * K * (u + 0.025 * math.sin(2 * math.pi * 3 * u + phase[2]) + 0.012 * math.sin(2 * math.pi * 7 * u + phase[3]))
            z = A * (math.sin(f + phase[0]) + 0.35 * math.sin(2.3 * f + phase[1]) * (0.6 + 0.4 * v)) + 0.04 * math.sin(7 * v + 11 * u)
            # нижний край — чуть волнистый подол
            yy = y + (0.05 * math.sin(f) if j == 0 else 0)
            idx = j * (NU + 1) + i
            me.vertices[idx].co = (side * -x, z - 0.5, yy)
    me.update()

L, R = panel(1), panel(-1)
os.makedirs(OUT, exist_ok=True)
frames = ONLY if ONLY is not None else range(FR)
for f in frames:
    t = f / (FR - 1)
    shape(L, 1, t); shape(R, -1, t)
    sc.render.filepath = os.path.join(OUT, f'{f:04d}.png')
    if os.path.exists(sc.render.filepath) and os.environ.get('RESUME'): continue
    bpy.ops.render.render(write_still=True)
    print('FRAME', f, flush=True)
