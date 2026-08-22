import { clamp, wrap } from '../core/math.js';

export const PIT_STATES = Object.freeze({
  NONE: 'NONE',
  REQUESTED: 'REQUESTED',
  ENTRY: 'ENTRY',
  LIMITER: 'LIMITER',
  BOX: 'BOX',
  SERVICE: 'SERVICE',
  EXIT: 'EXIT'
});

const DEFAULT_PIT = Object.freeze({
  entryFraction: 0.84,
  limiterFraction: 0.868,
  boxStartFraction: 0.905,
  boxEndFraction: 0.965,
  exitFraction: 0.036,
  lateralM: -13.2,
  entryLateralM: -10.5,
  exitLateralM: -8.6,
  pitSpeedLimitMps: 16.67,
  entrySpeedLimitMps: 23.5,
  boxSpeedMps: 1.1,
  stoppedSpeedMps: 0.55,
  serviceDurationS: 7.5,
  ambientTemperatureC: 24,
  coldPressurePa: 185000
});

const MOD = (value, length = 1) => wrap(value, length);
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const vehicleKey = (vehicle) => String(vehicle?.id ?? vehicle?.name ?? 'vehicle');

function inForwardArc(fraction, start, end) {
  return MOD(fraction - start) <= MOD(end - start) + 1e-8;
}

function normalizedDistance(vehicle, trackLength) {
  return MOD(finite(vehicle?.distance), Math.max(1, trackLength)) / Math.max(1, trackLength);
}

/**
 * Finds public tire-like objects without importing Vehicle/Tire internals.
 * The default service mutation is intentionally isolated here; applications
 * with their own tyre state should pass `serviceVehicle` to PitSystem instead.
 */
export function collectTireStates(vehicle) {
  const candidates = [
    ...(Array.isArray(vehicle?.wheels) ? vehicle.wheels : []),
    ...(Array.isArray(vehicle?.tires) ? vehicle.tires : [])
  ];
  const states = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const state = candidate?.tire ?? candidate?.state ?? candidate;
    if (state && typeof state === 'object' && !seen.has(state)) {
      seen.add(state);
      states.push(state);
    }
  }
  return states;
}

export function refreshTiresForService(vehicle, pitConfig = DEFAULT_PIT) {
  const ambient = finite(pitConfig.ambientTemperatureC, DEFAULT_PIT.ambientTemperatureC);
  const pressure = finite(pitConfig.coldPressurePa, DEFAULT_PIT.coldPressurePa);
  for (const tire of collectTireStates(vehicle)) {
    tire.wear = 0;
    tire.kappa = 0;
    tire.alpha = 0;
    tire.temperatureInnerC = ambient;
    tire.temperatureMiddleC = ambient;
    tire.temperatureOuterC = ambient;
    tire.carcassTemperatureC = ambient;
    tire.flashTemperatureC = ambient;
    tire.pressurePa = pressure;
    tire.energyJ = 0;
    tire.thermalEnergyJ = 0;
  }
  return collectTireStates(vehicle).length;
}

export function evaluatePitNeed(vehicle, lapsRemaining = 1, options = {}) {
  const tires = collectTireStates(vehicle);
  const wears = tires.map((tire) => clamp(finite(tire.wear), 0, 1));
  const maxWear = wears.length ? Math.max(...wears) : 0;
  const averageWear = wears.length ? wears.reduce((sum, wear) => sum + wear, 0) / wears.length : 0;
  const remaining = Math.max(0, finite(lapsRemaining, 1));
  const baseThreshold = finite(options.baseThreshold, 0.79);
  const threshold = clamp(baseThreshold - Math.min(0.20, remaining * finite(options.perLapMargin, 0.018)), 0.54, 0.88);
  const emergencyWear = clamp(finite(options.emergencyWear, 0.91), 0.7, 1);
  const shouldPit = maxWear >= emergencyWear || averageWear >= threshold || maxWear >= threshold + 0.10;
  return {
    shouldPit,
    maxWear,
    averageWear,
    threshold,
    urgency: clamp(Math.max(maxWear, averageWear) / Math.max(0.01, threshold), 0, 1.5),
    tireCount: tires.length
  };
}

/** Applies a returned pit intent to a caller-owned control object. */
export function applyPitIntentToControls(controls = {}, intent = {}) {
  if (!intent.active) return controls;
  if (intent.holdPosition) {
    controls.throttle = 0;
    controls.brake = 1;
    return controls;
  }
  controls.throttle = Math.min(clamp(finite(controls.throttle, 0), 0, 1), clamp(finite(intent.throttleLimit, 1), 0, 1));
  controls.brake = Math.max(clamp(finite(controls.brake, 0), 0, 1), clamp(finite(intent.brakeRequest, 0), 0, 1));
  return controls;
}

function createEntry(vehicle) {
  return {
    id: vehicleKey(vehicle),
    state: PIT_STATES.NONE,
    requestedAt: null,
    enteredAt: null,
    serviceElapsedS: 0,
    serviceTimeS: 0,
    cumulativeStops: 0,
    cumulativeServiceTimeS: 0,
    completedServices: 0,
    lastIntent: null
  };
}

/**
 * Deterministic pit-lane state machine. It provides intent/control ceilings
 * rather than teleporting or reaching into Vehicle physics internals.
 */
export class PitSystem {
  constructor(track, vehicles = [], scenarioConfig = {}, options = {}) {
    this.track = track || { length: 1 };
    this.vehicles = vehicles || [];
    this.config = { ...DEFAULT_PIT, ...(scenarioConfig.pit ?? scenarioConfig) };
    this.serviceVehicle = options.serviceVehicle ?? scenarioConfig.serviceVehicle ?? null;
    this.entries = new Map();
    this.elapsedS = 0;
    this.vehicles.forEach((vehicle) => this._entryFor(vehicle));
  }

  _entryFor(vehicle) {
    const key = vehicleKey(vehicle);
    if (!this.entries.has(key)) this.entries.set(key, createEntry(vehicle));
    return this.entries.get(key);
  }

  _trackLength() {
    return Math.max(1, finite(this.track?.length, 1));
  }

  _fractionFor(vehicle) {
    return normalizedDistance(vehicle, this._trackLength());
  }

  request(vehicle) {
    const entry = this._entryFor(vehicle);
    if (entry.state === PIT_STATES.NONE) {
      entry.state = PIT_STATES.REQUESTED;
      entry.requestedAt = this.elapsedS;
    }
    return this.status(vehicle);
  }

  cancel(vehicle) {
    const entry = this._entryFor(vehicle);
    if (entry.state !== PIT_STATES.REQUESTED) return false;
    entry.state = PIT_STATES.NONE;
    entry.requestedAt = null;
    entry.lastIntent = null;
    this._clearVehicleAdvisory(vehicle);
    return true;
  }

  status(vehicle) {
    const entry = this._entryFor(vehicle);
    return {
      id: entry.id,
      state: entry.state,
      requestedAt: entry.requestedAt,
      enteredAt: entry.enteredAt,
      serviceElapsedS: entry.serviceElapsedS,
      serviceTimeS: entry.serviceTimeS,
      cumulativeStops: entry.cumulativeStops,
      cumulativeServiceTimeS: entry.cumulativeServiceTimeS,
      completedServices: entry.completedServices,
      intent: entry.lastIntent ? { ...entry.lastIntent } : this._intentFor(entry, vehicle)
    };
  }

  intentFor(vehicle) {
    return { ...this._intentFor(this._entryFor(vehicle), vehicle) };
  }

  pitNeedFor(vehicle, lapsRemaining = 1, options = {}) {
    return evaluatePitNeed(vehicle, lapsRemaining, options);
  }

  reset(vehicles = this.vehicles) {
    this.elapsedS = 0;
    this.entries.clear();
    this.vehicles = vehicles || [];
    this.vehicles.forEach((vehicle) => {
      this._entryFor(vehicle);
      this._clearVehicleAdvisory(vehicle);
    });
  }

  update(dt, vehicles = this.vehicles) {
    const safeDt = clamp(finite(dt, 0), 0, 1);
    this.elapsedS += safeDt;
    this.vehicles = vehicles || [];
    const intents = new Map();
    for (const vehicle of this.vehicles) {
      const entry = this._entryFor(vehicle);
      this._advance(entry, vehicle, safeDt);
      const intent = this._intentFor(entry, vehicle);
      entry.lastIntent = intent;
      this._publishVehicleAdvisory(vehicle, intent, entry.state);
      intents.set(vehicle, { ...intent });
    }
    return intents;
  }

  _advance(entry, vehicle, dt) {
    const fraction = this._fractionFor(vehicle);
    const speed = Math.abs(finite(vehicle?.speed));
    const config = this.config;
    const inPitLane = inForwardArc(fraction, config.entryFraction, config.exitFraction);
    const pastLimiter = inForwardArc(fraction, config.limiterFraction, config.exitFraction);
    const inBox = inForwardArc(fraction, config.boxStartFraction, config.boxEndFraction);

    if (entry.state === PIT_STATES.REQUESTED && inPitLane) {
      entry.state = PIT_STATES.ENTRY;
      entry.enteredAt = this.elapsedS;
      return;
    }
    if (entry.state === PIT_STATES.ENTRY && pastLimiter) {
      entry.state = PIT_STATES.LIMITER;
      return;
    }
    if (entry.state === PIT_STATES.LIMITER && inBox) {
      entry.state = PIT_STATES.BOX;
      return;
    }
    if (entry.state === PIT_STATES.BOX && inBox && speed <= config.stoppedSpeedMps) {
      entry.state = PIT_STATES.SERVICE;
      entry.serviceElapsedS = 0;
      entry.cumulativeStops += 1;
      return;
    }
    if (entry.state === PIT_STATES.SERVICE) {
      // A moving car cannot accrue service time. Return it to the box phase so
      // the caller has a clear stop-only invariant rather than a hidden timer.
      if (!inBox || speed > config.stoppedSpeedMps) {
        entry.state = PIT_STATES.BOX;
        entry.serviceElapsedS = 0;
        return;
      }
      entry.serviceElapsedS += dt;
      entry.serviceTimeS += dt;
      entry.cumulativeServiceTimeS += dt;
      if (entry.serviceElapsedS >= config.serviceDurationS) {
        this._performService(vehicle, entry);
        entry.completedServices += 1;
        entry.state = PIT_STATES.EXIT;
      }
      return;
    }
    if (entry.state === PIT_STATES.EXIT && !inPitLane) {
      entry.state = PIT_STATES.NONE;
      entry.requestedAt = null;
      entry.enteredAt = null;
      entry.serviceElapsedS = 0;
    }
  }

  _performService(vehicle, entry) {
    if (typeof this.serviceVehicle === 'function') {
      this.serviceVehicle(vehicle, { ...this.config, entry: { ...entry } });
      return;
    }
    refreshTiresForService(vehicle, this.config);
  }

  _intentFor(entry, vehicle) {
    const state = entry.state;
    const config = this.config;
    const lateral = finite(vehicle?.surface?.lateral ?? vehicle?.lateral, 0);
    const pitLine = state === PIT_STATES.ENTRY ? config.entryLateralM
      : state === PIT_STATES.EXIT ? config.exitLateralM : config.lateralM;
    const limiterActive = state === PIT_STATES.LIMITER || state === PIT_STATES.BOX || state === PIT_STATES.SERVICE;
    const speedLimitMps = state === PIT_STATES.ENTRY ? config.entrySpeedLimitMps
      : limiterActive ? (state === PIT_STATES.BOX || state === PIT_STATES.SERVICE ? config.boxSpeedMps : config.pitSpeedLimitMps)
        : state === PIT_STATES.EXIT ? config.pitSpeedLimitMps : Infinity;
    const speed = Math.abs(finite(vehicle?.speed));
    return {
      active: state !== PIT_STATES.NONE,
      state,
      targetLateralM: state === PIT_STATES.NONE ? lateral : pitLine,
      lateralErrorM: pitLine - lateral,
      speedLimitMps,
      limiterActive,
      throttleLimit: Number.isFinite(speedLimitMps) ? clamp((speedLimitMps - speed) / Math.max(1, speedLimitMps * 0.22), 0, 1) : 1,
      brakeRequest: Number.isFinite(speedLimitMps) ? clamp((speed - speedLimitMps) / Math.max(1, speedLimitMps * 0.30), 0, 1) : 0,
      holdPosition: state === PIT_STATES.BOX || state === PIT_STATES.SERVICE,
      serviceProgress: state === PIT_STATES.SERVICE ? clamp(entry.serviceElapsedS / config.serviceDurationS, 0, 1) : 0
    };
  }

  _publishVehicleAdvisory(vehicle, intent, state) {
    if (!vehicle || typeof vehicle !== 'object') return;
    vehicle.pitIntent = intent;
    vehicle.pitLimiterActive = intent.limiterActive;
    vehicle.pitSpeedLimitMps = Number.isFinite(intent.speedLimitMps) ? intent.speedLimitMps : null;
    vehicle.pit = { state, limiterActive: intent.limiterActive, speedLimitMps: vehicle.pitSpeedLimitMps };
  }

  _clearVehicleAdvisory(vehicle) {
    if (!vehicle || typeof vehicle !== 'object') return;
    vehicle.pitIntent = null;
    vehicle.pitLimiterActive = false;
    vehicle.pitSpeedLimitMps = null;
    vehicle.pit = { state: PIT_STATES.NONE, limiterActive: false, speedLimitMps: null };
  }
}
