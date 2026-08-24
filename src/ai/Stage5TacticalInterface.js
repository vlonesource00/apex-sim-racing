import { clamp } from '../core/math.js';

export const STAGE5_MANEUVERS = Object.freeze([
  'FOLLOW', 'DRAFT', 'ATTACK_LEFT', 'ATTACK_RIGHT', 'LATE_BRAKE',
  'SWITCHBACK', 'DEFEND_LEFT', 'DEFEND_RIGHT', 'ABORT'
]);
export const STAGE5_ACTION_SIZE = STAGE5_MANEUVERS.length + 4;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function decodeStage5Action(values) {
  if (!values || values.length < STAGE5_ACTION_SIZE) {
    throw new Error(`Stage 5 requires ${STAGE5_ACTION_SIZE} policy outputs`);
  }
  let maneuverIndex = 0;
  for (let index = 1; index < STAGE5_MANEUVERS.length; index += 1) {
    if (finite(values[index], -Infinity) > finite(values[maneuverIndex], -Infinity)) maneuverIndex = index;
  }
  const continuous = STAGE5_MANEUVERS.length;
  const logits = STAGE5_MANEUVERS.map((name, index) => ({ name, score: finite(values[index]) }));
  const peak = Math.max(...logits.map((entry) => entry.score));
  const exponential = logits.map((entry) => Math.exp(entry.score - peak));
  const denominator = exponential.reduce((sum, value) => sum + value, 0) || 1;
  const alternatives = logits.map((entry, index) => ({ ...entry, probability: exponential[index] / denominator }))
    .sort((a, b) => b.probability - a.probability);
  return Object.freeze({
    maneuver: STAGE5_MANEUVERS[maneuverIndex],
    maneuverIndex,
    targetCorridor: clamp(finite(values[continuous]), -1, 1),
    targetClosingSpeed: clamp(finite(values[continuous + 1]), -1, 1) * 12,
    ersDeployment: clamp((finite(values[continuous + 2]) + 1) * 0.5, 0, 1),
    commitmentDuration: 0.35 + clamp((finite(values[continuous + 3]) + 1) * 0.5, 0, 1) * 3.65,
    confidence: alternatives[0]?.probability ?? 0,
    alternatives: alternatives.slice(0, 3),
    maneuverScores: Object.freeze(Object.fromEntries(logits.map((entry, index) => [entry.name, exponential[index] / denominator]))),
    source: 'RL_STAGE5'
  });
}

export function stage5ActionVector({ maneuver = 'FOLLOW', targetCorridor = 0,
  targetClosingSpeed = 0, ersDeployment = 0, commitmentDuration = 0.35 } = {}) {
  const logits = STAGE5_MANEUVERS.map((name) => name === maneuver ? 1 : -1);
  return [...logits,
    clamp(finite(targetCorridor), -1, 1),
    clamp(finite(targetClosingSpeed) / 12, -1, 1),
    clamp(finite(ersDeployment) * 2 - 1, -1, 1),
    clamp((finite(commitmentDuration) - 0.35) / 3.65 * 2 - 1, -1, 1)
  ];
}
