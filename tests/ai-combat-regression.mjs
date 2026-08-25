import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { HARBOR_RING } from '../src/scenarios/HarborRing.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { RaceState } from '../src/simulation/Race.js';
import { AIRaceDirector } from '../src/ai/AIRaceDirector.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const DT = 1 / 120;

const setMotion = (vehicle, track, distance, lateral, speed) => {
  vehicle.resetTo(track, distance, lateral);
  const point = track.atDistance(distance);
  vehicle.velocity.x = point.tangent.x * speed;
  vehicle.velocity.z = point.tangent.z * speed;
  vehicle.speed = speed;
};

const makeWorld = (specs, playerIndices = []) => {
  const track = new Circuit(HARBOR_RING);
  const vehicles = specs.map((spec, index) => new Vehicle({
    id: `combat-${index}`,
    spec,
    player: playerIndices.includes(index)
  }));
  const race = new RaceState(track, vehicles, 1);
  race.reset();
  race.phase = 'racing';
  race.raceTime = 12;
  return { track, vehicles, race, director: new AIRaceDirector({ track, vehicles }) };
};

const synchronizeProgress = (world) => {
  for (const vehicle of world.vehicles) {
    const entry = world.race.entries.get(vehicle.id);
    entry.lastDistance = vehicle.distance;
    entry.unwrappedDistance = vehicle.distance;
  }
};

const runForcedPass = (classKey, blockerSide) => {
  const world = makeWorld([classKey, 'touring'], [1]);
  const [attacker, blocker] = world.vehicles;
  const lateral = blockerSide * 3;
  setMotion(attacker, world.track, 600, lateral, classKey === 'gt' ? 24 : 16);
  setMotion(blocker, world.track, 624, lateral, classKey === 'gt' ? 16 : 8);
  synchronizeProgress(world);

  const phases = new Set();
  const attackSides = new Set();
  let passTime = null;
  let minimumSpeed = Infinity;
  let towSeconds = 0;
  let contactFrames = 0;
  let maxImpact = 0;
  for (let time = 0; time < 7 && passTime === null; time += DT) {
    blocker.controls = { throttle: 0, brake: 0.08, steer: 0 };
    world.race.step(DT);
    updateAerodynamicWakes(world.vehicles);
    const commands = world.director.step({ ...world, dt: DT });
    world.director.apply(commands, world);
    for (const vehicle of world.vehicles) vehicle.step(DT, world.track, true);
    const command = commands.get(attacker.id);
    phases.add(command.intent.phase);
    if (command.intent.attackSide) attackSides.add(command.intent.attackSide);
    if (command.intent.phase === 'SLIPSTREAM_TOW') towSeconds += DT;
    minimumSpeed = Math.min(minimumSpeed, attacker.speed);
    const collision = resolveVehicleCollisions(world.vehicles, 3);
    if (collision.contacts) contactFrames += 1;
    maxImpact = Math.max(maxImpact, collision.maxImpact);
    const attackerProgress = world.race.entries.get(attacker.id).unwrappedDistance;
    const blockerProgress = world.race.entries.get(blocker.id).unwrappedDistance;
    if (attackerProgress > blockerProgress + 7) passTime = time;
  }
  return { classKey, blockerSide, passTime, minimumSpeed, towSeconds,
    contactFrames, maxImpact, phases, attackSides };
};

for (const classKey of ['gt', 'touring']) {
  for (const blockerSide of [-1, 1]) {
    const result = runForcedPass(classKey, blockerSide);
    assert.ok(result.passTime !== null && result.passTime < 3.5,
      `${classKey} failed to complete the ${blockerSide < 0 ? 'right' : 'left'}-flank pass`);
    assert.ok(result.minimumSpeed > (classKey === 'gt' ? 15 : 12.5),
      `${classKey} collapsed to ${result.minimumSpeed.toFixed(1)} m/s during a clear-flank pass`);
    assert.ok(result.towSeconds < 1.2, `${classKey} remained trapped in the tow`);
    assert.ok(result.phases.has('SIDE_BY_SIDE'), `${classKey} never established wheel-to-wheel overlap`);
    assert.ok(result.attackSides.has(-blockerSide), `${classKey} did not use the open flank`);
    assert.ok(result.contactFrames <= 4 && result.maxImpact < 2,
      `${classKey} pass made avoidable contact`);
  }
}

const runParallelCombat = (classKey) => {
  const world = makeWorld([classKey, 'gt'], [1]);
  const [attacker, rival] = world.vehicles;
  const speed = classKey === 'gt' ? 22 : 17;
  const lateralSeparation = attacker.collisionHalfWidth + rival.collisionHalfWidth + 0.22;
  setMotion(attacker, world.track, 700, -lateralSeparation * 0.5, speed);
  setMotion(rival, world.track, 700.4, lateralSeparation * 0.5, speed);
  synchronizeProgress(world);

  const agent = world.director.agents.get(attacker.id);
  agent.attack = {
    targetId: rival.id,
    offset: attacker.surface.lateral,
    originLateral: attacker.surface.lateral,
    side: -1,
    phase: 'SIDE_BY_SIDE',
    overlapSeen: true,
    obstacle: false,
    urgentPass: false,
    age: 0,
    maxAge: 9
  };

  let minimumSpeed = Infinity;
  let maximumBrake = 0;
  let sideBySideFrames = 0;
  let managedFrames = 0;
  let hardFrames = 0;
  let contactFrames = 0;
  for (let time = 0; time < 1.5; time += DT) {
    rival.controls = { throttle: 0.42, brake: 0, steer: 0 };
    world.race.step(DT);
    updateAerodynamicWakes(world.vehicles);
    const commands = world.director.step({ ...world, dt: DT });
    world.director.apply(commands, world);
    for (const vehicle of world.vehicles) vehicle.step(DT, world.track, true);
    const command = commands.get(attacker.id);
    minimumSpeed = Math.min(minimumSpeed, attacker.speed);
    maximumBrake = Math.max(maximumBrake, command.controls.brake);
    if (command.intent.phase === 'SIDE_BY_SIDE') sideBySideFrames += 1;
    if (command.trajectory?.collisionResponse === 'MANAGED') managedFrames += 1;
    if (command.trajectory?.collisionResponse === 'HARD') hardFrames += 1;
    const collision = resolveVehicleCollisions(world.vehicles, 3);
    if (collision.contacts) contactFrames += 1;
  }
  return { classKey, speed, minimumSpeed, maximumBrake, sideBySideFrames,
    managedFrames, hardFrames, contactFrames };
};

for (const classKey of ['gt', 'touring']) {
  const result = runParallelCombat(classKey);
  assert.ok(result.sideBySideFrames > 120,
    `${classKey} held wheel-to-wheel combat for only ${result.sideBySideFrames} frames`);
  assert.ok(result.managedFrames > 75 && result.hardFrames < 12,
    `${classKey} treated a physically clear parallel car as a hard collision`);
  assert.ok(result.maximumBrake < 0.12,
    `${classKey} fear-braked at ${(result.maximumBrake * 100).toFixed(0)}% beside a clear car`);
  assert.ok(result.minimumSpeed > result.speed - 1,
    `${classKey} surrendered momentum in parallel combat`);
  assert.equal(result.contactFrames, 0, `${classKey} leaned on the parallel rival`);
}

const defenseWorld = makeWorld(['gt', 'prototype']);
const [defender, challenger] = defenseWorld.vehicles;
setMotion(defender, defenseWorld.track, 820, 0, 22);
setMotion(challenger, defenseWorld.track, 800, -1.2, 29);
synchronizeProgress(defenseWorld);
const defensePhases = new Set();
const defenseOffsets = [];
let defenseSeconds = 0;
let challengerPassed = false;
let defenseContacts = 0;
for (let time = 0; time < 5; time += DT) {
  defenseWorld.race.step(DT);
  updateAerodynamicWakes(defenseWorld.vehicles);
  const commands = defenseWorld.director.step({ ...defenseWorld, dt: DT });
  defenseWorld.director.apply(commands, defenseWorld);
  for (const vehicle of defenseWorld.vehicles) vehicle.step(DT, defenseWorld.track, true);
  const command = commands.get(defender.id);
  defensePhases.add(command.intent.phase);
  if (command.intent.mode === 'DEFEND') {
    defenseSeconds += DT;
    defenseOffsets.push(command.intent.targetLaneOffsetM);
  }
  const collision = resolveVehicleCollisions(defenseWorld.vehicles, 3);
  if (collision.contacts) defenseContacts += 1;
  challengerPassed ||= defenseWorld.race.entries.get(challenger.id).unwrappedDistance
    > defenseWorld.race.entries.get(defender.id).unwrappedDistance + 7;
}

assert.ok(defenseSeconds > 4.5, 'defender failed to commit to the defensive corridor');
assert.ok(defensePhases.has('DOOR_SHUT') && defensePhases.has('EXIT_SQUEEZE'),
  'defender failed to close the door and protect the exit');
assert.ok(Math.max(...defenseOffsets) - Math.min(...defenseOffsets) < 0.05,
  'defender violated its one-move lane lock');
assert.equal(challengerPassed, false, 'defense failed to retain the position');
assert.equal(defenseContacts, 0, 'defense must succeed without leaning on the attacker');

console.log('AI combat regression passed: GT/Touring dual-flank passes and locked door/exit defense.');
