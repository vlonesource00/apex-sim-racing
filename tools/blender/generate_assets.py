import bpy
import os
import math

def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()

def create_material(name, color, roughness=0.5, metallic=0.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*color, 1.0)
        bsdf.inputs['Roughness'].default_value = roughness
        bsdf.inputs['Metallic'].default_value = metallic
    return mat

def create_gt3_car():
    clear_scene()
    
    # Body
    bpy.ops.mesh.primitive_cube_add(size=1)
    body = bpy.context.active_object
    body.name = "Body"
    body.scale = (2.0, 4.5, 0.8)
    body.location = (0, 0, 0.6)
    mat_body = create_material("CarPaint", (0.8, 0.1, 0.1), 0.2, 0.8)
    body.data.materials.append(mat_body)
    
    # Cockpit
    bpy.ops.mesh.primitive_cube_add(size=1)
    cockpit = bpy.context.active_object
    cockpit.name = "Cockpit"
    cockpit.scale = (1.6, 2.0, 0.6)
    cockpit.location = (0, -0.2, 1.3)
    mat_glass = create_material("Glass", (0.1, 0.1, 0.1), 0.1, 0.0)
    cockpit.data.materials.append(mat_glass)
    cockpit.parent = body
    
    # Spoiler
    bpy.ops.mesh.primitive_cube_add(size=1)
    spoiler = bpy.context.active_object
    spoiler.name = "Spoiler"
    spoiler.scale = (1.8, 0.4, 0.1)
    spoiler.location = (0, 2.1, 1.5)
    mat_carbon = create_material("Carbon", (0.1, 0.1, 0.1), 0.6, 0.0)
    spoiler.data.materials.append(mat_carbon)
    spoiler.parent = body
    
    # Diffuser
    bpy.ops.mesh.primitive_cube_add(size=1)
    diffuser = bpy.context.active_object
    diffuser.name = "Diffuser"
    diffuser.scale = (1.9, 0.5, 0.2)
    diffuser.location = (0, 2.2, 0.3)
    diffuser.data.materials.append(mat_carbon)
    diffuser.parent = body

    # Brake Lights
    bpy.ops.mesh.primitive_cube_add(size=1)
    brakelight = bpy.context.active_object
    brakelight.name = "BrakeLight"
    brakelight.scale = (1.5, 0.1, 0.2)
    brakelight.location = (0, 2.25, 0.8)
    mat_emissive = create_material("BrakeLightMat", (1.0, 0.0, 0.0), 1.0, 0.0)
    mat_emissive.node_tree.nodes["Principled BSDF"].inputs['Emission Color'].default_value = (1.0, 0.0, 0.0, 1.0)
    mat_emissive.node_tree.nodes["Principled BSDF"].inputs['Emission Strength'].default_value = 0.0
    brakelight.data.materials.append(mat_emissive)
    brakelight.parent = body
    
    # Wheels
    wheel_offsets = [(-1.0, -1.5, 0.4), (1.0, -1.5, 0.4), (-1.0, 1.5, 0.4), (1.0, 1.5, 0.4)]
    wheel_names = ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"]
    mat_tire = create_material("Tire", (0.05, 0.05, 0.05), 0.9, 0.0)
    mat_rim = create_material("Rim", (0.7, 0.7, 0.7), 0.3, 0.9)
    
    for i, offset in enumerate(wheel_offsets):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.4, depth=0.3, vertices=32)
        wheel = bpy.context.active_object
        wheel.name = wheel_names[i]
        wheel.rotation_euler = (0, math.pi/2, 0)
        wheel.location = offset
        wheel.data.materials.append(mat_tire)
        
        # Rim
        bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=0.32, vertices=16)
        rim = bpy.context.active_object
        rim.name = f"Rim_{i}"
        rim.rotation_euler = (0, math.pi/2, 0)
        rim.location = offset
        rim.data.materials.append(mat_rim)
        rim.parent = wheel
        
        wheel.parent = body

def create_props():
    clear_scene()
    
    # Grandstand
    bpy.ops.mesh.primitive_cube_add(size=1)
    grandstand = bpy.context.active_object
    grandstand.name = "Grandstand"
    grandstand.scale = (10, 3, 5)
    grandstand.location = (0, 10, 2.5)
    
    # Pine Tree
    bpy.ops.mesh.primitive_cone_add(radius1=1, depth=3)
    tree = bpy.context.active_object
    tree.name = "PineTree"
    tree.location = (5, 5, 1.5)
    
    # Tire Wall
    bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1)
    tire_wall = bpy.context.active_object
    tire_wall.name = "TireWall"
    tire_wall.location = (-5, 5, 0.5)

def export_gt3(output_path):
    create_gt3_car()
    bpy.ops.export_scene.gltf(filepath=output_path, export_format='GLB')

def export_props(output_path):
    create_props()
    bpy.ops.export_scene.gltf(filepath=output_path, export_format='GLB')

if __name__ == "__main__":
    out_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'models'))
    os.makedirs(out_dir, exist_ok=True)
    
    gt3_path = os.path.join(out_dir, 'gt3_car.glb')
    export_gt3(gt3_path)
    
    props_path = os.path.join(out_dir, 'props.glb')
    export_props(props_path)
