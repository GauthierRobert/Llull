"""
Blender Cycles reference for a llull path-trace job folder (RV1 §5b wire contract, §7 layer V3).

    blender -b --factory-startup -P quality/render/cycles_from_job.py -- <job-folder> <out.exr> <spp> [--seed N] [--threads N] [--filter PX]

Reads job.json + positions.f32 / normals.f32 / uvs.f32 / indices.u32 / instances.f64 + tex-<i>.* and builds the same scene in Cycles:

- geometry: one Blender mesh per job mesh (custom split normals = the job normals, the job UVs), one object per instance row sharing
  that mesh (a linked duplicate) with the 3x4 affine as its world matrix; lengths scaled by unitMetres to metres (Blender unit = 1 m);
- materials: Principled BSDF (Blender 4.x) with the job's base colour / metalness / roughness / transmission / ior / coat / coat
  roughness / emission (radiance, strength 1), each an optional image texture x factor (glTF style, first channel for scalars),
  distribution "GGX" (not multiscatter: llull is single-scatter GGX), material linked per object;
- camera: perspective (vertical fovY, sensor fit vertical) or orthographic (orthoHeight), thin lens (f-stop from apertureRadius);
- lights with the same radiometry (factors below, measured with the one-light calibration scenes of quality/render-reference.json),
  hidden from camera rays as llull's are;
- world: uniform colour x intensity, the default uniform 0.3, or the HDR equirect with llull's orientation (the same mapping as Cycles'
  equirectangular lookup; rotation through a Mapping node). The Preetham sky has no Cycles counterpart and is refused;
- film: Blackman-Harris filter of width 1.5 px (matched on an edge: a sharp plate edge half a pixel off the pixel grid reads 0.140 / 0.889
  in llull's tent of radius 1 px and 0.133 / 0.895 in Cycles at 1.5 px; 2.0 px gives 0.20 / 0.82 and 2.95 px, the width whose
  variance equals the tent's on paper, 0.29 / 0.74), no denoiser, no clamping, no adaptive
  sampling, blur glossy 0, light threshold 0, caustics on; bounces = maxBounces - 1 (llull counts scattering events, Cycles bounces
  after the first hit); view transform Standard; output a 32-bit float linear OpenEXR (RGBA).

Radiometry (llull §5b -> Blender 4.0, measured with the one-light cal-* scenes of quality/render-reference.json on a pure Lambert
plate (ior 1), mean luminance within 0.02 %; docs/QUALITY_GATES.md "Render reference gate"): every factor is 1.
- sun: irradiance E W/m2 = Blender sun strength; angle = 2 x angularRadius.
- point / spot: llull power P (intensity P / 4pi W/sr, sphere radiance P / (4 pi^2 r^2)) = Blender point / spot power in W; spot_size =
  coneAngle (full), spot_blend = blend (both smoothstep over (1 - cos half) x blend).
- area: llull power P (radiance P / (pi A), one-sided) = Blender area power in W (spread 180 degrees).
"""

import json
import math
import os
import sys
from array import array

import bpy  # pylint: disable=import-error
from mathutils import Matrix, Vector  # pylint: disable=import-error

# Blender light power per llull light power (see the module comment).
POWER_FACTOR = {'sun': 1.0, 'point': 1.0, 'spot': 1.0, 'area': 1.0}
FILTER_WIDTH_PX = 1.5


def arguments():
    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    if len(argv) < 3:
        raise SystemExit('usage: blender -b -P cycles_from_job.py -- <job-folder> <out.exr> <spp> [--seed N] [--threads N]')
    options = {'seed': 0, 'threads': 0, 'filter': FILTER_WIDTH_PX}
    rest = argv[3:]
    for index in range(0, len(rest) - 1, 2):
        options[rest[index].lstrip('-')] = float(rest[index + 1])
    return argv[0], argv[1], int(argv[2]), options


def read_array(folder, name, code):
    values = array(code)
    with open(os.path.join(folder, name), 'rb') as handle:
        values.frombytes(handle.read())
    if sys.byteorder != 'little':
        values.byteswap()
    return values


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    return scene


def build_mesh(index, record, positions, normals, uvs, indices, unit):
    vo, vc, io, ic = record['vertexOffset'], record['vertexCount'], record['indexOffset'], record['indexCount']
    mesh = bpy.data.meshes.new(f'mesh-{index}')
    co = array('f', (positions[3 * vo + k] * unit for k in range(3 * vc)))
    triangles = ic // 3
    loops = array('i', (indices[io + k] for k in range(ic)))
    mesh.vertices.add(vc)
    mesh.vertices.foreach_set('co', co)
    mesh.loops.add(ic)
    mesh.loops.foreach_set('vertex_index', loops)
    mesh.polygons.add(triangles)
    mesh.polygons.foreach_set('loop_start', array('i', range(0, ic, 3)))
    mesh.polygons.foreach_set('use_smooth', array('b', [1]) * triangles)
    uv_layer = mesh.uv_layers.new(name='UVMap')
    uv_layer.data.foreach_set('uv', array('f', (uvs[2 * (vo + loops[k]) + c] for k in range(ic) for c in range(2))))
    mesh.update(calc_edges=True)
    if hasattr(mesh, 'use_auto_smooth'):
        mesh.use_auto_smooth = True
        mesh.auto_smooth_angle = math.pi
    vertex_normals = [tuple(normals[3 * (vo + v) + k] for k in range(3)) for v in range(vc)]
    mesh.normals_split_custom_set_from_vertices(vertex_normals)
    mesh.materials.append(None)
    return mesh


def load_images(folder, textures):
    images = []
    for texture in textures:
        image = bpy.data.images.load(os.path.join(folder, texture['file']), check_existing=False)
        image.colorspace_settings.name = 'sRGB' if texture['colorSpace'] == 'srgb' and texture['format'] != 'hdr' else 'Non-Color'
        if texture['format'] == 'hdr':
            image.colorspace_settings.name = 'Linear Rec.709'
        images.append(image)
    return images


class MaterialBuilder:
    def __init__(self, material, images):
        self.material = material
        self.images = images
        material.use_nodes = True
        self.tree = material.node_tree
        self.nodes = self.tree.nodes
        self.links = self.tree.links
        self.bsdf = self.nodes['Principled BSDF']
        self.bsdf.distribution = 'GGX'
        self.uv = self.nodes.new('ShaderNodeUVMap')
        self.uv.uv_map = 'UVMap'

    def image(self, index):
        node = self.nodes.new('ShaderNodeTexImage')
        node.image = self.images[index]
        node.interpolation = 'Linear'
        node.extension = 'REPEAT'
        self.links.new(self.uv.outputs['UV'], node.inputs['Vector'])
        return node

    def colour(self, socket, value, texture):
        rgba = (value[0], value[1], value[2], 1.0)
        if texture is None:
            self.bsdf.inputs[socket].default_value = rgba
            return
        mix = self.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        self.links.new(self.image(texture).outputs['Color'], mix.inputs['A'])
        mix.inputs['B'].default_value = rgba
        self.links.new(mix.outputs['Result'], self.bsdf.inputs[socket])

    def scalar(self, socket, value, texture):
        if texture is None:
            self.bsdf.inputs[socket].default_value = value
            return
        split = self.nodes.new('ShaderNodeSeparateColor')
        self.links.new(self.image(texture).outputs['Color'], split.inputs['Color'])
        multiply = self.nodes.new('ShaderNodeMath')
        multiply.operation = 'MULTIPLY'
        multiply.inputs[1].default_value = value
        self.links.new(split.outputs['Red'], multiply.inputs[0])
        self.links.new(multiply.outputs['Value'], self.bsdf.inputs[socket])

    def normal(self, texture, strength):
        node = self.nodes.new('ShaderNodeNormalMap')
        node.space = 'TANGENT'
        node.uv_map = 'UVMap'
        node.inputs['Strength'].default_value = strength
        self.links.new(self.image(texture).outputs['Color'], node.inputs['Color'])
        self.links.new(node.outputs['Normal'], self.bsdf.inputs['Normal'])


def build_material(index, record, images):
    material = bpy.data.materials.new(f'material-{index}')
    builder = MaterialBuilder(material, images)
    builder.colour('Base Color', record['baseColor'], record.get('baseColorTexture'))
    builder.scalar('Metallic', record['metalness'], record.get('metalnessTexture'))
    builder.scalar('Roughness', record['roughness'], record.get('roughnessTexture'))
    builder.scalar('Transmission Weight', record['transmission'], record.get('transmissionTexture'))
    builder.scalar('Coat Weight', record['coat'], record.get('coatTexture'))
    builder.bsdf.inputs['Coat Roughness'].default_value = record['coatRoughness']
    builder.bsdf.inputs['Coat IOR'].default_value = 1.5
    builder.bsdf.inputs['IOR'].default_value = record['ior']
    builder.bsdf.inputs['Specular IOR Level'].default_value = 0.5
    if record.get('normalTexture') is not None:
        builder.normal(record['normalTexture'], record.get('normalScale', 1.0))
    emission = record['emission']
    builder.colour('Emission Color', emission, record.get('emissionTexture'))
    builder.bsdf.inputs['Emission Strength'].default_value = 1.0 if (max(emission) > 0 or record.get('emissionTexture') is not None) else 0.0
    return material


def place_instances(folder, job, meshes, materials, unit):
    rows = read_array(folder, 'instances.f64', 'd')
    collection = bpy.context.scene.collection
    for row in range(job['instanceCount']):
        base = 14 * row
        mesh_index, material_index = int(rows[base]), int(rows[base + 1])
        m = rows[base + 2 : base + 14]
        obj = bpy.data.objects.new(f'instance-{row}', meshes[mesh_index])
        obj.matrix_world = Matrix(
            ((m[0], m[1], m[2], m[3] * unit), (m[4], m[5], m[6], m[7] * unit), (m[8], m[9], m[10], m[11] * unit), (0, 0, 0, 1))
        )
        obj.material_slots[0].link = 'OBJECT'
        obj.material_slots[0].material = materials[material_index]
        collection.objects.link(obj)


def orient(obj, z_axis, x_hint=None):
    """World matrix rotation whose local +Z is z_axis (and local +X along x_hint when given)."""
    z = Vector(z_axis).normalized()
    x = Vector(x_hint) if x_hint is not None else (Vector((1, 0, 0)) if abs(z.x) < 0.9 else Vector((0, 1, 0)))
    x = (x - z * x.dot(z)).normalized()
    y = z.cross(x)
    rotation = Matrix(((x.x, y.x, z.x), (x.y, y.y, z.y), (x.z, y.z, z.z)))
    obj.matrix_world = rotation.to_4x4() @ Matrix.Identity(4)
    return rotation


def place(obj, position, unit):
    obj.matrix_world.translation = Vector(position) * unit


def split_rgb(rgb):
    peak = max(rgb)
    return (0.0, (1.0, 1.0, 1.0)) if peak <= 0 else (peak, tuple(c / peak for c in rgb))


def set_shadow(data, cast):
    if hasattr(data, 'use_shadow'):
        data.use_shadow = cast
    elif hasattr(data, 'cycles') and hasattr(data.cycles, 'cast_shadow'):
        data.cycles.cast_shadow = cast


def add_light(index, light, unit):
    kind = light['type']
    data = bpy.data.lights.new(f'light-{index}', type={'sun': 'SUN', 'point': 'POINT', 'spot': 'SPOT', 'area': 'AREA'}[kind])
    strength, colour = split_rgb(light['irradiance'] if kind == 'sun' else light['power'])
    data.energy = strength * POWER_FACTOR[kind]
    data.color = colour
    set_shadow(data, light.get('castShadows', True))
    obj = bpy.data.objects.new(f'light-{index}', data)
    obj.visible_camera = False
    if kind == 'sun':
        data.angle = 2.0 * light['angularRadius']
        orient(obj, light['direction'])
    elif kind in ('point', 'spot'):
        data.shadow_soft_size = light['radius'] * unit
        if kind == 'spot':
            data.spot_size = light['coneAngle']
            data.spot_blend = light['blend']
            data.show_cone = False
            orient(obj, [-c for c in light['direction']])
        place(obj, light['position'], unit)
    else:
        u, v, normal = Vector(light['uAxis']), Vector(light['vAxis']), Vector(light['normal']).normalized()
        data.shape = 'RECTANGLE'
        data.size = u.length * unit
        data.size_y = v.length * unit
        if hasattr(data, 'spread'):
            data.spread = math.pi
        # Blender's area light emits toward local -Z; local X along u, Y along +/- v so that X x Y = -normal.
        z = -normal
        x = u.normalized()
        y = z.cross(x)
        obj.matrix_world = Matrix(((x.x, y.x, z.x), (x.y, y.y, z.y), (x.z, y.z, z.z))).to_4x4()
        place(obj, light['position'], unit)
    bpy.context.scene.collection.objects.link(obj)


def add_camera(job, unit):
    record = job['camera']
    data = bpy.data.cameras.new('camera')
    data.sensor_fit = 'VERTICAL'
    data.sensor_height = 24.0
    data.clip_start = 1e-4
    data.clip_end = 1e7
    if record['projection'] == 'orthographic':
        data.type = 'ORTHO'
        data.ortho_scale = record['orthoHeight'] * unit
    else:
        data.type = 'PERSP'
        data.lens = data.sensor_height / (2.0 * math.tan(record['fovY'] / 2.0))
    if record['apertureRadius'] > 0 and record['projection'] != 'orthographic':
        data.dof.use_dof = True
        data.dof.focus_distance = record['focusDistance'] * unit
        # Cycles' aperture radius is (lens / f-stop) / 2 with the lens in metres.
        data.dof.aperture_fstop = (data.lens * 1e-3) / (2.0 * record['apertureRadius'] * unit)
        data.dof.aperture_blades = 0
    obj = bpy.data.objects.new('camera', data)
    forward, up = Vector(record['forward']).normalized(), Vector(record['up']).normalized()
    right = forward.cross(up).normalized()
    true_up = right.cross(forward)
    back = -forward
    obj.matrix_world = Matrix(((right.x, true_up.x, back.x), (right.y, true_up.y, back.y), (right.z, true_up.z, back.z))).to_4x4()
    place(obj, record['position'], unit)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.scene.camera = obj


def build_world(environment, images):
    world = bpy.data.worlds.new('world')
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    background = nodes['Background']
    kind = environment['type']
    if kind == 'default':
        background.inputs['Color'].default_value = (0.3, 0.3, 0.3, 1.0)
        background.inputs['Strength'].default_value = 1.0
    elif kind == 'color':
        c = environment['color']
        background.inputs['Color'].default_value = (c[0], c[1], c[2], 1.0)
        background.inputs['Strength'].default_value = environment['intensity']
    elif kind == 'hdr':
        texture = nodes.new('ShaderNodeTexEnvironment')
        texture.image = images[environment['texture']]
        texture.interpolation = 'Linear'
        texture.projection = 'EQUIRECTANGULAR'
        coordinates = nodes.new('ShaderNodeTexCoord')
        mapping = nodes.new('ShaderNodeMapping')
        mapping.vector_type = 'POINT'
        # llull looks the map up with the direction turned by -rotation about +Z.
        mapping.inputs['Rotation'].default_value = (0.0, 0.0, -environment['rotation'])
        links.new(coordinates.outputs['Generated'], mapping.inputs['Vector'])
        links.new(mapping.outputs['Vector'], texture.inputs['Vector'])
        links.new(texture.outputs['Color'], background.inputs['Color'])
        background.inputs['Strength'].default_value = environment['intensity']
        world.cycles.sampling_method = 'MANUAL'
        world.cycles.sample_map_resolution = max(images[environment['texture']].size)
    else:
        raise SystemExit(f'environment type {kind!r} has no Cycles counterpart (the Preetham sky); keep it out of the reference corpus')
    bpy.context.scene.world = world


def configure_render(scene, job, spp, options):
    render = scene.render
    render.resolution_x, render.resolution_y, render.resolution_percentage = job['width'], job['height'], 100
    render.pixel_aspect_x = render.pixel_aspect_y = 1.0
    render.film_transparent = False
    render.use_persistent_data = False
    if options['threads'] > 0:
        render.threads_mode = 'FIXED'
        render.threads = int(options['threads'])
    cycles = scene.cycles
    cycles.device = 'CPU'
    cycles.samples = spp
    cycles.use_adaptive_sampling = False
    cycles.use_denoising = False
    cycles.seed = int(options['seed'])
    cycles.use_animated_seed = False
    bounces = max(0, job['maxBounces'] - 1)
    cycles.max_bounces = bounces
    cycles.diffuse_bounces = cycles.glossy_bounces = cycles.transmission_bounces = bounces
    cycles.volume_bounces = 0
    cycles.transparent_max_bounces = 8
    cycles.min_light_bounces = 0
    cycles.sample_clamp_direct = 0.0
    cycles.sample_clamp_indirect = 0.0
    cycles.blur_glossy = 0.0
    cycles.caustics_reflective = True
    cycles.caustics_refractive = True
    cycles.light_sampling_threshold = 0.0
    cycles.pixel_filter_type = 'BLACKMAN_HARRIS'
    cycles.filter_width = options['filter']
    view = scene.view_settings
    view.view_transform = 'Standard'
    view.look = 'None'
    view.exposure = 0.0
    view.gamma = 1.0
    image = render.image_settings
    image.file_format = 'OPEN_EXR'
    image.color_mode = 'RGBA'
    image.color_depth = '32'
    image.exr_codec = 'ZIP'


def main():
    folder, out_exr, spp, options = arguments()
    with open(os.path.join(folder, 'job.json'), encoding='utf8') as handle:
        job = json.load(handle)
    unit = job['unitMetres']
    scene = reset_scene()
    positions = read_array(folder, 'positions.f32', 'f')
    normals = read_array(folder, 'normals.f32', 'f')
    uvs = read_array(folder, 'uvs.f32', 'f')
    indices = read_array(folder, 'indices.u32', 'I')
    images = load_images(folder, job['textures'])
    meshes = [build_mesh(i, record, positions, normals, uvs, indices, unit) for i, record in enumerate(job['meshes'])]
    materials = [build_material(i, record, images) for i, record in enumerate(job['materials'])]
    place_instances(folder, job, meshes, materials, unit)
    for index, light in enumerate(job['lights']):
        strength = max(light['irradiance'] if light['type'] == 'sun' else light['power'])
        if strength > 0:
            add_light(index, light, unit)
    add_camera(job, unit)
    build_world(job['environment'], images)
    configure_render(scene, job, spp, options)
    scene.render.filepath = os.path.abspath(out_exr)
    bpy.ops.render.render(write_still=True)
    with open(os.path.abspath(out_exr) + '.json', 'w', encoding='utf8') as handle:
        json.dump({'blender': bpy.app.version_string, 'samples': spp, 'seed': options['seed'], 'filterWidthPx': options['filter']}, handle)


main()
