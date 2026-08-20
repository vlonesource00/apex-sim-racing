import { createPolicy, evaluatePolicy, loadWeights } from './nnPolicy.js';
import trainedWeightsData from './trainedWeights.json' with { type: 'json' };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const ALAT_MAX = 7.5;
const ABRAKE = 9.8;
const A_ACCEL = (v) => clamp(9.5 - v * 0.09, 2.2, 9.5);

export function computeRacingLine(track) {
  const S = track.samples;
  const n = S.length;
  const curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = S[i].dir, b = S[(i + 2) % n].dir;
    let d = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const ds = Math.max(S[(i + 2) % n].s - S[i].s, 1);
    curv[i] = Math.abs(d) / ds;
  }
  // smooth curvature
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -2; k <= 2; k++) acc += curv[(i + k + n) % n];
    sm[i] = acc / 5;
  }

  const vT = new Float32Array(n);
  for (let i = 0; i < n; i++) vT[i] = Math.min(75, Math.sqrt(ALAT_MAX / Math.max(sm[i], 1e-5)));

  // backward braking pass + forward accel pass (3 iterations)
  for (let iter = 0; iter < 3; iter++) {
    for (let i = n - 2; i >= 0; i--) {
      const ds = S[(i + 1) % n].s - S[i].s || 2;
      vT[i] = Math.min(vT[i], Math.sqrt(vT[i + 1] ** 2 + 2 * ABRAKE * Math.abs(ds)));
    }
    const wrap = Math.sqrt(vT[0] ** 2 + 2 * ABRAKE * (track.length - S[n - 1].s));
    vT[n - 1] = Math.min(vT[n - 1], wrap);
    for (let i = 0; i < n - 1; i++) {
      const ds = S[i + 1].s - S[i].s || 2;
      vT[i + 1] = Math.min(vT[i + 1], Math.sqrt(vT[i] ** 2 + 2 * A_ACCEL(vT[i]) * ds));
    }
  }

  // signed curvature (smoothed) for both line offset and steer feed-forward
  const sc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = S[i].dir, b = S[(i + 3) % n].dir;
    let d = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sc[i] = d / Math.max(S[(i + 3) % n].s - S[i].s, 1);
  }
  const scs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -6; k <= 6; k++) acc += sc[(i + k + n) % n];
    scs[i] = acc / 13;
  }

  // lateral out-in-out: hug inside in corners, centre on straights (corner-gated)
  const lat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const gate = clamp(Math.abs(scs[i]) * 90, 0, 1);   // 0 on straights, 1 in corners
    lat[i] = clamp(scs[i] * 90, -1, 1) * gate;
  }
  for (let p = 0; p < 20; p++) {
    for (let i = 0; i < n; i++) {
      lat[i] = (lat[(i - 2 + n) % n] + lat[(i - 1 + n) % n] + lat[i] * 2 + lat[(i + 1) % n] + lat[(i + 2) % n]) / 6;
    }
  }
  const maxLat = (i) => S[i].width / 2 - 1.6;
  for (let i = 0; i < n; i++) lat[i] = clamp(lat[i] * (S[i].width / 2 - 1.3), -maxLat(i), maxLat(i));

  const samples = S.map((s, i) => ({ s: s.s, lateral: lat[i], targetSpeed: vT[i] }));
  return { samples, vT, lat, curv: sm, scurv: sc };
}

export function createAiDriver(car, track, skill = 1) {
  const line = track._racingLine || (track._racingLine = computeRacingLine(track));
  const policy = createPolicy();
  if (trainedWeightsData) {
    loadWeights(policy, JSON.stringify(trainedWeightsData));
    if (trainedWeightsData.trained) policy.trained = true;
  }
  
  return {
    car, track, line, skill, policy,
    aLat: ALAT_MAX * skill,
    offset: (Math.random() - 0.5) * 1.2,
    _brakeNoise: 0.94 + Math.random() * 0.1,
  };
}

function linePoint(driver, s) {
  const { track, line } = driver;
  const t = ((s % track.length) + track.length) % track.length;
  const S = track.samples;
  let lo = 0, hi = S.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].s < t) lo = m + 1; else hi = m; }
  const i = lo, j = (i + 1) % S.length;
  const a = S[i], b = S[j];
  const f = clamp((t - a.s) / Math.max(b.s - a.s, 0.1), 0, 1);
  const latI = line.lat[i] + (line.lat[j] - line.lat[i]) * f + driver.offset;
  const px = a.pos.x + (b.pos.x - a.pos.x) * f + a.left.x * latI;
  const pz = a.pos.z + (b.pos.z - a.pos.z) * f + a.left.y * latI;
  const v = line.vT[i] + (line.vT[j] - line.vT[i]) * f;
  const k = line.scurv[i] + (line.scurv[j] - line.scurv[i]) * f;
  return { x: px, z: pz, v, k, idx: i };
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

  const v = car.speed;
  const look = 7 + v * 0.34;
  const pt = linePoint(driver, car.progressS + look);

  let yieldLat = 0, slowFactor = 1, draftMod = 1;
  let useFallback = false;
  
  const cosH = Math.cos(car.heading), sinH = Math.sin(car.heading);
  for (const o of cars) {
    if (o === car) continue;
    const dx = o.pos.x - car.pos.x, dz = o.pos.z - car.pos.z;
    const fwd = dx * cosH - dz * sinH;
    const latO = -dx * sinH - dz * cosH;
    
    // Draft / slipstream
    if (fwd > 5 && fwd < 45 && Math.abs(latO) < 2.0) {
      draftMod = 1.05; // speed boost intent from draft
    }
    
    // Side-by-side / Overtaking
    if (fwd > -4 && fwd < 26 && Math.abs(latO) < 3.2) {
      useFallback = true; // Use algorithmic for precise car avoidance
      if (fwd > 0 && o.speed < v - 1 && fwd < 18) {
        yieldLat = latO > 0 ? -1.8 : 1.8;
        if (fwd < 9 && Math.abs(latO) < 1.6) slowFactor = 0.86;
      } else if (fwd > 0 && fwd < 12) {
        yieldLat = latO > 0 ? -1.5 : 1.5;
        slowFactor = Math.min(slowFactor, clamp(o.speed / Math.max(v, 1), 0.7, 1));
      } else if (fwd > -4 && fwd <= 0) { // side by side
        yieldLat = latO > 0 ? -1.2 : 1.2;
      }
    }
  }

  // Neural Network execution (if trained policy is supplied)
  const obs = getObs(car, track, driver.line);
  if (Math.abs(obs[2]) > 1.2) useFallback = true;
  
  if (!useFallback && policy && policy.trained) {
    const action = evaluatePolicy(policy, obs);
    
    // --- Algorithmic Baseline for stabilization (acting as a safety net/blend) ---
    const avoidX = pt.x + -sinH * yieldLat;
    const avoidZ = pt.z + -cosH * yieldLat;
    const dxT = avoidX - car.pos.x, dzT = avoidZ - car.pos.z;
    const target = Math.atan2(-dzT, dxT);
    let err = target - car.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const ff = pt.k * car.setup.wheelbase / 0.45;
    const algoSteer = clamp(err * 2.2 - car.yawRate * 0.10 + ff, -1, 1);
    
    let vTarg = pt.v * driver._brakeNoise * slowFactor * skill * draftMod;
    const ahead2 = linePoint(driver, car.progressS + look + 20);
    vTarg = Math.min(vTarg, Math.sqrt(ahead2.v ** 2 + 2 * ABRAKE * 20) * slowFactor * skill * draftMod);
    const dv = vTarg - v;
    let algoThrottle = 0, algoBrake = 0;
    if (dv > 0.5) { algoThrottle = clamp(dv * 0.35, 0.25, 1); }
    else if (dv < -0.5) { algoBrake = clamp(-dv * 0.22, 0.15, 1); }
    else { algoThrottle = 0.3; }

    const blend = 0.2;
    car.input.steer = clamp(algoSteer * (1 - blend) + action.steer * blend, -1, 1);
    car.input.throttle = clamp((algoThrottle * (1 - blend) + action.throttle * blend) * skill * draftMod, 0, 1);
    car.input.brake = clamp((algoBrake * (1 - blend) + action.brake * blend) * (2 - skill), 0, 1);
    return;
  }

  // --- Algorithmic Fallback ---
  const avoidX = pt.x + -sinH * yieldLat;
  const avoidZ = pt.z + -cosH * yieldLat;
  const dxT = avoidX - car.pos.x, dzT = avoidZ - car.pos.z;
  const target = Math.atan2(-dzT, dxT);
  let err = target - car.heading;
  while (err > Math.PI) err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  
  const ff = pt.k * car.setup.wheelbase / 0.45;
  const steer = clamp(err * 2.2 - car.yawRate * 0.10 + ff, -1, 1);
  car.input.steer = steer;

  // target speed with brake lookahead, scaled by skill
  let vTarg = pt.v * driver._brakeNoise * slowFactor * skill * draftMod;
  const ahead2 = linePoint(driver, car.progressS + look + 20);
  vTarg = Math.min(vTarg, Math.sqrt(ahead2.v ** 2 + 2 * ABRAKE * 20) * slowFactor * skill * draftMod);

  const dv = vTarg - v;
  if (dv > 0.5) { car.input.throttle = clamp(dv * 0.35, 0.25, 1); car.input.brake = 0; }
  else if (dv < -0.5) { car.input.throttle = 0; car.input.brake = clamp(-dv * 0.22, 0.15, 1); }
  else { car.input.throttle = 0.3; car.input.brake = 0; }

  const spin = Math.max(car.wheels[2].slipRatio, car.wheels[3].slipRatio);
  if (spin > 0.12) car.input.throttle *= 0.6;
}
