import assert from 'node:assert/strict';
import { KeyboardDynamics } from '../src/input/KeyboardDynamics.js';
import { Vehicle } from '../src/simulation/Vehicle.js';

const DT = 1 / 120;

function envelope(classKey, speed) {
  const vehicle = new Vehicle({ id: `${classKey}-${speed}`, spec: classKey, player: true });
  vehicle.speed = speed;
  vehicle.localVelocity.x = 0;
  vehicle.localVelocity.z = speed;
  vehicle._aeroForces(speed);
  const keyboard = new KeyboardDynamics();
  let controls;
  for (let i = 0; i < 180; i += 1) controls = keyboard.update({ steer: 1 }, vehicle, DT);
  return {
    classKey,
    speedKmh: speed * 3.6,
    downforceN: vehicle.aero.downforceN,
    targetLateralG: keyboard.diagnostics.targetLateralAcceleration / 9.81,
    aeroContributionG: keyboard.diagnostics.aeroLateralContribution / 9.81,
    roadWheelDeg: keyboard.diagnostics.roadWheelLimit * 180 / Math.PI,
    commandRoadWheelDeg: Math.abs(controls.steer * vehicle.spec.steeringLock) * 180 / Math.PI,
    steeringReserve: keyboard.diagnostics.steeringReserve
  };
}

const results = {
  gt: envelope('gt', 55),
  prototype: envelope('prototype', 55),
  touring: envelope('touring', 55)
};

console.log(JSON.stringify(results, null, 2));
assert.ok(results.prototype.targetLateralG >= 2.7, `prototype target must exploit high-speed aero; got ${results.prototype.targetLateralG.toFixed(2)} g`);
assert.ok(results.prototype.roadWheelDeg >= 1.35, `prototype high-speed road-wheel authority collapsed to ${results.prototype.roadWheelDeg.toFixed(2)}°`);
assert.ok(results.prototype.roadWheelDeg >= results.gt.roadWheelDeg * 1.45, 'prototype must gain materially more aero-supported steering than GT');
assert.ok(results.gt.targetLateralG >= 1.5, `GT high-speed target too low: ${results.gt.targetLateralG.toFixed(2)} g`);
assert.ok(results.touring.targetLateralG <= 1.18, `touring car must not receive prototype-like aero authority: ${results.touring.targetLateralG.toFixed(2)} g`);
for (const result of Object.values(results)) {
  assert.ok(result.commandRoadWheelDeg <= result.roadWheelDeg + 1e-9, `${result.classKey} command exceeded physical envelope`);
  assert.ok(result.steeringReserve >= 0.95, `${result.classKey} healthy corner lost steering to stability reserve`);
}
