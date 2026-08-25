import assert from 'node:assert/strict';
import { RaceSnapshot } from '../src/ai/RaceSnapshot.js';
import { makeRace } from './ai-test-helpers.mjs';

const setMotion = (vehicle, track, distance, lateral, speed) => {
  vehicle.resetTo(track, distance, lateral);
  const point = track.atDistance(distance);
  vehicle.velocity.x = point.tangent.x * speed;
  vehicle.velocity.z = point.tangent.z * speed;
  vehicle.speed = speed;
};

const attackWorld = makeRace(['prototype', 'gt']);
attackWorld.race.raceTime = 12;
setMotion(attackWorld.vehicles[0], attackWorld.track, 200, 0, 28);
setMotion(attackWorld.vehicles[1], attackWorld.track, 222, 0, 0);
let snapshot = RaceSnapshot.capture({ ...attackWorld, tick: 0 });
const attacker = attackWorld.director.agents.get('ai-1');
const attack = attacker.tacticalIntents(snapshot, attackWorld.director.trackModel);
const attackSides = new Set(attack.filter((entry) => entry.mode === 'PASS').map((entry) => entry.attackSide));
assert.deepEqual([...attackSides].sort(), [-1, 1], 'stopped traffic must be attackable on both flanks');
assert.ok(attack.some((entry) => entry.phase === 'OBSTACLE_BYPASS'
  || entry.reason.startsWith('OBSTACLE_BYPASS')));

const defenseWorld = makeRace(['gt', 'prototype']);
defenseWorld.race.raceTime = 12;
setMotion(defenseWorld.vehicles[0], defenseWorld.track, 350, 0, 24);
setMotion(defenseWorld.vehicles[1], defenseWorld.track, 330, -2.5, 32);
const defender = defenseWorld.director.agents.get('ai-1');
snapshot = RaceSnapshot.capture({ ...defenseWorld, tick: 0 });
const firstDefense = defender.tacticalIntents(snapshot, defenseWorld.director.trackModel)[0];
assert.equal(firstDefense.mode, 'DEFEND');
setMotion(defenseWorld.vehicles[1], defenseWorld.track, 334, 2.5, 32);
snapshot = RaceSnapshot.capture({ ...defenseWorld, tick: 1 });
const lockedDefense = defender.tacticalIntents(snapshot, defenseWorld.director.trackModel)[0];
assert.equal(lockedDefense.terminalLateral, firstDefense.terminalLateral,
  'single-move defense must remain locked when the attacker changes sides');

const launchWorld = makeRace(['gt', 'gt']);
launchWorld.race.raceTime = 1;
snapshot = RaceSnapshot.capture({ ...launchWorld, tick: 0 });
const launch = launchWorld.director.agents.get('ai-1')
  .tacticalIntents(snapshot, launchWorld.director.trackModel);
assert.ok(launch.some((entry) => entry.phase === 'OPENING_LEFT'));
assert.ok(launch.some((entry) => entry.phase === 'OPENING_RIGHT'));

const recoveryWorld = makeRace(['touring']);
setMotion(recoveryWorld.vehicles[0], recoveryWorld.track, 500, recoveryWorld.track.roadHalfWidth + 3, 5);
snapshot = RaceSnapshot.capture({ ...recoveryWorld, tick: 0 });
const recovery = recoveryWorld.director.agents.get('ai-1')
  .tacticalIntents(snapshot, recoveryWorld.director.trackModel)[0];
assert.equal(recovery.mode, 'RECOVER');
assert.equal(recovery.marshalRequested, false);
console.log('AI racecraft contract passed: dual-flank bypass, locked defense, launch openings, physical recovery.');
