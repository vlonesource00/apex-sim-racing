import { Circuit } from '../simulation/Track.js';
import { ENDURANCE_PARK } from '../scenarios/EndurancePark.js';
import { Vehicle } from '../simulation/Vehicle.js';
import { AIController } from '../simulation/AI.js';
import { RaceState } from '../simulation/Race.js';
import { ReferenceLapRecorder } from './ReferenceLapRecorder.js';

export function runSoloAILap({ classKey = 'prototype', controllerIndex = 4, sampleHz = 20,
  maxSeconds = 300, flyingStart = true, referenceProfile = null } = {}) {
  const dt = 1 / 120;
  const track = new Circuit(ENDURANCE_PARK);
  const vehicle = new Vehicle({ id: `${classKey}-reference-benchmark`, spec: classKey });
  const vehicles = [vehicle];
  const controller = new AIController(controllerIndex);
  controller.setReferenceProfile(referenceProfile);
  const race = new RaceState(track, vehicles, flyingStart ? 2 : 1);
  const grid = race.gridPosition(0);
  vehicle.resetTo(track, grid.distance, grid.lateral);
  race.reset();
  const recorder = new ReferenceLapRecorder({ sampleHz });
  if (flyingStart) recorder.start(vehicle, track, race);
  else recorder.startImmediate(vehicle, track, race);
  let offTrackSeconds = 0;
  let maxSpeed = 0;
  for (let step = 0; step < maxSeconds / dt && !vehicle.finished; step += 1) {
    race.step(dt);
    controller.update(vehicle, vehicles, track, race, dt);
    vehicle.step(dt, track, race.phase === 'racing');
    recorder.update(dt, vehicle, track, race);
    maxSpeed = Math.max(maxSpeed, vehicle.speed);
    if (vehicle.surface?.zone === 'runoff' || vehicle.surface?.zone === 'grass') offTrackSeconds += dt;
  }
  const payload = recorder.lastExport ?? recorder.stop({ download: false, complete: vehicle.finished });
  if (payload) {
    payload.benchmark = {
      finishTimeS: race.entries.get(vehicle.id)?.finishTime ?? null,
      offTrackSeconds: Number(offTrackSeconds.toFixed(3)),
      maxSpeedKmh: Number((maxSpeed * 3.6).toFixed(1)),
      controllerIndex, flyingStart
    };
  }
  return { payload, vehicle, race, track, controller };
}
