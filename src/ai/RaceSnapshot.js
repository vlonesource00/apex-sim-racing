import { wrap, wrapAngle } from '../core/math.js';
import { finite } from './AIConfig.js';

const signedDistance = (from, to, length) => {
  const raw = wrap(to - from, length);
  return raw > length * 0.5 ? raw - length : raw;
};

const stateFor = (vehicle, track, race) => {
  const surface = track.surfaceAt(vehicle.position.x, vehicle.position.z);
  const tangent = surface.tangent;
  const normal = surface.normal;
  const forwardSpeed = vehicle.velocity.x * tangent.x + vehicle.velocity.z * tangent.z;
  const lateralSpeed = vehicle.velocity.x * normal.x + vehicle.velocity.z * normal.z;
  const trackHeading = Math.atan2(tangent.x, tangent.z);
  const raceEntry = race?.entries?.get(vehicle.id);
  return Object.freeze({
    id: vehicle.id,
    vehicle,
    player: Boolean(vehicle.player),
    classKey: vehicle.classKey,
    position: Object.freeze({ x: finite(vehicle.position.x), y: finite(vehicle.position.y), z: finite(vehicle.position.z) }),
    velocity: Object.freeze({ x: finite(vehicle.velocity.x), z: finite(vehicle.velocity.z) }),
    acceleration: Object.freeze({ x: finite(vehicle.acceleration?.x), z: finite(vehicle.acceleration?.z) }),
    speed: Math.max(0, finite(vehicle.speed)),
    forwardSpeed,
    lateralSpeed,
    distance: finite(surface.s, vehicle.distance),
    completedLaps: finite(raceEntry?.lap),
    raceProgress: finite(raceEntry?.unwrappedDistance, finite(surface.s, vehicle.distance)),
    lateral: finite(surface.lateral),
    zone: surface.zone,
    grip: finite(surface.grip, 1),
    yaw: finite(vehicle.yaw),
    yawRate: finite(vehicle.yawRate),
    headingError: wrapAngle(finite(vehicle.yaw) - trackHeading),
    halfLength: finite(vehicle.collisionHalfLength, 2.55),
    halfWidth: finite(vehicle.collisionHalfWidth, 1.02),
    targetLateral: finite(vehicle.aiTarget?.lateral, finite(surface.lateral)),
    finished: Boolean(vehicle.finished),
    despawned: Boolean(vehicle.despawned),
    ghost: Boolean(vehicle.trafficGhost),
    pitIntent: vehicle.pitIntent ?? null,
    previousIntent: vehicle.aiTactical ?? null,
    wake: Object.freeze({
      strength: finite(vehicle.aero?.wakeStrength),
      dragReduction: finite(vehicle.aero?.dragReduction),
      frontLoss: finite(vehicle.aero?.frontDownforceLoss),
      rearLoss: finite(vehicle.aero?.rearDownforceLoss)
    })
  });
};

export class RaceSnapshot {
  static capture({ vehicles, track, race, tick = 0 }) {
    const states = vehicles.filter((vehicle) => !vehicle.despawned)
      .map((vehicle) => stateFor(vehicle, track, race));
    const byId = new Map(states.map((state) => [state.id, state]));
    return new RaceSnapshot({ states, byId, track, race, tick });
  }

  constructor({ states, byId, track, race, tick }) {
    this.states = Object.freeze(states);
    this.byId = byId;
    this.track = track;
    this.race = race;
    this.tick = tick;
    this.raceTime = finite(race?.raceTime);
    this.phase = race?.phase ?? 'racing';
  }

  ego(id) { return this.byId.get(id) ?? null; }

  trafficFor(id, rangeM = 110) {
    const ego = this.byId.get(id);
    if (!ego) return [];
    return this.states
      .filter((other) => other.id !== id && !other.finished && !other.despawned && !other.ghost)
      .map((other) => {
        const delta = signedDistance(ego.distance, other.distance, this.track.length);
        const lateralDelta = other.lateral - ego.lateral;
        const closingSpeed = ego.forwardSpeed - other.forwardSpeed;
        return Object.freeze({
          other,
          delta,
          lateralDelta,
          closingSpeed,
          ttc: delta > 0 && closingSpeed > 0.05 ? delta / closingSpeed : 99,
          overlapLongitudinal: Math.abs(delta) < ego.halfLength + other.halfLength,
          overlapLateral: Math.abs(lateralDelta) < ego.halfWidth + other.halfWidth
        });
      })
      .filter((entry) => Math.abs(entry.delta) <= rangeM)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
  }
}

export { signedDistance };
