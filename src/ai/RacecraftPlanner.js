import { clamp } from '../core/math.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const ATTACKS = new Set(['ATTACK_INSIDE', 'ATTACK_OUTSIDE', 'SWITCHBACK']);

export class RacecraftPlanner {
  constructor(index = 1) {
    this.index = index;
    this.reset();
  }

  reset() {
    this.phase = 'NONE';
    this.targetId = null;
    this.targetOffset = 0;
    this.timer = 0;
    this.age = 0;
    this.cooldown = 0;
    this.draftAge = 0;
    this.side = 0;
    this.lastTargetDelta = 99;
    this.noProgressAge = 0;
    this.intent = null;
    this.passedTargetId = null;
    this.targetLockTime = 0;
    this.defenseTargetId = null;
    return this;
  }

  get attacking() { return ATTACKS.has(this.phase) && Boolean(this.targetId); }

  _clear(phase = 'NONE', cooldown = 0) {
    this.phase = phase;
    this.targetId = null;
    this.timer = phase === 'RETURN' ? 0.75 : 0;
    this.cooldown = Math.max(this.cooldown, cooldown);
    this.age = 0;
    this.noProgressAge = 0;
    this.intent = null;
    if (phase !== 'DEFEND') this.defenseTargetId = null;
  }

  update({ vehicle, track, traffic, awareness, dt, aggression, policyLine = 0, recovering = false,
    pitIntent = null, tacticalDirective = null, launchLaneOffset = null }) {
    this.timer = Math.max(0, this.timer - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.targetLockTime = Math.max(0, this.targetLockTime - dt);
    if (this.targetLockTime <= 0) this.passedTargetId = null;
    const roadMargin = Math.max(2.1, finite(track.roadHalfWidth, 6.5) - 1.75);
    const currentLateral = finite(traffic.current?.lateral);
    // Traffic owns the current lane. An arbitrary index-derived offset made
    // every grid car cross toward the centre at green and later behaved like
    // a fixed-line magnet in packs. Rejoin the pace line only in open space.
    const baseOffset = clamp(Number.isFinite(launchLaneOffset)
      ? launchLaneOffset : policyLine, -roadMargin, roadMargin);

    if (pitIntent?.active) {
      this._clear('NONE');
      return { phase: 'PIT', desiredOffset: finite(pitIntent.targetLateralM, baseOffset), target: null, corridor: null, committed: false };
    }
    if (recovering) {
      this._clear('NONE');
      return { phase: 'RECOVER', desiredOffset: 0, target: null, corridor: null, committed: false };
    }
    if (Number.isFinite(launchLaneOffset)) {
      this._clear('NONE');
      const laneLeader = traffic.entries
        .filter((entry) => entry.delta > 0 && entry.delta < 18 && entry.longitudinal > 0
          && Math.abs(entry.otherLateral - launchLaneOffset) < 1.45)
        .sort((a, b) => a.delta - b.delta)[0] ?? null;
      return { phase: 'LAUNCH', desiredOffset: baseOffset, target: laneLeader,
        corridor: null, committed: false, launching: true };
    }
    // A low-confidence learned logit must never cancel an already-safe pass.
    // Stage 5 currently has many near-uniform (~20%) decisions, so ABORT is
    // advisory until it is both decisive and the manoeuvre has settled.
    if (tacticalDirective?.maneuver === 'ABORT' && finite(tacticalDirective.confidence) >= 0.52
      && this.attacking && this.age > 0.65) {
      this._clear('RETURN', 0.45);
      return { phase: 'RETURN', desiredOffset: baseOffset, target: null, corridor: null,
        committed: false, abortReason: 'RL_STAGE5_ABORT' };
    }

    if (this.phase === 'DEFEND') {
      const challenger = traffic.entries.find((entry) => entry.other.id === this.defenseTargetId) ?? null;
      this.age += dt;
      const passed = challenger && challenger.delta > 4.8;
      const gone = !challenger || challenger.delta < -32;
      if (passed || gone || this.age > 4.8) {
        this._clear('RETURN', 0.55);
        return { phase: 'RETURN', desiredOffset: this.targetOffset, target: null,
          corridor: null, committed: false, defending: false };
      }
      // Once overlap starts, the legal move is over: hold the chosen lane and
      // leave the other lane available. Never weave in reaction to their side.
      return { phase: 'DEFEND', desiredOffset: this.targetOffset, target: challenger,
        corridor: null, committed: false, defending: true };
    }

    // Rejoining the racing line is itself a manoeuvre.  Do not immediately
    // collapse back to baseOffset after a pass: in a pack that made two cars
    // cross the same strip of asphalt from opposite sides.  Hold the completed
    // pass lane until the entire swept return corridor is free, then merge.
    if (this.phase === 'RETURN') {
      const currentLateral = finite(traffic.current?.lateral);
      const returnCorridor = awareness.evaluateCorridor({
        vehicle, track, traffic, terminalOffset: baseOffset,
        targetSpeed: Math.max(vehicle.speed, track.targetSpeed(vehicle.distance + 18, aggression))
      });
      if (Math.abs(currentLateral - baseOffset) < 0.42) {
        this.phase = 'NONE';
        this.targetOffset = baseOffset;
      } else if (this.timer > 0 || !returnCorridor.collisionFree) {
        return { phase: 'RETURN', desiredOffset: this.targetOffset, target: null,
          corridor: returnCorridor, committed: false, waitReason: 'HOLD_PASS_LANE' };
      } else {
        return { phase: 'RETURN', desiredOffset: baseOffset, target: null,
          corridor: returnCorridor, committed: false, waitReason: 'SAFE_REJOIN' };
      }
    }

    if (this.attacking) {
      const target = traffic.entries.find((entry) => entry.other.id === this.targetId) ?? null;
      this.age += dt;
      if (!target || target.delta < -5.2) {
        this.passedTargetId = this.targetId;
        this.targetLockTime = 18;
        this._clear('RETURN', 0.8);
        return { phase: 'RETURN', desiredOffset: baseOffset, target, corridor: null, committed: false };
      }
      const targetSpeed = Math.max(vehicle.speed, target.other.speed + 7);
      const corridor = awareness.evaluateCorridor({
        vehicle, track, traffic, terminalOffset: this.targetOffset,
        targetId: this.targetId, targetSpeed
      });
      // Progress is a velocity, not a per-tick distance threshold. At 120 Hz a
      // healthy 6 m/s closing rate changes the gap by only 5 cm per update, so
      // the former 12 cm test falsely aborted every successful attack at 2.2 s.
      const lateralPassClear = Math.abs(finite(traffic.current?.lateral) - target.otherLateral) >= 3.3;
      if (lateralPassClear && target.relativeLongitudinalVelocity < 0.15) this.noProgressAge += dt;
      else this.noProgressAge = Math.max(0, this.noProgressAge - dt * 2);
      this.lastTargetDelta = target.delta;
      const targetEnvelopeAllowed = Boolean(this.intent?.straightSend)
        && corridor.legal && corridor.targetSeparationM >= 3.45
        && corridor.minimumClearanceM >= finite(this.intent?.safetyThresholdM, 0)
        && corridor.blockerTimeS > 0.9;
      const staticTargetEscape = target.other.speed < 6.5 && corridor.legal
        && corridor.targetSeparationM >= 3.45 && corridor.blockerId === this.targetId;
      // The pass target is not an automatic collision exemption. If it turns
      // into our selected lane, the committed path must be revalidated by the
      // same explicit straight-send threshold as every new attack.
      const newlyUnsafe = !corridor.collisionFree && !targetEnvelopeAllowed && !staticTargetEscape;
      const requestedCommitment = finite(this.intent?.commitmentDuration, target.other.speed < 2.5 ? 14 : 8);
      // Commitment covers the physical lane change and overlap, not merely the
      // 20 Hz policy action lifetime. Do not abandon a progressing move midway.
      const minimumAttackAge = target.other.speed < 2.5 ? 12 : 6;
      const maximumAttackAge = clamp(Math.max(requestedCommitment, minimumAttackAge),
        minimumAttackAge, target.other.speed < 2.5 ? 14 : 9);
      if (this.age > maximumAttackAge || this.noProgressAge > 2.2 || newlyUnsafe) {
        this._clear('RETURN', 1.1);
        return { phase: 'RETURN', desiredOffset: baseOffset, target, corridor, committed: false, abortReason: newlyUnsafe ? 'NEW_BLOCKER' : 'NO_PROGRESS' };
      }
      return { phase: this.phase, desiredOffset: this.targetOffset, target, corridor, committed: true,
        straightSend: Boolean(this.intent?.straightSend),
        safetyThresholdM: finite(this.intent?.safetyThresholdM),
        predictedTimeGainS: finite(this.intent?.predictedTimeGainS) };
    }

    const target = traffic.entries
      .filter((entry) => entry.other.id !== this.passedTargetId
        // Awareness spans the legal circuit width. Restricting this to 3.8 m
        // made an opponent disappear as soon as the attacker pulled alongside,
        // which immediately reactivated the fixed racing-line return.
        && entry.delta > 0 && entry.delta < 55 && entry.longitudinal > -1.5
        // Let an opponent finish a pass before considering a counterattack.
        // Otherwise both cars target each other during overlap and cross into
        // the same lane with mutually valid but incompatible plans.
        && !(entry.other.aiTactical?.passTargetId === vehicle.id && entry.delta < 8)
        && Math.abs(entry.side) < roadMargin * 2 + 0.5)
      .sort((a, b) => a.delta - b.delta)[0] ?? null;
    const challenger = traffic.entries
      .filter((entry) => entry.delta < -3 && entry.delta > -32
        && entry.longitudinal < 2.5 && Math.abs(entry.side) < roadMargin * 2 + 0.5)
      .sort((a, b) => b.delta - a.delta)[0] ?? null;
    const challengerClosing = challenger
      ? challenger.otherForwardSpeed - traffic.egoForwardSpeed : 0;
    const challengerPullingOut = challenger
      && (Math.abs(challenger.side) > 1.2 || Math.abs(challenger.otherTargetLateral - challenger.otherLateral) > 0.7);
    const stage5Defense = tacticalDirective?.maneuver === 'DEFEND_LEFT'
      || tacticalDirective?.maneuver === 'DEFEND_RIGHT';
    const defenseWindow = (challenger
      && challengerClosing > (challengerPullingOut ? 0.8 : 1.4)
      && traffic.egoForwardSpeed > 8
      && (!target || target.delta > 13 || target.other.speed > vehicle.speed - 1)
      && this.cooldown <= 0) || Boolean(stage5Defense && challenger && this.cooldown <= 0);
    if (defenseWindow) {
      const turnSamples = [24, 42, 62].map((distance) => track.atDistance(vehicle.distance + distance));
      const turn = turnSamples.sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
      const turnSign = Math.sign(finite(turn?.turnSign)) || (this.index % 2 ? 1 : -1);
      const insideLane = clamp(turnSign * Math.min(3.7, roadMargin * 0.78), -roadMargin, roadMargin);
      // Track positive lateral is vehicle-left (track normal is -vehicle.right).
      const requestedDefenseOffset = tacticalDirective?.maneuver === 'DEFEND_LEFT' ? Math.abs(insideLane)
        : tacticalDirective?.maneuver === 'DEFEND_RIGHT' ? -Math.abs(insideLane) : insideLane;
      const defenseOffsets = [requestedDefenseOffset, currentLateral,
        -requestedDefenseOffset].filter((value, index, values) => values.indexOf(value) === index);
      const defenseChoices = defenseOffsets.map((offset) => ({ offset,
        corridor: awareness.evaluateCorridor({ vehicle, track, traffic,
          terminalOffset: offset, targetId: challenger.other.id, targetSpeed: vehicle.speed }) }));
      // A requested move may be occupied, but defence itself is not cancelled:
      // hold the current legal lane or use the opposite legal corridor.
      const defenseChoice = defenseChoices.find((choice) => choice.corridor.collisionFree
        && choice.corridor.legal) ?? null;
      if (defenseChoice) {
        const { offset: defenseOffset, corridor } = defenseChoice;
        this.phase = 'DEFEND';
        this.defenseTargetId = challenger.other.id;
        this.targetOffset = defenseOffset;
        this.age = 0;
        this.intent = { targetId: challenger.other.id, side: Math.sign(defenseOffset - currentLateral),
          lane: defenseOffset === currentLateral ? 'DEFEND_HOLD' : 'DEFEND_LANE', gapM: -challenger.delta };
        return { phase: 'DEFEND', desiredOffset: defenseOffset, target: challenger,
          corridor, committed: false, defending: true };
      }
    }
    if (!target || target.delta > 55 || this.cooldown > 0) {
      this.draftAge = 0;
      return { phase: this.phase, desiredOffset: baseOffset, target, corridor: null, committed: false };
    }

    const turnSamples = [18, 34, 52].map((distance) => track.atDistance(vehicle.distance + distance));
    const turn = turnSamples.sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
    const turnSign = Math.sign(finite(turn?.turnSign)) || (target.otherLateral >= 0 ? -1 : 1);
    const clearance = target.other.speed < 2 ? 4.5 : 3.9;
    let insideOffset = clamp(target.otherLateral + turnSign * clearance, -roadMargin, roadMargin);
    let outsideOffset = clamp(target.otherLateral - turnSign * clearance, -roadMargin, roadMargin);
    if (tacticalDirective?.source === 'RL_STAGE5') {
      const requestedCorridor = clamp(finite(tacticalDirective.targetCorridor) * roadMargin, -roadMargin, roadMargin);
      if (Math.abs(requestedCorridor - target.otherLateral) >= 3.55) {
        if (Math.sign(requestedCorridor - target.otherLateral) === turnSign) insideOffset = requestedCorridor;
        else outsideOffset = requestedCorridor;
      }
    }
    const targetSpeed = Math.max(vehicle.speed, target.other.speed + 7);
    const inside = awareness.evaluateCorridor({ vehicle, track, traffic, terminalOffset: insideOffset, targetId: target.other.id, targetSpeed });
    const outside = awareness.evaluateCorridor({ vehicle, track, traffic, terminalOffset: outsideOffset, targetId: target.other.id, targetSpeed });
    let evaluatedCandidates = [
      { side: turnSign, phase: 'ATTACK_INSIDE', corridor: inside },
      { side: -turnSign, phase: Math.abs(finite(turn?.curvature)) > 0.0045 ? 'SWITCHBACK' : 'ATTACK_OUTSIDE', corridor: outside }
    ];
    const requestedManeuver = tacticalDirective?.source === 'RL_STAGE5' ? tacticalDirective.maneuver : null;
    const policyConfidence = clamp(finite(tacticalDirective?.confidence), 0, 1);
    // Every manoeuvre is evaluated over the same predictive occupancy field.
    // Clearance is the primary score; exit opportunity breaks ties without
    // allowing a theoretical time gain to override a blocked body corridor.
    const lateralBudget = vehicle.classKey === 'prototype' ? 24 : vehicle.classKey === 'gt' ? 17.5 : 13.5;
    const turnCurvature = Math.abs(finite(turn?.curvature));
    const straightOpportunity = turnCurvature < 0.0028;
    // The swept envelopes intentionally include extra racing margin. On a
    // straight, a small overlap of those conservative envelopes can still be
    // physically legal. This is the explicit, measurable send threshold.
    const safetyThresholdM = vehicle.classKey === 'prototype' ? -0.24
      : vehicle.classKey === 'gt' ? -0.16 : -0.1;
    const candidates = evaluatedCandidates
      .filter((candidate) => candidate.corridor.targetSeparationM >= 3.45
        && (candidate.corridor.collisionFree || (straightOpportunity
          && candidate.corridor.legal
          && candidate.corridor.minimumClearanceM >= safetyThresholdM
          && candidate.corridor.blockerTimeS > 0.9)))
      .map((candidate) => {
        const isInside = candidate.side === turnSign;
        const effectiveCurvature = turnCurvature * (isInside ? 1.08 : 0.91);
        const cornerSpeed = effectiveCurvature > 1e-5
          ? Math.sqrt(lateralBudget / effectiveCurvature) : Math.max(vehicle.speed, target.other.speed + 7);
        const predictedSpeed = Math.min(Math.max(vehicle.speed, target.other.speed + 4), cornerSpeed);
        const opponentSpeed = Math.max(4, target.other.speed);
        const timeGainS = 90 / opponentSpeed - 90 / Math.max(4, predictedSpeed);
        const transitionTimeS = 0.78 + Math.abs(candidate.corridor.offset - finite(traffic.current?.lateral)) * 0.16;
        const switchbackBonus = candidate.phase === 'SWITCHBACK'
          && target.otherTargetLateral * turnSign > 0 ? 0.32 : 0;
        const insideBrakingOpportunity = isInside && turnCurvature > 0.003
          ? clamp((vehicle.speed - target.other.speed) * 0.12 + turnCurvature * 20, 0, 0.9) : 0;
        // Positive Frenet lateral is the driver's left; negative is right.
        const requestedSideMatch = requestedManeuver === 'ATTACK_LEFT'
          ? candidate.corridor.offset > target.otherLateral
          : requestedManeuver === 'ATTACK_RIGHT'
            ? candidate.corridor.offset < target.otherLateral
            : requestedManeuver === 'LATE_BRAKE'
              ? candidate.side === turnSign
              : requestedManeuver === 'SWITCHBACK' ? candidate.side !== turnSign : false;
        // Learned tactics rank safe alternatives; they never delete the only
        // open lane. A blocked requested side must immediately fall back to the
        // other legal side instead of braking behind the target indefinitely.
        const policyPreference = requestedSideMatch ? 0.35 + policyConfidence * 1.4 : 0;
        const straightSend = straightOpportunity && timeGainS >= 0.055;
        return { ...candidate, predictedSpeed, timeGainS, transitionTimeS,
          score: candidate.corridor.minimumClearanceM * 1.35 + timeGainS * 2.4
            - transitionTimeS * 0.35 + switchbackBonus + insideBrakingOpportunity * 1.25
            + policyPreference + (straightSend ? 1.4 + timeGainS * 3.2 : 0),
          straightSend, safetyThresholdM };
      })
      .sort((a, b) => b.score - a.score
        || b.corridor.minimumClearanceM - a.corridor.minimumClearanceM);

    const speedAdvantage = vehicle.speed - target.other.speed;
    const attackRange = target.other.speed < vehicle.speed * 0.82
      ? 46 : 34 + aggression * 6;
    // A clear lane is itself the permission to attack. Requiring an existing
    // closing velocity deadlocked the controller with its own follow-gap rule:
    // it matched speed, therefore never became “closing”, therefore drafted
    // indefinitely despite drawing a valid pass corridor in debug view.
    // FOLLOW/DRAFT are temporary setup choices, not a veto over an obvious
    // clean pass. Only a confident request is honoured, and only while the car
    // is still far enough back and has not already spent a second waiting.
    const stage5Wait = tacticalDirective?.source === 'RL_STAGE5'
      && ['FOLLOW', 'DRAFT'].includes(requestedManeuver)
      && policyConfidence >= 0.42 && target.delta > 15
      && speedAdvantage < 3.5 && this.draftAge < 1;
    const chosen = candidates[0] ?? null;
    if (chosen && (!stage5Wait || chosen.straightSend)
      && (target.delta < attackRange || chosen.straightSend)) {
      this.phase = chosen.phase;
      this.targetId = target.other.id;
      this.targetOffset = chosen.corridor.offset;
      this.side = chosen.side;
      this.age = 0;
      this.noProgressAge = 0;
      this.lastTargetDelta = target.delta;
      this.draftAge = 0;
      this.intent = { targetId: this.targetId, side: this.side,
        lane: this.phase.includes('INSIDE') ? 'INSIDE' : 'OUTSIDE', gapM: target.delta,
        predictedSpeed: chosen.predictedSpeed, predictedTimeGainS: chosen.timeGainS,
        straightSend: chosen.straightSend, safetyThresholdM: chosen.safetyThresholdM,
        targetClosingSpeed: finite(tacticalDirective?.targetClosingSpeed),
        commitmentDuration: finite(tacticalDirective?.commitmentDuration,
          target.other.speed < 2.5 ? 14 : 8) };
      return { phase: this.phase, desiredOffset: this.targetOffset, target, corridor: chosen.corridor, committed: true,
        straightSend: chosen.straightSend, safetyThresholdM: chosen.safetyThresholdM,
        predictedTimeGainS: chosen.timeGainS };
    }

    // Draft is a short setup only when both adjacent corridors are genuinely
    // occupied. It never overrides an available overtake.
    this.draftAge += dt;
    this.phase = 'DRAFT';
    // If both full corridors are blocked, begin a conservative lateral probe
    // after one second instead of staring at the rear bumper. The trajectory
    // planner and follow-gap controller remain authoritative until a complete
    // body-width corridor becomes legal.
    const probe = [...evaluatedCandidates]
      .sort((a, b) => b.corridor.minimumClearanceM - a.corridor.minimumClearanceM)[0];
    const probeOffset = this.draftAge > 0.45 && probe
      ? clamp(finite(target.otherLateral) + (finite(probe.corridor.offset) - finite(target.otherLateral)) * 0.72,
        -roadMargin, roadMargin)
      : clamp(target.otherLateral, -roadMargin, roadMargin);
    return { phase: 'DRAFT', desiredOffset: probeOffset, target, corridor: probe?.corridor ?? null, committed: false,
      waitReason: this.draftAge > 0.45 ? 'CREATE_PASS_CORRIDOR' : 'NO_SAFE_LATERAL_CORRIDOR' };
  }
}

export { ATTACKS as ATTACK_PHASES };
