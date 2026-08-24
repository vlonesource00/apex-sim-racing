import { wrapAngle } from '../core/math.js';
import { HybridPolicy } from './HybridPolicy.js';
import { initialReducedState } from './ReducedOrderVehicle.js';
import { STAGE5_MANEUVERS } from './Stage5TacticalInterface.js';

const LOOKAHEAD_M = [0, 18, 40, 70, 110, 160];
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function trafficSnapshots(vehicle, vehicles, track) {
  const length = track.length;
  const snapshots = [];
  for (const opponent of vehicles) {
    if (opponent === vehicle || opponent.id === vehicle.id || opponent.retired) continue;
    let gap = opponent.distance - vehicle.distance;
    gap = ((gap + length * 0.5) % length + length) % length - length * 0.5;
    const egoLateral = vehicle.surface?.lateral ?? 0;
    const opponentLateral = opponent.surface?.lateral ?? 0;
    const relativeLateral = opponentLateral - egoLateral;
    const relativeSpeed = opponent.speed - vehicle.speed;
    const closing = -relativeSpeed;
    snapshots.push({ id: opponent.id, gap, egoLateral, opponentLateral, relativeLateral,
      relativeSpeed, closing, ttc: gap > 0 && closing > 0.2 ? gap / closing : 99,
      clearance: Math.abs(relativeLateral) - 1.9, ahead: gap > 0,
      sideBySide: Math.abs(gap) < 5.5 });
  }
  const nearest = (items, score) => items.reduce((best, item) => !best || score(item) < score(best) ? item : best, null);
  const ahead = nearest(snapshots.filter((item) => item.gap > 0), (item) => item.gap);
  const side = nearest(snapshots.filter((item) => Math.abs(item.gap) < 7),
    (item) => Math.abs(item.gap) + Math.abs(item.relativeLateral) * 0.15);
  const behind = nearest(snapshots.filter((item) => item.gap < 0), (item) => -item.gap);
  const primary = nearest(snapshots, (item) => item.gap >= -7 ? Math.abs(item.gap) : Math.abs(item.gap) + 30);
  return { all: snapshots, ahead, side, behind, primary };
}

function trafficFeatures(traffic) {
  if (!traffic) return [1.5, 0, 0, 0, 1.5, 1, 0, 0];
  return [clamp(traffic.gap / 30, -1.5, 1.5), clamp(traffic.relativeLateral / 7.2, -1, 1),
    clamp(traffic.relativeSpeed / 20, -1, 1), clamp(traffic.closing / 20, -1, 1),
    clamp(traffic.ttc / 6, 0, 1.5), clamp(traffic.clearance / 4, -1, 1),
    traffic.ahead ? 1 : 0, traffic.sideBySide ? 1 : 0];
}

const STAGE5_CLASS = {
  prototype: [0, 925 / 1400, 1.92 / 2, 4.505 / 5, 10.4 / 12, 24 / 25, 11.5 / 14],
  gt: [1, 1325 / 1400, 1.58 / 2, 1.75 / 5, 7 / 12, 17.5 / 25, 10 / 14],
  touring: [2, 1280 / 1400, 1.34 / 2, 0.62 / 5, 5.4 / 12, 13.5 / 25, 8.5 / 14]
};

function stage5Memory(vehicle) {
  const phase = vehicle.aiTactical?.passPhase ?? 'FOLLOW';
  const lateral = vehicle.surface?.lateral ?? 0;
  const target = vehicle.aiTactical?.targetLaneOffsetM ?? lateral;
  let maneuver = 'FOLLOW';
  if (phase === 'DRAFT') maneuver = 'DRAFT';
  else if (phase === 'DEFEND') maneuver = target > lateral ? 'DEFEND_LEFT' : 'DEFEND_RIGHT';
  else if (phase === 'SWITCHBACK') maneuver = 'SWITCHBACK';
  else if (phase.includes('ATTACK') || phase.includes('DIVE')) maneuver = target > lateral ? 'ATTACK_LEFT' : 'ATTACK_RIGHT';
  else if (phase === 'RETURN') maneuver = 'ABORT';
  const oneHot = STAGE5_MANEUVERS.map((name) => name === maneuver ? 1 : 0);
  return [...oneHot, clamp((vehicle.aiTactical?.commitmentRemainingS ?? 0) / 4, 0, 1),
    clamp((vehicle.aiTactical?.passIntent?.targetClosingSpeed ?? 0) / 12, -1, 1)];
}

function applyTrafficShield(decision, trafficSet, stage3 = false) {
  const traffic = trafficSet.primary;
  if (!traffic) return { ...decision, trafficIntervention: 0, boxedIn: false };
  const nearby = trafficSet.all.filter((item) => Math.abs(item.gap) < 13 && Math.abs(item.relativeLateral) < 3.6);
  const negativeBlocked = nearby.some((item) => item.relativeLateral < -0.25);
  const positiveBlocked = nearby.some((item) => item.relativeLateral > 0.25);
  const boxedIn = negativeBlocked && positiveBlocked;
  const collisionCourse = traffic.gap > 0 && traffic.gap < 32 && traffic.closing > 0.2
    && Math.abs(traffic.relativeLateral) < 3.4;
  const corridorRisk = Math.abs(traffic.gap) < 18 && Math.abs(traffic.relativeLateral) < 3.1;
  const overlapRisk = Math.abs(traffic.gap) < 9 && Math.abs(traffic.relativeLateral) < 2.7;
  const approach = collisionCourse ? Math.max(0.46, clamp((22 - traffic.gap) / 15, 0, 1)) : 0;
  const urgency = Math.max(approach, corridorRisk ? 0.68 : 0, overlapRisk ? 0.98 : 0);
  let brakeUrgency = collisionCourse ? clamp((13 - traffic.gap) / 9, 0, 1) : 0;
  if (corridorRisk && traffic.gap > 0) brakeUrgency = Math.max(brakeUrgency, 0.48);
  if (overlapRisk && traffic.gap > 0) brakeUrgency = 1;
  if (boxedIn) brakeUrgency = Math.max(brakeUrgency, urgency);
  let openSide = traffic.opponentLateral >= traffic.egoLateral ? -0.78 : 0.78;
  if (openSide < 0 && negativeBlocked && !positiveBlocked) openSide = 0.78;
  if (openSide > 0 && positiveBlocked && !negativeBlocked) openSide = -0.78;
  if (boxedIn) openSide = 0;
  // Stage 3 supplies tactical intent; it must not silently replace the
  // learned line with a hard-coded side. Immediate collision urgency may
  // still blend toward an open corridor, while the deterministic trajectory
  // planner performs the full swept-path safety check downstream.
  const requestedLine = decision.lineOffset;
  const safe = {
    ...decision,
    lineOffset: requestedLine * (1 - urgency) + openSide * urgency,
    pace: Math.min(decision.pace, 0.10 - brakeUrgency * 1.10),
    aggression: decision.aggression * (1 - urgency * 0.65),
    ersStrategy: Math.min(decision.ersStrategy, 0.35 - brakeUrgency * 0.55),
    boxedIn
  };
  safe.trafficIntervention = Math.max(Math.abs(safe.lineOffset - decision.lineOffset),
    Math.abs(safe.pace - decision.pace), Math.abs(safe.aggression - decision.aggression),
    Math.abs(safe.ersStrategy - decision.ersStrategy));
  return safe;
}

export class RLShadowController {
  constructor(policy, updateHz = 20) {
    this.policy = policy instanceof HybridPolicy ? policy : HybridPolicy.fromJSON(policy);
    this.interval = 1 / Math.max(1, updateHz);
    this.clock = 0;
    this.decisions = 0;
    this.last = null;
  }

  reset() {
    this.clock = 0;
    this.decisions = 0;
    this.last = null;
    this.policy.resetMemory?.();
  }

  snapshot(vehicle, track, vehicles = []) {
    const point = track.atDistance(vehicle.distance);
    const trackHeading = Math.atan2(point.tangent.x, point.tangent.z);
    const lateral = vehicle.surface?.lateral ?? track.surfaceAt(vehicle.position.x, vehicle.position.z).lateral;
    const bodySlip = Math.atan2(vehicle.localVelocity?.x ?? 0, Math.max(3, Math.abs(vehicle.localVelocity?.z ?? vehicle.speed)));
    const state = initialReducedState({
      progressM: vehicle.distance, lateralM: lateral,
      headingErrorRad: wrapAngle(vehicle.yaw - trackHeading), speedMps: vehicle.speed,
      yawRateRadS: vehicle.yawRate, bodySlipRad: bodySlip,
      tireUtilization: vehicle.telemetry?.tyreUtilisation ?? 0,
      ersSoc: vehicle.ers?.soc ?? 0
    });
    const curvature = [];
    const targetSpeed = [];
    for (const offset of LOOKAHEAD_M) {
      curvature.push(track.atDistance(vehicle.distance + offset).curvature * 80);
      targetSpeed.push(track.targetSpeed(vehicle.distance + offset, 0.96) / 80);
    }
    const values = [
      state[1] / 7.2, state[2] / 0.5, state[3] / 80, state[4] / 2,
      state[5] / 0.3, state[6] / 1.5, state[7], ...curvature, ...targetSpeed
    ];
    const trafficSet = trafficSnapshots(vehicle, vehicles, track);
    const traffic = trafficSet.primary;
    const observationSize = this.policy.policy?.observationSize ?? 19;
    if (observationSize >= 65) {
      const classData = STAGE5_CLASS[vehicle.classKey] ?? STAGE5_CLASS.gt;
      const wheels = vehicle.wheels ?? [];
      const tireWear = wheels.length ? Math.max(...wheels.map((wheel) => wheel.wear ?? 0)) : 0;
      const tireTemperature = wheels.length
        ? wheels.reduce((sum, wheel) => sum + (wheel.carcassTemperatureC ?? 80), 0) / wheels.length : 80;
      values.push(...[0, 1, 2].map((id) => id === classData[0] ? 1 : 0), ...classData.slice(1),
        tireWear, (tireTemperature - 80) / 60,
        ...trafficFeatures(trafficSet.ahead), ...trafficFeatures(trafficSet.side),
        ...trafficFeatures(trafficSet.behind), ...stage5Memory(vehicle));
    } else if (observationSize >= 27) {
      if (observationSize >= 43) {
        values.push(...trafficFeatures(trafficSet.ahead), ...trafficFeatures(trafficSet.side),
          ...trafficFeatures(trafficSet.behind));
      } else values.push(...trafficFeatures(traffic));
    }
    return { state, observation: new Float32Array(values), traffic, trafficSet };
  }

  update(vehicle, track, dt, vehicles = []) {
    this.clock += dt;
    if (this.clock + 1e-9 < this.interval) return this.last;
    // Subtract one fixed decision quantum. `%` can preserve a value just
    // below `interval` when the epsilon admits a boundary tick, which caused
    // a second decision on the next simulation frame (~40 Hz instead of 20).
    this.clock = Math.max(0, this.clock - this.interval);
    const { state, observation, traffic, trafficSet } = this.snapshot(vehicle, track, vehicles);
    const learnedDecision = this.policy.inferSafe(observation, state);
    const stage3 = observation.length >= 43;
    const decision = learnedDecision.source === 'RL_STAGE5'
      ? learnedDecision : applyTrafficShield(learnedDecision, trafficSet, stage3);
    this.last = Object.freeze({ ...decision, enabled: true, decisions: ++this.decisions,
      requestedDecision: Object.freeze({ ...learnedDecision }),
      deployedPolicyDecision: Object.freeze({ ...decision }),
      safetyIntervention: Math.max(decision.safetyIntervention ?? 0, decision.trafficIntervention ?? 0),
      opponentId: traffic?.id ?? null, opponentGapM: traffic?.gap ?? null,
      opponentTtcS: traffic?.ttc ?? null, sideBySide: traffic?.sideBySide ?? false,
      boxedIn: decision.boxedIn, policyStage: observation.length >= 65 ? 5 : stage3 ? 3 : observation.length >= 27 ? 2 : 1,
      trafficSlots: stage3 ? [trafficSet.ahead?.id ?? null, trafficSet.side?.id ?? null, trafficSet.behind?.id ?? null] : null,
      observationSize: observation.length, timestampS: this.decisions * this.interval });
    vehicle.rlShadow = this.last;
    return this.last;
  }
}
