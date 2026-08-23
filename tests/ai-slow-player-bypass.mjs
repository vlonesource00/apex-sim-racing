import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);

const setForwardSpeed = (vehicle, speed) => {
  vehicle.velocity.x = vehicle.forward.x * speed;
  vehicle.velocity.z = vehicle.forward.z * speed;
};

const runScenario = ({ label, playerSpeed }) => {
  const player = new Vehicle({ id: `${label}-player`, player: true, spec: 'touring' });
  const attacker = new Vehicle({ id: `${label}-attacker`, spec: 'prototype' });
  player.resetTo(track, 118, 0);
  attacker.resetTo(track, 90, 0);
  setForwardSpeed(player, playerSpeed);
  setForwardSpeed(attacker, 28);

  const controller = new AIController(1);
  controller.setDebugEnabled(true);
  const vehicles = [player, attacker];
  const race = {
    phase: 'racing', raceTime: 10, elapsed: 10,
    statusFor: (vehicle) => ({ position: vehicle === player ? 1 : 2 })
  };

  let contactFrames = 0;
  let deepOverlapFrames = 0;
  let offTrackSeconds = 0;
  let draftSeconds = 0;
  let attackSeconds = 0;
  let completedAt = null;
  let minimumSeparation = Infinity;

  for (let step = 0; step < 22 / DT; step += 1) {
    race.raceTime += DT;
    race.elapsed += DT;
    setForwardSpeed(player, playerSpeed);
    player.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    controller.update(attacker, vehicles, track, race, DT);
    updateAerodynamicWakes(vehicles);
    if (playerSpeed > 0) player.step(DT, track, true);
    attacker.step(DT, track, true);
    const collision = resolveVehicleCollisions(vehicles, 3);
    if (collision.contacts > 0) contactFrames += 1;
    if (collision.deepOverlaps > 0) deepOverlapFrames += 1;
    minimumSeparation = Math.min(minimumSeparation,
      Math.hypot(attacker.position.x - player.position.x, attacker.position.z - player.position.z));
    if (attacker.surface?.zone === 'grass' || attacker.surface?.zone === 'runoff') offTrackSeconds += DT;
    if (controller.debugState?.racecraftPhase === 'DRAFT') draftSeconds += DT;
    if (['ATTACK_INSIDE', 'ATTACK_OUTSIDE', 'DIVE_INSIDE', 'SWITCHBACK']
      .includes(controller.debugState?.racecraftPhase)) attackSeconds += DT;
    if (completedAt === null && attacker.distance > player.distance + 4) completedAt = race.raceTime;
  }

  return {
    label,
    playerSpeedKph: Number((playerSpeed * 3.6).toFixed(1)),
    completed: completedAt !== null,
    completedAtS: completedAt === null ? null : Number(completedAt.toFixed(2)),
    contactFrames,
    deepOverlapFrames,
    offTrackSeconds: Number(offTrackSeconds.toFixed(2)),
    draftSeconds: Number(draftSeconds.toFixed(2)),
    attackSeconds: Number(attackSeconds.toFixed(2)),
    minimumSeparationM: Number(minimumSeparation.toFixed(3)),
    finalGapM: Number((attacker.distance - player.distance).toFixed(2)),
    finalPhase: controller.debugState?.racecraftPhase
  };
};

const results = [
  runScenario({ label: 'stopped', playerSpeed: 0 }),
  runScenario({ label: 'crawling', playerSpeed: 4 }),
  runScenario({ label: 'slow-driving', playerSpeed: 12 })
];

console.log(JSON.stringify(results, null, 2));
for (const result of results) {
  assert.ok(result.completed, `${result.label}: AI must turn out and pass the slow player`);
  assert.ok(result.attackSeconds > 0.25, `${result.label}: AI must enter a deliberate pass state`);
  assert.ok(result.draftSeconds < 1.5, `${result.label}: slow player must not be treated as a draft target`);
  assert.equal(result.contactFrames, 0, `${result.label}: bypass must be contact-free`);
  assert.equal(result.deepOverlapFrames, 0, `${result.label}: bypass must never overlap`);
  assert.equal(result.offTrackSeconds, 0, `${result.label}: bypass must remain on legal road`);
}
