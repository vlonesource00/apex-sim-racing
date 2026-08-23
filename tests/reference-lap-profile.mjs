import assert from 'node:assert/strict';
import { ReferenceLapProfile } from '../src/telemetry/ReferenceLapProfile.js';

const makeLap = (durationS, speedScale = 1) => ({
  schemaVersion: 1, kind: 'apex73-reference-lap', complete: true,
  vehicleClass: 'prototype', trackLengthM: 1000, sampleHz: 20, durationS,
  samples: Array.from({ length: 100 }, (_, index) => ({
    t: durationS * index / 99, s: index * 10, speed: (30 + Math.sin(index / 8) * 8) * speedScale,
    throttle: index % 20 < 15 ? 1 : 0, brake: index % 20 >= 17 ? 0.5 : 0,
    tyreUtilisation: 0.82
  }))
});

const baseline = new ReferenceLapProfile(makeLap(80));
assert.equal(baseline.summary.lapTimeS, 80);
assert.equal(baseline.summary.sampleCount, 100);
assert.ok(baseline.targetAtDistance(1002).distanceErrorM <= 2);
const comparison = baseline.compare(makeLap(84, 0.95));
assert.equal(comparison.lapDeltaS, 4);
assert.ok(comparison.pacePct > 95 && comparison.pacePct < 96);
assert.ok(comparison.meanSpeedDeltaKmh < 0);
console.log(JSON.stringify({ summary: baseline.summary, comparison }, null, 2));
