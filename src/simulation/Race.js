import { wrap } from '../core/math.js';

export class RaceState {
  constructor(track, vehicles, laps = 3) {
    this.track = track;
    this.vehicles = vehicles;
    this.totalLaps = laps;
    this.phase = 'grid';
    this.elapsed = 0;
    this.raceTime = 0;
    this.countdown = 3.5;
    this.finishOrder = [];
    this.entries = new Map();
    this.lastImpact = 0;
    vehicles.forEach((vehicle) => this.entries.set(vehicle.id, { lap: 0, crossings: 0, lastDistance: vehicle.distance, unwrappedDistance: vehicle.distance, finishTime: null }));
  }

  reset() {
    this.phase = 'grid';
    this.elapsed = 0;
    this.raceTime = 0;
    this.countdown = 3.5;
    this.finishOrder = [];
    this.lastImpact = 0;
    this.vehicles.forEach((vehicle) => {
      vehicle.finished = false;
      vehicle.cooldownActive = false;
      vehicle.cooldownTime = 0;
      vehicle.trafficGhost = false;
      vehicle.despawned = false;
      const entry = this.entries.get(vehicle.id);
      entry.lap = 0;
      entry.crossings = 0;
      entry.lastDistance = vehicle.distance;
      entry.unwrappedDistance = vehicle.distance > this.track.length * 0.5 ? vehicle.distance - this.track.length : vehicle.distance;
      entry.finishTime = null;
    });
  }

  step(dt) {
    this.elapsed += dt;
    this.lastImpact = Math.max(0, this.lastImpact - dt * 2.4);
    if (this.phase === 'grid' && this.elapsed > 0.75) this.phase = 'countdown';
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.raceTime = 0;
        // Cars may settle or be nudged across the wrapped start distance while staged.
        // Synchronise the baseline at green so that grid movement never counts as lap one.
        this._synchroniseRaceStart();
      }
    }
    if (this.phase === 'racing') this.raceTime += dt;
    this._updateLaps();
  }

  _synchroniseRaceStart() {
    for (const vehicle of this.vehicles) {
      const entry = this.entries.get(vehicle.id);
      entry.lastDistance = vehicle.distance;
      entry.unwrappedDistance = vehicle.distance > this.track.length * 0.5 ? vehicle.distance - this.track.length : vehicle.distance;
    }
  }

  _updateLaps() {
    if (this.phase !== 'racing') return;
    const length = this.track.length;
    for (const vehicle of this.vehicles) {
      const entry = this.entries.get(vehicle.id);
      const previous = entry.lastDistance;
      const current = vehicle.distance;
      const delta = wrap(current - previous + length * 0.5, length) - length * 0.5;
      entry.unwrappedDistance += delta;
      const forwardSpeed = vehicle.velocity.x * Math.sin(vehicle.yaw) + vehicle.velocity.z * Math.cos(vehicle.yaw);
      if (!vehicle.finished && previous > length * 0.88 && current < length * 0.12 && forwardSpeed > 4) {
        // Grid cars start at negative unwrapped distance. Their first passage
        // over timing zero begins lap one; it must not complete a lap. Credit
        // only crossings backed by a full accumulated circuit distance.
        const distanceLaps = Math.floor((entry.unwrappedDistance + length * 0.015) / length);
        if (distanceLaps <= entry.lap) {
          entry.lastDistance = current;
          continue;
        }
        entry.lap = distanceLaps;
        entry.crossings = distanceLaps;
        if (entry.lap >= this.totalLaps) {
          vehicle.finished = true;
          vehicle.cooldownActive = !vehicle.player;
          vehicle.cooldownTime = 0;
          vehicle.trafficGhost = false;
          vehicle.despawned = false;
          entry.finishTime = this.raceTime;
          this.finishOrder.push(vehicle);
        }
      }
      entry.lastDistance = current;
    }
    if (this.finishOrder.length === this.vehicles.length) this.phase = 'complete';
  }

  _scoreFor(candidate) {
    const length = this.track.length;
    const entry = this.entries.get(candidate.id);
    if (!entry) return Number.NEGATIVE_INFINITY;
    const finishBoost = candidate.finished
      ? (this.vehicles.length + 1 - this.finishOrder.indexOf(candidate)) * length * 10
      : 0;
    return finishBoost + entry.unwrappedDistance;
  }

  _orderedVehicles() {
    return this.vehicles
      .map((vehicle, index) => ({ vehicle, index, score: this._scoreFor(vehicle) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ vehicle }) => vehicle);
  }

  positionFor(vehicle) {
    return this._orderedVehicles().indexOf(vehicle) + 1;
  }

  standings(referenceVehicle = null) {
    const ordered = this._orderedVehicles();
    const reference = referenceVehicle && this.entries.has(referenceVehicle.id)
      ? referenceVehicle : ordered[0] ?? null;
    const referenceScore = reference ? this._scoreFor(reference) : 0;
    return ordered.map((vehicle, index) => {
      const entry = this.entries.get(vehicle.id);
      const completedLap = entry?.lap ?? 0;
      const distanceGapM = Number.isFinite(referenceScore) && Number.isFinite(this._scoreFor(vehicle))
        ? referenceScore - this._scoreFor(vehicle) : 0;
      return {
        position: index + 1,
        id: vehicle.id,
        name: vehicle.name,
        classKey: vehicle.classKey,
        lap: Math.min(this.totalLaps, completedLap + 1),
        finished: Boolean(vehicle.finished),
        distanceGapM: Number.isFinite(distanceGapM) ? distanceGapM : 0
      };
    });
  }

  statusFor(vehicle) {
    const entry = this.entries.get(vehicle.id);
    return {
      lap: Math.min(this.totalLaps, entry.lap + 1),
      completed: entry.lap,
      position: this.positionFor(vehicle),
      phase: this.phase,
      countdown: this.countdown,
      raceTime: this.raceTime,
      finished: vehicle.finished,
      finishPosition: this.finishOrder.indexOf(vehicle) + 1,
      finishTime: entry.finishTime,
      totalLaps: this.totalLaps
    };
  }

  gridPosition(index) {
    const lane = index % 2 === 0 ? -2.35 : 2.35;
    const row = Math.floor(index / 2);
    return { distance: wrap(-row * 7.4 - (index % 2) * 1.1, this.track.length), lateral: lane };
  }
}
