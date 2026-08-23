import assert from 'node:assert/strict';
import { runSoloAILap } from '../src/telemetry/AILapBenchmark.js';
import { ReferenceLapProfile } from '../src/telemetry/ReferenceLapProfile.js';

const { payload } = runSoloAILap({ classKey: 'prototype' });
assert.equal(payload?.complete, true, 'headless AI reference lap must complete');
assert.ok(payload.samples.length > 500, 'headless AI reference lap needs useful 20 Hz coverage');
assert.equal(payload.benchmark.offTrackSeconds, 0, 'solo AI reference lap must stay on track');
const profile = new ReferenceLapProfile(payload);
assert.ok(profile.summary.lapTimeS < 79, 'baseline Prototype AI flying lap must not regress');
const pace = profile.paceAtDistance(profile.trackLength * 0.35);
assert.ok(Number.isFinite(pace.speed) && Number.isFinite(pace.envelopeSpeed), 'smoothed pace envelope must be finite');
const self = profile.distanceDeltaReport(profile);
assert.equal(self.lapDeltaS, 0);
assert.ok(self.bins.length > 40);
assert.ok(self.bins.every((bin) => bin.timeDeltaS === 0 && bin.speedDeltaKmh === 0));
console.log(JSON.stringify({ summary: profile.summary, benchmark: payload.benchmark, bins: self.bins.length }, null, 2));
