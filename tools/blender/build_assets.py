"""Deterministic APEX//73 Blender asset build.

Run headlessly with Blender 5.1:
  blender --background --python tools/blender/build_assets.py

The script produces editable .blend sources and compact GLBs without downloads or
third-party data. Blender coordinates use X=car lateral, -Y=car forward, Z=up;
the glTF export consequently arrives in Three.js as X=lateral, +Z=forward, Y=up.
"""

import bpy
import math
import os
import sys
from array import array


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SOURCE_DIR = os.path.join(ROOT, 'assets', 'blender')
OUTPUT_DIR = os.path.join(ROOT, 'public', 'assets', 'models')
TEXTURE_DIR = os.path.join(ROOT, 'public', 'assets', 'textures')


def ensure_directories():
    os.makedirs(SOURCE_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(TEXTURE_DIR, exist_ok=True)


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material)


def new_collection(name):
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def move_to_collection(obj, collection):
    for existing in tuple(obj.users_collection):
        existing.objects.unlink(obj)
    collection.objects.link(obj)


def blender_location(x, y, z):
    """Convert Three local x/right, y/up, z/forward into Blender coordinates."""
    return (x, -z, y)


def blender_size(x, y, z):
    return (x, z, y)


def make_material(name, color, metallic=0.0, roughness=0.55, emission=None, alpha=1.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, alpha)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if 'Alpha' in bsdf.inputs:
        bsdf.inputs['Alpha'].default_value = alpha
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = 1.8
    if alpha < 1.0:
        try:
            material.surface_render_method = 'DITHERED'
        except AttributeError:
            pass
    return material


def _texture_pixel(kind, u, v):
    """Deterministic authored vehicle surface maps; no source images or downloads."""
    x = int(u * 1024)
    y = int(v * 1024)
    grain = ((x * 37 + y * 71 + x * y * 3) % 31) / 255.0
    diagonal = (x * 3 + y * 5) % 96
    if kind == 'touring_base':
        pearl = 0.72 + grain * 1.4
        stripe = (u * 1.18 + v * 0.36) % 1.0
        if 0.43 < stripe < 0.52:
            return (0.025, 0.095, 0.14, 1.0)
        if 0.525 < stripe < 0.565:
            return (0.10, 0.78, 0.88, 1.0)
        if 0.10 < v < 0.16 and 0.22 < u < 0.78:
            return (0.84, 0.11, 0.055, 1.0)
        return (pearl * 1.03, pearl * 1.04, pearl, 1.0)
    if kind == 'touring_decal':
        diagonal_band = (u * 0.72 - v * 1.16) % 1.0
        if 0.08 < diagonal_band < 0.19:
            return (0.08, 0.80, 0.91, 1.0)
        if 0.20 < diagonal_band < 0.25:
            return (0.94, 0.95, 0.87, 1.0)
        return (0.018, 0.045, 0.065, 1.0)
    if kind == 'prototype_base':
        pearl = 0.66 + grain * 1.7
        stripe = (u * 0.94 - v * 0.62) % 1.0
        if 0.34 < stripe < 0.43:
            return (0.025, 0.055, 0.10, 1.0)
        if 0.445 < stripe < 0.49:
            return (0.94, 0.23, 0.045, 1.0)
        if 0.74 < v < 0.80 and 0.18 < u < 0.82:
            return (0.07, 0.08, 0.10, 1.0)
        return (pearl * 1.08, pearl * 1.06, pearl, 1.0)
    if kind == 'prototype_decal':
        chevron = (u * 1.48 + v * 1.11) % 1.0
        if 0.06 < chevron < 0.14:
            return (0.95, 0.25, 0.045, 1.0)
        if 0.15 < chevron < 0.19:
            return (0.92, 0.94, 0.88, 1.0)
        return (0.018, 0.033, 0.065, 1.0)
    if kind == 'base':
        base = 0.78 + grain * 1.7
        # Neutral paint keeps runtime hue tinting intact; stripes remain legible.
        if 0.08 < ((u * 1.38 + v * 0.52) % 1.0) < 0.15:
            return (0.035, 0.065, 0.075, 1.0)
        if 0.16 < ((u * 1.38 + v * 0.52) % 1.0) < 0.185:
            return (0.18, 0.78, 0.88, 1.0)
        if 0.74 < v < 0.79 and 0.24 < u < 0.76:
            return (0.06, 0.075, 0.08, 1.0)
        return (base, base * 1.015, base * 1.04, 1.0)
    if kind == 'decal':
        if 0.07 < ((u * 0.82 + v * 1.24) % 1.0) < 0.16:
            return (0.08, 0.86, 0.96, 1.0)
        if diagonal < 16:
            return (0.94, 0.96, 0.90, 1.0)
        return (0.025, 0.042, 0.05, 1.0)
    if kind == 'carbon':
        weave = ((x // 7 + y // 7) % 2) * 0.035
        cross = 0.045 if diagonal < 7 else 0.0
        return (0.025 + weave + cross, 0.038 + weave + cross, 0.047 + weave + cross, 1.0)
    if kind == 'metal':
        band = 0.48 + 0.18 * math.sin((u * 13.0 + v * 1.8) * math.pi)
        scratch = 0.08 if (x + y * 3) % 113 < 2 else 0.0
        return (band + scratch, band + scratch, band * 1.06 + scratch, 1.0)
    if kind == 'tyre':
        tread = 0.085 if ((x // 12 + y // 34) % 3 == 0 or (x * 2 - y) % 79 < 6) else 0.0
        return (0.024 + tread, 0.029 + tread, 0.027 + tread, 1.0)
    if kind == 'glass':
        streak = 0.08 * math.sin((u * 8.0 + v * 4.0) * math.pi)
        return (0.018 + streak * 0.18, 0.13 + streak, 0.18 + streak, 0.68)
    if kind == 'interior':
        stitch = 0.055 if (x + y * 2) % 137 < 3 else 0.0
        weave = 0.025 if ((x // 11) + (y // 11)) % 2 else 0.0
        return (0.115 + stitch + weave, 0.155 + stitch + weave, 0.145 + stitch + weave, 1.0)
    if kind == 'display':
        grid = 0.10 if x % 43 < 2 or y % 37 < 2 else 0.0
        scan = 0.10 if (y // 9) % 2 else 0.0
        mark = 0.26 if 0.16 < u < 0.82 and 0.42 < v < 0.58 else 0.0
        return (0.025 + grid, 0.34 + scan + mark, 0.46 + scan + mark, 1.0)
    if kind == 'touring_display':
        grid = 0.08 if x % 37 < 2 or y % 31 < 2 else 0.0
        mark = 0.32 if 0.18 < u < 0.84 and 0.39 < v < 0.61 else 0.0
        return (0.018 + grid, 0.42 + mark, 0.34 + mark * 0.6, 1.0)
    if kind == 'prototype_display':
        grid = 0.09 if x % 29 < 2 or y % 43 < 2 else 0.0
        mark = 0.30 if 0.16 < u < 0.84 and 0.34 < v < 0.66 else 0.0
        return (0.045 + mark, 0.22 + grid + mark * 0.35, 0.48 + grid + mark, 1.0)
    if kind == 'touring_interior':
        weave = 0.035 if ((x // 9) + (y // 13)) % 2 else 0.0
        stitch = 0.08 if (x + y * 2) % 151 < 3 else 0.0
        return (0.07 + weave + stitch, 0.16 + weave + stitch, 0.14 + weave + stitch, 1.0)
    if kind == 'prototype_interior':
        weave = 0.030 if ((x // 8) + (y // 8)) % 2 else 0.0
        stitch = 0.07 if (x * 2 + y) % 143 < 3 else 0.0
        return (0.09 + weave + stitch, 0.105 + weave + stitch, 0.145 + weave + stitch, 1.0)
    if kind == 'normal':
        d = 0.024 * math.sin((u * 42.0 + v * 29.0) * math.pi)
        return (0.5 + d, 0.5 - d, 0.995, 1.0)
    if kind == 'orm':
        # R=AO, G=roughness, B=metallic. glTF exporter packs G/B as PBR map.
        rough = 0.22 + 0.08 * ((x // 23 + y // 19) % 4) / 3.0
        return (0.92, rough, 0.74, 1.0)
    if kind.startswith('prop_'):
        palette = {
            'prop_steel': (0.11, 0.15, 0.16), 'prop_concrete': (0.34, 0.35, 0.32),
            'prop_seat': (0.05, 0.29, 0.54), 'prop_yellow': (0.82, 0.94, 0.08),
            'prop_red': (0.82, 0.055, 0.03), 'prop_glass': (0.035, 0.16, 0.22),
            'prop_rubber': (0.018, 0.021, 0.019), 'prop_foliage': (0.035, 0.25, 0.09),
            'prop_trunk': (0.24, 0.105, 0.035), 'prop_lamp': (0.86, 0.96, 0.78)
        }
        base = palette[kind]
        panel = 0.055 if x % 127 < 3 or y % 113 < 3 else 0.0
        fleck = grain * (2.4 if kind in ('prop_concrete', 'prop_trunk', 'prop_foliage') else 1.0)
        return tuple(min(1.0, channel + panel + fleck) for channel in base) + (1.0,)
    raise ValueError('Unknown texture kind: ' + kind)


def make_image(name, filename, width, height, kind, data=False):
    path = os.path.join(TEXTURE_DIR, filename)
    existing = bpy.data.images.get(name)
    if existing:
        bpy.data.images.remove(existing)
    image = bpy.data.images.new(name, width=width, height=height, alpha=True, float_buffer=False)
    pixels = array('f')
    for y in range(height):
        v = y / max(1, height - 1)
        for x in range(width):
            u = x / max(1, width - 1)
            pixels.extend(_texture_pixel(kind, u, v))
    image.pixels.foreach_set(pixels)
    image.filepath_raw = path
    image.file_format = 'PNG'
    if data:
        try:
            image.colorspace_settings.name = 'Non-Color'
        except (AttributeError, TypeError):
            pass
    image.save()
    image.filepath = path
    return image


def make_gt_textures():
    return {
        'base': make_image('GT_BASECOLOR', 'gt-basecolor.png', 1024, 1024, 'base'),
        'decal': make_image('GT_DECAL', 'gt-decal.png', 512, 512, 'decal'),
        'carbon': make_image('GT_CARBON', 'gt-carbon.png', 512, 512, 'carbon'),
        'metal': make_image('GT_METAL', 'gt-metal.png', 512, 512, 'metal'),
        'tyre': make_image('GT_TYRE', 'gt-tyre.png', 512, 512, 'tyre'),
        'glass': make_image('GT_GLASS', 'gt-glass.png', 512, 512, 'glass'),
        'interior': make_image('GT_INTERIOR', 'gt-interior.png', 512, 512, 'interior'),
        'display': make_image('GT_DISPLAY', 'gt-display.png', 256, 256, 'display'),
        'normal': make_image('GT_NORMAL', 'gt-normal.png', 512, 512, 'normal', data=True),
        'orm': make_image('GT_ORM', 'gt-orm.png', 512, 512, 'orm', data=True)
    }


def make_variant_textures(variant):
    """Per-variant authored maps. Separate PNGs make each GLB self-contained on export."""
    tag = variant.upper()
    return {
        'base': make_image(f'{tag}_BASECOLOR', f'{variant}-basecolor.png', 1024, 1024, f'{variant}_base'),
        'decal': make_image(f'{tag}_DECAL', f'{variant}-decal.png', 1024, 1024, f'{variant}_decal'),
        'carbon': make_image(f'{tag}_CARBON', f'{variant}-carbon.png', 512, 512, 'carbon'),
        'metal': make_image(f'{tag}_METAL', f'{variant}-metal.png', 512, 512, 'metal'),
        'tyre': make_image(f'{tag}_TYRE', f'{variant}-tyre.png', 512, 512, 'tyre'),
        'glass': make_image(f'{tag}_GLASS', f'{variant}-glass.png', 512, 512, 'glass'),
        'interior': make_image(f'{tag}_INTERIOR', f'{variant}-interior.png', 512, 512, f'{variant}_interior'),
        'display': make_image(f'{tag}_DISPLAY', f'{variant}-display.png', 256, 256, f'{variant}_display'),
        'normal': make_image(f'{tag}_NORMAL', f'{variant}-normal.png', 512, 512, 'normal', data=True),
        'orm': make_image(f'{tag}_ORM', f'{variant}-orm.png', 512, 512, 'orm', data=True)
    }


def make_prop_textures():
    surfaces = ('steel', 'concrete', 'seat', 'yellow', 'red', 'glass', 'rubber', 'foliage', 'trunk', 'lamp')
    maps = {surface: make_image(f'PROP_{surface.upper()}', f'prop-{surface}.png', 256, 256, f'prop_{surface}') for surface in surfaces}
    maps['normal'] = make_image('PROP_NORMAL', 'prop-normal.png', 256, 256, 'normal', data=True)
    maps['orm'] = make_image('PROP_ORM', 'prop-orm.png', 256, 256, 'orm', data=True)
    return maps


def make_textured_material(name, base_image, normal_image, orm_image, metallic=0.0, roughness=0.55, alpha=1.0, emission=None, emission_strength=1.8):
    """Minimal Principled graph recognized by Blender's glTF exporter."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in tuple(nodes):
        nodes.remove(node)
    output = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (1.0, 1.0, 1.0, alpha)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if 'Alpha' in bsdf.inputs:
        bsdf.inputs['Alpha'].default_value = alpha
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    base = nodes.new('ShaderNodeTexImage')
    base.image = base_image
    base.interpolation = 'Linear'
    links.new(base.outputs['Color'], bsdf.inputs['Base Color'])

    if normal_image:
        normal_tex = nodes.new('ShaderNodeTexImage')
        normal_tex.image = normal_image
        normal_tex.interpolation = 'Linear'
        normal_map = nodes.new('ShaderNodeNormalMap')
        normal_map.inputs['Strength'].default_value = 0.52
        links.new(normal_tex.outputs['Color'], normal_map.inputs['Color'])
        links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])

    if orm_image:
        orm_tex = nodes.new('ShaderNodeTexImage')
        orm_tex.image = orm_image
        orm_tex.interpolation = 'Linear'
        try:
            separate = nodes.new('ShaderNodeSeparateColor')
            separate.mode = 'RGB'
        except RuntimeError:
            separate = nodes.new('ShaderNodeSeparateRGB')
        links.new(orm_tex.outputs['Color'], separate.inputs.get('Image') or separate.inputs.get('Color') or separate.inputs[0])
        links.new(separate.outputs.get('Green'), bsdf.inputs['Roughness'])
        links.new(separate.outputs.get('Blue'), bsdf.inputs['Metallic'])

    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    if alpha < 1.0:
        try:
            material.surface_render_method = 'DITHERED'
        except AttributeError:
            pass
    return material


def assign_material(obj, material):
    if not obj.data or not hasattr(obj.data, 'materials'):
        return
    obj.data.materials.clear()
    obj.data.materials.append(material)


def parent_local(obj, parent, location=(0, 0, 0), rotation=(0, 0, 0)):
    obj.parent = parent
    obj.matrix_parent_inverse.identity()
    obj.location = location
    obj.rotation_euler = rotation


def apply_bevel(obj, width=0.04, segments=1):
    modifier = obj.modifiers.new('EdgeSoftening', 'BEVEL')
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = 'ANGLE'
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def box(name, collection, location, size, material, parent=None, bevel=0.0, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0))
    obj = bpy.context.object
    obj.name = name
    move_to_collection(obj, collection)
    if parent:
        parent_local(obj, parent, location, rotation)
    else:
        obj.location = location
        obj.rotation_euler = rotation
    obj.dimensions = size
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)
    if bevel:
        apply_bevel(obj, bevel, 2 if bevel > 0.07 else 1)
    assign_material(obj, material)
    return obj


def cylinder(name, collection, location, radius, depth, material, parent=None, rotation=(0, 0, 0), vertices=16, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=(0, 0, 0))
    obj = bpy.context.object
    obj.name = name
    move_to_collection(obj, collection)
    if parent:
        parent_local(obj, parent, location, rotation)
    else:
        obj.location = location
        obj.rotation_euler = rotation
    assign_material(obj, material)
    if bevel:
        apply_bevel(obj, bevel, 1)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def sphere(name, collection, location, scale, material, parent=None, subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=(0, 0, 0))
    obj = bpy.context.object
    obj.name = name
    move_to_collection(obj, collection)
    if parent:
        parent_local(obj, parent, location)
    else:
        obj.location = location
    obj.scale = scale
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)
    assign_material(obj, material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def torus(name, collection, location, major_radius, minor_radius, material, parent=None, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major_radius, minor_radius=minor_radius, major_segments=16, minor_segments=6, location=(0, 0, 0))
    obj = bpy.context.object
    obj.name = name
    move_to_collection(obj, collection)
    if parent:
        parent_local(obj, parent, location, rotation)
    else:
        obj.location = location
        obj.rotation_euler = rotation
    assign_material(obj, material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def empty(name, collection, location=(0, 0, 0), parent=None, rotation=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = 'PLAIN_AXES'
    obj.empty_display_size = 0.18
    collection.objects.link(obj)
    if parent:
        parent_local(obj, parent, location, rotation)
    else:
        obj.location = location
        obj.rotation_euler = rotation
    return obj


def wedge(name, collection, location, width, length, height, material, parent=None, rise=0.0):
    # Low-poly wedge, useful for splitters, wings and car noses.
    half_w = width * 0.5
    half_l = length * 0.5
    lower = -height * 0.5
    upper_front = height * 0.5 + rise
    upper_rear = height * 0.5
    verts = [
        (-half_w, -half_l, lower), (half_w, -half_l, lower), (half_w, half_l, lower), (-half_w, half_l, lower),
        (-half_w, -half_l, upper_rear), (half_w, -half_l, upper_rear), (half_w, half_l, upper_front), (-half_w, half_l, upper_front)
    ]
    faces = [(0, 1, 2, 3), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0), (4, 7, 6, 5)]
    mesh = bpy.data.meshes.new(f'{name}_mesh')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if parent:
        parent_local(obj, parent, location)
    else:
        obj.location = location
    assign_material(obj, material)
    apply_bevel(obj, 0.025, 1)
    return obj


def _three_to_blender(vertex):
    x, y, z = vertex
    return (x, -z, y)


def _smooth(obj):
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def _mesh_from_three(name, collection, vertices, faces, material, parent=None, uv_faces=None, bevel=0.0):
    mesh = bpy.data.meshes.new(f'{name}_mesh')
    mesh.from_pydata([_three_to_blender(vertex) for vertex in vertices], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if parent:
        parent_local(obj, parent)
    assign_material(obj, material)
    if uv_faces:
        uv_layer = mesh.uv_layers.new(name='UVMap')
        for polygon, coords in zip(mesh.polygons, uv_faces):
            for loop_index, uv in zip(polygon.loop_indices, coords):
                uv_layer.data[loop_index].uv = uv
    if bevel:
        apply_bevel(obj, bevel, 2)
    return _smooth(obj)


def _loft(name, collection, sections, material, parent=None, radial=20, bevel=0.0, x_offset=0.0):
    """Closed authored shell from (z, half-width, y-center, y-radius) sections."""
    vertices = []
    for z, half_width, center_y, radius_y in sections:
        for step in range(radial):
            angle = math.tau * step / radial
            crown = max(0.0, math.sin(angle))
            x = x_offset + math.cos(angle) * half_width * (1.0 + crown * 0.06)
            y = center_y + math.sin(angle) * radius_y
            vertices.append((x, y, z))
    faces = []
    uv_faces = []
    for row in range(len(sections) - 1):
        for step in range(radial):
            nxt = (step + 1) % radial
            a = row * radial + step
            b = row * radial + nxt
            c = (row + 1) * radial + nxt
            d = (row + 1) * radial + step
            faces.append((a, b, c, d))
            uv_faces.append((
                (step / radial, row / (len(sections) - 1)),
                (nxt / radial, row / (len(sections) - 1)),
                (nxt / radial, (row + 1) / (len(sections) - 1)),
                (step / radial, (row + 1) / (len(sections) - 1))
            ))
    start = tuple(range(radial - 1, -1, -1))
    end = tuple((len(sections) - 1) * radial + step for step in range(radial))
    faces.extend((start, end))
    uv_faces.extend((
        tuple((step / radial, 0.0) for step in range(radial - 1, -1, -1)),
        tuple((step / radial, 1.0) for step in range(radial))
    ))
    return _mesh_from_three(name, collection, vertices, faces, material, parent, uv_faces, bevel)


def _arch(name, collection, center_x, center_z, radius, tube, material, parent=None, segments=28, profile=8):
    """Upper fender arch. Geometry follows wheel radius, not a visual box."""
    vertices = []
    for row in range(segments + 1):
        theta = math.pi * row / segments
        for step in range(profile):
            phi = math.tau * step / profile
            arch_radius = radius + tube * math.cos(phi)
            vertices.append((
                center_x + tube * 1.75 * math.sin(phi),
                0.34 + arch_radius * math.sin(theta),
                center_z + arch_radius * math.cos(theta)
            ))
    faces = []
    uv_faces = []
    for row in range(segments):
        for step in range(profile):
            nxt = (step + 1) % profile
            a = row * profile + step
            b = row * profile + nxt
            c = (row + 1) * profile + nxt
            d = (row + 1) * profile + step
            faces.append((a, b, c, d))
            uv_faces.append((
                (step / profile, row / segments),
                (nxt / profile, row / segments),
                (nxt / profile, (row + 1) / segments),
                (step / profile, (row + 1) / segments)
            ))
    return _mesh_from_three(name, collection, vertices, faces, material, parent, uv_faces)


def _airfoil(name, collection, center, span, chord, thickness, material, parent=None):
    cx, cy, cz = center
    vertices = [
        (cx - span * 0.5, cy, cz - chord * 0.5),
        (cx + span * 0.5, cy, cz - chord * 0.5),
        (cx + span * 0.5, cy, cz + chord * 0.5),
        (cx - span * 0.5, cy, cz + chord * 0.5),
        (cx - span * 0.5, cy + thickness, cz - chord * 0.30),
        (cx + span * 0.5, cy + thickness, cz - chord * 0.30),
        (cx + span * 0.5, cy + thickness * 0.72, cz + chord * 0.44),
        (cx - span * 0.5, cy + thickness * 0.72, cz + chord * 0.44)
    ]
    faces = [
        (0, 1, 2, 3), (0, 4, 5, 1), (1, 5, 6, 2),
        (2, 6, 7, 3), (3, 7, 4, 0), (4, 7, 6, 5)
    ]
    uvs = [((0, 0), (1, 0), (1, 1), (0, 1)) for _ in faces]
    return _mesh_from_three(name, collection, vertices, faces, material, parent, uvs, bevel=0.012)


def _tyre_mesh(name, collection, material, parent=None, angular=44, profile=12):
    """Dense only where visible: radial tyre sidewall/tread mesh around spin X axis."""
    vertices = []
    outer_radius = 0.335
    tube_radius = 0.072
    ring_radius = outer_radius - tube_radius
    for ring in range(angular):
        theta = math.tau * ring / angular
        for step in range(profile):
            phi = math.tau * step / profile
            radius = ring_radius + tube_radius * math.cos(phi)
            vertices.append((
                0.137 * math.sin(phi),
                radius * math.sin(theta),
                radius * math.cos(theta)
            ))
    faces = []
    uvs = []
    for ring in range(angular):
        nxt_ring = (ring + 1) % angular
        for step in range(profile):
            nxt = (step + 1) % profile
            a = ring * profile + step
            b = ring * profile + nxt
            c = nxt_ring * profile + nxt
            d = nxt_ring * profile + step
            faces.append((a, b, c, d))
            uvs.append((
                (ring / angular, step / profile),
                (ring / angular, nxt / profile),
                (nxt_ring / angular, nxt / profile),
                (nxt_ring / angular, step / profile)
            ))
    return _mesh_from_three(name, collection, vertices, faces, material, parent, uvs)


def create_gt_wheel(root, collection, label, x, z, materials):
    tyre, rim, brake, caliper, carbon = materials
    pivot = empty(label, collection, blender_location(x, 0.34, z), root)
    spin = empty(f'{label}_SPIN', collection, (0, 0, 0), pivot)
    _tyre_mesh(f'{label}_TYRE', collection, tyre, spin)
    cylinder(f'{label}_RIM', collection, (0, 0, 0), 0.208, 0.270, rim, spin, rotation=(0, math.pi * 0.5, 0), vertices=32, bevel=0.008)
    cylinder(f'{label}_BRAKE', collection, (0, 0, 0), 0.255, 0.094, brake, pivot, rotation=(0, math.pi * 0.5, 0), vertices=32, bevel=0.006)
    torus(f'{label}_RIM_RING', collection, (0, 0, 0), 0.178, 0.014, rim, spin, rotation=(0, math.pi * 0.5, 0))
    # Ten shallow spokes read in chase view without excessive hidden density.
    for spoke in range(10):
        angle = math.tau * spoke / 10
        box(
            f'{label}_SPOKE_{spoke}',
            collection,
            blender_location(0.142 if x > 0 else -0.142, math.sin(angle) * 0.105, math.cos(angle) * 0.105),
            blender_size(0.026, 0.044, 0.255),
            rim,
            spin,
            bevel=0.010,
            rotation=(angle, 0, 0)
        )
    box(f'{label}_CALIPER', collection, blender_location(0.0, 0.13, -0.18), blender_size(0.14, 0.14, 0.18), caliper, pivot, bevel=0.025)
    return pivot


def create_wheel(root, collection, label, x, z, tyre, rim, brake, caliper):
    pivot = empty(label, collection, blender_location(x, 0.34, z), root)
    spin = empty(f'{label}_SPIN', collection, (0, 0, 0), pivot)
    # Blender cylinders point along Z by default. Rotate around Y to align the axle with X.
    cylinder(f'{label}_TYRE', collection, (0, 0, 0), 0.335, 0.25, tyre, spin, rotation=(0, math.pi * 0.5, 0), vertices=20, bevel=0.012)
    cylinder(f'{label}_RIM', collection, (0, 0, 0), 0.205, 0.262, rim, spin, rotation=(0, math.pi * 0.5, 0), vertices=16, bevel=0.008)
    cylinder(f'{label}_BRAKE', collection, (0, 0, 0), 0.25, 0.10, brake, pivot, rotation=(0, math.pi * 0.5, 0), vertices=16)
    box(f'{label}_CALIPER', collection, (0.0, 0.14, -0.17), blender_size(0.14, 0.13, 0.16), caliper, pivot, bevel=0.025)
    return pivot


def add_a_pillars(root, collection, prefix, carbon, half_width, forward_z):
    for side in (-1, 1):
        box(
            f'{prefix}_A_PILLAR_{"L" if side < 0 else "R"}',
            collection,
            blender_location(side * half_width, 1.00, forward_z),
            blender_size(0.075, 0.56, 0.09),
            carbon,
            root,
            bevel=0.018
        )


def add_cockpit(root, collection, prefix, interior, seat_z, dash_z, eye):
    box(f'{prefix}_SEAT', collection, blender_location(0, 0.76, seat_z), blender_size(0.70, 0.48, 0.82), interior, root, bevel=0.06)
    box(f'{prefix}_HEADREST', collection, blender_location(0, 1.10, seat_z - 0.25), blender_size(0.48, 0.30, 0.18), interior, root, bevel=0.04)
    box(f'{prefix}_DASH', collection, blender_location(0, 0.87, dash_z), blender_size(1.16, 0.24, 0.31), interior, root, bevel=0.035)
    cylinder(f'{prefix}_STEERING_COLUMN', collection, blender_location(-0.23, 0.89, dash_z - 0.08), 0.035, 0.36, interior, root, rotation=(math.pi * 0.5, 0, 0), vertices=10)
    torus(f'{prefix}_STEERING_WHEEL', collection, blender_location(-0.23, 1.00, dash_z - 0.16), 0.145, 0.021, interior, root, rotation=(math.pi * 0.5, 0, 0))
    # Unrotated Blender -Y forward converts to glTF/Three +Z forward.
    camera_anchor = empty('COCKPIT_CAMERA', collection, blender_location(*eye), root)
    camera_anchor['role'] = 'driver_eye'
    camera_anchor['forward_axis'] = '+Z'


def add_gt_a_pillars(root, collection, carbon):
    """Thin chase-visible pillars; hidden only for player's cockpit sightline."""
    for side in (-1, 1):
        box(
            f'COCKPIT_HIDE_GT_A_PILLAR_{"L" if side < 0 else "R"}',
            collection,
            blender_location(side * 0.77, 0.98, 1.05),
            blender_size(0.045, 0.44, 0.060),
            carbon,
            root,
            bevel=0.012
        )


def add_gt_cockpit(root, collection, materials):
    """GT-only seating calibration: eye above, behind, and clear of dashboard volume."""
    interior = materials['interior']
    dash = materials['dash']
    wheel = materials['wheel']
    display = materials['display']
    carbon = materials['carbon']

    box('GT_SEAT', collection, blender_location(-0.01, 0.54, -0.64), blender_size(0.70, 0.42, 0.72), interior, root, bevel=0.052)
    box('GT_HEADREST', collection, blender_location(-0.01, 0.91, -0.91), blender_size(0.46, 0.26, 0.16), interior, root, bevel=0.035)
    box('GT_DASH', collection, blender_location(-0.10, 0.65, 1.02), blender_size(1.02, 0.18, 0.31), dash, root, bevel=0.030)
    box('GT_DASH_LIP', collection, blender_location(-0.10, 0.77, 0.94), blender_size(0.92, 0.035, 0.18), carbon, root, bevel=0.012)
    cylinder('GT_STEERING_COLUMN', collection, blender_location(-0.20, 0.69, 0.78), 0.028, 0.29, dash, root, rotation=(math.pi * 0.5, 0, 0), vertices=12)
    torus('GT_STEERING_WHEEL', collection, blender_location(-0.20, 0.78, 0.84), 0.112, 0.016, wheel, root, rotation=(math.pi * 0.5, 0, 0))
    cylinder('GT_WHEEL_HUB', collection, blender_location(-0.20, 0.78, 0.84), 0.042, 0.046, dash, root, rotation=(0, math.pi * 0.5, 0), vertices=16)
    box('GT_INSTRUMENT_DISPLAY', collection, blender_location(-0.20, 0.80, 1.00), blender_size(0.28, 0.11, 0.026), display, root, bevel=0.010)
    box('GT_DISPLAY_BEZEL', collection, blender_location(-0.20, 0.80, 1.015), blender_size(0.34, 0.15, 0.018), carbon, root, bevel=0.012)
    box('GT_CENTER_CONSOLE', collection, blender_location(0.15, 0.48, 0.38), blender_size(0.28, 0.16, 0.72), dash, root, bevel=0.025)

    # Driver's left-hand eye: 1.26 m high, ahead of seat, behind wheel/dash plane.
    camera_anchor = empty('COCKPIT_CAMERA', collection, blender_location(-0.20, 1.26, -0.15), root)
    camera_anchor['role'] = 'driver_eye'
    camera_anchor['forward_axis'] = '+Z'


def make_gt_materials(textures):
    normal = textures['normal']
    orm = textures['orm']
    return {
        'paint': make_textured_material('MAT_PAINT_GT', textures['base'], normal, orm, metallic=0.72, roughness=0.24),
        'decal': make_textured_material('MAT_DECAL_GT', textures['decal'], normal, orm, metallic=0.08, roughness=0.34),
        'carbon': make_textured_material('MAT_CARBON_GT', textures['carbon'], normal, orm, metallic=0.48, roughness=0.28),
        'glass': make_textured_material('MAT_GLASS_GT', textures['glass'], normal, orm, metallic=0.16, roughness=0.11, alpha=0.72),
        'lamp': make_textured_material('MAT_LAMP_GT', textures['decal'], normal, orm, metallic=0.06, roughness=0.18, emission=(0.72, 0.94, 0.86)),
        'rim': make_textured_material('MAT_RIM_GT', textures['metal'], normal, orm, metallic=0.92, roughness=0.19),
        'tyre': make_textured_material('MAT_TYRE_GT', textures['tyre'], normal, orm, metallic=0.01, roughness=0.88),
        'brake': make_textured_material('MAT_BRAKE_GT', textures['metal'], normal, orm, metallic=0.90, roughness=0.24),
        'caliper': make_textured_material('MAT_CALIPER_GT', textures['decal'], normal, orm, metallic=0.36, roughness=0.30),
        'interior': make_textured_material('MAT_INTERIOR_GT', textures['interior'], normal, orm, metallic=0.08, roughness=0.56),
        'dash': make_textured_material('MAT_DASH_GT', textures['interior'], normal, orm, metallic=0.18, roughness=0.42),
        'wheel': make_textured_material('MAT_WHEEL_GT', textures['carbon'], normal, orm, metallic=0.28, roughness=0.38),
        'display': make_textured_material('MAT_DISPLAY_GT', textures['display'], normal, orm, metallic=0.05, roughness=0.28, emission=(0.10, 0.72, 0.92), emission_strength=0.55)
    }


def make_variant_materials(variant, textures):
    """Full PBR material set shared by the touring and prototype authored meshes."""
    tag = variant.upper()
    normal = textures['normal']
    orm = textures['orm']
    return {
        'paint': make_textured_material(f'MAT_PAINT_{tag}', textures['base'], normal, orm, metallic=0.66, roughness=0.27),
        'decal': make_textured_material(f'MAT_DECAL_{tag}', textures['decal'], normal, orm, metallic=0.10, roughness=0.33),
        'carbon': make_textured_material(f'MAT_CARBON_{tag}', textures['carbon'], normal, orm, metallic=0.50, roughness=0.29),
        'glass': make_textured_material(f'MAT_GLASS_{tag}', textures['glass'], normal, orm, metallic=0.16, roughness=0.12, alpha=0.72),
        'lamp': make_textured_material(f'MAT_LAMP_{tag}', textures['decal'], normal, orm, metallic=0.05, roughness=0.18, emission=(0.72, 0.94, 0.86)),
        'rim': make_textured_material(f'MAT_RIM_{tag}', textures['metal'], normal, orm, metallic=0.92, roughness=0.20),
        'tyre': make_textured_material(f'MAT_TYRE_{tag}', textures['tyre'], normal, orm, metallic=0.01, roughness=0.89),
        'brake': make_textured_material(f'MAT_BRAKE_{tag}', textures['metal'], normal, orm, metallic=0.90, roughness=0.24),
        'caliper': make_textured_material(f'MAT_CALIPER_{tag}', textures['decal'], normal, orm, metallic=0.34, roughness=0.31),
        'interior': make_textured_material(f'MAT_INTERIOR_{tag}', textures['interior'], normal, orm, metallic=0.10, roughness=0.58),
        'display': make_textured_material(f'MAT_DISPLAY_{tag}', textures['display'], normal, orm, metallic=0.04, roughness=0.25, emission=(0.08, 0.72, 0.82), emission_strength=0.65)
    }


def _gt_number_panel(root, collection, materials):
    decal = materials['decal']
    carbon = materials['carbon']
    box('GT_NUMBER_PANEL', collection, blender_location(0, 0.73, -2.31), blender_size(0.82, 0.40, 0.045), decal, root, bevel=0.02)
    # Seven-segment 73, intentionally mesh-authored rather than font data.
    segments = {
        'a': (0.0, 0.13, 0.18, 0.045),
        'b': (0.12, 0.00, 0.045, 0.16),
        'c': (0.12, -0.15, 0.045, 0.16),
        'd': (0.0, -0.27, 0.18, 0.045),
        'e': (-0.12, -0.15, 0.045, 0.16),
        'f': (-0.12, 0.00, 0.045, 0.16),
        'g': (0.0, -0.07, 0.18, 0.045)
    }
    digits = (
        (-0.19, ('a', 'b', 'c')),
        (0.19, ('a', 'b', 'c', 'd', 'g'))
    )
    for digit, (offset, active) in enumerate(digits):
        for segment in active:
            sx, sy, width, height = segments[segment]
            box(
                f'GT_DIGIT_{digit}_{segment}',
                collection,
                blender_location(offset + sx, 0.73 + sy, -2.345),
                blender_size(width, height, 0.018),
                carbon,
                root,
                bevel=0.006
            )


def build_gt(root, collection, materials):
    """Hero GT: explicit curved cross-sections, visible fenders, cabin, and aero."""
    paint = materials['paint']
    carbon = materials['carbon']
    glass = materials['glass']
    lamp = materials['lamp']
    rim = materials['rim']
    tyre = materials['tyre']
    brake = materials['brake']
    caliper = materials['caliper']
    interior = materials['interior']

    body_sections = [
        (-2.34, 0.56, 0.54, 0.18), (-2.22, 0.72, 0.54, 0.26),
        (-2.04, 0.86, 0.53, 0.32), (-1.78, 0.94, 0.51, 0.37),
        (-1.48, 0.96, 0.50, 0.39), (-1.17, 0.95, 0.49, 0.40),
        (-0.86, 0.93, 0.48, 0.40), (-0.56, 0.91, 0.48, 0.39),
        (-0.25, 0.90, 0.47, 0.37), (0.06, 0.89, 0.46, 0.35),
        (0.38, 0.89, 0.45, 0.33), (0.68, 0.90, 0.44, 0.31),
        (0.96, 0.90, 0.43, 0.29), (1.22, 0.89, 0.42, 0.27),
        (1.46, 0.87, 0.41, 0.25), (1.68, 0.84, 0.40, 0.23),
        (1.88, 0.79, 0.39, 0.20), (2.05, 0.72, 0.38, 0.18),
        (2.19, 0.64, 0.37, 0.16), (2.31, 0.54, 0.34, 0.13)
    ]
    _loft('COCKPIT_HIDE_GT_BODY_SHELL', collection, body_sections, paint, root, radial=22, bevel=0.014)

    # Four sculpted arches create wheel-volume read without hidden subdivision.
    for side in (-1, 1):
        _arch(f'COCKPIT_HIDE_GT_FRONT_FENDER_{"L" if side < 0 else "R"}', collection, side * 0.84, 1.30, 0.39, 0.052, paint, root)
        _arch(f'COCKPIT_HIDE_GT_REAR_FENDER_{"L" if side < 0 else "R"}', collection, side * 0.85, -1.28, 0.40, 0.054, paint, root)

    cowl_sections = [
        (-1.16, 0.58, 0.92, 0.12), (-0.88, 0.70, 1.05, 0.22),
        (-0.55, 0.73, 1.13, 0.25), (-0.18, 0.72, 1.17, 0.27),
        (0.20, 0.68, 1.12, 0.25), (0.52, 0.60, 1.03, 0.21),
        (0.78, 0.49, 0.91, 0.14)
    ]
    _loft('COCKPIT_HIDE_GT_CABIN', collection, cowl_sections, glass, root, radial=18, bevel=0.010)
    _loft(
        'COCKPIT_HIDE_GT_HOOD_COWL',
        collection,
        [(0.58, 0.64, 0.67, 0.16), (0.94, 0.68, 0.66, 0.18), (1.34, 0.66, 0.63, 0.16), (1.72, 0.56, 0.58, 0.12)],
        carbon,
        root,
        radial=16,
        bevel=0.008
    )

    _airfoil('GT_FRONT_SPLITTER', collection, (0, 0.28, 2.31), 2.06, 0.54, 0.055, carbon, root)
    _airfoil('GT_REAR_WING_AUTHORED', collection, (0, 1.18, -2.13), 2.12, 0.40, 0.095, carbon, root)
    _airfoil('GT_DIFFUSER_PLANE', collection, (0, 0.29, -2.17), 1.72, 0.58, 0.075, carbon, root)
    for x in (-0.64, 0.64):
        box('GT_WING_STANCHION', collection, blender_location(x, 0.92, -1.92), blender_size(0.09, 0.48, 0.10), carbon, root, bevel=0.018)
    for x in (-0.48, -0.24, 0.24, 0.48):
        box('GT_DIFFUSER_FIN', collection, blender_location(x, 0.36, -2.18), blender_size(0.035, 0.22, 0.48), carbon, root, bevel=0.010)
    for side in (-1, 1):
        box('GT_SIDE_SKIRT', collection, blender_location(side * 0.92, 0.40, -0.02), blender_size(0.10, 0.13, 3.46), carbon, root, bevel=0.020)
        box('GT_SIDE_INTAKE', collection, blender_location(side * 0.94, 0.58, -0.08), blender_size(0.045, 0.23, 0.70), carbon, root, bevel=0.018)
        box('GT_MIRROR_STALK', collection, blender_location(side * 0.87, 0.78, 0.47), blender_size(0.06, 0.10, 0.32), carbon, root, bevel=0.018)
        box('GT_MIRROR_HOUSING', collection, blender_location(side * 1.02, 0.86, 0.55), blender_size(0.19, 0.12, 0.26), paint, root, bevel=0.040)
        box('COCKPIT_HIDE_GT_HEADLAMP', collection, blender_location(side * 0.57, 0.66, 2.20), blender_size(0.46, 0.10, 0.105), lamp, root, bevel=0.028)
        cylinder('GT_EXHAUST', collection, blender_location(side * 0.32, 0.46, -2.37), 0.075, 0.17, rim, root, rotation=(math.pi * 0.5, 0, 0), vertices=20, bevel=0.007)

    add_gt_a_pillars(root, collection, carbon)
    add_gt_cockpit(root, collection, materials)
    _gt_number_panel(root, collection, materials)

    wheel_materials = (tyre, rim, brake, caliper, carbon)
    for label, x, z in [('FL', -0.81, 1.30), ('FR', 0.81, 1.30), ('RL', -0.81, -1.28), ('RR', 0.81, -1.28)]:
        create_gt_wheel(root, collection, label, x, z, wheel_materials)


def build_touring(root, collection, materials):
    paint, decal, carbon, glass, lamp = (materials[k] for k in ('paint', 'decal', 'carbon', 'glass', 'lamp'))
    rim, tyre, brake, caliper, interior = (materials[k] for k in ('rim', 'tyre', 'brake', 'caliper', 'interior'))
    _loft('COCKPIT_HIDE_TOURING_BODY', collection, [
        (-2.28, .57, .46, .16), (-2.08, .79, .49, .29), (-1.70, .94, .52, .38),
        (-1.28, .98, .53, .42), (-.72, .97, .53, .43), (-.10, .96, .52, .42),
        (.55, .95, .50, .38), (1.12, .94, .48, .33), (1.66, .89, .43, .25),
        (2.06, .78, .36, .18), (2.30, .57, .28, .12)
    ], paint, root, radial=20, bevel=.012)
    _loft('COCKPIT_HIDE_TOURING_CABIN', collection, [
        (-1.10, .60, .89, .12), (-.80, .74, 1.08, .22), (-.38, .77, 1.20, .28),
        (.08, .75, 1.18, .27), (.50, .68, 1.06, .21), (.80, .54, .88, .12)
    ], glass, root, radial=18, bevel=.010)
    for side in (-1, 1):
        _arch(f'TOURING_FENDER_{side}', collection, side * .87, 1.33, .40, .050, paint, root)
        _arch(f'TOURING_FENDER_REAR_{side}', collection, side * .87, -1.28, .40, .050, paint, root)
        box(f'TOURING_SILL_{side}', collection, blender_location(side * .98, .40, -.02), blender_size(.10, .13, 3.58), carbon, root, bevel=.018)
    _airfoil('TOURING_FRONT_SPLITTER', collection, (0, .27, 2.27), 2.03, .48, .055, carbon, root)
    _airfoil('TOURING_REAR_WING', collection, (0, 1.27, -2.06), 2.04, .34, .082, carbon, root)
    box('TOURING_NUMBER_PANEL', collection, blender_location(0, .74, -2.25), blender_size(.82, .38, .04), decal, root, bevel=.018)
    for x in (-0.59, 0.59):
        box('TOURING_WING_POST', collection, blender_location(x, 1.08, -1.90), blender_size(0.10, 0.35, 0.10), carbon, root, bevel=0.015)
        box('TOURING_HEADLAMP', collection, blender_location(x, 0.71, 2.37), blender_size(0.50, 0.13, 0.09), lamp, root, bevel=0.025)
    add_a_pillars(root, collection, 'TOURING', carbon, 0.68, 0.74)
    add_cockpit(root, collection, 'TOURING', interior, -0.53, 0.86, (-0.23, 1.18, -0.28))
    box('TOURING_DISPLAY', collection, blender_location(-.23, .87, .70), blender_size(.26, .10, .025), materials['display'], root, bevel=.008)
    wheel_materials = (tyre, rim, brake, caliper, carbon)
    for label, x, z in [('FL', -0.84, 1.33), ('FR', 0.84, 1.33), ('RL', -0.84, -1.28), ('RR', 0.84, -1.28)]:
        create_gt_wheel(root, collection, label, x, z, wheel_materials)


def build_prototype(root, collection, materials):
    paint, decal, carbon, glass, lamp = (materials[k] for k in ('paint', 'decal', 'carbon', 'glass', 'lamp'))
    rim, tyre, brake, caliper, interior = (materials[k] for k in ('rim', 'tyre', 'brake', 'caliper', 'interior'))
    _loft('COCKPIT_HIDE_PROTO_TUB', collection, [
        (-2.36, .42, .35, .10), (-2.12, .70, .42, .18), (-1.64, .83, .43, .26),
        (-1.02, .84, .42, .29), (-.34, .80, .38, .29), (.40, .73, .34, .24),
        (1.02, .64, .28, .18), (1.56, .52, .20, .12), (2.14, .36, .13, .07), (2.42, .18, .07, .035)
    ], paint, root, radial=18, bevel=.010)
    _loft('COCKPIT_HIDE_PROTO_CANOPY', collection, [
        (-.88, .40, .77, .08), (-.55, .53, .96, .17), (-.17, .55, 1.08, .23),
        (.18, .53, 1.05, .21), (.48, .45, .91, .14), (.68, .31, .75, .07)
    ], glass, root, radial=16, bevel=.009)
    for side in (-1, 1):
        _loft(f'PROTO_FENDER_{side}', collection, [
            (-1.82, .27, .35, .09), (-1.36, .35, .50, .16), (-.58, .34, .48, .15),
            (.26, .31, .43, .12), (1.08, .32, .42, .12), (1.72, .25, .28, .08)
        ], paint, root, radial=12, bevel=.008, x_offset=side * .92)
    _airfoil('PROTO_FRONT_SPLITTER', collection, (0, .19, 2.34), 2.02, .56, .045, carbon, root)
    _airfoil('PROTO_REAR_WING', collection, (0, 1.04, -2.12), 2.22, .38, .080, carbon, root)
    box('PROTO_NUMBER_PANEL', collection, blender_location(0, .55, -2.29), blender_size(.72, .30, .035), decal, root, bevel=.014)
    box('PROTO_FIN', collection, blender_location(0, 1.04, -1.20), blender_size(0.08, 0.75, 1.55), carbon, root, bevel=0.02)
    for x in (-0.92, 0.92):
        box('PROTO_LAMP', collection, blender_location(x * 0.78, 0.60, 2.02), blender_size(0.34, 0.10, 0.08), lamp, root, bevel=0.025)
    add_a_pillars(root, collection, 'PROTO', carbon, 0.47, 0.66)
    add_cockpit(root, collection, 'PROTO', interior, -0.48, 0.76, (-0.20, 1.08, -0.25))
    box('PROTO_DISPLAY', collection, blender_location(-.20, .77, .65), blender_size(.24, .09, .022), materials['display'], root, bevel=.007)
    wheel_materials = (tyre, rim, brake, caliper, carbon)
    for label, x, z in [('FL', -0.93, 1.34), ('FR', 0.93, 1.34), ('RL', -0.93, -1.34), ('RR', 0.93, -1.34)]:
        create_gt_wheel(root, collection, label, x, z, wheel_materials)


def make_car_materials():
    return (
        make_material('MAT_PAINT', (0.52, 0.04, 0.035), metallic=0.52, roughness=0.27),
        make_material('MAT_CARBON', (0.012, 0.018, 0.020), metallic=0.48, roughness=0.30),
        make_material('MAT_GLASS', (0.025, 0.12, 0.16), metallic=0.25, roughness=0.14, alpha=0.76),
        make_material('MAT_LAMP', (0.85, 0.95, 0.82), metallic=0.05, roughness=0.22, emission=(0.76, 0.94, 0.70)),
        make_material('MAT_RIM', (0.50, 0.56, 0.58), metallic=0.88, roughness=0.20),
        make_material('MAT_TYRE', (0.010, 0.012, 0.011), roughness=0.92),
        make_material('MAT_BRAKE', (0.29, 0.32, 0.34), metallic=0.90, roughness=0.22),
        make_material('MAT_CALIPER', (0.88, 0.18, 0.04), metallic=0.35, roughness=0.32),
        make_material('MAT_INTERIOR', (0.025, 0.035, 0.032), metallic=0.18, roughness=0.68)
    )


def select_hierarchy(root):
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root


def export_glb(root, filename, canonical_wheels=False):
    originals = []
    if canonical_wheels:
        # Blender requires globally unique object names, while each standalone
        # GLB must expose the same wheel-node contract to the runtime.
        originals = [(obj, obj.name) for obj in bpy.data.objects]
        target_ids = {obj.as_pointer() for obj in [root, *root.children_recursive]}
        for index, (obj, _) in enumerate(originals):
            obj.name = f'__export_tmp_{index}'
        wheel_names = {'FL', 'FR', 'RL', 'RR', 'FL_SPIN', 'FR_SPIN', 'RL_SPIN', 'RR_SPIN', 'COCKPIT_CAMERA'}
        for obj, original_name in originals:
            if obj.as_pointer() not in target_ids:
                continue
            base_name = original_name.split('.')[0]
            obj.name = base_name if base_name in wheel_names else original_name
    try:
        select_hierarchy(root)
        bpy.ops.export_scene.gltf(
            filepath=os.path.join(OUTPUT_DIR, filename),
            export_format='GLB',
            use_selection=True,
            export_apply=True,
            export_yup=True,
            export_texcoords=True,
            export_normals=True,
            export_tangents=True,
            export_materials='EXPORT',
            export_image_format='AUTO',
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            export_keep_originals=False
        )
    finally:
        if originals:
            for index, (obj, _) in enumerate(originals):
                obj.name = f'__restore_{index}'
            for obj, original_name in originals:
                obj.name = original_name


def build_car_library(gt_only=False):
    clear_scene()
    collection = new_collection('CAR_VARIANTS')
    gt_materials = make_gt_materials(make_gt_textures())
    touring_materials = make_variant_materials('touring', make_variant_textures('touring'))
    prototype_materials = make_variant_materials('prototype', make_variant_textures('prototype'))
    material_sets = {'CAR_GT': gt_materials, 'CAR_TOURING': touring_materials, 'CAR_PROTOTYPE': prototype_materials}
    variants = [('CAR_GT', 'car-gt.glb', build_gt), ('CAR_TOURING', 'car-touring.glb', build_touring), ('CAR_PROTOTYPE', 'car-prototype.glb', build_prototype)]
    roots = []
    for name, _, builder in variants:
        root = empty(name, collection)
        root['asset_type'] = 'car'
        root['wheel_nodes'] = 'FL,FR,RL,RR'
        builder(root, collection, material_sets[name])
        roots.append(root)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SOURCE_DIR, 'car-variants.blend'))
    for root, (_, filename, _) in zip(roots, variants):
        if gt_only and filename != 'car-gt.glb':
            continue
        export_glb(root, filename, canonical_wheels=True)


def build_prop_materials():
    textures = make_prop_textures()
    normal, orm = textures['normal'], textures['orm']
    return {
        'steel': make_textured_material('PROP_STEEL', textures['steel'], normal, orm, metallic=0.78, roughness=0.34),
        'concrete': make_textured_material('PROP_CONCRETE', textures['concrete'], normal, orm, roughness=0.82),
        'seat': make_textured_material('PROP_SEAT', textures['seat'], normal, orm, roughness=0.72),
        'yellow': make_textured_material('PROP_YELLOW', textures['yellow'], normal, orm, metallic=0.14, roughness=0.34),
        'red': make_textured_material('PROP_RED', textures['red'], normal, orm, roughness=0.48),
        'glass': make_textured_material('PROP_GLASS', textures['glass'], normal, orm, metallic=0.25, roughness=0.18, alpha=0.72),
        'rubber': make_textured_material('PROP_RUBBER', textures['rubber'], normal, orm, roughness=0.93),
        'foliage': make_textured_material('PROP_FOLIAGE', textures['foliage'], normal, orm, roughness=0.92),
        'trunk': make_textured_material('PROP_TRUNK', textures['trunk'], normal, orm, roughness=0.92),
        'lamp': make_textured_material('PROP_LAMP', textures['lamp'], normal, orm, metallic=0.05, roughness=0.20, emission=(0.78, 0.94, 0.70))
    }


def build_props(collection, mat):
    # Pit/garage module: scalable three-bay visual shell.
    pit = empty('PROP_PIT_MODULE', collection)
    box('PIT_BACK', collection, blender_location(0, 2.7, 0), blender_size(18, 5.4, 7.2), mat['steel'], pit, bevel=0.12)
    box('PIT_CANOPY', collection, blender_location(0, 5.5, 0.6), blender_size(19.0, 0.28, 8.6), mat['steel'], pit, bevel=0.07)
    box('PIT_FASCIA', collection, blender_location(0, 5.16, -3.68), blender_size(18.8, 0.72, 0.16), mat['yellow'], pit, bevel=0.025)
    for x in (-5.8, 0, 5.8):
        box('PIT_DOOR', collection, blender_location(x, 1.82, -3.66), blender_size(4.5, 3.1, 0.10), mat['glass'], pit, bevel=0.03)

    stand = empty('PROP_GRANDSTAND', collection)
    box('STAND_BASE', collection, blender_location(0, 0.55, 0), blender_size(17, 1.1, 6), mat['concrete'], stand, bevel=0.08)
    for row in range(5):
        box('STAND_STEP', collection, blender_location(0, 1.18 + row * 0.72, -1.9 + row * 0.75), blender_size(17, 0.42, 1.18), mat['steel'], stand, bevel=0.025)
        for col in range(13):
            seat_mat = mat['seat'] if (row + col) % 3 else mat['yellow']
            box('STAND_SEAT', collection, blender_location(-7.45 + col * 1.24, 1.48 + row * 0.72, -2.13 + row * 0.75), blender_size(0.66, 0.30, 0.55), seat_mat, stand, bevel=0.05)
    box('STAND_ROOF', collection, blender_location(0, 5.45, 0.72), blender_size(18.6, 0.25, 7.4), mat['steel'], stand, bevel=0.07)

    marshal = empty('PROP_MARSHAL_POST', collection)
    box('MARSHAL_BASE', collection, blender_location(0, 0.45, 0), blender_size(2.2, 0.9, 2.2), mat['concrete'], marshal, bevel=0.06)
    box('MARSHAL_BOOTH', collection, blender_location(0, 2.25, 0), blender_size(1.75, 2.7, 1.75), mat['yellow'], marshal, bevel=0.08)
    box('MARSHAL_WINDOW', collection, blender_location(0, 2.45, -0.91), blender_size(1.25, 1.0, 0.08), mat['glass'], marshal, bevel=0.02)
    cylinder('MARSHAL_POLE', collection, blender_location(0, 5.1, 0), 0.07, 3.0, mat['steel'], marshal, vertices=10)

    tire_stack = empty('PROP_TIRE_STACK', collection)
    for layer in range(4):
        cylinder('TIRE_STACK', collection, blender_location(0, 0.32 + layer * 0.24, 0), 0.53, 0.22, mat['rubber'], tire_stack, rotation=(0, math.pi * 0.5, 0), vertices=18, bevel=0.015)

    tecpro = empty('PROP_TECPRO', collection)
    for index in range(4):
        block = box('TECPRO_BLOCK', collection, blender_location(0, 0.35 + (index % 2) * 0.30, -1.2 + index * 0.8), blender_size(0.72, 0.56, 0.72), mat['yellow'] if index % 2 else mat['red'], tecpro, bevel=0.10)
        block.rotation_euler[2] = (index % 2) * 0.04

    gantry = empty('PROP_GANTRY', collection)
    for x in (-6, 6):
        cylinder('GANTRY_POST', collection, blender_location(x, 4.6, 0), 0.15, 9.2, mat['steel'], gantry, vertices=12)
    box('GANTRY_BEAM', collection, blender_location(0, 8.85, 0), blender_size(13.2, 0.32, 0.48), mat['steel'], gantry, bevel=0.05)
    box('GANTRY_SIGN', collection, blender_location(0, 7.6, -0.18), blender_size(8.8, 1.65, 0.14), mat['yellow'], gantry, bevel=0.08)

    tower = empty('PROP_LIGHT_TOWER', collection)
    cylinder('TOWER_MAST', collection, blender_location(0, 6.5, 0), 0.19, 13, mat['steel'], tower, vertices=10)
    box('TOWER_ARM', collection, blender_location(0, 12.2, 0), blender_size(5.0, 0.16, 0.25), mat['steel'], tower, bevel=0.02)
    for x in (-1.55, 0, 1.55):
        box('TOWER_LAMP', collection, blender_location(x, 11.95, 0.16), blender_size(0.82, 0.48, 0.32), mat['lamp'], tower, bevel=0.04)

    fence = empty('PROP_FENCE_PANEL', collection)
    for x in (-1.6, 1.6):
        cylinder('FENCE_POST', collection, blender_location(x, 1.35, 0), 0.06, 2.7, mat['steel'], fence, vertices=8)
    for y in (0.6, 1.3, 2.0):
        box('FENCE_RAIL', collection, blender_location(0, y, 0), blender_size(3.35, 0.045, 0.045), mat['steel'], fence, bevel=0.008)

    tree = empty('PROP_TREE', collection)
    cylinder('TREE_TRUNK', collection, blender_location(0, 1.35, 0), 0.16, 2.7, mat['trunk'], tree, vertices=8)
    sphere('TREE_CROWN_LOW', collection, blender_location(0, 3.45, 0), (1.35, 1.6, 1.35), mat['foliage'], tree, subdivisions=2)
    sphere('TREE_CROWN_HIGH', collection, blender_location(0.28, 4.65, -0.12), (1.0, 1.2, 1.0), mat['foliage'], tree, subdivisions=2)

    # Circuit-landmark kit. These roots are intentionally separate so runtime
    # scenarios can clone them independently instead of loading bespoke GLBs.
    control_tower = empty('PROP_CONTROL_TOWER', collection)
    box('CONTROL_TOWER_CORE', collection, blender_location(0, 5.8, 0), blender_size(9.2, 11.6, 8.4), mat['concrete'], control_tower, bevel=0.13)
    box('CONTROL_TOWER_GLAZING', collection, blender_location(0, 10.4, -4.27), blender_size(9.7, 2.8, 0.16), mat['glass'], control_tower, bevel=0.025)
    box('CONTROL_TOWER_BALCONY', collection, blender_location(0, 9.0, -4.75), blender_size(11.0, 0.30, 1.25), mat['steel'], control_tower, bevel=0.04)
    box('CONTROL_TOWER_CROWN', collection, blender_location(0, 12.0, 0), blender_size(10.4, 0.36, 9.6), mat['steel'], control_tower, bevel=0.06)
    for x in (-3.8, -1.9, 0, 1.9, 3.8):
        box('CONTROL_TOWER_WINDOW_MULLION', collection, blender_location(x, 10.4, -4.40), blender_size(0.10, 3.0, 0.12), mat['steel'], control_tower, bevel=0.01)
    cylinder('CONTROL_TOWER_BEACON', collection, blender_location(0, 12.45, 0), 0.26, 0.45, mat['lamp'], control_tower, vertices=12, bevel=0.02)

    hospitality = empty('PROP_HOSPITALITY', collection)
    box('HOSPITALITY_DECK', collection, blender_location(0, 0.45, 0), blender_size(27, 0.9, 11), mat['concrete'], hospitality, bevel=0.08)
    box('HOSPITALITY_SUITE', collection, blender_location(0, 3.35, 0.8), blender_size(25.5, 5.2, 9.2), mat['glass'], hospitality, bevel=0.10)
    box('HOSPITALITY_ROOF', collection, blender_location(0, 6.25, 0.8), blender_size(29.0, 0.45, 12.0), mat['steel'], hospitality, bevel=0.08)
    box('HOSPITALITY_FASCIA', collection, blender_location(0, 5.65, -3.85), blender_size(27.2, 0.72, 0.18), mat['yellow'], hospitality, bevel=0.025)
    for x in (-10, -5, 0, 5, 10):
        box('HOSPITALITY_MULLION', collection, blender_location(x, 3.35, -3.87), blender_size(0.12, 5.0, 0.12), mat['steel'], hospitality, bevel=0.01)

    footbridge = empty('PROP_FOOTBRIDGE', collection)
    for x in (-12.5, 12.5):
        box('FOOTBRIDGE_PIER', collection, blender_location(x, 4.1, 0), blender_size(1.15, 8.2, 2.4), mat['concrete'], footbridge, bevel=0.08)
        box('FOOTBRIDGE_STAIR', collection, blender_location(x * 1.08, 2.5, 3.8), blender_size(3.3, 4.6, 6.6), mat['steel'], footbridge, bevel=0.04)
    box('FOOTBRIDGE_SPAN', collection, blender_location(0, 8.2, 0), blender_size(27.2, 1.15, 3.25), mat['steel'], footbridge, bevel=0.06)
    box('FOOTBRIDGE_SIGN', collection, blender_location(0, 7.95, -1.72), blender_size(11.8, 1.45, 0.16), mat['yellow'], footbridge, bevel=0.06)
    for x in (-10.5, -5.25, 0, 5.25, 10.5):
        cylinder('FOOTBRIDGE_RAIL_POST', collection, blender_location(x, 9.25, -1.30), 0.045, 1.8, mat['steel'], footbridge, vertices=6)

    service_truck = empty('PROP_SERVICE_TRUCK', collection)
    box('SERVICE_TRUCK_CHASSIS', collection, blender_location(0, 0.58, 0), blender_size(2.5, 0.52, 5.8), mat['steel'], service_truck, bevel=0.05)
    box('SERVICE_TRUCK_CAB', collection, blender_location(0, 1.65, 1.65), blender_size(2.35, 1.65, 2.05), mat['red'], service_truck, bevel=0.12)
    box('SERVICE_TRUCK_WINDSCREEN', collection, blender_location(0, 1.95, 2.72), blender_size(1.85, 0.75, 0.10), mat['glass'], service_truck, bevel=0.02)
    box('SERVICE_TRUCK_BODY', collection, blender_location(0, 1.75, -1.15), blender_size(2.45, 2.1, 3.25), mat['yellow'], service_truck, bevel=0.10)
    for x in (-1.18, 1.18):
        for z in (-1.75, 1.75):
            cylinder('SERVICE_TRUCK_WHEEL', collection, blender_location(x, 0.46, z), 0.40, 0.28, mat['rubber'], service_truck, rotation=(0, math.pi * 0.5, 0), vertices=14, bevel=0.01)
    box('SERVICE_TRUCK_LIGHTBAR', collection, blender_location(0, 2.62, 1.55), blender_size(1.32, 0.18, 0.28), mat['lamp'], service_truck, bevel=0.03)

    crane = empty('PROP_CRANE', collection)
    box('CRANE_BASE', collection, blender_location(0, 0.36, 0), blender_size(5.4, 0.72, 4.3), mat['concrete'], crane, bevel=0.08)
    cylinder('CRANE_MAST', collection, blender_location(0, 10.2, 0), 0.38, 20.4, mat['yellow'], crane, vertices=10)
    box('CRANE_JIB', collection, blender_location(0, 19.7, -12.0), blender_size(0.78, 0.55, 25.5), mat['yellow'], crane, bevel=0.04)
    box('CRANE_COUNTER_JIB', collection, blender_location(0, 18.9, 4.0), blender_size(1.3, 0.75, 8.8), mat['steel'], crane, bevel=0.04)
    cylinder('CRANE_CABLE', collection, blender_location(0, 12.5, -21.5), 0.035, 13.8, mat['steel'], crane, vertices=6)
    box('CRANE_HOOK', collection, blender_location(0, 5.2, -21.5), blender_size(0.8, 0.95, 0.35), mat['red'], crane, bevel=0.05)

    light_gantry = empty('PROP_LIGHT_GANTRY', collection)
    for x in (-8.3, 8.3):
        cylinder('LIGHT_GANTRY_POST', collection, blender_location(x, 5.1, 0), 0.18, 10.2, mat['steel'], light_gantry, vertices=10)
    box('LIGHT_GANTRY_BEAM', collection, blender_location(0, 9.85, 0), blender_size(18.0, 0.38, 0.52), mat['steel'], light_gantry, bevel=0.05)
    for x in (-5.4, -1.8, 1.8, 5.4):
        box('LIGHT_GANTRY_LAMP', collection, blender_location(x, 9.35, -0.18), blender_size(1.4, 0.54, 0.38), mat['lamp'], light_gantry, bevel=0.04)


def build_prop_library():
    clear_scene()
    collection = new_collection('TRACK_PROPS')
    build_props(collection, build_prop_materials())
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SOURCE_DIR, 'track-props.blend'))
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUTPUT_DIR, 'circuit-props.glb'),
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT',
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_keep_originals=False
    )


def main():
    ensure_directories()
    gt_only = '--gt-only' in sys.argv
    build_car_library(gt_only=gt_only)
    if not gt_only:
        build_prop_library()
    print('APEX//73 assets built:', OUTPUT_DIR, '(GT only)' if gt_only else '(full library)')


if __name__ == '__main__':
    main()
