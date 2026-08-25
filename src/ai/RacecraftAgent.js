import { clamp } from '../core/math.js';
import { AI_LIMITS, MANEUVER_PRIORITY, finite } from './AIConfig.js';

const roadMarginFor = (track, ego) => Math.max(1.5,
  track.planningLateralLimit?.(ego.distance, ego.lateral, {
    halfWidthM: ego.halfWidth,
    safetyM: AI_LIMITS.edgeSafetyM
  }) ?? track.roadHalfWidth - ego.halfWidth - AI_LIMITS.edgeSafetyM);

const intent = (values) => Object.freeze({
  mode: 'PACE', phase: 'PACE', targetId: null, terminalLateral: 0,
  priority: MANEUVER_PRIORITY.PACE, committed: false, desiredSpeed: null,
  reason: 'OPTIMAL_LINE', ...values
});

export class RacecraftAgent {
  constructor(vehicleId) {
    this.vehicleId = vehicleId;
    this.debugEnabled = false;
    this.debugState = null;
    this.reset();
  }

  reset() {
    this.attack = null;
    this.defense = null;
    this.returnTimer = 0;
    this.launchStartDistance = null;
    this.launch = null;
    this.recoverySeconds = 0;
    this.stuckSeconds = 0;
    this.lastProgress = null;
    this.lastTactical = null;
    this.currentPlan = null;
    this.planPhaseAge = 0;
    this.steerCommand = 0;
    this.debugState = null;
    this.strategicPhase = 'PACE';
    this.strategicCandidate = null;
    this.strategicCandidateTicks = 0;
  }

  setDebugEnabled(enabled) { this.debugEnabled = Boolean(enabled); }

  observeStrategicPhase(phase) {
    if (!phase || phase === this.strategicPhase) {
      this.strategicCandidate = null;
      this.strategicCandidateTicks = 0;
      return this.strategicPhase;
    }
    if (this.strategicCandidate !== phase) {
      this.strategicCandidate = phase;
      this.strategicCandidateTicks = 1;
    } else {
      this.strategicCandidateTicks += 1;
    }
    const immediate = ['RECOVER', 'PIT', 'COOLDOWN'].includes(phase);
    if (immediate || this.strategicCandidateTicks >= 3) {
      this.strategicPhase = phase;
      this.strategicCandidate = null;
      this.strategicCandidateTicks = 0;
    }
    return this.strategicPhase;
  }

  _traffic(snapshot) {
    const entries = snapshot.trafficFor(this.vehicleId);
    const ego = snapshot.ego(this.vehicleId);
    const corridor = (entry) => Math.abs(entry.lateralDelta)
      < ego.halfWidth + entry.other.halfWidth + 0.85;
    const forward = entries.filter((entry) => entry.delta > 0).sort((a, b) => a.delta - b.delta);
    const rearward = entries.filter((entry) => entry.delta < 0).sort((a, b) => b.delta - a.delta);
    // A staggered grid car in the other lane is not the obstacle. Prefer the
    // first body occupying our corridor, then fall back to general traffic.
    const ahead = forward.find(corridor) ?? forward[0] ?? null;
    const behind = rearward.find(corridor) ?? rearward[0] ?? null;
    const alongside = entries.find((entry) => entry.overlapLongitudinal) ?? null;
    return { entries, ahead, behind, alongside };
  }

  _recoveryIntent(ego, snapshot, trackModel) {
    const planningLimit = roadMarginFor(snapshot.track, ego);
    const offTrack = !['road', 'curb', 'pit'].includes(ego.zone)
      || Math.abs(ego.lateral) > planningLimit + 0.12;
    const facingBackwards = Math.abs(ego.headingError) > 70 * Math.PI / 180;
    const rotatedAndSlow = ego.speed < 8 && Math.abs(ego.headingError) > 35 * Math.PI / 180;
    if (!offTrack && !facingBackwards && !rotatedAndSlow) {
      this.recoverySeconds = 0;
      this.stuckSeconds = 0;
      return null;
    }
    this.recoverySeconds += 1 / 15;
    if (ego.speed < 1) this.stuckSeconds += 1 / 15;
    else this.stuckSeconds = Math.max(0, this.stuckSeconds - 2 / 15);
    const target = snapshot.track.atDistance(ego.distance + clamp(20 + ego.speed * 0.65, 20, 35));
    const shallowOffset = clamp(ego.lateral * 0.45, -snapshot.track.roadHalfWidth * 0.55,
      snapshot.track.roadHalfWidth * 0.55);
    return intent({
      mode: 'RECOVER', phase: (facingBackwards || rotatedAndSlow) ? 'TURN_AROUND' : 'PHYSICAL_REJOIN',
      terminalLateral: shallowOffset, priority: MANEUVER_PRIORITY.RECOVER,
      desiredSpeed: (facingBackwards || rotatedAndSlow) ? 4.5 : Math.min(11, trackModel.speedAt(target.s, ego.vehicle)),
      committed: true, reason: offTrack ? 'OFF_TRACK_REJOIN' : 'WRONG_WAY',
      marshalRequested: this.stuckSeconds >= AI_LIMITS.marshalTimeoutS
    });
  }

  _launchIntents(ego, traffic, snapshot, trackModel) {
    if (snapshot.phase !== 'racing' || snapshot.raceTime > AI_LIMITS.launchDurationS) {
      this.launch = null;
      return null;
    }
    this.launchStartDistance ??= ego.distance;
    const progress = ((ego.distance - this.launchStartDistance + snapshot.track.length) % snapshot.track.length);
    if (progress > AI_LIMITS.launchDistanceM) {
      this.launch = null;
      return null;
    }
    if (this.launch) return [intent({ ...this.launch, committed: true })];
    const margin = roadMarginFor(snapshot.track, ego);
    const lateralStep = Math.max(2.35, ego.halfWidth * 2 + 0.38);
    const leader = traffic.ahead;
    const gridLeaderExpectedToLaunch = leader && !leader.other.player
      && snapshot.raceTime < 1.35 && leader.delta < 17.5;
    const leaderBlocksLane = leader && leader.delta < AI_LIMITS.obstacleLookaheadM
      && Math.abs(leader.lateralDelta) < ego.halfWidth + leader.other.halfWidth + 0.85
      && leader.other.forwardSpeed < Math.max(AI_LIMITS.stoppedSpeedMps, ego.forwardSpeed * 0.45)
      && !gridLeaderExpectedToLaunch;
    if (gridLeaderExpectedToLaunch) {
      return [intent({
        mode: 'LAUNCH', phase: 'LAUNCH_FORMATION', targetId: leader.other.id,
        terminalLateral: ego.lateral, priority: MANEUVER_PRIORITY.LAUNCH,
        desiredSpeed: Math.min(trackModel.speedAt(ego.distance + 35, ego.vehicle), 22),
        committed: true, reason: 'GRID_ROW_ACCELERATION', collisionHorizonS: 0.9
      })];
    }
    if (leaderBlocksLane) {
      const clearance = ego.halfWidth + leader.other.halfWidth + AI_LIMITS.sideClearanceM;
      return [leader.other.lateral + clearance, leader.other.lateral - clearance]
        .map((offset) => clamp(offset, -margin, margin))
        .filter((offset, index, offsets) => offsets.findIndex((value) => Math.abs(value - offset) < 0.1) === index)
        .map((offset, index) => intent({
          mode: 'PASS', phase: 'GRID_BYPASS', targetId: leader.other.id,
          terminalLateral: offset, priority: MANEUVER_PRIORITY.LAUNCH - index,
          desiredSpeed: Math.min(trackModel.speedAt(ego.distance + 35, ego.vehicle),
            Math.max(26, leader.other.forwardSpeed + 16)),
          committed: false, reason: offset > leader.other.lateral
            ? 'OBSTACLE_BYPASS_LEFT' : 'OBSTACLE_BYPASS_RIGHT',
          attackSide: Math.sign(offset - leader.other.lateral)
        }));
    }
    const offsets = [ego.lateral, ego.lateral + lateralStep, ego.lateral - lateralStep]
      .map((value) => clamp(value, -margin, margin))
      .filter((value, index, values) => values.findIndex((item) => Math.abs(item - value) < 0.1) === index);
    return offsets.map((offset, index) => intent({
      mode: 'LAUNCH', phase: index === 0 ? 'HOLD_LAUNCH_LANE' : offset > ego.lateral ? 'OPENING_LEFT' : 'OPENING_RIGHT',
      terminalLateral: offset, targetId: leader?.other.id ?? null,
      priority: MANEUVER_PRIORITY.LAUNCH - index,
      desiredSpeed: Math.min(trackModel.speedAt(ego.distance + 35, ego.vehicle),
        leader && Math.abs(leader.other.lateral - offset) < ego.halfWidth * 2.4
          ? Math.max(gridLeaderExpectedToLaunch ? 18 : 8,
            leader.other.forwardSpeed + clamp((leader.delta - 7) * 0.45, -3, 3))
          : 38),
      committed: index !== 0,
      reason: index === 0 ? 'GRID_LANE_STABILITY' : 'GRID_OPENING'
    }));
  }

  _continueAttack(ego, traffic, snapshot, trackModel) {
    if (!this.attack) return null;
    const target = traffic.entries.find((entry) => entry.other.id === this.attack.targetId) ?? null;
    this.attack.age += 1 / 15;
    if (!target || target.delta < -7) {
      this.attack = null;
      this.returnTimer = 1.4;
      return [intent({ mode: 'RETURN', phase: 'CLEAR', terminalLateral: trackModel.lineAt(ego.distance + 25),
        priority: MANEUVER_PRIORITY.RETURN, reason: 'PASS_COMPLETE' })];
    }
    if (this.attack.age > this.attack.maxAge || target.delta > 80) {
      this.attack = null;
      this.returnTimer = 1.4;
      return [intent({ mode: 'RETURN', phase: 'ABORT', terminalLateral: ego.lateral,
        priority: MANEUVER_PRIORITY.RETURN, reason: 'ATTACK_TIMEOUT' })];
    }
    if (target.overlapLongitudinal) this.attack.overlapSeen = true;
    const overlap = this.attack.overlapSeen;
    const phase = overlap ? 'SIDE_BY_SIDE' : this.attack.phase;
    return [intent({
      mode: 'PASS', phase, targetId: target.other.id,
      terminalLateral: this.attack.offset,
      priority: overlap ? MANEUVER_PRIORITY.SIDE_BY_SIDE : MANEUVER_PRIORITY.COMMITTED_ATTACK,
      desiredSpeed: Math.min(trackModel.speedAt(ego.distance + 20, ego.vehicle) * 1.05,
        Math.max(target.other.forwardSpeed + (overlap ? 5 : this.attack.obstacle ? 18 : 12),
          ego.speed + 2.5)),
      committed: true, reason: overlap ? 'CORRIDOR_OWNED' : 'ATTACK_COMMITTED',
      attackSide: this.attack.side,
      urgentPass: this.attack.urgentPass,
      ...(this.attack.obstacle ? {
        maneuverOriginLateral: this.attack.originLateral,
        maneuverElapsedS: this.attack.age
      } : {})
    })];
  }

  _continueDefense(ego, traffic, trackModel) {
    if (!this.defense) return null;
    const challenger = traffic.entries.find((entry) => entry.other.id === this.defense.targetId) ?? null;
    this.defense.age += 1 / 15;
    if (!challenger || challenger.delta < -45 || challenger.delta > 8 || this.defense.age > 8) {
      this.defense = null;
      this.returnTimer = 1.1;
      return [intent({ mode: 'RETURN', phase: 'DEFENSE_RELEASE', terminalLateral: trackModel.lineAt(ego.distance + 30),
        priority: MANEUVER_PRIORITY.RETURN, reason: 'THREAT_CLEARED' })];
    }
    if (challenger.overlapLongitudinal) this.defense.overlapSeen = true;
    const phase = this.defense.overlapSeen ? 'EXIT_SQUEEZE' : this.defense.phase;
    return [intent({ mode: 'DEFEND', phase, targetId: challenger.other.id,
      terminalLateral: this.defense.offset, priority: MANEUVER_PRIORITY.DEFEND,
      committed: true, reason: 'ONE_MOVE_LOCKED' })];
  }

  tacticalIntents(snapshot, trackModel) {
    const ego = snapshot.ego(this.vehicleId);
    if (!ego || ego.finished || ego.despawned) return [];
    const traffic = this._traffic(snapshot);
    const recovery = this._recoveryIntent(ego, snapshot, trackModel);
    if (recovery) return [recovery];
    if (ego.pitIntent?.active) return [intent({
      mode: 'PIT', phase: 'PIT_COMMIT', terminalLateral: finite(ego.pitIntent.targetLateralM),
      desiredSpeed: finite(ego.pitIntent.speedLimitMps, 18), priority: MANEUVER_PRIORITY.PIT,
      committed: true, reason: 'PIT_REQUEST'
    })];
    const continuedAttack = this._continueAttack(ego, traffic, snapshot, trackModel);
    if (continuedAttack) return continuedAttack;
    const continuedDefense = this._continueDefense(ego, traffic, trackModel);
    if (continuedDefense) return continuedDefense;

    const launch = this._launchIntents(ego, traffic, snapshot, trackModel);
    if (launch) return launch;

    if (this.returnTimer > 0) {
      this.returnTimer = Math.max(0, this.returnTimer - 1 / 15);
      return [intent({ mode: 'RETURN', phase: 'SAFE_REJOIN', terminalLateral: trackModel.lineAt(ego.distance + 28),
        priority: MANEUVER_PRIORITY.RETURN, reason: 'SETTLE_AFTER_COMBAT' })];
    }


    const margin = roadMarginFor(snapshot.track, ego);
    const ahead = traffic.ahead;
    const behind = traffic.behind;
    const corner = trackModel.cornerAhead(ego.distance, 105);
    const line = clamp(trackModel.lineAt(ego.distance + 28), -margin, margin);

    const behindClosing = behind ? behind.other.forwardSpeed - ego.forwardSpeed : 0;
    const blockedBySlowCar = ahead && ahead.delta < AI_LIMITS.obstacleLookaheadM
      && (ahead.other.forwardSpeed < AI_LIMITS.stoppedSpeedMps
        || ahead.other.forwardSpeed < ego.forwardSpeed * AI_LIMITS.obstacleSpeedRatio);
    const beingLapped = behind
      && behind.other.raceProgress > ego.raceProgress + snapshot.track.length * 0.5;
    if (snapshot.raceTime > AI_LIMITS.launchDurationS + 1.5
      && behind && !beingLapped && !blockedBySlowCar && !traffic.alongside
      && behind.delta > -AI_LIMITS.defenseLookbehindM && behindClosing > 1.1
      && (!ahead || ahead.delta > 15 || ahead.other.forwardSpeed >= ego.forwardSpeed - 1)) {
      const requestedInside = clamp(corner.turnSign * Math.min(margin * 0.82, 4.9), -margin, margin);
      const inside = clamp(requestedInside, ego.lateral - 3.2, ego.lateral + 3.2);
      const breakTow = ego.speed > 22 && corner.distanceM > 70
        && Math.abs(behind.lateralDelta) < 1.2;
      const offset = breakTow
        ? clamp(ego.lateral + (ego.lateral >= 0 ? -1 : 1) * Math.min(3.0, margin * 0.55), -margin, margin)
        : inside;
      const corridorOccupied = traffic.entries.some((entry) => entry.other.id !== behind.other.id
        && entry.delta > -2 && entry.delta < 20
        && Math.abs(entry.other.lateral - offset)
          < ego.halfWidth + entry.other.halfWidth + AI_LIMITS.sideClearanceM);
      if (corridorOccupied) {
        return [intent({ terminalLateral: line,
          desiredSpeed: trackModel.speedAt(ego.distance + 18, ego.vehicle),
          reason: 'DEFENSE_CORRIDOR_OCCUPIED' })];
      }
      this.defense = { targetId: behind.other.id, offset, age: 0,
        phase: breakTow ? 'BREAK_TOW' : corner.distanceM < 45 ? 'APEX_SHIELD' : 'DOOR_SHUT',
        overlapSeen: false };
      return this._continueDefense(ego, traffic, trackModel);
    }

    if (ahead && ahead.delta < AI_LIMITS.obstacleLookaheadM) {
      const slowObstacle = ahead.other.forwardSpeed < AI_LIMITS.stoppedSpeedMps
        || ahead.other.forwardSpeed < ego.forwardSpeed * AI_LIMITS.obstacleSpeedRatio;
      const attackRange = slowObstacle ? AI_LIMITS.obstacleLookaheadM : AI_LIMITS.attackLookaheadM;
      if (ahead.delta < attackRange) {
        const closingSpeed = ego.forwardSpeed - ahead.other.forwardSpeed;
        const pulloutDistance = clamp(closingSpeed * 0.5 + ego.forwardSpeed * 0.88 - 3.8, 8.5, 30);
        const shouldPullOut = slowObstacle
          || (ahead.delta <= pulloutDistance && closingSpeed > 0.4)
          || ahead.ttc < 1.8 || ahead.delta < 8;
        const towAligned = !slowObstacle && Math.abs(ahead.lateralDelta) < 1.5;
        const passClearance = ego.halfWidth + ahead.other.halfWidth
          + AI_LIMITS.sideClearanceM + 0.2;
        const provisionalFlanks = [ahead.other.lateral - passClearance,
          ahead.other.lateral + passClearance]
          .map((offset) => clamp(offset, -margin, margin));
        const openFlank = provisionalFlanks.some((offset) => traffic.entries.every((entry) =>
          entry.other.id === ahead.other.id || entry.delta <= -8 || entry.delta >= 28
          || Math.abs(entry.other.lateral - offset)
            >= ego.halfWidth + entry.other.halfWidth + AI_LIMITS.sideClearanceM));
        if (towAligned && !shouldPullOut) {
          const towGap = ego.halfLength + ahead.other.halfLength + 3 + ego.speed * 0.18;
          const gapControlSpeed = ahead.other.forwardSpeed
            + clamp((ahead.delta - towGap) * 0.45, -3, 6);
          return [intent({ mode: 'FOLLOW', phase: 'SLIPSTREAM_TOW', targetId: ahead.other.id,
            terminalLateral: ahead.other.lateral, priority: MANEUVER_PRIORITY.DRAFT,
            desiredSpeed: Math.min(trackModel.speedAt(ego.distance + 30, ego.vehicle),
              openFlank ? Math.max(ego.speed - 0.4, gapControlSpeed) : gapControlSpeed),
            collisionHorizonS: 0.2, reason: 'BUILD_TOW_TO_PULL_OUT' })];
        }

        const minimumPassWidth = ego.halfWidth + ahead.other.halfWidth
          + AI_LIMITS.sideClearanceM + 0.2;
        const negativeSpace = margin + ahead.other.lateral;
        const positiveSpace = margin - ahead.other.lateral;
        const negativeShift = Math.min(3.8, Math.max(minimumPassWidth, negativeSpace * 0.65));
        const positiveShift = Math.min(3.8, Math.max(minimumPassWidth, positiveSpace * 0.65));
        const negativeOffset = clamp(ahead.other.lateral - negativeShift, -margin, margin);
        const positiveOffset = clamp(ahead.other.lateral + positiveShift, -margin, margin);
        const insideSign = corner.turnSign;
        const basePhase = slowObstacle ? 'OBSTACLE_BYPASS' : 'PULL_OUT';
        let negativeScore = negativeSpace * 1.5 + (insideSign < 0 ? 3.5 : 0)
          + (ahead.other.lateralSpeed > 0.08 ? 2.5 : ahead.other.lateralSpeed < -0.08 ? -2 : 0);
        let positiveScore = positiveSpace * 1.5 + (insideSign > 0 ? 3.5 : 0)
          + (ahead.other.lateralSpeed < -0.08 ? 2.5 : ahead.other.lateralSpeed > 0.08 ? -2 : 0);
        if (ego.lateral < ahead.other.lateral) negativeScore += 1;
        else positiveScore += 1;
        const speedIntent = Math.min(trackModel.speedAt(ego.distance + 30, ego.vehicle) * 1.04,
          Math.max(ego.speed + 4, ahead.other.forwardSpeed + (slowObstacle ? 18 : 12)));
        const candidates = [
          intent({ mode: 'PASS', phase: insideSign < 0 ? (corner.distanceM < 55 ? 'DIVEBOMB' : 'ATTACK_INSIDE')
            : (corner.distanceM < 42 ? 'SWITCHBACK' : 'ATTACK_OUTSIDE'),
          targetId: ahead.other.id, terminalLateral: negativeOffset,
          priority: MANEUVER_PRIORITY.ATTACK + (slowObstacle ? 8 : 0) + clamp(negativeScore * 0.18, 0, 3),
          desiredSpeed: speedIntent, committed: false,
          reason: `${basePhase}_LEFT`, attackSide: -1, flankScore: negativeScore,
          urgentPass: openFlank && shouldPullOut }),
          intent({ mode: 'PASS', phase: insideSign > 0 ? (corner.distanceM < 55 ? 'DIVEBOMB' : 'ATTACK_INSIDE')
            : (corner.distanceM < 42 ? 'SWITCHBACK' : 'ATTACK_OUTSIDE'),
          targetId: ahead.other.id, terminalLateral: positiveOffset,
          priority: MANEUVER_PRIORITY.ATTACK + (slowObstacle ? 8 : 0) + clamp(positiveScore * 0.18, 0, 3),
          desiredSpeed: speedIntent, committed: false,
          reason: `${basePhase}_RIGHT`, attackSide: 1, flankScore: positiveScore,
          urgentPass: openFlank && shouldPullOut })
        ];
        if (!slowObstacle && !shouldPullOut) {
          const safeGap = ego.halfLength + ahead.other.halfLength + 4.5 + ego.speed * 0.32;
          candidates.push(intent({
            mode: 'FOLLOW', phase: 'GAP_CONTROL', targetId: ahead.other.id,
            terminalLateral: ahead.other.lateral,
            priority: MANEUVER_PRIORITY.ATTACK - 1,
            desiredSpeed: Math.min(trackModel.speedAt(ego.distance + 24, ego.vehicle),
              Math.max(0, ahead.other.forwardSpeed + clamp((ahead.delta - safeGap) * 0.5, -10, 2))),
            committed: false, collisionHorizonS: 0.45, reason: 'SAFE_FOLLOWING_GAP'
          }));
        }
        return candidates;
      }
    }

    const pacePreview = ego.classKey === 'touring' ? 26 : 18;
    return [intent({ terminalLateral: line,
      desiredSpeed: trackModel.speedAt(ego.distance + pacePreview, ego.vehicle),
      reason: 'OPTIMAL_HARBOR_LINE' })];
  }

  acceptPlan(plan) {
    const intentValue = plan?.intent;
    if (!intentValue) return;
    this.planPhaseAge = this.currentPlan?.intent?.phase === intentValue.phase
      ? this.planPhaseAge + 1 : 0;
    this.currentPlan = plan;
    // A one-cycle safety fallback may reduce speed, but it must not cancel a
    // corridor that the tactical layer already committed to owning.
    if (intentValue.mode === 'LAUNCH') {
      this.launch = { ...intentValue };
    }
    if (intentValue.mode === 'PASS' && !this.attack
      && (plan.collisionFree || finite(plan.earliestCollisionTimeS, 0) > 0.65) && plan.roadLegal
      && intentValue.phase !== 'SLIPSTREAM_TOW') {
      this.attack = {
        targetId: intentValue.targetId,
        offset: plan.terminalLateral,
        originLateral: plan.startLateral,
        side: Math.sign(plan.terminalLateral - finite(plan.startLateral)),
        phase: intentValue.phase,
        overlapSeen: false,
        obstacle: intentValue.reason?.startsWith('OBSTACLE_BYPASS'),
        urgentPass: Boolean(intentValue.urgentPass),
        age: 0,
        maxAge: intentValue.reason?.startsWith('OBSTACLE_BYPASS') ? 14 : 9
      };
    }
  }
}
