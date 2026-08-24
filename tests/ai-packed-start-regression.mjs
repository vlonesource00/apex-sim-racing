import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { RaceState } from '../src/simulation/Race.js';
import { AIController } from '../src/simulation/AI.js';
import { resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);
const classes = ['prototype', 'gt', 'touring', 'prototype', 'gt', 'touring', 'prototype', 'gt'];
const vehicles = classes.map((spec, index) => new Vehicle({ id: `launch-${index}`, spec }));
const race = new RaceState(track, vehicles, 3);
const controllers = vehicles.map((_, index) => new AIController(index + 1));
controllers.forEach((controller) => { controller.debugEnabled = true; });
const startingLanes = [];
const startingDistances = [];

vehicles.forEach((vehicle, index) => {
  const grid = race.gridPosition(index);
  vehicle.resetTo(track, grid.distance, grid.lateral);
  startingLanes.push(grid.lateral);
  startingDistances.push(grid.distance);
  controllers[index].resetForRace(vehicle);
});
race.reset();
race.phase = 'racing';
race.raceTime = 0;

let contactFrames = 0;
let brakeSamples = 0;
let launchSamples = 0;
let minimumInitialThrottle = 1;
let maximumLaneDrift = 0;

for (let step = 0; step < 1.3 / DT; step += 1) {
  for (let index = 0; index < vehicles.length; index += 1) {
    controllers[index].update(vehicles[index], vehicles, track, race, DT);
    minimumInitialThrottle = step < 6
      ? Math.min(minimumInitialThrottle, vehicles[index].controls.throttle) : minimumInitialThrottle;
    brakeSamples += vehicles[index].controls.brake > 0.2 ? 1 : 0;
    launchSamples += 1;
  }
  for (const vehicle of vehicles) vehicle.step(DT, track, true);
  const collisions = resolveVehicleCollisions(vehicles, 3);
  if (collisions.contacts > 0) contactFrames += 1;
  vehicles.forEach((vehicle, index) => {
    maximumLaneDrift = Math.max(maximumLaneDrift,
      Math.abs((vehicle.surface?.lateral ?? startingLanes[index]) - startingLanes[index]));
  });
  race.raceTime += DT;
}

const speeds = vehicles.map((vehicle) => vehicle.speed);
const meanSpeed = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
console.log(JSON.stringify({ meanSpeedMps: meanSpeed, minimumSpeedMps: Math.min(...speeds),
  minimumInitialThrottle, maximumLaneDrift, brakeDuty: brakeSamples / launchSamples, contactFrames }, null, 2));
assert.ok(minimumInitialThrottle >= 0.99, 'Every grid car must release at full throttle when its row is stable');
assert.ok(meanSpeed > 7, `Packed launch must build speed instead of choking (${meanSpeed.toFixed(2)} m/s)`);
assert.ok(Math.min(...speeds) > 5, 'No class may be left stationary by the packed-start controller');
assert.ok(maximumLaneDrift < 0.9, `Cars must hold their authored launch lanes (${maximumLaneDrift.toFixed(2)} m drift)`);
assert.ok(brakeSamples / launchSamples < 0.1, 'Normal staggered grid spacing must not trigger collective braking');
assert.equal(contactFrames, 0, 'Coordinated launch must remain contact-free');

// After launch release, cars may attack but must not collapse back toward one
// arbitrary centre line or recreate the start choke.
for (let step = 0; step < 4.7 / DT; step += 1) {
  for (let index = 0; index < vehicles.length; index += 1) {
    controllers[index].update(vehicles[index], vehicles, track, race, DT);
  }
  for (const vehicle of vehicles) vehicle.step(DT, track, true);
  const collisions = resolveVehicleCollisions(vehicles, 3);
  if (collisions.contacts > 0) contactFrames += 1;
  race.raceTime += DT;
}
const releasedSpeeds = vehicles.map((vehicle) => vehicle.speed);
const progress = vehicles.map((vehicle, index) => {
  const delta = vehicle.distance - startingDistances[index];
  return ((delta + track.length * 0.5) % track.length + track.length) % track.length - track.length * 0.5;
});
console.log(JSON.stringify({ releasedMeanSpeedMps: releasedSpeeds.reduce((sum, speed) => sum + speed, 0) / releasedSpeeds.length,
  minimumProgressM: Math.min(...progress), totalContactFrames: contactFrames,
  perCar: vehicles.map((vehicle, index) => ({ id: vehicle.id, classKey: vehicle.classKey,
    speedMps: Number(vehicle.speed.toFixed(2)), progressM: Number(progress[index].toFixed(2)),
    lateralM: Number((vehicle.surface?.lateral ?? 0).toFixed(2)),
    phase: controllers[index].debugState?.racecraftPhase,
    reason: controllers[index].debugState?.reason })) }, null, 2));
assert.ok(releasedSpeeds.reduce((sum, speed) => sum + speed, 0) / releasedSpeeds.length > 25,
  'Released pack must accelerate to racing speed');
assert.ok(Math.min(...progress) > 65, 'Every class must make meaningful launch progress');
assert.equal(contactFrames, 0, 'Launch release and first attacks must remain contact-free');
