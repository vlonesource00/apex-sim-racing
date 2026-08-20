import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

let sharedGltf = null;
let gltfLoading = false;
const gltfCallbacks = [];

function loadGLTF(url, callback) {
  if (sharedGltf) {
    callback(sharedGltf);
    return;
  }
  gltfCallbacks.push(callback);
  if (gltfLoading) return;
  gltfLoading = true;
  const loader = new GLTFLoader();
  loader.load(url, (gltf) => {
    sharedGltf = gltf;
    gltfLoading = false;
    for (const cb of gltfCallbacks) cb(gltf);
    gltfCallbacks.length = 0;
  }, undefined, (e) => {
    console.warn('GLTF load fallback to procedural geometry:', e);
    gltfLoading = false;
    gltfCallbacks.length = 0;
  });
}

export function buildCarMesh(car) {
  const s = car.setup;
  const L = s.body.length, W = s.body.width, H = s.body.height;
  const group = new THREE.Group();
  
  // -- FALLBACK MESH --
  const fallbackGroup = new THREE.Group();
  const body = new THREE.Group();
  fallbackGroup.add(body);
  group.add(fallbackGroup);

  const paint = new THREE.MeshStandardMaterial({ color: car.colorHex, roughness: 0.32, metalness: 0.4 });
  const paintDark = new THREE.MeshStandardMaterial({ color: new THREE.Color(car.colorHex).multiplyScalar(0.55), roughness: 0.4, metalness: 0.4 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.6, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d1620, roughness: 0.08, metalness: 0.7 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.96 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb9bfc7, roughness: 0.35, metalness: 0.85 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xdfe8ee, emissive: 0xfff6d8, emissiveIntensity: 0.6 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.5 });

  const box = (w, h, d, mat, x, y, z, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    m.castShadow = true;
    body.add(m);
    return m;
  };

  box(L * 0.98, 0.20, W * 0.94, carbon, 0, 0.24, 0);                 
  box(L * 0.94, 0.30, W * 0.97, paint, 0, 0.47, 0);                 
  box(L * 0.30, 0.14, W * 0.84, paint, L * 0.34, 0.60, 0, -0.06);   
  box(L * 0.26, 0.10, W * 0.88, paint, L * 0.14, 0.66, 0, 0.05);    
  box(L * 0.24, 0.06, W * 0.74, glass, L * 0.0, 0.80, 0, 0.55);     
  box(L * 0.26, 0.08, W * 0.68, paint, -L * 0.13, 0.94, 0);         
  box(L * 0.24, 0.06, W * 0.70, glass, -L * 0.28, 0.82, 0, -0.5);   
  box(L * 0.22, 0.14, W * 0.92, paintDark, -L * 0.38, 0.62, 0, 0.08); 

  box(L * 0.30, 0.16, 0.06, carbon, -L * 0.16, 0.5, W * 0.49);
  box(L * 0.30, 0.16, 0.06, carbon, -L * 0.16, 0.5, -W * 0.49);
  box(L * 0.8, 0.10, 0.05, carbon, 0, 0.16, W * 0.48);
  box(L * 0.8, 0.10, 0.05, carbon, 0, 0.16, -W * 0.48);

  const halfT = s.trackWidth / 2;
  const ax = s.wheelbase * 0.46;
  for (const [px, pz] of [[ax, halfT], [ax, -halfT], [-ax, halfT], [-ax, -halfT]]) {
    box(1.02, 0.42, 0.36, paintDark, px, 0.44, pz);
  }

  box(0.06, 0.09, 0.34, headMat, L * 0.485, 0.52, W * 0.30);
  box(0.06, 0.09, 0.34, headMat, L * 0.485, 0.52, -W * 0.30);
  const tailL = box(0.05, 0.08, 0.4, tailMat, -L * 0.49, 0.6, W * 0.28);
  const tailR = box(0.05, 0.08, 0.4, tailMat, -L * 0.49, 0.6, -W * 0.28);

  const wing = box(0.30, 0.045, W * 0.96, carbon, -L * 0.47, H * 0.98, 0, -0.12);
  box(0.06, 0.26, 0.07, carbon, -L * 0.46, H * 0.8, W * 0.32);
  box(0.06, 0.26, 0.07, carbon, -L * 0.46, H * 0.8, -W * 0.32);
  box(0.34, 0.16, 0.03, carbon, -L * 0.47, H * 0.98, W * 0.48);
  box(0.34, 0.16, 0.03, carbon, -L * 0.47, H * 0.98, -W * 0.48);

  box(0.42, 0.05, W * 0.98, carbon, L * 0.48, 0.10, 0);
  box(0.3, 0.12, W * 0.9, carbon, -L * 0.47, 0.14, 0);
  box(0.03, 0.06, 0.16, carbon, L * 0.06, 0.86, W * 0.42);
  box(0.03, 0.06, 0.16, carbon, L * 0.06, 0.86, -W * 0.42);

  const dash = box(0.22, 0.16, W * 0.62, carbon, 0.52, 0.98, 0);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 8, 20), carbon);
  wheel.position.set(0.40, 1.02, 0);
  wheel.rotation.y = Math.PI / 2;
  body.add(wheel);
  const seat = box(0.12, 0.5, 0.44, carbon, -0.25, 0.95, 0);

  const wheelGeo = new THREE.CylinderGeometry(s.wheelRadius, s.wheelRadius, 0.32, 24);
  wheelGeo.rotateX(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(s.wheelRadius * 0.6, s.wheelRadius * 0.6, 0.34, 5);
  rimGeo.rotateX(Math.PI / 2);
  
  const fbWheels = [];
  for (let i = 0; i < 4; i++) {
    const wg = new THREE.Group();
    const tire = new THREE.Mesh(wheelGeo, tireMat);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    tire.castShadow = true;
    wg.add(tire, rim);
    const px = i < 2 ? ax : -ax;
    const pz = i % 2 === 0 ? halfT + 0.02 : -halfT - 0.02;
    wg.position.set(px, s.wheelRadius, pz);
    fallbackGroup.add(wg);
    fbWheels.push({ group: wg, tire, rim, steer: i < 2 });
  }

  // -- GLTF LOADING --
  let gltfRoot = null;
  let gltfBody = null;
  let gltfWheels = [];
  let gltfBrakeLights = [];

  loadGLTF('/assets/models/gt3_car.glb', (gltf) => {
    const model = gltf.scene.clone();
    gltfRoot = model;
    
    // Scale or offset model as needed
    // Assuming model is sized correctly, might need rotation/scaling depending on Blender export
    
    // We clone materials for livery
    model.traverse((child) => {
      if (child.isMesh) {
        if (child.material) {
          child.material = child.material.clone();
          if (child.material.name === "CarPaint" || child.name === "Body") {
            child.material.color.setHex(car.colorHex);
          }
          if (child.name === "BrakeLight" || child.material.name === "BrakeLightMat") {
            gltfBrakeLights.push(child.material);
          }
        }
      }
    });

    const bodyNode = model.getObjectByName('Body');
    if (bodyNode) gltfBody = bodyNode;

    const wn = ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"];
    for (let i=0; i<4; i++) {
        const wNode = model.getObjectByName(wn[i]);
        if (wNode) gltfWheels[i] = wNode;
    }

    group.add(model);
    fallbackGroup.visible = false;
  });

  function update(car, dt) {
    group.position.copy(car.pos);
    group.rotation.y = car.heading;

    if (gltfRoot) {
      if (gltfBody) {
        gltfBody.rotation.x = car.pitch;
        gltfBody.rotation.z = car.roll;
      }
      for (let i = 0; i < 4; i++) {
        if (!gltfWheels[i]) continue;
        const wNode = gltfWheels[i];
        const cw = car.wheels[i];
        
        // Handle steering
        // If front wheels steer (index 0 and 1)
        if (i < 2) {
            // Apply steering rotation. Need to keep original orientation if any.
            // Let's assume the wheel container handles position and steer, and a child handles spin
            // Since we built the wheels in Blender facing a specific way, we apply Euler rotations
            wNode.rotation.y = car._steer;
        }
        
        // Spin and suspension
        // Since wheel in blender was exported, we might need a sub-node for spin, or we spin the wheel object.
        // It's simpler to set the rotation on X for spin and Z for something else, depending on axis in blender.
        // In our blender script, wheels have rotation_euler = (0, math.pi/2, 0).
        wNode.rotation.x = cw.spin;
        
        // update position based on suspension
        const px = i < 2 ? ax : -ax;
        const pz = i % 2 === 0 ? halfT + 0.02 : -halfT - 0.02;
        wNode.position.y = s.wheelRadius - cw.suspDefl;
      }
      for (let m of gltfBrakeLights) {
          m.emissiveIntensity = 0.5 + car.input.brake * 2.5;
      }
    } else {
      body.rotation.x = car.pitch;
      body.rotation.z = car.roll;
      for (let i = 0; i < 4; i++) {
        const w = fbWheels[i];
        const cw = car.wheels[i];
        w.group.rotation.y = w.steer ? car._steer : 0;
        w.tire.rotation.z = cw.spin;
        w.rim.rotation.z = cw.spin;
        w.group.position.y = s.wheelRadius - cw.suspDefl;
      }
      wheel.rotation.x = car._steer * 2.6; 
      tailMat.emissiveIntensity = 0.5 + car.input.brake * 2.5;
    }
  }

  function dispose() {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  }

  return { group, update, dispose };
}
