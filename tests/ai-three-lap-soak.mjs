import assert from 'node:assert/strict';
import { makeRace, simulate } from './ai-test-helpers.mjs';

const world = makeRace(['prototype', 'touring', 'gt', 'touring', 'prototype', 'gt', 'touring', 'prototype'], 3);
const stats = simulate(world, 420);
assert.equal(world.race.finishOrder.length, 8);
assert.ok(stats.contactFrames < 140, 'contact must not accumulate over the three-lap run');
assert.ok(stats.maxImpact < 7, `three-lap impact was too severe at ${stats.maxImpact.toFixed(1)} m/s`);
assert.equal(stats.offTrackVehicleSeconds, 0);
assert.equal(stats.deepOverlaps, 0);
assert.equal(world.vehicles.reduce((sum, car) => sum + car.aiMarshalRecoveries, 0), 0);
assert.ok(stats.maxSlipDeg < 30, `three-lap stability excursion ${stats.maxSlipDeg.toFixed(1)}°`);
console.log(`Three-lap Harbor soak passed: 8/8 in ${stats.time.toFixed(2)} s, ${stats.contactFrames} non-accumulating light-contact frames, no off-track or marshal use.`);
