import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { RaceState } from '../src/simulation/Race.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const DT = 1 / 120;
const SIMULATION_SECONDS = 180;
const classes = ['prototype', 'gt', 'touring', 'prototype', 'gt', 'touring', 'prototype', 'gt'];
const track = new Circuit(ENDURANCE_PARK);
const vehicles = classes.map((spec, index) => new Vehicle({ id: `endurance-ai-${index + 1}`, spec }));
const controllers = new Map(vehicles.map((vehicle, index) => [vehicle.id, new AIController(index + 1)]));
const race = new RaceState(track, vehicles, 1);

vehicles.forEach((vehicle, index) => {
  const grid = race.gridPosition(index);
  vehicle.resetTo(track, grid.distance, grid.lateral);
});
race.reset();

const telemetry = new Map(vehicles.map((vehicle) => [vehicle.id, { lowSpeed: 0, offTrack: 0, maxWear: 0 }]));
let maxDeepOverlaps = 0;

for (let step = 0; step < SIMULATION_SECONDS / DT; step += 1) {
  race.step(DT);
  for (const vehicle of vehicles) controllers.get(vehicle.id).update(vehicle, vehicles, track, race, DT);
  updateAerodynamicWakes(vehicles);
  for (const vehicle of vehicles) vehicle.step(DT, track, race.phase === 'racing');
  resolveVehicleCollisions(vehicles, 3);

  let overlaps = 0;
  for (let a = 0; a < vehicles.length; a += 1) {
    for (let b = a + 1; b < vehicles.length; b += 1) {
      const contact = vehicles[a].obbContact?.(vehicles[b]);
      if (contact?.penetration > 0.18) overlaps += 1;
    }
  }
  maxDeepOverlaps = Math.max(maxDeepOverlaps, overlaps);

  if (race.phase !== 'racing' || race.raceTime < 8) continue;
  for (const vehicle of vehicles) {
    if (vehicle.finished) continue;
    const stats = telemetry.get(vehicle.id);
    if (vehicle.speed < 2) stats.lowSpeed += DT;
    if (vehicle.surface.zone === 'runoff' || vehicle.surface.zone === 'grass') stats.offTrack += DT;
    stats.maxWear = Math.max(stats.maxWear, ...vehicle.wheels.map((wheel) => wheel.wear));
  }
}

const cars = vehicles.map((vehicle) => {
  const stats = telemetry.get(vehicle.id);
  return {
    id: vehicle.id,
    classKey: vehicle.classKey,
    finished: vehicle.finished,
    finishTimeS: race.entries.get(vehicle.id).finishTime,
    lowSpeedS: Number(stats.lowSpeed.toFixed(2)),
    offTrackS: Number(stats.offTrack.toFixed(2)),
    maxWear: Number(stats.maxWear.toFixed(3)),
    marshalRecoveries: controllers.get(vehicle.id).marshalRecoveries
  };
});
const result = {
  trackLengthM: Number(track.length.toFixed(1)),
  finishers: cars.filter((car) => car.finished).length,
  maxDeepOverlaps,
  cars
};

console.log(JSON.stringify(result, null, 2));
assert.equal(result.finishers, vehicles.length, `All endurance AI must finish; got ${result.finishers}/${vehicles.length}`);
assert.ok(result.maxDeepOverlaps <= 1, `Deep collision pile-up detected: ${result.maxDeepOverlaps}`);
for (const car of cars) {
  assert.ok(car.lowSpeedS <= 8, `${car.id} spent ${car.lowSpeedS}s below 2 m/s`);
  assert.ok(car.offTrackS <= 3, `${car.id} spent ${car.offTrackS}s off track`);
  assert.ok(car.maxWear >= 0.07 && car.maxWear <= 0.24, `${car.id} wear ${car.maxWear} was not meaningful and bounded`);
}
