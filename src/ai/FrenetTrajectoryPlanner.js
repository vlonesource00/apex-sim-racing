import { clamp, wrapAngle } from '../core/math.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const PASS_PHASES = new Set(['ATTACK_LEFT', 'ATTACK_RIGHT']);

// Minimum-jerk lateral interpolation. Position, velocity and acceleration are
// continuous at both ends, unlike a direct line-offset ramp.
const minimumJerk = (value) => {
  const u = clamp(value, 0, 1);
  return u * u * u * (10 + u * (-15 + u * 6));
};

const uniqueOffsets = (values, minimum, maximum) => {
  const result = [];
  for (const value of values) {
    const bounded = clamp(finite(value), minimum, maximum);
    if (!result.some((entry) => Math.abs(entry - bounded) < 0.08)) result.push(bounded);
  }
  return result;
};

const worldHeading = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);

export class FrenetTrajectoryPlanner {
  constructor({ pointCount = 24, horizonS = 3.4 } = {}) {
    this.pointCount = Math.max(12, Math.trunc(pointCount));
    this.horizonS = Math.max(3.2, finite(horizonS, 3.4));
  }

  _candidate({
    vehicle, track, startLateral, terminalLateral, desiredOffset, transitionTime,
    targetSpeed, trafficEntries, roadMargin, committed, aggression, horizon, targetId,
    referenceLineAtDistance
  }) {
    const points = [];
    const startSpeed = Math.max(0, finite(vehicle.speed));
    const acceleration = clamp((finite(targetSpeed, startSpeed) - startSpeed) * 0.42, -6.5, 4.6);
    let roadViolation = 0;
    let edgeRisk = 0;
    let collisionRisk = 0;
    let predictedCollisions = 0;
    let minimumClearance = 99;
    let futureMinimumClearance = 99;
    let maxLateralAcceleration = 0;
    let maxCurvature = 0;

    for (let index = 0; index < this.pointCount; index += 1) {
      const time = horizon * index / (this.pointCount - 1);
      const predictedSpeed = clamp(startSpeed + acceleration * time, 0, 90);
      const forwardDistance = Math.max(0, startSpeed * time + 0.5 * acceleration * time * time);
      const blend = minimumJerk(time / Math.max(0.25, transitionTime));
      const reference = track.atDistance(vehicle.distance + forwardDistance);
      const followsReference = typeof referenceLineAtDistance === 'function'
        && Math.abs(terminalLateral - desiredOffset) < 0.08;
      const guidedLateral = followsReference
        ? clamp(finite(referenceLineAtDistance(reference.s), terminalLateral), -roadMargin, roadMargin)
        : terminalLateral;
      const lateral = startLateral + (guidedLateral - startLateral) * blend;
      const world = index === 0
        ? { x: finite(vehicle.position.x), y: finite(vehicle.position.y) + 0.08, z: finite(vehicle.position.z) }
        : track.lateralPoint(reference, lateral, 0.08);
      const surfaceLimit = Math.min(roadMargin,
        finite(track.planningLateralLimit?.(reference.s, lateral), roadMargin));
      if (Math.abs(lateral) > surfaceLimit) roadViolation += Math.abs(lateral) - surfaceLimit + 1;
      edgeRisk += Math.max(0, Math.abs(lateral) - (surfaceLimit - 0.45)) ** 2;

      for (const entry of trafficEntries) {
        if (!entry?.other || entry.other.finished || entry.other.despawned || entry.other.trafficGhost) continue;
        const opponentProgress = Math.max(0, finite(entry.other.speed) * time);
        const longitudinalGap = finite(entry.delta) + opponentProgress - forwardDistance;
        const opponentStart = finite(entry.other.surface?.lateral,
          startLateral + finite(entry.lateralDelta));
        const opponentTarget = finite(entry.other.aiTarget?.lateral, opponentStart);
        const opponentLateral = opponentStart
          + (opponentTarget - opponentStart) * minimumJerk(time / 1.35);
        const lateralGap = Math.abs(lateral - opponentLateral);
        const longitudinalClearance = Math.abs(longitudinalGap) - 5.2;
        const lateralClearance = lateralGap - 3.05;
        const combinedClearance = Math.max(longitudinalClearance, lateralClearance);
        minimumClearance = Math.min(minimumClearance, combinedClearance);
        if (time >= 0.45) futureMinimumClearance = Math.min(futureMinimumClearance, combinedClearance);
        const isPassTarget = targetId !== null && entry.other.id === targetId;
        const initialTargetSeparation = Math.abs(startLateral - opponentStart);
        const separatingPassTrajectory = isPassTarget
          && Math.abs(terminalLateral - opponentStart) >= 3.45
          && lateralGap >= initialTargetSeparation - 0.08;
        // The longitudinal controller coordinates arrival at the target's
        // rear axle. A pass target must not invalidate an otherwise legal
        // lane change merely because its swept box is initially ahead of us.
        if (longitudinalClearance < 0 && lateralClearance < 0 && !separatingPassTrajectory) {
          predictedCollisions += 1;
          collisionRisk += 25000 + (-longitudinalClearance + 0.2) * (-lateralClearance + 0.2) * 2200;
        } else if (Math.abs(longitudinalGap) < 11 && lateralClearance < 1.4) {
          collisionRisk += (11 - Math.abs(longitudinalGap)) * (1.4 - lateralClearance) * 18;
        }
      }

      points.push({
        x: finite(world.x), y: finite(world.y), z: finite(world.z),
        s: finite(reference.s), lateral: finite(lateral), time: finite(time),
        speed: finite(predictedSpeed), predictedSpeed: finite(predictedSpeed),
        forwardDistance: finite(forwardDistance)
      });
    }

    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const next = points[index + 1];
      const segment = Math.max(0.5, Math.hypot(next.x - previous.x, next.z - previous.z) * 0.5);
      const curvature = Math.abs(wrapAngle(worldHeading(current, next) - worldHeading(previous, current))) / segment;
      current.curvature = curvature;
      maxCurvature = Math.max(maxCurvature, curvature);
      maxLateralAcceleration = Math.max(maxLateralAcceleration, current.predictedSpeed ** 2 * curvature);
    }

    const lateralDelta = Math.abs(terminalLateral - startLateral);
    const availableLateralAcceleration = 7.5 + aggression * 4.5;
    const accelerationExcess = Math.max(0, maxLateralAcceleration - availableLateralAcceleration);
    const intentWeight = committed ? 180 : 42;
    const intentError = Math.abs(terminalLateral - desiredOffset);
    const transitionPreference = committed ? transitionTime * 1.4 : transitionTime * 0.22;
    const score = roadViolation * 1e6 + collisionRisk + edgeRisk * 60
      + intentError * intentError * intentWeight
      + accelerationExcess * accelerationExcess * 8
      + lateralDelta * 0.18 + transitionPreference;

    return {
      points, score, terminalLateral, transitionTime,
      collisionFree: predictedCollisions === 0,
      roadLegal: roadViolation < 1e-6,
      minimumClearanceM: minimumClearance,
      futureMinimumClearanceM: futureMinimumClearance,
      maxCurvaturePerM: maxCurvature,
      maxLateralAccelerationMps2: maxLateralAcceleration
    };
  }

  plan({
    vehicle, track, desiredOffset = 0, fallbackOffsets = [], trafficEntries = [],
    targetSpeed = vehicle?.speed ?? 0, aggression = 0.5, racecraftPhase = 'NONE', targetId = null,
    recovering = false, pitActive = false, urgent = false, roadMargin = null,
    lookAhead = 12, trackingDistance = null, referenceLineAtDistance = null
  }) {
    const currentLateral = finite(vehicle?.surface?.lateral);
    const maximumSurfaceMargin = finite(track?.roadHalfWidth, 6.5) - 1.18
      + Math.min(0.42, finite(track?.curbWidth) * 0.32);
    const margin = Math.max(1.8, finite(roadMargin, maximumSurfaceMargin));
    const intendedOffset = clamp(finite(desiredOffset), -margin, margin);
    const committed = pitActive || PASS_PHASES.has(racecraftPhase);
    const urgentManeuver = committed || recovering || urgent;
    const offsets = uniqueOffsets(
      urgentManeuver
        ? [intendedOffset]
        : [intendedOffset, ...fallbackOffsets, currentLateral],
      -margin, margin
    );
    const lateralDelta = Math.abs(intendedOffset - currentLateral);
    const availableLateralAcceleration = 7.5 + clamp(finite(aggression, 0.5), 0, 1) * 4.5;
    const physicalMinimum = Math.sqrt(5.78 * lateralDelta / Math.max(2, availableLateralAcceleration));
    const nominalTransition = clamp(
      physicalMinimum * (urgentManeuver ? 1.01 : 1.08) + (urgentManeuver ? 0.02 : 0.3),
      urgentManeuver ? 0.76 : 1.25,
      urgentManeuver ? 2.35 : 3.0
    );
    const transitionScales = urgentManeuver ? [0.84, 1, 1.18] : [1, 1.24];
    const horizon = Math.max(this.horizonS,
      finite(lookAhead, 12) / Math.max(5, finite(vehicle?.speed)));
    const candidates = [];
    for (const terminalLateral of offsets) {
      for (const scale of transitionScales) {
        candidates.push(this._candidate({
          vehicle, track, startLateral: currentLateral, terminalLateral,
          desiredOffset: intendedOffset, transitionTime: nominalTransition * scale,
          targetSpeed, trafficEntries, roadMargin: margin,
          aggression: clamp(finite(aggression, 0.5), 0, 1), horizon, targetId,
          referenceLineAtDistance,
          committed: urgentManeuver
        }));
      }
    }
    candidates.sort((a, b) => a.score - b.score
      || Math.abs(a.terminalLateral - intendedOffset) - Math.abs(b.terminalLateral - intendedOffset)
      || a.transitionTime - b.transitionTime);
    const safeCandidates = candidates.filter((candidate) => candidate.collisionFree && candidate.roadLegal);
    const selected = safeCandidates[0] ?? [...candidates].sort((a, b) =>
      b.futureMinimumClearanceM - a.futureMinimumClearanceM || a.score - b.score)[0];
    // A committed car looks farther through its already validated trajectory.
    // Looking at the near point made the steering controller visibly wait for
    // the minimum-jerk curve to develop even though the tactical planner had
    // already selected the adjacent lane.
    const pursuitDistance = clamp(finite(trackingDistance, finite(lookAhead, 12) * 0.72), 5.5, 24);
    let trackingIndex = selected.points.findIndex((point) => point.forwardDistance >= pursuitDistance);
    if (trackingIndex < 1) trackingIndex = Math.min(selected.points.length - 1, 2);
    const trackingPoint = selected.points[trackingIndex];
    return {
      points: selected.points,
      trackingPoint,
      trackingIndex,
      selectedOffset: selected.terminalLateral,
      requestedOffset: intendedOffset,
      transitionTimeS: selected.transitionTime,
      score: selected.score,
      candidateCount: candidates.length,
      collisionFree: selected.collisionFree,
      roadLegal: selected.roadLegal,
      minimumClearanceM: selected.minimumClearanceM,
      futureMinimumClearanceM: selected.futureMinimumClearanceM,
      maxCurvaturePerM: selected.maxCurvaturePerM,
      maxLateralAccelerationMps2: selected.maxLateralAccelerationMps2,
      committed,
      recovering: Boolean(recovering)
    };
  }
}

export { minimumJerk };
