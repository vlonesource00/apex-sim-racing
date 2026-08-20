import * as THREE from 'three';

export function buildEnvironment(track, scene) {
  const group = new THREE.Group();
  scene.add(group);

  const dummy = new THREE.Object3D();

  // Compute track bounding box and center
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const sm of track.samples) {
    minX = Math.min(minX, sm.pos.x);
    maxX = Math.max(maxX, sm.pos.x);
    minZ = Math.min(minZ, sm.pos.z);
    maxZ = Math.max(maxZ, sm.pos.z);
  }
  const trackCenterX = (minX + maxX) / 2;
  const trackCenterZ = (minZ + maxZ) / 2;

  // Ground elevation function that conforms strictly to track elevation
  function getGroundHeight(x, z) {
    const n = track.nearest({ x, z });
    const sm = track.samples[n.idx];
    const distToCenterline = n.dist;
    const roadVergeWidth = (sm.width || 13) / 2 + 5.0; // road + curb + verge

    // Under road and verge ribbon: stay safely below track geometry
    if (distToCenterline <= roadVergeWidth) {
      return sm.pos.y - 0.08;
    }

    const margin = distToCenterline - roadVergeWidth;
    const roadY = sm.pos.y - 0.08;

    if (margin < 40.0) {
      // Smooth Hermite blend from road elevation to surrounding meadow
      const t = margin / 40.0;
      const smoothT = t * t * (3 - 2 * t);
      const naturalMeadow = roadY - 0.2;
      return roadY * (1 - smoothT) + naturalMeadow * smoothT;
    }

    // Far from track: gentle undulating meadow hills (never exceeding +4m)
    const farDist = margin - 40.0;
    const blendFar = Math.min(1.0, farDist / 100.0);
    const meadowHills = Math.sin(x * 0.006) * Math.cos(z * 0.006) * 3.5;
    return (sm.pos.y - 0.25) + meadowHills * blendFar;
  }

  // ==========================================
  // 1. VAST GROUND TERRAIN (Conforming to Track)
  // ==========================================
  const terrainGeo = new THREE.PlaneGeometry(6000, 6000, 100, 100);
  terrainGeo.rotateX(-Math.PI / 2);
  
  // Center terrain mesh on track center
  terrainGeo.translate(trackCenterX, 0, trackCenterZ);

  const posAttr = terrainGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    posAttr.setY(i, getGroundHeight(x, z));
  }
  terrainGeo.computeVertexNormals();

  const terrainMat = new THREE.MeshStandardMaterial({
    color: 0x325626,
    roughness: 0.95,
    metalness: 0.05,
    flatShading: true,
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  group.add(terrain);

  // ==========================================
  // 2. SNOW-CAPPED ALPINE MOUNTAIN RANGE (Far Horizon Ring)
  // ==========================================
  const mtnGroup = new THREE.Group();
  const mtnCount = 36;
  const mtnRockMat = new THREE.MeshStandardMaterial({
    color: 0x47515a,
    roughness: 0.9,
    metalness: 0.1,
    flatShading: true,
  });
  const mtnSnowMat = new THREE.MeshStandardMaterial({
    color: 0xf0f5f9,
    roughness: 0.65,
    metalness: 0.05,
    flatShading: true,
  });

  // Base Rock Cone (radius 420m, height 700m, deeply anchored into ground)
  const rockGeo = new THREE.ConeGeometry(420, 700, 8, 1);
  rockGeo.translate(0, 250, 0);
  const rockMesh = new THREE.InstancedMesh(rockGeo, mtnRockMat, mtnCount);

  // Snow Cap Peak
  const snowGeo = new THREE.ConeGeometry(180, 260, 8, 1);
  snowGeo.translate(0, 470, 0);
  const snowMesh = new THREE.InstancedMesh(snowGeo, mtnSnowMat, mtnCount);

  // Place mountains in a wide ring 1650m - 1950m away from track center
  for (let i = 0; i < mtnCount; i++) {
    const angle = (i / mtnCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
    const r = 1750 + (i % 4) * 120 + Math.random() * 100;
    const px = trackCenterX + Math.cos(angle) * r;
    const pz = trackCenterZ + Math.sin(angle) * r;
    const scaleY = 0.9 + Math.random() * 0.8;
    const scaleXZ = 0.9 + Math.random() * 0.5;

    dummy.position.set(px, -120, pz);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.set(scaleXZ, scaleY, scaleXZ);
    dummy.updateMatrix();

    rockMesh.setMatrixAt(i, dummy.matrix);
    snowMesh.setMatrixAt(i, dummy.matrix);
  }
  rockMesh.instanceMatrix.needsUpdate = true;
  snowMesh.instanceMatrix.needsUpdate = true;
  mtnGroup.add(rockMesh, snowMesh);
  group.add(mtnGroup);

  // ==========================================
  // 3. REALISTIC 3D PINE TREES (Naturally Dispersed)
  // ==========================================
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.35, 2.8, 6);
  trunkGeo.translate(0, 1.4, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x362312, roughness: 0.95 });

  const crownGeo1 = new THREE.ConeGeometry(2.2, 3.6, 6);
  crownGeo1.translate(0, 3.5, 0);
  const crownGeo2 = new THREE.ConeGeometry(1.6, 3.0, 6);
  crownGeo2.translate(0, 5.1, 0);
  const crownGeo3 = new THREE.ConeGeometry(1.1, 2.4, 6);
  crownGeo3.translate(0, 6.5, 0);

  const foliageMat1 = new THREE.MeshStandardMaterial({ color: 0x1c3616, roughness: 0.85, flatShading: true });
  const foliageMat2 = new THREE.MeshStandardMaterial({ color: 0x24441b, roughness: 0.85, flatShading: true });
  const foliageMat3 = new THREE.MeshStandardMaterial({ color: 0x2e5423, roughness: 0.85, flatShading: true });

  const treeCount = 800;
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const foliageMesh1 = new THREE.InstancedMesh(crownGeo1, foliageMat1, treeCount);
  const foliageMesh2 = new THREE.InstancedMesh(crownGeo2, foliageMat2, treeCount);
  const foliageMesh3 = new THREE.InstancedMesh(crownGeo3, foliageMat3, treeCount);

  trunkMesh.castShadow = true;
  foliageMesh1.castShadow = foliageMesh2.castShadow = foliageMesh3.castShadow = true;
  foliageMesh1.receiveShadow = foliageMesh2.receiveShadow = foliageMesh3.receiveShadow = true;

  let placed = 0;
  for (let i = 0; i < treeCount; i++) {
    const sm = track.samples[Math.floor(Math.random() * track.samples.length)];
    const side = Math.random() > 0.5 ? 1 : -1;
    // Distance safely 20m - 160m outside track centerline
    const dist = 20 + Math.pow(Math.random(), 1.5) * 140;
    const lateralJitter = (Math.random() - 0.5) * 14;
    const forwardJitter = (Math.random() - 0.5) * 14;

    const px = sm.pos.x + sm.left.x * dist * side + sm.dir.x * forwardJitter + sm.left.x * lateralJitter;
    const pz = sm.pos.z + sm.left.y * dist * side + sm.dir.y * forwardJitter + sm.left.y * lateralJitter;
    const py = getGroundHeight(px, pz);

    const scale = 0.7 + Math.random() * 0.6;
    dummy.position.set(px, py, pz);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.set(scale, scale * (0.9 + Math.random() * 0.3), scale);
    dummy.updateMatrix();

    trunkMesh.setMatrixAt(placed, dummy.matrix);
    foliageMesh1.setMatrixAt(placed, dummy.matrix);
    foliageMesh2.setMatrixAt(placed, dummy.matrix);
    foliageMesh3.setMatrixAt(placed, dummy.matrix);
    placed++;
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  foliageMesh1.instanceMatrix.needsUpdate = true;
  foliageMesh2.instanceMatrix.needsUpdate = true;
  foliageMesh3.instanceMatrix.needsUpdate = true;

  group.add(trunkMesh, foliageMesh1, foliageMesh2, foliageMesh3);

  // ==========================================
  // 4. ARMCO CRASH BARRIERS & POSTS
  // ==========================================
  if (track.walls && track.walls.length > 0) {
    const railGeo = new THREE.BoxGeometry(0.2, 0.55, 1.0);
    const railMat = new THREE.MeshStandardMaterial({
      color: 0x9ea7ad,
      roughness: 0.35,
      metalness: 0.85,
    });
    const postGeo = new THREE.BoxGeometry(0.16, 1.1, 0.16);
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x333333,
      roughness: 0.6,
      metalness: 0.5,
    });

    const numWalls = track.walls.length;
    const railMesh = new THREE.InstancedMesh(railGeo, railMat, numWalls);
    const postMesh = new THREE.InstancedMesh(postGeo, postMat, numWalls);
    railMesh.castShadow = postMesh.castShadow = true;
    railMesh.receiveShadow = postMesh.receiveShadow = true;

    for (let i = 0; i < numWalls; i++) {
      const w = track.walls[i];
      const midX = (w.a.x + w.b.x) / 2;
      const midZ = (w.a.z + w.b.z) / 2;
      const midY = (w.a.y + w.b.y) / 2;
      const segLen = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z);
      const angle = Math.atan2(w.b.x - w.a.x, w.b.z - w.a.z);

      // Rail
      dummy.position.set(midX, midY + 0.65, midZ);
      dummy.rotation.set(0, angle, 0);
      dummy.scale.set(1, 1, segLen);
      dummy.updateMatrix();
      railMesh.setMatrixAt(i, dummy.matrix);

      // Post
      dummy.position.set(w.a.x, w.a.y + 0.5, w.a.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      postMesh.setMatrixAt(i, dummy.matrix);
    }
    railMesh.instanceMatrix.needsUpdate = true;
    postMesh.instanceMatrix.needsUpdate = true;
    group.add(railMesh, postMesh);
  }

  // ==========================================
  // 5. START / FINISH GRANDSTAND & OVERHEAD GANTRY
  // ==========================================
  const startSample = track.samples[0] || { pos: new THREE.Vector3(), dir: new THREE.Vector2(1, 0), left: new THREE.Vector2(0, 1) };
  // Track heading angle in X/Z world plane
  const trackHeadingAngle = Math.atan2(-startSample.dir.y, startSample.dir.x);

  // Grandstand along Pit Straight (Placed at S=35m, 28m to the left)
  const smGS = track.sampleAt ? track.sampleAt(35) : startSample;
  const grandstandGroup = new THREE.Group();
  const gsMatTier = new THREE.MeshStandardMaterial({ color: 0x3d4349, roughness: 0.75, flatShading: true });
  const gsMatSeat = new THREE.MeshStandardMaterial({ color: 0xc82323, roughness: 0.5 });
  const gsMatRoof = new THREE.MeshStandardMaterial({ color: 0xe8ecf0, roughness: 0.35, metalness: 0.4 });
  const gsMatPillar = new THREE.MeshStandardMaterial({ color: 0x1f2327, roughness: 0.4, metalness: 0.85 });

  // Tiered seating stadium block
  const tiersMesh = new THREE.Mesh(new THREE.BoxGeometry(68, 6, 12), gsMatTier);
  tiersMesh.position.set(0, 3, 0);
  tiersMesh.castShadow = true;
  grandstandGroup.add(tiersMesh);

  // 3 Rows of Seating
  for (let r = 0; r < 3; r++) {
    const seatRow = new THREE.Mesh(new THREE.BoxGeometry(66, 0.4, 2.8), gsMatSeat);
    seatRow.position.set(0, 4.5 + r * 1.5, -3 + r * 3.2);
    seatRow.castShadow = true;
    grandstandGroup.add(seatRow);
  }

  // Aerodynamic Roof Canopy
  const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(72, 0.5, 16), gsMatRoof);
  roofMesh.position.set(0, 13, 0);
  roofMesh.rotation.x = -0.06;
  roofMesh.castShadow = true;
  grandstandGroup.add(roofMesh);

  // Support Pillars
  for (const px of [-30, -10, 10, 30]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 13, 8), gsMatPillar);
    pillar.position.set(px, 6.5, 6);
    pillar.castShadow = true;
    grandstandGroup.add(pillar);
  }

  grandstandGroup.position.set(
    smGS.pos.x + smGS.left.x * 28,
    smGS.pos.y,
    smGS.pos.z + smGS.left.y * 28
  );
  grandstandGroup.rotation.y = trackHeadingAngle;
  group.add(grandstandGroup);

  // Overhead Start/Finish Steel Truss Gantry (Placed at S=22m down the straight)
  const smGantry = track.sampleAt ? track.sampleAt(22) : startSample;
  const gantryGroup = new THREE.Group();
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x22272e, roughness: 0.35, metalness: 0.85 });
  const lightHousingMat = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.6 });
  const redLightMat = new THREE.MeshStandardMaterial({ color: 0x440000, emissive: 0xff1e1e, emissiveIntensity: 1.5 });

  // Crossbeam spanning 26 meters across the track (X axis in local group)
  const gantryBeam = new THREE.Mesh(new THREE.BoxGeometry(26, 1.2, 1.2), trussMat);
  gantryBeam.position.set(0, 7.8, 0);
  gantryBeam.castShadow = true;
  gantryGroup.add(gantryBeam);

  // Left & Right Support Towers (13 meters away from road center)
  const leftTower = new THREE.Mesh(new THREE.BoxGeometry(1.0, 8.4, 1.0), trussMat);
  leftTower.position.set(13.0, 4.2, 0);
  leftTower.castShadow = true;
  const rightTower = new THREE.Mesh(new THREE.BoxGeometry(1.0, 8.4, 1.0), trussMat);
  rightTower.position.set(-13.0, 4.2, 0);
  rightTower.castShadow = true;
  gantryGroup.add(leftTower, rightTower);

  // 5 Formula 1 Starting Light Boxes (Facing back toward starting grid at local -Z)
  for (let k = -2; k <= 2; k++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, 0.5), lightHousingMat);
    box.position.set(k * 1.8, 7.8, -0.6);
    const light = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), redLightMat);
    light.position.set(k * 1.8, 7.8, -0.86);
    light.rotation.y = Math.PI;
    gantryGroup.add(box, light);
  }

  gantryGroup.position.copy(smGantry.pos);
  // Align local X with track left vector (perpendicular to road direction)
  gantryGroup.rotation.y = trackHeadingAngle - Math.PI / 2;
  group.add(gantryGroup);

  // ==========================================
  // 6. DISTANCE BRAKING BOARDS (150m, 100m, 50m)
  // ==========================================
  const boardMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.4 });
  const boardPostMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 });

  // Place boards before notable braking points (e.g. S=200, S=450, S=600)
  for (const sTarget of [220, 520, 850, 1400]) {
    for (const [distOffset, labelColor] of [[150, 0x111111], [100, 0x111111], [50, 0x111111]]) {
      const s = (sTarget - distOffset + track.length) % track.length;
      const sm = track.sampleAt ? track.sampleAt(s) : null;
      if (!sm) continue;

      const boardGroup = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 0.08), boardMat);
      panel.position.set(0, 1.4, 0);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 8), boardPostMat);
      post.position.set(0, 0.7, 0);
      boardGroup.add(panel, post);

      // Position to the right side of the track outside curb
      const rightX = sm.pos.x - sm.left.x * (sm.width / 2 + 2.5);
      const rightZ = sm.pos.z - sm.left.y * (sm.width / 2 + 2.5);
      boardGroup.position.set(rightX, sm.pos.y, rightZ);
      boardGroup.rotation.y = Math.atan2(sm.dir.x, sm.dir.y);
      group.add(boardGroup);
    }
  }

  return { group };
}

