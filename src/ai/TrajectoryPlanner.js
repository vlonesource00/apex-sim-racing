import { clamp, wrapAngle } from '../core/math.js';
import { AI_LIMITS, AI_TIMING, classDynamics, finite, lateralCapacity, minimumJerk } from './AIConfig.js';
import { signedDistance } from './RaceSnapshot.js';

const heading = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);

const uniqueIntents = (intents) => intents.filter((entry, index, values) =>
  values.findIndex((other) => other.phase === entry.phase
    && Math.abs(other.terminalLateral - entry.terminalLateral) < 0.08) === index);

export class TrajectoryPlanner {
  constructor(trackModel) {
    this.trackModel = trackModel;
  }

  _predictOpponent(other, entry, time, snapshot) {
    let acceleration = clamp((other.vehicle.localAcceleration?.z ?? 0), -8, 5);
    if (!other.player && other.speed < AI_LIMITS.stoppedSpeedMps
      && !other.previousIntent && snapshot.raceTime < 1.35) {
      acceleration = classDynamics(other.vehicle).accel * 0.82;
    }
    const forward = Math.max(0, other.forwardSpeed * time + 0.5 * acceleration * time * time);
    const target = finite(other.previousIntent?.targetLaneOffsetM, other.targetLateral);
    const lateral = other.player
      ? other.lateral + other.lateralSpeed * time
      : other.lateral + (target - other.lateral) * minimumJerk(time / 1.35);
    const effectivelyStationary = other.speed < AI_LIMITS.stoppedSpeedMps
      && Math.abs(other.lateralSpeed) < 0.25;
    return {
      longitudinal: entry.delta + forward,
      lateral,
      // Simulator opponents are exactly observed. A stopped obstacle does not
      // deserve an imaginary uncertainty halo that consumes the last usable
      // strip of asphalt and turns a legal flank into a permanent stop.
      uncertainty: effectivelyStationary ? 0.01
        : 0.055 + Math.abs(other.lateralSpeed) * time * 0.055 + time * 0.018
    };
  }

  _evaluate(snapshot, ego, traffic, intentValue, transitionTime) {
    const dynamics = classDynamics(ego.vehicle);
    const horizon = clamp(AI_TIMING.horizonSeconds + ego.speed * 0.012, 3.2, 4.1);
    let targetSpeed = clamp(finite(intentValue.desiredSpeed,
      this.trackModel.speedAt(ego.distance + 18, ego.vehicle)), 0, dynamics.topSpeed);
    const margin = Math.max(1.4, snapshot.track.roadHalfWidth - ego.halfWidth - AI_LIMITS.edgeSafetyM);
    const terminal = clamp(finite(intentValue.terminalLateral), -margin, margin);
    if (['PASS', 'DEFEND', 'LAUNCH'].includes(intentValue.mode)
      && Math.abs(terminal - ego.lateral) > 5.2) targetSpeed = Math.min(targetSpeed, 24);
    const settlingMove = ['LINE_RECOVERY', 'SAFE_REJOIN', 'DEFENSE_RELEASE', 'CLEAR', 'ABORT']
      .includes(intentValue.phase);
    const acceleration = clamp((targetSpeed - ego.speed) * 0.65, -dynamics.brake, dynamics.accel);
    const points = [];
    let roadViolation = 0;
    let collisionCount = 0;
    let hardCollisionCount = 0;
    let managedOccupancyCount = 0;
    let earliestCollisionTime = Infinity;
    let earliestHardCollisionTime = Infinity;
    let earliestManagedOccupancyTime = Infinity;
    let minimumClearance = 99;
    let minimumBodyClearance = 99;
    let proximityCost = 0;
    let maxLateralAcceleration = 0;
    let maxLateralUtilization = 0;
    let maxCurvature = 0;
    const followsOptimizedLine = intentValue.mode === 'PACE';
    const currentLineLateral = this.trackModel.lineAt(ego.distance);
    // Pace trajectories are a spatial path, not a fresh time-domain lane
    // change on every planning tick. Re-starting minimum jerk from the car's
    // current lateral position at 15 Hz creates a receding-horizon delay: the
    // car never commits to the opposite half of a chicane. Capture the line
    // within a short distance when already close, while still rate-limiting a
    // genuine off-line recovery over enough road to remain physical.
    const paceCaptureDistance = clamp(Math.max(10,
      Math.abs(ego.lateral - currentLineLateral) * Math.max(8, ego.speed) / 3.2), 10, 90);

    for (let index = 0; index < AI_TIMING.trajectoryPoints; index += 1) {
      const time = horizon * index / (AI_TIMING.trajectoryPoints - 1);
      const speed = clamp(ego.speed + acceleration * time, 0, dynamics.topSpeed);
      const forwardDistance = Math.max(0, ego.speed * time + 0.5 * acceleration * time * time);
      const reference = snapshot.track.atDistance(ego.distance + forwardDistance);
      const futureTerminal = followsOptimizedLine
        ? clamp(this.trackModel.lineAt(reference.s), -margin, margin)
        : terminal;
      const hasPersistentManeuver = !followsOptimizedLine
        && Number.isFinite(intentValue.maneuverOriginLateral)
        && Number.isFinite(intentValue.maneuverElapsedS);
      const maneuverStart = hasPersistentManeuver
        ? finite(intentValue.maneuverOriginLateral) : ego.lateral;
      const capture = followsOptimizedLine
        ? minimumJerk(forwardDistance / paceCaptureDistance)
        : minimumJerk((time + (hasPersistentManeuver
          ? Math.max(0, finite(intentValue.maneuverElapsedS)) : 0)) / transitionTime);
      const lateral = index === 0 ? ego.lateral
        : maneuverStart + (futureTerminal - maneuverStart) * capture;
      const legalLimit = snapshot.track.planningLateralLimit?.(reference.s, lateral, {
        halfWidthM: ego.halfWidth,
        safetyM: AI_LIMITS.edgeSafetyM
      }) ?? margin;
      if (Math.abs(lateral) > legalLimit) {
        const excess = Math.abs(lateral) - legalLimit;
        // A recovery starts outside the legal envelope by definition. It is
        // valid while every future point monotonically reduces that excess;
        // otherwise the safety sorter would choose BRAKE_FALLBACK forever and
        // strand a perfectly driveable car in the runoff.
        const monotonicallyRecentering = (intentValue.mode === 'RECOVER'
          || intentValue.phase === 'LINE_RECOVERY')
          && Math.abs(lateral) <= Math.abs(ego.lateral) + 0.05;
        if (!monotonicallyRecentering) roadViolation += excess;
      }
      const world = index === 0 ? ego.position : snapshot.track.lateralPoint(reference, lateral, 0.08);

      for (const entry of traffic) {
        const predicted = this._predictOpponent(entry.other, entry, time, snapshot);
        const egoLongitudinal = forwardDistance;
        const ds = predicted.longitudinal - egoLongitudinal;
        const dl = predicted.lateral - lateral;
        const longitudinalLimit = ego.halfLength + entry.other.halfLength + AI_LIMITS.longitudinalClearanceM;
        const lateralLimit = ego.halfWidth + entry.other.halfWidth + AI_LIMITS.sideClearanceM + predicted.uncertainty;
        const bodyLongitudinalLimit = ego.halfLength + entry.other.halfLength + 0.05;
        const bodyLateralLimit = ego.halfWidth + entry.other.halfWidth + 0.08;
        // The trailing car owns rear-end avoidance. Making the leader reject
        // every forward plan because a faster car is approaching from behind
        // causes the brake-check the field planner is meant to prevent.
        if (entry.delta < -longitudinalLimit * 0.65 && !entry.overlapLongitudinal) continue;
        const longitudinalClearance = Math.abs(ds) - longitudinalLimit;
        const lateralClearance = Math.abs(dl) - lateralLimit;
        const bodyLongitudinalClearance = Math.abs(ds) - bodyLongitudinalLimit;
        const bodyLateralClearance = Math.abs(dl) - bodyLateralLimit;
        const clearance = Math.max(longitudinalClearance, lateralClearance);
        minimumClearance = Math.min(minimumClearance, clearance);
        minimumBodyClearance = Math.min(minimumBodyClearance,
          Math.max(bodyLongitudinalClearance, bodyLateralClearance));
        // Existing light overlap is a state to escape, not a reason to mark
        // every possible plan unsafe. Judge collision feasibility after the
        // controller has had a few ticks to create separation; persistent or
        // converging occupancy is still rejected across the remaining horizon.
        const withinCollisionHorizon = time <= finite(intentValue.collisionHorizonS, horizon);
        if (withinCollisionHorizon && time > 0.22
          && longitudinalClearance < 0 && lateralClearance < 0) {
          const targetCombat = ['PASS', 'DEFEND', 'LAUNCH'].includes(intentValue.mode)
            && intentValue.targetId === entry.other.id;
          const bodyCollision = bodyLongitudinalClearance < 0 && bodyLateralClearance < 0;
          const currentBodyLateralClearance = Math.abs(entry.lateralDelta) - bodyLateralLimit;
          // A safety envelope is deliberately wider than the physical car.
          // Wheel-to-wheel cars inside that envelope are managed occupancy,
          // not an emergency. Physical-body intersections remain hard even
          // when a flank is opening: that makes the attacker finish the lane
          // change before it earns full throttle instead of leaning on cars.
          const managedOccupancy = targetCombat && !bodyCollision
            && currentBodyLateralClearance > 0.05 && bodyLateralClearance > 0.05;
          collisionCount += 1;
          earliestCollisionTime = Math.min(earliestCollisionTime, time);
          if (managedOccupancy) {
            managedOccupancyCount += 1;
            earliestManagedOccupancyTime = Math.min(earliestManagedOccupancyTime, time);
          } else {
            hardCollisionCount += 1;
            earliestHardCollisionTime = Math.min(earliestHardCollisionTime, time);
          }
        }
        else if (Math.abs(ds) < 14 && lateralClearance < 1.5) {
          proximityCost += (14 - Math.abs(ds)) * (1.5 - lateralClearance) * 18;
        }
      }
      points.push({ x: finite(world.x), y: finite(world.y), z: finite(world.z),
        s: reference.s, lateral, time, speed, predictedSpeed: speed, forwardDistance });
    }

    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const next = points[index + 1];
      const length = Math.max(0.6, Math.hypot(next.x - previous.x, next.z - previous.z) * 0.5);
      const signedCurvature = wrapAngle(heading(current, next) - heading(previous, current)) / length;
      const curvature = Math.abs(signedCurvature);
      current.curvature = curvature;
      current.signedCurvature = signedCurvature;
      maxCurvature = Math.max(maxCurvature, curvature);
      const lateralAcceleration = current.speed ** 2 * curvature;
      maxLateralAcceleration = Math.max(maxLateralAcceleration, lateralAcceleration);
      maxLateralUtilization = Math.max(maxLateralUtilization, lateralAcceleration
        / Math.max(1, lateralCapacity(ego.vehicle, current.speed, ego.wake.frontLoss)));
    }
    const lateralExcess = Math.max(0, maxLateralUtilization - 1.02);
    const progressReward = targetSpeed * 8 + finite(intentValue.priority) * 120;
    const movementCost = Math.abs(terminal - ego.lateral) * (intentValue.mode === 'LAUNCH' ? 10 : 4);
    const score = roadViolation * 1e8 + hardCollisionCount * 1e7 + managedOccupancyCount * 1e4 + proximityCost * 85
      + lateralExcess * lateralExcess * 12000 + movementCost + transitionTime * 2 - progressReward;
    return {
      vehicleId: ego.id,
      intent: intentValue,
      startLateral: ego.lateral,
      terminalLateral: terminal,
      transitionTimeS: transitionTime,
      targetSpeed,
      points,
      score,
      roadLegal: roadViolation < 1e-6,
      collisionFree: collisionCount === 0,
      hardCollisionFree: hardCollisionCount === 0,
      collisionResponse: hardCollisionCount > 0 ? 'HARD'
        : managedOccupancyCount > 0 ? 'MANAGED' : 'CLEAR',
      hardCollisionCount,
      managedOccupancyCount,
      earliestCollisionTimeS: earliestCollisionTime,
      earliestHardCollisionTimeS: earliestHardCollisionTime,
      earliestManagedOccupancyTimeS: earliestManagedOccupancyTime,
      dynamicallyFeasible: (intentValue.mode === 'RECOVER' || intentValue.mode === 'COOLDOWN'
        || intentValue.mode === 'PACE')
        || ego.speed < 10
        || ((!['PASS', 'DEFEND', 'LAUNCH'].includes(intentValue.mode)
          && Math.abs(terminal - ego.lateral) <= 8.5)
          || maxLateralUtilization <= (intentValue.mode === 'PASS' ? 1.15 : 1.08)),
      minimumClearanceM: minimumClearance,
      minimumBodyClearanceM: minimumBodyClearance,
      maxCurvaturePerM: maxCurvature,
      maxLateralAccelerationMps2: maxLateralAcceleration
    };
  }

  proposalsFor(snapshot, agent, intents) {
    const ego = snapshot.ego(agent.vehicleId);
    if (!ego) return [];
    const traffic = snapshot.trafficFor(agent.vehicleId, 120);
    const proposals = [];
    for (const intentValue of uniqueIntents(intents)) {
      const delta = Math.abs(finite(intentValue.terminalLateral) - ego.lateral);
      const obstacleBypass = intentValue.mode === 'PASS'
        && intentValue.reason?.startsWith('OBSTACLE_BYPASS');
      const settlingMove = ['LINE_RECOVERY', 'SAFE_REJOIN', 'DEFENSE_RELEASE', 'CLEAR', 'ABORT']
        .includes(intentValue.phase);
      let baseTransition = obstacleBypass && ego.speed < 12
        ? clamp(0.46 + Math.sqrt(delta) * 0.16, 0.62, 0.92)
        : clamp(0.85 + Math.sqrt(delta) * 0.42 + ego.speed * 0.004,
          intentValue.mode === 'RECOVER' ? 0.9 : 1.05, 2.6);
      const targetTraffic = intentValue.targetId
        ? traffic.find((entry) => entry.other.id === intentValue.targetId) : null;
      if (intentValue.urgentPass && targetTraffic?.delta > 0
        && targetTraffic.closingSpeed > 0.2) {
        baseTransition = Math.min(baseTransition,
          clamp((targetTraffic.ttc - 0.1) * 0.82, 0.62, 1.25));
      }
      // Bound commanded lateral target rate. Combat can use the full 3.2 m/s
      // envelope; post-combat recentering is deliberately smoother so a wide
      // line never becomes a snap across the circuit.
      const lateralRate = intentValue.urgentPass
        ? ego.classKey === 'prototype' ? 4.2 : ego.classKey === 'gt' ? 3.6 : 3.0
        : 3.2;
      baseTransition = Math.max(baseTransition, delta / (settlingMove ? 2.55 : lateralRate));
      const scales = obstacleBypass ? [0.82, 1, 1.25, 1.55]
        : intentValue.committed ? [1, 1.3, 1.65] : [0.9, 1.15, 1.4, 1.7];
      for (const scale of scales) proposals.push(this._evaluate(snapshot, ego, traffic, intentValue, baseTransition * scale));
    }
    // Normal pace never abandons the optimized line for a centreline crutch.
    // A recentering candidate exists only when every requested trajectory is
    // geometrically outside the legal road envelope.
    if (!proposals.some((proposal) => proposal.roadLegal)) {
      proposals.push(this._evaluate(snapshot, ego, traffic, {
        mode: 'RETURN', phase: 'LINE_RECOVERY', targetId: null,
        terminalLateral: 0, priority: 5, committed: false,
        desiredSpeed: Math.min(18, this.trackModel.speedAt(ego.distance + 18, ego.vehicle)),
        reason: 'RESTORE_LEGAL_RACING_LINE'
      }, 1.05));
    }
    const closestAhead = traffic.find((entry) => entry.delta > 0
      && Math.abs(entry.lateralDelta) < ego.halfWidth + entry.other.halfWidth + 0.8);
    const fallbackGap = closestAhead
      ? ego.halfLength + closestAhead.other.halfLength + 5 + ego.speed * 0.38 : 0;
    const fallbackSpeed = closestAhead
      ? Math.max(0, closestAhead.other.forwardSpeed
        + clamp((closestAhead.delta - fallbackGap) * 0.55, -12, 0))
      : Math.max(0, ego.speed - 8);
    const fallback = this._evaluate(snapshot, ego, traffic, {
      mode: 'BRAKE', phase: 'BRAKE_FALLBACK', targetId: null,
      terminalLateral: ego.lateral, priority: 0, committed: false,
      desiredSpeed: fallbackSpeed,
      reason: 'NO_SAFE_CORRIDOR'
    }, 1.4);
    proposals.push(fallback);
    return proposals.sort((a, b) => {
      const safeA = a.roadLegal && a.collisionFree && a.dynamicallyFeasible ? 0 : 1;
      const safeB = b.roadLegal && b.collisionFree && b.dynamicallyFeasible ? 0 : 1;
      const brakeA = a.intent.phase === 'BRAKE_FALLBACK' ? 1 : 0;
      const brakeB = b.intent.phase === 'BRAKE_FALLBACK' ? 1 : 0;
      return safeA - safeB || brakeA - brakeB || a.score - b.score
        || a.intent.phase.localeCompare(b.intent.phase);
    });
  }

  trajectoriesConflict(a, b, trackLength) {
    const count = Math.min(a.points.length, b.points.length);
    const vehicleA = a._vehicle;
    const vehicleB = b._vehicle;
    const longitudinal = finite(vehicleA?.collisionHalfLength, 2.55)
      + finite(vehicleB?.collisionHalfLength, 2.55) + AI_LIMITS.longitudinalClearanceM;
    const lateral = finite(vehicleA?.collisionHalfWidth, 1.02)
      + finite(vehicleB?.collisionHalfWidth, 1.02) + AI_LIMITS.sideClearanceM;
    for (let index = 1; index < count; index += 1) {
      const ds = Math.abs(signedDistance(a.points[index].s, b.points[index].s, trackLength));
      const dl = Math.abs(a.points[index].lateral - b.points[index].lateral);
      if (ds < longitudinal && dl < lateral) return true;
    }
    return false;
  }
}
