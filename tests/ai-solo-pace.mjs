import assert from 'node:assert/strict';
import { makeRace, simulate } from './ai-test-helpers.mjs';

const gates = { prototype: 80, gt: 98, touring: 118 };
const minimumCornerSpeed = { prototype: 11, gt: 10, touring: 7 };
for (const spec of Object.keys(gates)) {
  const world = makeRace([spec]);
  const stats = simulate(world, gates[spec]);
  assert.equal(world.vehicles[0].finished, true, `${spec} missed ${gates[spec]} s pace gate`);
  assert.equal(stats.offTrackVehicleSeconds, 0, `${spec} left the legal circuit`);
  assert.equal(world.vehicles[0].aiMarshalRecoveries, 0, `${spec} invoked the emergency marshal`);
  assert.ok(stats.maxSlipDeg < 30, `${spec} stability excursion ${stats.maxSlipDeg.toFixed(1)}°`);
  assert.ok(stats.minimumRacingSpeedMps >= minimumCornerSpeed[spec],
    `${spec} crawled at ${stats.minimumRacingSpeedMps.toFixed(1)} m/s`);
  console.log(`${spec}: ${stats.time.toFixed(2)} s, minimum ${stats.minimumRacingSpeedMps.toFixed(1)} m/s, maximum slip ${stats.maxSlipDeg.toFixed(1)}°`);
}
