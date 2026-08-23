import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSoloAILap } from '../src/telemetry/AILapBenchmark.js';
import { ReferenceLapProfile } from '../src/telemetry/ReferenceLapProfile.js';

const referencePath = process.argv[2];
if (!referencePath) throw new Error('Usage: node tests/human-reference-pace.mjs <reference-lap.json>');
const human = new ReferenceLapProfile(JSON.parse(fs.readFileSync(referencePath, 'utf8')));
const { payload } = runSoloAILap({ classKey: human.summary.vehicleClass, referenceProfile: human });
assert.equal(payload?.complete, true, 'AI must complete the flying lap');
assert.equal(payload.benchmark.offTrackSeconds, 0, 'reference-informed AI must remain on track');
const ai = new ReferenceLapProfile(payload);
const report = human.distanceDeltaReport(ai);
assert.ok(ai.summary.lapTimeS <= 76, `phase-one reference pace regressed: ${ai.summary.lapTimeS}s > 76s`);
assert.ok(report.bins.length >= 50, 'distance report needs enough resolution to localise losses');
console.log(JSON.stringify({ human: human.summary, ai: ai.summary, benchmark: payload.benchmark,
  lapDeltaS: report.lapDeltaS, largestLosses: report.largestLosses.slice(0, 3) }, null, 2));
