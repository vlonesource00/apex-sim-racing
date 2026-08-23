import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { ReferenceLapRecorder } from '../src/telemetry/ReferenceLapRecorder.js';

const track = new Circuit(ENDURANCE_PARK);
const vehicle = new Vehicle({ id: 'player', player: true, spec: 'prototype' });
vehicle.resetTo(track, 100, 0);
const entry = { lap: 1 };
const race = { phase: 'racing', raceTime: 10, entries: new Map([[vehicle.id, entry]]) };
const recorder = new ReferenceLapRecorder({ sampleHz: 20 });
recorder.start(vehicle, track, race);
entry.lap = 2;
recorder.update(1 / 120, vehicle, track, race);
for (let step = 0; step < 240; step += 1) {
  race.raceTime += 1 / 120;
  vehicle.controls = { throttle: 1, brake: 0, steer: 0.1, handbrake: 0 };
  vehicle.step(1 / 120, track, true);
  recorder.update(1 / 120, vehicle, track, race);
}
entry.lap = 3;
const payload = recorder.update(1 / 120, vehicle, track, race);
console.log(JSON.stringify({ complete: payload?.complete, samples: payload?.samples.length,
  durationS: payload?.durationS, fields: Object.keys(payload?.samples[0] ?? {}) }, null, 2));
assert.equal(payload.complete, true);
assert.ok(payload.samples.length >= 39 && payload.samples.length <= 41);
assert.ok(payload.samples.every((sample) => Number.isFinite(sample.s) && Number.isFinite(sample.speed)));
assert.ok(payload.samples[0].throttle > 0.9);
