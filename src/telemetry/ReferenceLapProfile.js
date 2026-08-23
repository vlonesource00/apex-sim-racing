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
    this.paceGridStepM = 5;
    this.paceGrid = this._buildPaceGrid();
    this.summary = this._summary();
  }

  _smoothPaceSample(s, radius = 12) {
    const nearby = this.samples.filter((sample) => circularDistance(sample.s, s, this.trackLength) <= radius);
    const source = nearby.length ? nearby : [this.targetAtDistance(s)];
    let weightTotal = 0;
    const totals = { speed: 0, throttle: 0, brake: 0, tyreUtilisation: 0, bodySlip: 0, lateral: 0 };
    for (const sample of source) {
      const distanceM = circularDistance(sample.s, s, this.trackLength);
      const weight = Math.max(0.05, 1 - distanceM / Math.max(0.001, radius));
      weightTotal += weight;
      for (const key of Object.keys(totals)) totals[key] += finite(sample[key]) * weight;
    }
    return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / Math.max(0.001, weightTotal)]));
  }

  _buildPaceGrid() {
    const count = Math.ceil(this.trackLength / this.paceGridStepM);
    const grid = Array.from({ length: count }, (_, index) => ({
      s: index * this.paceGridStepM,
      ...this._smoothPaceSample(index * this.paceGridStepM),
      // Lateral intent needs a wider spatial filter than pedals/speed.  This
      // retains corner setup while removing individual steering corrections.
      lineLateral: this._smoothPaceSample(index * this.paceGridStepM, 35).lateral
    }));
    // Convert the driven speed trace into a predictive braking envelope.  It
    // answers “how fast may I be now and still reach every observed future
    // speed?”, avoiding both centreline-curvature lifts and late blind braking.
    const previewSteps = Math.ceil(150 / this.paceGridStepM);
    const deceleration = 11.5;
    for (let index = 0; index < count; index += 1) {
      let envelopeSpeed = grid[index].speed * 0.99;
      for (let step = 1; step <= previewSteps; step += 1) {
        const future = grid[(index + step) % count];
        const distanceM = step * this.paceGridStepM;
        envelopeSpeed = Math.min(envelopeSpeed,
          Math.sqrt((future.speed * 0.99) ** 2 + 2 * deceleration * distanceM));
      }
      grid[index].envelopeSpeed = envelopeSpeed;
    }
    return grid;
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
      meanTyreUtilisation: Number(mean('tyreUtilisation').toFixed(3)),
      ersStartPct: Number((finite(this.samples[0]?.ersSoc) * 100).toFixed(1)),
      ersEndPct: Number((finite(this.samples.at(-1)?.ersSoc) * 100).toFixed(1)),
      ersUsedPct: Number(((finite(this.samples[0]?.ersSoc) - finite(this.samples.at(-1)?.ersSoc)) * 100).toFixed(1))
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

  /**
   * Smooth distance-domain driver intent.  A single 20 Hz sample can contain
   * a gearshift, correction or timing jitter, so pace guidance must never use
   * the nearest sample as a hard speed command.
   */
  paceAtDistance(distance, { radiusM = 12 } = {}) {
    const s = ((finite(distance) % this.trackLength) + this.trackLength) % this.trackLength;
    const gridPosition = s / this.paceGridStepM;
    const lowerIndex = Math.floor(gridPosition) % this.paceGrid.length;
    const upperIndex = (lowerIndex + 1) % this.paceGrid.length;
    const blend = gridPosition - Math.floor(gridPosition);
    const lower = this.paceGrid[lowerIndex];
    const upper = this.paceGrid[upperIndex];
    const result = {};
    for (const key of ['speed', 'envelopeSpeed', 'throttle', 'brake', 'tyreUtilisation', 'bodySlip', 'lateral', 'lineLateral']) {
      result[key] = finite(lower[key]) + (finite(upper[key]) - finite(lower[key])) * blend;
    }
    return { ...result, s, sampleCount: this.samples.length, radiusM: clamp(finite(radiusM, 12), 3, 40) };
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

  distanceDeltaReport(lapPayload, { binSizeM = 50 } = {}) {
    const candidate = lapPayload instanceof ReferenceLapProfile ? lapPayload : new ReferenceLapProfile(lapPayload);
    const size = clamp(finite(binSizeM, 50), 10, 250);
    const bins = [];
    for (let startM = 0; startM < this.trackLength; startM += size) {
      const endM = Math.min(this.trackLength, startM + size);
      const centerM = (startM + endM) * 0.5;
      const reference = this.targetAtDistance(centerM);
      const comparison = candidate.targetAtDistance(centerM);
      const distanceM = endM - startM;
      const referenceSpeed = Math.max(2, reference.speed);
      const candidateSpeed = Math.max(2, comparison.speed);
      bins.push({
        startM: Number(startM.toFixed(1)), endM: Number(endM.toFixed(1)),
        timeDeltaS: Number((distanceM / candidateSpeed - distanceM / referenceSpeed).toFixed(3)),
        speedDeltaKmh: Number(((comparison.speed - reference.speed) * 3.6).toFixed(1)),
        lineDeltaM: Number((finite(comparison.lateral) - finite(reference.lateral)).toFixed(2)),
        referenceKmh: Number((reference.speed * 3.6).toFixed(1)),
        candidateKmh: Number((comparison.speed * 3.6).toFixed(1)),
        aiDesiredKmh: Number((finite(comparison.aiDesiredSpeed) * 3.6).toFixed(1)),
        aiTrajectoryLimitKmh: Number((finite(comparison.aiTrajectorySpeedLimit) * 3.6).toFixed(1)),
        aiReferenceKmh: Number((finite(comparison.aiReferenceSpeed) * 3.6).toFixed(1)),
        aiReferenceEnvelopeKmh: Number((finite(comparison.aiReferenceEnvelopeSpeed) * 3.6).toFixed(1)),
        aiPhase: comparison.aiPhase ?? null
      });
    }
    return {
      ...this.compare(candidate), binSizeM: size, bins,
      largestLosses: [...bins].sort((a, b) => b.timeDeltaS - a.timeDeltaS).slice(0, 10),
      largestGains: [...bins].sort((a, b) => a.timeDeltaS - b.timeDeltaS).slice(0, 5)
    };
  }
}
