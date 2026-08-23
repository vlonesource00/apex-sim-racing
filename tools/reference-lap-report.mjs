import fs from 'node:fs';
import { ReferenceLapProfile } from '../src/telemetry/ReferenceLapProfile.js';

const [, , baselinePath, candidatePath] = process.argv;
if (!baselinePath) {
  console.error('Usage: npm run lap:report -- <baseline.json> [candidate.json]');
  process.exit(1);
}
const readProfile = (path) => new ReferenceLapProfile(JSON.parse(fs.readFileSync(path, 'utf8')));
const baseline = readProfile(baselinePath);
const report = { baseline: baseline.summary };
if (candidatePath) report.comparison = baseline.compare(readProfile(candidatePath));
console.log(JSON.stringify(report, null, 2));
