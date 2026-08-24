import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { HybridPolicy } from '../src/ai/HybridPolicy.js';
import { RLShadowController } from '../src/ai/RLShadowController.js';
import { STAGE5_ACTION_SIZE } from '../src/ai/Stage5TacticalInterface.js';

const track = new Circuit(ENDURANCE_PARK);
const attacker = new Vehicle({ id: 'stage5-attacker', spec: 'gt' });
const target = new Vehicle({ id: 'stage5-target', player: true, spec: 'gt' });
attacker.resetTo(track, 500, 0);
target.resetTo(track, 524, 0);
for (const [vehicle, speed] of [[attacker, 32], [target, 21]]) {
  vehicle.velocity.x = vehicle.forward.x * speed;
  vehicle.velocity.z = vehicle.forward.z * speed;
  vehicle.speed = speed;
}
const controller = new AIController(1);
controller.setDebugEnabled(true);
assert.equal(controller.setTacticalPolicy({ source: 'RL_STAGE5', maneuver: 'ATTACK_LEFT',
  targetCorridor: -0.82, targetClosingSpeed: 9, ersDeployment: 0.8,
  commitmentDuration: 3.2, confidence: 0.9 }), true);
const race = { phase: 'racing', raceTime: 12, elapsed: 12,
  statusFor: (vehicle) => ({ position: vehicle === attacker ? 2 : 1 }) };

const stage5Policy = new HybridPolicy({ observationSize: 65, actionSize: STAGE5_ACTION_SIZE,
  layers: [{ weight: Array.from({ length: STAGE5_ACTION_SIZE }, () => Array(65).fill(0)),
    bias: Array.from({ length: STAGE5_ACTION_SIZE }, (_, index) => index === 2 ? 1 : -1) }] });
const shadow = new RLShadowController(stage5Policy);
const snapshot = shadow.snapshot(attacker, track, [attacker, target]);
assert.equal(snapshot.observation.length, 65, 'Browser must emit the same 65-value mixed-class/tyre/memory observation as JAX');
const shadowDecision = shadow.update(attacker, track, 0.05, [attacker, target]);
assert.equal(shadowDecision.source, 'RL_STAGE5');
assert.equal(shadowDecision.policyStage, 5);
assert.equal(shadowDecision.requestedDecision.maneuver, 'ATTACK_LEFT');
assert.equal(shadowDecision.deployedPolicyDecision.maneuver, 'ATTACK_LEFT');

controller.update(attacker, [attacker, target], track, race, 1 / 120);

assert.equal(attacker.aiTactical.source, 'RL_STAGE5', 'Browser must preserve the Stage 5 source through the real controller');
assert.equal(attacker.aiTactical.passTargetId, target.id, 'Stage 5 attack must lock the actual pass target');
assert.ok(Math.abs(controller.trajectoryPlan.selectedOffset - target.surface.lateral) >= 3.4,
  'A requested attack must commit its terminal path to a real body-width corridor');
assert.ok(controller.trajectoryPlan.selectedOffset > target.surface.lateral,
  'ATTACK_LEFT must select positive Frenet lateral, which is vehicle-left on this track frame');
assert.equal(controller.passIntent.targetClosingSpeed, 9, 'Learned closing-speed request must reach longitudinal control');
assert.equal(controller.passIntent.commitmentDuration, 3.2, 'Learned commitment memory must reach the manoeuvre owner');
assert.equal(controller.passIntent.straightSend, true, 'An open time-gaining straight corridor must become a straight-send');
assert.ok(Math.abs(attacker.controls.steer) > 0.02,
  'A tight-gap straight-send must immediately use lateral authority before accelerating into overlap');
assert.equal(controller.debugState.thought.requestedManeuver, 'ATTACK_LEFT');
assert.equal(controller.debugState.thought.deployedManeuver, controller.passPhase);
assert.equal(controller.debugState.thought.targetId, target.id);
assert.ok(controller.trajectoryPlan.futureMinimumClearanceM >= controller.passIntent.safetyThresholdM,
  'A straight-send may use the explicit safety threshold but must stay above it');

// Near-uniform learned logits are advisory. A much faster car with a safe
// adjacent corridor must attack instead of obeying a timid DRAFT forever.
const eagerAttacker = new Vehicle({ id: 'stage5-eager', spec: 'gt' });
const slowTarget = new Vehicle({ id: 'stage5-slow', player: true, spec: 'gt' });
eagerAttacker.resetTo(track, 500, 0);
slowTarget.resetTo(track, 540, 0);
for (const [vehicle, speed] of [[eagerAttacker, 31], [slowTarget, 15]]) {
  vehicle.velocity.x = vehicle.forward.x * speed;
  vehicle.velocity.z = vehicle.forward.z * speed;
  vehicle.speed = speed;
}
const eagerController = new AIController(2);
eagerController.setDebugEnabled(true);
eagerController.setTacticalPolicy({ source: 'RL_STAGE5', maneuver: 'DRAFT', confidence: 0.21,
  targetCorridor: 0, targetClosingSpeed: -8, ersDeployment: 0.2, commitmentDuration: 0.8 });
eagerController.update(eagerAttacker, [eagerAttacker, slowTarget], track, race, 1 / 120);
assert.equal(eagerController.passTargetId, slowTarget.id,
  'A low-confidence DRAFT request must not veto an obvious safe pass');
assert.ok(['ATTACK_INSIDE', 'ATTACK_OUTSIDE', 'SWITCHBACK'].includes(eagerController.passPhase));
assert.ok(Math.abs(eagerController.trajectoryPlan.selectedOffset - slowTarget.surface.lateral) >= 3.4,
  'Opportunity override must commit a body-width terminal corridor');
assert.equal(eagerAttacker.controls.brake, 0,
  'Opportunity override must not apply follow braking while opening the pass');

console.log('Stage 5 browser deployment passed: manoeuvre, low-confidence opportunity override, target corridor, closing speed, commitment, and controller authority.');
