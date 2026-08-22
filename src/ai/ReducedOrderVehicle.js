import MODEL_CONFIG from '../../rl/model_config.json' with { type: 'json' };
import { clamp } from '../core/math.js';

export const RL_STATE_SIZE = 8;
export const RL_ACTION_SIZE = 4;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function initialReducedState(overrides = {}) {
  return new Float64Array([
    finite(overrides.progressM), finite(overrides.lateralM), finite(overrides.headingErrorRad),
    finite(overrides.speedMps, 24), finite(overrides.yawRateRadS), finite(overrides.bodySlipRad),
    finite(overrides.tireUtilization), clamp(finite(overrides.ersSoc, 0.74), 0, 1)
  ]);
}

export function shieldTacticalAction(state, action, config = MODEL_CONFIG) {
  const lateral = finite(state[1]);
  const heading = finite(state[2]);
  const speed = Math.max(0, finite(state[3]));
  const beta = finite(state[5]);
  const projectedLateral = lateral + speed * Math.sin(heading + beta) * 0.8;
  const warningEdge = config.roadHalfWidthM * 0.72;
  const riskFor = (value) => clamp((Math.abs(value) - warningEdge) / Math.max(0.1, config.roadHalfWidthM - warningEdge), 0, 1);
  const risk = Math.max(riskFor(lateral), riskFor(projectedLateral));
  const centerRequest = -Math.sign(projectedLateral || lateral) * 0.55;
  return new Float64Array([
    clamp(finite(action[0]) * (1 - risk) + centerRequest * risk, -1, 1),
    Math.min(clamp(finite(action[1]), -1, 1), 0.12 - risk * 0.82),
    clamp(finite(action[2]) * (1 - risk), -1, 1),
    Math.min(clamp(finite(action[3]), -1, 1), 0.25 - risk * 0.9)
  ]);
}

export function reducedVehicleStep(state, action, trackInput, config = MODEL_CONFIG) {
  if (state.length !== RL_STATE_SIZE || action.length !== RL_ACTION_SIZE) throw new Error('Invalid reduced-order state/action shape');
  const dt = config.dt;
  const progress = finite(state[0]);
  const lateral = finite(state[1]);
  const heading = finite(state[2]);
  const speed = Math.max(1, finite(state[3]));
  const yawRate = finite(state[4]);
  const beta = finite(state[5]);
  const ersSoc = clamp(finite(state[7], 0.74), 0, 1);
  const curvature = finite(trackInput.curvature);
  const nominalTargetSpeed = clamp(finite(trackInput.targetSpeedMps, 38), 8, 95);
  const lineTarget = clamp(finite(action[0]), -1, 1) * config.roadHalfWidthM * config.lineOffsetFraction;
  const pace = 0.72 + (clamp(finite(action[1]), -1, 1) + 1) * 0.165;
  const aggression = 0.88 + (clamp(finite(action[2]), -1, 1) + 1) * 0.08;
  const ersRequest = clamp(finite(action[3]), -1, 1);
  const targetSpeed = nominalTargetSpeed * pace;
  const lineError = lateral - lineTarget;
  const desiredHeading = clamp(-lineError * 0.045, -0.28, 0.28);
  const headingControlError = heading - desiredHeading;
  const controller = config.controller;
  const steer = clamp((
    -controller.headingGain * headingControlError
    - controller.lineGain * lineError
    - controller.yawGain * yawRate
  ) * aggression, -config.maxSteerRad, config.maxSteerRad);
  const speedError = targetSpeed - speed;
  const throttle = clamp(speedError * controller.speedThrottleGain, 0, 1);
  const brake = clamp(-speedError * controller.speedBrakeGain, 0, 1);

  const lf = config.frontAxleM;
  const lr = config.rearAxleM;
  const safeSpeed = Math.max(4, speed);
  const alphaFront = steer - beta - lf * yawRate / safeSpeed;
  const alphaRear = -beta + lr * yawRate / safeSpeed;
  const downforce = config.aeroDownforcePerSpeed2 * speed * speed;
  const normalTotal = config.massKg * 9.81 + downforce;
  const maxLateral = config.tireMu * normalTotal;
  let frontForce = config.corneringFrontNPerRad * alphaFront;
  let rearForce = config.corneringRearNPerRad * alphaRear;
  const requestedLateral = Math.abs(frontForce) + Math.abs(rearForce);
  const lateralScale = requestedLateral > maxLateral ? maxLateral / Math.max(1, requestedLateral) : 1;
  frontForce *= lateralScale;
  rearForce *= lateralScale;

  const ersCanDeploy = ersRequest > 0 && ersSoc > config.ers.minSoc && throttle > 0.05;
  const ersCanRegen = ersRequest < 0 && (brake > 0.02 || throttle < 0.05) && ersSoc < 0.999;
  const ersPower = ersCanDeploy ? config.ers.maxPowerW * ersRequest : ersCanRegen ? config.ers.regenPowerW * ersRequest : 0;
  const ersAccel = ersCanDeploy ? ersPower / Math.max(4, speed) / config.massKg : 0;
  const longitudinalAccel = throttle * config.maxDriveAccelMps2 + ersAccel
    - brake * config.maxBrakeAccelMps2 - config.dragAccelPerSpeed2 * speed * speed - config.rollingAccelMps2;
  const betaDot = (frontForce + rearForce) / (config.massKg * safeSpeed) - yawRate;
  const yawDot = (lf * frontForce - lr * rearForce) / config.yawInertiaKgM2;
  const nextSpeed = Math.max(1, speed + longitudinalAccel * dt);
  const nextBeta = clamp(beta + betaDot * dt, -0.42, 0.42);
  const nextYawRate = clamp(yawRate + yawDot * dt, -2.8, 2.8);
  const nextHeading = clamp(heading + (nextYawRate - curvature * nextSpeed) * dt, -Math.PI, Math.PI);
  const velocityHeading = nextHeading + nextBeta;
  const progressDelta = Math.max(0, nextSpeed * Math.cos(velocityHeading) * dt);
  const nextLateral = lateral + nextSpeed * Math.sin(velocityHeading) * dt;
  const longitudinalDemand = Math.abs(longitudinalAccel) * config.massKg;
  const tireUtilization = Math.sqrt(requestedLateral ** 2 + longitudinalDemand ** 2) / Math.max(1, maxLateral);
  const nextSoc = clamp(ersSoc - ersPower * dt / config.ers.capacityJ, 0, 1);
  const offTrack = Math.abs(nextLateral) > config.roadHalfWidthM;
  const edgeRisk = Math.max(0, Math.abs(nextLateral) - config.roadHalfWidthM * 0.76);
  const reward = progressDelta * 0.1
    - nextLateral * nextLateral * 0.012
    - nextHeading * nextHeading * 0.35
    - nextBeta * nextBeta * 0.5
    - edgeRisk * edgeRisk * 0.18
    - Math.max(0, tireUtilization - 1) ** 2 * 1.25
    - (offTrack ? 30 : 0);

  return {
    state: new Float64Array([
      progress + progressDelta, nextLateral, nextHeading, nextSpeed,
      nextYawRate, nextBeta, tireUtilization, nextSoc
    ]),
    controls: { steer, throttle, brake },
    tactical: { lineTarget, targetSpeed, pace, aggression, ersRequest },
    reward,
    done: offTrack || !Number.isFinite(reward)
  };
}

export { MODEL_CONFIG };
