import { clamp } from '../core/math.js';
import { shieldTacticalAction } from './ReducedOrderVehicle.js';

const finite = (value) => Number.isFinite(value) ? value : 0;
const activate = (values) => values.map((value) => Math.tanh(value));

export class HybridPolicy {
  constructor(policy = null) {
    this.policy = policy;
    this.enabled = Boolean(policy?.layers?.length);
  }

  static fromJSON(policy) { return new HybridPolicy(policy); }

  infer(observation) {
    if (!this.enabled) return { lineOffset: 0, pace: 0, aggression: 0, ersStrategy: 0, source: 'HEURISTIC' };
    let values = Array.from(observation, finite);
    for (const [index, layer] of this.policy.layers.entries()) {
      const output = new Array(layer.bias.length).fill(0);
      for (let row = 0; row < output.length; row += 1) {
        let sum = finite(layer.bias[row]);
        for (let column = 0; column < values.length; column += 1) sum += finite(layer.weight[row][column]) * values[column];
        output[row] = sum;
      }
      values = index === this.policy.layers.length - 1 ? output.map(Math.tanh) : activate(output);
    }
    return {
      lineOffset: clamp(values[0] ?? 0, -1, 1),
      pace: clamp(values[1] ?? 0, -1, 1),
      aggression: clamp(values[2] ?? 0, -1, 1),
      ersStrategy: clamp(values[3] ?? 0, -1, 1),
      source: 'RL'
    };
  }

  inferSafe(observation, reducedState) {
    const decision = this.infer(observation);
    const safe = shieldTacticalAction(reducedState, [decision.lineOffset, decision.pace, decision.aggression, decision.ersStrategy]);
    return { lineOffset: safe[0], pace: safe[1], aggression: safe[2], ersStrategy: safe[3],
      source: decision.source, safetyIntervention: Math.max(
        Math.abs(safe[0] - decision.lineOffset), Math.abs(safe[1] - decision.pace),
        Math.abs(safe[2] - decision.aggression), Math.abs(safe[3] - decision.ersStrategy)
      ) };
  }
}
