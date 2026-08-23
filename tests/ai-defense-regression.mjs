import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);
const leader = new Vehicle({ id: 'defense-leader', spec: 'gt' });
const challenger = new Vehicle({ id: 'defense-challenger', spec: 'gt' });
leader.resetTo(track, 132, 0);
challenger.resetTo(track, 112, 0);

const setSpeed = (vehicle, speed) => {
  vehicle.velocity.x = vehicle.forward.x * speed;
  vehicle.velocity.z = vehicle.forward.z * speed;
};
setSpeed(leader, 25);
setSpeed(challenger, 31);

const leaderAI = new AIController(2);
const challengerAI = new AIController(1);
leaderAI.setDebugEnabled(true);
challengerAI.setDebugEnabled(true);
const vehicles = [leader, challenger];
const race = { phase: 'racing', raceTime: 10, elapsed: 10,
  statusFor: (vehicle) => ({ position: vehicle === leader ? 1 : 2 }) };

let defenseSeconds = 0;
let firstDefenseGap = null;
let defenseOffset = null;
let contactFrames = 0;
let offTrackSeconds = 0;
let lateralReversals = 0;
let priorDirection = 0;

for (let step = 0; step < 10 / DT; step += 1) {
  race.raceTime += DT;
  race.elapsed += DT;
  leaderAI.update(leader, vehicles, track, race, DT);
  challengerAI.update(challenger, vehicles, track, race, DT);
  updateAerodynamicWakes(vehicles);
  for (const vehicle of vehicles) vehicle.step(DT, track, true);
  const collision = resolveVehicleCollisions(vehicles, 3);
  if (collision.contacts) contactFrames += 1;
  if (vehicles.some((vehicle) => vehicle.surface?.zone === 'grass' || vehicle.surface?.zone === 'runoff')) offTrackSeconds += DT;

  if (leaderAI.debugState?.mode === 'DEFEND') {
    defenseSeconds += DT;
    firstDefenseGap ??= leader.distance - challenger.distance;
    defenseOffset ??= leaderAI.debugState.targetOffset;
    const direction = Math.sign(leaderAI.debugState.targetOffset);
    if (priorDirection && direction && direction !== priorDirection) lateralReversals += 1;
    if (direction) priorDirection = direction;
  }
}

const result = {
  defenseSeconds: Number(defenseSeconds.toFixed(2)),
  firstDefenseGapM: Number((firstDefenseGap ?? -1).toFixed(2)),
  defenseOffsetM: Number((defenseOffset ?? 0).toFixed(2)),
  lateralReversals, contactFrames,
  offTrackSeconds: Number(offTrackSeconds.toFixed(2)),
  finalGapM: Number((leader.distance - challenger.distance).toFixed(2)),
  leaderMode: leaderAI.debugState?.mode,
  challengerMode: challengerAI.debugState?.mode
};

console.log(JSON.stringify(result, null, 2));
assert.ok(result.defenseSeconds > 0.35, 'leader must deliberately defend a closing challenger');
assert.ok(result.firstDefenseGapM > 8, 'defensive move must happen before overlap');
assert.ok(Math.abs(result.defenseOffsetM) > 1.5, 'defense must close a meaningful part of the inside lane');
assert.equal(result.lateralReversals, 0, 'defender may make one move, never weave');
assert.equal(result.contactFrames, 0, 'legal defense must remain contact-free');
assert.equal(result.offTrackSeconds, 0, 'both cars must remain on the road');
