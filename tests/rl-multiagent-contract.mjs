import assert from 'node:assert/strict';
import policy from '../rl/policies/stage2_multiagent_policy.json' with { type: 'json' };
import { RLShadowController } from '../src/ai/RLShadowController.js';
import { Circuit } from '../src/simulation/Track.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';

const track = new Circuit(ENDURANCE_PARK);
const ego = new Vehicle({ id: 'attacker', name: 'ATTACKER', spec: 'prototype' });
const rival = new Vehicle({ id: 'rival', name: 'RIVAL', spec: 'gt' });
ego.resetTo(track, 100, 0);
rival.resetTo(track, 120, 1.2);
ego.speed = 52;
rival.speed = 30;

const leftController = new RLShadowController(policy);
const left = leftController.update(ego, track, 0.05, [ego, rival]);
assert.equal(left.observationSize, 27, 'Stage-2 policy must consume live traffic observations');
assert.equal(left.opponentId, rival.id);
assert.ok(left.opponentTtcS < 1, 'closing-time telemetry must be live');
assert.ok(left.lineOffset < 0, 'safety layer must reserve the lane away from a rival on the right');
assert.ok(left.trafficIntervention > 0.1, 'unsafe learned requests must be visibly shielded');

rival.resetTo(track, 120, -1.2);
rival.speed = 30;
const right = new RLShadowController(policy).update(ego, track, 0.05, [ego, rival]);
assert.ok(right.lineOffset > 0, 'the pass plan must react to the rival moving to the opposite side');
console.log(JSON.stringify({ observationSize: left.observationSize, leftPlan: left.lineOffset,
  rightPlan: right.lineOffset, ttcS: left.opponentTtcS, intervention: left.trafficIntervention }, null, 2));
