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

    // Far from track: gentle undulating meadow hills
    const farDist = margin - 40.0;
    const blendFar = Math.min(1.0, farDist / 100.0);
    const meadowHills = Math.sin(x * 0.006) * Math.cos(z * 0.006) * 3.5;
    return (sm.pos.y - 0.25) + meadowHills * blendFar;
  }

  // =========================================================================
  // TEXTURE GENERATION UTILITIES (Crisp CanvasTextures for High-Res Props)
  // =========================================================================
  function createBrakingBoardTexture(distText, chevronsCount) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');

    // Solid white background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, 512, 320);

    // High contrast black border
    ctx.strokeStyle = '#090d16';
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, 498, 306);

    // Racing red top & bottom accent stripes
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(14, 14, 484, 22);
    ctx.fillRect(14, 284, 484, 22);

    // Main Distance Text
    ctx.fillStyle = '#090d16';
    ctx.font = '900 144px "Impact", "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(distText, 256, 145);

    // Subtitle
    ctx.font = 'bold 34px "Arial", sans-serif';
    ctx.fillStyle = '#475569';
    ctx.fillText('METERS', 256, 232);

    // Red directional chevrons on sides
    ctx.fillStyle = '#dc2626';
    for (let c = 0; c < chevronsCount; c++) {
      const yOff = 82 + c * 40;
      // Left chevron
      ctx.beginPath();
      ctx.moveTo(38, yOff);
      ctx.lineTo(58, yOff + 16);
      ctx.lineTo(38, yOff + 32);
      ctx.lineTo(26, yOff + 32);
      ctx.lineTo(46, yOff + 16);
      ctx.lineTo(26, yOff);
      ctx.fill();

      // Right chevron
      ctx.beginPath();
      ctx.moveTo(474, yOff);
      ctx.lineTo(454, yOff + 16);
      ctx.lineTo(474, yOff + 32);
      ctx.lineTo(486, yOff + 32);
      ctx.lineTo(466, yOff + 16);
      ctx.lineTo(486, yOff);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  function createSponsorTexture(brand) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    switch (brand) {
      case 'APEX':
        ctx.fillStyle = '#0a1128';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(0, 0, 512, 12);
        ctx.fillRect(0, 116, 512, 12);
        ctx.fillStyle = '#ff6b00';
        ctx.fillRect(20, 24, 14, 80);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'italic 900 68px "Impact", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('APEX RACING', 48, 64);
        break;

      case 'BREMBO':
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#e50012';
        ctx.fillRect(0, 0, 512, 10);
        ctx.fillRect(0, 118, 512, 10);
        // Brembo logo circle
        ctx.beginPath();
        ctx.arc(64, 64, 28, 0, Math.PI * 2);
        ctx.lineWidth = 10;
        ctx.strokeStyle = '#e50012';
        ctx.stroke();
        ctx.font = 'bold 64px "Arial", sans-serif';
        ctx.fillStyle = '#e50012';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('brembo', 110, 64);
        break;

      case 'MICHELIN':
        ctx.fillStyle = '#003399';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#ffcc00';
        ctx.fillRect(0, 0, 512, 12);
        ctx.fillRect(0, 116, 512, 12);
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'italic 900 64px "Arial Black", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('MICHELIN', 256, 64);
        break;

      case 'MOTEC':
        ctx.fillStyle = '#14171a';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#e5a93b';
        ctx.fillRect(0, 0, 512, 10);
        ctx.fillRect(0, 118, 512, 10);
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(36, 32, 16, 64);
        ctx.fillStyle = '#e5a93b';
        ctx.font = '900 70px "Impact", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('MoTeC', 68, 64);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px "Arial", sans-serif';
        ctx.fillText('DATA SYSTEMS', 280, 64);
        break;

      case 'SPARCO':
        ctx.fillStyle = '#0c2340';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'italic 900 74px "Trebuchet MS", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('sparco', 256, 64);
        ctx.fillStyle = '#00a8e8';
        ctx.fillRect(60, 100, 392, 8);
        break;

      case 'PIRELLI':
        ctx.fillStyle = '#ffd200';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#d50000';
        ctx.font = 'italic 900 76px "Arial Black", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('IRELLI', 270, 64);
        // Top banner bar of P
        ctx.fillRect(70, 24, 380, 12);
        break;

      case 'BILSTEIN':
        ctx.fillStyle = '#0066b2';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#ffdd00';
        ctx.fillRect(0, 0, 512, 12);
        ctx.fillRect(0, 116, 512, 12);
        ctx.fillStyle = '#ffdd00';
        ctx.font = '900 68px "Impact", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('BILSTEIN', 256, 64);
        break;

      case 'MOBIL1':
      default:
        ctx.fillStyle = '#f8f9fa';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#0b2545';
        ctx.font = 'italic 900 70px "Arial Black", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('Mobil', 80, 64);
        ctx.fillStyle = '#d90429';
        ctx.fillText('1', 350, 64);
        break;
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  function createTeamSignTexture(teamName, primaryColor, accentColor) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 512, 128);

    // Team color bar
    ctx.fillStyle = primaryColor;
    ctx.fillRect(0, 0, 512, 14);
    ctx.fillRect(0, 114, 512, 14);
    ctx.fillRect(16, 20, 12, 88);

    ctx.fillStyle = accentColor;
    ctx.fillRect(32, 20, 6, 88);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 54px "Impact", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(teamName, 52, 64);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function createSafetyCarSignTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, 512, 128);

    // Hazard chevrons
    ctx.fillStyle = '#eab308';
    ctx.fillRect(0, 0, 512, 14);
    ctx.fillRect(0, 114, 512, 14);

    ctx.fillStyle = '#facc15';
    ctx.font = '900 58px "Impact", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('OFFICIAL SAFETY CAR', 256, 64);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ==========================================
  // 1. VAST GROUND TERRAIN (Conforming to Track)
  // ==========================================
  const terrainGeo = new THREE.PlaneGeometry(6000, 6000, 100, 100);
  terrainGeo.rotateX(-Math.PI / 2);
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
  // 2. SNOW-CAPPED ALPINE MOUNTAIN RANGE
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

  const rockGeo = new THREE.ConeGeometry(420, 700, 8, 1);
  rockGeo.translate(0, 250, 0);
  const rockMesh = new THREE.InstancedMesh(rockGeo, mtnRockMat, mtnCount);

  const snowGeo = new THREE.ConeGeometry(180, 260, 8, 1);
  snowGeo.translate(0, 470, 0);
  const snowMesh = new THREE.InstancedMesh(snowGeo, mtnSnowMat, mtnCount);

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
    const dist = 22 + Math.pow(Math.random(), 1.5) * 140;
    const lateralJitter = (Math.random() - 0.5) * 14;
    const forwardJitter = (Math.random() - 0.5) * 14;

    const px = sm.pos.x + sm.left.x * dist * side + sm.dir.x * forwardJitter + sm.left.x * lateralJitter;
    const pz = sm.pos.z + sm.left.y * dist * side + sm.dir.y * forwardJitter + sm.left.y * lateralJitter;

    // Do not place trees over pit lane complex (right side of S=20 to S=220)
    const n = track.nearest({ x: px, z: pz });
    if (n.s >= 10 && n.s <= 230 && n.lateral < 0 && n.lateral > -50) {
      continue;
    }

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
  trunkMesh.count = placed;
  foliageMesh1.count = placed;
  foliageMesh2.count = placed;
  foliageMesh3.count = placed;
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
  const trackHeadingAngle = Math.atan2(-startSample.dir.y, startSample.dir.x);

  // Grandstand along Pit Straight (Placed at S=35m, 28m to the left)
  const smGS = track.sampleAt ? track.sampleAt(35) : startSample;
  const grandstandGroup = new THREE.Group();
  const gsMatTier = new THREE.MeshStandardMaterial({ color: 0x3d4349, roughness: 0.75, flatShading: true });
  const gsMatSeat = new THREE.MeshStandardMaterial({ color: 0xc82323, roughness: 0.5 });
  const gsMatRoof = new THREE.MeshStandardMaterial({ color: 0xe8ecf0, roughness: 0.35, metalness: 0.4 });
  const gsMatPillar = new THREE.MeshStandardMaterial({ color: 0x1f2327, roughness: 0.4, metalness: 0.85 });

  const tiersMesh = new THREE.Mesh(new THREE.BoxGeometry(68, 6, 12), gsMatTier);
  tiersMesh.position.set(0, 3, 0);
  tiersMesh.castShadow = true;
  grandstandGroup.add(tiersMesh);

  for (let r = 0; r < 3; r++) {
    const seatRow = new THREE.Mesh(new THREE.BoxGeometry(66, 0.4, 2.8), gsMatSeat);
    seatRow.position.set(0, 4.5 + r * 1.5, -3 + r * 3.2);
    seatRow.castShadow = true;
    grandstandGroup.add(seatRow);
  }

  const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(72, 0.5, 16), gsMatRoof);
  roofMesh.position.set(0, 13, 0);
  roofMesh.rotation.x = -0.06;
  roofMesh.castShadow = true;
  grandstandGroup.add(roofMesh);

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

  // Overhead Start/Finish Steel Truss Gantry (S=22m)
  const smGantry = track.sampleAt ? track.sampleAt(22) : startSample;
  const gantryGroup = new THREE.Group();
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x22272e, roughness: 0.35, metalness: 0.85 });
  const lightHousingMat = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.6 });
  const redLightMat = new THREE.MeshStandardMaterial({ color: 0x440000, emissive: 0xff1e1e, emissiveIntensity: 1.5 });

  const gantryBeam = new THREE.Mesh(new THREE.BoxGeometry(26, 1.2, 1.2), trussMat);
  gantryBeam.position.set(0, 7.8, 0);
  gantryBeam.castShadow = true;
  gantryGroup.add(gantryBeam);

  const leftTower = new THREE.Mesh(new THREE.BoxGeometry(1.0, 8.4, 1.0), trussMat);
  leftTower.position.set(13.0, 4.2, 0);
  leftTower.castShadow = true;
  const rightTower = new THREE.Mesh(new THREE.BoxGeometry(1.0, 8.4, 1.0), trussMat);
  rightTower.position.set(-13.0, 4.2, 0);
  rightTower.castShadow = true;
  gantryGroup.add(leftTower, rightTower);

  for (let k = -2; k <= 2; k++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, 0.5), lightHousingMat);
    box.position.set(k * 1.8, 7.8, -0.6);
    const light = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), redLightMat);
    light.position.set(k * 1.8, 7.8, -0.86);
    light.rotation.y = Math.PI;
    gantryGroup.add(box, light);
  }

  gantryGroup.position.copy(smGantry.pos);
  gantryGroup.rotation.y = trackHeadingAngle - Math.PI / 2;
  group.add(gantryGroup);

  // =========================================================================
  // 6. PIT LANE COMPLEX (Pit Wall, Team Garages, Tires, Safety Car)
  // =========================================================================
  const pitGroup = new THREE.Group();

  // Materials for Pit Complex
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.85, metalness: 0.1 });
  const asphaltPitMat = new THREE.MeshStandardMaterial({ color: 0x1e2229, roughness: 0.88, metalness: 0.12 });
  const metalFrameMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.4, metalness: 0.8 });
  const fencePostMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.35, metalness: 0.85 });
  const garageWallMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.6, metalness: 0.3 });
  const garageRoofMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.4, metalness: 0.5 });
  const shutterMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.5, metalness: 0.6 });
  const tireRubberMat = new THREE.MeshStandardMaterial({ color: 0x171717, roughness: 0.92, metalness: 0.05 });
  const tireStripeSoftMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.4 });
  const tireStripeMedMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4 });
  const toolChestMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.35, metalness: 0.6 });
  const toolChestRedMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.35, metalness: 0.6 });
  const monitorMat = new THREE.MeshStandardMaterial({ color: 0x059669, emissive: 0x10b981, emissiveIntensity: 0.8, roughness: 0.2 });

  // A. Concrete Pit Wall with Catch Fencing (Running along S=30 to S=180, lateral = -11.5m)
  const pitWallLength = 150;
  const wallSteps = 30;
  const pitWallGeo = new THREE.BoxGeometry(pitWallLength / wallSteps, 1.1, 0.6);
  pitWallGeo.translate(0, 0.55, 0);
  const fencePostGeo = new THREE.CylinderGeometry(0.04, 0.04, 2.2, 8);
  fencePostGeo.translate(0, 1.1, 0);

  const pitWallMesh = new THREE.InstancedMesh(pitWallGeo, concreteMat, wallSteps);
  const pitFenceMesh = new THREE.InstancedMesh(fencePostGeo, fencePostMat, wallSteps);
  pitWallMesh.castShadow = pitWallMesh.receiveShadow = true;
  pitFenceMesh.castShadow = true;

  for (let i = 0; i < wallSteps; i++) {
    const s = 30 + (i + 0.5) * (pitWallLength / wallSteps);
    const sm = track.sampleAt(s);
    const px = sm.pos.x - sm.left.x * 11.5;
    const pz = sm.pos.z - sm.left.y * 11.5;
    const py = getGroundHeight(px, pz);
    const heading = Math.atan2(-sm.dir.y, sm.dir.x);

    dummy.position.set(px, py, pz);
    dummy.rotation.set(0, heading, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    pitWallMesh.setMatrixAt(i, dummy.matrix);

    dummy.position.set(px, py + 1.1, pz);
    dummy.updateMatrix();
    pitFenceMesh.setMatrixAt(i, dummy.matrix);
  }
  pitWallMesh.instanceMatrix.needsUpdate = true;
  pitFenceMesh.instanceMatrix.needsUpdate = true;
  pitGroup.add(pitWallMesh, pitFenceMesh);

  // Pit Wall Catch Fencing Rails (horizontal wires)
  for (let w = 0; w < 3; w++) {
    const wireGeo = new THREE.CylinderGeometry(0.015, 0.015, pitWallLength, 4);
    wireGeo.rotateZ(Math.PI / 2);
    const wireMesh = new THREE.Mesh(wireGeo, fencePostMat);
    const smMid = track.sampleAt(105);
    const midX = smMid.pos.x - smMid.left.x * 11.5;
    const midZ = smMid.pos.z - smMid.left.y * 11.5;
    const midY = getGroundHeight(midX, midZ);
    wireMesh.position.set(midX, midY + 1.6 + w * 0.45, midZ);
    wireMesh.rotation.y = trackHeadingAngle;
    pitGroup.add(wireMesh);
  }

  // 4 Pit Wall Telemetry Stations / Perches for Race Engineers
  for (let p = 0; p < 4; p++) {
    const s = 50 + p * 30;
    const sm = track.sampleAt(s);
    const px = sm.pos.x - sm.left.x * 11.8;
    const pz = sm.pos.z - sm.left.y * 11.8;
    const py = getGroundHeight(px, pz);
    const heading = Math.atan2(-sm.dir.y, sm.dir.x);

    const perchGroup = new THREE.Group();
    // Platform
    const platform = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.15, 1.6), metalFrameMat);
    platform.position.set(0, 1.15, -0.6);
    perchGroup.add(platform);

    // Sun Shade Canopy
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.08, 1.8), garageRoofMat);
    canopy.position.set(0, 2.7, -0.6);
    perchGroup.add(canopy);

    // Telemetry Monitors
    for (let m = -1; m <= 1; m++) {
      const monBox = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.06), metalFrameMat);
      monBox.position.set(m * 1.0, 1.9, -0.3);
      const monScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.42), monitorMat);
      monScreen.position.set(m * 1.0, 1.9, -0.26);
      monScreen.rotation.y = Math.PI;
      perchGroup.add(monBox, monScreen);
    }

    perchGroup.position.set(px, py, pz);
    perchGroup.rotation.y = heading;
    pitGroup.add(perchGroup);
  }

  // B. Pit Lane Asphalt Apron Surface Ribbon
  const apronSamples = [];
  for (let s = 25; s <= 190; s += 5) {
    apronSamples.push(track.sampleAt(s));
  }
  const apronGeo = new THREE.PlaneGeometry(165, 14, 30, 2);
  apronGeo.rotateX(-Math.PI / 2);
  const apronMesh = new THREE.Mesh(apronGeo, asphaltPitMat);
  const smApron = track.sampleAt(107.5);
  apronMesh.position.set(
    smApron.pos.x - smApron.left.x * 19.5,
    getGroundHeight(smApron.pos.x - smApron.left.x * 19.5, smApron.pos.z - smApron.left.y * 19.5) + 0.02,
    smApron.pos.z - smApron.left.y * 19.5
  );
  apronMesh.rotation.y = trackHeadingAngle;
  apronMesh.receiveShadow = true;
  pitGroup.add(apronMesh);

  // Pit Lane Painted Markings (Pit Stall Boxes & Speed Limit Stencils)
  const pitStallLineMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4 });
  for (let b = 0; b < 4; b++) {
    const s = 55 + b * 30;
    const sm = track.sampleAt(s);
    const px = sm.pos.x - sm.left.x * 16.0;
    const pz = sm.pos.z - sm.left.y * 16.0;
    const py = getGroundHeight(px, pz) + 0.03;
    const heading = Math.atan2(-sm.dir.y, sm.dir.x);

    // Box perimeter outline
    const stallBox = new THREE.Mesh(new THREE.BoxGeometry(14.0, 0.02, 4.5), pitStallLineMat);
    stallBox.position.set(px, py, pz);
    stallBox.rotation.y = heading;
    pitGroup.add(stallBox);

    // Inner dark pit slot
    const stallInner = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.025, 4.1), asphaltPitMat);
    stallInner.position.set(px, py, pz);
    stallInner.rotation.y = heading;
    pitGroup.add(stallInner);
  }

  // C. 4 Team Pit Boxes / Garages
  const teams = [
    { name: 'APEX RACING MOTORSPORT', color: '#00e5ff', accent: '#ff6b00', colorHex: 0x00e5ff },
    { name: 'SCUDERIA VELOCE CORSE', color: '#ef4444', accent: '#ffffff', colorHex: 0xef4444 },
    { name: 'KRONOS MOTORSPORT GT', color: '#eab308', accent: '#3b82f6', colorHex: 0xeab308 },
    { name: 'VALKYRIE RACING TEAM', color: '#10b981', accent: '#8b5cf6', colorHex: 0x10b981 },
  ];

  // Instanced Tire Stacks (Over 80 slick tires arranged in neat stacks of 3 and 4)
  const tireGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.32, 18);
  const tireStripeGeo = new THREE.CylinderGeometry(0.332, 0.332, 0.07, 18);

  const totalTires = 120;
  const tireMesh = new THREE.InstancedMesh(tireGeo, tireRubberMat, totalTires);
  const tireStripeMesh = new THREE.InstancedMesh(tireStripeGeo, tireStripeSoftMat, totalTires);
  tireMesh.castShadow = tireStripeMesh.castShadow = true;
  let tireIdx = 0;

  for (let i = 0; i < 4; i++) {
    const s = 55 + i * 30;
    const sm = track.sampleAt(s);
    const team = teams[i];
    const heading = Math.atan2(-sm.dir.y, sm.dir.x);

    const garageGroup = new THREE.Group();

    // Main Garage Building Block (22m wide x 6.5m high x 12m deep)
    const garageBody = new THREE.Mesh(new THREE.BoxGeometry(22.0, 6.5, 12.0), garageWallMat);
    garageBody.position.set(0, 3.25, 0);
    garageBody.castShadow = garageBody.receiveShadow = true;
    garageGroup.add(garageBody);

    // Overhanging Roof Fascia
    const roofFascia = new THREE.Mesh(new THREE.BoxGeometry(22.6, 0.6, 13.0), garageRoofMat);
    roofFascia.position.set(0, 6.55, 0.5);
    roofFascia.castShadow = true;
    garageGroup.add(roofFascia);

    // Illuminated Team Sign Lightbox Header
    const signTex = createTeamSignTexture(team.name, team.color, team.accent);
    const signMat = new THREE.MeshStandardMaterial({
      map: signTex,
      emissive: new THREE.Color(team.colorHex),
      emissiveIntensity: 0.6,
      roughness: 0.3,
    });
    const signMesh = new THREE.Mesh(new THREE.BoxGeometry(21.0, 1.4, 0.2), signMat);
    signMesh.position.set(0, 5.4, 6.1);
    garageGroup.add(signMesh);

    // Partially open Roller Shutter Door
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(18.0, 1.8, 0.1), shutterMat);
    shutter.position.set(0, 3.8, 5.95);
    garageGroup.add(shutter);

    // Overhead Cantilever Equipment Boom / Gantry (Extends 6.5m over pit apron)
    const boomTruss = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 7.5), metalFrameMat);
    boomTruss.position.set(0, 6.0, 9.8);
    boomTruss.castShadow = true;
    garageGroup.add(boomTruss);

    // Air Hoses hanging down for pneumatic wheel guns
    for (const hx of [-2.2, 2.2]) {
      const hose = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.6, 6), metalFrameMat);
      hose.position.set(hx, 4.0, 12.5);
      garageGroup.add(hose);
    }

    // Pit Stop Lollipop Sign ("BRAKE" / "GO")
    const lollipopPole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3.8, 8), metalFrameMat);
    lollipopPole.position.set(-6.5, 1.9, 10.0);
    const lollipopDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.06, 16), toolChestRedMat);
    lollipopDisc.rotation.z = Math.PI / 2;
    lollipopDisc.position.set(-6.5, 3.2, 10.0);
    garageGroup.add(lollipopPole, lollipopDisc);

    // Tool Chests (Mechanic Equipment)
    const toolMat = i % 2 === 0 ? toolChestMat : toolChestRedMat;
    for (const tx of [-7.5, 7.5]) {
      const toolChest = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 0.9), toolMat);
      toolChest.position.set(tx, 0.6, 6.8);
      toolChest.castShadow = true;
      garageGroup.add(toolChest);
    }

    // Position Garage Complex
    const gx = sm.pos.x - sm.left.x * 29.5;
    const gz = sm.pos.z - sm.left.y * 29.5;
    const gy = getGroundHeight(gx, gz);
    garageGroup.position.set(gx, gy, gz);
    garageGroup.rotation.y = heading;
    pitGroup.add(garageGroup);

    // Populate Instanced Tire Stacks around this pit box
    for (let stack = 0; stack < 6; stack++) {
      const stackX = (stack % 2 === 0 ? -8.5 : 8.5) + (stack > 1 ? (stack % 3) * 0.9 : 0);
      const stackZ = 7.5 + Math.floor(stack / 2) * 1.4;
      const stackHeight = 3 + (stack % 2);

      // Metal Dolly Platform under each stack
      const dolly = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.06, 0.74), metalFrameMat);
      dolly.position.set(stackX, 0.03, stackZ);
      garageGroup.add(dolly);

      for (let t = 0; t < stackHeight; t++) {
        if (tireIdx >= totalTires) break;

        const worldMat = new THREE.Matrix4();
        worldMat.makeRotationY(heading);
        worldMat.setPosition(gx, gy, gz);
        const tireMatLocal = new THREE.Matrix4().makeTranslation(stackX, 0.22 + t * 0.33, stackZ);
        const finalMat = new THREE.Matrix4().multiplyMatrices(worldMat, tireMatLocal);

        tireMesh.setMatrixAt(tireIdx, finalMat);
        tireStripeMesh.setMatrixAt(tireIdx, finalMat);
        tireIdx++;
      }
    }
  }
  tireMesh.count = tireIdx;
  tireStripeMesh.count = tireIdx;
  tireMesh.instanceMatrix.needsUpdate = true;
  tireStripeMesh.instanceMatrix.needsUpdate = true;
  pitGroup.add(tireMesh, tireStripeMesh);

  // D. Safety Car Parked at Pit Exit (S=175, lateral = -15.5m)
  const scSample = track.sampleAt(175);
  const scHeading = Math.atan2(-scSample.dir.y, scSample.dir.x);
  const scGroup = new THREE.Group();

  const scPaintMat = new THREE.MeshStandardMaterial({ color: 0xebedf0, roughness: 0.15, metalness: 0.9 });
  const scAccentMat = new THREE.MeshStandardMaterial({ color: 0xccff00, roughness: 0.2, metalness: 0.5 });
  const scCarbonMat = new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.45, metalness: 0.6 });
  const scGlassMat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.05, metalness: 0.95, transparent: true, opacity: 0.85 });
  const scLightbarAmber = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xff8800, emissiveIntensity: 2.2, roughness: 0.1 });
  const scLightbarGreen = new THREE.MeshStandardMaterial({ color: 0x00ff66, emissive: 0x00cc44, emissiveIntensity: 2.0, roughness: 0.1 });

  // Body Chassis
  const scBody = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.55, 1.9), scPaintMat);
  scBody.position.set(0, 0.42, 0);
  scBody.castShadow = true;
  scGroup.add(scBody);

  // Fluorescent Safety Livery Accent Stripes
  const scStripeL = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.12, 0.04), scAccentMat);
  scStripeL.position.set(0, 0.45, 0.96);
  const scStripeR = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.12, 0.04), scAccentMat);
  scStripeR.position.set(0, 0.45, -0.96);
  scGroup.add(scStripeL, scStripeR);

  // Carbon Front Splitter & Rear Diffuser
  const scSplitter = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 2.0), scCarbonMat);
  scSplitter.position.set(2.1, 0.15, 0);
  const scDiffuser = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 1.9), scCarbonMat);
  scDiffuser.position.set(-2.0, 0.22, 0);
  scGroup.add(scSplitter, scDiffuser);

  // Cabin & Windshield
  const scCabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.52, 1.5), scGlassMat);
  scCabin.position.set(-0.2, 0.92, 0);
  scCabin.castShadow = true;
  scGroup.add(scCabin);

  // Roof Banner
  const scSignTex = createSafetyCarSignTexture();
  const scSignMat = new THREE.MeshStandardMaterial({ map: scSignTex, roughness: 0.3 });
  const scRoofBanner = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.02, 1.3), scSignMat);
  scRoofBanner.position.set(-0.2, 1.19, 0);
  scGroup.add(scRoofBanner);

  // Aerodynamic Emergency Rooftop Light Bar
  const scLightMount = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 1.1), scCarbonMat);
  scLightMount.position.set(-0.2, 1.23, 0);
  const scStrobeL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.45), scLightbarAmber);
  scStrobeL.position.set(-0.2, 1.31, 0.3);
  const scStrobeR = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.45), scLightbarGreen);
  scStrobeR.position.set(-0.2, 1.31, -0.3);
  scGroup.add(scLightMount, scStrobeL, scStrobeR);

  // Rear GT Wing
  const scWingFoil = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.04, 1.8), scCarbonMat);
  scWingFoil.position.set(-1.9, 1.05, 0);
  const scWingPillarL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.35, 0.04), scCarbonMat);
  scWingPillarL.position.set(-1.85, 0.85, 0.5);
  const scWingPillarR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.35, 0.04), scCarbonMat);
  scWingPillarR.position.set(-1.85, 0.85, -0.5);
  scGroup.add(scWingFoil, scWingPillarL, scWingPillarR);

  // 4 Wheels
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.28, 16);
  wheelGeo.rotateX(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.29, 12);
  rimGeo.rotateX(Math.PI / 2);
  const scRimMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3, metalness: 0.85 });
  for (const [wx, wz] of [[1.35, 0.92], [1.35, -0.92], [-1.35, 0.92], [-1.35, -0.92]]) {
    const tire = new THREE.Mesh(wheelGeo, tireRubberMat);
    tire.position.set(wx, 0.34, wz);
    const rim = new THREE.Mesh(rimGeo, scRimMat);
    rim.position.set(wx, 0.34, wz);
    scGroup.add(tire, rim);
  }

  const scX = scSample.pos.x - scSample.left.x * 15.5;
  const scZ = scSample.pos.z - scSample.left.y * 15.5;
  const scY = getGroundHeight(scX, scZ);
  scGroup.position.set(scX, scY, scZ);
  scGroup.rotation.y = scHeading;
  pitGroup.add(scGroup);

  group.add(pitGroup);

  // =========================================================================
  // 7. ANIMATED WIND TURBINES (6 Majestic Turbines on Distant Alpine Ridges)
  // =========================================================================
  const turbinesGroup = new THREE.Group();
  const turbineMat = new THREE.MeshStandardMaterial({ color: 0xedf2f7, roughness: 0.35, metalness: 0.2 });
  const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff1111, emissiveIntensity: 2.0 });

  // 6 Ridge Coordinates around the track perimeter
  const turbineLocations = [
    { x: trackCenterX + 540, z: trackCenterZ - 720, speed: 1.15, phase: 0.2 },
    { x: trackCenterX + 820, z: trackCenterZ + 140, speed: 0.95, phase: 1.8 },
    { x: trackCenterX + 640, z: trackCenterZ + 800, speed: 1.25, phase: 3.4 },
    { x: trackCenterX - 580, z: trackCenterZ + 720, speed: 1.05, phase: 4.9 },
    { x: trackCenterX - 860, z: trackCenterZ - 160, speed: 1.30, phase: 2.1 },
    { x: trackCenterX - 460, z: trackCenterZ - 760, speed: 1.10, phase: 5.6 },
  ];

  const turbineRotors = [];
  const turbineBeacons = [];

  // Reusable Blade Geometry
  const bladeGeo = new THREE.ConeGeometry(0.8, 22.0, 6);
  bladeGeo.translate(0, 11.0, 0);

  for (let t = 0; t < turbineLocations.length; t++) {
    const loc = turbineLocations[t];
    const tGroup = new THREE.Group();
    const groundY = getGroundHeight(loc.x, loc.z);

    // Tower Mast (52 meters tall tapered cylinder)
    const towerGeo = new THREE.CylinderGeometry(1.2, 2.6, 52, 12);
    towerGeo.translate(0, 26, 0);
    const towerMesh = new THREE.Mesh(towerGeo, turbineMat);
    towerMesh.castShadow = true;
    tGroup.add(towerMesh);

    // Nacelle Pod at tower top
    const nacelleGeo = new THREE.BoxGeometry(3.0, 2.8, 7.5);
    const nacelleMesh = new THREE.Mesh(nacelleGeo, turbineMat);
    nacelleMesh.position.set(0, 52, 1.2);
    nacelleMesh.castShadow = true;
    tGroup.add(nacelleMesh);

    // Red Aviation Hazard Light Beacon on Nacelle
    const beaconGeo = new THREE.SphereGeometry(0.4, 8, 8);
    const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat.clone());
    beaconMesh.position.set(0, 53.6, 1.2);
    tGroup.add(beaconMesh);
    turbineBeacons.push(beaconMesh);

    // Rotor Hub & 3 Aerodynamic Blades
    const rotorGroup = new THREE.Group();
    rotorGroup.position.set(0, 52, 5.0);

    const hubGeo = new THREE.ConeGeometry(1.4, 2.2, 12);
    hubGeo.rotateX(Math.PI / 2);
    const hubMesh = new THREE.Mesh(hubGeo, turbineMat);
    rotorGroup.add(hubMesh);

    // 3 Blades spaced at 120° (0, 2π/3, 4π/3)
    for (let b = 0; b < 3; b++) {
      const bladeMesh = new THREE.Mesh(bladeGeo, turbineMat);
      bladeMesh.rotation.z = (b * Math.PI * 2) / 3;
      bladeMesh.castShadow = true;
      rotorGroup.add(bladeMesh);
    }

    rotorGroup.rotation.z = loc.phase;
    tGroup.add(rotorGroup);
    turbineRotors.push({ group: rotorGroup, speed: loc.speed });

    tGroup.position.set(loc.x, groundY, loc.z);
    tGroup.rotation.y = (t * Math.PI) / 3.0; // Facing predominant wind
    turbinesGroup.add(tGroup);
  }
  group.add(turbinesGroup);

  // =========================================================================
  // 8. 3D DISTANCE BRAKING BOARDS (200m, 150m, 100m, 50m before Braking Zones)
  // =========================================================================
  const brakingGroup = new THREE.Group();
  const boardPostMat = new THREE.MeshStandardMaterial({ color: 0x1f2428, roughness: 0.5, metalness: 0.8 });
  const boardBackMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.6 });

  // Cache textures for 200, 150, 100, 50
  const brakingTexMap = {
    '200': createBrakingBoardTexture('200', 4),
    '150': createBrakingBoardTexture('150', 3),
    '100': createBrakingBoardTexture('100', 2),
    '50': createBrakingBoardTexture('50', 1),
  };

  // 5 Heavy Braking Points along the Alpine Ring circuit
  const brakingTargets = [
    { s: 270, side: -1 }, // Turn 1 (End of Pit Straight)
    { s: 560, side: 1 },  // Turn 4 (Tight Hairpin)
    { s: 920, side: -1 }, // Turn 7 (Esses entry)
    { s: 1520, side: 1 }, // Turn 10 (Back Straight Chicane)
    { s: 2480, side: -1 },// Turn 14 (Final Complex)
  ];

  const boardPanelGeo = new THREE.BoxGeometry(1.6, 1.0, 0.08);
  const boardLegGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.8, 8);

  for (const bTarget of brakingTargets) {
    for (const dist of [200, 150, 100, 50]) {
      const s = (bTarget.s - dist + track.length) % track.length;
      const sm = track.sampleAt(s);
      if (!sm) continue;

      const singleBoardGroup = new THREE.Group();

      const tex = brakingTexMap[String(dist)];
      const frontMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 });
      const panel = new THREE.Mesh(boardPanelGeo, [
        boardBackMat, boardBackMat, boardBackMat, boardBackMat, frontMat, boardBackMat
      ]);
      panel.position.set(0, 1.6, 0);
      panel.castShadow = true;
      singleBoardGroup.add(panel);

      // Twin Steel Support Legs
      for (const lx of [-0.6, 0.6]) {
        const leg = new THREE.Mesh(boardLegGeo, boardPostMat);
        leg.position.set(lx, 0.9, 0);
        leg.castShadow = true;
        singleBoardGroup.add(leg);
      }

      // Position on the outer verge / barrier side
      const lateralDist = (sm.width / 2 + 3.2) * bTarget.side;
      const bx = sm.pos.x + sm.left.x * lateralDist;
      const bz = sm.pos.z + sm.left.y * lateralDist;
      const by = getGroundHeight(bx, bz);

      singleBoardGroup.position.set(bx, by, bz);
      // Align board face perpendicular to oncoming car trajectory
      singleBoardGroup.rotation.y = Math.atan2(-sm.dir.x, -sm.dir.y);
      brakingGroup.add(singleBoardGroup);
    }
  }
  group.add(brakingGroup);

  // =========================================================================
  // 9. TRACKSIDE MARSHAL POSTS (8 Elevated Lookouts with Flag Poles)
  // =========================================================================
  const marshalGroup = new THREE.Group();
  const timberMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.9 });
  const railingMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.4, metalness: 0.7 });
  const yellowFlagMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6, side: THREE.DoubleSide });
  const greenFlagMat = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.6, side: THREE.DoubleSide });
  const fireExtMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.35 });

  // 8 Marshal Sector Posts
  const marshalSectors = [180, 520, 860, 1200, 1540, 1880, 2220, 2560];
  const marshalFlagMeshes = [];

  for (let m = 0; m < marshalSectors.length; m++) {
    const s = marshalSectors[m];
    const sm = track.sampleAt(s);
    const side = (m % 2 === 0 ? 1 : -1);
    const heading = Math.atan2(-sm.dir.y, sm.dir.x);

    const hutGroup = new THREE.Group();

    // 4 Foundation Stilts
    for (const [sx, sz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) {
      const stilt = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.6, 0.18), timberMat);
      stilt.position.set(sx, 0.8, sz);
      stilt.castShadow = true;
      hutGroup.add(stilt);
    }

    // Platform Deck (2.4m x 2.4m)
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.16, 2.4), timberMat);
    deck.position.set(0, 1.6, 0);
    deck.castShadow = true;
    hutGroup.add(deck);

    // Safety Guardrails
    const railFront = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.08), railingMat);
    railFront.position.set(0, 2.1, 1.15);
    const railLeft = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 2.4), railingMat);
    railLeft.position.set(-1.15, 2.1, 0);
    const railRight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 2.4), railingMat);
    railRight.position.set(1.15, 2.1, 0);
    hutGroup.add(railFront, railLeft, railRight);

    // Shelter Roof Canopy
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 2.6), garageRoofMat);
    roof.position.set(0, 3.8, 0);
    roof.rotation.x = -0.08;
    roof.castShadow = true;
    hutGroup.add(roof);

    // Roof Support Pillars
    for (const [px, pz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6), timberMat);
      pillar.position.set(px, 2.7, pz);
      hutGroup.add(pillar);
    }

    // Flag Mast & Flags (Yellow & Green)
    const flagMast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.4, 6), railingMat);
    flagMast.position.set(1.1, 3.3, 1.1);
    hutGroup.add(flagMast);

    const flagYellow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), yellowFlagMat);
    flagYellow.position.set(1.55, 4.4, 1.1);
    flagYellow.rotation.y = Math.PI / 4;
    hutGroup.add(flagYellow);

    const flagGreen = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), greenFlagMat);
    flagGreen.position.set(1.55, 3.7, 1.1);
    flagGreen.rotation.y = Math.PI / 4;
    hutGroup.add(flagGreen);

    marshalFlagMeshes.push({ yellow: flagYellow, green: flagGreen, phase: m * 0.8 });

    // Fire Extinguisher Safety Canister
    const ext = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.65, 8), fireExtMat);
    ext.position.set(-0.9, 2.0, 0.9);
    hutGroup.add(ext);

    // Position outside track barriers
    const lateralDist = (sm.width / 2 + 7.5) * side;
    const mx = sm.pos.x + sm.left.x * lateralDist;
    const mz = sm.pos.z + sm.left.y * lateralDist;
    const my = getGroundHeight(mx, mz);

    hutGroup.position.set(mx, my, mz);
    hutGroup.rotation.y = heading + (side < 0 ? Math.PI : 0);
    marshalGroup.add(hutGroup);
  }
  group.add(marshalGroup);

  // =========================================================================
  // 10. MOTORSPORT SPONSOR HOARDINGS (Mounted on Armco Barriers)
  // =========================================================================
  const sponsorBrands = ['APEX', 'BREMBO', 'MICHELIN', 'MOTEC', 'SPARCO', 'PIRELLI', 'BILSTEIN', 'MOBIL1'];
  const sponsorTexList = sponsorBrands.map((b) => createSponsorTexture(b));
  const hoardingGroup = new THREE.Group();

  const hoardingGeo = new THREE.BoxGeometry(4.6, 0.85, 0.08);

  // Distribute 80 sponsor hoarding boards along straights and corner entries
  const hoardingCount = 80;
  const hoardingsPerBrand = Math.floor(hoardingCount / sponsorBrands.length);

  for (let b = 0; b < sponsorBrands.length; b++) {
    const brandMat = new THREE.MeshStandardMaterial({
      map: sponsorTexList[b],
      roughness: 0.4,
      metalness: 0.2,
    });
    const instMesh = new THREE.InstancedMesh(hoardingGeo, brandMat, hoardingsPerBrand);
    instMesh.castShadow = true;

    for (let k = 0; k < hoardingsPerBrand; k++) {
      const idx = b * hoardingsPerBrand + k;
      // Spread across circuit length
      const s = (idx * 31.5 + 40) % track.length;
      const sm = track.sampleAt(s);
      const side = (idx % 2 === 0 ? 1 : -1);

      // Attach directly on Armco barrier line (approx 24m offset)
      const lat = (track.wallOffset || 24) * side;
      const px = sm.pos.x + sm.left.x * lat;
      const pz = sm.pos.z + sm.left.y * lat;
      const py = getGroundHeight(px, pz) + 0.65;
      const heading = Math.atan2(-sm.dir.y, sm.dir.x);

      dummy.position.set(px, py, pz);
      // Face towards track center
      dummy.rotation.set(0, heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      instMesh.setMatrixAt(k, dummy.matrix);
    }
    instMesh.instanceMatrix.needsUpdate = true;
    hoardingGroup.add(instMesh);
  }
  group.add(hoardingGroup);

  // =========================================================================
  // 11. DYNAMIC UPDATE & AUTOMATIC ANIMATION HOOK
  // =========================================================================
  let totalTime = 0;
  let lastTime = performance.now();

  function update(dt) {
    if (typeof dt !== 'number' || isNaN(dt)) {
      const now = performance.now();
      dt = (now - lastTime) / 1000;
      lastTime = now;
    }
    totalTime += dt;

    // Rotate Wind Turbine 3-Blade Rotors smoothly
    for (let i = 0; i < turbineRotors.length; i++) {
      const tr = turbineRotors[i];
      tr.group.rotation.z += tr.speed * dt;
    }

    // Pulse Aviation Beacon Hazard Lights
    const beaconPulse = 0.5 + 0.5 * Math.sin(totalTime * 3.5);
    for (let i = 0; i < turbineBeacons.length; i++) {
      turbineBeacons[i].material.emissiveIntensity = 1.0 + beaconPulse * 2.0;
    }

    // Safety Car Emergency Strobe Lights
    if (scStrobeL && scStrobeR) {
      const strobePhase = Math.sin(totalTime * 10.0);
      scStrobeL.material.emissiveIntensity = strobePhase > 0 ? 3.0 : 0.3;
      scStrobeR.material.emissiveIntensity = strobePhase <= 0 ? 3.0 : 0.3;
    }

    // Gentle Flutter for Marshal Flags
    for (let f = 0; f < marshalFlagMeshes.length; f++) {
      const fm = marshalFlagMeshes[f];
      const flutter = Math.sin(totalTime * 3.5 + fm.phase) * 0.12;
      fm.yellow.rotation.y = Math.PI / 4 + flutter;
      fm.green.rotation.y = Math.PI / 4 + flutter;
    }
  }

  function dispose() {
    turbinesGroup.onBeforeRender = null;
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        } else {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      }
    });
    scene.remove(group);
  }

  return { group, update, dispose };
}

