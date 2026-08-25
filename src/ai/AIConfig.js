export const AI_TIMING = Object.freeze({
  physicsHz: 120,
  trajectoryIntervalTicks: 8,
  tacticalIntervalTicks: 8,
  horizonSeconds: 3.2,
  trajectoryPoints: 24
});

export const AI_LIMITS = Object.freeze({
  sideClearanceM: 0.72,
  longitudinalClearanceM: 0.35,
  edgeSafetyM: 0.18,
  stoppedSpeedMps: 2,
  obstacleSpeedRatio: 0.35,
  obstacleLookaheadM: 72,
  attackLookaheadM: 52,
  defenseLookbehindM: 38,
  meaningfulOverlapM: 1.0,
  marshalTimeoutS: 5,
  launchDurationS: 2.5,
  launchDistanceM: 60
});

export const CLASS_DYNAMICS = Object.freeze({
  prototype: Object.freeze({ lateralBase: 21.5, lateralMax: 34, aeroUtilization: 0.78, cornerFactor: 0.98,
    brake: 17.5, accel: 9.0, topSpeed: 76 }),
  gt: Object.freeze({ lateralBase: 15.6, lateralMax: 18, aeroUtilization: 0.68, cornerFactor: 1,
    brake: 8.5, accel: 7.2, topSpeed: 62 }),
  touring: Object.freeze({ lateralBase: 10.2, lateralMax: 11.0, aeroUtilization: 0.52, cornerFactor: 1,
    brake: 8.0, accel: 7.5, topSpeed: 53 })
});

export const MANEUVER_PRIORITY = Object.freeze({
  EMERGENCY: 100,
  RECOVER: 90,
  PIT: 85,
  LAUNCH: 80,
  SIDE_BY_SIDE: 72,
  COMMITTED_ATTACK: 68,
  DEFEND: 58,
  ATTACK: 52,
  DRAFT: 36,
  RETURN: 24,
  PACE: 10,
  BRAKE_FALLBACK: 0
});

export const ATTACK_PHASES = new Set([
  'PULL_OUT_LEFT', 'PULL_OUT_RIGHT', 'ATTACK_INSIDE', 'ATTACK_OUTSIDE',
  'DIVEBOMB', 'SWITCHBACK', 'GRID_BYPASS', 'OBSTACLE_BYPASS', 'SIDE_BY_SIDE', 'CLEAR'
]);

export const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export const minimumJerk = (value) => {
  const u = Math.max(0, Math.min(1, finite(value)));
  return u * u * u * (10 + u * (-15 + u * 6));
};

export function classDynamics(vehicle) {
  return CLASS_DYNAMICS[vehicle?.classKey] ?? CLASS_DYNAMICS.gt;
}

export function lateralCapacity(vehicle, speed, frontDownforceLoss = 0) {
  const dynamics = classDynamics(vehicle);
  const spec = vehicle?.spec ?? {};
  const aero = spec.aero ?? {};
  const coefficient = 0.5 * 1.225 * finite(aero.area) * (
    finite(aero.frontCl) * (1 - clamp01(frontDownforceLoss))
    + finite(aero.rearCl) + finite(aero.groundEffect)
  ) / Math.max(1, finite(spec.mass, 1200));
  const aeroAcceleration = coefficient * speed * speed * dynamics.aeroUtilization;
  const wheels = vehicle?.wheels ?? [];
  const axleWear = wheels.length >= 4 ? [
    (finite(wheels[0].tyre?.wear, finite(wheels[0].wear))
      + finite(wheels[1].tyre?.wear, finite(wheels[1].wear))) * 0.5,
    (finite(wheels[2].tyre?.wear, finite(wheels[2].wear))
      + finite(wheels[3].tyre?.wear, finite(wheels[3].wear))) * 0.5
  ] : [0];
  const limitingWear = Math.max(...axleWear);
  const wearFactor = Math.max(0.58, 1 - limitingWear * 0.43);
  return Math.min(dynamics.lateralMax, dynamics.lateralBase + aeroAcceleration) * wearFactor;
}

export function cornerSpeedFor(vehicle, curvature, frontDownforceLoss = 0) {
  const dynamics = classDynamics(vehicle);
  const demand = Math.max(0.00001, finite(curvature));
  let low = 0;
  let high = dynamics.topSpeed;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const speed = (low + high) * 0.5;
    if (speed * speed * demand <= lateralCapacity(vehicle, speed, frontDownforceLoss)) low = speed;
    else high = speed;
  }
  return low < dynamics.topSpeed * 0.995 ? low * dynamics.cornerFactor : low;
}

const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));
