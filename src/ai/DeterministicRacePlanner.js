import { clamp } from '../core/math.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const PASSES = new Set(['ATTACK_LEFT', 'ATTACK_RIGHT']);

const classLimits = (vehicle) => vehicle.classKey === 'prototype'
  ? { lateral: 24, closing: 10, threshold: -0.24 }
  : vehicle.classKey === 'gt'
    ? { lateral: 17.5, closing: 7.5, threshold: -0.16 }
    : { lateral: 13.5, closing: 6, threshold: -0.1 };

/**
 * Deterministic race planner.
 *
 * The planner owns one persistent manoeuvre at a time. It does not output
 * steering or pedals; it selects a legal lateral corridor, target, closing
 * speed and commitment. The physical controller remains authoritative.
 */
export class DeterministicRacePlanner {
  constructor(index = 1) {
    this.index = index;
    this.reset();
  }

  reset() {
    this.phase = 'PACE';
    this.targetId = null;
    this.defenseTargetId = null;
    this.targetOffset = 0;
    this.side = 0;
    this.age = 0;
    this.timer = 0;
    this.cooldown = 0;
    this.draftAge = 0;
    this.noProgressAge = 0;
    this.lastTargetDelta = 99;
    this.intent = null;
    this.passedTargetId = null;
    this.passedTargetLock = 0;
    this.defendedTargetId = null;
    this.defendedTargetLock = 0;
    this.holdReason = null;
    return this;
  }

  get attacking() { return PASSES.has(this.phase) && Boolean(this.targetId); }

  _hold(offset, reason, duration = 0.7, cooldown = 0.35) {
    this.phase = 'HOLD';
    this.targetId = null;
    this.defenseTargetId = null;
    this.targetOffset = offset;
    this.timer = duration;
    this.cooldown = Math.max(this.cooldown, cooldown);
    this.age = 0;
    this.intent = null;
    this.holdReason = reason;
  }

  _startPass(candidate, target, limits) {
    this.phase = candidate.phase;
    this.targetId = target.other.id;
    this.defenseTargetId = null;
    this.targetOffset = candidate.corridor.offset;
    this.side = candidate.side;
    this.age = 0;
    this.noProgressAge = 0;
    this.lastTargetDelta = target.delta;
    this.draftAge = 0;
    this.intent = {
      targetId: this.targetId,
      lane: candidate.phase,
      side: candidate.side,
      gapM: target.delta,
      targetClosingSpeed: limits.closing,
      predictedTimeGainS: candidate.timeGainS,
      commitmentDuration: candidate.commitmentS,
      straightSend: candidate.straightSend,
      safetyThresholdM: limits.threshold
    };
  }

  update({ vehicle, track, traffic, awareness, dt, aggression, paceLine = 0,
    recovering = false, pitIntent = null, launchLaneOffset = null }) {
    this.age += dt;
    this.timer = Math.max(0, this.timer - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.passedTargetLock = Math.max(0, this.passedTargetLock - dt);
    if (this.passedTargetLock <= 0) this.passedTargetId = null;
    this.defendedTargetLock = Math.max(0, this.defendedTargetLock - dt);
    if (this.defendedTargetLock <= 0) this.defendedTargetId = null;

    const currentLateral = finite(traffic.current?.lateral);
    const roadMargin = Math.max(2.1,
      finite(track.planningLateralLimit?.(vehicle.distance, 1), finite(track.roadHalfWidth, 6.5) - 1.18),
      finite(track.planningLateralLimit?.(vehicle.distance, -1), finite(track.roadHalfWidth, 6.5) - 1.18));
    const paceOffset = clamp(finite(paceLine), -roadMargin, roadMargin);
    const limits = classLimits(vehicle);

    if (pitIntent?.active) {
      this.phase = 'PIT'; this.targetId = null; this.intent = null;
      return { phase: 'PIT', desiredOffset: finite(pitIntent.targetLateralM, paceOffset),
        target: null, corridor: null, committed: false };
    }
    if (recovering) {
      this.phase = 'RECOVER'; this.targetId = null; this.intent = null;
      return { phase: 'RECOVER', desiredOffset: 0, target: null, corridor: null, committed: false };
    }
    if (Number.isFinite(launchLaneOffset)) {
      this.phase = 'LAUNCH'; this.targetId = null; this.intent = null;
      const laneLeader = traffic.entries
        .filter((entry) => entry.delta > 0 && entry.delta < 18 && entry.longitudinal > 0
          && Math.abs(entry.otherLateral - launchLaneOffset) < 1.45)
        .sort((a, b) => a.delta - b.delta)[0] ?? null;
      return { phase: 'LAUNCH', desiredOffset: clamp(launchLaneOffset, -roadMargin, roadMargin),
        target: laneLeader, corridor: null, committed: false, launching: true };
    }

    if (this.phase === 'HOLD' || this.phase === 'RETURN') {
      if (this.timer > 0) {
        const holdCorridor = awareness.evaluateCorridor({ vehicle, track, traffic,
          terminalOffset: this.targetOffset, targetSpeed: vehicle.speed });
        if (!holdCorridor.collisionFree || !holdCorridor.legal) this.targetOffset = currentLateral;
        return { phase: 'HOLD', desiredOffset: this.targetOffset, target: null, corridor: holdCorridor,
          committed: false, waitReason: this.holdReason ?? 'HOLD_MANOEUVRE_LANE' };
      }
      const corridor = awareness.evaluateCorridor({ vehicle, track, traffic,
        terminalOffset: paceOffset, targetSpeed: Math.max(vehicle.speed,
          track.targetSpeed(vehicle.distance + 22, aggression)) });
      if (!corridor.collisionFree || !corridor.legal) {
        this.phase = 'HOLD';
        return { phase: 'HOLD', desiredOffset: this.targetOffset, target: null, corridor,
          committed: false, waitReason: 'WAIT_CLEAR_RETURN' };
      }
      if (Math.abs(currentLateral - paceOffset) < 0.35) {
        this.phase = 'PACE'; this.targetOffset = paceOffset; this.holdReason = null;
        return { phase: 'PACE', desiredOffset: paceOffset, target: null, corridor,
          committed: false };
      }
      this.phase = 'RETURN';
      return { phase: 'RETURN', desiredOffset: paceOffset, target: null, corridor,
        committed: false, waitReason: 'CLEAR_RETURN' };
    }

    if (this.attacking) {
      const target = traffic.entries.find((entry) => entry.other.id === this.targetId) ?? null;
      if (!target || target.delta < -5.5) {
        if (target) { this.passedTargetId = target.other.id; this.passedTargetLock = 10; }
        this._hold(currentLateral, 'PASS_COMPLETE', 0.65, 0.25);
        return { phase: 'HOLD', desiredOffset: this.targetOffset, target, corridor: null,
          committed: false, waitReason: 'PASS_COMPLETE' };
      }
      const corridor = awareness.evaluateCorridor({ vehicle, track, traffic,
        terminalOffset: this.targetOffset, targetId: this.targetId,
        targetSpeed: Math.max(vehicle.speed, target.other.speed + limits.closing) });
      const thresholdSafe = Boolean(this.intent?.straightSend) && corridor.legal
        && corridor.targetSeparationM >= 3.45
        && corridor.minimumClearanceM >= finite(this.intent?.safetyThresholdM)
        && corridor.blockerTimeS > 0.9;
      const slowEscape = target.other.speed < 6.5 && corridor.legal
        && corridor.targetSeparationM >= 3.45 && corridor.blockerId === this.targetId;
      const safe = corridor.collisionFree || thresholdSafe || slowEscape;
      if (Math.abs(currentLateral - target.otherLateral) >= 3.3
        && target.relativeLongitudinalVelocity < 0.2) this.noProgressAge += dt;
      else this.noProgressAge = Math.max(0, this.noProgressAge - dt * 2);
      if (!safe && target.delta > 4 && Math.abs(currentLateral - target.otherLateral) < 3.15) {
        // A third car may close the selected channel after commitment. Re-plan
        // once across the target instead of cancelling into a timid FOLLOW.
        const alternateSide = -this.side;
        const clearance = target.other.speed < 6.5 ? 4.5 : 3.9;
        const alternateOffset = clamp(target.otherLateral + alternateSide * clearance,
          -roadMargin, roadMargin);
        const alternate = awareness.evaluateCorridor({ vehicle, track, traffic,
          terminalOffset: alternateOffset, targetId: this.targetId,
          targetSpeed: Math.max(vehicle.speed, target.other.speed + limits.closing) });
        const alternateThresholdSafe = Boolean(this.intent?.straightSend) && alternate.legal
          && alternate.targetSeparationM >= 3.45
          && alternate.minimumClearanceM >= finite(this.intent?.safetyThresholdM)
          && alternate.blockerTimeS > 0.9;
        if (alternate.targetSeparationM >= 3.45
          && (alternate.collisionFree || alternateThresholdSafe)) {
          this.side = alternateSide;
          this.phase = alternateSide > 0 ? 'ATTACK_LEFT' : 'ATTACK_RIGHT';
          this.targetOffset = alternateOffset;
          this.age = 0;
          this.noProgressAge = 0;
          this.intent = { ...this.intent, lane: this.phase, side: this.side };
          return { phase: this.phase, desiredOffset: this.targetOffset, target,
            corridor: alternate, committed: true,
            straightSend: Boolean(this.intent?.straightSend),
            safetyThresholdM: finite(this.intent?.safetyThresholdM),
            predictedTimeGainS: finite(this.intent?.predictedTimeGainS) };
        }
      }
      if (!safe || this.age > finite(this.intent?.commitmentDuration, 8)
        || this.noProgressAge > 2.2) {
        this._hold(currentLateral, !safe ? 'CORRIDOR_CHANGED' : 'PASS_NO_PROGRESS', 0.75, 0.45);
        return { phase: 'HOLD', desiredOffset: this.targetOffset, target, corridor,
          committed: false, abortReason: this.holdReason };
      }
      return { phase: this.phase, desiredOffset: this.targetOffset, target, corridor,
        committed: true, straightSend: Boolean(this.intent?.straightSend),
        safetyThresholdM: finite(this.intent?.safetyThresholdM),
        predictedTimeGainS: finite(this.intent?.predictedTimeGainS) };
    }

    if (this.phase === 'DEFEND_LEFT' || this.phase === 'DEFEND_RIGHT') {
      const challenger = traffic.entries.find((entry) => entry.other.id === this.defenseTargetId) ?? null;
      if (!challenger || challenger.delta > 5 || challenger.delta < -34 || this.age > 3.8) {
        this._hold(currentLateral, 'DEFENCE_COMPLETE', 0.55, 0.5);
        return { phase: 'HOLD', desiredOffset: this.targetOffset, target: challenger,
          corridor: null, committed: false, waitReason: 'DEFENCE_COMPLETE' };
      }
      return { phase: this.phase, desiredOffset: this.targetOffset, target: challenger,
        corridor: null, committed: false, defending: true };
    }

    const target = traffic.entries
      .filter((entry) => entry.other.id !== this.passedTargetId
        && entry.delta > 0 && entry.delta < 55 && entry.longitudinal > -1.5
        && Math.abs(entry.side) < roadMargin * 2 + 0.5
        && !(entry.other.aiTactical?.passTargetId === vehicle.id && entry.delta < 8))
      .sort((a, b) => a.delta - b.delta)[0] ?? null;
    const challenger = traffic.entries
      .filter((entry) => entry.other.id !== this.defendedTargetId
        && entry.delta < -1.5 && entry.delta > -42 && entry.longitudinal < 3.5
        && Math.abs(entry.side) < roadMargin * 2 + 0.5)
      .sort((a, b) => b.delta - a.delta)[0] ?? null;

    // One legal defensive move, selected from predicted challenger overlap.
    const challengerClosing = challenger
      ? challenger.otherForwardSpeed - traffic.egoForwardSpeed : 0;
    const predictedOverlapS = challenger && challengerClosing > 0.1
      ? Math.max(0, (-challenger.delta - 2.5) / challengerClosing) : 99;
    if (challenger && this.cooldown <= 0 && vehicle.speed > 10
      && challengerClosing > 0.6 && (predictedOverlapS < 3.5 || challenger.delta > -18)
      && (!target || target.delta > 7)) {
      const turn = [24, 42, 64].map((distance) => track.atDistance(vehicle.distance + distance))
        .sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
      const turnSign = Math.sign(finite(turn?.turnSign)) || (challenger.side > 0 ? -1 : 1);
      const overlapStarted = Math.abs(challenger.longitudinal) < 4.8;
      const requested = overlapStarted ? currentLateral
        : clamp(turnSign * Math.min(3.65, roadMargin * 0.8), -roadMargin, roadMargin);
      const choices = [requested,
        currentLateral + (requested - currentLateral) * 0.75,
        currentLateral + (requested - currentLateral) * 0.5,
        currentLateral].filter((value, index, values) => values.indexOf(value) === index)
        .map((offset) => ({ offset, corridor: awareness.evaluateCorridor({ vehicle, track, traffic,
          terminalOffset: offset, targetId: challenger.other.id, targetSpeed: vehicle.speed }) }));
      const choice = choices.find((entry) => entry.corridor.legal
        && (entry.corridor.collisionFree
          || entry.corridor.blockerId === challenger.other.id)) ?? null;
      if (choice) {
        this.phase = choice.offset >= currentLateral ? 'DEFEND_LEFT' : 'DEFEND_RIGHT';
        this.defenseTargetId = challenger.other.id;
        this.targetId = null;
        this.targetOffset = choice.offset;
        this.side = Math.sign(choice.offset - currentLateral);
        this.age = 0;
        this.defendedTargetId = challenger.other.id;
        this.defendedTargetLock = 10;
        this.intent = { targetId: challenger.other.id, lane: this.phase,
          side: this.side, gapM: -challenger.delta, commitmentDuration: 3.8 };
        return { phase: this.phase, desiredOffset: this.targetOffset, target: challenger,
          corridor: choice.corridor, committed: false, defending: true };
      }
    }

    if (!target || this.cooldown > 0) {
      this.phase = 'PACE'; this.draftAge = 0; this.targetId = null; this.intent = null;
      return { phase: 'PACE', desiredOffset: paceOffset, target: null, corridor: null, committed: false };
    }

    const turn = [20, 36, 54].map((distance) => track.atDistance(vehicle.distance + distance))
      .sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
    const turnSign = Math.sign(finite(turn?.turnSign));
    const curvature = Math.abs(finite(turn?.curvature));
    const straight = curvature < 0.0028;
    const clearance = target.other.speed < 6.5 ? 4.5 : 3.9;
    const offsets = [
      { phase: 'ATTACK_LEFT', side: 1, offset: clamp(target.otherLateral + clearance, -roadMargin, roadMargin) },
      { phase: 'ATTACK_RIGHT', side: -1, offset: clamp(target.otherLateral - clearance, -roadMargin, roadMargin) }
    ];
    const candidates = offsets.map((candidate) => {
      const corridor = awareness.evaluateCorridor({ vehicle, track, traffic,
        terminalOffset: candidate.offset, targetId: target.other.id,
        targetSpeed: Math.max(vehicle.speed, target.other.speed + limits.closing) });
      const thresholdSafe = straight && corridor.legal && corridor.minimumClearanceM >= limits.threshold
        && corridor.blockerTimeS > 0.9;
      const slowEscape = target.other.speed < 6.5 && corridor.legal
        && corridor.blockerId === target.other.id;
      const reservation = traffic.entries.find((entry) => entry.other.id !== target.other.id
        && entry.delta > -8 && entry.delta < 24
        && (entry.other.aiTactical?.passPhase?.startsWith('ATTACK_')
          || entry.other.aiTactical?.defending)
        && Math.abs(finite(entry.other.aiTactical?.targetLaneOffsetM,
          entry.otherTargetLateral) - candidate.offset) < 3.0) ?? null;
      const legal = !reservation && corridor.targetSeparationM >= 3.45
        && (corridor.collisionFree || thresholdSafe || slowEscape);
      const transitionS = 0.78 + Math.abs(candidate.offset - currentLateral) * 0.16;
      const isInside = turnSign !== 0 && candidate.side === turnSign;
      const effectiveCurvature = curvature * (isInside ? 1.08 : 0.91);
      const cornerSpeed = effectiveCurvature > 1e-5
        ? Math.sqrt(limits.lateral / effectiveCurvature) : vehicle.speed + limits.closing;
      const predictedSpeed = Math.min(Math.max(vehicle.speed + 1.5,
        target.other.speed + limits.closing), cornerSpeed);
      const timeGainS = 100 / Math.max(4, target.other.speed)
        - 100 / Math.max(4, predictedSpeed);
      const exitBias = curvature > 0.0035
        ? (isInside ? (target.delta < 18 ? 0.82 : 0.35) : 0.62) : 0;
      // Stable diversity prevents an entire pack from requesting the same
      // channel on the same tick while still letting measured time gain win.
      const spreadBias = (((this.index + String(target.other.id).length) & 1)
        ? candidate.side : -candidate.side) * 0.22;
      const score = legal ? corridor.minimumClearanceM * 1.4 + timeGainS * 3.5
        - transitionS * 0.4 + exitBias + spreadBias + (straight ? 1.2 : 0) : -Infinity;
      return { ...candidate, corridor, legal, transitionS, predictedSpeed,
        timeGainS, score, reservationId: reservation?.other.id ?? null,
        straightSend: straight && timeGainS > 0.04,
        commitmentS: target.other.speed < 6.5 ? 13 : 8 };
    }).filter((candidate) => candidate.legal).sort((a, b) => b.score - a.score);

    const speedOpportunity = vehicle.speed > target.other.speed + 0.4
      || target.other.speed < 6.5 || target.delta < 20;
    const chosen = candidates[0] ?? null;
    if (chosen && target.delta < 48 && speedOpportunity) {
      this._startPass(chosen, target, limits);
      return { phase: this.phase, desiredOffset: this.targetOffset, target,
        corridor: chosen.corridor, committed: true, straightSend: chosen.straightSend,
        safetyThresholdM: limits.threshold, predictedTimeGainS: chosen.timeGainS };
    }

    this.phase = 'FOLLOW';
    this.targetId = null;
    this.intent = null;
    this.draftAge += dt;
    const bestProbe = candidates[0];
    const followOffset = bestProbe && this.draftAge > 0.45
      ? currentLateral + (bestProbe.offset - currentLateral) * 0.7
      : target.otherLateral;
    return { phase: 'FOLLOW', desiredOffset: clamp(followOffset, -roadMargin, roadMargin),
      target, corridor: bestProbe?.corridor ?? null, committed: false,
      waitReason: bestProbe ? 'BUILD_PASS_GAP' : 'NO_FULL_WIDTH_CORRIDOR' };
  }
}

export const DETERMINISTIC_PASS_PHASES = PASSES;
