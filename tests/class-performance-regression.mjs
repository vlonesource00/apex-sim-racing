import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { RaceState } from '../src/simulation/Race.js';

const DT = 1 / 120;

function representativeLap(classKey) {
  const track = new Circuit(ENDURANCE_PARK);
  const car = new Vehicle({ id: `${classKey}-benchmark`, spec: classKey });
  const vehicles = [car];
  const controller = new AIController(4);
  const race = new RaceState(track, vehicles, 1);
  const grid = race.gridPosition(0);
  car.resetTo(track, grid.distance, grid.lateral);
  race.reset();
  let maxSpeed = 0;
  let maxWear = 0;
  let offTrackSeconds = 0;
  for (let step = 0; step < 240 / DT && !car.finished; step += 1) {
    race.step(DT);
    controller.update(car, vehicles, track, race, DT);
    car.step(DT, track, race.phase === 'racing');
    maxSpeed = Math.max(maxSpeed, car.speed);
    maxWear = Math.max(maxWear, ...car.wheels.map((wheel) => wheel.wear));
    if (car.surface.zone === 'runoff' || car.surface.zone === 'grass') offTrackSeconds += DT;
  }
  return {
    classKey,
    finished: car.finished,
    lapTimeS: race.entries.get(car.id).finishTime,
    maxSpeedKmh: maxSpeed * 3.6,
    maxWear,
    offTrackSeconds
  };
}

const results = Object.fromEntries(['gt', 'prototype', 'touring'].map((key) => [key, representativeLap(key)]));
for (const result of Object.values(results)) {
  assert.equal(result.finished, true, `${result.classKey} must finish the representative lap`);
  assert.ok(result.maxWear >= 0.08 && result.maxWear <= 0.22, `${result.classKey} one-lap degradation must be strategically meaningful and bounded`);
  assert.ok(result.offTrackSeconds <= 0.75, `${result.classKey} benchmark left the racing surface for ${result.offTrackSeconds.toFixed(2)} s`);
}
assert.ok(results.prototype.lapTimeS <= results.gt.lapTimeS * 0.90, 'prototype must be at least 10% quicker than GT');
assert.ok(results.gt.lapTimeS <= results.touring.lapTimeS * 0.94, 'GT must be materially quicker than touring');
assert.ok(results.prototype.maxSpeedKmh >= results.gt.maxSpeedKmh + 15, 'prototype boost/top-speed advantage must be visible');

console.log(JSON.stringify(results, null, 2));
