import { Circuit } from '../src/simulation/Track.js';
import { HARBOR_RING } from '../src/scenarios/HarborRing.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { RaceState } from '../src/simulation/Race.js';
import { AIRaceDirector } from '../src/ai/AIRaceDirector.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

export const DT = 1 / 120;

export function makeRace(specs, laps = 1) {
  const track = new Circuit(HARBOR_RING);
  const vehicles = specs.map((spec, index) => new Vehicle({ id: `ai-${index + 1}`, spec }));
  const race = new RaceState(track, vehicles, laps);
  vehicles.forEach((vehicle, index) => {
    const grid = race.gridPosition(index);
    vehicle.resetTo(track, grid.distance, grid.lateral);
  });
  race.reset();
  race.phase = 'racing';
  for (const vehicle of vehicles) {
    const entry = race.entries.get(vehicle.id);
    entry.lastDistance = vehicle.distance;
    entry.unwrappedDistance = vehicle.distance > track.length * 0.5
      ? vehicle.distance - track.length : vehicle.distance;
  }
  return { track, vehicles, race, director: new AIRaceDirector({ track, vehicles }) };
}

export function makePlayerGrid(laps = 3) {
  const track = new Circuit(HARBOR_RING);
  const specs = ['gt', 'prototype', 'touring', 'gt', 'touring', 'prototype', 'gt', 'touring', 'prototype'];
  const vehicles = specs.map((spec, index) => new Vehicle({
    id: index === 0 ? 'player' : `ai-${index}`,
    player: index === 0,
    spec
  }));
  const race = new RaceState(track, vehicles, laps);
  vehicles.forEach((vehicle, index) => {
    const grid = race.gridPosition(index);
    vehicle.resetTo(track, grid.distance, grid.lateral);
  });
  race.reset();
  race.phase = 'racing';
  for (const vehicle of vehicles) {
    const entry = race.entries.get(vehicle.id);
    entry.lastDistance = vehicle.distance;
    entry.unwrappedDistance = vehicle.distance > track.length * 0.5
      ? vehicle.distance - track.length : vehicle.distance;
  }
  return { track, vehicles, race, director: new AIRaceDirector({ track, vehicles }) };
}

export function simulate(world, limitS, { stopWhenFinished = true, onStep = null } = {}) {
  const lastNonRecoveryPhase = new Map();
  const stats = { time: 0, contactFrames: 0, contacts: 0, maxImpact: 0,
    deepOverlaps: 0, offTrackVehicleSeconds: 0, maxSlipDeg: 0,
    minimumRacingSpeedMps: Infinity, minimumRacingSpeedState: null,
    contactPairs: {}, offTrackByVehicle: {}, maxSlipState: null, firstHighSlipState: null,
    firstOffTrackState: null };
  while (stats.time < limitS
    && (!stopWhenFinished || world.race.finishOrder.length < world.vehicles.length)) {
    world.race.step(DT);
    updateAerodynamicWakes(world.vehicles);
    const commands = world.director.step({ ...world, dt: DT });
    world.director.apply(commands, world);
    for (const vehicle of world.vehicles) {
      const activePhase = vehicle.aiTactical?.racecraftPhase;
      if (activePhase && !['TURN_AROUND', 'PHYSICAL_REJOIN', 'QUEUE_RELEASE'].includes(activePhase)) {
        lastNonRecoveryPhase.set(vehicle.id, activePhase);
      }
      vehicle.step(DT, world.track, true);
      if (vehicle.finished) continue;
      if (stats.time > 5 && !vehicle.player) {
        if (vehicle.speed < stats.minimumRacingSpeedMps) {
          const command = world.director.lastCommands.get(vehicle.id);
          stats.minimumRacingSpeedMps = vehicle.speed;
          stats.minimumRacingSpeedState = {
            distance: vehicle.distance,
            lateral: vehicle.aiTarget?.lateral,
            targetSpeed: command?.debugState?.targetSpeed,
            planSpeed: command?.plan?.targetSpeed,
            phase: command?.intent?.phase,
            curvature: command?.plan?.maxCurvaturePerM
          };
        }
      }
      const closest = world.track.closest(vehicle.position.x, vehicle.position.z, vehicle.distance);
      const zone = world.track.surfaceAt(vehicle.position.x, vehicle.position.z, closest).zone;
      if (!['road', 'curb'].includes(zone)) {
        stats.offTrackVehicleSeconds += DT;
        stats.offTrackByVehicle[vehicle.id] = (stats.offTrackByVehicle[vehicle.id] ?? 0) + DT;
        stats.firstOffTrackState ??= { id: vehicle.id, time: stats.time, speed: vehicle.speed,
          phase: vehicle.aiTactical?.racecraftPhase,
          previousPhase: lastNonRecoveryPhase.get(vehicle.id),
          distance: vehicle.distance,
          lateral: world.track.surfaceAt(vehicle.position.x, vehicle.position.z, closest).lateral };
      }
      const forward = vehicle.velocity.x * vehicle.forward.x + vehicle.velocity.z * vehicle.forward.z;
      const lateral = vehicle.velocity.x * vehicle.right.x + vehicle.velocity.z * vehicle.right.z;
      const slipDeg = Math.abs(Math.atan2(lateral, Math.max(2, Math.abs(forward)))) * 180 / Math.PI;
      if (slipDeg > 15 && !stats.firstHighSlipState) {
        stats.firstHighSlipState = { id: vehicle.id, time: stats.time, speed: vehicle.speed,
          phase: vehicle.aiTactical?.racecraftPhase, distance: vehicle.distance,
          trackLateral: closest.lateral, forward, lateralVelocity: lateral,
          yawRate: vehicle.yawRate, steer: vehicle.controls.steer,
          throttle: vehicle.controls.throttle, brake: vehicle.controls.brake };
      }
      if (slipDeg > stats.maxSlipDeg) {
        stats.maxSlipDeg = slipDeg;
        stats.maxSlipState = { id: vehicle.id, time: stats.time, speed: vehicle.speed,
          phase: vehicle.aiTactical?.racecraftPhase, distance: vehicle.distance,
          lateral: closest.lateral, forward, lateralVelocity: lateral,
          yawRate: vehicle.yawRate, steer: vehicle.controls.steer,
          throttle: vehicle.controls.throttle, brake: vehicle.controls.brake,
          escDemand: vehicle.telemetry.aiEscDemand,
          escReason: vehicle.telemetry.aiEscReason,
          escTorqueCut: vehicle.telemetry.aiEscTorqueCut };
      }
    }
    const collision = resolveVehicleCollisions(world.vehicles, 3);
    if (collision.contacts) stats.contactFrames += 1;
    stats.contacts += collision.contacts;
    stats.maxImpact = Math.max(stats.maxImpact, collision.maxImpact);
    stats.deepOverlaps += collision.deepOverlaps;
    for (const pair of collision.contactPairs) {
      const key = `${pair.a}/${pair.b}`;
      stats.contactPairs[key] = (stats.contactPairs[key] ?? 0) + 1;
    }
    onStep?.(world, stats);
    stats.time += DT;
  }
  return stats;
}
