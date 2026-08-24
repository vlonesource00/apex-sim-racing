import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { RaceState } from '../src/simulation/Race.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);
const classes = ['touring', 'prototype', 'gt', 'touring', 'prototype', 'gt'];
const vehicles = classes.map((spec, index) => new Vehicle({ id: `racecraft-${index + 1}`, name: `RC${index + 1}`, spec }));
const controllers = new Map(vehicles.map((vehicle, index) => {
  const controller = new AIController(index + 1);
  controller.setDebugEnabled(true);
  return [vehicle.id, controller];
}));
const race = new RaceState(track, vehicles, 2);
vehicles.forEach((vehicle, index) => {
  const grid = race.gridPosition(index);
  vehicle.resetTo(track, grid.distance, grid.lateral);
});
race.reset();

const telemetry = new Map(vehicles.map((vehicle) => [vehicle.id, {
  straightSamples: 0, straightFullThrottle: 0, straightThrottle: 0, maxStraightSpeed: 0,
  straightThrottleCuts: 0, straightThrottleCutReasons: {}, recoveryRun: 0, maxRecoveryRun: 0,
  lastOffTrack: false, offTrackRun: 0, maxOffTrackRun: 0,
  closeFrontSamples: 0, followSamples: 0, passSamples: 0, attackLeftSamples: 0, attackRightSamples: 0,
  returnSamples: 0, avoidSamples: 0, maxPassRun: 0, passRun: 0,
  spinSamples: 0, offTrackSamples: 0, positionChanges: 0, lastPosition: null, firstOffTrack: null
}]));
let contactFrames = 0;
let deepOverlapFrames = 0;
let maxContactImpact = 0;
const contactPairs = new Map();
let activeContactFrames = 0;
let activeDeepOverlapFrames = 0;
let activeMaxContactImpact = 0;
const activeContactPairs = new Map();
const activeContactEvents = new Map();

for (let step = 0; step < 260 / DT; step += 1) {
  race.step(DT);
  for (const vehicle of vehicles) controllers.get(vehicle.id).update(vehicle, vehicles, track, race, DT);
  updateAerodynamicWakes(vehicles);
  for (const vehicle of vehicles) vehicle.step(DT, track, race.phase === 'racing');
  const collisionStats = resolveVehicleCollisions(vehicles, 3);
  if (collisionStats.contacts > 0) contactFrames += 1;
  if (collisionStats.deepOverlaps > 0) deepOverlapFrames += 1;
  maxContactImpact = Math.max(maxContactImpact, collisionStats.maxImpact);
  const activePairKeys = new Set();
  for (const pair of collisionStats.contactPairs) {
    const key = [pair.a, pair.b].sort().join('|');
    contactPairs.set(key, (contactPairs.get(key) ?? 0) + 1);
    const first = vehicles.find((car) => car.id === pair.a);
    const second = vehicles.find((car) => car.id === pair.b);
    if (race.phase === 'racing' && race.raceTime >= 6 && !first.finished && !second.finished) {
      activePairKeys.add(key);
      activeContactPairs.set(key, (activeContactPairs.get(key) ?? 0) + 1);
      activeMaxContactImpact = Math.max(activeMaxContactImpact, pair.impact);
      const prior = activeContactEvents.get(key);
      if (!prior || pair.impact > prior.impact) {
        const compactCar = (car) => {
          const debug = controllers.get(car.id).debugState;
          return {
            id: car.id, d: Number(car.distance.toFixed(1)), lat: Number((car.surface?.lateral ?? 0).toFixed(2)),
            kph: Number((car.speed * 3.6).toFixed(1)), mode: debug?.mode,
            phase: debug?.racecraftPhase,
            target: debug?.passIntent?.targetId ?? null,
            requestedLane: Number((debug?.trajectory?.requestedOffset ?? 0).toFixed(2)),
            selectedLane: Number((debug?.trajectory?.selectedOffset ?? 0).toFixed(2)),
            clearance: Number((debug?.trajectory?.minimumClearanceM ?? 99).toFixed(2)),
            trajectorySafe: debug?.trajectory?.collisionFree ?? null,
            steer: Number((car.controls.steer ?? 0).toFixed(2)),
            brake: Number((car.controls.brake ?? 0).toFixed(2))
          };
        };
        activeContactEvents.set(key, {
          time: Number(race.raceTime.toFixed(2)), impact: Number(pair.impact.toFixed(3)),
          first: compactCar(first), second: compactCar(second)
        });
      }
    }
  }
  if (activePairKeys.size > 0) activeContactFrames += 1;
  if (activePairKeys.size > 0 && collisionStats.deepOverlaps > 0) activeDeepOverlapFrames += 1;
  for (const vehicle of vehicles) {
    const stats = telemetry.get(vehicle.id);
    const offTrackNow = vehicle.surface?.zone === 'grass' || vehicle.surface?.zone === 'runoff';
    if (offTrackNow && !stats.lastOffTrack && stats.firstOffTrack === null && race.phase === 'racing') {
      const debug = controllers.get(vehicle.id).debugState;
      stats.firstOffTrack = {
        timeS: Number(race.raceTime.toFixed(2)), distanceM: Number(vehicle.distance.toFixed(1)),
        lateralM: Number(finite(vehicle.surface?.lateral).toFixed(2)), speedKmh: Number((vehicle.speed * 3.6).toFixed(1)),
        mode: debug?.mode ?? null, phase: debug?.racecraftPhase ?? null,
        requestedLaneM: Number(finite(debug?.trajectoryRequestedOffsetM).toFixed(2)),
        selectedLaneM: Number(finite(debug?.trajectorySelectedOffsetM).toFixed(2)),
        steer: Number(vehicle.controls.steer.toFixed(2)), brake: Number(vehicle.controls.brake.toFixed(2))
      };
    }
    if (offTrackNow) {
      stats.offTrackRun += DT;
      stats.maxOffTrackRun = Math.max(stats.maxOffTrackRun, stats.offTrackRun);
    } else {
      stats.offTrackRun = 0;
    }
    stats.lastOffTrack = offTrackNow;
  }
  if (race.phase !== 'racing' || race.raceTime < 6) continue;
  for (const vehicle of vehicles) {
    if (vehicle.finished) continue;
    const stats = telemetry.get(vehicle.id);
    const debug = controllers.get(vehicle.id).debugState;
    const curvature = track.atDistance(vehicle.distance + Math.max(20, vehicle.speed * 0.65)).curvature;
    if (curvature < 0.0028 && vehicle.surface?.zone === 'road') {
      stats.straightSamples += 1;
      stats.straightThrottle += vehicle.controls.throttle;
      if (vehicle.controls.throttle > 0.92) stats.straightFullThrottle += 1;
      stats.maxStraightSpeed = Math.max(stats.maxStraightSpeed, vehicle.speed);
      if (vehicle.controls.throttle < 0.92) {
        stats.straightThrottleCuts += 1;
        const cutReason = debug?.recovering
          ? 'RECOVER'
          : debug?.trafficThreat && debug.trafficThreat !== 'CLEAR'
            ? `TTC_${debug.trafficThreat}`
            : debug?.mode ?? 'RACE';
        stats.straightThrottleCutReasons[cutReason] = (stats.straightThrottleCutReasons[cutReason] ?? 0) + 1;
      }
    }
    if (debug?.recovering) {
      stats.recoveryRun += DT;
      stats.maxRecoveryRun = Math.max(stats.maxRecoveryRun, stats.recoveryRun);
    } else {
      stats.recoveryRun = 0;
    }
    if (debug?.closeFront) stats.closeFrontSamples += 1;
    if (debug?.mode === 'FOLLOW') stats.followSamples += 1;
    if (debug?.mode === 'PASS') stats.passSamples += 1;
    if (debug?.racecraftPhase === 'ATTACK_LEFT') stats.attackLeftSamples += 1;
    if (debug?.racecraftPhase === 'ATTACK_RIGHT') stats.attackRightSamples += 1;
    if (debug?.racecraftPhase === 'RETURN') stats.returnSamples += 1;
    stats.passRun = debug?.mode === 'PASS' ? stats.passRun + DT : 0;
    stats.maxPassRun = Math.max(stats.maxPassRun, stats.passRun);
    if (debug?.mode === 'AVOID') stats.avoidSamples += 1;
    const bodySlip = Math.atan2(vehicle.localVelocity?.x ?? 0, Math.max(3, Math.abs(vehicle.localVelocity?.z ?? vehicle.speed)));
    if (Math.abs(bodySlip) > 0.45 && Math.abs(vehicle.yawRate) > 2.2) stats.spinSamples += 1;
    if (vehicle.surface?.zone === 'grass' || vehicle.surface?.zone === 'runoff') stats.offTrackSamples += 1;
    const position = race.positionFor(vehicle);
    if (stats.lastPosition !== null && position !== stats.lastPosition) stats.positionChanges += 1;
    stats.lastPosition = position;
  }
}

const report = vehicles.map((vehicle) => {
  const stats = telemetry.get(vehicle.id);
  const sampleSeconds = (samples) => Number((samples * DT).toFixed(2));
  return {
    id: vehicle.id, classKey: vehicle.classKey, finished: vehicle.finished,
    lap: race.entries.get(vehicle.id).lap, finalSpeedKmh: Number((vehicle.speed * 3.6).toFixed(1)),
    finishTimeS: Number((race.entries.get(vehicle.id).finishTime ?? 0).toFixed(2)),
    straightFullThrottlePct: Number((100 * stats.straightFullThrottle / Math.max(1, stats.straightSamples)).toFixed(1)),
    meanStraightThrottle: Number((stats.straightThrottle / Math.max(1, stats.straightSamples)).toFixed(3)),
    maxStraightKmh: Number((stats.maxStraightSpeed * 3.6).toFixed(1)),
    straightThrottleCuts: stats.straightThrottleCuts,
    straightThrottleCutReasons: stats.straightThrottleCutReasons,
    maxRecoveryRunS: Number(stats.maxRecoveryRun.toFixed(2)),
    closeFrontS: sampleSeconds(stats.closeFrontSamples), followS: sampleSeconds(stats.followSamples),
    passS: sampleSeconds(stats.passSamples), attackLeftS: sampleSeconds(stats.attackLeftSamples),
    attackRightS: sampleSeconds(stats.attackRightSamples),
    returnS: sampleSeconds(stats.returnSamples), maxPassRunS: Number(stats.maxPassRun.toFixed(2)),
    avoidS: sampleSeconds(stats.avoidSamples),
    unstableS: sampleSeconds(stats.spinSamples), offTrackS: sampleSeconds(stats.offTrackSamples),
    maxOffTrackRunS: Number(stats.maxOffTrackRun.toFixed(2)),
    positionChanges: stats.positionChanges, marshalRecoveries: controllers.get(vehicle.id).marshalRecoveries,
    firstOffTrack: stats.firstOffTrack
  };
});
console.log(JSON.stringify(report, null, 2));
console.log('CONTACT_QUALITY', JSON.stringify({
  contactFrames, deepOverlapFrames, maxContactImpact,
  pairs: [...contactPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  activeContactFrames, activeDeepOverlapFrames, activeMaxContactImpact,
  activePairs: [...activeContactPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  activeEvents: Object.fromEntries(activeContactEvents)
}));

assert.equal(report.filter((car) => car.finished).length, vehicles.length, 'the whole field must finish');
assert.ok(report.filter((car) => car.passS > 0.5).length >= 4, 'mixed-class traffic must produce committed passing attempts, including decisive sub-second passes');
assert.ok(report.reduce((sum, car) => sum + car.followS, 0) > 0.4, 'traffic must produce a bounded follow/setup phase');
assert.ok(report.some((car) => car.attackLeftS > 0), 'left-side pass intent must be observable');
assert.ok(report.some((car) => car.attackRightS > 0), 'right-side pass intent must be observable');
assert.ok(report.every((car) => car.maxPassRunS <= 13.5), 'a committed pass phase must remain finite');
assert.ok(activeContactFrames <= 90, `AI field produced ${activeContactFrames} active-race contact frames`);
assert.equal(activeDeepOverlapFrames, 0, `AI field produced ${activeDeepOverlapFrames} active-race deep-overlap frames`);
assert.ok(activeMaxContactImpact <= 3, `AI field produced active-race contact impact ${activeMaxContactImpact}`);
assert.ok(report.reduce((sum, car) => sum + car.straightFullThrottlePct, 0) / report.length >= 82, 'field must use full throttle on clean straights');
for (const car of report) {
  assert.ok(car.unstableS <= 2.5, `${car.id} spent ${car.unstableS}s in a severe spin state`);
  assert.ok(car.offTrackS <= 8, `${car.id} spent ${car.offTrackS}s off track`);
  assert.ok(car.marshalRecoveries <= 3, `${car.id} needed ${car.marshalRecoveries} marshal recoveries`);
}

// Isolated prototype straight probe: clean straight feed-forward should be
// fully committed without broadening the AI's corner classification.
const straightVehicle = new Vehicle({ id: 'racecraft-clean-prototype', spec: 'prototype' });
straightVehicle.resetTo(track, 80, 0);
const straightController = new AIController(97);
const straightRace = new RaceState(track, [straightVehicle], 1);
straightRace.reset();
let straightSamples = 0;
let straightFullThrottle = 0;
for (let step = 0; step < 14 / DT; step += 1) {
  straightRace.step(DT);
  straightController.update(straightVehicle, [straightVehicle], track, straightRace, DT);
  updateAerodynamicWakes([straightVehicle]);
  straightVehicle.step(DT, track, straightRace.phase === 'racing');
  if (straightRace.phase !== 'racing') continue;
  const point = track.atDistance(straightVehicle.distance + Math.max(20, straightVehicle.speed * 0.65));
  if (point.curvature < 0.0028 && straightVehicle.surface?.zone === 'road') {
    straightSamples += 1;
    if (straightVehicle.controls.throttle > 0.98) straightFullThrottle += 1;
  }
}
assert.ok(straightSamples > 120, 'clean prototype straight probe must collect enough samples');
assert.ok(straightFullThrottle / straightSamples >= 0.98, 'clean prototype straight must stay at full throttle');
