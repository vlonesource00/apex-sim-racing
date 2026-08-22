const legalSurface = (vehicle) => vehicle.surface?.zone === 'road' || vehicle.surface?.zone === 'kerb';

const signedGap = (from, to, length) => {
  let gap = to.distance - from.distance;
  return ((gap + length * 0.5) % length + length) % length - length * 0.5;
};

export class PassQualityTracker {
  constructor(track) {
    this.track = track;
    this.reset();
  }

  reset() {
    this.pairs = new Map();
    this.cleanPasses = 0;
    this.rejectedContact = 0;
    this.rejectedOffTrack = 0;
    this.candidates = 0;
    this.latest = null;
  }

  update(vehicles, collisionStats, dt, active = true) {
    if (!active) return this.snapshot();
    const contactKeys = new Set((collisionStats?.contactPairs ?? []).map(({ a, b }) => [a, b].sort().join('|')));
    for (let firstIndex = 0; firstIndex < vehicles.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < vehicles.length; secondIndex += 1) {
        const first = vehicles[firstIndex];
        const second = vehicles[secondIndex];
        if (first.finished || second.finished || first.retired || second.retired) continue;
        const key = [first.id, second.id].sort().join('|');
        const gap = signedGap(first, second, this.track.length);
        const state = this.pairs.get(key) ?? { previousGap: gap, attempt: null };
        const firstClosing = gap > 0 && gap < 20 && gap < state.previousGap - 0.01;
        const secondClosing = gap < 0 && gap > -20 && gap > state.previousGap + 0.01;
        if (!state.attempt && ((state.previousGap > 0 && gap <= 0) || firstClosing)) {
          state.attempt = { attacker: first, defender: second, taintedContact: contactKeys.has(key),
            attackerOff: !legalSurface(first), defenderOff: !legalSurface(second), clearTime: 0,
            crossed: gap <= 0, time: 0 };
          this.candidates += 1;
        } else if (!state.attempt && ((state.previousGap < 0 && gap >= 0) || secondClosing)) {
          state.attempt = { attacker: second, defender: first, taintedContact: contactKeys.has(key),
            attackerOff: !legalSurface(second), defenderOff: !legalSurface(first), clearTime: 0,
            crossed: gap >= 0, time: 0 };
          this.candidates += 1;
        }
        const attempt = state.attempt;
        if (attempt) {
          attempt.taintedContact ||= contactKeys.has(key);
          attempt.attackerOff ||= !legalSurface(attempt.attacker);
          attempt.defenderOff ||= !legalSurface(attempt.defender);
          const clearGap = signedGap(attempt.defender, attempt.attacker, this.track.length);
          attempt.time += dt;
          attempt.crossed ||= clearGap >= 0;
          attempt.clearTime = clearGap > 5 ? attempt.clearTime + dt : 0;
          if (attempt.clearTime >= 1) {
            const clean = !attempt.taintedContact && !attempt.attackerOff && !attempt.defenderOff;
            if (clean) this.cleanPasses += 1;
            else if (attempt.taintedContact) this.rejectedContact += 1;
            else this.rejectedOffTrack += 1;
            this.latest = Object.freeze({ attackerId: attempt.attacker.id, defenderId: attempt.defender.id,
              clean, reason: clean ? 'CLEAN_DURABLE_PASS' : attempt.taintedContact ? 'CONTACT' : 'OFF_TRACK',
              clearanceM: clearGap });
            state.attempt = null;
          } else if ((attempt.crossed && clearGap < -8) || (!attempt.crossed && attempt.time > 20)) state.attempt = null;
        }
        state.previousGap = gap;
        this.pairs.set(key, state);
      }
    }
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({ cleanPasses: this.cleanPasses, rejectedContact: this.rejectedContact,
      rejectedOffTrack: this.rejectedOffTrack, candidates: this.candidates, latest: this.latest });
  }
}
