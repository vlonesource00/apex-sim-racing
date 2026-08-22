import assert from 'node:assert/strict';
import { HybridPolicy } from '../src/ai/HybridPolicy.js';
import { initialReducedState, reducedVehicleStep, shieldTacticalAction } from '../src/ai/ReducedOrderVehicle.js';

const fallback = new HybridPolicy();
assert.equal(fallback.infer(new Float32Array(19)).source, 'HEURISTIC');

const policy = HybridPolicy.fromJSON({
  layers: [{
    weight: Array.from({ length: 4 }, () => Array(19).fill(0)),
    bias: [0.2, -0.1, 0.3, 0.4]
  }]
});
const decision = policy.infer(new Float32Array(19));
assert.equal(decision.source, 'RL');
for (const value of [decision.lineOffset, decision.pace, decision.aggression, decision.ersStrategy]) {
  assert.ok(Number.isFinite(value) && value >= -1 && value <= 1);
}

const step = reducedVehicleStep(initialReducedState(), [0, 0, 0, 0.5], { curvature: 0.006, targetSpeedMps: 42 });
assert.equal(step.state.length, 8);
assert.ok(step.state.every(Number.isFinite));
assert.ok(Number.isFinite(step.reward));
assert.ok(step.controls.throttle > 0);
const dangerState = initialReducedState({ lateralM: 6.5, headingErrorRad: 0.18, speedMps: 45 });
const shielded = shieldTacticalAction(dangerState, [1, 1, 1, 1]);
assert.ok(shielded[0] < 0, 'safety shield must request the center from the outside edge');
assert.ok(shielded[1] < 0, 'safety shield must reduce pace near a projected boundary breach');
const safeDecision = policy.inferSafe(new Float32Array(19), dangerState);
assert.ok(safeDecision.safetyIntervention > 0.5, 'browser inference must report a material safety intervention');
console.log('Hybrid RL contract passed: bounded tactical policy and finite deterministic controller.');
