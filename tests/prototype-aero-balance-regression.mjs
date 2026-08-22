import assert from 'node:assert/strict';
import { KeyboardDynamics } from '../src/input/KeyboardDynamics.js';
import { Vehicle } from '../src/simulation/Vehicle.js';

const DT = 1 / 120;
const flatTrack = {
  length: 5000,
  atDistance: (s) => ({ x: 0, y: 0, z: s, s, index: 0, tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 }, normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0, curvature: 0, turnSign: 0, turnStrength: 0 }),
  surfaceAt: (x, z) => ({ x, y: 0, z, s: z, index: 0, lateral: -x, tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 }, normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0, height: 0, grip: 1.08, zone: 'road', barrierDepth: 0, curbHeight: 0, roughness: 0, roadEdge: 6.5, curbEdge: 7.55, barrierEdge: 16.05, turnStrength: 0 }),
  updateTirePass() {}
};

const settledPrototype = (speed, id) => {
  const vehicle = new Vehicle({ id, spec: 'prototype', player: true });
  vehicle.place(0, 0, 0, vehicle.rideHeight);
  vehicle.velocity.z = speed;
  vehicle.localVelocity.z = speed;
  vehicle.speed = speed;
  vehicle.gear = speed < 22 ? 2 : speed < 38 ? 3 : speed < 54 ? 4 : 5;
  const wheelOmega = speed / vehicle.wheelRadius;
  const ratio = vehicle.spec.gearRatios[vehicle.gear] * vehicle.spec.finalDrive;
  for (const wheel of vehicle.wheels) wheel.omega = wheelOmega;
  vehicle.rpm = Math.max(vehicle.spec.idleRpm, wheelOmega * ratio * 9.5493);
  vehicle.engineOmega = vehicle.rpm * Math.PI * 2 / 60;
  return vehicle;
};

const cornerProbe = (speed, brake = 0) => {
  const vehicle = settledPrototype(speed, `prototype-${speed}-${brake}`);
  const keyboard = new KeyboardDynamics();
  let preYaw = 0;
  let preBodySlip = 0;
  for (let i = 0; i < 180; i += 1) {
    vehicle.controls = keyboard.update({ steer: 0.72, throttle: 0.32 }, vehicle, DT);
    vehicle.step(DT, flatTrack, true);
    if (i >= 120) {
      preYaw = Math.max(preYaw, Math.abs(vehicle.yawRate));
      preBodySlip = Math.max(preBodySlip, Math.abs(Math.atan2(vehicle.localVelocity.x, Math.max(1, Math.abs(vehicle.localVelocity.z)))));
    }
  }
  let peakYaw = 0;
  let peakBodySlip = 0;
  let peakRearSlip = 0;
  let peakFrontSlip = 0;
  for (let i = 0; i < 120; i += 1) {
    vehicle.controls = keyboard.update({ steer: 0.72, throttle: 0, brake }, vehicle, DT);
    vehicle.step(DT, flatTrack, true);
    peakYaw = Math.max(peakYaw, Math.abs(vehicle.yawRate));
    peakBodySlip = Math.max(peakBodySlip, Math.abs(Math.atan2(vehicle.localVelocity.x, Math.max(1, Math.abs(vehicle.localVelocity.z)))));
    peakFrontSlip = Math.max(peakFrontSlip, ...vehicle.wheels.slice(0, 2).map((wheel) => Math.abs(wheel.slipAngle)));
    peakRearSlip = Math.max(peakRearSlip, ...vehicle.wheels.slice(2).map((wheel) => Math.abs(wheel.slipAngle)));
  }
  return {
    speed,
    aeroBalance: vehicle.aero.balance,
    groundEffect: vehicle.aero.groundEffect,
    preYaw,
    preBodySlipDeg: preBodySlip * 180 / Math.PI,
    peakYaw,
    peakBodySlipDeg: peakBodySlip * 180 / Math.PI,
    peakFrontSlipDeg: peakFrontSlip * 180 / Math.PI,
    peakRearSlipDeg: peakRearSlip * 180 / Math.PI,
    brakeYawGain: preYaw > 1e-4 ? peakYaw / preYaw : 0
  };
};

const sweep = [15, 35, 55].map((speed) => cornerProbe(speed));
const trailBrake = cornerProbe(35, 0.12);
console.log(JSON.stringify({ sweep, trailBrake }, null, 2));

// These broad safety assertions remain active while the tighter balance
// targets below capture the perceptual discontinuities reported in play.
for (const result of sweep) {
  assert.ok(result.peakBodySlipDeg < 10, `prototype ${result.speed} m/s corner must stay recoverable`);
  assert.ok(result.peakRearSlipDeg < 14, `prototype ${result.speed} m/s rear slip must stay bounded`);
}
assert.ok(trailBrake.peakBodySlipDeg < 10, 'light trail braking must not spin the prototype');
for (const result of sweep) {
  assert.ok(result.aeroBalance >= 0.455 && result.aeroBalance <= 0.49, `prototype aero balance must stay progressive; got ${(result.aeroBalance * 100).toFixed(1)}% front`);
}
const lowToHighYawRatio = sweep[2].peakYaw / Math.max(1e-6, sweep[0].peakYaw);
assert.ok(lowToHighYawRatio >= 0.252, `high-speed yaw response must not collapse into rigid understeer; got ${lowToHighYawRatio.toFixed(3)}`);
assert.ok(sweep[1].peakYaw >= 0.2, `mid-speed steering response still feels inert; got ${sweep[1].peakYaw.toFixed(3)} rad/s`);
assert.ok(sweep[2].peakYaw >= 0.18, `high-speed steering response still feels like a brick; got ${sweep[2].peakYaw.toFixed(3)} rad/s`);
assert.ok(trailBrake.peakYaw <= sweep[1].peakYaw * 1.14, `12% trail brake must not create a yaw spike; got ${(trailBrake.peakYaw / sweep[1].peakYaw).toFixed(2)}x coast yaw`);
