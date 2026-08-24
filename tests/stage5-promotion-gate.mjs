import assert from 'node:assert/strict';
import { evaluateStage5Promotion } from '../tools/stage5-promotion-gate.mjs';

const baseline = { cleanPassRate: 0.4, deepContactRate: 0.1, forcedOffRate: 0.02,
  soloLapTimeS: 65, stoppedCarBypassRate: 0.95, sideBySideCompletionRate: 0.91 };
const acceptable = { situations: 600000, seeds: [1, 2, 3, 4, 5], cleanPassRate: 0.45,
  deepContactRate: 0.08, forcedOffRate: 0.018, soloLapTimeS: 65.4,
  stoppedCarBypassRate: 0.995, sideBySideCompletionRate: 0.96 };
assert.equal(evaluateStage5Promotion(baseline, acceptable).promoted, true);
for (const field of ['situations', 'seeds', 'cleanPassRate', 'deepContactRate', 'forcedOffRate',
  'soloLapTimeS', 'stoppedCarBypassRate', 'sideBySideCompletionRate']) {
  const rejected = structuredClone(acceptable);
  if (field === 'situations') rejected[field] = 499999;
  else if (field === 'seeds') rejected[field] = [1, 2, 3, 4];
  else if (field === 'cleanPassRate') rejected[field] = 0.43;
  else if (field === 'deepContactRate') rejected[field] = 0.09;
  else if (field === 'forcedOffRate') rejected[field] = 0.021;
  else if (field === 'soloLapTimeS') rejected[field] = 65.7;
  else if (field === 'stoppedCarBypassRate') rejected[field] = 0.98;
  else rejected[field] = 0.94;
  assert.equal(evaluateStage5Promotion(baseline, rejected).promoted, false, `${field} must independently block promotion`);
}
console.log('Stage 5 promotion gate passed: every required quality threshold independently blocks a weak candidate.');
