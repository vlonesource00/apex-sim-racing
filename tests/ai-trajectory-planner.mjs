import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { FrenetTrajectoryPlanner } from '../src/ai/FrenetTrajectoryPlanner.js';

const track = new Circuit(ENDURANCE_PARK);
const vehicle = new Vehicle({ id: 'trajectory-ego', spec: 'prototype' });
vehicle.resetTo(track, 100, 0);
vehicle.velocity.x = vehicle.forward.x * 30;
vehicle.velocity.z = vehicle.forward.z * 30;
vehicle.speed = 30;

const planner = new FrenetTrajectoryPlanner();
const decisive = planner.plan({
  vehicle, track, desiredOffset: 4.2, fallbackOffsets: [0], targetSpeed: 34,
  aggression: 0.8, racecraftPhase: 'ATTACK_OUTSIDE', roadMargin: 5.3, lookAhead: 24
});

assert.equal(decisive.points.length, 24, 'planner must publish a complete fixed-size trajectory');
assert.ok(decisive.committed, 'attack trajectory must be marked committed');
assert.ok(decisive.roadLegal, 'selected attack trajectory must remain inside road bounds');
assert.ok(Math.abs(decisive.selectedOffset - 4.2) < 0.15, 'clear-road attack must preserve tactical intent');
assert.ok(Math.abs(decisive.points.at(-1).lateral - 4.2) < 0.15, 'trajectory must establish and hold the selected lane');
for (let index = 1; index < decisive.points.length; index += 1) {
  assert.ok(decisive.points[index].time > decisive.points[index - 1].time, 'trajectory time must increase');
  assert.ok(decisive.points[index].lateral >= decisive.points[index - 1].lateral - 1e-5,
    'clear-road lane change must remain directionally consistent');
}
const lateralSteps = decisive.points.slice(1).map((point, index) => point.lateral - decisive.points[index].lateral);
const peakStep = Math.max(...lateralSteps);
assert.ok(lateralSteps[0] < peakStep * 0.35, 'minimum-jerk path must turn in progressively');
assert.ok(lateralSteps.at(-1) < peakStep * 0.2, 'minimum-jerk path must straighten after reaching the pass lane');

const blocker = new Vehicle({ id: 'trajectory-blocker', player: true, spec: 'touring' });
blocker.resetTo(track, 112, 4.2);
blocker.velocity.x = blocker.forward.x * 18;
blocker.velocity.z = blocker.forward.z * 18;
blocker.speed = 18;
const blocked = planner.plan({
  vehicle, track, desiredOffset: 4.2, fallbackOffsets: [-4.2, 0], targetSpeed: 34,
  aggression: 0.8, racecraftPhase: 'ATTACK_OUTSIDE', roadMargin: 5.3, lookAhead: 24,
  trafficEntries: [{
    other: blocker, delta: 12, lateralDelta: 4.2, longitudinal: 12, side: 4.2,
    relativeLongitudinalVelocity: 12, relativeLateralVelocity: 0
  }]
});
assert.ok(blocked.collisionFree, 'candidate scorer must reject the occupied pass corridor');
assert.ok(blocked.selectedOffset < 1, 'candidate scorer must choose a materially different safe corridor');
assert.ok(blocked.candidateCount >= 6, 'planner must evaluate multiple complete trajectories');

console.log(JSON.stringify({
  decisive: {
    offset: decisive.selectedOffset,
    transitionTimeS: decisive.transitionTimeS,
    candidates: decisive.candidateCount,
    maxLateralAccelerationMps2: decisive.maxLateralAccelerationMps2
  },
  blocked: {
    requestedOffset: blocked.requestedOffset,
    selectedOffset: blocked.selectedOffset,
    candidates: blocked.candidateCount,
    minimumClearanceM: blocked.minimumClearanceM
  }
}, null, 2));
