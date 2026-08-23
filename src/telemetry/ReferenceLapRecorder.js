const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const average = (values) => values.length ? values.reduce((sum, value) => sum + finite(value), 0) / values.length : 0;

/** Records the player's real fixed-step physics as a compact 20 Hz reference lap. */
export class ReferenceLapRecorder {
  constructor({ sampleHz = 20 } = {}) {
    this.sampleInterval = 1 / sampleHz;
    this.reset();
  }

  reset() {
    this.recording = false;
    this.armed = false;
    this.samples = [];
    this.clock = 0;
    this.startLap = null;
    this.startedAt = 0;
    this.lastExport = null;
  }

  start(vehicle, track, race, { armed = true } = {}) {
    this.reset();
    this.recording = true;
    this.armed = Boolean(armed);
    this.startLap = race.entries.get(vehicle.id)?.lap ?? 0;
    this.startedAt = finite(race.raceTime);
    this.trackLength = finite(track.length);
    this.vehicleClass = vehicle.classKey;
    return this.status();
  }

  startImmediate(vehicle, track, race) {
    return this.start(vehicle, track, race, { armed: false });
  }

  stop({ download = true, complete = false } = {}) {
    if (!this.recording && !this.samples.length) return null;
    this.recording = false;
    const payload = {
      schemaVersion: 1,
      kind: 'apex73-reference-lap',
      complete,
      vehicleClass: this.vehicleClass,
      trackLengthM: this.trackLength,
      sampleHz: Math.round(1 / this.sampleInterval),
      startedAtRaceTimeS: this.startedAt,
      durationS: this.samples.length ? this.samples.at(-1).t : 0,
      samples: this.samples
    };
    this.lastExport = payload;
    if (download && typeof document !== 'undefined') this._download(payload);
    return payload;
  }

  toggle(vehicle, track, race) {
    return this.recording ? this.stop({ download: true, complete: false }) : this.start(vehicle, track, race);
  }

  update(dt, vehicle, track, race) {
    if (!this.recording || race.phase !== 'racing') return null;
    const lap = race.entries.get(vehicle.id)?.lap ?? this.startLap;
    if (lap > this.startLap) {
      if (this.armed) {
        this.armed = false;
        this.startLap = lap;
        this.startedAt = finite(race.raceTime);
        this.samples = [];
        this.clock = 0;
        return null;
      }
      if (this.samples.length > 10) return this.stop({ download: true, complete: true });
    }
    if (this.armed) return null;
    this.clock += dt;
    if (this.clock + 1e-9 < this.sampleInterval) return null;
    this.clock = Math.max(0, this.clock - this.sampleInterval);
    const wheels = vehicle.wheels ?? [];
    const controls = vehicle.controls ?? {};
    this.samples.push({
      t: Number((finite(race.raceTime) - this.startedAt).toFixed(3)),
      s: Number(finite(vehicle.distance).toFixed(3)),
      lateral: Number(finite(vehicle.surface?.lateral).toFixed(3)),
      speed: Number(finite(vehicle.speed).toFixed(3)),
      throttle: Number(finite(controls.throttle).toFixed(3)),
      brake: Number(finite(controls.brake).toFixed(3)),
      steer: Number(finite(controls.steer).toFixed(3)),
      gear: finite(vehicle.gear), rpm: Math.round(finite(vehicle.rpm)),
      yaw: Number(finite(vehicle.yaw).toFixed(5)),
      yawRate: Number(finite(vehicle.yawRate).toFixed(4)),
      bodySlip: Number(Math.atan2(finite(vehicle.localVelocity?.x), Math.max(1, Math.abs(finite(vehicle.localVelocity?.z)))).toFixed(4)),
      longitudinalG: Number(finite(vehicle.telemetry?.longitudinalG).toFixed(3)),
      lateralG: Number(finite(vehicle.telemetry?.lateralG).toFixed(3)),
      tyreUtilisation: Number(finite(vehicle.telemetry?.tyreUtilisation).toFixed(3)),
      tyreTempC: Number(average(wheels.map((wheel) => wheel.temperature)).toFixed(2)),
      tyreWear: Number(average(wheels.map((wheel) => wheel.wear)).toFixed(5)),
      ersSoc: Number(finite(vehicle.ers?.soc).toFixed(4)),
      ersDeployKw: Number((finite(vehicle.ers?.deployPowerW) / 1000).toFixed(2)),
      ersRegenKw: Number((finite(vehicle.ers?.regenElectricalPowerW) / 1000).toFixed(2)),
      ersMode: vehicle.ers?.mode ?? 'OFF',
      surface: vehicle.surface?.zone ?? 'unknown',
      aiMode: vehicle.aiTactical?.source ?? null,
      aiPhase: vehicle.aiTactical?.racecraftPhase ?? null,
      aiDesiredSpeed: Number(finite(vehicle.aiTactical?.desiredSpeed).toFixed(3)),
      aiTrajectorySpeedLimit: Number(finite(vehicle.aiTactical?.trajectorySpeedLimit).toFixed(3)),
      aiReferenceSpeed: Number(finite(vehicle.aiTactical?.referenceSpeed).toFixed(3)),
      aiReferenceEnvelopeSpeed: Number(finite(vehicle.aiTactical?.referenceEnvelopeSpeed).toFixed(3))
    });
    return null;
  }

  status() { return { recording: this.recording, armed: this.armed, samples: this.samples.length, startLap: this.startLap, lastExport: this.lastExport }; }

  _download(payload) {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `apex73-reference-${payload.vehicleClass}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
}
