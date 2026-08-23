import { clamp } from '../core/math.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const ATTACKS = new Set(['ATTACK_INSIDE', 'ATTACK_OUTSIDE', 'SWITCHBACK']);

export class RacecraftPlanner {
  constructor(index = 1) {
    this.index = index;
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

  update({ vehicle, track, traffic, awareness, dt, aggression, policyLine = 0, recovering = false, pitIntent = null }) {
    this.timer = Math.max(0, this.timer - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.targetLockTime = Math.max(0, this.targetLockTime - dt);
    if (this.targetLockTime <= 0) this.passedTargetId = null;
    const roadMargin = Math.max(2.1, finite(track.roadHalfWidth, 6.5) - 1.75);
    const baseOffset = clamp(((this.index % 4) - 1.5) * 0.5 + policyLine, -roadMargin, roadMargin);

    if (pitIntent?.active) {
      this._clear('NONE');
      return { phase: 'PIT', desiredOffset: finite(pitIntent.targetLateralM, baseOffset), target: null, corridor: null, committed: false };
    }
    if (recovering) {
      this._clear('NONE');
      return { phase: 'RECOVER', desiredOffset: 0, target: null, corridor: null, committed: false };
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
      if (target.relativeLongitudinalVelocity < 0.15) this.noProgressAge += dt;
      else this.noProgressAge = Math.max(0, this.noProgressAge - dt * 2);
      this.lastTargetDelta = target.delta;
      const newlyUnsafe = !corridor.collisionFree && corridor.blockerId !== this.targetId;
      if (this.age > 8 || this.noProgressAge > 2.2 || newlyUnsafe) {
        this._clear('RETURN', 1.1);
        return { phase: 'RETURN', desiredOffset: baseOffset, target, corridor, committed: false, abortReason: newlyUnsafe ? 'NEW_BLOCKER' : 'NO_PROGRESS' };
      }
      return { phase: this.phase, desiredOffset: this.targetOffset, target, corridor, committed: true };
    }

    const target = traffic.entries
      .filter((entry) => entry.other.id !== this.passedTargetId
        && entry.delta > 0 && entry.delta < 55 && entry.longitudinal > -1.5 && Math.abs(entry.side) < 3.8)
      .sort((a, b) => a.delta - b.delta)[0] ?? null;
    const challenger = traffic.behind;
    const challengerClosing = challenger
      ? challenger.otherForwardSpeed - traffic.egoForwardSpeed : 0;
    const defenseWindow = challenger && challenger.delta < -8 && challenger.delta > -25
      && challengerClosing > 2.5 && Math.abs(challenger.side) < 2.2
      && traffic.egoForwardSpeed > 8 && (!target || target.delta > 30) && this.cooldown <= 0;
    if (defenseWindow) {
      const turnSamples = [24, 42, 62].map((distance) => track.atDistance(vehicle.distance + distance));
      const turn = turnSamples.sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
      const turnSign = Math.sign(finite(turn?.turnSign)) || (this.index % 2 ? 1 : -1);
      const defenseOffset = clamp(challenger.otherLateral + turnSign * 3.7, -roadMargin, roadMargin);
      const corridor = awareness.evaluateCorridor({ vehicle, track, traffic,
        terminalOffset: defenseOffset, targetId: challenger.other.id, targetSpeed: vehicle.speed });
      if (corridor.collisionFree && corridor.legal && corridor.targetSeparationM >= 3.45) {
        this.phase = 'DEFEND';
        this.defenseTargetId = challenger.other.id;
        this.targetOffset = defenseOffset;
        this.age = 0;
        this.intent = { targetId: challenger.other.id, side: turnSign, lane: 'DEFEND_INSIDE', gapM: -challenger.delta };
        return { phase: 'DEFEND', desiredOffset: defenseOffset, target: challenger,
          corridor, committed: false, defending: true };
      }
    }
    if (!target || target.delta > 38 || this.cooldown > 0) {
      this.draftAge = 0;
      return { phase: this.phase, desiredOffset: baseOffset, target, corridor: null, committed: false };
    }

    const turnSamples = [18, 34, 52].map((distance) => track.atDistance(vehicle.distance + distance));
    const turn = turnSamples.sort((a, b) => Math.abs(b.curvature) - Math.abs(a.curvature))[0];
    const turnSign = Math.sign(finite(turn?.turnSign)) || (target.otherLateral >= 0 ? -1 : 1);
    const clearance = target.other.speed < 2 ? 4.5 : 3.9;
    const insideOffset = clamp(target.otherLateral + turnSign * clearance, -roadMargin, roadMargin);
    const outsideOffset = clamp(target.otherLateral - turnSign * clearance, -roadMargin, roadMargin);
    const targetSpeed = Math.max(vehicle.speed, target.other.speed + 7);
    const inside = awareness.evaluateCorridor({ vehicle, track, traffic, terminalOffset: insideOffset, targetId: target.other.id, targetSpeed });
    const outside = awareness.evaluateCorridor({ vehicle, track, traffic, terminalOffset: outsideOffset, targetId: target.other.id, targetSpeed });
    const evaluatedCandidates = [
      { side: turnSign, phase: 'ATTACK_INSIDE', corridor: inside },
      { side: -turnSign, phase: Math.abs(finite(turn?.curvature)) > 0.0045 ? 'SWITCHBACK' : 'ATTACK_OUTSIDE', corridor: outside }
    ];
    // Every manoeuvre is evaluated over the same predictive occupancy field.
    // Clearance is the primary score; exit opportunity breaks ties without
    // allowing a theoretical time gain to override a blocked body corridor.
    const candidates = evaluatedCandidates
      .filter((candidate) => candidate.corridor.collisionFree && candidate.corridor.targetSeparationM >= 3.55)
      .map((candidate) => {
        const exitBonus = candidate.phase === 'SWITCHBACK' && target.otherTargetLateral * turnSign > 0 ? 0.12 : 0;
        return { ...candidate, score: candidate.corridor.minimumClearanceM + exitBonus };
      })
      .sort((a, b) => b.score - a.score
        || b.corridor.minimumClearanceM - a.corridor.minimumClearanceM);

    const attackRange = target.other.speed < vehicle.speed * 0.72 ? 38 : 28;
    // A clear lane is itself the permission to attack. Requiring an existing
    // closing velocity deadlocked the controller with its own follow-gap rule:
    // it matched speed, therefore never became “closing”, therefore drafted
    // indefinitely despite drawing a valid pass corridor in debug view.
    if (target.delta < attackRange && candidates.length) {
      const chosen = candidates[0];
      this.phase = chosen.phase;
      this.targetId = target.other.id;
      this.targetOffset = chosen.corridor.offset;
      this.side = chosen.side;
      this.age = 0;
      this.noProgressAge = 0;
      this.lastTargetDelta = target.delta;
      this.draftAge = 0;
      this.intent = { targetId: this.targetId, side: this.side, lane: this.phase.includes('INSIDE') ? 'INSIDE' : 'OUTSIDE', gapM: target.delta };
      return { phase: this.phase, desiredOffset: this.targetOffset, target, corridor: chosen.corridor, committed: true };
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
    const probeOffset = this.draftAge > 1 && probe
      ? clamp(finite(target.otherLateral) + (finite(probe.corridor.offset) - finite(target.otherLateral)) * 0.48,
        -roadMargin, roadMargin)
      : clamp(target.otherLateral, -roadMargin, roadMargin);
    return { phase: 'DRAFT', desiredOffset: probeOffset, target, corridor: probe?.corridor ?? null, committed: false,
      waitReason: this.draftAge > 1 ? 'CREATE_PASS_CORRIDOR' : 'NO_SAFE_LATERAL_CORRIDOR' };
  }
}

export { ATTACKS as ATTACK_PHASES };
