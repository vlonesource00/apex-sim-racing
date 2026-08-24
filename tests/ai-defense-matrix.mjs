import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);
const setSpeed = (vehicle, speed) => {
  vehicle.velocity.x = vehicle.forward.x * speed;
  vehicle.velocity.z = vehicle.forward.z * speed;
  vehicle.speed = speed;
};

function runScenario({ name, gapM, challengerLateral = 0, trafficAhead = false }) {
  const leader = new Vehicle({ id: `${name}-leader`, spec: 'gt' });
  const challenger = new Vehicle({ id: `${name}-challenger`, spec: 'gt' });
  leader.resetTo(track, 150, 0);
  challenger.resetTo(track, 150 - gapM, challengerLateral);
  setSpeed(leader, 25);
  setSpeed(challenger, 31);
  const vehicles = [leader, challenger];
  if (trafficAhead) {
    const traffic = new Vehicle({ id: `${name}-traffic`, spec: 'gt' });
    traffic.resetTo(track, 168, -1.4);
    setSpeed(traffic, 25.5);
    vehicles.push(traffic);
  }
  const controllers = new Map(vehicles.map((vehicle, index) => [vehicle, new AIController(index + 1)]));
  for (const controller of controllers.values()) controller.setDebugEnabled(true);
  const race = { phase: 'racing', raceTime: 10, elapsed: 10,
    statusFor: (vehicle) => ({ position: vehicles.indexOf(vehicle) + 1 }) };
  let defenseSeconds = 0;
  let firstDefenseGap = null;
  let contactFrames = 0;
  let deepOverlapFrames = 0;
  let offTrackSeconds = 0;
  let priorDirection = 0;
  let reversals = 0;
  for (let step = 0; step < 7 / DT; step += 1) {
    race.raceTime += DT;
    race.elapsed += DT;
    for (const vehicle of vehicles) controllers.get(vehicle).update(vehicle, vehicles, track, race, DT);
    updateAerodynamicWakes(vehicles);
    for (const vehicle of vehicles) vehicle.step(DT, track, true);
    const collision = resolveVehicleCollisions(vehicles, 3);
    contactFrames += collision.contacts ?? 0;
    deepOverlapFrames += collision.deepOverlaps ?? 0;
    if (vehicles.some((vehicle) => vehicle.surface?.zone === 'grass' || vehicle.surface?.zone === 'runoff')) offTrackSeconds += DT;
    const state = controllers.get(leader).debugState;
    if (state?.mode === 'DEFEND') {
      defenseSeconds += DT;
      firstDefenseGap ??= leader.distance - challenger.distance;
      const direction = Math.sign(state.targetOffset);
      if (priorDirection && direction && priorDirection !== direction) reversals += 1;
      if (direction) priorDirection = direction;
    }
  }
  return {
    name,
    defenseSeconds: Number(defenseSeconds.toFixed(2)),
    firstDefenseGapM: Number((firstDefenseGap ?? -1).toFixed(2)),
    contactFrames,
    deepOverlapFrames,
    offTrackSeconds: Number(offTrackSeconds.toFixed(2)),
    reversals
  };
}

const results = [
  runScenario({ name: 'centered-20m', gapM: 20 }),
  runScenario({ name: 'slipstream-pullout', gapM: 20, challengerLateral: 2.8 }),
  runScenario({ name: 'close-7m', gapM: 7 }),
  runScenario({ name: 'traffic-ahead', gapM: 20, trafficAhead: true })
];
console.log(JSON.stringify(results, null, 2));
for (const result of results) {
  assert.ok(result.defenseSeconds > 0.2, `${result.name}: predicted challenger must trigger a legal defensive move`);
  assert.equal(result.deepOverlapFrames, 0, `${result.name}: defense must never produce deep overlap`);
  assert.equal(result.offTrackSeconds, 0, `${result.name}: defense must keep the field on track`);
  assert.equal(result.reversals, 0, `${result.name}: defender must make at most one directional move`);
}

// The deterministic planner must retain a legal defensive state if the ideal
// inside corridor is occupied; it may shorten the move or hold its lane.
const policyLeader = new Vehicle({ id: 'blocked-defender', spec: 'gt' });
const policyChallenger = new Vehicle({ id: 'blocked-challenger', spec: 'gt' });
const leftBlocker = new Vehicle({ id: 'left-blocker', spec: 'gt' });
policyLeader.resetTo(track, 420, 0);
policyChallenger.resetTo(track, 408, 0);
const defenseTurn = [24, 42, 64].map((distance) => track.atDistance(420 + distance))
  .sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
const blockedOffset = (Math.sign(defenseTurn?.turnSign) || 1) * 3.65;
leftBlocker.resetTo(track, 420, blockedOffset);
setSpeed(policyLeader, 28); setSpeed(policyChallenger, 33); setSpeed(leftBlocker, 28);
const policyController = new AIController(1);
policyController.setDebugEnabled(true);
policyController.update(policyLeader, [policyLeader, policyChallenger, leftBlocker], track,
  { phase: 'racing', raceTime: 10, elapsed: 10, statusFor: () => ({ position: 1 }) }, DT);
assert.match(policyController.passPhase, /^DEFEND_/, 'Blocked preferred defence must fall back to a legal defensive hold');
assert.ok(Math.abs(policyController.racecraft.targetOffset - blockedOffset) > 1,
  'Occupied left defence must use the current/opposite legal corridor rather than silently reject');
assert.equal(policyController.racecraft.defenseTargetId, policyChallenger.id);

console.log('Defense matrix passed: centered, slipstream pull-out, close challenger, and traffic-ahead situations.');
