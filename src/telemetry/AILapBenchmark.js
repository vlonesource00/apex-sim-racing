import { Circuit } from '../simulation/Track.js';
import { ENDURANCE_PARK } from '../scenarios/EndurancePark.js';
import { Vehicle } from '../simulation/Vehicle.js';
import { AIController } from '../simulation/AI.js';
import { RaceState } from '../simulation/Race.js';
import { ReferenceLapRecorder } from './ReferenceLapRecorder.js';

export function runSoloAILap({ classKey = 'prototype', controllerIndex = 4, sampleHz = 20,
  maxSeconds = 300, flyingStart = true, referenceProfile = null, referenceTuning = null } = {}) {
  const dt = 1 / 120;
  const track = new Circuit(ENDURANCE_PARK);
  const vehicle = new Vehicle({ id: `${classKey}-reference-benchmark`, spec: classKey });
  const vehicles = [vehicle];
  const controller = new AIController(controllerIndex);
  controller.setReferenceProfile(referenceProfile);
  if (referenceTuning) controller.setReferenceTuning(referenceTuning);
  const race = new RaceState(track, vehicles, flyingStart ? 2 : 1);
  const grid = race.gridPosition(0);
  vehicle.resetTo(track, grid.distance, grid.lateral);
  race.reset();
  const recorder = new ReferenceLapRecorder({ sampleHz });
  if (flyingStart) recorder.start(vehicle, track, race);
  else recorder.startImmediate(vehicle, track, race);
  let offTrackSeconds = 0;
  let maxSpeed = 0;
  let flyingStateMatched = false;
  const referenceStartSoc = referenceProfile?.timeSamples?.length
    ? referenceProfile.timeSamples[0].ersSoc : null;
  const referenceStartTyreTempC = referenceProfile?.timeSamples?.length
    ? referenceProfile.timeSamples[0].tyreTempC : null;
  const referenceStartTyreWear = referenceProfile?.timeSamples?.length
    ? referenceProfile.timeSamples[0].tyreWear : null;
  for (let step = 0; step < maxSeconds / dt && !vehicle.finished; step += 1) {
    race.step(dt);
    controller.update(vehicle, vehicles, track, race, dt);
    vehicle.step(dt, track, race.phase === 'racing');
    const wasArmed = recorder.armed;
    recorder.update(dt, vehicle, track, race);
    if (wasArmed && !recorder.armed && !flyingStateMatched) {
      // The warm-up lap exists only to produce a flying timing-line crossing.
      // Match the measured lap's finite starting energy so the comparison does
      // not silently handicap the AI with a depleted battery.
      if (vehicle.ers?.enabled && Number.isFinite(referenceStartSoc)) {
        vehicle.ers.soc = Math.max(0, Math.min(1, referenceStartSoc));
        vehicle.ers.energyJ = vehicle.ers.capacityJ * vehicle.ers.soc;
      }
      if (Number.isFinite(referenceStartTyreTempC) && Number.isFinite(referenceStartTyreWear)) {
        for (const wheel of vehicle.wheels) {
          const tyre = wheel.tyre;
          const surfaceTemp = Math.max(20, Math.min(180, referenceStartTyreTempC));
          const carcassTemp = Math.max(20, surfaceTemp - 8);
          tyre.temperatureInnerC = tyre.temperatureMiddleC = tyre.temperatureOuterC = surfaceTemp;
          tyre.carcassTemperatureC = carcassTemp;
          tyre.flashTemperatureC = surfaceTemp;
          tyre.wear = Math.max(0, Math.min(1, referenceStartTyreWear));
          const ambient = vehicle.spec.tire.ambientC ?? 22;
          const coldPressure = vehicle.spec.tire.coldPressurePa ?? 185000;
          tyre.pressurePa = coldPressure * ((carcassTemp + 273.15) / (ambient + 273.15));
          wheel.temperature = wheel.temperatureInnerC = wheel.temperatureMiddleC
            = wheel.temperatureOuterC = surfaceTemp;
          wheel.carcassTemperatureC = carcassTemp;
          wheel.pressurePa = tyre.pressurePa;
          wheel.wear = tyre.wear;
        }
      }
      flyingStateMatched = true;
    }
    maxSpeed = Math.max(maxSpeed, vehicle.speed);
    if (vehicle.surface?.zone === 'runoff' || vehicle.surface?.zone === 'grass') offTrackSeconds += dt;
  }
  const payload = recorder.lastExport ?? recorder.stop({ download: false, complete: vehicle.finished });
  if (payload) {
    payload.benchmark = {
      finishTimeS: race.entries.get(vehicle.id)?.finishTime ?? null,
      offTrackSeconds: Number(offTrackSeconds.toFixed(3)),
      maxSpeedKmh: Number((maxSpeed * 3.6).toFixed(1)),
      controllerIndex, flyingStart, referenceStartSocMatched: flyingStateMatched ? referenceStartSoc : null,
      referenceStartTyreTempCMatched: flyingStateMatched ? referenceStartTyreTempC : null,
      referenceStartTyreWearMatched: flyingStateMatched ? referenceStartTyreWear : null
    };
  }
  return { payload, vehicle, race, track, controller };
}
