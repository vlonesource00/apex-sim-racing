import { clamp, lerp, wrap } from '../core/math.js';
import { classDynamics, cornerSpeedFor, finite } from './AIConfig.js';

const CACHE = new WeakMap();

const minimumJerk = (value) => {
  const u = clamp(value, 0, 1);
  return u * u * u * (10 + u * (-15 + u * 6));
};

const circularDistance = (a, b, length) => wrap(a - b + length * 0.5, length) - length * 0.5;

const curvature3 = (a, b, c) => {
  const ab = Math.hypot(b.x - a.x, b.z - a.z);
  const bc = Math.hypot(c.x - b.x, c.z - b.z);
  const ac = Math.hypot(c.x - a.x, c.z - a.z);
  const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return area2 <= 1e-6 ? 0 : (2 * area2) / Math.max(1e-6, ab * bc * ac);
};

export class TrackIntelligence {
  static for(track) {
    const cached = CACHE.get(track);
    if (cached) return cached;
    const created = new TrackIntelligence(track);
    CACHE.set(track, created);
    return created;
  }

  constructor(track) {
    this.track = track;
    this.revision = track.revision;
    this.spacing = 3;
    this.count = Math.max(240, Math.ceil(track.length / this.spacing));
    this.spacing = track.length / this.count;
    this.samples = Array.from({ length: this.count }, (_, index) => {
      const point = track.atDistance(index * this.spacing);
      return { ...point, distance: index * this.spacing, lateral: 0 };
    });
    this._optimizeLine();
    this.speedProfiles = new Map();
  }

  _optimizeLine() {
    const source = this.track.samples?.length ? this.track.samples : this.samples;
    const curvatures = source
      .map((sample) => Math.abs(finite(sample.curvature)))
      .sort((a, b) => a - b);
    const robustPeak = Math.max(0.001, curvatures[Math.floor((curvatures.length - 1) * 0.90)] ?? 0.001);
    const threshold = Math.max(0.00115, robustPeak * 0.15);
    const candidates = source.map((sample) => ({
      s: wrap(finite(sample.s), this.track.length),
      strength: Math.abs(finite(sample.curvature)),
      sign: Math.sign(finite(sample.turnSign))
    })).filter((sample) => sample.sign && sample.strength >= threshold);

    const clusters = [];
    for (const candidate of candidates) {
      const previous = clusters.at(-1);
      const gap = previous ? candidate.s - previous.end : Infinity;
      if (previous && previous.turnSign === candidate.sign && gap >= 0 && gap <= 24) {
        previous.end = candidate.s;
        if (candidate.strength > previous.peakStrength) {
          previous.apex = candidate.s;
          previous.peakStrength = candidate.strength;
        }
      } else {
        clusters.push({
          start: candidate.s,
          end: candidate.s,
          apex: candidate.s,
          turnSign: candidate.sign,
          peakStrength: candidate.strength
        });
      }
    }

    if (clusters.length > 1) {
      const first = clusters[0];
      const last = clusters.at(-1);
      if (first.turnSign === last.turnSign && first.start + this.track.length - last.end <= 24) {
        last.end = first.end + this.track.length;
        if (first.peakStrength > last.peakStrength) {
          last.apex = first.apex + this.track.length;
          last.peakStrength = first.peakStrength;
        }
        clusters.shift();
      }
    }

    this.bends = clusters.map((cluster) => {
      const entryLead = clamp(24 + cluster.peakStrength * 2000, 30, 82);
      const exitTail = clamp(28 + cluster.peakStrength * 1800, 34, 90);
      const insideLimit = this._legalLimit(cluster.apex, cluster.turnSign);
      const outsideLimit = this._legalLimit(cluster.start - entryLead, -cluster.turnSign);
      return {
        ...cluster,
        entryStart: cluster.start - entryLead,
        exitEnd: cluster.end + exitTail,
        insideOffset: cluster.turnSign * insideLimit * 0.62,
        outsideOffset: -cluster.turnSign * outsideLimit * 0.62
      };
    });

    for (let index = 0; index < this.bends.length; index += 1) {
      const bend = this.bends[index];
      const next = this.bends[(index + 1) % this.bends.length];
      const nextStart = index === this.bends.length - 1 ? next.start + this.track.length : next.start;
      if (bend.turnSign !== next.turnSign && nextStart - bend.end < 28) {
        bend.insideOffset *= 0.65;
        bend.outsideOffset = bend.insideOffset;
        next.insideOffset *= 0.65;
        next.outsideOffset *= 0.42;
      }
    }

    for (const sample of this.samples) sample.lateral = this._lineAt(sample.distance);
    // Bend influence windows can overlap at chicanes and long compound turns.
    // Diffuse those phase hand-offs into one C2-like corridor before deriving
    // curvature; the planner must never see a one-sample cross-track jump as
    // a hairpin which does not exist in the road geometry.
    for (let pass = 0; pass < 128; pass += 1) {
      const next = this.samples.map((sample, index) => {
        const before = this.samples[(index - 1 + this.count) % this.count].lateral;
        const after = this.samples[(index + 1) % this.count].lateral;
        return (before + sample.lateral * 2 + after) * 0.25;
      });
      for (let index = 0; index < this.count; index += 1) {
        const legal = this._legalLimit(this.samples[index].distance, next[index]);
        this.samples[index].lateral = clamp(next[index], -legal, legal);
      }
    }
    const points = this.samples.map((sample) => ({
      x: sample.x + sample.normal.x * sample.lateral,
      z: sample.z + sample.normal.z * sample.lateral
    }));
    for (let index = 0; index < this.count; index += 1) {
      const previous = points[(index - 1 + this.count) % this.count];
      const current = points[index];
      const next = points[(index + 1) % this.count];
      const geometricCurvature = curvature3(previous, current, next);
      const rawCurvature = Math.abs(finite(this.track.scalarAtDistance(
        this.samples[index].distance)?.curvature));
      this.samples[index].lineCurvature = Math.max(geometricCurvature, rawCurvature);
    }
  }

  _legalLimit(distance, direction) {
    const point = this.track.atDistance(distance);
    return finite(this.track.planningLateralLimitAtPoint?.(point, direction, {
      halfWidthM: 1.02,
      safetyM: 0.24
    }) ?? this.track.planningLateralLimit?.(point.s, direction, {
      halfWidthM: 1.02,
      safetyM: 0.24
    }), Math.max(1.8, finite(this.track.roadHalfWidth, 6.5) - 1.26));
  }

  _lineForBend(bend, distance) {
    let s = wrap(distance, this.track.length);
    while (s < bend.entryStart) s += this.track.length;
    while (s > bend.entryStart + this.track.length) s -= this.track.length;
    if (s < bend.entryStart || s > bend.exitEnd) return null;
    if (s <= bend.start) {
      const u = minimumJerk((s - bend.entryStart) / Math.max(1, bend.start - bend.entryStart));
      return { lateral: bend.outsideOffset * u, weight: u };
    }
    if (s <= bend.apex) {
      const u = minimumJerk((s - bend.start) / Math.max(1, bend.apex - bend.start));
      return { lateral: lerp(bend.outsideOffset, bend.insideOffset, u), weight: 1 };
    }
    if (s <= bend.end) {
      const u = minimumJerk((s - bend.apex) / Math.max(1, bend.end - bend.apex));
      return { lateral: lerp(bend.insideOffset, bend.outsideOffset, u), weight: 1 };
    }
    const u = minimumJerk((s - bend.end) / Math.max(1, bend.exitEnd - bend.end));
    return { lateral: bend.outsideOffset * (1 - u), weight: 1 - u };
  }

  _lineAt(distance) {
    let selected = null;
    for (const bend of this.bends) {
      const line = this._lineForBend(bend, distance);
      if (!line) continue;
      const proximity = Math.abs(circularDistance(distance, bend.apex, this.track.length));
      if (!selected || line.weight > selected.weight + 1e-5
        || (Math.abs(line.weight - selected.weight) <= 1e-5 && proximity < selected.proximity)) {
        selected = { ...line, proximity };
      }
    }
    if (!selected) return 0;
    const legal = this._legalLimit(distance, selected.lateral);
    return clamp(selected.lateral, -legal, legal);
  }

  _indices(distance) {
    const unit = wrap(distance, this.track.length) / this.spacing;
    const a = Math.floor(unit) % this.count;
    return { a, b: (a + 1) % this.count, t: unit - Math.floor(unit) };
  }

  lineAt(distance) {
    const { a, b, t } = this._indices(distance);
    return lerp(this.samples[a].lateral, this.samples[b].lateral, t);
  }

  curvatureAt(distance) {
    const { a, b, t } = this._indices(distance);
    return lerp(this.samples[a].lineCurvature, this.samples[b].lineCurvature, t);
  }

  cornerAhead(distance, horizonM = 110) {
    let strongest = null;
    for (let forward = 0; forward <= horizonM; forward += 5) {
      const sample = this.track.scalarAtDistance(distance + forward);
      const magnitude = Math.abs(finite(sample.curvature));
      if (!strongest || magnitude > strongest.curvature) strongest = {
        distanceM: forward,
        curvature: magnitude,
        turnSign: Math.sign(finite(sample.turnSign)) || 1,
        s: sample.s
      };
    }
    return strongest;
  }

  _profileFor(vehicle) {
    const key = vehicle.classKey ?? 'gt';
    if (this.speedProfiles.has(key)) return this.speedProfiles.get(key);
    const dynamics = classDynamics(vehicle);
    const speeds = this.samples.map((sample) => {
      const curvature = Math.max(0.00035, finite(sample.lineCurvature, sample.curvature));
      return Math.min(dynamics.topSpeed, cornerSpeedFor(vehicle, curvature));
    });
    for (let pass = 0; pass < 4; pass += 1) {
      for (let index = this.count - 1; index >= 0; index -= 1) {
        const next = (index + 1) % this.count;
        speeds[index] = Math.min(speeds[index], Math.sqrt(speeds[next] ** 2 + 2 * dynamics.brake * this.spacing));
      }
      for (let index = 0; index < this.count; index += 1) {
        const previous = (index - 1 + this.count) % this.count;
        speeds[index] = Math.min(speeds[index], Math.sqrt(speeds[previous] ** 2 + 2 * dynamics.accel * this.spacing));
      }
    }
    this.speedProfiles.set(key, speeds);
    return speeds;
  }

  speedAt(distance, vehicle) {
    const profile = this._profileFor(vehicle);
    const { a, b, t } = this._indices(distance);
    return lerp(profile[a], profile[b], t);
  }
}
