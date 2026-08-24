import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeStage5Action, stage5ActionVector, STAGE5_ACTION_SIZE, STAGE5_MANEUVERS } from '../src/ai/Stage5TacticalInterface.js';
import { HybridPolicy } from '../src/ai/HybridPolicy.js';

const config = JSON.parse(await readFile(new URL('../rl/stage5_config.json', import.meta.url), 'utf8'));
assert.deepEqual(config.maneuvers, STAGE5_MANEUVERS, 'Browser and trainer manoeuvre order must be identical');
assert.equal(config.decisionHz, 20);
assert.equal(config.simulationHz, 120);
assert.equal(config.gruUnits, 64);
assert.equal(STAGE5_ACTION_SIZE, 13);
assert.deepEqual(Object.keys(config.classes), ['prototype', 'gt', 'touring']);
assert.ok(config.curriculum.includes('STOPPED_CAR_AHEAD') && config.curriculum.includes('THREE_WIDE'));
assert.ok(config.promotion.minimumSituations >= 500000 && config.promotion.minimumSeeds >= 5);

for (const maneuver of STAGE5_MANEUVERS) {
  const encoded = stage5ActionVector({ maneuver, targetCorridor: -0.65,
    targetClosingSpeed: 8, ersDeployment: 0.7, commitmentDuration: 2.4 });
  const decoded = decodeStage5Action(encoded);
  assert.equal(decoded.maneuver, maneuver);
  assert.equal(decoded.alternatives[0].name, maneuver);
  assert.ok(decoded.confidence > 0 && decoded.confidence <= 1);
  assert.equal(Object.keys(decoded.maneuverScores).length, STAGE5_MANEUVERS.length);
  assert.ok(Math.abs(decoded.targetClosingSpeed - 8) < 1e-9);
  assert.ok(Math.abs(decoded.commitmentDuration - 2.4) < 1e-9);
}

const output = stage5ActionVector({ maneuver: 'ATTACK_LEFT', targetCorridor: -0.8,
  targetClosingSpeed: 9, ersDeployment: 1, commitmentDuration: 3 });
const policy = new HybridPolicy({ actionSize: STAGE5_ACTION_SIZE, layers: [{
  weight: output.map(() => [0]), bias: output.map((value) => Math.atanh(Math.max(-0.999, Math.min(0.999, value))))
}] });
const inferred = policy.inferSafe(new Float32Array([0]), new Float32Array(8));
assert.equal(inferred.maneuver, 'ATTACK_LEFT');
assert.equal(inferred.source, 'RL_STAGE5');
assert.equal(inferred.alternatives[0].name, 'ATTACK_LEFT');
assert.equal(inferred.safetyIntervention, 0, 'Stage 5 must be shielded by the deployed planner, not the old four-float shield');

const zeros = (rows, columns, bias = []) => ({
  weight: Array.from({ length: rows }, () => Array(columns).fill(0)),
  bias: Array.from({ length: rows }, (_, index) => bias[index] ?? 0)
});
const recurrentBias = Array(STAGE5_ACTION_SIZE).fill(-0.5);
recurrentBias[3] = 1.5;
recurrentBias[STAGE5_ACTION_SIZE - 4] = 0.7;
const recurrent = new HybridPolicy({ format: 'apex73-stage5-gru-policy-v1',
  observationSize: 65, actionSize: STAGE5_ACTION_SIZE, gruUnits: 2,
  parameters: { encoder: zeros(2, 65), gru: {
    wz: zeros(2, 2), uz: zeros(2, 2), wr: zeros(2, 2), ur: zeros(2, 2),
    wh: zeros(2, 2, [0.4, -0.2]), uh: zeros(2, 2)
  }, actor: zeros(STAGE5_ACTION_SIZE, 2, recurrentBias), critic: zeros(1, 2), log_std: [-1, -1, -1, -1] } });
const recurrentDecision = recurrent.inferSafe(new Float32Array(65), new Float32Array(8));
assert.equal(recurrentDecision.maneuver, 'ATTACK_RIGHT', 'Browser GRU inference must preserve discrete manoeuvre logits');
assert.ok(recurrent.hidden.some((value) => Math.abs(value) > 0), 'GRU must retain tactical memory between 20 Hz decisions');
recurrent.resetMemory();
assert.ok(recurrent.hidden.every((value) => value === 0), 'Race reset must clear recurrent memory');

console.log('Stage 5 action contract passed: discrete manoeuvres, corridor/closing/ERS/commitment outputs, class schema, and promotion gate.');
