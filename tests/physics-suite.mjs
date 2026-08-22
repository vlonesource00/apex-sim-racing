import assert from 'node:assert/strict';
import { playerSteerFromScreenAxis } from '../src/core/conventions.js';
import { KeyboardDynamics } from '../src/input/KeyboardDynamics.js';
import { carSpecFor } from '../src/simulation/CarSpecs.js';
import { createTireState, tireForces } from '../src/simulation/Tire.js';
import { Circuit } from '../src/simulation/Track.js';
import { Vehicle } from '../src/simulation/Vehicle.js';

const DT = 1 / 120;
const finite = (value, label) => assert.ok(Number.isFinite(value), `${label} must be finite`);
const settleTire = (args, spec, steps = 90) => {
  const state = createTireState(spec);
  let force;
  for (let i = 0; i < steps; i += 1) force = tireForces({ ...args, spec }, state, DT);
  return { state, force };
};

// Keyboard virtual driver: right/D remains the one sign-converted boundary,
// then response is filtered, speed-limited, and self-centres on release.
assert.equal(playerSteerFromScreenAxis(1), -1, 'D/right must remain physics-negative');
const keyboard = new KeyboardDynamics();
const keyboardVehicle = { speed: 42, localVelocity: { x: 0, z: 42 }, yawRate: 0 };
let keyboardOut;
for (let i = 0; i < 12; i += 1) keyboardOut = keyboard.update({ throttle: 1, brake: 0, steer: -1 }, keyboardVehicle, DT);
assert.ok(keyboardOut.throttle > 0.65 && keyboardOut.throttle < 0.9, 'keyboard throttle attack must be progressive');
assert.ok(keyboardOut.steer < 0 && Math.abs(keyboardOut.steer) < 0.7, 'speed-sensitive lock must limit input');
for (let i = 0; i < 90; i += 1) keyboardOut = keyboard.update({}, keyboardVehicle, DT);
assert.ok(Math.abs(keyboardOut.steer) < 0.08, 'released keyboard steering must self-centre');

const gtTire = carSpecFor('gt').tire;
const lowLoad = settleTire({ longitudinalVelocity: 28, lateralVelocity: 0, wheelAngularSpeed: 28 / 0.335 * 1.15, radius: 0.335, normalLoad: 2500, grip: 1 }, gtTire);
const highLoad = settleTire({ longitudinalVelocity: 28, lateralVelocity: 0, wheelAngularSpeed: 28 / 0.335 * 1.15, radius: 0.335, normalLoad: 5000, grip: 1 }, gtTire);
assert.ok(Math.abs(highLoad.force.fx) > Math.abs(lowLoad.force.fx), 'loaded tyre must make more total force');
assert.ok(Math.abs(highLoad.force.fx) < Math.abs(lowLoad.force.fx) * 2, 'load sensitivity must be nonlinear');
const pureCorner = settleTire({ longitudinalVelocity: 28, lateralVelocity: 3.2, wheelAngularSpeed: 28 / 0.335, radius: 0.335, normalLoad: 3300, grip: 1 }, gtTire);
const combinedCorner = settleTire({ longitudinalVelocity: 28, lateralVelocity: 3.2, wheelAngularSpeed: 28 / 0.335 * 1.22, radius: 0.335, normalLoad: 3300, grip: 1 }, gtTire);
assert.ok(Math.abs(combinedCorner.force.fy) < Math.abs(pureCorner.force.fy), 'combined slip must reduce lateral force');
for (const [key, value] of Object.entries(combinedCorner.force)) {
  if (typeof value === 'number') finite(value, `tire.${key}`);
}
const heatState = createTireState(gtTire);
const coldPressure = heatState.pressurePa;
for (let i = 0; i < 720; i += 1) {
  tireForces({ longitudinalVelocity: 31, lateralVelocity: 4.8, wheelAngularSpeed: 31 / 0.335 * 1.45, radius: 0.335, normalLoad: 3600, grip: 1, spec: gtTire }, heatState, DT);
}
assert.ok(heatState.carcassTemperatureC > gtTire.ambientC + 1, 'tire carcass must heat under sustained slip');
assert.ok(heatState.pressurePa > coldPressure, 'ideal-gas pressure must rise with tire temperature');

const track = new Circuit();
const elevations = track.samples.map((sample) => sample.y);
const banks = track.samples.map((sample) => sample.bank);
assert.ok(Math.max(...elevations) - Math.min(...elevations) > 3, 'track must have meaningful elevation');
assert.ok(Math.max(...banks) - Math.min(...banks) > 0.12, 'track must have meaningful banking');
for (const distance of [0, track.length * 0.22, track.length * 0.57, track.length * 0.91]) {
  const surface = track.surfaceAt(track.atDistance(distance).x, track.atDistance(distance).z);
  finite(surface.height, 'surface.height');
  finite(surface.normal3.x, 'surface.normal3.x');
  finite(surface.normal3.y, 'surface.normal3.y');
  finite(surface.normal3.z, 'surface.normal3.z');
  assert.ok(Math.abs(Math.hypot(surface.normal3.x, surface.normal3.y, surface.normal3.z) - 1) < 0.01, 'surface normal must be unit length');
}

// Flat handling fixture isolates force-generated yaw and sprung attitude from
// the authored circuit curvature. Positive local-X steering turns right and
// loads the left/outside wheels in this +Z-forward coordinate frame.
const flatTrack = {
  length: 1000,
  atDistance: (distance) => ({
    x: 0, y: 0, z: distance, s: distance, index: 0,
    tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 },
    normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0,
    curvature: 0, turnSign: 0, turnStrength: 0
  }),
  surfaceAt: (x, z) => ({
    x, y: 0, z, s: 0, index: 0, lateral: -x,
    tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 },
    normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0, height: 0,
    grip: 1.08, zone: 'road', barrierDepth: 0, curbHeight: 0, roughness: 0,
    roadEdge: 6.5, curbEdge: 7.55, barrierEdge: 16.05, turnStrength: 0
  }),
  updateTirePass() {}
};
const handling = new Vehicle({ id: 'handling-regression', spec: 'gt', player: true });
handling.place(0, 0, 0, handling.rideHeight);
handling.velocity.z = 22;
for (const wheel of handling.wheels) wheel.omega = handling.velocity.z / handling.wheelRadius;
let maxHandlingSlip = 0;
for (let step = 0; step < 90; step += 1) {
  handling.controls = { throttle: 0, brake: 0, steer: 0.2, handbrake: 0 };
  handling.step(DT, flatTrack, true);
  maxHandlingSlip = Math.max(maxHandlingSlip, ...handling.wheels.map((wheel) => Math.abs(wheel.slipAngle)));
}
const outsideCompression = handling.wheels[0].compression + handling.wheels[2].compression;
const insideCompression = handling.wheels[1].compression + handling.wheels[3].compression;
assert.ok(handling.yaw > 0.15, 'moderate positive steer must produce a positive integrated yaw');
assert.ok(handling.yawRate > 0, 'moderate positive steer must produce a positive yaw rate');
assert.ok(handling.speed > 14, 'moderate steer must not immediately spin or stop the car');
assert.ok(maxHandlingSlip < 1.2, 'moderate steer slip must remain finite and bounded');
assert.ok(outsideCompression > insideCompression, 'positive lateral acceleration must load the left/outside wheels');
assert.ok(handling.roll > 0, 'body roll sign must follow the loaded/outside side');
assert.ok(Math.abs(handling.roll) < 5 * Math.PI / 180, 'body roll must stay below five degrees near one-g lateral load');
for (const [key, value] of Object.entries(handling.position)) finite(value, `handling.position.${key}`);
finite(handling.yaw, 'handling.yaw');
finite(handling.yawRate, 'handling.yawRate');
finite(maxHandlingSlip, 'handling.maxSlipAngle');

const stress = new Vehicle({ id: 'stress', spec: 'gt' });
stress.resetTo(track, 0, 0);
for (let step = 0; step < 3000; step += 1) {
  const phase = step / 120;
  stress.controls.throttle = phase % 7 < 4.2 ? 0.82 : 0.1;
  stress.controls.brake = phase % 7 > 5.5 ? 0.62 : 0;
  stress.controls.steer = Math.sin(phase * 0.72) * 0.58;
  stress.controls.handbrake = 0;
  stress.step(DT, track, true);
  for (const [key, value] of Object.entries(stress.position)) finite(value, `stress.position.${key}`);
  for (const [key, value] of Object.entries(stress.velocity)) finite(value, `stress.velocity.${key}`);
  finite(stress.yaw, 'stress.yaw');
  for (const wheel of stress.wheels) {
    finite(wheel.compression, `${wheel.name}.compression`);
    finite(wheel.omega, `${wheel.name}.omega`);
    assert.ok(wheel.compression >= 0 && wheel.compression <= stress.spec.suspension.travel + 0.001, `${wheel.name} travel bounded`);
  }
}
assert.equal(stress.setTCLevel(99), 7, 'TC level upper clamp');
assert.equal(stress.setTCLevel(-4), 0, 'TC level lower clamp');
assert.equal(stress.setABSLevel(99), 7, 'ABS level upper clamp');
assert.equal(stress.setABSLevel(-4), 0, 'ABS level lower clamp');

const launchSpeed = (classKey) => {
  const vehicle = new Vehicle({ id: `launch-${classKey}`, spec: classKey });
  vehicle.resetTo(track, 0, 0);
  vehicle.setTCLevel(3);
  for (let i = 0; i < 420; i += 1) {
    vehicle.controls = { throttle: 1, brake: 0, steer: 0.025, handbrake: 0 };
    vehicle.step(DT, track, true);
  }
  return vehicle.speed;
};
const gtLaunch = launchSpeed('gt');
const prototypeLaunch = launchSpeed('prototype');
const touringLaunch = launchSpeed('touring');
assert.ok(prototypeLaunch > gtLaunch * 1.03, 'prototype must accelerate harder than GT');
assert.ok(gtLaunch > touringLaunch * 1.02, 'GT must accelerate harder than touring');
assert.ok(carSpecFor('prototype').aero.frontCl + carSpecFor('prototype').aero.rearCl > carSpecFor('gt').aero.frontCl + carSpecFor('gt').aero.rearCl, 'prototype must have higher downforce');

const metrics = {
  keyboard: { throttle: Number(keyboardOut.throttle.toFixed(3)), finalSteer: Number(keyboardOut.steer.toFixed(3)), maxLock: Number(keyboard.diagnostics.maxLock.toFixed(3)) },
  tire: { lowLoadFx: Number(lowLoad.force.fx.toFixed(0)), highLoadFx: Number(highLoad.force.fx.toFixed(0)), pureFy: Number(pureCorner.force.fy.toFixed(0)), combinedFy: Number(combinedCorner.force.fy.toFixed(0)), hotCarcassC: Number(heatState.carcassTemperatureC.toFixed(1)), hotPressureBar: Number((heatState.pressurePa / 100000).toFixed(3)) },
  track: { lengthM: Number(track.length.toFixed(1)), elevationRangeM: Number((Math.max(...elevations) - Math.min(...elevations)).toFixed(2)), bankRangeDeg: Number(((Math.max(...banks) - Math.min(...banks)) * 57.2958).toFixed(2)) },
  handling: {
    speedKmh: Number((handling.speed * 3.6).toFixed(1)),
    yawRad: Number(handling.yaw.toFixed(3)),
    yawRateRadS: Number(handling.yawRate.toFixed(3)),
    curvaturePerM: Number((handling.yawRate / Math.max(handling.speed, 0.001)).toFixed(4)),
    maxSlipAngleRad: Number(maxHandlingSlip.toFixed(3)),
    lateralG: Number(handling.telemetry.lateralG.toFixed(3)),
    rollDeg: Number((handling.roll * 180 / Math.PI).toFixed(2))
  },
  vehicle: { stressSpeedKmh: Number((stress.speed * 3.6).toFixed(1)), suspensionTravel: Number(stress.telemetry.suspensionTravel.toFixed(3)), prototypeLaunchKmh: Number((prototypeLaunch * 3.6).toFixed(1)), gtLaunchKmh: Number((gtLaunch * 3.6).toFixed(1)), touringLaunchKmh: Number((touringLaunch * 3.6).toFixed(1)) }
};
console.log(JSON.stringify(metrics, null, 2));
