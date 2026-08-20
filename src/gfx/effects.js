// P10 owns this file. Contract: see ARCHITECTURE.md.
// createEffects(scene) -> { update(cars, dt), dispose() }
// Tire smoke, persistent skidmarks, collision impact sparks.

import * as THREE from 'three';

// Pool capacities
const MAX_SPARKS = 800;
const MAX_SMOKE = 1200;
const MAX_SKID_QUADS = 300;

export function createEffects(scene) {
  // ---------------------------------------------------------------------------
  // 1. COLLISION IMPACT SPARKS PARTICLE SYSTEM
  // ---------------------------------------------------------------------------
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPositions = new Float32Array(MAX_SPARKS * 3);
  const sparkColors = new Float32Array(MAX_SPARKS * 3);
  const sparkSizes = new Float32Array(MAX_SPARKS);
  const sparkAlphas = new Float32Array(MAX_SPARKS);

  // Initialize offscreen
  for (let i = 0; i < MAX_SPARKS; i++) {
    sparkPositions[i * 3 + 1] = -9999;
    sparkAlphas[i] = 0;
    sparkSizes[i] = 0;
  }

  const sparkPosAttr = new THREE.BufferAttribute(sparkPositions, 3);
  const sparkColorAttr = new THREE.BufferAttribute(sparkColors, 3);
  const sparkSizeAttr = new THREE.BufferAttribute(sparkSizes, 1);
  const sparkAlphaAttr = new THREE.BufferAttribute(sparkAlphas, 1);

  sparkPosAttr.setUsage(THREE.DynamicDrawUsage);
  sparkColorAttr.setUsage(THREE.DynamicDrawUsage);
  sparkSizeAttr.setUsage(THREE.DynamicDrawUsage);
  sparkAlphaAttr.setUsage(THREE.DynamicDrawUsage);

  sparkGeo.setAttribute('position', sparkPosAttr);
  sparkGeo.setAttribute('color', sparkColorAttr);
  sparkGeo.setAttribute('size', sparkSizeAttr);
  sparkGeo.setAttribute('alpha', sparkAlphaAttr);

  const sparkMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 color;
      attribute float size;
      attribute float alpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vAlpha = alpha;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * (260.0 / -mvPos.z), 1.0, 128.0);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.002) discard;
        vec2 coord = gl_PointCoord - vec2(0.5);
        float d2 = dot(coord, coord);
        if (d2 > 0.25) discard;
        float core = exp(-d2 * 28.0);
        float halo = exp(-d2 * 7.0) * 0.45;
        float intensity = (core + halo) * vAlpha;
        gl_FragColor = vec4(vColor * 1.5, intensity);
      }
    `,
  });

  const sparkMesh = new THREE.Points(sparkGeo, sparkMat);
  sparkMesh.frustumCulled = false;
  scene.add(sparkMesh);

  // Spark CPU simulation pool
  const sparkVelX = new Float32Array(MAX_SPARKS);
  const sparkVelY = new Float32Array(MAX_SPARKS);
  const sparkVelZ = new Float32Array(MAX_SPARKS);
  const sparkLife = new Float32Array(MAX_SPARKS);
  const sparkMaxLife = new Float32Array(MAX_SPARKS);
  const sparkActive = new Uint8Array(MAX_SPARKS);
  let nextSparkIdx = 0;

  function spawnSpark(x, y, z, vx, vy, vz, r, g, b, size, lifeTime) {
    const idx = nextSparkIdx;
    nextSparkIdx = (nextSparkIdx + 1) % MAX_SPARKS;

    sparkPositions[idx * 3] = x;
    sparkPositions[idx * 3 + 1] = y;
    sparkPositions[idx * 3 + 2] = z;

    sparkColors[idx * 3] = r;
    sparkColors[idx * 3 + 1] = g;
    sparkColors[idx * 3 + 2] = b;

    sparkSizes[idx] = size;
    sparkAlphas[idx] = 1.0;

    sparkVelX[idx] = vx;
    sparkVelY[idx] = vy;
    sparkVelZ[idx] = vz;
    sparkLife[idx] = lifeTime;
    sparkMaxLife[idx] = lifeTime;
    sparkActive[idx] = 1;
  }

  function emitSparksBurst(origin, normal, count, speedMin, speedMax, baseVel) {
    const bx = baseVel ? baseVel.x * 0.35 : 0;
    const bz = baseVel ? baseVel.z * 0.35 : 0;

    for (let k = 0; k < count; k++) {
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      // Random hemisphere spray around normal
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.8 + 0.2); // bias forward

      // Tangent frame
      let up = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const tangentX = normal.z * up.y - normal.y * up.z;
      const tangentY = normal.x * up.z - normal.z * up.x;
      const tangentZ = normal.y * up.x - normal.x * up.y;
      const tLen = Math.hypot(tangentX, tangentY, tangentZ) || 1;
      const tx = tangentX / tLen, ty = tangentY / tLen, tz = tangentZ / tLen;

      const bx_ = ty * normal.z - tz * normal.y;
      const by_ = tz * normal.x - tx * normal.z;
      const bz_ = tx * normal.y - ty * normal.x;

      const sinPhi = Math.sin(phi);
      const dirX = normal.x * Math.cos(phi) + (tx * Math.cos(theta) + bx_ * Math.sin(theta)) * sinPhi;
      const dirY = normal.y * Math.cos(phi) + (ty * Math.cos(theta) + by_ * Math.sin(theta)) * sinPhi;
      const dirZ = normal.z * Math.cos(phi) + (tz * Math.cos(theta) + bz_ * Math.sin(theta)) * sinPhi;

      const vx = dirX * speed + bx;
      const vy = Math.max(1.5, dirY * speed + 2.0 + Math.random() * 3.5);
      const vz = dirZ * speed + bz;

      // Glowing spark color palette
      const colRand = Math.random();
      let r, g, b;
      if (colRand < 0.35) {
        // White-hot gold
        r = 1.0; g = 0.94; b = 0.65;
      } else if (colRand < 0.75) {
        // Bright golden amber
        r = 1.0; g = 0.68; b = 0.15;
      } else {
        // Fiery red-orange
        r = 1.0; g = 0.32; b = 0.05;
      }

      const size = 0.30 + Math.random() * 0.35;
      const life = 0.25 + Math.random() * 0.20; // 0.25 - 0.45s

      spawnSpark(
        origin.x + (Math.random() - 0.5) * 0.15,
        origin.y + (Math.random() - 0.5) * 0.10,
        origin.z + (Math.random() - 0.5) * 0.15,
        vx, vy, vz,
        r, g, b,
        size, life
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 2. TIRE SMOKE PUFFS PARTICLE SYSTEM
  // ---------------------------------------------------------------------------
  const smokeGeo = new THREE.BufferGeometry();
  const smokePositions = new Float32Array(MAX_SMOKE * 3);
  const smokeColors = new Float32Array(MAX_SMOKE * 3);
  const smokeSizes = new Float32Array(MAX_SMOKE);
  const smokeAlphas = new Float32Array(MAX_SMOKE);

  // Initialize offscreen
  for (let i = 0; i < MAX_SMOKE; i++) {
    smokePositions[i * 3 + 1] = -9999;
    smokeAlphas[i] = 0;
    smokeSizes[i] = 0;
  }

  const smokePosAttr = new THREE.BufferAttribute(smokePositions, 3);
  const smokeColorAttr = new THREE.BufferAttribute(smokeColors, 3);
  const smokeSizeAttr = new THREE.BufferAttribute(smokeSizes, 1);
  const smokeAlphaAttr = new THREE.BufferAttribute(smokeAlphas, 1);

  smokePosAttr.setUsage(THREE.DynamicDrawUsage);
  smokeColorAttr.setUsage(THREE.DynamicDrawUsage);
  smokeSizeAttr.setUsage(THREE.DynamicDrawUsage);
  smokeAlphaAttr.setUsage(THREE.DynamicDrawUsage);

  smokeGeo.setAttribute('position', smokePosAttr);
  smokeGeo.setAttribute('color', smokeColorAttr);
  smokeGeo.setAttribute('size', smokeSizeAttr);
  smokeGeo.setAttribute('alpha', smokeAlphaAttr);

  const smokeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    vertexShader: `
      attribute vec3 color;
      attribute float size;
      attribute float alpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vAlpha = alpha;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * (340.0 / -mvPos.z), 1.0, 256.0);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.002) discard;
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        if (dist > 0.5) discard;
        float soft = smoothstep(0.5, 0.02, dist);
        float puff = pow(soft, 1.35);
        gl_FragColor = vec4(vColor, vAlpha * puff * 0.70);
      }
    `,
  });

  const smokeMesh = new THREE.Points(smokeGeo, smokeMat);
  smokeMesh.frustumCulled = false;
  scene.add(smokeMesh);

  // Smoke CPU simulation pool
  const smokeVelX = new Float32Array(MAX_SMOKE);
  const smokeVelY = new Float32Array(MAX_SMOKE);
  const smokeVelZ = new Float32Array(MAX_SMOKE);
  const smokeLife = new Float32Array(MAX_SMOKE);
  const smokeMaxLife = new Float32Array(MAX_SMOKE);
  const smokeStartSize = new Float32Array(MAX_SMOKE);
  const smokeEndSize = new Float32Array(MAX_SMOKE);
  const smokeMaxAlpha = new Float32Array(MAX_SMOKE);
  const smokeActive = new Uint8Array(MAX_SMOKE);
  let nextSmokeIdx = 0;

  function spawnSmokePuff(x, y, z, vx, vy, vz, r, g, b, startSize, endSize, maxAlpha, lifeTime) {
    const idx = nextSmokeIdx;
    nextSmokeIdx = (nextSmokeIdx + 1) % MAX_SMOKE;

    smokePositions[idx * 3] = x;
    smokePositions[idx * 3 + 1] = y;
    smokePositions[idx * 3 + 2] = z;

    smokeColors[idx * 3] = r;
    smokeColors[idx * 3 + 1] = g;
    smokeColors[idx * 3 + 2] = b;

    smokeSizes[idx] = startSize;
    smokeAlphas[idx] = 0.0;

    smokeVelX[idx] = vx;
    smokeVelY[idx] = vy;
    smokeVelZ[idx] = vz;
    smokeLife[idx] = lifeTime;
    smokeMaxLife[idx] = lifeTime;
    smokeStartSize[idx] = startSize;
    smokeEndSize[idx] = endSize;
    smokeMaxAlpha[idx] = maxAlpha;
    smokeActive[idx] = 1;
  }

  // ---------------------------------------------------------------------------
  // 3. PERSISTENT SKIDMARKS SYSTEM (dynamic mesh ribbon)
  // ---------------------------------------------------------------------------
  const MAX_SKID_VERTS = MAX_SKID_QUADS * 4;
  const MAX_SKID_INDICES = MAX_SKID_QUADS * 6;

  const skidGeo = new THREE.BufferGeometry();
  const skidPositions = new Float32Array(MAX_SKID_VERTS * 3);
  const skidAlphas = new Float32Array(MAX_SKID_VERTS);
  const skidIndices = new Uint16Array(MAX_SKID_INDICES);

  for (let i = 0; i < MAX_SKID_QUADS; i++) {
    const v = i * 4;
    const idx = i * 6;
    skidIndices[idx] = v;
    skidIndices[idx + 1] = v + 1;
    skidIndices[idx + 2] = v + 2;
    skidIndices[idx + 3] = v + 2;
    skidIndices[idx + 4] = v + 1;
    skidIndices[idx + 5] = v + 3;
  }

  skidGeo.setIndex(new THREE.BufferAttribute(skidIndices, 1));
  const skidPosAttr = new THREE.BufferAttribute(skidPositions, 3);
  const skidAlphaAttr = new THREE.BufferAttribute(skidAlphas, 1);
  skidPosAttr.setUsage(THREE.DynamicDrawUsage);
  skidAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  skidGeo.setAttribute('position', skidPosAttr);
  skidGeo.setAttribute('alpha', skidAlphaAttr);

  const skidMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1.0,
    polygonOffsetUnits: -1.0,
    vertexShader: `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.005) discard;
        gl_FragColor = vec4(0.08, 0.08, 0.09, vAlpha * 0.60);
      }
    `,
  });

  const skidMesh = new THREE.Mesh(skidGeo, skidMat);
  skidMesh.frustumCulled = false;
  scene.add(skidMesh);

  let nextSkidQuad = 0;
  let skidDirty = false;

  function addSkidSegment(p1x, p1z, p2x, p2z, y, width, alpha) {
    const dx = p2x - p1x;
    const dz = p2z - p1z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;

    const nx = -dz / len * (width * 0.5);
    const nz = dx / len * (width * 0.5);

    const q = nextSkidQuad;
    nextSkidQuad = (nextSkidQuad + 1) % MAX_SKID_QUADS;
    const v = q * 4;

    const yLift = y + 0.015;

    // Vertex 0: p1 left
    skidPositions[v * 3] = p1x + nx;
    skidPositions[v * 3 + 1] = yLift;
    skidPositions[v * 3 + 2] = p1z + nz;
    skidAlphas[v] = alpha;

    // Vertex 1: p1 right
    skidPositions[(v + 1) * 3] = p1x - nx;
    skidPositions[(v + 1) * 3 + 1] = yLift;
    skidPositions[(v + 1) * 3 + 2] = p1z - nz;
    skidAlphas[v + 1] = alpha;

    // Vertex 2: p2 left
    skidPositions[(v + 2) * 3] = p2x + nx;
    skidPositions[(v + 2) * 3 + 1] = yLift;
    skidPositions[(v + 2) * 3 + 2] = p2z + nz;
    skidAlphas[v + 2] = alpha;

    // Vertex 3: p2 right
    skidPositions[(v + 3) * 3] = p2x - nx;
    skidPositions[(v + 3) * 3 + 1] = yLift;
    skidPositions[(v + 3) * 3 + 2] = p2z - nz;
    skidAlphas[v + 3] = alpha;

    skidDirty = true;
  }

  // Wheel contact tracking map for skidmark ribbons and smoke timers
  const wheelTrackers = new Map();

  // ---------------------------------------------------------------------------
  // MAIN UPDATE FUNCTION
  // ---------------------------------------------------------------------------
  function update(cars, dt) {
    if (!cars || cars.length === 0) return;
    const stepDt = Math.min(dt, 0.05);

    // 1. PROCESS CARS FOR IMPACT SPARKS & TIRE SMOKE
    for (let cIdx = 0; cIdx < cars.length; cIdx++) {
      const car = cars[cIdx];
      const heading = car.heading || 0;
      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);
      const fwdX = cosH, fwdZ = -sinH;
      const leftX = -sinH, leftZ = -cosH;

      // -----------------------------------------------------------------------
      // A. COLLISION IMPACT SPARKS
      // -----------------------------------------------------------------------
      const lastContact = car._lastContact;
      const contactImpact = lastContact ? (lastContact.impact ?? lastContact.impulse ?? 0) : 0;
      const lastSparkImpact = car._lastSparkImpact || 0;

      if (lastContact && contactImpact > 0.2 && Math.abs(contactImpact - lastSparkImpact) > 0.1) {
        car._lastSparkImpact = contactImpact;
        const origin = lastContact.pos || lastContact.point || car.pos;
        let normal = lastContact.normal;
        if (!normal) {
          normal = new THREE.Vector3(origin.x - car.pos.x, 0.2, origin.z - car.pos.z);
          if (normal.lengthSq() < 1e-4) normal.set(fwdX, 0.2, fwdZ);
          else normal.normalize();
        }

        const sparkCount = Math.floor(Math.min(42, Math.max(16, contactImpact * 6)));
        emitSparksBurst(
          origin,
          normal,
          sparkCount,
          8.0, 22.0,
          car.vel
        );
      } else if (car.wallHit > 0.10 && car.wallHit > (car._prevWallHit || 0) + 0.04) {
        // Wall hit without car-to-car metadata -> compute wall impact position
        const hitMag = car.wallHit;
        const speed = car.speed || 0;
        const normVelX = speed > 0.5 ? car.vel.x / speed : fwdX;
        const normVelZ = speed > 0.5 ? car.vel.z / speed : fwdZ;

        const impactPoint = new THREE.Vector3(
          car.pos.x + normVelX * 1.8,
          car.pos.y + 0.35,
          car.pos.z + normVelZ * 1.8
        );
        const wallNormal = new THREE.Vector3(-normVelX, 0.2, -normVelZ).normalize();

        const sparkCount = Math.floor(Math.min(38, Math.max(14, hitMag * 36)));
        emitSparksBurst(
          impactPoint,
          wallNormal,
          sparkCount,
          7.0, 20.0,
          car.vel
        );
      }
      car._prevWallHit = car.wallHit;

      // -----------------------------------------------------------------------
      // B. TIRE SMOKE PUFFS & SKIDMARKS
      // -----------------------------------------------------------------------
      const s = car.setup || {};
      const aDist = s.wheelbase ? s.weightDist * s.wheelbase : 1.205;
      const bDist = s.wheelbase ? s.wheelbase - aDist : 1.415;
      const halfT = s.trackWidth ? s.trackWidth * 0.5 : 0.84;

      if (!wheelTrackers.has(car.id)) {
        wheelTrackers.set(car.id, [
          { lastX: 0, lastZ: 0, active: false, timer: 0 },
          { lastX: 0, lastZ: 0, active: false, timer: 0 },
          { lastX: 0, lastZ: 0, active: false, timer: 0 },
          { lastX: 0, lastZ: 0, active: false, timer: 0 },
        ]);
      }
      const trackers = wheelTrackers.get(car.id);

      for (let i = 0; i < 4; i++) {
        const wheel = car.wheels ? car.wheels[i] : null;
        if (!wheel) continue;

        const isFront = i < 2;
        const isLeft = i % 2 === 0;
        const lonOffset = isFront ? aDist : -bDist;
        const latOffset = isLeft ? halfT : -halfT;

        const wx = car.pos.x + fwdX * lonOffset + leftX * latOffset;
        const wy = car.pos.y + 0.05;
        const wz = car.pos.z + fwdZ * lonOffset + leftZ * latOffset;

        const slipAngleRad = Math.abs(wheel.slipAngle || 0);
        const slipAngleDeg = slipAngleRad * (180 / Math.PI);
        const slipRatio = Math.abs(wheel.slipRatio || 0);

        // Thresholds: slip angle > 12 deg OR slip ratio > 0.18
        const isSliding = slipAngleDeg > 12.0 || slipRatio > 0.18;
        const tracker = trackers[i];

        if (isSliding && (car.speed > 1.2 || Math.abs(wheel.omega || 0) > 8.0)) {
          const angleExcess = Math.max(0, (slipAngleDeg - 12.0) / 16.0);
          const ratioExcess = Math.max(0, (slipRatio - 0.18) / 0.32);
          const intensity = Math.min(1.0, angleExcess + ratioExcess);

          // Emit smoke puffs at rate proportional to intensity
          tracker.timer -= stepDt;
          if (tracker.timer <= 0) {
            tracker.timer = 0.022 / Math.max(0.3, intensity);

            // Smoke color based on surface
            let sr = 0.90, sg = 0.90, sb = 0.91;
            if (car.surface === 'grass') {
              sr = 0.68; sg = 0.70; sb = 0.54;
            } else if (car.surface === 'gravel') {
              sr = 0.72; sg = 0.66; sb = 0.52;
            }

            const startSize = 0.32 + Math.random() * 0.18;
            const endSize = 1.6 + Math.random() * 0.9 + intensity * 0.5;
            const maxAlpha = 0.35 + intensity * 0.28;
            const lifeTime = 0.65 + Math.random() * 0.45;

            const svx = car.vel.x * 0.22 + (Math.random() - 0.5) * 0.6;
            const svy = 0.45 + Math.random() * 0.55;
            const svz = car.vel.z * 0.22 + (Math.random() - 0.5) * 0.6;

            spawnSmokePuff(
              wx + (Math.random() - 0.5) * 0.12,
              wy + 0.10,
              wz + (Math.random() - 0.5) * 0.12,
              svx, svy, svz,
              sr, sg, sb,
              startSize, endSize,
              maxAlpha, lifeTime
            );
          }

          // Persistent skidmarks on track / curb
          if (wheel.onTrack || car.surface === 'track' || car.surface === 'curb') {
            if (tracker.active) {
              const segDist = Math.hypot(wx - tracker.lastX, wz - tracker.lastZ);
              if (segDist > 0.25 && segDist < 3.5) {
                const skidAlpha = Math.min(0.65, Math.max(0.18, intensity * 0.60));
                addSkidSegment(tracker.lastX, tracker.lastZ, wx, wz, wy, 0.28, skidAlpha);
                tracker.lastX = wx;
                tracker.lastZ = wz;
              }
            } else {
              tracker.lastX = wx;
              tracker.lastZ = wz;
              tracker.active = true;
            }
          } else {
            tracker.active = false;
          }
        } else {
          tracker.active = false;
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. ADVANCE ACTIVE SPARKS
    // -------------------------------------------------------------------------
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (!sparkActive[i]) continue;

      sparkLife[i] -= stepDt;
      if (sparkLife[i] <= 0) {
        sparkActive[i] = 0;
        sparkPositions[i * 3 + 1] = -9999;
        sparkAlphas[i] = 0;
        sparkSizes[i] = 0;
        continue;
      }

      // Physics: Gravity & Drag
      sparkVelY[i] -= 14.0 * stepDt;
      sparkVelX[i] *= (1.0 - 2.2 * stepDt);
      sparkVelZ[i] *= (1.0 - 2.2 * stepDt);

      sparkPositions[i * 3] += sparkVelX[i] * stepDt;
      sparkPositions[i * 3 + 1] += sparkVelY[i] * stepDt;
      sparkPositions[i * 3 + 2] += sparkVelZ[i] * stepDt;

      // Ground bounce
      if (sparkPositions[i * 3 + 1] < 0.03) {
        sparkPositions[i * 3 + 1] = 0.03;
        sparkVelY[i] = -sparkVelY[i] * 0.35;
        sparkVelX[i] *= 0.75;
        sparkVelZ[i] *= 0.75;
      }

      const lifeRatio = sparkLife[i] / sparkMaxLife[i];
      sparkAlphas[i] = lifeRatio * lifeRatio; // quadratic fadeout
    }

    sparkPosAttr.needsUpdate = true;
    sparkColorAttr.needsUpdate = true;
    sparkSizeAttr.needsUpdate = true;
    sparkAlphaAttr.needsUpdate = true;

    // -------------------------------------------------------------------------
    // 3. ADVANCE ACTIVE SMOKE PUFFS
    // -------------------------------------------------------------------------
    for (let i = 0; i < MAX_SMOKE; i++) {
      if (!smokeActive[i]) continue;

      smokeLife[i] -= stepDt;
      if (smokeLife[i] <= 0) {
        smokeActive[i] = 0;
        smokePositions[i * 3 + 1] = -9999;
        smokeAlphas[i] = 0;
        smokeSizes[i] = 0;
        continue;
      }

      // Thermal upward buoyancy + ambient deceleration
      smokeVelX[i] *= (1.0 - 1.6 * stepDt);
      smokeVelZ[i] *= (1.0 - 1.6 * stepDt);
      smokeVelY[i] *= (1.0 - 0.7 * stepDt);

      smokePositions[i * 3] += smokeVelX[i] * stepDt;
      smokePositions[i * 3 + 1] += smokeVelY[i] * stepDt;
      smokePositions[i * 3 + 2] += smokeVelZ[i] * stepDt;

      const ageRatio = 1.0 - (smokeLife[i] / smokeMaxLife[i]); // 0 -> 1

      // Scale up smoothly
      const sizeCurve = Math.pow(ageRatio, 0.62);
      smokeSizes[i] = smokeStartSize[i] + (smokeEndSize[i] - smokeStartSize[i]) * sizeCurve;

      // Smooth fade in & fade out
      const maxA = smokeMaxAlpha[i];
      if (ageRatio < 0.12) {
        smokeAlphas[i] = (ageRatio / 0.12) * maxA;
      } else {
        const fadeProgress = (ageRatio - 0.12) / 0.88;
        smokeAlphas[i] = maxA * Math.pow(1.0 - fadeProgress, 1.4);
      }
    }

    smokePosAttr.needsUpdate = true;
    smokeColorAttr.needsUpdate = true;
    smokeSizeAttr.needsUpdate = true;
    smokeAlphaAttr.needsUpdate = true;

    // -------------------------------------------------------------------------
    // 4. UPDATE SKIDMARKS
    // -------------------------------------------------------------------------
    if (skidDirty) {
      skidPosAttr.needsUpdate = true;
      skidAlphaAttr.needsUpdate = true;
      skidDirty = false;
    }
  }

  function dispose() {
    scene.remove(sparkMesh);
    sparkGeo.dispose();
    sparkMat.dispose();

    scene.remove(smokeMesh);
    smokeGeo.dispose();
    smokeMat.dispose();

    scene.remove(skidMesh);
    skidGeo.dispose();
    skidMat.dispose();

    wheelTrackers.clear();
  }

  return { update, dispose };
}
