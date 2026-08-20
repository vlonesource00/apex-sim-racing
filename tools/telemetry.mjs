// Headless physics validation. Runs scripted maneuvers and prints numbers a
// sim-literate critic can judge (0-100, top speed, braking G, lateral G, lap time).
import { buildTrack } from '../src/track/trackBuilder.js';
import alpineDef from '../src/track/defs/alpine.js';
import { createCar, stepCar } from '../src/physics/car.js';
import { getSetup } from '../src/physics/setups.js';

const DT = 1 / 240;
const track = buildTrack(alpineDef);

function newCar() {
  const c = createCar(getSetup('gt3'), { isPlayer: true });
  const s0 = track.sampleAt(track.startS);
  c.pos.set(s0.pos.x, s0.pos.y, s0.pos.z);
  c.heading = Math.atan2(-s0.dir.y, s0.dir.x);
  return c;
}

// --- 1. acceleration --------------------------------------------------------
{
  const c = newCar();
  c.input.throttle = 1;
  let t0 = null, t100 = null, t200 = null;
  for (let t = 0; t < 40; t += DT) {
    stepCar(c, track, DT);
    if (t0 === null && c.speedKph > 1) t0 = t;
    if (t100 === null && c.speedKph >= 100) t100 = t - t0;
    if (t200 === null && c.speedKph >= 200) { t200 = t - t0; break; }
  }
  console.log(`ACCEL 0-100: ${t100?.toFixed(2)}s  0-200: ${t200?.toFixed(2)}s`);
}

// --- 2. top speed on long straight ------------------------------------------
{
  const c = newCar();
  c.input.throttle = 1;
  let vmax = 0;
  for (let t = 0; t < 60; t += DT) {
    stepCar(c, track, DT);
    vmax = Math.max(vmax, c.speedKph);
    if (c.offTrack) break;
  }
  console.log(`TOP SPEED: ${vmax.toFixed(0)} km/h (offTrack=${c.offTrack})`);
}

// --- 3. braking from 200 ------------------------------------------------------
{
  const c = newCar();
  c.input.throttle = 1;
  let braking = false, v0 = 0, t0 = 0, minG = 0, dist = 0;
  for (let t = 0; t < 60; t += DT) {
    stepCar(c, track, DT);
    if (!braking && c.speedKph >= 200) { braking = true; c.input.throttle = 0; c.input.brake = 1; v0 = c.speed; t0 = t; }
    if (braking) {
      minG = Math.min(minG, c._ax / -9.81);
      dist += c.speed * DT;
      if (c.speedKph < 5) { console.log(`BRAKE 200-5: ${(t - t0).toFixed(2)}s, ${dist.toFixed(0)}m, peak ${minG.toFixed(2)}g`); break; }
    }
  }
}

// --- 4. steady-state lateral G (constant steer sweep) ------------------------
{
  const c = newCar();
  c.input.throttle = 0.5;
  let maxG = 0;
  for (let t = 0; t < 12; t += DT) {
    c.input.steer = Math.min(0.5, 0.08 + t * 0.02);
    if (c.speedKph > 120) c.input.throttle = 0.35;
    stepCar(c, track, DT);
    const g = Math.hypot(c._ay, 0) / 9.81;
    if (t > 4) maxG = Math.max(maxG, Math.abs(c._ay) / 9.81);
  }
  console.log(`LATERAL peak |ay|: ${maxG.toFixed(2)}g`);
}

// --- 5. autopilot lap ---------------------------------------------------------
{
  const c = newCar();
  let lapT = 0, laps = 0, off = 0, maxSlip = 0;
  let lastS = c.progressS;
  const curvAt = (s) => {
    const a = track.sampleAt(s + 4).dir;
    const b = track.sampleAt(s + 24).dir;
    let d = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) / 20;
  };
  for (let t = 0; t < 200; t += DT) {
    const curv = Math.max(curvAt(c.progressS), curvAt(c.progressS + 10));
    const vTarget = Math.min(75, Math.sqrt((11.5) / Math.max(curv, 1e-4)));
    const ahead = track.sampleAt(c.progressS + 6 + c.speed * 0.35);
    const dx = ahead.pos.x - c.pos.x, dz = ahead.pos.z - c.pos.z;
    const target = Math.atan2(-dz, dx);
    let err = target - c.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    c.input.steer = Math.max(-1, Math.min(1, err * 2.2 + c.yawRate * -0.08));
    if (c.speed < vTarget) { c.input.throttle = 0.9; c.input.brake = 0; }
    else { c.input.throttle = 0; c.input.brake = Math.min(1, (c.speed - vTarget) * 0.35); }
    stepCar(c, track, DT);
    maxSlip = Math.max(maxSlip, ...c.wheels.map((w) => Math.abs(w.slipAngle)));
    if (c.offTrack) off += DT;
    if (c.progressS < lastS - track.length / 2) { laps++; lapT = t; break; }
    lastS = c.progressS;
  }
  console.log(`LAP: ${lapT.toFixed(2)}s  offtrack=${off.toFixed(2)}s  maxSlipAngle=${(maxSlip * 57.3).toFixed(1)}deg`);
}
