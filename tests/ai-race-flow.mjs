import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { RaceState } from '../src/simulation/Race.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const FIXED_TIMESTEP = 1 / 120;
const SIMULATION_SECONDS = 180;
const WARMUP_SECONDS = 8;
const STALL_SPEED = 2;
const STALL_LIMIT_SECONDS = 8;
const COLLISION_RADIUS = 2.8;
const DEEP_OVERLAP_PENETRATION = 0.18;

const track = new Circuit();
const player = new Vehicle({ id: 'player', name: 'Idle Player', color: '#e85038', player: true });
const aiCars = Array.from({ length: 8 }, (_, index) => new Vehicle({ id: `ai-${index + 1}`, name: `AI ${index + 1}`, color: '#ffffff' }));
const vehicles = [player, ...aiCars];
const controllers = new Map(aiCars.map((vehicle, index) => [vehicle.id, new AIController(index + 1)]));
for (const controller of controllers.values()) controller.setDebugEnabled(true);
const race = new RaceState(track, vehicles, 3);

for (const [index, vehicle] of vehicles.entries()) {
  const grid = race.gridPosition(index);
  vehicle.resetTo(track, grid.distance, grid.lateral);
}
race.reset();

const telemetry = new Map(aiCars.map((vehicle) => [vehicle.id, {
  belowTwoSeconds: 0,
  belowTwoRunSeconds: 0,
  maxBelowTwoRunSeconds: 0,
  belowTwoReasons: {},
  firstStall: null,
  offTrackSeconds: 0,
  recoverySeconds: 0,
  deadlockSeconds: 0,
  maxDeadlockSeconds: 0,
  sampledSpeeds: [],
  postFinishSeconds: 0,
  postFinishOffTrackSeconds: 0,
  postFinishOffTrackStops: 0
}]));
let deepOverlapSeconds = 0;
let maxSimultaneousDeepOverlaps = 0;

for (let step = 0; step < SIMULATION_SECONDS / FIXED_TIMESTEP; step += 1) {
  race.step(FIXED_TIMESTEP);
  player.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  for (const vehicle of aiCars) controllers.get(vehicle.id).update(vehicle, vehicles, track, race, FIXED_TIMESTEP);
  updateAerodynamicWakes(vehicles);
  for (const vehicle of vehicles) vehicle.step(FIXED_TIMESTEP, track, race.phase === 'racing');
  resolveVehicleCollisions(vehicles, 3);
  let deepOverlaps = 0;
  if (race.phase === 'racing') {
    for (let a = 0; a < vehicles.length; a += 1) {
      if (vehicles[a].finished || vehicles[a].despawned) continue;
      for (let b = a + 1; b < vehicles.length; b += 1) {
        if (vehicles[b].finished || vehicles[b].despawned) continue;
        const contact = vehicles[a].obbContact?.(vehicles[b]);
        if (contact?.penetration > DEEP_OVERLAP_PENETRATION) deepOverlaps += 1;
      }
    }
  }
  maxSimultaneousDeepOverlaps = Math.max(maxSimultaneousDeepOverlaps, deepOverlaps);
  deepOverlapSeconds = deepOverlaps > 0 ? deepOverlapSeconds + FIXED_TIMESTEP : 0;

  if (race.phase !== 'racing' || race.raceTime <= WARMUP_SECONDS) continue;
  for (const vehicle of aiCars) {
    const stats = telemetry.get(vehicle.id);
    if (vehicle.finished) {
      if (!vehicle.despawned) {
        stats.postFinishSeconds += FIXED_TIMESTEP;
        const offTrack = vehicle.surface.zone === 'runoff' || vehicle.surface.zone === 'grass';
        if (offTrack) stats.postFinishOffTrackSeconds += FIXED_TIMESTEP;
        if (offTrack && vehicle.speed < STALL_SPEED) stats.postFinishOffTrackStops += FIXED_TIMESTEP;
      }
      continue;
    }
    if (vehicle.speed < STALL_SPEED) {
      stats.belowTwoSeconds += FIXED_TIMESTEP;
      stats.belowTwoRunSeconds += FIXED_TIMESTEP;
      stats.maxBelowTwoRunSeconds = Math.max(stats.maxBelowTwoRunSeconds, stats.belowTwoRunSeconds);
      const debug = controllers.get(vehicle.id).debugState;
      const reason = `${debug?.mode ?? 'UNKNOWN'}:${debug?.reason ?? 'UNKNOWN'}`;
      stats.belowTwoReasons[reason] = (stats.belowTwoReasons[reason] ?? 0) + FIXED_TIMESTEP;
      stats.firstStall ??= { timeS: Number(race.raceTime.toFixed(2)), distanceM: Number(vehicle.distance.toFixed(1)),
        speedKmh: Number((vehicle.speed * 3.6).toFixed(1)), throttle: Number((vehicle.controls.throttle ?? 0).toFixed(2)),
        brake: Number((vehicle.controls.brake ?? 0).toFixed(2)), desiredSpeed: Number((debug?.desiredSpeed ?? -1).toFixed(2)),
        reason, hazardId: debug?.hazardId ?? null, closeFront: debug?.closeFront ?? null };
    } else stats.belowTwoRunSeconds = 0;
    if (vehicle.surface.zone === 'runoff' || vehicle.surface.zone === 'grass') stats.offTrackSeconds += FIXED_TIMESTEP;
    if (controllers.get(vehicle.id).recovery > 0) stats.recoverySeconds += FIXED_TIMESTEP;
    stats.sampledSpeeds.push(vehicle.speed);
    const blocked = vehicle.speed < STALL_SPEED && vehicles.some((other) => other !== vehicle && !other.finished && Math.hypot(other.position.x - vehicle.position.x, other.position.z - vehicle.position.z) < COLLISION_RADIUS);
    stats.deadlockSeconds = blocked ? stats.deadlockSeconds + FIXED_TIMESTEP : 0;
    stats.maxDeadlockSeconds = Math.max(stats.maxDeadlockSeconds, stats.deadlockSeconds);
  }
}

const allSpeeds = [...telemetry.values()].flatMap((stats) => stats.sampledSpeeds).sort((a, b) => a - b);
const kmh = (value) => Number((value * 3.6).toFixed(1));
const perCar = aiCars.map((vehicle) => {
  const stats = telemetry.get(vehicle.id);
  return {
    id: vehicle.id,
    finished: vehicle.finished,
    lap: race.entries.get(vehicle.id).lap,
    speedKmh: kmh(vehicle.speed),
    zone: vehicle.surface.zone,
      belowTwoSeconds: Number(stats.belowTwoSeconds.toFixed(2)),
      maxBelowTwoRunSeconds: Number(stats.maxBelowTwoRunSeconds.toFixed(2)),
      belowTwoReasons: Object.fromEntries(Object.entries(stats.belowTwoReasons)
        .sort((a, b) => b[1] - a[1]).map(([reason, seconds]) => [reason, Number(seconds.toFixed(2))])),
      firstStall: stats.firstStall,
    offTrackSeconds: Number(stats.offTrackSeconds.toFixed(2)),
    recoverySeconds: Number(stats.recoverySeconds.toFixed(2)),
    marshalRecoveries: controllers.get(vehicle.id).marshalRecoveries,
    maxDeadlockSeconds: Number(stats.maxDeadlockSeconds.toFixed(2)),
    postFinishSeconds: Number(stats.postFinishSeconds.toFixed(2)),
    postFinishOffTrackSeconds: Number(stats.postFinishOffTrackSeconds.toFixed(2)),
    postFinishOffTrackStops: Number(stats.postFinishOffTrackStops.toFixed(2))
  };
});
const result = {
  simulatedSeconds: SIMULATION_SECONDS,
  raceSeconds: Number(race.raceTime.toFixed(2)),
  aiFinishers: aiCars.filter((vehicle) => vehicle.finished).length,
  totalFinishers: vehicles.filter((vehicle) => vehicle.finished).length,
  stallers: perCar.filter((car) => car.maxBelowTwoRunSeconds > STALL_LIMIT_SECONDS).map((car) => car.id),
  collisionDeadlocks: perCar.filter((car) => car.maxDeadlockSeconds > STALL_LIMIT_SECONDS).map((car) => car.id),
  postFinishCoverageFailures: perCar.filter((car) => car.postFinishSeconds < 10).map((car) => car.id),
  postFinishOffTrackCars: perCar.filter((car) => car.postFinishOffTrackSeconds > 0 || car.postFinishOffTrackStops > 0).map((car) => car.id),
  offTrackSeconds: Number(perCar.reduce((sum, car) => sum + car.offTrackSeconds, 0).toFixed(2)),
  recoverySeconds: Number(perCar.reduce((sum, car) => sum + car.recoverySeconds, 0).toFixed(2)),
  deepOverlapSeconds: Number(deepOverlapSeconds.toFixed(2)),
  maxSimultaneousDeepOverlaps,
  minimumActiveSpeedKmh: kmh(allSpeeds[0] ?? 0),
  medianActiveSpeedKmh: kmh(allSpeeds[Math.floor(allSpeeds.length / 2)] ?? 0),
  cars: perCar
};

console.log(JSON.stringify(result, null, 2));
assert.ok(result.aiFinishers >= 8, `Expected at least 8/8 AI finishers; got ${result.aiFinishers}`);
assert.deepEqual(result.stallers, [], `Avoidable low-speed stalls: ${result.stallers.join(', ')}`);
assert.deepEqual(result.collisionDeadlocks, [], `Active-car collision deadlocks: ${result.collisionDeadlocks.join(', ')}`);
assert.deepEqual(result.postFinishCoverageFailures, [], `Need at least 10 s post-finish telemetry: ${result.postFinishCoverageFailures.join(', ')}`);
assert.deepEqual(result.postFinishOffTrackCars, [], `Post-finish off-track behavior: ${result.postFinishOffTrackCars.join(', ')}`);
assert.ok(result.deepOverlapSeconds <= 1, `Sustained deep overlap: ${result.deepOverlapSeconds}s`);
assert.ok(result.maxSimultaneousDeepOverlaps <= 2, `Too many simultaneous deep overlaps: ${result.maxSimultaneousDeepOverlaps}`);
