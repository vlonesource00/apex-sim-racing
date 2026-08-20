import * as THREE from 'three';

export function buildCarMesh(car) {
  const s = car.setup;
  const L = s.body.length, W = s.body.width, H = s.body.height;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // --- Materials ---
  const paintColor = new THREE.Color(car.colorHex);
  const darkColor = paintColor.clone().multiplyScalar(0.4);
  const accentColor = paintColor.clone().offsetHSL(0.08, 0.2, 0.1);

  const paint = new THREE.MeshStandardMaterial({
    color: paintColor,
    roughness: 0.15,
    metalness: 0.8,
  });

  const paintAccent = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.2,
    metalness: 0.7,
  });

  const paintDark = new THREE.MeshStandardMaterial({
    color: darkColor,
    roughness: 0.3,
    metalness: 0.6,
  });

  const carbon = new THREE.MeshStandardMaterial({
    color: 0x121417,
    roughness: 0.45,
    metalness: 0.5,
  });

  const glass = new THREE.MeshStandardMaterial({
    color: 0x05080c,
    roughness: 0.05,
    metalness: 0.95,
    transparent: true,
    opacity: 0.82,
  });

  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x151618,
    roughness: 0.9,
    metalness: 0.05,
  });

  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xd0d5db,
    roughness: 0.22,
    metalness: 0.92,
  });

  const brakeDiscMat = new THREE.MeshStandardMaterial({
    color: 0x828a91,
    roughness: 0.28,
    metalness: 0.9,
  });

  const caliperMat = new THREE.MeshStandardMaterial({
    color: 0xee1111,
    roughness: 0.25,
    metalness: 0.6,
  });

  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xfffae8,
    emissiveIntensity: 1.1,
    roughness: 0.1,
  });

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x330000,
    emissive: 0xff1818,
    emissiveIntensity: 0.8,
    roughness: 0.2,
  });

  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    roughness: 0.12,
    metalness: 0.95,
  });

  const addMesh = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  const addBox = (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = body) => {
    return addMesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz, parent);
  };

  // ==========================================
  // 1. SLEEK GT3 BODYWORK (Aerodynamic Supercar)
  // (+X = forward, +Y = up, +Z = left, -Z = right)
  // ==========================================

  // --- Carbon Undertray & Front Splitter ---
  addBox(L * 0.96, 0.03, W * 0.92, carbon, 0, 0.08, 0);
  // Extended Front Splitter with side canard winglets
  addBox(0.60, 0.03, W * 0.96, carbon, L * 0.46, 0.07, 0);
  addBox(0.24, 0.10, 0.02, carbon, L * 0.46, 0.12, W * 0.47, 0, 0, 0.15);
  addBox(0.24, 0.10, 0.02, carbon, L * 0.46, 0.12, -W * 0.47, 0, 0, 0.15);

  // --- Rear Diffuser with 4 vertical strakes ---
  addBox(0.55, 0.06, W * 0.92, carbon, -L * 0.45, 0.11, 0, 0, 0, 0.08);
  for (const z of [-0.55, -0.18, 0.18, 0.55]) {
    addBox(0.48, 0.10, 0.02, carbon, -L * 0.45, 0.12, z, 0, 0, 0.08);
  }

  // --- Lower Hull & Side Sills ---
  addBox(L * 0.82, 0.22, W * 0.88, paint, -0.04, 0.24, 0);
  addBox(1.60, 0.06, 0.05, carbon, -0.08, 0.11, W * 0.45);
  addBox(1.60, 0.06, 0.05, carbon, -0.08, 0.11, -W * 0.45);

  // --- Sculpted Nose & Front Intakes ---
  addBox(0.65, 0.16, W * 0.82, paint, L * 0.36, 0.24, 0, 0, 0, -0.04);
  // Front central radiator intake cavity
  addBox(0.15, 0.10, W * 0.54, carbon, L * 0.47, 0.17, 0);
  // Left/Right brake cooling ducts
  addBox(0.12, 0.08, 0.18, carbon, L * 0.46, 0.17, W * 0.34);
  addBox(0.12, 0.08, 0.18, carbon, L * 0.46, 0.17, -W * 0.34);

  // --- Sloping Aerodynamic Hood with Extractor Vents ---
  addBox(0.92, 0.06, W * 0.78, paint, L * 0.18, 0.37, 0, 0, 0, 0.05);
  // Hood carbon extraction louver
  addBox(0.45, 0.02, W * 0.42, carbon, L * 0.22, 0.38, 0, 0, 0, 0.05);

  // --- Wheel Fenders (Flared GT3 Widebody) ---
  const ax = s.wheelbase * 0.46; // ~1.205
  const halfT = s.trackWidth / 2; // ~0.84

  // Front Fenders
  addBox(0.85, 0.26, 0.18, paint, ax, 0.31, halfT + 0.02);
  addBox(0.85, 0.26, 0.18, paint, ax, 0.31, -halfT - 0.02);
  // Rear Fenders (Aggressive muscle haunches)
  addBox(0.92, 0.28, 0.22, paint, -ax * 1.15, 0.33, halfT + 0.03);
  addBox(0.92, 0.28, 0.22, paint, -ax * 1.15, 0.33, -halfT - 0.03);

  // --- Cabin & Glasshouse Canopy ---
  // Windshield (Sleek raked glass)
  addBox(0.68, 0.03, W * 0.68, glass, L * 0.04, 0.56, 0, 0, 0, 0.56);
  // Roof (Sculpted double-bubble profile)
  addBox(0.82, 0.04, W * 0.62, paint, -L * 0.10, 0.72, 0);
  // Roof intake scoop
  addBox(0.26, 0.03, 0.08, carbon, -L * 0.08, 0.75, 0);
  // Fastback Rear Engine Hatch / Glass
  addBox(0.78, 0.03, W * 0.64, glass, -L * 0.28, 0.56, 0, 0, 0, -0.44);
  // Side Windows
  addBox(0.72, 0.20, 0.02, glass, -L * 0.10, 0.60, W * 0.31);
  addBox(0.72, 0.20, 0.02, glass, -L * 0.10, 0.60, -W * 0.31);

  // --- Rear Tail & Engine Deck ---
  addBox(0.52, 0.18, W * 0.86, paintDark, -L * 0.38, 0.35, 0);

  // --- Aerodynamic Side Mirrors ---
  addBox(0.06, 0.05, 0.12, carbon, L * 0.08, 0.55, W * 0.38);
  addBox(0.06, 0.05, 0.12, carbon, L * 0.08, 0.55, -W * 0.38);

  // --- Swan-Neck High Downforce GT Rear Wing ---
  const wingY = 0.82;
  const wingX = -L * 0.44;
  // Dual-element Carbon Wing Foil
  addBox(0.30, 0.03, W * 0.94, carbon, wingX, wingY, 0, 0, 0, -0.08);
  // Swan-neck curved pylons
  addBox(0.14, 0.30, 0.03, carbon, wingX + 0.05, wingY - 0.15, W * 0.22);
  addBox(0.14, 0.30, 0.03, carbon, wingX + 0.05, wingY - 0.15, -W * 0.22);
  // Wing Endplates
  addBox(0.36, 0.18, 0.02, carbon, wingX, wingY, W * 0.47);
  addBox(0.36, 0.18, 0.02, carbon, wingX, wingY, -W * 0.47);

  // --- Modern Lighting Systems ---
  // Angled Dual Projector LED Headlights
  addBox(0.10, 0.06, 0.24, headMat, L * 0.44, 0.31, W * 0.30, 0, -0.12, 0);
  addBox(0.10, 0.06, 0.24, headMat, L * 0.44, 0.31, -W * 0.30, 0, 0.12, 0);

  // Full-width Sleek Rear LED Taillight Lightbar
  const tailLight = addBox(0.03, 0.05, W * 0.78, tailMat, -L * 0.465, 0.38, 0);

  // Dual Stainless Exhaust Pipes
  addBox(0.10, 0.06, 0.12, chromeMat, -L * 0.47, 0.18, 0.18);
  addBox(0.10, 0.06, 0.12, chromeMat, -L * 0.47, 0.18, -0.18);

  // --- Cockpit Interior ---
  // Dashboard
  addBox(0.30, 0.14, W * 0.56, carbon, 0.34, 0.42, 0);
  // MoTeC DDU Display Screen
  addBox(0.02, 0.07, 0.14, headMat, 0.20, 0.48, 0.08);
  // Racing Bucket Seat
  addBox(0.14, 0.42, 0.38, carbon, -0.20, 0.40, 0.12);
  // Roll cage structure
  addBox(0.03, 0.38, 0.03, chromeMat, -0.08, 0.52, W * 0.26);
  addBox(0.03, 0.38, 0.03, chromeMat, -0.08, 0.52, -W * 0.26);
  addBox(0.03, 0.03, W * 0.52, chromeMat, -0.08, 0.70, 0);

  // Steering Wheel
  const wheelGroup = new THREE.Group();
  const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.016, 8, 16), carbon);
  wheelRim.rotation.y = Math.PI / 2;
  wheelGroup.add(wheelRim);
  wheelGroup.position.set(0.16, 0.46, 0.12);
  body.add(wheelGroup);

  // ==========================================
  // 2. DETAILED WHEEL ASSEMBLIES (4x)
  // ==========================================
  const rTire = s.wheelRadius; // 0.33
  const tireGeo = new THREE.CylinderGeometry(rTire, rTire, 0.28, 24);
  tireGeo.rotateX(Math.PI / 2);

  const rimBarrelGeo = new THREE.CylinderGeometry(rTire * 0.65, rTire * 0.65, 0.29, 20);
  rimBarrelGeo.rotateX(Math.PI / 2);

  const discGeo = new THREE.CylinderGeometry(rTire * 0.52, rTire * 0.52, 0.03, 16);
  discGeo.rotateX(Math.PI / 2);

  const caliperGeo = new THREE.BoxGeometry(0.08, 0.15, 0.06);
  const spokeGeo = new THREE.BoxGeometry(0.035, rTire * 0.60, 0.018);

  const wheels = [];
  const axleX = [ax, ax, -ax * 1.15, -ax * 1.15];
  const axleZ = [halfT + 0.02, -halfT - 0.02, halfT + 0.03, -halfT - 0.03];

  for (let i = 0; i < 4; i++) {
    const steerableGroup = new THREE.Group();
    const spinGroup = new THREE.Group();

    // Tire
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.castShadow = true;
    spinGroup.add(tire);

    // Rim Outer Barrel
    const rim = new THREE.Mesh(rimBarrelGeo, rimMat);
    spinGroup.add(rim);

    // Center Hub & 5 Spokes
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.30, 10), chromeMat);
    hub.rotateX(Math.PI / 2);
    spinGroup.add(hub);

    for (let k = 0; k < 5; k++) {
      const sp = new THREE.Mesh(spokeGeo, rimMat);
      sp.rotation.z = (k / 5) * Math.PI * 2;
      sp.position.z = (i % 2 === 0 ? 0.13 : -0.13);
      spinGroup.add(sp);
    }

    // Ventilated Brake Disc
    const disc = new THREE.Mesh(discGeo, brakeDiscMat);
    disc.position.z = (i % 2 === 0 ? -0.04 : 0.04);
    spinGroup.add(disc);

    steerableGroup.add(spinGroup);

    // Brembo Brake Caliper (fixed to upright)
    const caliper = new THREE.Mesh(caliperGeo, caliperMat);
    caliper.position.set(0.05, 0.11, (i % 2 === 0 ? -0.04 : 0.04));
    steerableGroup.add(caliper);

    steerableGroup.position.set(axleX[i], rTire, axleZ[i]);
    group.add(steerableGroup);

    wheels.push({
      group: steerableGroup,
      spinGroup,
      baseY: rTire,
      steer: i < 2,
    });
  }

  // ==========================================
  // 3. RUNTIME TRANSFORM UPDATE
  // ==========================================
  function update(carState, dt) {
    group.position.copy(carState.pos);
    group.rotation.y = carState.heading;

    // Body pitch (acceleration squat / braking dive) & roll
    body.rotation.x = carState.pitch;
    body.rotation.z = carState.roll;

    // Wheels
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const cw = carState.wheels[i];

      if (w.steer) {
        w.group.rotation.y = carState._steer || 0;
      }
      w.spinGroup.rotation.z = cw.spin;
      w.group.position.y = w.baseY - (cw.suspDefl || 0);
    }

    // Interior steering wheel
    wheelGroup.rotation.x = (carState._steer || 0) * 2.8;

    // Dynamic brake light emissive glow
    const brake = carState.input?.brake || 0;
    tailMat.emissiveIntensity = 0.7 + brake * 2.8;
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
