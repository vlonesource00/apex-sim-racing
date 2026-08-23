import { clamp, wrap } from '../core/math.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const smooth = (value) => {
  const u = clamp(value, 0, 1);
  return u * u * (3 - 2 * u);
};

/**
 * One shared, predictive traffic model for tactical and longitudinal control.
 * Every entry is expressed in the ego car's local frame and in track Frenet
 * coordinates.  This prevents the pass planner and brake controller from
 * forming contradictory ideas about where another car is going.
 */
export class TrafficAwareness {
  constructor({ longitudinalEnvelope = 5.4, lateralEnvelope = 2.9 } = {}) {
    this.longitudinalEnvelope = longitudinalEnvelope;
    this.lateralEnvelope = lateralEnvelope;
  }

  scan(vehicle, vehicles, track) {
    const current = vehicle.surface ?? track.surfaceAt(vehicle.position.x, vehicle.position.z);
    const forward = vehicle.forward;
    const right = vehicle.right;
    const egoForwardSpeed = vehicle.velocity.x * forward.x + vehicle.velocity.z * forward.z;
    const egoLateralSpeed = vehicle.velocity.x * right.x + vehicle.velocity.z * right.z;
    const entries = [];

    for (const other of vehicles) {
      if (other === vehicle || other.finished || other.despawned || other.trafficGhost) continue;
      const dx = other.position.x - vehicle.position.x;
      const dz = other.position.z - vehicle.position.z;
      const longitudinal = dx * forward.x + dz * forward.z;
      const side = dx * right.x + dz * right.z;
      const delta = wrap(other.distance - vehicle.distance + track.length * 0.5, track.length) - track.length * 0.5;
      const otherForwardSpeed = other.velocity.x * forward.x + other.velocity.z * forward.z;
      const otherLateralSpeed = other.velocity.x * right.x + other.velocity.z * right.z;
      const closingSpeed = egoForwardSpeed - otherForwardSpeed;
      const bodyGap = longitudinal - this.longitudinalEnvelope * 0.5;
      entries.push({
        other, delta, longitudinal, side,
        direct: Math.hypot(dx, dz),
        lateralDelta: finite(other.surface?.lateral) - finite(current.lateral),
        otherLateral: finite(other.surface?.lateral),
        otherTargetLateral: finite(other.aiTarget?.lateral, finite(other.surface?.lateral)),
        egoForwardSpeed, otherForwardSpeed,
        relativeSpeed: finite(vehicle.speed) - finite(other.speed),
        relativeLongitudinalVelocity: closingSpeed,
        relativeLateralVelocity: otherLateralSpeed - egoLateralSpeed,
        ttc: closingSpeed > 0.2 ? Math.max(0, bodyGap) / closingSpeed : 99
      });
    }

    entries.sort((a, b) => a.delta - b.delta);
    const ahead = entries
      .filter((entry) => entry.delta > 0 && entry.delta < 55 && entry.longitudinal > -1.5 && Math.abs(entry.side) < 3.8)
      .sort((a, b) => a.delta - b.delta)[0] ?? null;
    const behind = entries
      .filter((entry) => entry.delta < 0 && entry.delta > -28 && entry.longitudinal < 1.5 && Math.abs(entry.side) < 4.8)
      .sort((a, b) => b.delta - a.delta)[0] ?? null;
    const alongside = entries
      .filter((entry) => entry.direct < 5.8 && Math.abs(entry.longitudinal) < 4.8)
      .sort((a, b) => a.direct - b.direct)[0] ?? null;

    const occupancy = {
      frontLeft: [], frontCenter: [], frontRight: [],
      sideLeft: [], sideRight: [],
      rearLeft: [], rearCenter: [], rearRight: []
    };
    for (const entry of entries) {
      const longitudinalBand = entry.longitudinal > 4.5 ? 'front'
        : entry.longitudinal < -4.5 ? 'rear' : 'side';
      const lateralBand = entry.side > 1.5 ? 'Right' : entry.side < -1.5 ? 'Left' : 'Center';
      const key = longitudinalBand === 'side'
        ? (lateralBand === 'Left' ? 'sideLeft' : lateralBand === 'Right' ? 'sideRight' : null)
        : `${longitudinalBand}${lateralBand}`;
      if (!key || !occupancy[key]) continue;
      occupancy[key].push({
        id: entry.other.id, distanceM: entry.direct, deltaM: entry.delta,
        relativeLongitudinalVelocityMps: entry.relativeLongitudinalVelocity,
        predicted: [0.5, 1, 2, 3].map((timeS) => ({
          timeS,
          longitudinalM: entry.longitudinal - entry.relativeLongitudinalVelocity * timeS,
          lateralM: entry.side + entry.relativeLateralVelocity * timeS
        }))
      });
    }

    return { current, entries, ahead, behind, alongside, occupancy, egoForwardSpeed };
  }

  evaluateCorridor({ vehicle, track, traffic, terminalOffset, targetId = null, horizonS = 3.4, targetSpeed = vehicle.speed }) {
    const startLateral = finite(traffic.current?.lateral);
    const roadMargin = Math.max(2.1, finite(track.roadHalfWidth, 6.5) - 1.75);
    const offset = clamp(finite(terminalOffset), -roadMargin, roadMargin);
    let legal = Math.abs(offset) <= roadMargin + 1e-6;
    let collisionFree = true;
    let minimumClearance = 99;
    let blocker = null;
    const samples = 18;

    for (let index = 0; index < samples; index += 1) {
      const time = horizonS * index / (samples - 1);
      const forwardDistance = Math.max(0, finite(vehicle.speed) * time
        + 0.5 * clamp((finite(targetSpeed) - finite(vehicle.speed)) * 0.45, -7, 4.8) * time * time);
      const lateral = startLateral + (offset - startLateral) * smooth(time / Math.max(0.75, Math.min(2.2, 0.75 + Math.abs(offset - startLateral) * 0.2)));
      const point = track.atDistance(vehicle.distance + forwardDistance);
      const surfaceLimit = finite(track.planningLateralLimit?.(point.s, lateral), roadMargin);
      if (Math.abs(lateral) > Math.min(roadMargin, surfaceLimit)) legal = false;

      for (const entry of traffic.entries) {
        const opponentProgress = Math.max(0, finite(entry.other.speed) * time);
        const longitudinalGap = entry.delta + opponentProgress - forwardDistance;
        const opponentLateral = entry.otherLateral
          + (entry.otherTargetLateral - entry.otherLateral) * smooth(time / 1.25);
        const lateralGap = Math.abs(lateral - opponentLateral);
        const longitudinalClearance = Math.abs(longitudinalGap) - this.longitudinalEnvelope;
        const lateralClearance = lateralGap - this.lateralEnvelope;
        const clearance = Math.max(longitudinalClearance, lateralClearance);
        minimumClearance = Math.min(minimumClearance, clearance);
        const isPassTarget = targetId !== null && entry.other.id === targetId;
        const initialTargetSeparation = Math.abs(startLateral - entry.otherLateral);
        // A legal grid/follow gap can sit inside the conservative swept-box
        // envelope without actual OBB contact. If the chosen pass trajectory
        // increases lateral separation while remaining behind the target, it
        // is an escape path and must not be rejected as an existing collision.
        const separatingFromPassTarget = isPassTarget && Math.abs(longitudinalGap) > 2.8
          && lateralGap >= initialTargetSeparation - 0.08;
        if (longitudinalClearance < 0 && lateralClearance < 0 && !separatingFromPassTarget) {
          collisionFree = false;
          if (!blocker || clearance < blocker.clearance) blocker = { entry, clearance, time };
        }
      }
    }

    // A pass target may occupy the longitudinal corridor while we move beside
    // it; it is still unsafe until the lateral envelope becomes positive.
    const target = targetId ? traffic.entries.find((entry) => entry.other.id === targetId) : null;
    const targetSeparation = target ? Math.abs(offset - target.otherLateral) : 99;
    return {
      offset, legal, collisionFree: legal && collisionFree,
      minimumClearanceM: finite(minimumClearance, 99),
      blockerId: blocker?.entry.other.id ?? null,
      blockerTimeS: finite(blocker?.time, 99),
      targetSeparationM: targetSeparation
    };
  }

  forwardHazard(traffic, { maximumTtc = 5, lateralEnvelope = 3.15 } = {}) {
    return traffic.entries
      .filter((entry) => entry.longitudinal > 0 && entry.longitudinal < 58
        && entry.relativeLongitudinalVelocity > 0.25)
      .map((entry) => {
        const time = clamp(entry.ttc, 0.3, 3.2);
        const predictedSide = Math.abs(entry.side + entry.relativeLateralVelocity * time);
        return { ...entry, predictedSide };
      })
      .filter((entry) => entry.ttc < maximumTtc && entry.predictedSide < lateralEnvelope)
      .sort((a, b) => a.ttc - b.ttc)[0] ?? null;
  }
}
