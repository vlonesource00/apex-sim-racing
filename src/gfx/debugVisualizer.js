import * as THREE from 'three';
import { computeRacingLine } from '../ai/aiDriver.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Default layers configuration
 */
export const DEFAULT_LAYERS = {
  racingLine: true,
  lookahead: true,
  tireForces: true,
  draftCones: true,
  tags: true,
};

/**
 * Color palette constants
 */
const COLOR_ACCEL = new THREE.Color(0x22c55e); // Green
const COLOR_APEX = new THREE.Color(0xfacc15);  // Yellow
const COLOR_BRAKE = new THREE.Color(0xef4444); // Red

const STATE_COLORS = {
  DRAFTING: { bg: 'rgba(6, 182, 212, 0.25)', border: '#06b6d4', text: '#22d3ee' },
  DIVEBOMB: { bg: 'rgba(239, 68, 68, 0.25)', border: '#ef4444', text: '#f87171' },
  DEFENDING: { bg: 'rgba(245, 158, 11, 0.25)', border: '#f59e0b', text: '#fbbf24' },
  SLINGSHOT: { bg: 'rgba(168, 85, 247, 0.25)', border: '#a855f7', text: '#c084fc' },
  BRAKING: { bg: 'rgba(244, 63, 94, 0.25)', border: '#f43f5e', text: '#fb7185' },
  ACCEL: { bg: 'rgba(34, 197, 94, 0.25)', border: '#22c55e', text: '#4ade80' },
  CRUISING: { bg: 'rgba(56, 189, 248, 0.25)', border: '#38bdf8', text: '#7dd3fc' },
  PLAYER: { bg: 'rgba(225, 6, 0, 0.25)', border: '#e10600', text: '#ff6b6b' },
};

/**
 * Retrieve the AI driver instance for a given car from various collection formats.
 */
function getDriverForCar(car, drivers) {
  if (!car) return null;
  if (car._aiDriver) return car._aiDriver;
  if (!drivers) return null;
  if (drivers instanceof Map) return drivers.get(car.id) || null;
  if (Array.isArray(drivers)) return drivers.find((d) => d.car === car || d.car?.id === car.id) || null;
  if (typeof drivers === 'object') return drivers[car.id] || null;
  return null;
}

/**
 * Build racing line data from track if not already computed.
 */
function getRacingLineData(track) {
  if (track._racingLine) return track._racingLine;
  if (track.racingLine) return track.racingLine;
  track._racingLine = computeRacingLine(track);
  return track._racingLine;
}

/**
 * Builds the 3D colored racing line ribbon mesh.
 */
function buildRacingLineMesh(track) {
  const line = getRacingLineData(track);
  if (!line || !track.samples || track.samples.length === 0) return null;

  const S = track.samples;
  const n = S.length;
  const ribbonWidth = 0.45;
  const halfW = ribbonWidth / 2;

  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const indices = [];

  const tempColor = new THREE.Color();

  for (let i = 0; i < n; i++) {
    const s = S[i];
    const nextI = (i + 1) % n;
    const lat = (line.lat && line.lat[i] !== undefined)
      ? line.lat[i]
      : (line.samples && line.samples[i]?.lateral !== undefined)
        ? line.samples[i].lateral
        : 0;

    // Center point on the racing line, slightly elevated above track surface
    const cx = s.pos.x + s.left.x * lat;
    const cz = s.pos.z + s.left.y * lat;
    const cy = s.pos.y + 0.055;

    // Left and right ribbon edges
    const lx = cx + s.left.x * halfW;
    const lz = cz + s.left.y * halfW;
    const rx = cx - s.left.x * halfW;
    const rz = cz - s.left.y * halfW;

    const idxLeft = (i * 2) * 3;
    const idxRight = (i * 2 + 1) * 3;

    positions[idxLeft] = lx;
    positions[idxLeft + 1] = cy;
    positions[idxLeft + 2] = lz;

    positions[idxRight] = rx;
    positions[idxRight + 1] = cy;
    positions[idxRight + 2] = rz;

    normals[idxLeft] = 0; normals[idxLeft + 1] = 1; normals[idxLeft + 2] = 0;
    normals[idxRight] = 0; normals[idxRight + 1] = 1; normals[idxRight + 2] = 0;

    // Calculate vertex color based on acceleration, apex, or braking zone
    const ds = Math.max(0.5, Math.abs(S[nextI].s - s.s));
    const vCurr = line.vT ? line.vT[i] : 50;
    const vNext = line.vT ? line.vT[nextI] : 50;
    const accel = (vNext * vNext - vCurr * vCurr) / (2 * ds);
    const curv = (line.curv ? line.curv[i] : 0);

    if (accel < -1.8) {
      // Braking zone (Blend Yellow -> Red)
      const t = clamp((-accel - 1.8) / 5.5, 0, 1);
      tempColor.copy(COLOR_APEX).lerp(COLOR_BRAKE, t);
    } else if (curv > 0.011) {
      // Apex zone (Blend Green -> Yellow)
      const t = clamp((curv - 0.011) / 0.025, 0, 1);
      tempColor.copy(COLOR_ACCEL).lerp(COLOR_APEX, t);
    } else {
      // Acceleration / Straight zone (Green)
      tempColor.copy(COLOR_ACCEL);
    }

    colors[idxLeft] = tempColor.r;
    colors[idxLeft + 1] = tempColor.g;
    colors[idxLeft + 2] = tempColor.b;

    colors[idxRight] = tempColor.r;
    colors[idxRight + 1] = tempColor.g;
    colors[idxRight + 2] = tempColor.b;
  }

  // Generate closed quad-strip indices
  for (let i = 0; i < n; i++) {
    const nextI = (i + 1) % n;
    const a = i * 2;
    const b = i * 2 + 1;
    const c = nextI * 2;
    const d = nextI * 2 + 1;
    indices.push(a, b, c, b, d, c);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DebugRacingLineRibbon';
  return mesh;
}

const _scratchTarget = new THREE.Vector3();
const _scratchContact = new THREE.Vector3();
const _scratchFwd = new THREE.Vector3();
const _scratchLat = new THREE.Vector3();
const _scratchDir = new THREE.Vector3();

/**
 * Calculates lookahead target position for an AI driver if not explicitly on _debugState.
 */
function calculateLookaheadTarget(car, driver, track, out = _scratchTarget) {
  if (driver?._debugState?.targetPos) {
    const tp = driver._debugState.targetPos;
    return out.set(tp.x, tp.y !== undefined ? tp.y : 0.35, tp.z);
  }

  const v = car.speed || 0;
  const look = 7 + v * 0.34;
  const totalExtraLat = driver
    ? ((driver.defendLat || 0) + (driver.overtakeLat || 0) + (driver.yieldLat || 0) + (driver.mistakeLat || 0))
    : 0;

  const targetS = (car.progressS || 0) + look;
  const sm = track.sampleAt(targetS);

  const line = track._racingLine || track.racingLine;
  let lat = 0;
  if (line && line.lat && sm.idx !== undefined && line.lat[sm.idx] !== undefined) {
    lat = line.lat[sm.idx] + (driver?.offset || 0) + totalExtraLat;
  } else if (line && line.samples && sm.idx !== undefined && line.samples[sm.idx]?.lateral !== undefined) {
    lat = line.samples[sm.idx].lateral + (driver?.offset || 0) + totalExtraLat;
  }

  const halfW = (sm.width || 12) / 2 - 1.4;
  lat = clamp(lat, -halfW, halfW);

  const tx = sm.pos.x + sm.left.x * lat;
  const tz = sm.pos.z + sm.left.y * lat;
  const ty = (track.heightAt ? track.heightAt(tx, tz) : sm.pos.y) + 0.35;

  return out.set(tx, ty, tz);
}

/**
 * Helper to safely draw a rounded rectangle with fallback.
 */
function drawRoundRect(ctx, x, y, width, height, radius) {
  if (ctx.roundRect) {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
  }
}

/**
 * Creates 2D canvas texture for floating driver tag billboard.
 */
function createDriverTagCanvas() {
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(512, 256);
  }
  // Mock canvas object for headless node / test environments
  return {
    width: 512,
    height: 256,
    getContext: () => ({
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      roundRect: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: () => {},
      moveTo: () => {},
      lineTo: () => {},
      measureText: () => ({ width: 60 }),
    }),
  };
}

/**
 * Draws the overhead driver tag onto its canvas.
 */
function drawDriverTag(canvas, name, badge, stateName, speedKph, targetSpeedKph, accentColorHex) {
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;

  ctx.clearRect(0, 0, 512, 256);

  const pad = 14;
  const w = 512 - pad * 2;
  const h = 256 - pad * 2;
  const radius = 24;

  // Background Card with glowing border
  ctx.save();
  ctx.shadowColor = accentColorHex || '#38bdf8';
  ctx.shadowBlur = 16;
  ctx.fillStyle = 'rgba(11, 17, 32, 0.88)';
  ctx.strokeStyle = accentColorHex || '#38bdf8';
  ctx.lineWidth = 4;

  ctx.beginPath();
  drawRoundRect(ctx, pad, pad, w, h, radius);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // 1. Top Header: Driver Name & Archetype Badge
  ctx.save();
  ctx.font = 'bold 30px "Segoe UI", "SF Pro Display", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const displayName = (name || 'DRIVER').toUpperCase();
  ctx.fillText(displayName, pad + 24, pad + 48, 280);

  // Badge capsule
  if (badge) {
    const badgeText = `[${badge.toUpperCase()}]`;
    ctx.font = 'bold 24px monospace';
    const badgeWidth = (ctx.measureText(badgeText)?.width || 60) + 18;
    const badgeX = 512 - pad - 24 - badgeWidth;
    const badgeY = pad + 32;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.strokeStyle = accentColorHex || '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    drawRoundRect(ctx, badgeX, badgeY, badgeWidth, 32, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accentColorHex || '#38bdf8';
    ctx.textAlign = 'center';
    ctx.fillText(badgeText, badgeX + badgeWidth / 2, badgeY + 17);
  }
  ctx.restore();

  // Horizontal divider
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad + 20, pad + 84);
  ctx.lineTo(512 - pad - 20, pad + 84);
  ctx.stroke();

  // 2. Middle Row: Tactical State Tag
  const stStyle = STATE_COLORS[stateName] || STATE_COLORS.CRUISING;
  const stateLabel = `[${stateName}]`;

  ctx.save();
  ctx.font = 'bold 26px monospace';
  const stWidth = (ctx.measureText(stateLabel)?.width || 100) + 24;
  const stX = pad + 24;
  const stY = pad + 104;

  ctx.fillStyle = stStyle.bg;
  ctx.strokeStyle = stStyle.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  drawRoundRect(ctx, stX, stY, stWidth, 38, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = stStyle.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(stateLabel, stX + stWidth / 2, stY + 20);
  ctx.restore();

  // 3. Bottom Row: Speed & Target Speed Readout
  ctx.save();
  ctx.font = 'bold 30px "Consolas", "Courier New", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const vStr = `${Math.round(speedKph)}`;
  const tgtStr = targetSpeedKph !== null ? `${Math.round(targetSpeedKph)}` : '--';

  ctx.fillStyle = '#94a3b8';
  ctx.fillText('v: ', pad + 24, pad + 182);

  ctx.fillStyle = '#38bdf8';
  ctx.fillText(`${vStr}`, pad + 58, pad + 182);

  ctx.fillStyle = '#64748b';
  ctx.fillText(' / tgt: ', pad + 128, pad + 182);

  ctx.fillStyle = '#facc15';
  ctx.fillText(`${tgtStr}`, pad + 225, pad + 182);

  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 22px monospace';
  ctx.fillText('km/h', pad + 295, pad + 182);
  ctx.restore();
}

/**
 * Creates the complete 3D Visual Debug Visualizer subsystem.
 *
 * @param {THREE.Scene} scene - The main Three.js scene.
 * @param {Object} track - The Track instance.
 * @param {Array<Object>} cars - Array of CarState instances.
 * @param {Map|Array|Object} drivers - AI Driver instances.
 * @returns {Object} Debug Visualizer controller.
 */
export function createDebugVisualizer(scene, track, cars = [], drivers = null) {
  let isEnabled = true;
  const layers = { ...DEFAULT_LAYERS };

  // Root group for all debug visualization objects
  const rootGroup = new THREE.Group();
  rootGroup.name = 'ApexDebugVisualizerRoot';
  scene.add(rootGroup);

  // Sub-groups for layer control
  const racingLineGroup = new THREE.Group();
  racingLineGroup.name = 'DebugLayer_RacingLine';

  const lookaheadGroup = new THREE.Group();
  lookaheadGroup.name = 'DebugLayer_Lookahead';

  const tireForcesGroup = new THREE.Group();
  tireForcesGroup.name = 'DebugLayer_TireForces';

  const draftConesGroup = new THREE.Group();
  draftConesGroup.name = 'DebugLayer_DraftCones';

  const tagsGroup = new THREE.Group();
  tagsGroup.name = 'DebugLayer_Tags';

  rootGroup.add(racingLineGroup);
  rootGroup.add(lookaheadGroup);
  rootGroup.add(tireForcesGroup);
  rootGroup.add(draftConesGroup);
  rootGroup.add(tagsGroup);

  // 1. SPECTATOR FOCUS HALO (glowing ground rings on focused car)
  const haloGroup = new THREE.Group();
  haloGroup.name = 'Debug_SpectateHalo';
  const haloRingGeom = new THREE.RingGeometry(1.8, 2.2, 32);
  haloRingGeom.rotateX(-Math.PI / 2);
  const haloRingMat = new THREE.MeshBasicMaterial({
    color: 0x00ddff,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const haloRingMesh = new THREE.Mesh(haloRingGeom, haloRingMat);
  haloGroup.add(haloRingMesh);

  const haloInnerGeom = new THREE.RingGeometry(2.4, 2.52, 32);
  haloInnerGeom.rotateX(-Math.PI / 2);
  const haloInnerMat = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const haloInnerMesh = new THREE.Mesh(haloInnerGeom, haloInnerMat);
  haloGroup.add(haloInnerMesh);
  rootGroup.add(haloGroup);

  // 2. CIRCUIT RACING LINE RIBBON
  const racingLineMesh = buildRacingLineMesh(track);
  if (racingLineMesh) {
    racingLineGroup.add(racingLineMesh);
  }

  // 3. PER-CAR VISUALIZERS
  const carVisualizers = new Map();

  for (const car of cars) {
    const carColorHex = car.colorHex ? `#${car.colorHex.toString(16).padStart(6, '0')}` : '#38bdf8';
    const threeColor = new THREE.Color(car.colorHex ?? 0x38bdf8);

    // --- A. Lookahead Ray & Glowing Target Sphere ---
    const rayPositions = new Float32Array(6);
    const rayGeometry = new THREE.BufferGeometry();
    rayGeometry.setAttribute('position', new THREE.BufferAttribute(rayPositions, 3));
    const rayMaterial = new THREE.LineBasicMaterial({
      color: threeColor,
      linewidth: 2,
      transparent: true,
      opacity: 0.85,
    });
    const rayLine = new THREE.Line(rayGeometry, rayMaterial);
    lookaheadGroup.add(rayLine);

    const sphereGeometry = new THREE.SphereGeometry(0.32, 16, 12);
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: threeColor,
      transparent: true,
      opacity: 0.9,
    });
    const targetSphere = new THREE.Mesh(sphereGeometry, sphereMaterial);

    const ringGeometry = new THREE.RingGeometry(0.24, 0.46, 16);
    ringGeometry.rotateX(Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: threeColor,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    const targetRing = new THREE.Mesh(ringGeometry, ringMaterial);
    targetSphere.add(targetRing);
    lookaheadGroup.add(targetSphere);

    // --- B. 3D Tire Force Vectors (4 Wheels: Fx Red, Fy Blue) ---
    const tireArrows = [];
    const colorRed = 0xff2222;
    const colorBlue = 0x00d4ff;

    for (let w = 0; w < 4; w++) {
      const arrowFx = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, colorRed, 0.35, 0.22);
      const arrowFy = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, colorBlue, 0.35, 0.22);
      tireForcesGroup.add(arrowFx);
      tireForcesGroup.add(arrowFy);
      tireArrows.push({ fx: arrowFx, fy: arrowFy });
    }

    // --- C. Slipstream Drafting Cone (Frustum extending 6m to 40m behind) ---
    const coneGroup = new THREE.Group();
    // Cylinder geometry aligned along -X axis
    const coneGeom = new THREE.CylinderGeometry(1.2, 3.2, 34, 16, 4, true);
    coneGeom.rotateZ(-Math.PI / 2);
    coneGeom.translate(-23, 0.5, 0);

    const coneWireMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const coneWireMesh = new THREE.Mesh(coneGeom, coneWireMat);

    const coneSurfMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const coneSurfMesh = new THREE.Mesh(coneGeom, coneSurfMat);

    coneGroup.add(coneWireMesh);
    coneGroup.add(coneSurfMesh);
    draftConesGroup.add(coneGroup);

    // --- D. Floating Driver Overhead Billboard Tag ---
    const tagCanvas = createDriverTagCanvas();
    const tagTexture = new THREE.CanvasTexture(tagCanvas);
    tagTexture.minFilter = THREE.LinearFilter;
    tagTexture.magFilter = THREE.LinearFilter;

    const tagMaterial = new THREE.SpriteMaterial({
      map: tagTexture,
      transparent: true,
      depthTest: false,
    });
    const tagSprite = new THREE.Sprite(tagMaterial);
    tagSprite.scale.set(3.6, 1.8, 1.0);
    tagsGroup.add(tagSprite);

    carVisualizers.set(car.id, {
      car,
      carColorHex,
      rayLine,
      rayGeometry,
      rayPositions,
      targetSphere,
      targetRing,
      tireArrows,
      coneGroup,
      coneWireMat,
      coneSurfMat,
      tagSprite,
      tagCanvas,
      tagTexture,
      lastTagKey: '',
      tagUpdateTimer: Math.random() * 0.05,
    });
  }

  let totalTime = 0;

  /**
   * Updates all active debug visualizers.
   * @param {number} dt - Delta time in seconds.
   * @param {object} state - Shared game simulation state.
   */
  function update(dt = 0.016, state = null) {
    if (!isEnabled) return;
    totalTime += dt;

    // Pulse factor for glowing spheres
    const pulseScale = 1.0 + 0.12 * Math.sin(totalTime * 6);

    // Update Spectator Focus Halo Ring
    const spectatedCar = state?.spectating ? state.spectatedCar : null;
    if (spectatedCar && layers.lookahead) {
      haloGroup.visible = true;
      haloGroup.position.set(spectatedCar.pos.x, spectatedCar.pos.y + 0.04, spectatedCar.pos.z);
      haloGroup.rotation.y = totalTime * 1.5;
      const s = 1.0 + 0.08 * Math.sin(totalTime * 8);
      haloGroup.scale.set(s, 1, s);
    } else {
      haloGroup.visible = false;
    }

    for (const [carId, viz] of carVisualizers.entries()) {
      const car = viz.car;
      const driver = getDriverForCar(car, drivers);
      const isSpectated = (car === spectatedCar);

      const cosH = Math.cos(car.heading);
      const sinH = Math.sin(car.heading);

      // 1. LOOKAHEAD RAYS & TARGET SPHERES
      if (layers.lookahead) {
        viz.rayLine.visible = true;
        viz.targetSphere.visible = true;

        const targetPos = calculateLookaheadTarget(car, driver, track, _scratchTarget);
        const carY = car.pos.y + 0.45;

        viz.rayPositions[0] = car.pos.x;
        viz.rayPositions[1] = carY;
        viz.rayPositions[2] = car.pos.z;

        viz.rayPositions[3] = targetPos.x;
        viz.rayPositions[4] = targetPos.y;
        viz.rayPositions[5] = targetPos.z;

        viz.rayGeometry.attributes.position.needsUpdate = true;
        viz.targetSphere.position.copy(targetPos);
        viz.targetSphere.scale.setScalar(isSpectated ? pulseScale * 1.5 : pulseScale);
      } else {
        viz.rayLine.visible = false;
        viz.targetSphere.visible = false;
      }

      // 2. 3D TIRE FORCE VECTORS
      if (layers.tireForces) {
        const s = car.setup || { wheelbase: 2.6, trackWidth: 1.68, weightDist: 0.46 };
        const a = (s.weightDist ?? 0.46) * s.wheelbase;
        const b = s.wheelbase - a;
        const halfT = (s.trackWidth ?? 1.68) / 2;

        const axleX = [a, a, -b, -b];
        const axleZ = [halfT, -halfT, halfT, -halfT];
        const steerAngle = car._steer || (car.input?.steer ? car.input.steer * (s.maxSteer || 0.45) : 0);

        const forceScale = 1.0 / 2600; // 2600 N = 1.0 meter

        for (let i = 0; i < 4; i++) {
          const arrowObj = viz.tireArrows[i];
          const wheel = car.wheels?.[i] || {};
          const xLoc = axleX[i];
          const zLoc = axleZ[i];

          // Wheel contact patch in world space
          const cpX = car.pos.x + xLoc * cosH + zLoc * sinH;
          const cpZ = car.pos.z - xLoc * sinH + zLoc * cosH;
          const cpY = car.pos.y + 0.08;
          _scratchContact.set(cpX, cpY, cpZ);

          // Wheel orientation unit vectors
          const delta = i < 2 ? steerAngle : 0;
          const cosD = Math.cos(delta);
          const sinD = Math.sin(delta);

          const fwdX = cosD * cosH + sinD * sinH;
          const fwdZ = -cosD * sinH + sinD * cosH;
          _scratchFwd.set(fwdX, 0, fwdZ).normalize();

          const latX = -sinD * cosH + cosD * sinH;
          const latZ = sinD * sinH + cosD * cosH;
          _scratchLat.set(latX, 0, latZ).normalize();

          // Longitudinal Force Fx
          const fxVal = wheel.fx ?? 0;
          const lenFx = clamp(Math.abs(fxVal) * forceScale, 0, 3.8);
          if (lenFx > 0.06) {
            arrowObj.fx.visible = true;
            arrowObj.fx.position.copy(_scratchContact);
            if (fxVal >= 0) {
              arrowObj.fx.setDirection(_scratchFwd);
            } else {
              _scratchDir.copy(_scratchFwd).negate();
              arrowObj.fx.setDirection(_scratchDir);
            }
            arrowObj.fx.setLength(lenFx, Math.min(lenFx * 0.35, 0.4), Math.min(lenFx * 0.25, 0.22));
          } else {
            arrowObj.fx.visible = false;
          }

          // Lateral Force Fy
          const fyVal = wheel.fy ?? 0;
          const lenFy = clamp(Math.abs(fyVal) * forceScale, 0, 3.8);
          if (lenFy > 0.06) {
            arrowObj.fy.visible = true;
            arrowObj.fy.position.copy(_scratchContact);
            if (fyVal >= 0) {
              arrowObj.fy.setDirection(_scratchLat);
            } else {
              _scratchDir.copy(_scratchLat).negate();
              arrowObj.fy.setDirection(_scratchDir);
            }
            arrowObj.fy.setLength(lenFy, Math.min(lenFy * 0.35, 0.4), Math.min(lenFy * 0.25, 0.22));
          } else {
            arrowObj.fy.visible = false;
          }
        }
      } else {
        for (let i = 0; i < 4; i++) {
          viz.tireArrows[i].fx.visible = false;
          viz.tireArrows[i].fy.visible = false;
        }
      }

      // 3. SLIPSTREAM DRAFTING CONES
      if (layers.draftCones) {
        viz.coneGroup.visible = true;
        viz.coneGroup.position.copy(car.pos);
        viz.coneGroup.rotation.y = car.heading;

        // Check if any trailing car is inside this car's draft cone
        let isDrafted = false;
        for (const other of cars) {
          if (other === car) continue;
          const dx = other.pos.x - car.pos.x;
          const dz = other.pos.z - car.pos.z;
          const fwd = dx * cosH - dz * sinH;
          const lat = -dx * sinH - dz * cosH;

          if (fwd <= -6 && fwd >= -40) {
            const t = (-fwd - 6) / 34; // 0 (near) to 1 (far)
            const maxR = 1.2 + t * 2.0;
            if (Math.abs(lat) <= maxR) {
              isDrafted = true;
              break;
            }
          }
        }

        if (isDrafted) {
          viz.coneWireMat.color.setHex(0x00ffff);
          viz.coneWireMat.opacity = 0.85;
          viz.coneSurfMat.color.setHex(0x00e5ff);
          viz.coneSurfMat.opacity = 0.22;
        } else {
          viz.coneWireMat.color.setHex(0x38bdf8);
          viz.coneWireMat.opacity = 0.24;
          viz.coneSurfMat.color.setHex(0x38bdf8);
          viz.coneSurfMat.opacity = 0.05;
        }
      } else {
        viz.coneGroup.visible = false;
      }

      // 4. FLOATING DRIVER OVERHEAD BILLBOARD TAGS
      if (layers.tags) {
        viz.tagSprite.visible = true;
        viz.tagSprite.position.set(car.pos.x, car.pos.y + (isSpectated ? 2.65 : 2.35), car.pos.z);
        viz.tagSprite.scale.set(isSpectated ? 4.2 : 3.6, isSpectated ? 2.1 : 1.8, 1.0);

        viz.tagUpdateTimer -= dt;
        if (viz.tagUpdateTimer <= 0) {
          viz.tagUpdateTimer = 0.04; // Throttle redraws to 25Hz per car

          // Determine driver name & badge
          const name = car.isPlayer ? (car.name || 'YOU') : (driver?.name || car.name || 'AI DRIVER');
          const badge = isSpectated ? `★ ${car.isPlayer ? 'YOU' : (driver?.badge || driver?.archetype?.badge || 'AI')}` : (car.isPlayer ? 'PLAYER' : (driver?.badge || driver?.archetype?.badge || 'AI'));

          // Determine tactical state
          let stateName = 'CRUISING';
          if (car.isPlayer) {
            stateName = 'PLAYER';
          } else if (driver?.divebombActive) {
            stateName = 'DIVEBOMB';
          } else if (driver?.slingshotActive) {
            stateName = 'SLINGSHOT';
          } else if (driver?.draftTimer > 0.25) {
            stateName = 'DRAFTING';
          } else if (Math.abs(driver?.defendLat || 0) > 0.35) {
            stateName = 'DEFENDING';
          } else if (car.input?.brake > 0.3) {
            stateName = 'BRAKING';
          } else if (car.input?.throttle > 0.85) {
            stateName = 'ACCEL';
          }

          // Speeds
          const speedKph = car.speedKph ?? (car.speed ? car.speed * 3.6 : 0);
          let targetSpeedKph = null;
          if (driver?._debugState?.targetSpeed !== undefined) {
            targetSpeedKph = driver._debugState.targetSpeed;
          } else if (driver?.line?.vT && track.length) {
            const progress = ((car.progressS % track.length) + track.length) % track.length;
            const idx = Math.min(driver.line.vT.length - 1, Math.max(0, Math.floor((progress / track.length) * driver.line.vT.length)));
            targetSpeedKph = driver.line.vT[idx] * (driver.skill || 1) * 3.6;
          }

          const tagKey = `${name}|${badge}|${stateName}|${Math.round(speedKph)}|${targetSpeedKph !== null ? Math.round(targetSpeedKph) : 0}`;
          if (tagKey !== viz.lastTagKey) {
            viz.lastTagKey = tagKey;
            drawDriverTag(viz.tagCanvas, name, badge, stateName, speedKph, targetSpeedKph, viz.carColorHex);
            viz.tagTexture.needsUpdate = true;
          }
        }
      } else {
        viz.tagSprite.visible = false;
      }
    }
  }

  const LAYER_ALIASES = {
    tireVectors: 'tireForces',
    tireForces: 'tireForces',
    overheadTags: 'tags',
    tags: 'tags',
    racingLine: 'racingLine',
    lookahead: 'lookahead',
    draftCones: 'draftCones',
  };

  /**
   * Set overall visualizer visibility master switch.
   * @param {boolean} enabled
   */
  function setEnabled(enabled) {
    isEnabled = !!enabled;
    rootGroup.visible = isEnabled;
  }

  /**
   * Configure visibility per layer.
   * @param {Object} newLayers - Partial or full layers config object.
   */
  function setLayers(newLayers = {}) {
    for (const [k, v] of Object.entries(newLayers)) {
      const mapped = LAYER_ALIASES[k] || k;
      if (mapped in layers) {
        layers[mapped] = !!v;
      }
    }
    racingLineGroup.visible = !!layers.racingLine;
    lookaheadGroup.visible = !!layers.lookahead;
    tireForcesGroup.visible = !!layers.tireForces;
    draftConesGroup.visible = !!layers.draftCones;
    tagsGroup.visible = !!layers.tags;
  }

  /**
   * Set visibility for a single layer name (supports aliases like tireVectors/overheadTags).
   * @param {string} name
   * @param {boolean} visible
   */
  function setLayerVisibility(name, visible) {
    const key = LAYER_ALIASES[name] || name;
    if (key in layers) {
      layers[key] = !!visible;
      setLayers(layers);
    }
  }

  /**
   * Retrieve current layers configuration.
   * @returns {Object}
   */
  function getLayers() {
    return { ...layers };
  }

  /**
   * Cleanly disposes all Three.js geometries, materials, and canvas textures.
   */
  function dispose() {
    scene.remove(rootGroup);

    rootGroup.traverse((obj) => {
      if (obj.geometry) {
        obj.geometry.dispose();
      }
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

    carVisualizers.clear();
  }

  // Initialize layer visibility
  setLayers(layers);

  return {
    group: rootGroup,
    layers,
    setEnabled,
    setLayers,
    setLayerVisibility,
    getLayers,
    update,
    dispose,
  };
}
