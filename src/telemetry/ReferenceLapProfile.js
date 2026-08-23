const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const circularDistance = (a, b, length) => {
  const direct = Math.abs(a - b);
  return Math.min(direct, Math.max(0, length - direct));
};

/** Distance-indexed driver reference used for pace comparison and later imitation/RL curricula. */
export class ReferenceLapProfile {
  constructor(payload) {
    if (!payload || payload.kind !== 'apex73-reference-lap') throw new Error('Not an Apex 73 reference lap');
    if (!Array.isArray(payload.samples) || payload.samples.length < 10) throw new Error('Reference lap has too few samples');
    this.payload = payload;
    this.trackLength = Math.max(1, finite(payload.trackLengthM));
    this.samples = payload.samples.map((sample) => ({
      ...sample,
      s: ((finite(sample.s) % this.trackLength) + this.trackLength) % this.trackLength,
      t: finite(sample.t), speed: Math.max(0, finite(sample.speed))
    })).sort((a, b) => a.s - b.s);
    this.summary = this._summary();
  }

  _summary() {
    const durationS = finite(this.payload.durationS, Math.max(...this.samples.map((sample) => sample.t)));
    const mean = (key) => this.samples.reduce((sum, sample) => sum + finite(sample[key]), 0) / this.samples.length;
    return {
      vehicleClass: this.payload.vehicleClass ?? 'unknown',
      complete: Boolean(this.payload.complete),
      lapTimeS: Number(durationS.toFixed(3)),
      sampleCount: this.samples.length,
      sampleHz: finite(this.payload.sampleHz),
      meanSpeedKmh: Number((mean('speed') * 3.6).toFixed(1)),
      maxSpeedKmh: Number((Math.max(...this.samples.map((sample) => sample.speed)) * 3.6).toFixed(1)),
      fullThrottlePct: Number((100 * this.samples.filter((sample) => finite(sample.throttle) >= 0.98).length / this.samples.length).toFixed(1)),
      brakingPct: Number((100 * this.samples.filter((sample) => finite(sample.brake) > 0.05).length / this.samples.length).toFixed(1)),
      meanTyreUtilisation: Number(mean('tyreUtilisation').toFixed(3))
    };
  }

  targetAtDistance(distance) {
    const s = ((finite(distance) % this.trackLength) + this.trackLength) % this.trackLength;
    let best = this.samples[0];
    let bestDistance = Infinity;
    for (const sample of this.samples) {
      const distanceToSample = circularDistance(sample.s, s, this.trackLength);
      if (distanceToSample < bestDistance) { best = sample; bestDistance = distanceToSample; }
    }
    return { ...best, distanceErrorM: Number(bestDistance.toFixed(3)) };
  }

  compare(lapPayload) {
    const candidate = lapPayload instanceof ReferenceLapProfile ? lapPayload : new ReferenceLapProfile(lapPayload);
    const lapDeltaS = candidate.summary.lapTimeS - this.summary.lapTimeS;
    const speedDeltas = candidate.samples.map((sample) => {
      const reference = this.targetAtDistance(sample.s);
      return sample.speed - reference.speed;
    });
    const meanSpeedDelta = speedDeltas.reduce((sum, value) => sum + value, 0) / Math.max(1, speedDeltas.length);
    return {
      baselineLapTimeS: this.summary.lapTimeS,
      candidateLapTimeS: candidate.summary.lapTimeS,
      lapDeltaS: Number(lapDeltaS.toFixed(3)),
      pacePct: Number(clamp(this.summary.lapTimeS / Math.max(0.001, candidate.summary.lapTimeS) * 100, 0, 999).toFixed(2)),
      meanSpeedDeltaKmh: Number((meanSpeedDelta * 3.6).toFixed(2))
    };
  }
}
