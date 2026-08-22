import assert from 'node:assert/strict';
import policy from '../rl/policies/stage3_pack_policy.json' with { type: 'json' };
import { RLShadowController } from '../src/ai/RLShadowController.js';
import { Circuit } from '../src/simulation/Track.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';

const track = new Circuit(ENDURANCE_PARK);
const makeCar = (id, distance, lateral, speed) => {
  const car = new Vehicle({ id, name: id.toUpperCase(), spec: 'prototype' });
  car.resetTo(track, distance, lateral);
  car.speed = speed;
  return car;
};

const ego = makeCar('ego', 100, 0, 48);
const ahead = makeCar('ahead', 116, 1.1, 35);
const side = makeCar('side', 102, -1.2, 47);
const behind = makeCar('behind', 92, 2.8, 52);
const result = new RLShadowController(policy).update(ego, track, 0.05, [ego, ahead, side, behind]);

assert.equal(result.policyStage, 3);
assert.equal(result.observationSize, 43, 'Stage 3 must consume base state plus three traffic slots');
assert.deepEqual(result.trafficSlots, ['side', 'side', 'behind'],
  'slot selection must match JAX: one nearby rival may occupy both ahead and side roles');
assert.equal(result.boxedIn, true, 'opponents on both sides must be recognized as a boxed-in condition');
assert.ok(result.pace < 0, 'boxed traffic must trigger deterministic yielding authority');
assert.ok(result.safetyIntervention > 0.1, 'Stage 3 safety intervention must be visible to telemetry');

console.log(JSON.stringify({ stage: result.policyStage, observationSize: result.observationSize,
  slots: result.trafficSlots, boxedIn: result.boxedIn, pace: result.pace }, null, 2));
