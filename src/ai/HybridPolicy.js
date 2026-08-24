import { clamp } from '../core/math.js';
import { shieldTacticalAction } from './ReducedOrderVehicle.js';
import { decodeStage5Action, STAGE5_ACTION_SIZE } from './Stage5TacticalInterface.js';

const finite = (value) => Number.isFinite(value) ? value : 0;
const activate = (values) => values.map((value) => Math.tanh(value));

export class HybridPolicy {
  constructor(policy = null) {
    this.policy = policy;
    this.enabled = Boolean(policy?.layers?.length || policy?.parameters?.gru);
    this.hidden = new Array(policy?.gruUnits ?? 0).fill(0);
  }

  static fromJSON(policy) { return new HybridPolicy(policy); }

  infer(observation) {
    if (!this.enabled) return { lineOffset: 0, pace: 0, aggression: 0, ersStrategy: 0, source: 'HEURISTIC' };
    if (this.policy?.format === 'apex73-stage5-gru-policy-v1') {
      const parameters = this.policy.parameters;
      const dense = (layer, input) => layer.bias.map((bias, row) => {
        let sum = finite(bias);
        for (let column = 0; column < input.length; column += 1) sum += finite(layer.weight[row][column]) * finite(input[column]);
        return sum;
      });
      const encoded = dense(parameters.encoder, Array.from(observation, finite)).map(Math.tanh);
      const sigmoid = (value) => 1 / (1 + Math.exp(-value));
      const combine = (inputLayer, recurrentLayer, recurrentInput, activation) => {
        const a = dense(inputLayer, encoded); const b = dense(recurrentLayer, recurrentInput);
        return a.map((value, index) => activation(value + b[index]));
      };
      const z = combine(parameters.gru.wz, parameters.gru.uz, this.hidden, sigmoid);
      const r = combine(parameters.gru.wr, parameters.gru.ur, this.hidden, sigmoid);
      const candidate = combine(parameters.gru.wh, parameters.gru.uh,
        this.hidden.map((value, index) => value * r[index]), Math.tanh);
      this.hidden = this.hidden.map((value, index) => (1 - z[index]) * value + z[index] * candidate[index]);
      const output = dense(parameters.actor, this.hidden);
      for (let index = STAGE5_ACTION_SIZE - 4; index < STAGE5_ACTION_SIZE; index += 1) output[index] = Math.tanh(output[index]);
      return decodeStage5Action(output);
    }
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
    if ((this.policy.actionSize ?? values.length) >= STAGE5_ACTION_SIZE) return decodeStage5Action(values);
    return {
      lineOffset: clamp(values[0] ?? 0, -1, 1),
      pace: clamp(values[1] ?? 0, -1, 1),
      aggression: clamp(values[2] ?? 0, -1, 1),
      ersStrategy: clamp(values[3] ?? 0, -1, 1),
      source: 'RL'
    };
  }

  resetMemory() { this.hidden.fill(0); }

  inferSafe(observation, reducedState) {
    const decision = this.infer(observation);
    if (decision.source === 'RL_STAGE5') return { ...decision, safetyIntervention: 0 };
    const safe = shieldTacticalAction(reducedState, [decision.lineOffset, decision.pace, decision.aggression, decision.ersStrategy]);
    return { lineOffset: safe[0], pace: safe[1], aggression: safe[2], ersStrategy: safe[3],
      source: decision.source, safetyIntervention: Math.max(
        Math.abs(safe[0] - decision.lineOffset), Math.abs(safe[1] - decision.pace),
        Math.abs(safe[2] - decision.aggression), Math.abs(safe[3] - decision.ersStrategy)
      ) };
  }
}
