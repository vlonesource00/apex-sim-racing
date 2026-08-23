import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);
const defender = new Vehicle({ id: 'clean-defender', spec: 'touring' });
const attacker = new Vehicle({ id: 'clean-attacker', spec: 'prototype' });
defender.resetTo(track, 118, 0.35);
attacker.resetTo(track, 96, -0.35);

const setForwardSpeed = (vehicle, speed) => {
  vehicle.velocity.x = vehicle.forward.x * speed;
  vehicle.velocity.z = vehicle.forward.z * speed;
};
setForwardSpeed(defender, 24);
setForwardSpeed(attacker, 30);

const defenderAI = new AIController(2);
const attackerAI = new AIController(1);
defenderAI.setDebugEnabled(true);
attackerAI.setDebugEnabled(true);
const vehicles = [defender, attacker];
const race = {
  phase: 'racing', raceTime: 10, elapsed: 10,
  statusFor: (vehicle) => ({ position: vehicle === defender ? 1 : 2 })
};

let contactFrames = 0;
let deepOverlapFrames = 0;
let maxImpact = 0;
let draftSeconds = 0;
let attackSeconds = 0;
let attackFullThrottleSeconds = 0;
let maxAttackLateralSeparation = 0;
let completedAt = null;
let minimumSeparation = Infinity;
let offTrackSeconds = 0;
let firstContact = null;
const phaseEvents = [];
let lastPhase = null;

for (let step = 0; step < 18 / DT; step += 1) {
  race.raceTime += DT;
  race.elapsed += DT;
  defenderAI.update(defender, vehicles, track, race, DT);
  attackerAI.update(attacker, vehicles, track, race, DT);
  updateAerodynamicWakes(vehicles);
  defender.step(DT, track, true);
  attacker.step(DT, track, true);
  const collision = resolveVehicleCollisions(vehicles, 3);
  if (collision.contacts > 0) contactFrames += 1;
  if (collision.contacts > 0 && firstContact === null) {
    firstContact = {
      time: Number(race.raceTime.toFixed(2)),
      attackerDistance: Number(attacker.distance.toFixed(2)),
      defenderDistance: Number(defender.distance.toFixed(2)),
      attackerLateral: Number((attacker.surface?.lateral ?? 0).toFixed(2)),
      defenderLateral: Number((defender.surface?.lateral ?? 0).toFixed(2)),
      attackerKph: Number((attacker.speed * 3.6).toFixed(1)),
      defenderKph: Number((defender.speed * 3.6).toFixed(1)),
      phase: attackerAI.debugState?.racecraftPhase,
      throttle: Number(attacker.controls.throttle.toFixed(2)),
      brake: Number(attacker.controls.brake.toFixed(2)),
      defenderMode: defenderAI.debugState?.mode,
      defenderReason: defenderAI.debugState?.reason,
      defenderTargetOffset: Number((defenderAI.debugState?.targetOffset ?? 0).toFixed(2)),
      defenderSteer: Number(defender.controls.steer.toFixed(2))
    };
  }
  if (collision.deepOverlaps > 0) deepOverlapFrames += 1;
  maxImpact = Math.max(maxImpact, collision.maxImpact);
  minimumSeparation = Math.min(minimumSeparation,
    Math.hypot(attacker.position.x - defender.position.x, attacker.position.z - defender.position.z));
  if (attacker.surface?.zone === 'grass' || attacker.surface?.zone === 'runoff') offTrackSeconds += DT;
  const debug = attackerAI.debugState;
  if (debug?.racecraftPhase !== lastPhase) {
    lastPhase = debug?.racecraftPhase;
    phaseEvents.push({ time: Number(race.raceTime.toFixed(2)), phase: lastPhase,
      gap: Number((defender.distance - attacker.distance).toFixed(2)),
      attackerLateral: Number((attacker.surface?.lateral ?? 0).toFixed(2)),
      defenderLateral: Number((defender.surface?.lateral ?? 0).toFixed(2)) });
  }
  if (debug?.mode === 'DRAFT') draftSeconds += DT;
  if (debug?.mode === 'PASS') {
    attackSeconds += DT;
    if (attacker.controls.throttle > 0.9) attackFullThrottleSeconds += DT;
    maxAttackLateralSeparation = Math.max(maxAttackLateralSeparation,
      Math.abs((attacker.surface?.lateral ?? 0) - (defender.surface?.lateral ?? 0)));
  }
  if (completedAt === null && attacker.distance > defender.distance + 4) completedAt = race.raceTime;
}

const result = {
  completed: completedAt !== null,
  completedAtS: completedAt === null ? null : Number(completedAt.toFixed(2)),
  contactFrames,
  deepOverlapFrames,
  maxImpact: Number(maxImpact.toFixed(3)),
  minimumSeparationM: Number(minimumSeparation.toFixed(3)),
  draftSeconds: Number(draftSeconds.toFixed(2)),
  attackSeconds: Number(attackSeconds.toFixed(2)),
  attackFullThrottleSeconds: Number(attackFullThrottleSeconds.toFixed(2)),
  maxAttackLateralSeparationM: Number(maxAttackLateralSeparation.toFixed(2)),
  offTrackSeconds: Number(offTrackSeconds.toFixed(2)),
  finalGapM: Number((attacker.distance - defender.distance).toFixed(2)),
  attackerDistanceM: Number(attacker.distance.toFixed(2)),
  defenderDistanceM: Number(defender.distance.toFixed(2)),
  attackerKph: Number((attacker.speed * 3.6).toFixed(1)),
  defenderKph: Number((defender.speed * 3.6).toFixed(1)),
  finalPhase: attackerAI.debugState?.racecraftPhase,
  firstContact,
  phaseEvents
};

console.log(JSON.stringify(result, null, 2));
assert.ok(result.completed, 'the faster prototype must complete the overtake');
assert.ok(result.attackSeconds > 0.25, 'the attacker must execute a deliberate pass phase');
assert.equal(result.contactFrames, 0, 'the controlled overtake must be contact-free');
assert.equal(result.deepOverlapFrames, 0, 'the controlled overtake must never overlap');
assert.equal(result.offTrackSeconds, 0, 'the controlled overtake must remain on the road');
assert.ok(result.finalGapM > 4, 'the attacker must establish clear race progress after passing');
