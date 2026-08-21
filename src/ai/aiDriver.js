import { createPolicy, evaluatePolicy, loadWeights } from './nnPolicy.js';
import trainedWeightsData from './trainedWeights.json' with { type: 'json' };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const ALAT_MAX = 8.2;
const ABRAKE = 8.0;
const A_ACCEL = (v) => clamp(9.2 - v * 0.08, 2.0, 9.2);

export const AI_ARCHETYPES = {
  viper: {
    id: 'viper',
    name: 'Alex "Viper" Vance',
    badge: 'VIPER',
    personality: 'Aggressive / Divebomber',
    colorHex: 0xef4444,
    skill: 1.00,
    brakeNoise: 0.99,          // Late braker
    yieldLat: -2.2,             // Aggressive inside line diver
    diveAggression: 1.35,       // High divebomb intent into braking zones
    draftAggression: 1.15,      // High draft tow pull
    draftSpeedBoost: 1.08,      // Speed boost intent from slipstream
    defenseAggression: 0.70,    // Moderately defends
    defenseLookahead: 18,
    mistakeProb: 0.04,          // Overcooks entry occasionally under pressure
    throttleAggression: 1.00,
    cornerSpeedFactor: 1.01,
  },
  surgeon: {
    id: 'surgeon',
    name: 'Marco "The Surgeon" Rossi',
    badge: 'SURGEON',
    personality: 'Smooth / Precision',
    colorHex: 0x3b82f6,
    skill: 1.00,
    brakeNoise: 1.00,          // Laser-precise apex clipping & optimal braking
    yieldLat: -1.6,             // Clean, measured overtakes
    diveAggression: 0.50,       // Patient overtaker
    draftAggression: 1.05,
    draftSpeedBoost: 1.05,
    defenseAggression: 0.85,    // Clean positional defense
    defenseLookahead: 18,
    mistakeProb: 0.005,         // Virtually zero mistakes
    throttleAggression: 1.00,   // Confident, clean throttle
    cornerSpeedFactor: 1.02,    // Optimal high apex corner speed
  },
  wall: {
    id: 'wall',
    name: 'Viktor "The Wall" Steiner',
    badge: 'WALL',
    personality: 'Defensive / Blocker',
    colorHex: 0xeab308,
    skill: 0.98,
    brakeNoise: 0.97,          // Sturdy, predictable braking
    yieldLat: -1.4,             // Sturdy track presence
    diveAggression: 0.65,
    draftAggression: 1.00,
    draftSpeedBoost: 1.04,
    defenseAggression: 1.45,    // Highly aggressive inside line blocker
    defenseLookahead: 22,       // Covers inside lane early
    mistakeProb: 0.02,
    throttleAggression: 0.98,
    cornerSpeedFactor: 0.99,
    wideExitBias: 0.35,         // Holds wide line on exit
  },
  rocket: {
    id: 'rocket',
    name: 'Elena "Rocket" Rostova',
    badge: 'ROCKET',
    personality: 'Daring Late-Braker',
    colorHex: 0xa855f7,
    skill: 1.00,
    brakeNoise: 1.01,          // Late braker
    yieldLat: -2.0,             // Eager slingshot pullout
    diveAggression: 1.20,       // Deep dive
    draftAggression: 1.25,      // Slingshot specialist
    draftSpeedBoost: 1.10,      // High slipstream top speed
    trailBrakeMod: 1.25,        // Deep trail-braking deep into corner apex
    defenseAggression: 0.75,
    defenseLookahead: 18,
    mistakeProb: 0.05,          // Takes daring risks -> occasional minor slides
    throttleAggression: 1.00,
    cornerSpeedFactor: 1.01,
  },
  rookie: {
    id: 'rookie',
    name: 'Lucas "Rookie" Silva',
    badge: 'ROOKIE',
    personality: 'Cautious / Variable',
    colorHex: 0x10b981,
    skill: 0.94,
    brakeNoise: 0.95,          // Slightly conservative braking point
    yieldLat: 1.8,              // Yields room easily when challenged
    diveAggression: 0.35,       // Cautious attacker
    draftAggression: 0.95,
    draftSpeedBoost: 1.03,
    defenseAggression: 0.30,    // Leaves inside open
    defenseLookahead: 14,
    mistakeProb: 0.07,          // Small chance of minor lockup/running wide under close pressure
    throttleAggression: 0.92,
    cornerSpeedFactor: 0.96,    // Conservative corner entry
  },
};

const ARCHETYPE_KEYS = ['viper', 'surgeon', 'wall', 'rocket', 'rookie'];
let driverCounter = 0;

export function computeRacingLine(track) {
  const S = track.samples;
  const n = S.length;
  const curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nextIdx = (i + 2) % n;
    const a = S[i].dir, b = S[nextIdx].dir;
    let d = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    let ds = S[nextIdx].s - S[i].s;
    if (ds < 0) ds += track.length;
    curv[i] = Math.abs(d) / Math.max(ds, 0.1);
  }
  // smooth curvature
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -2; k <= 2; k++) acc += curv[(i + k + n) % n];
    sm[i] = acc / 5;
  }

  const vT = new Float32Array(n);
  for (let i = 0; i < n; i++) vT[i] = Math.min(78, Math.sqrt(ALAT_MAX / Math.max(sm[i], 1e-5)));

  // backward braking pass + forward accel pass (6 iterations with proper closed-loop wrap)
  for (let iter = 0; iter < 6; iter++) {
    for (let count = 0; count < n; count++) {
      const i = (n - 1 - count + n) % n;
      const nextI = (i + 1) % n;
      let ds = S[nextI].s - S[i].s;
      if (ds < 0) ds += track.length;
      vT[i] = Math.min(vT[i], Math.sqrt(vT[nextI] ** 2 + 2 * ABRAKE * Math.abs(ds)));
    }
    for (let i = 0; i < n; i++) {
      const nextI = (i + 1) % n;
      let ds = S[nextI].s - S[i].s;
      if (ds < 0) ds += track.length;
      vT[nextI] = Math.min(vT[nextI], Math.sqrt(vT[i] ** 2 + 2 * A_ACCEL(vT[i]) * ds));
    }
  }

  // signed curvature (smoothed) for both line offset and steer feed-forward
  const sc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nextIdx = (i + 3) % n;
    const a = S[i].dir, b = S[nextIdx].dir;
    let d = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    let ds = S[nextIdx].s - S[i].s;
    if (ds < 0) ds += track.length;
    sc[i] = d / Math.max(ds, 0.1);
  }
  const scs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -6; k <= 6; k++) acc += sc[(i + k + n) % n];
    scs[i] = acc / 13;
  }

  // lateral out-in-out: hug inside in corners, center on straights (corner-gated)
  const lat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const curvMag = Math.abs(scs[i]);
    const gate = clamp(curvMag * 100 - 0.05, 0, 1);   // 0 on straights, 1 in corners
    lat[i] = clamp(scs[i] * 90, -1, 1) * gate;
  }
  for (let p = 0; p < 24; p++) {
    for (let i = 0; i < n; i++) {
      lat[i] = (lat[(i - 2 + n) % n] + lat[(i - 1 + n) % n] + lat[i] * 2 + lat[(i + 1) % n] + lat[(i + 2) % n]) / 6;
    }
  }
  const maxLat = (i) => S[i].width / 2 - 1.6;
  for (let i = 0; i < n; i++) lat[i] = clamp(lat[i] * (S[i].width / 2 - 1.3), -maxLat(i), maxLat(i));

  const samples = S.map((s, i) => ({ s: s.s, lateral: lat[i], targetSpeed: vT[i] }));
  return { samples, vT, lat, curv: sm, scurv: sc };
}

export function createAiDriver(car, track, skill = 1, archetype = null) {
  const line = track._racingLine || (track._racingLine = computeRacingLine(track));
  const policy = createPolicy();
  if (trainedWeightsData) {
    loadWeights(policy, JSON.stringify(trainedWeightsData));
    if (trainedWeightsData.trained) policy.trained = true;
  }

  // Determine Archetype
  let archKey = archetype;
  if (!archKey && car) {
    if (car.archetype) archKey = car.archetype;
    else if (car.name) {
      const lower = car.name.toLowerCase();
      for (const k of ARCHETYPE_KEYS) {
        if (lower.includes(k) || lower.includes(AI_ARCHETYPES[k].badge.toLowerCase())) {
          archKey = k;
          break;
        }
      }
    }
  }
  if (!archKey || !AI_ARCHETYPES[archKey]) {
    archKey = ARCHETYPE_KEYS[driverCounter % ARCHETYPE_KEYS.length];
    driverCounter++;
  }

  const arch = AI_ARCHETYPES[archKey];
  const driverSkill = skill ?? arch.skill ?? 1.0;

  // Base lateral offset tailored to archetype
  let baseOffset = 0;
  if (archKey === 'rookie') baseOffset = (Math.random() - 0.5) * 0.6;
  else if (archKey === 'wall') baseOffset = (Math.random() > 0.5 ? 0.2 : -0.2);
  else if (archKey === 'viper') baseOffset = (Math.random() - 0.5) * 0.3;
  else if (archKey === 'surgeon') baseOffset = 0; // Laser precision

  const driver = {
    car,
    track,
    line,
    skill: driverSkill,
    policy,
    archetype: arch,
    archetypeKey: archKey,
    name: arch.name,
    badge: arch.badge,
    aLat: ALAT_MAX * driverSkill * (arch.cornerSpeedFactor || 1.0),
    offset: baseOffset,
    _brakeNoise: arch.brakeNoise,

    // Dynamic racecraft state
    defendLat: 0,
    overtakeLat: 0,
    yieldLat: 0,
    mistakeLat: 0,
    mistakeDuration: 0,
    mistakeCooldown: 0,
    mistakeType: null,
    pressureTimer: 0,
    draftTimer: 0,
    slingshotActive: false,
    divebombActive: false,
    stabilizationTimer: 0,
    emergencyBrake: 0,
    avoidanceActive: false,
    understeerCorrecting: false,
    _debugState: null,
  };

  if (car) car._aiDriver = driver;
  return driver;
}

function linePoint(driver, s = 0, lateralOffset = 0) {
  const { track, line } = driver;
  const sNum = typeof s === 'number' && !isNaN(s) ? s : 0;
  const t = ((sNum % track.length) + track.length) % track.length;
  const S = track.samples;
  const n = S.length;

  let lo = 0, hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (S[mid].s <= t) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const i = Math.max(0, Math.min(hi, n - 1));
  const j = (i + 1) % n;
  const a = S[i], b = S[j];

  let segLen = b.s - a.s;
  if (segLen < 0) segLen += track.length;
  segLen = Math.max(segLen, 0.001);

  let distFromA = t - a.s;
  if (distFromA < 0) distFromA += track.length;
  const f = clamp(distFromA / segLen, 0, 1);

  const trackWidth = (a.width || 12) + ((b.width || 12) - (a.width || 12)) * f;
  const maxLat = Math.max(trackWidth / 2 - 2.2, 1.0);
  const rawLat = line.lat[i] + (line.lat[j] - line.lat[i]) * f + (driver.offset || 0) + lateralOffset;
  const latI = clamp(rawLat, -maxLat, maxLat);

  const leftX = a.left.x + (b.left.x - a.left.x) * f;
  const leftY = a.left.y + (b.left.y - a.left.y) * f;

  const px = a.pos.x + (b.pos.x - a.pos.x) * f + leftX * latI;
  const py = (a.pos.y || 0) + ((b.pos.y || 0) - (a.pos.y || 0)) * f;
  const pz = a.pos.z + (b.pos.z - a.pos.z) * f + leftY * latI;

  const v = line.vT[i] + (line.vT[j] - line.vT[i]) * f;
  const k = line.scurv[i] + (line.scurv[j] - line.scurv[i]) * f;
  const curvAbs = line.curv[i] + (line.curv[j] - line.curv[i]) * f;
  return { x: px, y: py, z: pz, pos: { x: px, y: py, z: pz }, v, k, curvAbs, idx: i, lateral: latI, maxLat };
}

function getObs(car, track, line) {
  const obs = new Float32Array(16);
  const n = track.nearest(car.pos);
  const s = n.s;
  const sample = track.samples[n.idx] || track.samples[0];
  
  obs[0] = car.speed / 100.0;
  obs[1] = car.yawRate / 5.0;
  obs[2] = n.lateral / 10.0;
  
  let headingErr = car.heading - Math.atan2(-sample.dir.y, sample.dir.x);
  while(headingErr > Math.PI) headingErr -= 2 * Math.PI;
  while(headingErr < -Math.PI) headingErr += 2 * Math.PI;
  obs[3] = headingErr / Math.PI;
  
  const lookaheads = [10, 25, 50, 80, 120];
  for(let i=0; i<5; i++) {
    const ls = (s + lookaheads[i]) % track.length;
    let lo = 0, hi = track.samples.length - 1;
    while(lo < hi) { const m = (lo + hi) >> 1; if(track.samples[m].s < ls) lo = m + 1; else hi = m; }
    obs[4 + i] = line.curv[lo] * 10;
  }
  
  for(let i=0; i<4; i++) {
    obs[9 + i] = car.wheels[i].slipAngle / (Math.PI / 4);
  }
  
  obs[13] = car.input.throttle;
  obs[14] = car.input.brake;
  obs[15] = car.input.steer;
  return obs;
}

export function updateAiDriver(driver, cars, dt, active = true) {
  const { car, track, policy, skill } = driver;
  if (!active) {
    car.input.throttle = 0; car.input.brake = 1; car.input.steer = 0;
    return;
  }

  const arch = driver.archetype || AI_ARCHETYPES.viper;
  const v = car.speed || 0;
  const progressS = typeof car.progressS === 'number' && !isNaN(car.progressS) ? car.progressS : 0;
  const look = 7 + v * 0.34;

  // Handle mistake timers & pressure
  if (driver.mistakeCooldown > 0) driver.mistakeCooldown -= dt;
  if (driver.mistakeDuration > 0) {
    driver.mistakeDuration -= dt;
  } else {
    driver.mistakeType = null;
    driver.mistakeLat = 0;
  }

  // Handle post-impact stabilization recovery
  if (car.wallHit && car.wallHit > 0.15) {
    driver.stabilizationTimer = 1.2;
  } else if (driver.stabilizationTimer > 0) {
    driver.stabilizationTimer -= dt;
  }

  // Tactical situational awareness: scan opponents
  let draftMod = 1.0;
  let slowFactor = 1.0;
  let targetDefendLat = 0;
  let targetOvertakeLat = 0;
  let targetYieldLat = 0;
  let maxEmergencyBrake = 0;
  let avoidanceActive = false;
  let useFallback = true;
  let isUnderPressure = false;

  const cosH = Math.cos(car.heading), sinH = Math.sin(car.heading);
  const aheadTurnSample = linePoint(driver, progressS + look + 25);
  const upcomingCurv = aheadTurnSample.k;
  const isUpcomingCorner = Math.abs(upcomingCurv) > 0.005;
  const insideDir = upcomingCurv > 0 ? 1.0 : upcomingCurv < 0 ? -1.0 : 0;

  const nearestTrackSample = track.nearest(car.pos);
  const trackSample = track.samples[nearestTrackSample.idx] || track.samples[0];
  const halfTrackWidth = ((trackSample.width || 12) / 2) - 1.6;
  const currentLateral = nearestTrackSample.lateral;

  for (const o of cars) {
    if (!o || o === car || !o.pos) continue;
    const dx = o.pos.x - car.pos.x, dz = o.pos.z - car.pos.z;
    const fwd = dx * cosH - dz * sinH;
    const latO = -dx * sinH - dz * cosH;
    const closingSpeed = v - (o.speed || 0);
    const inDirectPath = Math.abs(latO) < 1.45; // True direct rear-end alignment

    // 1. Slipstream Drafting & High-Speed Tow (fwd: 5m to 45m)
    if (fwd > 5.0 && fwd < 45.0 && Math.abs(latO) < 3.2) {
      draftMod = Math.max(draftMod, arch.draftSpeedBoost || 1.08);
      driver.draftTimer = Math.min(2.5, (driver.draftTimer || 0) + dt * 1.5);

      // Opportunistic Passing Lane Commitment:
      // When closing on the car ahead, pick open side of track and commit to passing lane!
      if (fwd < 30.0) {
        let passSide = latO >= 0 ? -1.5 : 1.5;
        // Prefer inside lane if approaching a corner
        if (isUpcomingCorner && insideDir !== 0) {
          passSide = insideDir * (arch.yieldLat ? Math.abs(arch.yieldLat) * 0.75 : 1.4);
        }
        // Validate track boundary
        if (passSide < 0 && (currentLateral < -halfTrackWidth + 1.8)) passSide = 1.4;
        else if (passSide > 0 && (currentLateral > halfTrackWidth - 1.8)) passSide = -1.4;

        targetOvertakeLat = passSide;
        driver.slingshotActive = true;
      }
    } else {
      driver.draftTimer = Math.max(0, (driver.draftTimer || 0) - dt * 2.0);
      if (driver.draftTimer <= 0) driver.slingshotActive = false;
    }

    // 2. Late-Braking Divebombs (Alex "Viper", Elena "Rocket", Marco "The Surgeon")
    if (isUpcomingCorner && fwd > 2.0 && fwd < 24.0 && closingSpeed > 0.3) {
      if ((arch.diveAggression || 1.0) > 0.6) {
        driver.divebombActive = true;
        const diveLat = insideDir !== 0 ? insideDir * (arch.yieldLat ? Math.abs(arch.yieldLat) * 0.75 : 1.4) : (latO >= 0 ? -1.4 : 1.4);
        targetOvertakeLat = diveLat;
      }
    } else {
      driver.divebombActive = false;
    }

    // 3. Defensive Line Covering (Viktor "The Wall", Marco "The Surgeon")
    if (fwd > -25.0 && fwd < -2.0 && Math.abs(latO) < 3.5) {
      if (isUpcomingCorner && (arch.defenseAggression || 0) > 0.5) {
        targetDefendLat = insideDir !== 0 ? insideDir * (1.1 * (arch.defenseAggression || 1.0)) : (latO > 0 ? 1.1 : -1.1);
      }
    }

    // 4. Side-by-Side Wheel-to-Wheel Spatial Clearance (2.0m Dynamic Corridor)
    if (Math.abs(fwd) < 4.8 && Math.abs(latO) < 2.4) {
      const overlap = clamp(2.4 - Math.abs(latO), 0, 2.0);
      if (latO > 0) {
        // Opponent on left -> hold right lane
        targetYieldLat -= Math.max(overlap * 0.75, 0.4);
      } else {
        // Opponent on right -> hold left lane
        targetYieldLat += Math.max(overlap * 0.75, 0.4);
      }
    }

    // 5. Anti-Crash Emergency TTC Radar (Only when directly in collision path)
    if (fwd > 0.8 && fwd < 20.0 && inDirectPath) {
      if (closingSpeed > 1.5 && fwd < 18.0) {
        const ttc = fwd / closingSpeed;
        if (ttc < 0.95) {
          const eBrake = clamp((0.95 - ttc) * 1.8, 0.4, 1.0);
          maxEmergencyBrake = Math.max(maxEmergencyBrake, eBrake);
          avoidanceActive = true;
          if (targetOvertakeLat === 0) {
            targetOvertakeLat = latO >= 0 ? -2.2 : 2.2;
          }
        }
      }

      // Point-blank rear proximity buffer (< 3.8m directly behind)
      if (fwd < 3.8 && closingSpeed > 0) {
        const proxBrake = clamp((3.8 - fwd) / 2.5, 0.3, 0.85);
        maxEmergencyBrake = Math.max(maxEmergencyBrake, proxBrake);
        avoidanceActive = true;
        if (targetOvertakeLat === 0) {
          targetOvertakeLat = latO >= 0 ? -2.2 : 2.2;
        }
      }
    }

    // 6. Pressure & Mistake Detection
    if (fwd > -4.0 && fwd < 4.0 && Math.abs(latO) < 3.0) {
      isUnderPressure = true;
    }
  }

  driver.emergencyBrake = maxEmergencyBrake;
  driver.avoidanceActive = avoidanceActive;

  // Pressure accumulation & mistake simulation
  if (isUnderPressure) {
    driver.pressureTimer = (driver.pressureTimer || 0) + dt;
    if (driver.mistakeCooldown <= 0 && driver.pressureTimer > 0.5) {
      if (Math.random() < (arch.mistakeProb || 0.04)) {
        // Trigger mistake under close pressure
        const types = ['lateBrake', 'wideLine', 'hesitation'];
        driver.mistakeType = types[Math.floor(Math.random() * types.length)];
        driver.mistakeDuration = 0.9;
        driver.mistakeCooldown = 5.5;

        if (driver.mistakeType === 'wideLine') {
          // Slide 0.7m wide (away from inside apex)
          driver.mistakeLat = insideDir !== 0 ? -insideDir * 0.7 : (Math.random() > 0.5 ? 0.7 : -0.7);
        }
      }
    }
  } else {
    driver.pressureTimer = Math.max(0, (driver.pressureTimer || 0) - dt * 1.5);
  }

  // Smooth filter dynamic offsets with agile steering response
  const filterRate = clamp(dt * (avoidanceActive || driver.slingshotActive ? 7.5 : 4.5), 0, 1);
  driver.defendLat += (targetDefendLat - driver.defendLat) * filterRate;
  driver.overtakeLat += (targetOvertakeLat - driver.overtakeLat) * filterRate;
  driver.yieldLat += (targetYieldLat - driver.yieldLat) * filterRate;

  let totalExtraLat = driver.defendLat + driver.overtakeLat + driver.yieldLat + driver.mistakeLat;
  totalExtraLat = clamp(totalExtraLat, -halfTrackWidth, halfTrackWidth);

  // Neural Network policy execution (if trained policy is supplied)
  const obs = getObs(car, track, driver.line);
  if (Math.abs(obs[2]) > 1.2 || Math.abs(totalExtraLat) > 0.5 || avoidanceActive || driver.stabilizationTimer > 0) {
    useFallback = true;
  }

  // During emergency avoidance, slightly shorten lookahead distance for agility while preserving stability
  const effectiveLook = avoidanceActive ? Math.max(6.5, look * 0.75) : look;
  const pt = linePoint(driver, progressS + effectiveLook, totalExtraLat);

  // Target speed calculation with Dynamic Stopping Distance along forward line
  let brakeFactor = driver._brakeNoise || 1.0;
  if (driver.mistakeType === 'lateBrake') brakeFactor *= 1.02;
  const cornerSpeed = Math.min(1.03, arch.cornerSpeedFactor || 1.0);
  const aEff = 7.2 * (arch.brakeNoise || 1.0) * skill;

  // On straights, allow draftMod speed boost; in corners/braking zones, cap strictly to physical tire limits
  const speedBoost = isUpcomingCorner ? 1.0 : draftMod;
  let vTarg = pt.v * brakeFactor * slowFactor * skill * cornerSpeed * speedBoost;

  // Multi-horizon stopping distance lookahead: dStop = (v^2 - vApex^2) / (2 * aBrake)
  const lookaheadDistances = [6, 12, 20, 30, 44, 60, 80, 105, 135];
  for (let k = 0; k < lookaheadDistances.length; k++) {
    const distAhead = lookaheadDistances[k];
    const aheadSample = linePoint(driver, progressS + look + distAhead, totalExtraLat);
    const vApex = aheadSample.v * cornerSpeed * (arch.brakeNoise || 1.0) * skill;
    const vMaxAllowed = Math.sqrt(Math.max(0, vApex * vApex + 2 * aEff * distAhead)) * slowFactor;
    if (vMaxAllowed < vTarg) {
      vTarg = vMaxAllowed;
    }
  }

    const dxT = pt.x - car.pos.x, dzT = pt.z - car.pos.z;
    const target = Math.atan2(-dzT, dxT);
    let err = target - car.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;

    const ff = pt.k * car.setup.wheelbase / 0.45;
    // Active counter-steer damping catches slides immediately
    const steer = clamp(err * 2.2 - car.yawRate * 0.14 + ff, -1, 1);
    car.input.steer = steer;

    const dv = vTarg - v;
    if (maxEmergencyBrake > 0.15) {
      // Emergency braking from TTC radar or proximity
      car.input.brake = clamp(maxEmergencyBrake, 0, 1.0);
      car.input.throttle = 0;
    } else if (driver.stabilizationTimer > 0) {
      // Clean throttle ramping after wall impact / touch
      const stabProgress = clamp(1.0 - driver.stabilizationTimer / 1.2, 0, 1);
      car.input.throttle = clamp(0.40 + 0.60 * stabProgress, 0, 1.0);
      car.input.brake = 0;
    } else if (dv > 0.3) {
      // Accelerating
      let throttle = 1.0;
      if (dv < 2.5 && Math.abs(steer) > 0.18) {
        // High lateral load corner exit: modulate throttle to prevent snapping the rear
        throttle = clamp(dv * 0.45, 0.5, 1.0);
        if (arch.throttleAggression && arch.throttleAggression < 1.0) {
          throttle *= arch.throttleAggression;
        }
      } else {
        // Straights & open exits: FULL 100% THROTTLE
        throttle = 1.0;
      }
      if (driver.mistakeType === 'hesitation') {
        throttle *= 0.7; // Hesitation mistake
      }
      car.input.throttle = clamp(throttle * (draftMod > 1 ? 1.05 : 1.0), 0, 1.0);
      car.input.brake = 0;
    } else if (dv < -0.3) {
      // Decisive Threshold Braking with Trail-Braking
      let brake = clamp(-dv * 0.45, 0.4, 1.0);
      // Trail-braking: as steering angle increases towards apex, trail off brake
      if (Math.abs(steer) > 0.08) {
        const trailMod = arch.trailBrakeMod ? 0.35 : 0.48;
        brake = clamp(brake * (1.0 - Math.abs(steer) * trailMod), 0.15, 1.0);
      }
      car.input.throttle = 0;
      car.input.brake = clamp(brake, 0, 1.0);
    } else {
      // Rolling / maintaining high corner speed
      let rollThrottle = clamp(0.38 + (arch.cornerSpeedFactor ? (arch.cornerSpeedFactor - 0.95) * 0.5 : 0.05), 0.3, 0.6);
      if (driver.mistakeType === 'hesitation') rollThrottle *= 0.7;
      car.input.throttle = rollThrottle;
      car.input.brake = 0;
    }

    // Traction control on excessive rear wheelspin
    const spin = Math.max(car.wheels?.[2]?.slipRatio ?? 0, car.wheels?.[3]?.slipRatio ?? 0);
    if (spin > 0.16) car.input.throttle *= 0.75;

  driver._debugState = {
    targetPos: { x: pt.pos.x, y: pt.pos.y, z: pt.pos.z },
    targetSpeed: vTarg * 3.6,        // km/h
    currentSpeed: v * 3.6,           // km/h
    lookaheadDist: look,             // meters
    mode: driver.stabilizationTimer > 0 ? 'STABILIZING' :
          driver.emergencyBrake > 0.15 ? 'EMERGENCY_BRAKE' :
          driver.divebombActive ? 'DIVEBOMB' :
          driver.slingshotActive ? 'SLINGSHOT' :
          Math.abs(driver.overtakeLat) > 0.4 ? 'OVERTAKING' :
          Math.abs(driver.defendLat) > 0.3 ? 'DEFENDING' :
          driver.draftTimer > 0.05 ? 'DRAFTING' :
          driver.avoidanceActive ? 'EVADING' :
          driver.understeerCorrecting ? 'ANTI_UNDERSTEER' :
          car.input.throttle > 0.85 ? 'FULL THROTTLE' :
          (Math.abs(car.input.steer) > 0.12 || Math.abs(pt.k) > 0.006) ? 'CORNERING' :
          driver.mistakeType ? `MISTAKE (${driver.mistakeType})` : 'CRUISING',
    defendLat: driver.defendLat || 0,
    overtakeLat: driver.overtakeLat || 0,
    yieldLat: driver.yieldLat || 0,
    mistakeLat: driver.mistakeLat || 0,
    totalExtraLat: totalExtraLat || 0,
    emergencyBrake: driver.emergencyBrake || 0,
    understeerCorrecting: driver.understeerCorrecting || false,
    draftSpeedBoost: driver.slingshotActive ? arch.draftSpeedBoost : 1.0,
    archetype: arch.name,
    badge: arch.badge,
  };
}
