import { clamp, wrap, wrapAngle } from '../core/math.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export class AIController {
  constructor(index) {
    this.index = index;
    this.skill = 0.72 + ((index * 37) % 23) / 100;
    this.aggression = 0.42 + ((index * 19) % 41) / 100;
    this.baseOffset = ((index % 4) - 1.5) * 0.72;
    this.lineOffset = this.baseOffset;
    this.mistakeClock = 9 + index * 1.9;
    this.mistake = 0;
    this.recovery = 0;
    this.stallTime = 0;
    this.marshalRecoveries = 0;
    this.lastDistance = null;
    this.passTime = 0;
    this.passOffset = 0;
    this.passTargetId = null;
    this.passPhase = 'NONE';
    this.passCooldown = 0;
    this.debugEnabled = false;
    this.debugState = null;
    this.trafficThreat = 'CLEAR';
    this.trafficTTC = 99;
    this.predictedLateralSeparation = 99;
    this.tacticalPolicy = null;
    this.tacticalPolicyAge = Infinity;
    this.adaptiveLineOffset = 0;
    this.adaptiveClock = 0;
    this._debugPathClock = Infinity;
    this._debugPlanPath = [];
  }

  setDebugEnabled(enabled) {
    this.debugEnabled = Boolean(enabled);
    if (!this.debugEnabled) {
      this.debugState = null;
      this._debugPlanPath.length = 0;
      this._debugPathClock = Infinity;
    } else {
      // Force a path on the first published state after the panel is armed.
      this._debugPathClock = Infinity;
    }
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
    const other = entry.other;
    return {
      id: other?.id ?? null,
      name: other?.name ?? null,
      deltaM: finite(entry.delta),
      lateralDeltaM: finite(entry.lateralDelta),
      longitudinalM: finite(entry.longitudinal),
      sideM: finite(entry.side),
      directM: finite(entry.direct),
      relativeSpeedMps: finite(entry.relativeSpeed),
      relativeLongitudinalVelocityMps: finite(entry.relativeLongitudinalVelocity),
      relativeLateralVelocityMps: finite(entry.relativeLateralVelocity),
      ttc: finite(entry.ttc, 99),
      predictedLateralSeparationM: finite(entry.predictedLateralSeparation, 99)
    };
  }

  _publishDebug(vehicle, track, {
    mode = 'RACE', reason = 'OPEN_RACING_LINE', currentSpeed = vehicle.speed,
    desiredSpeed = 0, speedError = 0, lookAhead = 0, targetOffset = 0,
    lineOffset = this.lineOffset, headingError = 0, lateralError = 0,
    target = null, closeFront = null, closeBehind = null, nearestSide = null,
    controls = vehicle.controls, recovering = false, trafficThreat = 'CLEAR',
    trafficTTC = 99, predictedLateralSeparation = 99, dt = 0
  } = {}) {
    if (!this.debugEnabled) return;
    this._debugPathClock += Math.max(0, finite(dt));
    const horizon = Math.max(3.2, finite(lookAhead, 8) / Math.max(6, finite(currentSpeed, vehicle.speed)));
    const pathSpeed = Math.max(0, finite(currentSpeed, vehicle.speed));
    const throttle = clamp(finite(controls?.throttle), 0, 1);
    const brake = clamp(finite(controls?.brake), 0, 1);
    const longitudinalAcceleration = throttle * 4.2 - brake * 7.2 - pathSpeed * 0.018;
    if (!this._debugPlanPath.length || this._debugPathClock >= 0.05) {
      this._debugPlanPath.length = 0;
      const pathPoints = 24;
      for (let index = 0; index < pathPoints; index += 1) {
        const time = horizon * index / (pathPoints - 1);
        const predictedSpeed = clamp(pathSpeed + longitudinalAcceleration * time, 0, 90);
        const forwardDistance = Math.max(0, pathSpeed * time + 0.5 * longitudinalAcceleration * time * time);
        const blend = clamp(time / horizon, 0, 1);
        const lateral = finite(vehicle.surface?.lateral, 0)
          + (finite(targetOffset, 0) - finite(vehicle.surface?.lateral, 0)) * blend;
        const point = track.atDistance(vehicle.distance + forwardDistance);
        const world = index === 0
          ? { x: finite(vehicle.position.x), y: finite(vehicle.position.y) + 0.08, z: finite(vehicle.position.z) }
          : track.lateralPoint(point, lateral, 0.08);
        this._debugPlanPath.push({
          x: finite(world.x), y: finite(world.y), z: finite(world.z),
          s: finite(point.s), lateral: finite(lateral), time: finite(time),
          speed: finite(predictedSpeed), predictedSpeed: finite(predictedSpeed)
        });
      }
      this._debugPathClock = 0;
    }
    // Keep the anchor truthful between the <=20 Hz projection refreshes;
    // the future samples remain cached, but point zero always denotes the
    // vehicle pose from the current simulation tick.
    if (this._debugPlanPath[0]) {
      this._debugPlanPath[0].x = finite(vehicle.position.x);
      this._debugPlanPath[0].y = finite(vehicle.position.y) + 0.08;
      this._debugPlanPath[0].z = finite(vehicle.position.z);
      this._debugPlanPath[0].time = 0;
      this._debugPlanPath[0].speed = pathSpeed;
      this._debugPlanPath[0].predictedSpeed = pathSpeed;
    }

    const output = {
      steer: finite(controls?.steer),
      throttle: finite(controls?.throttle),
      brake: finite(controls?.brake),
      handbrake: finite(controls?.handbrake)
    };
    const fallbackTarget = this._debugPlanPath[this._debugPlanPath.length - 1];
    const targetData = target ? {
      x: finite(target.x), y: finite(target.y), z: finite(target.z), lateral: finite(target.lateral)
    } : fallbackTarget ? {
      x: finite(fallbackTarget.x), y: finite(fallbackTarget.y), z: finite(fallbackTarget.z), lateral: finite(targetOffset)
    } : null;
    const state = {
      enabled: true,
      vehicleId: vehicle.id,
      name: vehicle.name,
      class: vehicle.classKey,
      classKey: vehicle.classKey,
      mode,
      reason,
      skill: finite(this.skill),
      aggression: finite(vehicle.aiTactical?.effectiveAggression, this.aggression),
      currentSpeed: finite(currentSpeed),
      desiredSpeed: finite(desiredSpeed),
      currentSpeedMps: finite(currentSpeed),
      desiredSpeedMps: finite(desiredSpeed),
      speedError: finite(speedError),
      lookAhead: finite(lookAhead),
      targetOffset: finite(targetOffset),
      lineOffset: finite(lineOffset),
      headingError: finite(headingError),
      lateralError: finite(lateralError),
      recovery: finite(this.recovery),
      recoveryTimer: finite(this.recovery),
      passTime: finite(this.passTime),
      passTimer: finite(this.passTime),
      passOffset: finite(this.passOffset),
      stallTime: finite(this.stallTime),
      stallTimer: finite(this.stallTime),
      recovering: Boolean(recovering),
      closeFront: this._summary(closeFront),
      closeBehind: this._summary(closeBehind),
      nearestSide: this._summary(nearestSide),
      trafficThreat: String(trafficThreat ?? 'CLEAR'),
      trafficTTC: finite(trafficTTC, 99),
      ttc: finite(trafficTTC, 99),
      predictedLateralSeparationM: finite(predictedLateralSeparation, 99),
      predictedSeparationM: finite(predictedLateralSeparation, 99),
      controls: output,
      output: { ...output },
      outputControls: { ...output },
      target: targetData,
      targetX: targetData?.x ?? null,
      targetY: targetData?.y ?? null,
      targetZ: targetData?.z ?? null,
      planPath: this._debugPlanPath,
      path: this._debugPlanPath
    };
    state.tacticalPolicy = vehicle.aiTactical ?? (this.tacticalPolicyAge < 0.35 && this.tacticalPolicy
      ? { source: 'RL_HYBRID', ...this.tacticalPolicy }
      : null);
    this.debugState = state;
  }

  update(vehicle, vehicles, track, race, dt) {
    this.tacticalPolicyAge += dt;
    if (!vehicle._aiDynamicsConfigured) {
      // The AI already closes the loop on target speed and combined slip.
      // Higher TC layers double-govern launch torque and cost a full lap on
      // the close-to-line lead grid slot; retain ABS for braking control.
      vehicle.setTCLevel?.(vehicle.classKey === 'prototype' ? 2 : vehicle.classKey === 'gt' ? 1 : 0);
      vehicle.setABSLevel?.(6);
      if (vehicle.classKey === 'prototype') vehicle.setERSMode?.('AUTO');
      vehicle._aiDynamicsConfigured = true;
    }
    if (race.phase !== 'racing') {
      vehicle.controls.throttle = 0;
      vehicle.controls.brake = 1;
      vehicle.controls.steer = 0;
      vehicle.controls.handbrake = 0;
      if (this.debugEnabled) this._publishDebug(vehicle, track, {
        mode: 'GRID', reason: 'GRID_HOLD', desiredSpeed: 0, speedError: -vehicle.speed,
        lineOffset: this.lineOffset, targetOffset: 0, controls: vehicle.controls, dt
      });
      return;
    }
    if (vehicle.finished) {
      this._updateFinishedCooldown(vehicle, vehicles, track, dt);
      return;
    }
    const speed = vehicle.speed;
    const current = vehicle.surface ?? track.surfaceAt(vehicle.position.x, vehicle.position.z);
    const isOffTrack = current.zone === 'runoff' || current.zone === 'grass';
    const forward = vehicle.forward;
    const right = vehicle.right;
    if (this.lastDistance === null) this.lastDistance = vehicle.distance;
    const progress = wrap(vehicle.distance - this.lastDistance + track.length * 0.5, track.length) - track.length * 0.5;
    this.lastDistance = vehicle.distance;
    // Progress can jitter by a few centimetres when an OBB contact is being
    // unwound, so use a small forward window rather than requiring a strictly
    // positive delta before arming the bounded recovery request.
    this.stallTime = speed < 3.2 && progress < 0.8 ? this.stallTime + dt : Math.max(0, this.stallTime - dt * 1.8);
    if (this.stallTime > 2.15 && vehicle.marshalRecoverTo) {
      // Real series marshal or tow cars that cannot safely rejoin under their
      // own power. Preserve tyre wear/ERS state, advance only a few metres,
      // and resume at pit-lane speed instead of allowing a permanent AI orbit.
      vehicle.marshalRecoverTo(track, vehicle.distance + 7, clamp(this.baseOffset, -2.2, 2.2));
      this.stallTime = 0;
      this.recovery = 0.9;
      this.lastDistance = vehicle.distance;
      this.marshalRecoveries += 1;
      vehicle.controls.throttle = 0.45;
      vehicle.controls.brake = 0;
      vehicle.controls.steer = 0;
      vehicle.controls.handbrake = 0;
      return;
    }
    // A car can remain nominally on the road while a high-slip transient
    // points it at the wrong side of a bend.  Treat a sustained near-stop as
    // a short recovery request so the controller unwinds steering instead of
    // spending a full corner applying throttle into the same state.
    if (this.stallTime > 0.55) this.recovery = Math.max(this.recovery, 1.35);
    const lookAhead = 11 + speed * 0.62;
    const policy = this.tacticalPolicyAge < 0.35 ? this.tacticalPolicy : null;
    const raceStatus = race.statusFor?.(vehicle) ?? {};
    const racePressure = clamp(((raceStatus.position ?? 1) - 1) / Math.max(1, vehicles.length - 1), 0, 1);
    const effectiveAggression = clamp(this.aggression + finite(policy?.aggression) * 0.12 + racePressure * 0.055, 0.34, 0.92);
    this.adaptiveClock -= dt;
    if (this.adaptiveClock <= 0) {
      const maxWear = vehicle.wheels.reduce((maximum, wheel) => Math.max(maximum, finite(wheel.wear)), 0);
      const gripDeficit = clamp(1 - finite(current.grip, 1), 0, 0.4);
      const liveVariation = Math.sin(race.elapsed * (0.29 + this.index * 0.013) + vehicle.distance * 0.0009 + this.index * 1.7);
      const policyBias = finite(policy?.lineOffset) * 1.15;
      const conditionBias = liveVariation * (0.12 + maxWear * 0.28 + gripDeficit * 0.5);
      this.adaptiveLineOffset = clamp(policyBias + conditionBias, -1.45, 1.45);
      this.adaptiveClock = 1.35 + (this.index % 4) * 0.23;
    }
    let desiredOffset = this.baseOffset + this.adaptiveLineOffset;
    let closeFront = null;
    let closeBehind = null;
    let nearestSide = null;
    let trafficThreat = 'CLEAR';
    let trafficTTC = 99;
    let predictedLateralSeparation = 99;
    let trafficThreatEntry = null;
    const vehicleForwardSpeed = vehicle.velocity.x * forward.x + vehicle.velocity.z * forward.z;
    const vehicleLateralSpeed = vehicle.velocity.x * right.x + vehicle.velocity.z * right.z;
    for (const other of vehicles) {
      if (other === vehicle || other.finished || other.despawned || other.trafficGhost) continue;
      const delta = wrap(other.distance - vehicle.distance + track.length * 0.5, track.length) - track.length * 0.5;
      const lateralDelta = (other.surface?.lateral ?? 0) - (current.lateral ?? 0);
      const dx = other.position.x - vehicle.position.x;
      const dz = other.position.z - vehicle.position.z;
      const longitudinal = dx * forward.x + dz * forward.z;
      const side = dx * right.x + dz * right.z;
      const otherForwardSpeed = other.velocity.x * forward.x + other.velocity.z * forward.z;
      const otherLateralSpeed = other.velocity.x * right.x + other.velocity.z * right.z;
      const relativeLongitudinalVelocity = vehicleForwardSpeed - otherForwardSpeed;
      const relativeLateralVelocity = otherLateralSpeed - vehicleLateralSpeed;
      const bodyGap = Math.max(0.2, longitudinal - 1.7);
      const closing = Math.max(0, relativeLongitudinalVelocity);
      const ttc = closing > 0.25 ? bodyGap / closing : 99;
      const predictionTime = clamp(ttc, 0.35, 2.4);
      const predictedSeparation = Math.abs(side + relativeLateralVelocity * predictionTime);
      const relevantTraffic = longitudinal > 0 && longitudinal < 35 && Math.abs(side) < 6.2;
      if (relevantTraffic && ttc < 3.9 && predictedSeparation < 2.25) {
        const candidateThreat = ttc < 1.35 || bodyGap < 2.2 ? 'CRITICAL' : ttc < 2.35 ? 'IMMINENT' : 'PREDICTED';
        const priority = { CLEAR: 0, PREDICTED: 1, IMMINENT: 2, CRITICAL: 3 };
        if (priority[candidateThreat] > priority[trafficThreat] || (candidateThreat === trafficThreat && ttc < trafficTTC)) {
          trafficThreat = candidateThreat;
          trafficTTC = finite(ttc, 99);
          predictedLateralSeparation = finite(predictedSeparation, 99);
          trafficThreatEntry = {
            other, delta, lateralDelta, longitudinal, side,
            relativeSpeed: speed - other.speed,
            relativeLongitudinalVelocity, relativeLateralVelocity,
            ttc, predictedLateralSeparation: predictedSeparation
          };
        }
      }
      if (delta > 0 && delta < 30 && longitudinal > -1.2 && Math.abs(side) < 5.4 && (!closeFront || delta < closeFront.delta)) closeFront = {
        other, delta, lateralDelta, longitudinal, side,
        relativeSpeed: speed - other.speed,
        relativeLongitudinalVelocity, relativeLateralVelocity, ttc,
        predictedLateralSeparation: predictedSeparation
      };
      if (delta < 0 && delta > -12 && Math.abs(lateralDelta) < 3.2 && (!closeBehind || delta > closeBehind.delta)) closeBehind = { other, delta, lateralDelta };
      const direct = Math.hypot(dx, dz);
      if (direct < 5.2 && (!nearestSide || direct < nearestSide.direct)) nearestSide = { other, direct, side, longitudinal };
    }
    this.trafficThreat = trafficThreat;
    this.trafficTTC = finite(trafficTTC, 99);
    this.predictedLateralSeparation = finite(predictedLateralSeparation, 99);
    vehicle.aiTraffic = {
      trafficThreat: this.trafficThreat,
      ttc: this.trafficTTC,
      predictedLateralSeparationM: this.predictedLateralSeparation
    };

    // Keep deterministic fleet completion under the higher-fidelity tyre
    // transient model. Line variation and traffic already provide race motion.
    this.mistake = 0;
    if (isOffTrack) this.recovery = 1.15;
    else this.recovery = Math.max(0, this.recovery - dt);
    const recovering = isOffTrack || this.recovery > 0 || this.stallTime > 0.55;

    this.passTime = Math.max(0, this.passTime - dt);
    this.passCooldown = Math.max(0, this.passCooldown - dt);
    const activePassTarget = this.passTargetId
      ? vehicles.find((candidate) => candidate.id === this.passTargetId && !candidate.finished && !candidate.despawned)
      : null;
    if (activePassTarget) {
      const targetDelta = wrap(activePassTarget.distance - vehicle.distance + track.length * 0.5, track.length) - track.length * 0.5;
      if (targetDelta < -4.5) {
        // Once clear, return to the racing line rather than remaining parked
        // beside the passed car. This is also the visible second half of a
        // switchback/cutback move.
        this.passTime = Math.max(this.passTime, 1.15);
        this.passPhase = 'RETURN';
        this.passOffset = this.baseOffset;
        this.passTargetId = null;
        this.passCooldown = 1.4;
      } else if (this.passTime <= 0 || targetDelta > 34) {
        this.passTargetId = null;
        this.passPhase = 'NONE';
        this.passCooldown = 0.7;
      }
    } else if (this.passTargetId) {
      this.passTargetId = null;
      this.passPhase = 'NONE';
    }

    const localCurvature = track.atDistance(vehicle.distance + clamp(12 + speed * 0.34, 16, 36)).curvature;
    const passCorridorOpen = (localCurvature < 0.0048 && track.atDistance(vehicle.distance + 70).curvature < 0.007)
      || (localCurvature < 0.012 && speed < 30 && closeFront?.delta < 6.5);
    const sideLaneBlocked = nearestSide && nearestSide.other !== closeFront?.other && nearestSide.direct < 4.6;
    const canAttackFront = closeFront && !recovering && !sideLaneBlocked && this.passCooldown <= 0 && this.passTime <= 0
      && closeFront.delta < 18 && speed > 9
      && (closeFront.relativeLongitudinalVelocity > 0.28 || closeFront.delta < 7.5)
      && passCorridorOpen;
    if (canAttackFront) {
      const frontLateral = finite(closeFront.other.surface?.lateral, finite(current.lateral));
      const roadEdge = track.roadHalfWidth - 1.05;
      const clearance = 2.35;
      const positiveRoom = roadEdge - frontLateral;
      const negativeRoom = frontLateral + roadEdge;
      let passSide = positiveRoom > negativeRoom ? 1 : -1;
      if (nearestSide && nearestSide.other !== closeFront.other) passSide = Math.sign(-nearestSide.side || passSide);
      this.passOffset = clamp(frontLateral + passSide * clearance, -roadEdge, roadEdge);
      this.passTime = clamp(4.0 + closeFront.delta * 0.1, 4.2, 5.7);
      this.passTargetId = closeFront.other.id;
      // A blocked corner entry deliberately opens the line and cuts back;
      // a normal speed differential commits to the available lane.
      this.passPhase = localCurvature > 0.0048 && closeFront.delta < 6.5 ? 'SWITCHBACK' : 'ATTACK';
    }

    if (recovering) desiredOffset = 0;
    if (this.passTime > 0) desiredOffset = this.passOffset;
    else if (trafficThreatEntry) {
      const side = Math.sign(-trafficThreatEntry.side || (this.index % 2 ? 1 : -1));
      desiredOffset += side * (1.65 + effectiveAggression * 0.85);
    } else if (closeFront) {
      const side = closeFront.lateralDelta > 0 ? -1 : 1;
      desiredOffset += side * (1.35 + effectiveAggression * 1.35);
    }
    if (closeBehind && effectiveAggression > 0.58 && Math.abs(closeBehind.lateralDelta) < 1.3) {
      desiredOffset += closeBehind.lateralDelta >= 0 ? 0.85 : -0.85;
    }
    if (nearestSide) {
      const otherSurface = nearestSide.other.surface ?? track.surfaceAt(nearestSide.other.position.x, nearestSide.other.position.z);
      desiredOffset += Math.sign((current.lateral ?? 0) - (otherSurface.lateral ?? 0) || (this.index % 2 ? 1 : -1)) * 1.45;
    }
    const pitIntent = vehicle.pitIntent;
    if (pitIntent?.active) desiredOffset = finite(pitIntent.targetLateralM, desiredOffset);
    if (this.mistake > 0) desiredOffset += Math.sin(race.elapsed * 5 + this.index) * this.mistake * 1.25;
    const passLineRate = 0.7 + clamp((32 - speed) / 28, 0, 1) * 0.7;
    const lineChangeRate = pitIntent?.active ? 3.2 : recovering ? 2.7 : this.passTime > 0 ? passLineRate : 1.25;
    this.lineOffset += (desiredOffset - this.lineOffset) * Math.min(1, dt * lineChangeRate);
    const lineMinimum = pitIntent?.active ? Math.min(-track.roadHalfWidth + 1.1, finite(pitIntent.targetLateralM) - 0.4) : -track.roadHalfWidth + 1.1;
    const lineMaximum = pitIntent?.active ? Math.max(track.roadHalfWidth - 1.1, finite(pitIntent.targetLateralM) + 0.4) : track.roadHalfWidth - 1.1;
    this.lineOffset = clamp(this.lineOffset, lineMinimum, lineMaximum);

    const prolongedStall = this.stallTime > 2;
    // A stopped car needs a target far enough down the road to produce a
    // useful heading, not a full-lock orbit around the nearest centre point.
    const recoveryLookAhead = prolongedStall ? 19 : 9 + Math.min(10, speed) * 0.42;
    const target = track.atDistance(vehicle.distance + (recovering ? recoveryLookAhead : lookAhead));
    const targetOffset = recovering ? 0 : this.lineOffset;
    const targetX = target.x + target.normal.x * targetOffset;
    const targetZ = target.z + target.normal.z * targetOffset;
    const targetHeading = Math.atan2(targetX - vehicle.position.x, targetZ - vehicle.position.z);
    const headingError = wrapAngle(targetHeading - vehicle.yaw);
    const lateralError = current.lateral - targetOffset;
    let steer = clamp(headingError * (recovering ? 3.05 : 2.3) - lateralError * (recovering ? 0.09 : 0.055) - vehicle.yawRate * 0.16, -1, 1);
    if (prolongedStall) {
      // Full steering lock plus low throttle cannot overcome tyre scrub in the
      // physical model.  Open the steering and let the car build enough speed
      // for its front axle to generate a meaningful restoring yaw moment.
      steer = clamp(headingError * 1.25 - lateralError * 0.035 - vehicle.yawRate * 0.1, -0.68, 0.68);
    }
    if (nearestSide && nearestSide.direct < 3.4) {
      const avoidanceAuthority = 0.1 + 0.17 * clamp((28 - speed) / 20, 0, 1);
      steer += Math.sign((current.lateral ?? 0) - ((nearestSide.other.surface?.lateral) ?? 0) || 1) * avoidanceAuthority;
    }
    const bodySlip = Math.atan2(finite(vehicle.localVelocity?.x), Math.max(3, Math.abs(finite(vehicle.localVelocity?.z, speed))));
    const instability = clamp(Math.max((Math.abs(bodySlip) - 0.105) / 0.16, (Math.abs(vehicle.yawRate) - 0.82) / 1.1), 0, 1);
    if (!recovering && instability > 0) steer *= 1 - instability * 0.34;
    // The generic track envelope is deliberately conservative. Class pace
    // lets high-downforce prototypes exploit their mechanical/aero capacity
    // while touring cars retain their lower corner/straight performance.
    const classPace = vehicle.classKey === 'prototype' ? 1 : vehicle.classKey === 'touring' ? 0.96 : 1;
    const cornerSpeed = track.targetSpeed(vehicle.distance + lookAhead * 0.75, this.skill) * classPace;
    const straightAhead = localCurvature < 0.0036;
    const policyPace = finite(policy?.pace) * 0.025;
    const pace = (straightAhead
      ? 1.005 + this.skill * 0.018 + effectiveAggression * 0.008
      : 0.85 + effectiveAggression * 0.08 - this.mistake * 0.14) + policyPace;
    let desiredSpeed = cornerSpeed * pace;
    vehicle.aiTactical = {
      source: policy ? 'RL_HYBRID' : 'HEURISTIC',
      lineBiasM: this.adaptiveLineOffset,
      paceDelta: policyPace,
      effectiveAggression,
      passPhase: this.passPhase,
      safetyIntervention: finite(policy?.safetyIntervention)
    };
    if (recovering) desiredSpeed = current.zone === 'grass' ? 13 : 17;
    const speedError = desiredSpeed - speed;
    const throttleFeedForward = straightAhead ? 0.92 : 0.42;
    let throttle = speedError > -0.25 ? clamp(throttleFeedForward + speedError * 0.14, 0, 1) : 0;
    let brake = clamp((-speedError - 1.2) * 0.14, 0, 1);
    if (recovering) {
      // Recovery maintains enough drive to turn out of grass/runoff instead of repeatedly braking to a stop.
      throttle = speed < desiredSpeed ? (prolongedStall ? 0.78 : Math.abs(headingError) > 1.2 ? 0.38 : 0.72) : 0;
      brake = speed > desiredSpeed + 3 ? 0.18 : 0;
    } else {
      if (Math.abs(headingError) > 1.05) { throttle *= 0.62; brake = Math.max(brake, 0.08); }
      const needsEmergencyBrake = closeFront && this.passTime <= 0 && (
        (trafficThreat !== 'CLEAR' && trafficTTC < 2.75 && predictedLateralSeparation < 2.05)
        || (closeFront.delta < 2.4 && Math.abs(closeFront.side) < 0.9 && closeFront.relativeSpeed > 3.2)
      );
      if (needsEmergencyBrake) { throttle = 0; brake = Math.max(brake, 0.5); }
      if (current.zone === 'grass') { throttle *= 0.25; brake = Math.max(brake, 0.28); }
      if (instability > 0) {
        throttle *= 1 - instability * 0.7;
        // Trail-braking a rotating car is a common source of the observed
        // spins; release non-emergency brake pressure while it regains yaw.
        if (!needsEmergencyBrake) brake *= 1 - instability * 0.65;
      }
    }
    vehicle.controls.steer = clamp(steer, -1, 1);
    vehicle.controls.throttle = throttle;
    vehicle.controls.brake = brake;
    vehicle.controls.handbrake = 0;
    if (vehicle.classKey === 'prototype' && policy) {
      const attack = this.passTime > 0 || policy.ersStrategy > 0.18;
      vehicle.setERSMode?.(attack ? 'ATTACK' : 'AUTO');
    }
    vehicle.aiTarget = { x: targetX, z: targetZ, lateral: targetOffset };
    if (this.debugEnabled) {
      const targetY = finite(target.y) + Math.sin(finite(target.bank)) * targetOffset;
      const defending = closeBehind && effectiveAggression > 0.58 && Math.abs(closeBehind.lateralDelta) < 1.3;
      let mode = 'RACE';
      let reason = 'OPEN_RACING_LINE';
      if (pitIntent?.active) { mode = 'PIT'; reason = `PIT_${pitIntent.state ?? 'ACTIVE'}`; }
      else if (recovering) { mode = 'RECOVER'; reason = isOffTrack ? 'OFF_TRACK_RECOVERY' : 'STALL_RECOVERY'; }
      else if (this.passTime > 0) { mode = 'PASS'; reason = this.passPhase === 'SWITCHBACK' ? 'SWITCHBACK_CUTBACK' : this.passPhase === 'RETURN' ? 'PASS_RETURN_TO_LINE' : 'PASS_COMMIT'; }
      else if (trafficThreat !== 'CLEAR') { mode = 'AVOID'; reason = `TRAFFIC_${trafficThreat}`; }
      else if (nearestSide) { mode = 'AVOID'; reason = 'NEAREST_SIDE_CAR'; }
      else if (defending) { mode = 'DEFEND'; reason = 'CLOSE_BEHIND'; }
      else if (brake > 0.08) { mode = 'BRAKE'; reason = 'TARGET_SPEED_BRAKE'; }
      else if (closeFront) { mode = 'FOLLOW'; reason = 'CLOSE_FRONT'; }
      this._publishDebug(vehicle, track, {
        mode, reason, currentSpeed: speed, desiredSpeed, speedError, lookAhead: recovering ? recoveryLookAhead : lookAhead,
        targetOffset, lineOffset: this.lineOffset, headingError, lateralError,
        target: { x: targetX, y: targetY, z: targetZ, lateral: targetOffset },
        closeFront: trafficThreatEntry ?? closeFront, closeBehind, nearestSide,
        controls: vehicle.controls, recovering, trafficThreat, trafficTTC,
        predictedLateralSeparation, dt
      });
    }
  }

  _updateFinishedCooldown(vehicle, vehicles, track, dt) {
    if (vehicle.despawned) {
      vehicle.controls.throttle = 0;
      vehicle.controls.brake = 1;
      vehicle.controls.steer = 0;
      if (this.debugEnabled) this._publishDebug(vehicle, track, {
        mode: 'COOLDOWN', reason: 'STOPPED_DESPAWNED', desiredSpeed: 0,
        speedError: -vehicle.speed, targetOffset: 0, controls: vehicle.controls, dt
      });
      return;
    }
    vehicle.cooldownTime += dt;
    const current = vehicle.surface ?? track.surfaceAt(vehicle.position.x, vehicle.position.z);
    const offTrack = current.zone === 'runoff' || current.zone === 'grass';
    const side = this.index % 2 ? -1 : 1;
    const safeOffset = offTrack ? 0 : clamp(side * 2.8, -track.roadHalfWidth + 1.2, track.roadHalfWidth - 1.2);
    const lookAhead = clamp(9 + vehicle.speed * 0.44, 10, 21);
    const target = track.atDistance(vehicle.distance + lookAhead);
    const targetX = target.x + target.normal.x * safeOffset;
    const targetZ = target.z + target.normal.z * safeOffset;
    const headingError = wrapAngle(Math.atan2(targetX - vehicle.position.x, targetZ - vehicle.position.z) - vehicle.yaw);
    const lateralError = current.lateral - safeOffset;
    let steer = clamp(headingError * (offTrack ? 3.0 : 2.15) - lateralError * (offTrack ? 0.1 : 0.06) - vehicle.yawRate * 0.16, -1, 1);
    const activeBehind = vehicles.some((other) => {
      if (other === vehicle || other.finished || other.despawned) return false;
      const dx = other.position.x - vehicle.position.x;
      const dz = other.position.z - vehicle.position.z;
      return dx * vehicle.forward.x + dz * vehicle.forward.z < 0 && Math.hypot(dx, dz) < 10;
    });
    let desiredSpeed = vehicle.cooldownTime < 3 ? 18 : vehicle.cooldownTime < 7 ? 13 : vehicle.cooldownTime < 12 ? 8 : vehicle.cooldownTime < 17 ? 3.5 : 0;
    if (offTrack) desiredSpeed = 13;
    if (activeBehind) desiredSpeed = Math.min(desiredSpeed, 7);
    const speedError = desiredSpeed - vehicle.speed;
    let throttle = clamp(speedError * 0.11, 0, offTrack ? 0.7 : 0.55);
    let brake = clamp((-speedError - 0.4) * 0.16, 0, 0.82);
    if (offTrack) {
      throttle = vehicle.speed < desiredSpeed ? (Math.abs(headingError) > 1.2 ? 0.36 : 0.68) : 0;
      brake = vehicle.speed > desiredSpeed + 3 ? 0.18 : 0;
    }
    if (vehicle.cooldownTime > 17) {
      throttle = 0;
      brake = Math.max(brake, 0.74);
    }
    vehicle.controls.steer = steer;
    vehicle.controls.throttle = throttle;
    vehicle.controls.brake = brake;
    vehicle.controls.handbrake = 0;
    vehicle.aiTarget = { x: targetX, z: targetZ, lateral: safeOffset };
    if (this.debugEnabled) {
      const targetY = finite(target.y) + Math.sin(finite(target.bank)) * safeOffset;
      this._publishDebug(vehicle, track, {
        mode: 'COOLDOWN', reason: vehicle.cooldownTime > 17 ? 'CONTROLLED_STOP' : offTrack ? 'COOLDOWN_RECOVERY' : 'COOLDOWN_RETURN',
        currentSpeed: vehicle.speed, desiredSpeed, speedError, lookAhead,
        targetOffset: safeOffset, lineOffset: safeOffset, headingError, lateralError,
        target: { x: targetX, y: targetY, z: targetZ, lateral: safeOffset },
        controls: vehicle.controls, recovering: offTrack, dt
      });
    }
    if (vehicle.cooldownTime > 19 && vehicle.speed < 0.75 && !offTrack) {
      // Only after a controlled on-track stop may a finished car leave active collision traffic.
      vehicle.trafficGhost = true;
      vehicle.despawned = true;
    }
  }
}
