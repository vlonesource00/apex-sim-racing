import { clamp, wrap, wrapAngle } from '../core/math.js';
import { FrenetTrajectoryPlanner } from '../ai/FrenetTrajectoryPlanner.js';
import { TrafficAwareness } from '../ai/TrafficAwareness.js';
import { RacecraftPlanner } from '../ai/RacecraftPlanner.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const offRoad = (surface) => surface?.zone === 'grass' || surface?.zone === 'runoff';

/** Fixed-step physical driver: one traffic model and one manoeuvre own both axes. */
export class AIController {
  constructor(index = 1) {
    this.index = index;
    this.skill = 0.76 + ((index * 37) % 21) / 100;
    this.aggression = 0.68 + ((index * 19) % 29) / 100;
    this.awareness = new TrafficAwareness();
    this.racecraft = new RacecraftPlanner(index);
    this.trajectoryPlanner = new FrenetTrajectoryPlanner();
    this.trajectoryPlan = null;
    this.debugEnabled = false;
    this.debugState = null;
    this._debugPlanPath = [];
    this._debugPathClock = Infinity;
    this.tacticalPolicy = null;
    this.tacticalPolicyAge = Infinity;
    this.steerCommand = 0;
    this.lastDistance = null;
    this.stallTime = 0;
    this.recoveryTimer = 0;
    this.recovery = 0;
    this.marshalRecoveries = 0;
    this.passPhase = 'NONE';
    this.passTime = 0;
    this.passTargetId = null;
    this.passOffset = 0;
    this.passSide = 0;
    this.passIntent = null;
    this.draftTargetId = null;
    this.draftAge = 0;
    this.draftWakeStrength = 0;
    this.draftWakeSource = null;
    this.insideLaneOffset = 0;
    this.outsideLaneOffset = 0;
    this.insideLaneClear = false;
    this.outsideLaneClear = false;
    this.upcomingTurnSign = 0;
    this.upcomingCurvature = 0;
    this.trafficThreat = 'CLEAR';
    this.trafficTTC = 99;
    this.predictedLateralSeparation = 99;
    this.referenceProfile = null;
  }

  setReferenceProfile(profile = null) {
    this.referenceProfile = profile && typeof profile.targetAtDistance === 'function' ? profile : null;
    return Boolean(this.referenceProfile);
  }

  setDebugEnabled(enabled) {
    this.debugEnabled = Boolean(enabled);
    if (!this.debugEnabled) {
      this.debugState = null;
      this._debugPlanPath.length = 0;
      this._debugPathClock = Infinity;
    } else this._debugPathClock = Infinity;
    return this.debugEnabled;
  }

  setTacticalPolicy(decision = null) {
    if (!decision || decision.source !== 'RL') {
      this.tacticalPolicy = null;
      this.tacticalPolicyAge = Infinity;
      return false;
    }
    this.tacticalPolicy = Object.freeze({
      lineOffset: clamp(finite(decision.lineOffset), -1, 1),
      pace: clamp(finite(decision.pace), -1, 1),
      aggression: clamp(finite(decision.aggression), -1, 1),
      ersStrategy: clamp(finite(decision.ersStrategy), -1, 1),
      safetyIntervention: clamp(finite(decision.safetyIntervention), 0, 2)
    });
    this.tacticalPolicyAge = 0;
    return true;
  }

  _summary(entry) {
    if (!entry) return null;
    return {
      id: entry.other?.id ?? null, name: entry.other?.name ?? null,
      deltaM: finite(entry.delta), lateralDeltaM: finite(entry.lateralDelta),
      longitudinalM: finite(entry.longitudinal), sideM: finite(entry.side), directM: finite(entry.direct),
      relativeSpeedMps: finite(entry.relativeSpeed),
      relativeLongitudinalVelocityMps: finite(entry.relativeLongitudinalVelocity),
      relativeLateralVelocityMps: finite(entry.relativeLateralVelocity),
      ttc: finite(entry.ttc, 99), predictedLateralSeparationM: finite(entry.predictedSide, 99)
    };
  }

  _debug(vehicle, { mode, reason, desiredSpeed, targetOffset, target, headingError,
    lateralError, traffic, hazard, recovering, decision, aggression, dt }) {
    if (!this.debugEnabled) return;
    this._debugPathClock += dt;
    this._debugPlanPath = (this.trajectoryPlan?.points ?? []).map((point) => ({
      x: finite(point.x), y: finite(point.y), z: finite(point.z), s: finite(point.s),
      lateral: finite(point.lateral), time: finite(point.time), speed: finite(point.speed),
      predictedSpeed: finite(point.predictedSpeed)
    }));
    const controls = { throttle: finite(vehicle.controls.throttle), brake: finite(vehicle.controls.brake),
      steer: finite(vehicle.controls.steer), handbrake: finite(vehicle.controls.handbrake) };
    this.debugState = {
      vehicleId: vehicle.id, name: vehicle.name, classKey: vehicle.classKey,
      skill: finite(this.skill), aggression: finite(aggression, this.aggression),
      mode, reason, currentSpeed: finite(vehicle.speed), speedKmh: finite(vehicle.speed * 3.6),
      desiredSpeed: finite(desiredSpeed), targetSpeed: finite(desiredSpeed),
      speedError: finite(desiredSpeed - vehicle.speed), targetOffset: finite(targetOffset),
      lineOffset: finite(targetOffset), headingError: finite(headingError), lateralError: finite(lateralError),
      recovery: finite(this.recoveryTimer), recoveryTimer: finite(this.recoveryTimer),
      stallTime: finite(this.stallTime), stallTimer: finite(this.stallTime), recovering: Boolean(recovering),
      passTime: finite(this.passTime), passTimer: finite(this.passTime), passOffset: finite(this.passOffset),
      passSide: finite(this.passSide), passIntent: this.passIntent ? { ...this.passIntent } : null,
      racecraftPhase: this.passPhase, phase: this.passPhase,
      draftTime: finite(this.racecraft.draftAge), draftAge: finite(this.racecraft.draftAge),
      draftTargetId: this.draftTargetId, draftWakeStrength: finite(this.draftWakeStrength),
      draftWakeSource: this.draftWakeSource, wakeStrength: finite(this.draftWakeStrength), wakeSource: this.draftWakeSource,
      upcomingTurnSign: finite(this.upcomingTurnSign), upcomingCurvature: finite(this.upcomingCurvature),
      insideLaneOffset: finite(this.insideLaneOffset), outsideLaneOffset: finite(this.outsideLaneOffset),
      insideLaneClear: Boolean(this.insideLaneClear), outsideLaneClear: Boolean(this.outsideLaneClear),
      trafficThreat: this.trafficThreat, trafficTTC: finite(this.trafficTTC, 99), ttc: finite(this.trafficTTC, 99),
      predictedLateralSeparationM: finite(this.predictedLateralSeparation, 99), predictedSeparationM: finite(this.predictedLateralSeparation, 99),
      closeFront: this._summary(traffic.ahead), closeBehind: this._summary(traffic.behind), nearestSide: this._summary(traffic.alongside),
      target: { x: finite(target.x), y: finite(target.y), z: finite(target.z), lateral: finite(targetOffset) },
      controls, planPath: this._debugPlanPath, path: this._debugPlanPath, trajectory: this.trajectoryPlan,
      trajectoryRequestedOffsetM: finite(this.trajectoryPlan?.requestedOffset),
      trajectorySelectedOffsetM: finite(this.trajectoryPlan?.selectedOffset),
      trajectoryTransitionS: finite(this.trajectoryPlan?.transitionTimeS), trajectoryScore: finite(this.trajectoryPlan?.score),
      trajectoryCandidateCount: finite(this.trajectoryPlan?.candidateCount),
      trajectoryCollisionFree: Boolean(this.trajectoryPlan?.collisionFree), trajectoryRoadLegal: Boolean(this.trajectoryPlan?.roadLegal),
      trajectoryMinimumClearanceM: finite(this.trajectoryPlan?.minimumClearanceM, 99),
      trajectoryFutureClearanceM: finite(this.trajectoryPlan?.futureMinimumClearanceM, 99),
      trajectoryMaxLateralAccelerationMps2: finite(this.trajectoryPlan?.maxLateralAccelerationMps2),
      corridorBlockerId: decision.corridor?.blockerId ?? null,
      corridorMinimumClearanceM: finite(decision.corridor?.minimumClearanceM, 99),
      waitReason: decision.waitReason ?? null, abortReason: decision.abortReason ?? null,
      hazardId: hazard?.other.id ?? null,
      tacticalPolicy: this.tacticalPolicy ? { source: 'RL_HYBRID', ...this.tacticalPolicy } : null
    };
  }

  update(vehicle, vehicles, track, race, dt) {
    this.tacticalPolicyAge += dt;
    if (race.phase !== 'racing') {
      vehicle.controls = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
      return;
    }
    if (vehicle.finished) return this._cooldown(vehicle, track, dt);

    const traffic = this.awareness.scan(vehicle, vehicles, track);
    const current = traffic.current;
    const isOffTrack = offRoad(current);
    // Intervene before all four tyres leave the asphalt. Planned lanes stop at
    // this margin; crossing it by more than a metre means the car is no longer
    // tracking its trajectory, even if the coarse surface classifier still
    // labels the outer shoulder as road.
    const plannedRoadMargin = Math.max(2.1, finite(track.roadHalfWidth, 6.5) - 1.75);
    const edgeDeviation = Math.abs(finite(current.lateral)) > plannedRoadMargin + 1.05;
    if (this.lastDistance === null) this.lastDistance = vehicle.distance;
    const progress = wrap(vehicle.distance - this.lastDistance + track.length * 0.5, track.length) - track.length * 0.5;
    this.lastDistance = vehicle.distance;
    const queued = traffic.ahead && traffic.ahead.delta < 12;
    this.stallTime = vehicle.speed < 2.2 && progress < 0.25 && !queued ? this.stallTime + dt : Math.max(0, this.stallTime - dt * 2);
    if (isOffTrack) this.recoveryTimer = 1.2;
    else this.recoveryTimer = Math.max(0, this.recoveryTimer - dt);
    this.recovery = this.recoveryTimer;
    const recovering = isOffTrack || edgeDeviation || this.recoveryTimer > 0 || this.stallTime > 0.7;
    if (isOffTrack && this.stallTime > 5 && vehicle.marshalRecoverTo) {
      vehicle.marshalRecoverTo(track, vehicle.distance + 9, 0);
      this.marshalRecoveries += 1;
      this.stallTime = 0;
      this.recoveryTimer = 1;
      return;
    }

    const policy = this.tacticalPolicyAge < 0.4 ? this.tacticalPolicy : null;
    const aggression = clamp(this.aggression + finite(policy?.aggression) * 0.1, 0.55, 0.98);
    const policyLine = finite(policy?.lineOffset) * 1.15;
    const decision = this.racecraft.update({ vehicle, track, traffic, awareness: this.awareness, dt,
      aggression, policyLine, recovering, pitIntent: vehicle.pitIntent });
    this.passPhase = ['PIT', 'RECOVER'].includes(decision.phase) ? 'NONE' : decision.phase;
    this.passTargetId = this.racecraft.targetId;
    this.passOffset = finite(decision.desiredOffset);
    this.passSide = this.racecraft.side;
    this.passIntent = this.racecraft.intent;
    this.passTime = this.racecraft.attacking ? Math.max(0, 8 - this.racecraft.age) : this.passPhase === 'RETURN' ? this.racecraft.timer : 0;
    this.draftTargetId = this.passPhase === 'DRAFT' ? decision.target?.other.id ?? null : null;
    this.draftAge = this.racecraft.draftAge;
    this.draftWakeStrength = this.draftTargetId && String(vehicle.wake?.sourceId ?? '') === String(this.draftTargetId)
      ? clamp(finite(vehicle.wake?.strength), 0, 1) : 0;
    this.draftWakeSource = this.draftWakeStrength > 0.005 ? vehicle.wake?.sourceId ?? null : null;

    const turns = [18, 34, 52].map((distance) => track.atDistance(vehicle.distance + distance));
    const turn = turns.sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
    this.upcomingCurvature = Math.abs(finite(turn.curvature));
    this.upcomingTurnSign = Math.sign(finite(turn.turnSign));
    const frontLateral = finite(decision.target?.otherLateral, finite(current.lateral));
    const roadMargin = plannedRoadMargin;
    this.insideLaneOffset = clamp(frontLateral + (this.upcomingTurnSign || 1) * 3.9, -roadMargin, roadMargin);
    this.outsideLaneOffset = clamp(frontLateral - (this.upcomingTurnSign || 1) * 3.9, -roadMargin, roadMargin);
    this.insideLaneClear = decision.committed && Math.abs(decision.desiredOffset - this.insideLaneOffset) < 0.2;
    this.outsideLaneClear = decision.committed && Math.abs(decision.desiredOffset - this.outsideLaneOffset) < 0.2;

    const yieldingRejoin = isOffTrack && traffic.behind && traffic.behind.other.speed > vehicle.speed + 4 && traffic.behind.delta > -20;
    // Reserve side-by-side space before the OBBs overlap.  Waiting until the
    // nearest-car helper reports an already-alongside body made two returning
    // cars brake only after their doors were touching.  A committed pass owns
    // its chosen corridor; every other close lateral convergence is resolved
    // here with deterministic longitudinal priority.
    const sideEntry = traffic.entries
      .filter((entry) => entry.other.id !== decision.target?.other.id || !(decision.committed || decision.defending))
      .filter((entry) => Math.abs(entry.longitudinal) < 8.5 && entry.direct < 10.5)
      .filter((entry) => Math.abs(finite(current.lateral) - finite(entry.otherLateral)) < 4.15)
      .sort((a, b) => a.direct - b.direct)[0] ?? null;
    const sideSeparation = sideEntry ? Math.abs(finite(current.lateral) - finite(sideEntry.otherLateral)) : 99;
    const sideConflict = Boolean(sideEntry && sideSeparation < 4.15);
    const awaySign = sideConflict
      ? Math.sign(finite(current.lateral) - finite(sideEntry.otherLateral))
        || (String(vehicle.id) > String(sideEntry.other.id) ? 1 : -1)
      : 0;
    const separationOffset = sideConflict
      ? clamp(finite(sideEntry.otherLateral) + awaySign * 3.75, -roadMargin, roadMargin)
      : finite(decision.desiredOffset);
    const desiredOffset = yieldingRejoin
      ? finite(current.lateral)
      : recovering ? finite(decision.desiredOffset) : separationOffset;
    const lookAhead = recovering ? clamp(10 + vehicle.speed * 0.42, 10, 20) : clamp(11 + vehicle.speed * 0.58, 12, 30);
    const localCurvature = Math.max(
      Math.abs(finite(track.atDistance(vehicle.distance + 3).curvature)),
      Math.abs(finite(track.atDistance(vehicle.distance + 9).curvature))
    );
    // Pure-pursuit needs a shorter aim point once the car is actually in a
    // tight corner. Keeping the high-speed straight look-ahead here was the
    // reason the controller visibly drew a broad arc and ran wide at hairpins.
    const trackingDistance = clamp(lookAhead * 0.72 / (1 + localCurvature * 20), 5.5, 24);
    const physicalTargetSpeed = track.targetSpeed(vehicle.distance + lookAhead * 0.8, this.skill);
    const referenceTarget = this.referenceProfile?.paceAtDistance?.(vehicle.distance + lookAhead * 0.8)
      ?? this.referenceProfile?.targetAtDistance(vehicle.distance + lookAhead * 0.8) ?? null;
    // Human telemetry supplies feed-forward intent, never direct controls.
    // The selected trajectory, tyre state and live traffic remain authoritative.
    // A larger correction is permitted only where the reference proves the
    // section is flat-out and low-utilisation, and the live car is settled.
    // This fixes false centre-line curvature limits without teaching the AI to
    // blindly copy a human speed through a differently chosen line.
    const liveSlip = Math.atan2(finite(vehicle.localVelocity?.x), Math.max(3, Math.abs(finite(vehicle.localVelocity?.z, vehicle.speed))));
    const referencePaceDelta = referenceTarget
      ? clamp(finite(referenceTarget.speed) * 0.985 - physicalTargetSpeed, 0, 6)
      : 0;
    const baseTargetSpeed = physicalTargetSpeed + referencePaceDelta;
    this.trajectoryPlan = this.trajectoryPlanner.plan({
      vehicle, track, desiredOffset,
      // A committed manoeuvre has one authoritative lane. Allowing a current-
      // lane fallback made the debug path say “attack” while the controller
      // continued following and braking behind the target.
      fallbackOffsets: recovering || decision.committed || decision.defending ? [] : [policyLine, finite(current.lateral)],
      // Keep geometry prediction independent of the learned pace feed-forward.
      // Feeding a higher reference speed into spatial horizon generation made
      // the planner see distant spline curvature sooner and brake twice.
      trafficEntries: traffic.entries, targetSpeed: physicalTargetSpeed, aggression,
      racecraftPhase: this.passPhase, recovering, pitActive: Boolean(vehicle.pitIntent?.active), urgent: decision.committed || decision.defending,
      roadMargin: yieldingRejoin ? Math.max(roadMargin, Math.abs(finite(current.lateral)) + 0.5) : roadMargin,
      lookAhead, trackingDistance
    });
    const point = this.trajectoryPlan.trackingPoint ?? this.trajectoryPlan.points.at(-1);
    const targetOffset = finite(point?.lateral, desiredOffset);
    const target = { x: finite(point?.x), y: finite(point?.y), z: finite(point?.z), lateral: targetOffset };
    const headingError = wrapAngle(Math.atan2(target.x - vehicle.position.x, target.z - vehicle.position.z) - vehicle.yaw);
    const lateralError = finite(current.lateral) - targetOffset;
    // Heading to the world-space trajectory is authoritative. Track-lateral
    // error is only a small centring trim: a large Frenet-space term could
    // oppose the required steering on a curved/offset lane and make the car
    // wash farther outside while the debug target itself was valid.
    let rawSteer = clamp(headingError * (recovering ? 2.8 : 2.25)
      - lateralError * (recovering ? 0.085 : 0.055) - vehicle.yawRate * 0.17, -1, 1);
    if (yieldingRejoin) rawSteer = clamp(rawSteer, -0.3, 0.3);
    const steerRate = decision.committed ? 7.5 : recovering ? 6 : 5.2;
    this.steerCommand += clamp(rawSteer - this.steerCommand, -steerRate * dt, steerRate * dt);

    const classPace = vehicle.classKey === 'prototype' ? 1.025 : vehicle.classKey === 'gt' ? 0.985 : 0.96;
    const policyPace = finite(policy?.pace) * 0.025;
    let desiredSpeed = baseTargetSpeed * (classPace + policyPace);
    // The chosen offset trajectory can be tighter than the centre-line
    // curvature used by Track.targetSpeed. Cap speed from the actual path the
    // steering controller will follow, with class-appropriate lateral grip.
    const lateralAccelerationBudget = vehicle.classKey === 'prototype' ? 24
      : vehicle.classKey === 'gt' ? 17.5 : 15;
    const trajectoryCurvature = Math.max(0, finite(this.trajectoryPlan.maxCurvaturePerM));
    // Back-project every future corner-speed limit through a realistic braking
    // distance. A raw maximum over the whole 3.4 s horizon made cars lift on
    // an otherwise clean straight because it could see a hairpin 150 m away.
    const brakingDeceleration = vehicle.classKey === 'prototype' ? 11.5 : vehicle.classKey === 'gt' ? 10 : 8.5;
    const trajectorySpeedLimit = this.trajectoryPlan.points.reduce((limit, pathPoint) => {
      const curvature = Math.max(0, finite(pathPoint.curvature));
      if (curvature < 1e-5) return limit;
      const cornerSpeed = Math.sqrt(lateralAccelerationBudget / curvature);
      const reachableSpeed = Math.sqrt(cornerSpeed * cornerSpeed
        + 2 * brakingDeceleration * Math.max(0, finite(pathPoint.forwardDistance)));
      return Math.min(limit, reachableSpeed);
    }, 90);
    desiredSpeed = Math.min(desiredSpeed, trajectorySpeedLimit);
    const targetEntry = decision.target;
    const selectedSeparation = targetEntry ? Math.abs(finite(this.trajectoryPlan.selectedOffset) - finite(targetEntry.otherLateral)) : 99;
    const committedPathReady = decision.committed && this.trajectoryPlan.collisionFree && this.trajectoryPlan.roadLegal && selectedSeparation >= 3.45;
    const sideEscapeSeparation = sideEntry
      ? Math.abs(finite(this.trajectoryPlan.selectedOffset) - finite(sideEntry.otherLateral)) : 99;
    // Special-case only a genuinely static obstruction. Moving race traffic
    // must keep longitudinal priority; treating every side conflict as an
    // acceleration opportunity reintroduced door-to-door rubbing.
    const sideEscapeReady = sideConflict && sideEntry.other.speed < 2.5
      && this.trajectoryPlan.collisionFree
      && this.trajectoryPlan.roadLegal && sideEscapeSeparation >= 3.45;
    const actualTargetSeparation = targetEntry
      ? Math.abs(finite(current.lateral) - finite(targetEntry.otherLateral)) : 99;
    const passBodiesClear = actualTargetSeparation >= 3.3;
    if (committedPathReady && targetEntry && passBodiesClear) {
      // Once the real bodies have lateral room, use the car's power advantage.
      desiredSpeed = Math.max(desiredSpeed, targetEntry.other.speed + clamp(5 + targetEntry.delta * 0.12, 5, 8));
    } else if (committedPathReady && targetEntry) {
      // Coordinate arrival time with lateral clearance. This is neither timid
      // speed matching nor blind full throttle: reach the rear axle only after
      // the physically achievable lane transition has opened a body-width.
      const transitionTime = Math.max(0.65, finite(this.trajectoryPlan.transitionTimeS, 1.4));
      const usableGap = Math.max(0, targetEntry.delta - 4.2);
      const approachSpeed = targetEntry.other.speed + usableGap / transitionTime;
      desiredSpeed = Math.min(desiredSpeed, Math.max(targetEntry.other.speed + 3, approachSpeed));
    } else if (targetEntry && targetEntry.delta > 0 && targetEntry.delta < 35) {
      const closing = Math.max(0, targetEntry.relativeLongitudinalVelocity);
      const safeGap = clamp(7 + closing * closing / 10, 8, 34);
      desiredSpeed = Math.min(desiredSpeed, Math.max(0,
        targetEntry.other.speed + clamp((targetEntry.delta - safeGap) * 0.32, -6, 2.2)));
    }
    if (recovering) desiredSpeed = isOffTrack ? 7 : edgeDeviation ? 10 : 16;
    if (yieldingRejoin) desiredSpeed = Math.min(desiredSpeed, 5);
    const sideYieldPriority = sideConflict && (sideEntry.delta > 0.15
      || (Math.abs(sideEntry.delta) <= 0.15 && String(vehicle.id) > String(sideEntry.other.id)));
    if (sideEscapeReady && sideEntry) {
      const bodiesClear = sideSeparation >= 3.3;
      if (bodiesClear) {
        desiredSpeed = Math.max(desiredSpeed, sideEntry.other.speed + 3.5);
      } else {
        const transitionTime = Math.max(0.65, finite(this.trajectoryPlan.transitionTimeS, 1.4));
        const usableGap = Math.max(0, sideEntry.delta - 4.1);
        desiredSpeed = Math.min(desiredSpeed,
          Math.max(sideEntry.other.speed + 2.5, sideEntry.other.speed + usableGap / transitionTime));
      }
    } else if (sideConflict && !committedPathReady) {
      desiredSpeed = sideYieldPriority
        ? Math.min(desiredSpeed, Math.max(0, sideEntry.other.speed - 1.5))
        : Math.max(desiredSpeed, sideEntry.other.speed + 1.5);
    }

    const hazard = this.awareness.forwardHazard(traffic);
    const passEscape = (committedPathReady && hazard?.other.id === this.passTargetId)
      || (sideEscapeReady && hazard?.other.id === sideEntry?.other.id);
    const emergency = Boolean(hazard && !passEscape && (hazard.ttc < 3.2 || hazard.longitudinal < 10));
    if (emergency) desiredSpeed = Math.min(desiredSpeed, Math.max(0, hazard.other.speed - 1.5));
    const speedError = desiredSpeed - vehicle.speed;
    const straight = this.upcomingCurvature < 0.0038;
    let throttle = speedError > -0.6 ? clamp((straight ? 0.92 : 0.48) + speedError * 0.14, 0, 1) : 0;
    let brake = clamp((-speedError - 1.1) * 0.15, 0, 1);
    if (committedPathReady && passBodiesClear && speedError > -0.8 && !emergency) {
      throttle = Math.max(throttle, 0.88);
      brake = 0;
    }
    if (this.passPhase === 'DRAFT' && targetEntry && targetEntry.delta > 10 && speedError > -0.5) { throttle = 1; brake = 0; }
    if (straight && !targetEntry && !hazard && speedError > -1) { throttle = 1; brake = 0; }
    if (recovering) {
      throttle = vehicle.speed < desiredSpeed ? (Math.abs(headingError) > 1.15 ? 0.35 : 0.68) : 0;
      brake = vehicle.speed > desiredSpeed + 2.5 ? 0.25 : 0;
    }
    if (emergency) { throttle = 0; brake = Math.max(brake, clamp(0.55 + (3.2 - Math.min(3.2, hazard.ttc)) * 0.16, 0.55, 1)); }
    const slip = liveSlip;
    const instability = clamp(Math.max((Math.abs(slip) - 0.14) / 0.22, (Math.abs(vehicle.yawRate) - 1.05) / 1.2), 0, 1);
    if (instability > 0 && !emergency) { throttle *= 1 - instability * 0.65; brake *= 1 - instability * 0.7; }

    vehicle.controls = { steer: clamp(this.steerCommand, -1, 1), throttle: clamp(throttle, 0, 1), brake: clamp(brake, 0, 1), handbrake: 0 };
    vehicle.aiTarget = { x: target.x, z: target.z, lateral: targetOffset };
    vehicle.aiTraffic = { trafficThreat: emergency ? 'IMMINENT' : hazard ? 'PREDICTED' : 'CLEAR', ttc: finite(hazard?.ttc, 99) };
    this.trafficThreat = vehicle.aiTraffic.trafficThreat;
    this.trafficTTC = vehicle.aiTraffic.ttc;
    this.predictedLateralSeparation = finite(hazard?.predictedSide, 99);
    vehicle.aiTactical = {
      source: policy ? 'RL_HYBRID' : 'HEURISTIC_V2', lineBiasM: policyLine, paceDelta: policyPace,
      effectiveAggression: aggression, passPhase: this.passPhase, racecraftPhase: this.passPhase,
      passTargetId: this.passTargetId, targetLaneOffsetM: targetOffset, draftTargetId: this.draftTargetId,
      draftWakeStrength: this.draftWakeStrength, draftWakeSource: this.draftWakeSource,
      passSide: this.passSide, passIntent: this.passIntent, upcomingTurnSign: this.upcomingTurnSign,
      upcomingCurvature: this.upcomingCurvature, insideLaneOffset: this.insideLaneOffset,
      outsideLaneOffset: this.outsideLaneOffset, insideLaneClear: this.insideLaneClear,
      outsideLaneClear: this.outsideLaneClear, safetyIntervention: finite(policy?.safetyIntervention),
      trajectoryCurvature, trajectorySpeedLimit, desiredSpeed,
      referenceSpeed: finite(referenceTarget?.speed), referenceEnvelopeSpeed: finite(referenceTarget?.envelopeSpeed),
      defenseTargetId: this.racecraft.defenseTargetId, defending: Boolean(decision.defending)
    };
    if (vehicle.classKey === 'prototype') vehicle.setERSMode?.(committedPathReady ? 'ATTACK' : 'AUTO');

    let mode = 'RACE'; let reason = 'OPEN_RACING_LINE';
    if (vehicle.pitIntent?.active) { mode = 'PIT'; reason = `PIT_${vehicle.pitIntent.state ?? 'ACTIVE'}`; }
    else if (recovering) { mode = 'RECOVER'; reason = yieldingRejoin ? 'WAIT_SAFE_REJOIN' : isOffTrack ? 'OFF_TRACK_RECOVERY' : 'STALL_RECOVERY'; }
    else if (decision.defending) { mode = 'DEFEND'; reason = 'ONE_MOVE_HOLD_LANE'; }
    else if (decision.committed) { mode = 'PASS'; reason = committedPathReady ? `${decision.phase}_COMMIT` : `${decision.phase}_PATH_BLOCKED`; }
    else if (this.passPhase === 'DRAFT') { mode = 'DRAFT'; reason = decision.waitReason ?? 'DRAFT_SETUP'; }
    else if (sideEscapeReady) { mode = 'AVOID'; reason = 'OPEN_ESCAPE_CORRIDOR'; }
    else if (emergency) { mode = 'BRAKE'; reason = 'PREDICTED_COLLISION'; }
    else if (targetEntry) { mode = 'FOLLOW'; reason = 'CLOSING_GAP'; }
    else if (brake > 0.08) { mode = 'BRAKE'; reason = 'CORNER_SPEED'; }
    this._debug(vehicle, { mode, reason, desiredSpeed, targetOffset, target, headingError, lateralError, traffic, hazard, recovering, decision, aggression, dt });
  }

  _cooldown(vehicle, track, dt) {
    if (vehicle.despawned) { vehicle.controls = { throttle: 0, brake: 1, steer: 0, handbrake: 0 }; return; }
    vehicle.trafficGhost = true;
    vehicle.cooldownTime += dt;
    const current = vehicle.surface ?? track.surfaceAt(vehicle.position.x, vehicle.position.z);
    const isOffTrack = offRoad(current);
    const lanes = [-5, -1.67, 1.67, 5];
    const offset = isOffTrack ? 0 : clamp(lanes[Math.abs(this.index - 1) % lanes.length], -track.roadHalfWidth + 1.2, track.roadHalfWidth - 1.2);
    const point = track.atDistance(vehicle.distance + clamp(10 + vehicle.speed * 0.44, 10, 21));
    const target = track.lateralPoint(point, offset, 0.08);
    const headingError = wrapAngle(Math.atan2(target.x - vehicle.position.x, target.z - vehicle.position.z) - vehicle.yaw);
    const desiredSpeed = vehicle.cooldownTime < 3 ? 18 : vehicle.cooldownTime < 7 ? 13 : vehicle.cooldownTime < 12 ? 8 : vehicle.cooldownTime < 17 ? 3.5 : 0;
    const speedError = desiredSpeed - vehicle.speed;
    vehicle.controls = {
      steer: clamp(headingError * 2.2 - (finite(current.lateral) - offset) * 0.06 - vehicle.yawRate * 0.16, -1, 1),
      throttle: clamp(speedError * 0.12, 0, 0.58),
      brake: vehicle.cooldownTime > 17 ? 0.8 : clamp((-speedError - 0.4) * 0.16, 0, 0.82), handbrake: 0
    };
    vehicle.aiTarget = { x: target.x, z: target.z, lateral: offset };
    if (vehicle.cooldownTime > 19 && vehicle.speed < 0.75 && !isOffTrack) vehicle.despawned = true;
  }
}
