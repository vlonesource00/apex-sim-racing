import assert from 'node:assert/strict';
import { RaceSnapshot } from '../src/ai/RaceSnapshot.js';
import { TrackIntelligence } from '../src/ai/TrackIntelligence.js';
import { makeRace, DT } from './ai-test-helpers.mjs';

const world = makeRace(['prototype', 'gt']);
const snapshot = RaceSnapshot.capture({ ...world, tick: 0 });
assert.ok(Object.isFrozen(snapshot.states) && snapshot.states.every(Object.isFrozen));
assert.equal(snapshot.states.length, 2);
assert.equal(TrackIntelligence.for(world.track), TrackIntelligence.for(world.track));
const commands = world.director.step({ ...world, dt: DT });
assert.equal(commands.size, 2);
for (const command of commands.values()) {
  assert.equal(command.plan.points.length, 24);
  assert.equal(command.plan.roadLegal, true);
  assert.ok(command.plan.points.every((point) => Object.values(point)
    .filter((value) => typeof value === 'number').every(Number.isFinite)));
}
world.director.apply(commands, world);
assert.ok(world.vehicles.every((vehicle) => vehicle.aiTactical.source === 'HEURISTIC_RACE_DIRECTOR'));
console.log('AI core contract passed: immutable exact state, shared track model, deterministic plans.');
