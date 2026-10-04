# Огненный взрыв на чёрном фоне для эффекта «Взрыв» (кладётся «экраном»).
# Процедурный объём: шар с 4D-шумом расширяется, поднимается и остывает (белое ядро → оранжевый → тёмный дым).
import bpy, math, sys, os
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0]; RX, RY = int(argv[1]), int(argv[2])
ONLY = [int(x) for x in argv[3].split(',')] if len(argv) > 3 and argv[3] else None
SAMPLES = int(os.environ.get('SAMPLES', '32')); FR = 60

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'; prefs.get_devices()
for d in prefs.devices: d.use = d.type == 'OPTIX'
sc.cycles.device = 'GPU'; sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = True
sc.cycles.volume_bounces = 1; sc.cycles.volume_step_rate = 1.0
sc.render.resolution_x, sc.render.resolution_y = RX, RY
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'
sc.view_settings.view_transform = 'Standard'
world = bpy.data.worlds.new('w'); world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0, 0, 0, 1)
sc.world = world

bpy.ops.mesh.primitive_cube_add(size=8, location=(0, 0, 0))
box = bpy.context.active_object

mat = bpy.data.materials.new('boom'); mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes): nt.nodes.remove(n)
N = nt.nodes.new; Lk = nt.links.new
out = N('ShaderNodeOutputMaterial'); pv = N('ShaderNodeVolumePrincipled'); Lk(pv.outputs['Volume'], out.inputs['Volume'])
def val(name, v):
    n = N('ShaderNodeValue'); n.name = name; n.outputs[0].default_value = v; return n
vW, vR, vRise, vDen, vHeat, vEm = val('W', 0), val('R', 0.2), val('rise', 0), val('den', 1), val('heat', 1), val('em', 30)
tc = N('ShaderNodeTexCoord')
def math_(op, a, b=None, c=None):
    m = N('ShaderNodeMath'); m.operation = op
    for i, x in enumerate((a, b, c)):
        if x is None: continue
        if isinstance(x, (int, float)): m.inputs[i].default_value = x
        else: Lk(x, m.inputs[i])
    return m.outputs[0]
def vmath(op, a, b=None, s=None):
    m = N('ShaderNodeVectorMath'); m.operation = op
    for i, x in enumerate((a, b)):
        if x is None: continue
        if isinstance(x, tuple): m.inputs[i].default_value = x
        else: Lk(x, m.inputs[i])
    if s is not None: m.inputs['Scale'].default_value = s
    return m.outputs['Vector'] if op != 'LENGTH' else m.outputs['Value']
# подъём: центр шара уезжает вверх
comb = N('ShaderNodeCombineXYZ'); Lk(vRise.outputs[0], comb.inputs['Z'])
p = vmath('SUBTRACT', tc.outputs['Object'], comb.outputs['Vector'])
# крупный шум — «клубы», мелкий — языки
n1 = N('ShaderNodeTexNoise'); n1.noise_dimensions = '4D'; n1.inputs['Scale'].default_value = 2.2; n1.inputs['Detail'].default_value = 8; n1.inputs['Roughness'].default_value = 0.65
Lk(p, n1.inputs['Vector']); Lk(vW.outputs[0], n1.inputs['W'])
d1 = vmath('SCALE', vmath('SUBTRACT', n1.outputs['Color'], (0.5, 0.5, 0.5)), s=2.2)
q = vmath('ADD', p, d1)
# несколько огненных шаров, разлетающихся от центра: расстояние до ближайшего (в долях его радиуса)
import random
rr = random.Random(5)
rn = None
for i in range(9):
    th, ph = rr.uniform(0, 2 * math.pi), math.acos(rr.uniform(-0.6, 1))
    k = 0 if i == 0 else rr.uniform(0.35, 0.62)
    c = (math.sin(ph) * math.cos(th) * k, math.sin(ph) * math.sin(th) * k * 0.6, math.cos(ph) * k)
    r = 0.62 if i == 0 else rr.uniform(0.36, 0.5)
    cv = vmath('SCALE', N('ShaderNodeCombineXYZ').outputs[0], s=1)  # заглушка, заменим ниже
    cc = N('ShaderNodeCombineXYZ')
    for ax, v in zip('XYZ', c): cc.inputs[ax].default_value = v
    cr = vmath('SCALE', cc.outputs['Vector'], None)
    Lk(vR.outputs[0], cr.node.inputs['Scale'])
    di = math_('DIVIDE', vmath('LENGTH', vmath('SUBTRACT', q, cr)), math_('MULTIPLY', vR.outputs[0], r))
    rn = di if rn is None else math_('MINIMUM', rn, di)
edge = N('ShaderNodeMapRange'); edge.interpolation_type = 'SMOOTHSTEP'
Lk(rn, edge.inputs['Value']); edge.inputs['From Min'].default_value = 0.72; edge.inputs['From Max'].default_value = 1.0
edge.inputs['To Min'].default_value = 1.0; edge.inputs['To Max'].default_value = 0.0
n2 = N('ShaderNodeTexNoise'); n2.noise_dimensions = '4D'; n2.inputs['Scale'].default_value = 4.0; n2.inputs['Detail'].default_value = 10; n2.inputs['Roughness'].default_value = 0.7
Lk(q, n2.inputs['Vector']); Lk(vW.outputs[0], n2.inputs['W'])
cl = N('ShaderNodeMapRange'); cl.interpolation_type = 'SMOOTHSTEP'; Lk(n2.outputs['Fac'], cl.inputs['Value'])
cl.inputs['From Min'].default_value = 0.38; cl.inputs['From Max'].default_value = 0.68
clump = cl.outputs['Result']
dens = math_('MULTIPLY', math_('MULTIPLY', edge.outputs['Result'], vDen.outputs[0]), math_('ADD', math_('MULTIPLY', clump, 1.6), 0.15))
Lk(dens, pv.inputs['Density'])
pv.inputs['Color'].default_value = (0.03, 0.025, 0.02, 1)
# жар: сильнее к центру и в «клубах», остывает со временем
core = math_('POWER', math_('SUBTRACT', 1.0, math_('MINIMUM', rn, 1.0)), 1.2)
heat = math_('MULTIPLY', math_('MULTIPLY', core, vHeat.outputs[0]), math_('ADD', math_('MULTIPLY', clump, 1.3), 0.25))
temp = N('ShaderNodeMapRange'); Lk(heat, temp.inputs['Value'])
temp.inputs['From Min'].default_value = 0; temp.inputs['From Max'].default_value = 1
temp.inputs['To Min'].default_value = 900; temp.inputs['To Max'].default_value = 5200
bb = N('ShaderNodeBlackbody'); Lk(temp.outputs['Result'], bb.inputs['Temperature']); Lk(bb.outputs['Color'], pv.inputs['Emission Color'])
Lk(math_('MULTIPLY', math_('MULTIPLY', heat, edge.outputs['Result']), vEm.outputs[0]), pv.inputs['Emission Strength'])
box.data.materials.append(mat)

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 6.4
cam.location = (0, -12, 0.3); cam.rotation_euler = (math.pi / 2, 0, 0)
sc.collection.objects.link(cam); sc.camera = cam

def anim(f):
    t = f / (FR - 1)
    grow = 1 - (1 - min(1, t / 0.45)) ** 3
    vR.outputs[0].default_value = 0.15 + 1.2 * grow + 0.25 * t
    vRise.outputs[0].default_value = 0.6 * t * t
    vW.outputs[0].default_value = 0.2 + 1.6 * t
    vHeat.outputs[0].default_value = math.exp(-2.8 * t) * (0.6 + 0.4 * min(1, t / 0.06))
    vDen.outputs[0].default_value = 2.5 * (1 - 0.5 * t)
    vEm.outputs[0].default_value = 8 * math.exp(-2.4 * t) * min(1, 0.4 + t / 0.05)

os.makedirs(OUT, exist_ok=True)
for f in (ONLY if ONLY is not None else range(FR)):
    anim(f)
    sc.render.filepath = os.path.join(OUT, f'{f:04d}.png')
    if os.path.exists(sc.render.filepath) and os.environ.get('RESUME'): continue
    bpy.ops.render.render(write_still=True)
    print('FRAME', f, flush=True)
