import fs from 'node:fs';
import { runSoloAILap } from '../src/telemetry/AILapBenchmark.js';
import { ReferenceLapProfile } from '../src/telemetry/ReferenceLapProfile.js';

const args = process.argv.slice(2);
const compact = args.includes('--compact');
const [referencePath, outputPath] = args.filter((argument) => !argument.startsWith('--'));
if (!referencePath) {
  console.error('Usage: npm run ai:reference -- <human-reference.json> [ai-output.json]');
  process.exit(1);
}
const human = new ReferenceLapProfile(JSON.parse(fs.readFileSync(referencePath, 'utf8')));
const { payload } = runSoloAILap({ classKey: human.summary.vehicleClass, referenceProfile: human });
if (!payload?.complete) throw new Error('AI benchmark did not complete a lap');
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(payload));
const ai = new ReferenceLapProfile(payload);
const comparison = human.distanceDeltaReport(ai);
console.log(JSON.stringify({ human: human.summary, ai: ai.summary, benchmark: payload.benchmark,
  comparison: compact ? { ...human.compare(ai), binSizeM: comparison.binSizeM,
    largestLosses: comparison.largestLosses, largestGains: comparison.largestGains } : comparison }, null, 2));
