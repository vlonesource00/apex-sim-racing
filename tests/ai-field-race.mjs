import assert from 'node:assert/strict';
import { makeRace, simulate } from './ai-test-helpers.mjs';

const world = makeRace(['prototype', 'touring', 'gt', 'touring', 'prototype', 'gt', 'touring', 'prototype']);
const stats = simulate(world, 165);
console.log(JSON.stringify(stats));
assert.equal(world.race.finishOrder.length, 8, 'all eight cars must finish the Harbor field test');
assert.ok(stats.contactFrames < 140, 'field contact must remain brief rather than become sustained rubbing');
assert.ok(stats.maxImpact < 7, `field impact was too severe at ${stats.maxImpact.toFixed(1)} m/s`);
assert.equal(stats.deepOverlaps, 0);
assert.equal(stats.offTrackVehicleSeconds, 0);
assert.ok(stats.maxSlipDeg < 30, `field stability excursion ${stats.maxSlipDeg.toFixed(1)}°`);
assert.equal(world.vehicles.reduce((sum, car) => sum + car.aiMarshalRecoveries, 0), 0);
console.log(`AI field contract passed: 8/8 in ${stats.time.toFixed(2)} s, ${stats.contactFrames} light-contact frames, zero off-track time.`);
