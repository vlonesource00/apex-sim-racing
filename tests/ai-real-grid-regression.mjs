import assert from 'node:assert/strict';
import { DT, makePlayerGrid } from './ai-test-helpers.mjs';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const world = makePlayerGrid();
const player = world.vehicles[0];
const aiCars = world.vehicles.slice(1);
const startProgress = new Map(aiCars.map((car) => [car.id,
  world.race.entries.get(car.id).unwrappedDistance]));
const phases = new Map(aiCars.map((car) => [car.id,
  { last: null, changes: 0, seen: new Set(), transitions: new Map() }]));
const passedAt = new Map();
let contactFrames = 0;
let deepOverlaps = 0;
let maxImpact = 0;
const contactPairs = new Map();
let offTrackSeconds = 0;

for (let time = 0; time < 30; time += DT) {
  player.controls = { throttle: 0, brake: 1, steer: 0, clutch: 0, gearUp: false, gearDown: false };
  world.race.step(DT);
  updateAerodynamicWakes(world.vehicles);
  const commands = world.director.step({ ...world, dt: DT });
  world.director.apply(commands, world);
  for (const vehicle of world.vehicles) {
    vehicle.step(DT, world.track, true);
    if (!vehicle.player) {
      const record = phases.get(vehicle.id);
      const phase = vehicle.aiTactical?.strategicPhase
        ?? vehicle.aiTactical?.racecraftPhase ?? 'NONE';
      record.seen.add(phase);
      if (record.last !== null && phase !== record.last) {
        record.changes += 1;
        const transition = `${record.last}->${phase}`;
        record.transitions.set(transition, (record.transitions.get(transition) ?? 0) + 1);
      }
      record.last = phase;
      const entry = world.race.entries.get(vehicle.id);
      const playerEntry = world.race.entries.get(player.id);
      if (!passedAt.has(vehicle.id) && entry.unwrappedDistance > playerEntry.unwrappedDistance + 7) {
        passedAt.set(vehicle.id, time);
      }
      const surface = world.track.surfaceAt(vehicle.position.x, vehicle.position.z);
      if (!['road', 'curb'].includes(surface.zone)) offTrackSeconds += DT;
    }
  }
  const collision = resolveVehicleCollisions(world.vehicles, 3);
  if (collision.contacts) contactFrames += 1;
  deepOverlaps += collision.deepOverlaps;
  maxImpact = Math.max(maxImpact, collision.maxImpact);
  for (const pair of collision.contactPairs) {
    const key = `${pair.a}/${pair.b}`;
    contactPairs.set(key, (contactPairs.get(key) ?? 0) + 1);
  }
}

const summary = aiCars.map((car) => {
  const entry = world.race.entries.get(car.id);
  const phase = phases.get(car.id);
  return {
    id: car.id,
    classKey: car.classKey,
    progressM: +(entry.unwrappedDistance - startProgress.get(car.id)).toFixed(1),
    speedMps: +car.speed.toFixed(1),
    passedAtS: passedAt.has(car.id) ? +passedAt.get(car.id).toFixed(1) : null,
    phaseChanges: phase.changes,
    phases: [...phase.seen],
    transitions: Object.fromEntries([...phase.transitions.entries()].sort((a, b) => b[1] - a[1]))
  };
});

const contactCounts = Object.fromEntries([...contactPairs.entries()].sort((a, b) => b[1] - a[1]));
const stoppedPlayerContactFrames = [...contactPairs.entries()]
  .filter(([key]) => key.startsWith('player/') || key.endsWith('/player'))
  .reduce((sum, [, count]) => sum + count, 0);
console.log(`AI real-grid contract: ${passedAt.size}/8 passed in ${Math.max(...passedAt.values()).toFixed(1)} s, ${contactFrames} contact frames, max impact ${maxImpact.toFixed(1)} m/s.`);

assert.equal(passedAt.size, aiCars.length, 'every AI must decisively pass a stationary player within 30 seconds');
assert.ok(Math.max(...summary.map((car) => car.phaseChanges)) <= 18,
  'tactical state must remain committed instead of changing every planner cycle');
assert.ok(summary.every((car) => car.progressM > 180), 'the grid must launch at racing speed');
assert.ok(offTrackSeconds < 1, 'stationary-car avoidance must stay on the circuit');
assert.equal(deepOverlaps, 0, 'grid combat must never produce a deep body overlap');
assert.ok(contactFrames < 280, 'grid contact must not become a sustained pile-up');
assert.ok(stoppedPlayerContactFrames < 180,
  'AI cars must pull out rather than remain against the stationary player');
assert.ok(Math.max(0, ...Object.values(contactCounts)) < 120,
  'no pair may remain locked together during a pass');
assert.ok(maxImpact < 12, `grid impact was too severe at ${maxImpact.toFixed(1)} m/s`);
assert.ok(summary.every((car) => car.passedAtS !== null && car.passedAtS < 10),
  'every AI must choose and complete a flank promptly');
