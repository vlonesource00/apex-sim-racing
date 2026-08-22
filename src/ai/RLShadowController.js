import { wrapAngle } from '../core/math.js';
import { HybridPolicy } from './HybridPolicy.js';
import { initialReducedState } from './ReducedOrderVehicle.js';

const LOOKAHEAD_M = [0, 18, 40, 70, 110, 160];
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function trafficSnapshot(vehicle, vehicles, track) {
  const length = track.length;
  let nearest = null;
  for (const opponent of vehicles) {
    if (opponent === vehicle || opponent.id === vehicle.id || opponent.retired) continue;
    let gap = opponent.distance - vehicle.distance;
    gap = ((gap + length * 0.5) % length + length) % length - length * 0.5;
    const score = gap >= -7 ? Math.abs(gap) : Math.abs(gap) + 30;
    if (!nearest || score < nearest.score) nearest = { opponent, gap, score };
  }
  if (!nearest) return null;
  const egoLateral = vehicle.surface?.lateral ?? 0;
  const opponentLateral = nearest.opponent.surface?.lateral ?? 0;
  const relativeLateral = opponentLateral - egoLateral;
  const relativeSpeed = nearest.opponent.speed - vehicle.speed;
  const closing = -relativeSpeed;
  const ttc = nearest.gap > 0 && closing > 0.2 ? nearest.gap / closing : 99;
  return { id: nearest.opponent.id, gap: nearest.gap, egoLateral, opponentLateral,
    relativeLateral, relativeSpeed, closing, ttc,
    clearance: Math.abs(relativeLateral) - 1.9, ahead: nearest.gap > 0,
    sideBySide: Math.abs(nearest.gap) < 5.5 };
}

function applyTrafficShield(decision, traffic) {
  if (!traffic) return { ...decision, trafficIntervention: 0 };
  const collisionCourse = traffic.gap > 0 && traffic.gap < 32 && traffic.closing > 0.2
    && Math.abs(traffic.relativeLateral) < 3.4;
  const overlapRisk = Math.abs(traffic.gap) < 5.8 && Math.abs(traffic.relativeLateral) < 2.35;
  const approach = collisionCourse ? Math.max(0.46, clamp((22 - traffic.gap) / 15, 0, 1)) : 0;
  const overlap = overlapRisk ? 0.9 : 0;
  const urgency = Math.max(approach, overlap);
  const brakeUrgency = collisionCourse ? clamp((12 - traffic.gap) / 8, 0, 1) : 0;
  const openSide = traffic.opponentLateral >= traffic.egoLateral ? -0.78 : 0.78;
  const safe = {
    ...decision,
    lineOffset: decision.lineOffset * (1 - urgency) + openSide * urgency,
    pace: Math.min(decision.pace, 0.10 - brakeUrgency * 1.10),
    aggression: decision.aggression * (1 - urgency * 0.65),
    ersStrategy: Math.min(decision.ersStrategy, 0.35 - brakeUrgency * 0.55)
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
    const traffic = trafficSnapshot(vehicle, vehicles, track);
    if ((this.policy.policy?.observationSize ?? 19) >= 27) {
      values.push(traffic ? clamp(traffic.gap / 30, -1.5, 1.5) : 1.0,
        traffic ? clamp(traffic.relativeLateral / 7.2, -1, 1) : 1.0,
        traffic ? clamp(traffic.relativeSpeed / 20, -1, 1) : 0,
        traffic ? clamp(traffic.closing / 20, -1, 1) : 0,
        traffic ? clamp(traffic.ttc / 6, 0, 1.5) : 1.5,
        traffic ? clamp(traffic.clearance / 4, -1, 1) : 1,
        traffic?.ahead ? 1 : 0, traffic?.sideBySide ? 1 : 0);
    }
    return { state, observation: new Float32Array(values), traffic };
  }

  update(vehicle, track, dt, vehicles = []) {
    this.clock += dt;
    if (this.clock + 1e-9 < this.interval) return this.last;
    // Subtract one fixed decision quantum. `%` can preserve a value just
    // below `interval` when the epsilon admits a boundary tick, which caused
    // a second decision on the next simulation frame (~40 Hz instead of 20).
    this.clock = Math.max(0, this.clock - this.interval);
    const { state, observation, traffic } = this.snapshot(vehicle, track, vehicles);
    const learnedDecision = this.policy.inferSafe(observation, state);
    const decision = applyTrafficShield(learnedDecision, traffic);
    this.last = Object.freeze({ ...decision, enabled: true, decisions: ++this.decisions,
      safetyIntervention: Math.max(decision.safetyIntervention ?? 0, decision.trafficIntervention ?? 0),
      opponentId: traffic?.id ?? null, opponentGapM: traffic?.gap ?? null,
      opponentTtcS: traffic?.ttc ?? null, sideBySide: traffic?.sideBySide ?? false,
      observationSize: observation.length, timestampS: this.decisions * this.interval });
    vehicle.rlShadow = this.last;
    return this.last;
  }
}
