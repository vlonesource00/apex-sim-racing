import { clamp, wrapAngle } from '../core/math.js';
import { classDynamics, cornerSpeedFor, finite, lateralCapacity } from './AIConfig.js';
import { TrackIntelligence } from './TrackIntelligence.js';

const drivenWheelIndices = (vehicle) => vehicle.spec?.drive === 'front'
  ? [0, 1] : vehicle.spec?.drive === 'all' ? [0, 1, 2, 3] : [2, 3];

export class VehicleController {
  compute(snapshot, agent, plan, dt) {
    const ego = snapshot.ego(agent.vehicleId);
    if (!ego || !plan?.points?.length) return {
      controls: { throttle: 0, brake: 1, steer: 0, handbrake: 0 },
      stability: { torqueCut: 0, wheelBrake: [0, 0, 0, 0], active: false, reason: 'NO_PLAN' }
    };
    const dynamics = classDynamics(ego.vehicle);
    const lookahead = clamp(5.5 + ego.speed * 0.24, 6, 22);
    let targetIndex = plan.points.findIndex((point) => point.forwardDistance >= lookahead);
    if (targetIndex < 1) targetIndex = Math.min(plan.points.length - 1, 3);
    const target = plan.points[targetIndex];
    const desiredHeading = Math.atan2(target.x - ego.position.x, target.z - ego.position.z);
    const headingError = wrapAngle(desiredHeading - ego.yaw);
    const lateralError = ego.lateral - target.lateral;
    const slipAngle = Math.atan2(finite(ego.vehicle.localVelocity?.x),
      Math.max(3, Math.abs(finite(ego.vehicle.localVelocity?.z, ego.speed))));
    const availableLateral = lateralCapacity(ego.vehicle, ego.speed, ego.wake.frontLoss);
    // ESC compares the car to the local path tangent, not the maximum bend
    // anywhere in the multi-second horizon. Using the horizon maximum made a
    // straight-running car look like it was under-rotating for a distant
    // corner and needlessly cut power for most of the lap.
    const localCurvature = clamp(finite(target.signedCurvature), -0.12, 0.12);
    const desiredYawRate = ego.speed * localCurvature;
    const yawError = ego.yawRate - desiredYawRate;
    const steeringAuthority = ego.classKey === 'touring' ? 13.5 : 15;
    const steerLimit = plan.intent.mode === 'RECOVER' || plan.intent.phase === 'LINE_RECOVERY' ? 1
      : clamp(steeringAuthority / Math.max(8, ego.speed), 0.35, 1);
    let steerTarget = headingError * 2.55 - lateralError * 0.075
      - ego.yawRate * 0.18 + slipAngle * 1.18;
    if (plan.intent.mode === 'LAUNCH') steerTarget = clamp(steerTarget, -0.38, 0.38);
    steerTarget = clamp(steerTarget, -steerLimit, steerLimit);
    const rate = plan.intent.committed ? 7.2 : plan.intent.mode === 'RECOVER' ? 5.5 : 4.8;
    agent.steerCommand += clamp(steerTarget - agent.steerCommand, -rate * dt, rate * dt);
    agent.steerCommand = clamp(agent.steerCommand, -1, 1);

    let desiredSpeed = finite(plan.targetSpeed, ego.speed);
    const previewLimit = plan.points.reduce((limit, point) => {
      const curvature = finite(point.curvature);
      if (curvature < 0.0005) return limit;
      const cornerSpeed = cornerSpeedFor(ego.vehicle, curvature, ego.wake.frontLoss);
      const reachable = Math.sqrt(cornerSpeed ** 2 + 2 * dynamics.brake * Math.max(0, point.forwardDistance));
      return Math.min(limit, reachable);
    }, dynamics.topSpeed);
    // Tactical trajectories already carry a track-aware speed target and have
    // passed the planner's lateral-acceleration check. Reinterpreting their
    // intentional lane change as a tiny-radius corner makes an attacker crawl
    // beside the obstacle it is trying to clear.
    if (!['PASS', 'LAUNCH', 'PACE', 'RETURN', 'DEFEND'].includes(plan.intent.mode)) {
      desiredSpeed = Math.min(desiredSpeed, previewLimit);
    }
    if (ego.wake.frontLoss > 0.02 && Math.abs(agent.steerCommand) > 0.16) {
      desiredSpeed *= clamp(1 - ego.wake.frontLoss * 0.42, 0.82, 1);
    }
    const trackModel = snapshot.trackModel ?? TrackIntelligence.for(snapshot.track);
    const offLineDistance = Math.abs(ego.lateral - trackModel.lineAt(ego.distance));
    const trackCurvature = Math.abs(trackModel.curvatureAt(ego.distance));
    if (trackCurvature > 0.004 && offLineDistance > 2.2) {
      desiredSpeed *= clamp(1 - (offLineDistance - 2.2) * 0.035, 0.82, 1);
    }
    const tireWear = ego.vehicle.wheels?.map((wheel) => finite(wheel.tyre?.wear, finite(wheel.wear))) ?? [];
    const limitingWear = tireWear.length >= 4
      ? Math.max((tireWear[0] + tireWear[1]) * 0.5, (tireWear[2] + tireWear[3]) * 0.5)
      : 0;
    if (limitingWear > 0.05) {
      const wearSlope = ego.classKey === 'touring' ? 1.1 : 0.85;
      desiredSpeed *= clamp(1 - (limitingWear - 0.05) * wearSlope, 0.68, 1);
    }
    if (plan.intent.mode === 'RECOVER') desiredSpeed = Math.min(desiredSpeed, 11);
    if (!plan.collisionFree && finite(plan.earliestCollisionTimeS, Infinity) < 0.45) {
      if (!(plan.intent.phase === 'SIDE_BY_SIDE' && plan.hardCollisionFree)) {
        const combatFloor = ['PASS', 'DEFEND', 'LAUNCH'].includes(plan.intent.mode) ? 8 : 5;
        desiredSpeed = Math.min(desiredSpeed, Math.max(combatFloor, ego.speed - 3));
      }
    }

    const lateralUtilization = clamp(Math.abs(ego.speed * ego.yawRate) / availableLateral, 0, 1.4);
    const speedError = desiredSpeed - ego.speed;
    let throttle = speedError > -0.4 ? clamp(0.48 + speedError * 0.24, 0, 1) : 0;
    let brake = speedError < -0.35 ? clamp((-speedError + 0.1) / 4.8, 0.1, 1) : 0;
    if (plan.intent.phase === 'BRAKE_FALLBACK') {
      throttle = 0;
      brake = Math.max(brake, 0.82);
    }
    // Once the chassis is rotating, piling on service brake unloads the rear
    // and converts a small slide into a spin—especially in the FWD Touring
    // car. Release trail brake progressively so the tyres can spend their
    // friction budget on restoring direction. A genuine blocked-corridor
    // fallback retains its emergency brake authority.
    if (ego.classKey === 'touring' && plan.intent.phase !== 'BRAKE_FALLBACK') {
      const slideBrakeRelease = clamp((Math.abs(slipAngle) - 3 * Math.PI / 180)
        / (9 * Math.PI / 180), 0, 0.88);
      brake *= 1 - slideBrakeRelease;
    }
    const longitudinalReserve = Math.sqrt(Math.max(0, 1 - Math.min(1, lateralUtilization) ** 2));
    throttle *= clamp(0.3 + longitudinalReserve * 0.85, 0.25, 1);
    if (brake > 0) throttle = 0;

    const drivenSlip = drivenWheelIndices(ego.vehicle).reduce((maximum, index) =>
      Math.max(maximum, Math.max(0, finite(ego.vehicle.wheels[index]?.slipRatio))), 0);
    // Vehicle owns the filtered, hysteretic traction-control loop. Keep this
    // instantaneous demand for telemetry; applying it here as a second torque
    // cut made low-speed corner exits needlessly anaemic.
    const slipTarget = finite(ego.vehicle.spec?.handling?.tcSlipTarget, 0.105);
    const tractionCut = clamp((drivenSlip - slipTarget) / 0.2, 0, 1);

    const speedEligible = ego.speed > (ego.classKey === 'touring' ? 7 : 12);
    const betaStart = ego.classKey === 'prototype' ? 5 : ego.classKey === 'touring' ? 2 : 3.5;
    const betaRange = ego.classKey === 'touring' ? 3.5 : 6.5;
    const betaDemand = clamp((Math.abs(slipAngle) - betaStart * Math.PI / 180)
      / (betaRange * Math.PI / 180), 0, 1);
    const yawDemand = clamp((Math.abs(yawError) - 0.35) / 0.65, 0, 1);
    const predictedLateralUtilization = ego.speed * ego.speed * Math.abs(localCurvature)
      / Math.max(1, availableLateral);
    const pathDemand = clamp((predictedLateralUtilization - 0.78) / 0.32, 0, 1);
    const correctionDemand = speedEligible ? Math.max(betaDemand, yawDemand) : 0;
    const escDemand = speedEligible ? Math.max(correctionDemand, pathDemand) : 0;
    const torqueCut = Math.min(0.82, escDemand * 0.82);
    const wheelBrake = [0, 0, 0, 0];
    if (correctionDemand > 0.01) {
      const correctionSign = Math.sign(slipAngle * 1.4 + yawError) || Math.sign(ego.yawRate) || 1;
      // Braking the right-front generates a positive corrective yaw moment;
      // braking the left-front generates a negative one in Vehicle's local
      // coordinate convention. This must oppose the measured sideslip/yaw
      // error, not reinforce it.
      const frontCorrectionWheel = correctionSign > 0 ? 1 : 0;
      wheelBrake[frontCorrectionWheel] = correctionDemand * 0.22;
      // Vehicle applies the bounded torque cut below; retain only a light
      // anticipatory lift here so ESC never becomes a duplicated full cut.
      throttle *= 1 - torqueCut * 0.45;
    }
    return {
      controls: { steer: agent.steerCommand, throttle: clamp(throttle, 0, 1),
        brake: clamp(brake, 0, 1), handbrake: 0 },
      stability: {
        torqueCut,
        wheelBrake,
        active: escDemand > 0.01,
        reason: escDemand > 0.01 ? (betaDemand >= yawDemand ? 'SIDESLIP' : 'YAW_ERROR') : 'STABLE',
        slipAngle,
        yawRateError: yawError,
        demand: Math.max(escDemand, tractionCut)
      },
      target,
      targetSpeed: desiredSpeed,
      headingError,
      lateralError,
      lateralUtilization,
      tractionCut
    };
  }
}
