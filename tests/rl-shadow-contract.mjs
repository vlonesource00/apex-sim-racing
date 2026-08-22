import assert from 'node:assert/strict';
import policy from '../rl/policies/stage1_policy_compact.json' with { type: 'json' };
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { RLShadowController } from '../src/ai/RLShadowController.js';

const track = new Circuit(ENDURANCE_PARK);
const vehicle = new Vehicle({ id: 'rl-shadow', spec: 'prototype' });
vehicle.resetTo(track, 180, 0.4);
vehicle.velocity.x = track.atDistance(180).tangent.x * 42;
vehicle.velocity.z = track.atDistance(180).tangent.z * 42;
vehicle.speed = 42;
vehicle.localVelocity.z = 42;
vehicle.surface = track.surfaceAt(vehicle.position.x, vehicle.position.z);
vehicle.controls = { throttle: 0.63, brake: 0.04, steer: -0.17, handbrake: 0 };
const before = { ...vehicle.controls };
const shadow = new RLShadowController(policy);
for (let index = 0; index < 12; index += 1) shadow.update(vehicle, track, 1 / 120);

assert.deepEqual(vehicle.controls, before, 'shadow policy must never mutate heuristic controls');
assert.equal(vehicle.rlShadow.enabled, true);
assert.equal(vehicle.rlShadow.observationSize, 19);
assert.ok(vehicle.rlShadow.decisions >= 2);
for (const key of ['lineOffset', 'pace', 'aggression', 'ersStrategy', 'safetyIntervention']) {
  assert.ok(Number.isFinite(vehicle.rlShadow[key]), `${key} must be finite`);
}
console.log(JSON.stringify(vehicle.rlShadow, null, 2));
