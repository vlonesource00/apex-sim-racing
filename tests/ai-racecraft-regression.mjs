import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { RaceState } from '../src/simulation/Race.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);
const classes = ['touring', 'prototype', 'gt', 'touring', 'prototype', 'gt'];
const vehicles = classes.map((spec, index) => new Vehicle({ id: `racecraft-${index + 1}`, name: `RC${index + 1}`, spec }));
const controllers = new Map(vehicles.map((vehicle, index) => {
  const controller = new AIController(index + 1);
  controller.setDebugEnabled(true);
  return [vehicle.id, controller];
}));
const race = new RaceState(track, vehicles, 2);
vehicles.forEach((vehicle, index) => {
  const grid = race.gridPosition(index);
  vehicle.resetTo(track, grid.distance, grid.lateral);
});
race.reset();

const telemetry = new Map(vehicles.map((vehicle) => [vehicle.id, {
  straightSamples: 0, straightFullThrottle: 0, straightThrottle: 0, maxStraightSpeed: 0,
  closeFrontSamples: 0, passSamples: 0, switchbackSamples: 0, avoidSamples: 0,
  spinSamples: 0, offTrackSamples: 0, positionChanges: 0, lastPosition: null
}]));

for (let step = 0; step < 260 / DT; step += 1) {
  race.step(DT);
  for (const vehicle of vehicles) controllers.get(vehicle.id).update(vehicle, vehicles, track, race, DT);
  updateAerodynamicWakes(vehicles);
  for (const vehicle of vehicles) vehicle.step(DT, track, race.phase === 'racing');
  resolveVehicleCollisions(vehicles, 3);
  if (race.phase !== 'racing' || race.raceTime < 6) continue;
  for (const vehicle of vehicles) {
    if (vehicle.finished) continue;
    const stats = telemetry.get(vehicle.id);
    const debug = controllers.get(vehicle.id).debugState;
    const curvature = track.atDistance(vehicle.distance + Math.max(20, vehicle.speed * 0.65)).curvature;
    if (curvature < 0.0028 && vehicle.surface?.zone === 'road') {
      stats.straightSamples += 1;
      stats.straightThrottle += vehicle.controls.throttle;
      if (vehicle.controls.throttle > 0.92) stats.straightFullThrottle += 1;
      stats.maxStraightSpeed = Math.max(stats.maxStraightSpeed, vehicle.speed);
    }
    if (debug?.closeFront) stats.closeFrontSamples += 1;
    if (debug?.mode === 'PASS') stats.passSamples += 1;
    if (/SWITCHBACK/.test(debug?.reason ?? '')) stats.switchbackSamples += 1;
    if (debug?.mode === 'AVOID') stats.avoidSamples += 1;
    const bodySlip = Math.atan2(vehicle.localVelocity?.x ?? 0, Math.max(3, Math.abs(vehicle.localVelocity?.z ?? vehicle.speed)));
    if (Math.abs(bodySlip) > 0.45 && Math.abs(vehicle.yawRate) > 2.2) stats.spinSamples += 1;
    if (vehicle.surface?.zone === 'grass' || vehicle.surface?.zone === 'runoff') stats.offTrackSamples += 1;
    const position = race.positionFor(vehicle);
    if (stats.lastPosition !== null && position !== stats.lastPosition) stats.positionChanges += 1;
    stats.lastPosition = position;
  }
}

const report = vehicles.map((vehicle) => {
  const stats = telemetry.get(vehicle.id);
  const sampleSeconds = (samples) => Number((samples * DT).toFixed(2));
  return {
    id: vehicle.id, classKey: vehicle.classKey, finished: vehicle.finished,
    lap: race.entries.get(vehicle.id).lap, finalSpeedKmh: Number((vehicle.speed * 3.6).toFixed(1)),
    finishTimeS: Number((race.entries.get(vehicle.id).finishTime ?? 0).toFixed(2)),
    straightFullThrottlePct: Number((100 * stats.straightFullThrottle / Math.max(1, stats.straightSamples)).toFixed(1)),
    meanStraightThrottle: Number((stats.straightThrottle / Math.max(1, stats.straightSamples)).toFixed(3)),
    maxStraightKmh: Number((stats.maxStraightSpeed * 3.6).toFixed(1)),
    closeFrontS: sampleSeconds(stats.closeFrontSamples), passS: sampleSeconds(stats.passSamples),
    switchbackS: sampleSeconds(stats.switchbackSamples), avoidS: sampleSeconds(stats.avoidSamples),
    unstableS: sampleSeconds(stats.spinSamples), offTrackS: sampleSeconds(stats.offTrackSamples),
    positionChanges: stats.positionChanges, marshalRecoveries: controllers.get(vehicle.id).marshalRecoveries
  };
});
console.log(JSON.stringify(report, null, 2));

assert.equal(report.filter((car) => car.finished).length, vehicles.length, 'the whole field must finish');
assert.ok(report.filter((car) => car.passS > 2).length >= 4, 'mixed-class traffic must produce committed passing attempts');
assert.ok(report.filter((car) => car.switchbackS > 0.4).length >= 1, 'blocked cars must attempt a live switchback/cutback move');
assert.ok(report.reduce((sum, car) => sum + car.straightFullThrottlePct, 0) / report.length >= 82, 'field must use full throttle on clean straights');
for (const car of report) {
  assert.ok(car.unstableS <= 2.5, `${car.id} spent ${car.unstableS}s in a severe spin state`);
  assert.ok(car.offTrackS <= 8, `${car.id} spent ${car.offTrackS}s off track`);
  assert.ok(car.marshalRecoveries <= 3, `${car.id} needed ${car.marshalRecoveries} marshal recoveries`);
}
