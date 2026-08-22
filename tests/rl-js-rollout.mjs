import fs from 'node:fs';
import { initialReducedState, reducedVehicleStep } from '../src/ai/ReducedOrderVehicle.js';

const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let state = initialReducedState(payload.initial);
const trace = [];
for (const frame of payload.frames) {
  const result = reducedVehicleStep(state, frame.action, frame.track);
  state = result.state;
  trace.push({ state: Array.from(state), controls: result.controls, reward: result.reward, done: result.done });
}
process.stdout.write(JSON.stringify({ trace, state: Array.from(state) }));
