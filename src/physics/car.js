import * as THREE from 'three';
import { tirePeak, magicMag, SURFACE } from './tires.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const G = 9.81;
const TWO_PI = Math.PI * 2;

// Wheel order: 0 FL, 1 FR, 2 RL, 3 RR
const WHEEL_X = [1, 1, -1, -1]; // +front / -rear (multiplied by a or b)
const WHEEL_Y = [1, -1, 1, -1];  // +left / -right

export function createCar(setup, opts = {}) {
  const s = setup;
  const a = s.weightDist * s.wheelbase;      // CG -> front axle
  const b = s.wheelbase - a;                 // CG -> rear axle
  const car = {
    setup: s,
    id: opts.id ?? Math.random().toString(36).slice(2),
    isPlayer: !!opts.isPlayer,
    name: opts.name || 'Car',
    colorHex: opts.colorHex ?? 0xe10600,
    autoShift: opts.autoShift !== false,

    pos: new THREE.Vector3(0, 0, 0),
    heading: 0, pitch: 0, roll: 0,
    vel: new THREE.Vector3(),
    vx: 0, vy: 0, yawRate: 0,
    speed: 0, speedKph: 0,

    a, b,
    input: { throttle: 0, brake: 0, steer: 0, clutch: 0, gearRequest: 0 },
    gear: 1, rpm: s.idleRpm,
    wheels: [0, 1, 2, 3].map(() => ({
      load: 0, slipAngle: 0, slipRatio: 0, suspDefl: 0, spin: 0, omega: 0,
      onTrack: true, grip: 1, surface: 'track', fx: 0, fy: 0,
    })),

    lap: 0, progressS: 0, lastS: 0,
    lastLap: null, bestLap: null, lapStart: 0, totalTime: 0,
    finished: false, place: 0,
    damage: 0,
    surface: 'track',
    surfaceMu: 1,

    _ax: 0, _ay: 0,
    _steer: 0,
    _trackIdx: 0,
    offTrack: false,
    wallHit: 0, // decays; used for fx/sound/damage
  };
  // Static loads
  car._staticFront = s.mass * G * s.weightDist;
  car._staticRear = s.mass * G * (1 - s.weightDist);
  return car;
}

function surfaceAt(track, car) {
  if (!track) return { mu: 1, surface: 'track', lateral: 0 };
  const n = track.nearest(car.pos);
  car._trackIdx = n.idx;
  car.progressS = n.s;
  const surf = n.surface || 'track';
  const mu = (SURFACE[surf] ? SURFACE[surf].mu : 1);
  car.surface = surf;
  car.surfaceMu = mu;
  car.offTrack = surf !== 'track' && surf !== 'curb';
  return { mu, surface: surf, lateral: n.lateral, dist: n.dist };
}

export function stepCar(car, track, dt) {
  const s = car.setup;
  const inp = car.input;

  // --- Surface / grip -------------------------------------------------------
  const surf = surfaceAt(track, car);
  const rr = SURFACE[car.surface]?.rr ?? 0.01;

  // --- Steering (rate-limited actuator) ------------------------------------
  const maxSteer = 0.55; // rad at wheel
  const steerTarget = clamp(inp.steer, -1, 1) * maxSteer;
  const steerRate = 3.2; // rad/s
  car._steer += clamp(steerTarget - car._steer, -steerRate * dt, steerRate * dt);
  // Mild speed-sensitive steering ratio (stability at speed, authority retained)
  const speedSteer = 1 / (1 + car.speed * 0.008);
  const steer = car._steer * speedSteer;

  // --- Wheel loads (static + transfer using last-step accel) ---------------
  const axPrev = car._ax, ayPrev = car._ay;
  const hLat = s.cgHeight;
  const lonTransfer = (s.mass * axPrev * hLat) / s.wheelbase;
  const latTransfer = (s.mass * ayPrev * hLat) / s.trackWidth;
  let Fzf = car._staticFront - lonTransfer;
  let Fzr = car._staticRear + lonTransfer;

  // Aero downforce grows with v^2, split by axle.
  const v2 = car.speed * car.speed;
  const rho = s.dragAirDensity;
  const dfFront = 0.5 * rho * v2 * s.frontalArea * s.downforceClFront;
  const dfRear = 0.5 * rho * v2 * s.frontalArea * s.downforceClRear;
  Fzf += dfFront;
  Fzr += dfRear;

  const loads = [
    Fzf / 2 - s.rollSplit * latTransfer,       // FL
    Fzf / 2 + s.rollSplit * latTransfer,       // FR
    Fzr / 2 - (1 - s.rollSplit) * latTransfer, // RL
    Fzr / 2 + (1 - s.rollSplit) * latTransfer, // RR
  ].map((L) => Math.max(L, 0));

  // --- Per-wheel kinematics -------------------------------------------------
  const halfT = s.trackWidth / 2;
  const r = car.yawRate;
  const wv = [0, 1, 2, 3].map((i) => {
    const px = WHEEL_X[i] > 0 ? car.a : -car.b;
    const py = WHEEL_Y[i] * halfT;
    return {
      vx: car.vx - r * py,
      vy: car.vy + r * px,
    };
  });

  const driveRear = s.driveWheels === 'rear' || s.driveWheels === 'all';
  const driveFront = s.driveWheels === 'front' || s.driveWheels === 'all';

  // --- Drivetrain -------------------------------------------------------------
  const throttle = clamp(inp.throttle, 0, 1);
  const driveOmegaWheel = driveRear
    ? (car.wheels[2].omega + car.wheels[3].omega) / 2
    : (car.wheels[0].omega + car.wheels[1].omega) / 2;

  // Auto shift (snap rpm on change = clutch kick rev-match)
  const gearBefore = car.gear;
  if (car.autoShift) autoShift(car);
  const gearRatio = car.gear === -1 ? s.reverse : (s.gears[car.gear - 1] || s.gears[0]);
  const ratioTotal = gearRatio * s.finalDrive;
  if (car.gear !== gearBefore) {
    car.rpm = clamp(Math.abs(driveOmegaWheel) * ratioTotal * (60 / TWO_PI), s.idleRpm, s.redline);
  }

  // Engine speed integrated with its own inertia; clutch holds it above wheel speed.
  const engineTorque = s.torqueCurve(car.rpm) * throttle;
  const driveReactionPrev = driveRear
    ? car.wheels[2].fx + car.wheels[3].fx
    : car.wheels[0].fx + car.wheels[1].fx;
  const tLoad = (driveReactionPrev * s.wheelRadius) / ratioTotal;
  const tFric = (18 + car.rpm * 0.012) * (throttle > 0.05 ? 0.35 : 1);
  let we = (car.rpm * TWO_PI) / 60 + ((engineTorque - tLoad - tFric) / (s.engineInertia ?? 0.28)) * dt;
  we = Math.max(we, Math.abs(driveOmegaWheel) * ratioTotal);
  we = clamp(we, (s.idleRpm * TWO_PI) / 60, ((s.redline + 250) * TWO_PI) / 60);
  car.rpm = (we * 60) / TWO_PI;

  const shaftTorque = engineTorque * ratioTotal;
  const drivePerWheel = shaftTorque / (s.driveWheels === 'all' ? 4 : 2);
  const brakeFront = (inp.brake * s.brakeTorqueFront) / 2;
  const brakeRear = (inp.brake * s.brakeTorqueRear) / 2;

  // --- Tire forces (quasi-static, friction-circle capped) ----------------------
  let Fx = 0, Fy = 0, Mz = 0;
  const gripMul = surf.mu;
  const lowBlend = 0.25 + 0.75 * clamp(car.speed / 4, 0, 1);
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const isFront = i < 2;
    const isDrive = (isFront && driveFront) || (!isFront && driveRear);
    const vxw = wv[i].vx, vyw = wv[i].vy;
    const fwd = Math.max(Math.abs(vxw), 0.6);

    const slipAngle = Math.atan2(vyw, fwd) - (isFront ? steer : 0);
    w.load = loads[i];
    w.slipAngle = slipAngle;
    w.surface = car.surface;
    w.grip = gripMul;
    w.onTrack = !car.offTrack;

    const D = tirePeak(s.tire, loads[i], gripMul) * lowBlend;

    // Pure lateral from magic formula (opposes slip)
    const sy = Math.tan(clamp(slipAngle, -0.6, 0.6));
    const FyPure = -Math.sign(sy) * magicMag(s.tire, D, Math.abs(sy));

    // Requested longitudinal force (drive - brake) at the contact patch
    const brakeTq = isFront ? brakeFront : brakeRear;
    const Freq = ((isDrive ? drivePerWheel : 0) - Math.sign(vxw || 1) * brakeTq) / s.wheelRadius;

    const cap = Math.sqrt(Math.max(D * D - FyPure * FyPure, (0.12 * D) ** 2));
    const fx = cap * Math.tanh(Freq / cap);
    const fy = FyPure * Math.sqrt(Math.max(1 - (fx / D) ** 2, 0.04));

    w.fx = fx;
    w.fy = fy;
    // wheelspin / lockup metrics for fx, sound, rpm feel
    w.slipRatio = Freq > 0 ? clamp((Freq - fx) / (D + 1), 0, 1.5) : -clamp((-Freq - fx) / (D + 1), 0, 1.5);
    w.omega = (vxw * (1 - clamp(-w.slipRatio, 0, 1) * 0.95) + clamp(w.slipRatio, 0, 1.5) * 4) / s.wheelRadius;
    w.spin += w.omega * dt;

    const px = WHEEL_X[i] > 0 ? car.a : -car.b;
    const py = WHEEL_Y[i] * halfT;
    Fx += fx;
    Fy += fy;
    Mz += px * fy - py * fx;
  }

  // --- Longitudinal drag + rolling resistance on body -----------------------
  const dragForce = 0.5 * rho * v2 * s.frontalArea * s.aeroDragCd;
  const rrForce = rr * s.mass * G;
  Fx += -Math.sign(car.vx) * (dragForce + rrForce) * clamp(Math.abs(car.vx) / 2, 0, 1);

  // Damage reduces available grip slightly
  const dmgMul = 1 - clamp(car.damage, 0, 1) * 0.25;
  Fx *= dmgMul; Fy *= dmgMul;

  // --- Integrate planar dynamics -------------------------------------------
  const m = s.mass;
  const dvx = Fx / m + car.vy * r;
  const dvy = Fy / m - car.vx * r;
  const dyr = Mz / s.inertiaZ;

  car.vx += dvx * dt;
  car.vy += dvy * dt;
  car.yawRate += dyr * dt;
  // Damp yaw a touch for stability at the limit
  car.yawRate *= 1 - clamp(dt * 0.15, 0, 0.02);

  car._ax = dvx;
  car._ay = dvy + car.vx * r; // body lateral accel

  // Body-frame -> world
  const cosH = Math.cos(car.heading), sinH = Math.sin(car.heading);
  const wx = car.vx * cosH - car.vy * sinH;
  const wz = -(car.vx * sinH + car.vy * cosH);
  car.vel.set(wx, 0, wz);
  car.pos.x += wx * dt;
  car.pos.z += wz * dt;
  car.heading += r * dt;
  car.speed = Math.hypot(car.vx, car.vy);
  car.speedKph = car.speed * 3.6;

  // Ground height
  if (track) car.pos.y = track.heightAt(car.pos.x, car.pos.z);

  // --- Visual body attitude (suspension) -----------------------------------
  const pitchTarget = clamp(-car._ax * 0.012, -0.05, 0.07);
  const rollTarget = clamp(car._ay * 0.014, -0.09, 0.09);
  car.pitch += (pitchTarget - car.pitch) * clamp(dt * 7, 0, 1);
  car.roll += (rollTarget - car.roll) * clamp(dt * 7, 0, 1);

  // Suspension deflection per wheel for visuals
  for (let i = 0; i < 4; i++) {
    const target = clamp(loads[i] / 6000, 0, 1) * 0.06;
    car.wheels[i].suspDefl += (target - car.wheels[i].suspDefl) * clamp(dt * 10, 0, 1);
  }

  // --- Wall collision -------------------------------------------------------
  car.wallHit = Math.max(0, car.wallHit - dt * 3);
  if (track && track.walls) collideWalls(car, track);

  return car;
}

function autoShift(car) {
  const s = car.setup;
  const n = s.gears.length;
  if (car.gear < 1) car.gear = 1;
  if (car.rpm > s.redline * 0.985 && car.gear < n) car.gear++;
  else if (car.gear > 1) {
    const lowerRatio = s.gears[car.gear - 2];
    const rpmIfDown = car.rpm * (lowerRatio / (s.gears[car.gear - 1] || 1));
    if (car.rpm < s.redline * 0.42 && rpmIfDown < s.redline * 0.92) car.gear--;
  }
}

function collideWalls(car, track) {
  const radius = 1.05;
  const walls = track.wallsNear ? track.wallsNear(car.pos, 6) : track.walls;
  if (!walls) return;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const ax = w.a.x, az = w.a.z, bx = w.b.x, bz = w.b.z;
    const abx = bx - ax, abz = bz - az;
    const len2 = abx * abx + abz * abz;
    if (len2 < 1e-6) continue;
    let t = ((car.pos.x - ax) * abx + (car.pos.z - az) * abz) / len2;
    t = clamp(t, 0, 1);
    const cx = ax + abx * t, cz = az + abz * t;
    let dx = car.pos.x - cx, dz = car.pos.z - cz;
    const dist = Math.hypot(dx, dz);
    if (dist < radius && dist > 1e-6) {
      const nx = dx / dist, nz = dz / dist;
      const pen = radius - dist;
      car.pos.x += nx * pen;
      car.pos.z += nz * pen;
      const vn = car.vel.x * nx + car.vel.z * nz;
      if (vn < 0) {
        const restitution = 0.25;
        car.vel.x -= (1 + restitution) * vn * nx;
        car.vel.z -= (1 + restitution) * vn * nz;
        // Re-project world velocity into body frame
        const cosH = Math.cos(car.heading), sinH = Math.sin(car.heading);
        car.vx = car.vel.x * cosH - car.vel.z * sinH;
        car.vy = -car.vel.x * sinH - car.vel.z * cosH;
        const impact = -vn;
        car.damage = clamp(car.damage + impact * 0.012, 0, 1);
        car.wallHit = clamp(impact / 8, 0, 1);
        car.yawRate *= 0.85;
      }
    }
  }
}
