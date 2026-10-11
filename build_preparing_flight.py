# Builds the "Preparing Flight" loading-video scene from scratch and renders it.
# Run in BACKGROUND Blender (does not touch any open file):
#   blender -b -P build_preparing_flight.py -- <repo_root>
#
# The game's own F-15 (public/models/f-15.glb), oriented nose=-Y, up=+Z,
# scaled to the real 19.43 m. Camera behind-and-below, jet silhouetted against
# a late-afternoon sky above a drifting cloud deck. Every animated property is
# either an integer number of sine cycles over the 144-frame loop or a
# modulo-wrapped treadmill of identical evenly spaced clusters, so frame 144
# flows into frame 1 with exactly one frame's worth of motion (seamless loop).

import bpy
import bmesh
import math
import mathutils
import os
import sys

_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
REPO = _args[0] if _args else "."
GLB = os.path.join(REPO, "public", "models", "f-15.glb")
OUT = os.path.join(REPO, "render-preparing")
FRAMES = 144
FPS = 24
RES_X, RES_Y = 1920, 1080
JET_LEN = 19.43  # real F-15C length, metres

bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------------- import jet
bpy.ops.import_scene.gltf(filepath=os.path.abspath(GLB))
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if not meshes:
    raise SystemExit("no meshes imported")
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data_clear()

# ------------------------------------------------------------ orient the jet
# glTF is Y-up; Blender's importer bakes the conversion, so after import the
# long axis is the one with the largest world extent. The tail end is the one
# the vertical stabilizers (highest vertices) sit at.
def world_bounds(objs):
    lo = mathutils.Vector((1e9, 1e9, 1e9))
    hi = mathutils.Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    return lo, hi

lo, hi = world_bounds(meshes)
ext = hi - lo
long_axis = max(range(3), key=lambda i: ext[i])
print("imported bbox", tuple(round(v, 2) for v in lo), tuple(round(v, 2) for v in hi),
      "long axis", "XYZ"[long_axis])

tops = []
for o in meshes:
    mx = o.matrix_world
    for v in o.data.vertices:
        tops.append(mx @ v.co)
tops.sort(key=lambda p: p.z, reverse=True)
top_mean = mathutils.Vector((0, 0, 0))
for p in tops[:12]:
    top_mean += p / 12.0
centre = (lo + hi) / 2
LA = "XYZ"[long_axis]
tail_sign = 1.0 if top_mean[long_axis] > centre[long_axis] else -1.0
print("tail (fins) side sign along long axis:", tail_sign)

# Parent ONLY the imported ROOT nodes to the rig; nested children keep
# their hierarchy (a child's local matrix is parent-relative — reparenting
# it directly with a world parent-inverse would collapse it).
roots = [o for o in bpy.data.objects if o.parent is None and o.type in {"MESH", "ARMATURE", "EMPTY"}]
rig = bpy.data.objects.new("JetRig", None)
rig.empty_display_size = 2
bpy.context.scene.collection.objects.link(rig)
rig.location = centre
for o in roots:
    o.parent = rig
    o.matrix_parent_inverse = rig.matrix_world.inverted()
bpy.context.view_layer.update()

if long_axis == 0:      # long axis along X -> rotate onto Y (tail toward +Y)
    rig.rotation_euler = (0, 0, math.radians(90 if tail_sign > 0 else -90))
elif long_axis == 1:    # already along Y; flip if the tail is at -Y
    if tail_sign < 0:
        rig.rotation_euler = (0, 0, math.pi)
else:
    raise SystemExit(f"unexpected long axis Z, bbox={lo}..{hi}")
bpy.context.view_layer.update()

lo2, hi2 = world_bounds(meshes)
s = JET_LEN / (hi2.y - lo2.y)
rig.scale = (s, s, s)
bpy.context.view_layer.update()
lo3, hi3 = world_bounds(meshes)
rig.location -= (lo3 + hi3) / 2
bpy.context.view_layer.update()
lo4, hi4 = world_bounds(meshes)
print("oriented jet bbox", tuple(round(v, 2) for v in lo4), "..",
      tuple(round(v, 2) for v in hi4))

# ------------------------------------------------------------------- clouds
# Lanes of IDENTICAL puff clusters, evenly spaced S apart. Each cluster drifts
# exactly one lane-span over the loop with modulo wrap, so the field is both
# periodic and gapless (frame 144 -> frame 1 looks like one more frame).
def make_puff(name, seed, n_balls, radius, z_squash):
    import random
    random.seed(seed)
    bm = bmesh.new()
    for i in range(n_balls):
        r = radius * random.uniform(0.42, 1.0)
        off = mathutils.Vector((
            random.uniform(-1, 1) * radius * 1.35,
            random.uniform(-1, 1) * radius * 0.85,
            random.uniform(-0.35, 0.65) * radius * z_squash,
        ))
        bmesh.ops.create_icosphere(bm, subdivisions=3, radius=r,
                                   matrix=mathutils.Matrix.Translation(off))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me

def make_puff_object(name, seed, n_balls, radius, z_squash):
    me = make_puff(name, seed, n_balls, radius, z_squash)
    ob = bpy.data.objects.new(name, me)
    mod = ob.modifiers.new("disp", "DISPLACE")
    tex = bpy.data.textures.new(f"{name}Noise", "CLOUDS")
    tex.noise_type = "SOFT_NOISE"
    tex.noise_scale = 0.55
    mod.texture = tex
    mod.strength = radius * 0.18
    return ob

cloud_mat = bpy.data.materials.new("CloudPuff")
bsdf = cloud_mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.94, 0.96, 1.0, 1.0)
bsdf.inputs["Roughness"].default_value = 1.0

lanes = [
    # (z, spacing S, count N, puff radius, x offset, z_squash)
    (-58, 170, 8, 42, 0, 0.45),
    (-62, 170, 8, 52, -140, 0.42),
    (-66, 170, 8, 46, 150, 0.45),
    (-30, 240, 6, 26, -90, 0.55),
    (-34, 240, 6, 30, 130, 0.5),
]
for li, (z, S, N, radius, xoff, sq) in enumerate(lanes):
    proto = make_puff_object(f"Puff{li}", 100 + li, 9, radius, sq)
    proto.data.materials.append(cloud_mat)
    span = N * S
    vpf = span / FRAMES  # full lane round-trip per loop
    for i in range(N):
        ob = proto if i == 0 else proto.copy()
        ob.name = f"Cloud_{li}_{i}"
        ob.rotation_euler = (0, 0, 0)
        ob.location = (xoff, 0, z)
        bpy.context.scene.collection.objects.link(ob)
        y0 = i * S - span / 2 + S / 2
        ob.location.y = y0
        drv = ob.driver_add("location", 1)
        d = drv.driver
        d.type = "SCRIPTED"
        d.expression = f"(({y0!r} + (frame-1)*{vpf!r}) % {span!r}) - {span / 2!r}"
print("cloud lanes:", lanes)

# ground haze plane far below (cloud tops merging into distance)
def make_quad(name, w, h, location, rotation=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(
        [(-w, -h, 0), (w, -h, 0), (w, h, 0), (-w, h, 0)],
        [],
        [(0, 1, 2, 3)],
    )
    ob = bpy.data.objects.new(name, me)
    ob.location = location
    if rotation:
        ob.rotation_euler = rotation
    bpy.context.scene.collection.objects.link(ob)
    return ob

haze_ob = make_quad("HazePlane", 3000, 3000, (0, -600, -78))
haze_mat = bpy.data.materials.new("HazeMat")
hb = haze_mat.node_tree.nodes["Principled BSDF"]
hb.inputs["Base Color"].default_value = (0.75, 0.8, 0.92, 1.0)
hb.inputs["Roughness"].default_value = 1.0
haze_ob.data.materials.append(haze_mat)

# ------------------------------------------------------------ afterburners
def make_cone(name, x, y, z, length, radius, color, strength):
    bm = bmesh.new()
    mat4 = (mathutils.Matrix.Translation((x, y + length / 2, z))
            @ mathutils.Matrix.Rotation(-math.pi / 2, 4, "X"))
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=24,
                          radius1=radius, radius2=radius * 0.22,
                          depth=length, matrix=mat4)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    mat = bpy.data.materials.new(name + "Mat")
    em = mat.node_tree.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = color
    em.inputs["Strength"].default_value = strength
    out = mat.node_tree.nodes["Material Output"]
    mat.node_tree.links.new(em.outputs[0], out.inputs[0])
    ob.data.materials.append(mat)
    return em

tail_y = hi4.y
noz_z = (lo4.z + hi4.z) / 2 + 0.1
burners = [
    make_cone("BurnerL", -0.72, tail_y - 0.25, noz_z, 3.2, 0.30, (1.0, 0.62, 0.22, 1.0), 26),
    make_cone("BurnerR", 0.72, tail_y - 0.25, noz_z, 3.2, 0.30, (1.0, 0.62, 0.22, 1.0), 26),
    make_cone("BurnerCoreL", -0.72, tail_y - 0.25, noz_z, 1.7, 0.20, (1.0, 0.92, 0.75, 1.0), 60),
    make_cone("BurnerCoreR", 0.72, tail_y - 0.25, noz_z, 1.7, 0.20, (1.0, 0.92, 0.75, 1.0), 60),
]
for em in burners:
    base = em.inputs["Strength"].default_value
    drv = em.inputs["Strength"].driver_add("default_value")
    d = drv.driver
    d.type = "SCRIPTED"
    d.expression = (f"{base!r} * (1 + 0.18*sin(2*pi*4*(frame-1)/{FRAMES}) "
                   f"+ 0.10*sin(2*pi*7*(frame-1)/{FRAMES}))")

# ---------------------------------------------------------- jet + cam motion
# bank/pitch/bob: integer sine cycles over the loop -> frame 144 == frame 1.
def cyc(freq, phase, amp):
    return f"{amp!r}*sin(2*pi*{freq!r}*(frame-1)/{FRAMES}+{phase!r})"

rig.rotation_mode = "XYZ"
for idx, freq, phase, amp in ((2, 1, 0.0, math.radians(11)),
                              (0, 2, 1.3, math.radians(2.5))):
    base = rig.rotation_euler[idx]
    drv = rig.driver_add("rotation_euler", idx)
    d = drv.driver
    d.type = "SCRIPTED"
    d.expression = f"{base!r} + " + cyc(freq, phase, amp)
zdrv = rig.driver_add("location", 2)
dz = zdrv.driver
dz.type = "SCRIPTED"
dz.expression = f"{rig.location.z!r} + " + cyc(2, 0.7, 0.35)

cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 32
cam = bpy.data.objects.new("Cam", cam_data)
cam.location = (7.5, 34, -4.5)
direction = mathutils.Vector((0, 0, 0.9)) - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.collection.objects.link(cam)

cam_rig = bpy.data.objects.new("CamRig", None)
bpy.context.scene.collection.objects.link(cam_rig)
cam.parent = cam_rig
cam.matrix_parent_inverse = cam_rig.matrix_world.inverted()
for idx, freq, phase, amp in ((2, 1, 0.5, math.radians(1.4)),
                              (0, 3, 2.1, math.radians(0.8))):
    base = cam_rig.rotation_euler[idx]
    drv = cam_rig.driver_add("rotation_euler", idx)
    d = drv.driver
    d.type = "SCRIPTED"
    d.expression = f"{base!r} + " + cyc(freq, phase, amp)

# ------------------------------------------------------------------- lights
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = 4.0
sun.data.color = (1.0, 0.86, 0.62)  # late afternoon
sun.location = (-60, -120, 30)
sun.rotation_euler = (-sun.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.collection.objects.link(sun)

rim = bpy.data.objects.new("Rim", bpy.data.lights.new("Rim", "SUN"))
rim.data.energy = 1.6
rim.data.color = (0.55, 0.72, 1.0)  # cool back fill from behind-right
rim.location = (80, 140, 10)
rim.rotation_euler = (-rim.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.collection.objects.link(rim)

# ------------------------------------------------------------- world + sky
world = bpy.data.worlds.new("Sky")
ntw = world.node_tree
ntw.nodes.remove(ntw.nodes["Background"])
out = ntw.nodes["World Output"]
texco = ntw.nodes.new("ShaderNodeTexCoord")
sep = ntw.nodes.new("ShaderNodeSeparateXYZ")
map_range = ntw.nodes.new("ShaderNodeMapRange")
map_range.inputs["From Min"].default_value = -0.35
map_range.inputs["From Max"].default_value = 0.45
map_range.inputs["To Min"].default_value = 0.0
map_range.inputs["To Max"].default_value = 1.0
sky_top = ntw.nodes.new("ShaderNodeRGB")
sky_top.outputs[0].default_value = (0.10, 0.18, 0.42, 1.0)
sky_hor = ntw.nodes.new("ShaderNodeRGB")
sky_hor.outputs[0].default_value = (0.98, 0.62, 0.30, 1.0)
mix = ntw.nodes.new("ShaderNodeMix")
mix.data_type = "RGBA"
bgf = ntw.nodes.new("ShaderNodeBackground")
bgf.inputs["Strength"].default_value = 1.0
# The Mix node has one socket set per data type with DUPLICATED names —
# select by socket TYPE so the RGBA pair and the VALUE factor are exact.
mix_factor = next(s for s in mix.inputs if s.name == "Factor" and s.type == "VALUE")
mix_a = next(s for s in mix.inputs if s.name == "A" and s.type == "RGBA")
mix_b = next(s for s in mix.inputs if s.name == "B" and s.type == "RGBA")
mix_result = next(s for s in mix.outputs if s.name == "Result" and s.type == "RGBA")
ntw.links.new(texco.outputs["Generated"], sep.inputs[0])
ntw.links.new(sep.outputs["Z"], map_range.inputs["Value"])
ntw.links.new(map_range.outputs[0], mix_factor)
ntw.links.new(sky_top.outputs[0], mix_a)
ntw.links.new(sky_hor.outputs[0], mix_b)
ntw.links.new(mix_result, bgf.inputs["Color"])
ntw.links.new(bgf.outputs[0], out.inputs["Surface"])
bpy.context.scene.world = world

# warm horizon glow blob ahead of (and below) the jet, where the camera looks
glow = make_quad("GlowPlane", 900, 900, (0, -1900, -120),
                 rotation=(math.radians(72), 0, 0))
gm = bpy.data.materials.new("GlowMat")
gem = gm.node_tree.nodes.new("ShaderNodeEmission")
gem.inputs["Color"].default_value = (1.0, 0.55, 0.22, 1.0)
gem.inputs["Strength"].default_value = 1.35
gout = gm.node_tree.nodes["Material Output"]
gm.node_tree.links.new(gem.outputs[0], gout.inputs[0])
glow.data.materials.append(gm)

# ------------------------------------------------------------------ render
sc = bpy.context.scene
sc.frame_start, sc.frame_end = 1, FRAMES
sc.render.fps = FPS
sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
sc.render.engine = "BLENDER_EEVEE"
sc.eevee.taa_render_samples = 96
sc.render.film_transparent = False
os.makedirs(OUT, exist_ok=True)
sc.render.filepath = os.path.join(OUT, "frame_")
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGB"
sc.camera = cam

# numeric framing check: jet projected into camera NDC at key frames
import bpy_extras
for f in (1, 72, 144):
    sc.frame_set(f)
    bpy.context.view_layer.update()
    lo5, hi5 = world_bounds(meshes)
    ndc = []
    for corner in ((lo5.x, lo5.y, lo5.z), (hi5.x, hi5.y, hi5.z),
                   (lo5.x, hi5.y, hi5.z), (hi5.x, lo5.y, hi5.z)):
        p = bpy_extras.object_utils.world_to_camera_view(
            sc, cam, mathutils.Vector(corner))
        ndc.append((round(p.x, 3), round(p.y, 3)))
    xs = [n[0] for n in ndc]
    ys = [n[1] for n in ndc]
    print(f"frame {f}: jet NDC x [{min(xs):.2f}..{max(xs):.2f}] "
          f"y [{min(ys):.2f}..{max(ys):.2f}]")

bpy.ops.render.render(animation=True)
print("RENDER DONE ->", OUT)
