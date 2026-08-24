import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function evaluateStage5Promotion(baseline, candidate) {
  const checks = {
    situationCount: candidate.situations >= 500000,
    seedCount: Array.isArray(candidate.seeds) && new Set(candidate.seeds).size >= 5,
    cleanPassImprovement: candidate.cleanPassRate >= baseline.cleanPassRate * 1.10,
    deepContactReduction: candidate.deepContactRate <= baseline.deepContactRate * 0.85,
    forcedOffNonRegression: candidate.forcedOffRate <= baseline.forcedOffRate,
    soloPace: candidate.soloLapTimeS <= baseline.soloLapTimeS * 1.01,
    stoppedCarBypass: candidate.stoppedCarBypassRate >= 0.99,
    sideBySideCompletion: candidate.sideBySideCompletionRate >= 0.95
  };
  return { promoted: Object.values(checks).every(Boolean), checks, baseline, candidate };
}

async function main() {
  const [, , baselinePath, candidatePath] = process.argv;
  if (!baselinePath || !candidatePath) throw new Error('Usage: node tools/stage5-promotion-gate.mjs baseline.json candidate.json');
  const [baseline, candidate] = await Promise.all([
    readFile(baselinePath, 'utf8').then(JSON.parse), readFile(candidatePath, 'utf8').then(JSON.parse)
  ]);
  const result = evaluateStage5Promotion(baseline, candidate);
  console.log(JSON.stringify(result, null, 2));
  if (!result.promoted) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
