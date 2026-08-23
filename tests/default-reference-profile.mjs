import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ReferenceLapProfile } from '../src/telemetry/ReferenceLapProfile.js';

const path = new URL('../public/data/endurance-park-prototype-reference.json', import.meta.url);
const profile = new ReferenceLapProfile(JSON.parse(fs.readFileSync(path, 'utf8')));

assert.equal(profile.summary.complete, true, 'bundled default reference must be a complete lap');
assert.equal(profile.summary.vehicleClass, 'prototype', 'bundled default must only tune the Prototype');
assert.equal(profile.summary.lapTimeS, 64.3, 'bundled default must remain the validated 64.300 s lap');
assert.ok(profile.summary.sampleCount > 1200, 'bundled reference must retain 20 Hz driver evidence');
assert.ok(Math.abs(profile.trackLength - 3061.6501447186506) < 0.01,
  'bundled reference must match Endurance Park geometry');

console.log(JSON.stringify(profile.summary, null, 2));
