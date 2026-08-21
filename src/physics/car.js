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
    transmission: opts.transmission ?? (opts.autoShift === false ? 'manual' : 'auto'),
    autoShift: opts.autoShift !== false && opts.transmission !== 'manual',
    tcLevel: opts.tcLevel ?? 1,   // 0: Off, 1: Low, 2: High
    absLevel: opts.absLevel ?? 1, // 0: Off, 1: Low, 2: High
    tcActive: false,
    absActive: false,

    pos: new THREE.Vector3(0, 0, 0),
    heading: 0, pitch: 0, roll: 0,
    vel: new THREE.Vector3(),
    vx: 0, vy: 0, yawRate: 0,
    speed: 0, speedKph: 0,

    a, b,
    input: { throttle: 0, brake: 0, steer: 0, clutch: 0, gearRequest: 0 },
    gear: 1, rpm: s.idleRpm,
    _blipTimer: 0,
    wheels: [0, 1, 2, 3].map(() => ({
      load: 0, slipAngle: 0, slipRatio: 0, suspDefl: 0, spin: 0, omega: 0,
      onTrack: true, grip: 1, surface: 'track', fx: 0, fy: 0,
    })),

    lap: 0, progressS: 0, lastS: 0,
    lastLap: null, bestLap: null, lapStart: 0, totalTime: 0,
    finished: false, place: 0,
    damage: 0,
    surface: 'track',
    _ax: 0, _ay: 0,
    _steer: 0,
    _trackIdx: 0,
    offTrack: false,
    wallHit: 0, // decays; used for fx/sound/damage

    _loads: new Float32Array(4),
    _wvX: new Float32Array(4),
    _wvY: new Float32Array(4),
    _wheelBrakes: new Float32Array(4),
    _lastContact: { pos: new THREE.Vector3(), impact: 0 },
  };

  car.shiftUp = () => shiftUp(car);
  car.shiftDown = () => shiftDown(car);
  car.toggleTransmission = () => {
    car.transmission = car.transmission === 'auto' ? 'manual' : 'auto';
    car.autoShift = car.transmission === 'auto';
  };
  car.toggleTC = () => {
    car.tcLevel = (car.tcLevel + 1) % 3;
  };
  car.toggleABS = () => {
    car.absLevel = (car.absLevel + 1) % 3;
  };

  // Static loads
  car._staticFront = s.mass * G * s.weightDist;
  car._staticRear = s.mass * G * (1 - s.weightDist);
  return car;
}

function shiftUp(car) {
  const s = car.setup;
  const maxGears = s.gears.length;
  if (car.gear === -1) {
    car.gear = 0;
  } else if (car.gear === 0) {
    car.gear = 1;
  } else if (car.gear < maxGears) {
    car.gear++;
  }
  syncRpmAfterShift(car, false);
}

function shiftDown(car) {
  if (car.gear > 1) {
    car.gear--;
    syncRpmAfterShift(car, true);
  } else if (car.gear === 1) {
    car.gear = 0;
    syncRpmAfterShift(car, true);
  } else if (car.gear === 0) {
    car.gear = -1;
    syncRpmAfterShift(car, true);
  }
}

function syncRpmAfterShift(car, isDownshift) {
  const s = car.setup;
  const driveRear = s.driveWheels === 'rear' || s.driveWheels === 'all';
  const driveOmegaWheel = driveRear
    ? (car.wheels[2].omega + car.wheels[3].omega) / 2
    : (car.wheels[0].omega + car.wheels[1].omega) / 2;

  if (car.gear === 0) return;

  const gearRatio = car.gear === -1 ? s.reverse : (s.gears[car.gear - 1] || s.gears[0]);
  const ratioTotal = gearRatio * s.finalDrive;
  const targetRpm = Math.abs(driveOmegaWheel) * ratioTotal * (60 / TWO_PI);

  if (isDownshift) {
    // Throttle blip / rev-matching
    car.rpm = clamp(Math.max(car.rpm, targetRpm * 1.02), s.idleRpm, s.redline);
    car._blipTimer = 0.12;
  } else {
    car.rpm = clamp(targetRpm, s.idleRpm, s.redline);
    car._blipTimer = 0;
  }
}

function surfaceAt(track, car) {
  if (!track) {
    car.surface = 'track';
    car.surfaceMu = 1;
    car.offTrack = false;
    return 1;
  }
  const n = track.nearest(car.pos);
  car._trackIdx = n.idx;
  car.progressS = n.s;
  const surf = n.surface || 'track';
  const mu = (SURFACE[surf] ? SURFACE[surf].mu : 1);
  car.surface = surf;
  car.surfaceMu = mu;
  car.offTrack = surf !== 'track' && surf !== 'curb';
  return mu;
}

export function stepCar(car, track, dt) {
  const s = car.setup;
  const inp = car.input;

  // --- Gear request from input ----------------------------------------------
  if (inp.gearRequest === 1) {
    shiftUp(car);
    inp.gearRequest = 0;
  } else if (inp.gearRequest === -1) {
    shiftDown(car);
    inp.gearRequest = 0;
  }

  // --- Surface / grip -------------------------------------------------------
  const gripMul = surfaceAt(track, car);
  const rr = SURFACE[car.surface]?.rr ?? 0.01;

  // --- Steering (rate-limited actuator) ------------------------------------
  const maxSteer = s.steerLock ?? 0.48; // rad at wheel (~27.5 deg)
  const steerTarget = clamp(inp.steer, -1, 1) * maxSteer;
  const steerRate = 3.4; // rad/s (crisp steering response)
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

  const loads = car._loads;
  loads[0] = Math.max(0, Fzf / 2 - s.rollSplit * latTransfer);       // FL
  loads[1] = Math.max(0, Fzf / 2 + s.rollSplit * latTransfer);       // FR
  loads[2] = Math.max(0, Fzr / 2 - (1 - s.rollSplit) * latTransfer); // RL
  loads[3] = Math.max(0, Fzr / 2 + (1 - s.rollSplit) * latTransfer); // RR

  // --- Per-wheel kinematics -------------------------------------------------
  const halfT = s.trackWidth / 2;
  const r = car.yawRate;
  const wvX = car._wvX;
  const wvY = car._wvY;
  for (let i = 0; i < 4; i++) {
    const px = WHEEL_X[i] > 0 ? car.a : -car.b;
    const py = WHEEL_Y[i] * halfT;
    wvX[i] = car.vx - r * py;
    wvY[i] = car.vy + r * px;
  }

  const driveRear = s.driveWheels === 'rear' || s.driveWheels === 'all';
  const driveFront = s.driveWheels === 'front' || s.driveWheels === 'all';

  // --- Drivetrain & Assists -------------------------------------------------
  const driveOmegaWheel = driveRear
    ? (car.wheels[2].omega + car.wheels[3].omega) / 2
    : (car.wheels[0].omega + car.wheels[1].omega) / 2;

  // Auto shift
  const gearBefore = car.gear;
  if (car.transmission === 'auto' || car.autoShift) {
    autoShift(car);
  }

  // Blip timer countdown
  if (car._blipTimer > 0) {
    car._blipTimer = Math.max(0, car._blipTimer - dt);
  }

  // Throttle input + rev-match blip
  let rawThrottle = clamp(inp.throttle, 0, 1);
  if (car._blipTimer > 0 && car.transmission === 'manual') {
    const blipThrottle = 0.65 * (car._blipTimer / 0.12);
    rawThrottle = Math.max(rawThrottle, blipThrottle);
  }

  // Traction Control (TC)
  let tcCut = 0;
  const rearSlipAvg = (car.wheels[2].slipRatio + car.wheels[3].slipRatio) / 2;
  if (!car.offTrack && car.speed > 3.0) {
    if (car.tcLevel === 1) {
      // Low (Race): allows playful wheelspin up to 0.25, gentle torque cut
      if (rearSlipAvg > 0.25) {
        tcCut = clamp((rearSlipAvg - 0.25) / 0.25, 0, 0.30);
      }
    } else if (car.tcLevel === 2) {
      // High (Safe): intervenes above 0.15 slip, cuts up to 50%
      if (rearSlipAvg > 0.15) {
        tcCut = clamp((rearSlipAvg - 0.15) / 0.20, 0, 0.50);
      }
    }
  }
  car.tcActive = tcCut > 0.05;
  const throttle = rawThrottle * (1 - tcCut);

  const isNeutral = car.gear === 0;
  const isReverse = car.gear === -1;
  const gearRatio = isReverse ? s.reverse : isNeutral ? 0 : (s.gears[car.gear - 1] || s.gears[0]);
  const ratioTotal = gearRatio * s.finalDrive;

  if (car.gear !== gearBefore) {
    syncRpmAfterShift(car, car.gear < gearBefore);
  }

  // Engine RPM and Drivetrain coupling
  const engineTorque = s.torqueCurve(car.rpm) * throttle;
  if (isNeutral) {
    const tFric = (18 + car.rpm * 0.012) * (throttle > 0.05 ? 0.35 : 1);
    let we = (car.rpm * TWO_PI) / 60 + ((engineTorque - tFric) / (s.engineInertia ?? 0.28)) * dt;
    we = clamp(we, (s.idleRpm * TWO_PI) / 60, ((s.redline + 250) * TWO_PI) / 60);
    car.rpm = (we * 60) / TWO_PI;
  } else {
    const wheelRpm = (Math.abs(driveOmegaWheel) * ratioTotal * 60) / TWO_PI;
    if (car._blipTimer > 0) {
      // Throttle blip rev-matching smoothly decays towards wheel speed
      car.rpm = clamp(Math.max(wheelRpm, car.rpm - (car.rpm - wheelRpm) * clamp(dt * 10, 0, 1)), s.idleRpm, s.redline);
    } else {
      car.rpm = clamp(Math.max(s.idleRpm, wheelRpm), s.idleRpm, s.redline + 250);
    }
  }

  const shaftTorque = isNeutral ? 0 : isReverse ? -engineTorque * ratioTotal : engineTorque * ratioTotal;
  const drivePerWheel = ratioTotal > 0 ? shaftTorque / (s.driveWheels === 'all' ? 4 : 2) : 0;

  // Differential Locking (LSD) on Rear Axle
  let driveRL = drivePerWheel;
  let driveRR = drivePerWheel;
  if (driveRear && ratioTotal > 0) {
    const dOmega = car.wheels[2].omega - car.wheels[3].omega;
    const diffLock = s.diffLock ?? 0.65;
    const maxLock = Math.abs(drivePerWheel) * diffLock + (s.diffPreload ?? 60) * 0.5;
    const diffTq = clamp(dOmega * 60, -maxLock, maxLock);
    driveRL -= diffTq;
    driveRR += diffTq;
  }

  // --- Braking & ABS --------------------------------------------------------
  const totalBrakeTorque = (s.brakeTorqueFront + s.brakeTorqueRear) || 6400;
  const bias = s.brakeBias ?? 0.54;
  const rawBrakeFront = (inp.brake * totalBrakeTorque * bias) / 2;
  const rawBrakeRear = (inp.brake * totalBrakeTorque * (1 - bias)) / 2;

  let absCutFront = 0;
  let absCutRear = 0;
  const frontSlipAvg = (car.wheels[0].slipRatio + car.wheels[1].slipRatio) / 2;
  const rearSlipAvgBrake = (car.wheels[2].slipRatio + car.wheels[3].slipRatio) / 2;
  if (car.absLevel === 1) {
    // Low (Race): threshold braking modulation near peak grip
    if (frontSlipAvg < -0.25) absCutFront = clamp((-frontSlipAvg - 0.25) / 0.15, 0, 0.25);
    if (rearSlipAvgBrake < -0.25) absCutRear = clamp((-rearSlipAvgBrake - 0.25) / 0.15, 0, 0.25);
  } else if (car.absLevel === 2) {
    // High (Safe): prevents lockup with progressive cut
    if (frontSlipAvg < -0.15) absCutFront = clamp((-frontSlipAvg - 0.15) / 0.15, 0, 0.40);
    if (rearSlipAvgBrake < -0.15) absCutRear = clamp((-rearSlipAvgBrake - 0.15) / 0.15, 0, 0.40);
  }
  car.absActive = absCutFront > 0.05 || absCutRear > 0.05;

  const wheelBrakes = car._wheelBrakes;
  wheelBrakes[0] = rawBrakeFront * (1 - absCutFront);
  wheelBrakes[1] = rawBrakeFront * (1 - absCutFront);
  wheelBrakes[2] = rawBrakeRear * (1 - absCutRear);
  wheelBrakes[3] = rawBrakeRear * (1 - absCutRear);

  // --- Tire forces (quasi-static, friction-circle capped) ----------------------
  let Fx = 0, Fy = 0, Mz = 0;
  const lowBlend = 0.25 + 0.75 * clamp(car.speed / 4, 0, 1);
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const isFront = i < 2;
    const isDrive = (isFront && driveFront) || (!isFront && driveRear);
    const vxw = wvX[i], vyw = wvY[i];
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
    let driveForce = 0;
    if (isDrive) {
      driveForce = (i === 2 ? driveRL : i === 3 ? driveRR : drivePerWheel) / s.wheelRadius;
    }
    const brakeTq = wheelBrakes[i];
    const Freq = driveForce - Math.sign(vxw || 1) * (brakeTq / s.wheelRadius);

    const cap = Math.sqrt(Math.max(D * D - FyPure * FyPure, (0.12 * D) ** 2));
    const fx = cap * Math.tanh(Freq / cap);
    const fy = FyPure * Math.sqrt(Math.max(1 - (fx / D) ** 2, 0.04));

    w.fx = fx;
    w.fy = fy;
    // wheelspin / lockup metrics for fx, sound, rpm feel
    const excess = Math.max(0, Math.abs(Freq) - Math.abs(fx));
    w.slipRatio = Math.sign(Freq) * clamp(excess / (D + 1), 0, 1.5);
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

export function collideCars(cars, dt) {
  if (!cars || cars.length < 2) return;

  const nCars = cars.length;
  const CIRCLE_OFFSET = 1.2;
  const RAD_SUM = 1.90;
  const RAD_SUM_SQ = 3.61;
  const RESTITUTION = 0.35;

  for (let i = 0; i < nCars; i++) {
    const carA = cars[i];
    if (!carA) continue;

    for (let j = i + 1; j < nCars; j++) {
      const carB = cars[j];
      if (!carB) continue;

      // Broadphase bounding check
      const bdx = carA.pos.x - carB.pos.x;
      const bdz = carA.pos.z - carB.pos.z;
      if (bdx * bdx + bdz * bdz > 25.0) continue;

      const cosHA = Math.cos(carA.heading), sinHA = Math.sin(carA.heading);
      const cosHB = Math.cos(carB.heading), sinHB = Math.sin(carB.heading);

      const fwdAx = cosHA, fwdAz = -sinHA;
      const fwdBx = cosHB, fwdBz = -sinHB;

      const invMassA = 1 / (carA.setup?.mass || 1250);
      const invMassB = 1 / (carB.setup?.mass || 1250);
      const invInertiaA = 1 / (carA.setup?.inertiaZ || 1900);
      const invInertiaB = 1 / (carB.setup?.inertiaZ || 1900);

      // Test all 4 circle-to-circle pairs (Front/Rear of A vs Front/Rear of B)
      for (let ca = 0; ca < 2; ca++) {
        const offA = ca === 0 ? CIRCLE_OFFSET : -CIRCLE_OFFSET;
        for (let cb = 0; cb < 2; cb++) {
          const offB = cb === 0 ? CIRCLE_OFFSET : -CIRCLE_OFFSET;

          const cAx = carA.pos.x + offA * fwdAx;
          const cAz = carA.pos.z + offA * fwdAz;
          const cBx = carB.pos.x + offB * fwdBx;
          const cBz = carB.pos.z + offB * fwdBz;

          let dx = cAx - cBx;
          let dz = cAz - cBz;
          const distSq = dx * dx + dz * dz;

          if (distSq < RAD_SUM_SQ) {
            let dist = Math.sqrt(distSq);
            if (dist < 1e-5) {
              dist = 1e-5;
              dx = 1e-5;
              dz = 0;
            }

            const pen = RAD_SUM - dist;
            const nx = dx / dist;
            const nz = dz / dist;

            // De-penetration: move car A by +0.5 * pen * n and car B by -0.5 * pen * n
            const sepX = 0.5 * pen * nx;
            const sepZ = 0.5 * pen * nz;
            carA.pos.x += sepX;
            carA.pos.z += sepZ;
            carB.pos.x -= sepX;
            carB.pos.z -= sepZ;

            // Contact position
            const contactX = 0.5 * (cAx + cBx);
            const contactZ = 0.5 * (cAz + cBz);
            const contactY = (carA.pos.y + carB.pos.y) * 0.5;

            // Moment arms from CG to contact point
            const rAx = contactX - carA.pos.x;
            const rAz = contactZ - carA.pos.z;
            const rBx = contactX - carB.pos.x;
            const rBz = contactZ - carB.pos.z;

            // Relative velocity at contact point
            const vA_contact_x = carA.vel.x + carA.yawRate * rAz;
            const vA_contact_z = carA.vel.z - carA.yawRate * rAx;
            const vB_contact_x = carB.vel.x + carB.yawRate * rBz;
            const vB_contact_z = carB.vel.z - carB.yawRate * rBx;

            const v_rel_x = vA_contact_x - vB_contact_x;
            const v_rel_z = vA_contact_z - vB_contact_z;
            const v_rel_n = v_rel_x * nx + v_rel_z * nz;

            // If moving towards each other, compute and apply collision impulse
            if (v_rel_n < 0) {
              const rAxn = rAz * nx - rAx * nz;
              const rBxn = rBz * nx - rBx * nz;

              const denom = invMassA + invMassB + (rAxn * rAxn) * invInertiaA + (rBxn * rBxn) * invInertiaB;
              if (denom > 1e-6) {
                const J = -(1 + RESTITUTION) * v_rel_n / denom;

                // Apply linear impulse
                carA.vel.x += (J * invMassA) * nx;
                carA.vel.z += (J * invMassA) * nz;
                carB.vel.x -= (J * invMassB) * nx;
                carB.vel.z -= (J * invMassB) * nz;

                // Apply rotational yaw impulse (damped by ground tire scrub to prevent unnatural spins)
                const yawImpulseA = clamp((J * rAxn) * invInertiaA * 0.25, -0.35, 0.35);
                const yawImpulseB = clamp((J * rBxn) * invInertiaB * 0.25, -0.35, 0.35);
                carA.yawRate += yawImpulseA;
                carB.yawRate -= yawImpulseB;

                // Re-project world velocities back into car body frames
                carA.vx = carA.vel.x * cosHA - carA.vel.z * sinHA;
                carA.vy = -carA.vel.x * sinHA - carA.vel.z * cosHA;
                carA.speed = Math.hypot(carA.vx, carA.vy);
                carA.speedKph = carA.speed * 3.6;

                carB.vx = carB.vel.x * cosHB - carB.vel.z * sinHB;
                carB.vy = -carB.vel.x * sinHB - carB.vel.z * cosHB;
                carB.speed = Math.hypot(carB.vx, carB.vy);
                carB.speedKph = carB.speed * 3.6;
              }

              // Trigger impacts & damage
              const impact = Math.abs(v_rel_n);
              carA.wallHit = Math.max(carA.wallHit, clamp(impact / 6.0, 0, 1));
              carB.wallHit = Math.max(carB.wallHit, clamp(impact / 6.0, 0, 1));
              carA.damage = clamp(carA.damage + impact * 0.015, 0, 1);
              carB.damage = clamp(carB.damage + impact * 0.015, 0, 1);

              if (!carA._lastContact) carA._lastContact = { pos: new THREE.Vector3(), impact: 0 };
              carA._lastContact.pos.set(contactX, contactY, contactZ);
              carA._lastContact.impact = impact;

              if (!carB._lastContact) carB._lastContact = { pos: new THREE.Vector3(), impact: 0 };
              carB._lastContact.pos.set(contactX, contactY, contactZ);
              carB._lastContact.impact = impact;
            }
          }
        }
      }
    }
  }
}

