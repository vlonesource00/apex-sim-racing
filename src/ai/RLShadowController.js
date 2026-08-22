import { wrapAngle } from '../core/math.js';
import { HybridPolicy } from './HybridPolicy.js';
import { initialReducedState } from './ReducedOrderVehicle.js';

const LOOKAHEAD_M = [0, 18, 40, 70, 110, 160];

export class RLShadowController {
  constructor(policy, updateHz = 20) {
    this.policy = policy instanceof HybridPolicy ? policy : HybridPolicy.fromJSON(policy);
    this.interval = 1 / Math.max(1, updateHz);
    this.clock = 0;
    this.decisions = 0;
    this.last = null;
  }

  snapshot(vehicle, track) {
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
    const observation = new Float32Array([
      state[1] / 7.2, state[2] / 0.5, state[3] / 80, state[4] / 2,
      state[5] / 0.3, state[6] / 1.5, state[7], ...curvature, ...targetSpeed
    ]);
    return { state, observation };
  }

  update(vehicle, track, dt) {
    this.clock += dt;
    if (this.clock + 1e-9 < this.interval) return this.last;
    this.clock %= this.interval;
    const { state, observation } = this.snapshot(vehicle, track);
    const decision = this.policy.inferSafe(observation, state);
    this.last = Object.freeze({ ...decision, enabled: true, decisions: ++this.decisions,
      observationSize: observation.length, timestampS: this.decisions * this.interval });
    vehicle.rlShadow = this.last;
    return this.last;
  }
}
