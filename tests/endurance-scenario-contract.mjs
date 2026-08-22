import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ENDURANCE_PARK,
  estimatedScenarioInstanceCount,
  estimateScenarioLength,
  sampleScenarioControlPoints
} from '../src/scenarios/EndurancePark.js';
import { EnduranceScenarioVisuals, createEndurancePlacementPlan } from '../src/render/EnduranceScenarioVisuals.js';
import { Circuit } from '../src/simulation/Track.js';

const estimatedLength = estimateScenarioLength(ENDURANCE_PARK, 32);
assert.ok(estimatedLength >= 2400 && estimatedLength <= 3800, `Endurance Park length outside brief: ${estimatedLength.toFixed(1)} m`);
const liveTrack = new Circuit(ENDURANCE_PARK);
assert.ok(Math.abs(liveTrack.length - estimatedLength) < 8, 'live Circuit must consume the endurance scenario geometry');
assert.equal(liveTrack.samples.length, ENDURANCE_PARK.controlPoints.length * ENDURANCE_PARK.sampleDensity);
const pitPoint = liveTrack.lateralPoint(liveTrack.atDistance(liveTrack.length * ENDURANCE_PARK.pit.boxStartFraction), ENDURANCE_PARK.pit.lateralM);
assert.equal(liveTrack.surfaceAt(pitPoint.x, pitPoint.z).zone, 'pit', 'authored pit lane must be a physical surface');

const samplesPerSpan = 32;
const samples = sampleScenarioControlPoints(ENDURANCE_PARK.controlPoints, samplesPerSpan);
const mainStraightM = samples.slice(0, samplesPerSpan + 1).reduce((total, point, index, span) => {
  if (!index || !span[index - 1]) return total;
  return total + Math.hypot(point.x - span[index - 1].x, point.y - span[index - 1].y, point.z - span[index - 1].z);
}, 0);
assert.ok(mainStraightM >= 550 && mainStraightM <= 850, `Main straight outside brief: ${mainStraightM.toFixed(1)} m`);

const points = ENDURANCE_PARK.controlPoints;
for (let index = 0; index < points.length; index += 1) {
  const point = points[index];
  const next = points[(index + 1) % points.length];
  assert.ok(Math.hypot(next.x - point.x, next.y - point.y, next.z - point.z) >= 75, `Control span ${index} is implausibly small`);
  assert.notDeepEqual(point, next, `Duplicate control point at ${index}`);
}

const technical = ENDURANCE_PARK.sectors.filter((sector) => sector.character === 'technical');
assert.ok(technical.length >= 3, 'Endurance Park needs three technical complexes');
assert.ok(ENDURANCE_PARK.sectors.some((sector) => sector.character === 'high-speed'), 'Endurance Park needs a high-speed sector');
const elevations = points.map((point) => point.y);
const elevationDelta = Math.max(...elevations) - Math.min(...elevations);
assert.ok(elevationDelta >= 18 && elevationDelta <= 45, `Elevation delta outside brief: ${elevationDelta} m`);

const pit = ENDURANCE_PARK.pit;
for (const fraction of [pit.entryFraction, pit.limiterFraction, pit.boxStartFraction, pit.boxEndFraction, pit.exitFraction]) {
  assert.ok(fraction >= 0 && fraction < 1, `Invalid pit fraction: ${fraction}`);
}
assert.ok(pit.entryFraction < pit.limiterFraction && pit.limiterFraction < pit.boxStartFraction && pit.boxStartFraction < pit.boxEndFraction, 'Pit lane markers must be ordered before the wrap exit');
assert.ok(pit.exitFraction < pit.entryFraction && pit.pitSpeedLimitMps > 0 && pit.serviceDurationS > 0, 'Pit config lacks wrap exit/speed/service values');

assert.ok(estimatedScenarioInstanceCount(ENDURANCE_PARK) >= 300, 'Scenario does not describe enough procedural scenery');
const plan = createEndurancePlacementPlan(ENDURANCE_PARK);
assert.ok(plan.instanceCount >= 300, 'Placement planner did not preserve scenery count');
assert.ok(plan.drawCallBudget <= 35, 'Steady-state draw-call target regressed');
for (const required of ['tree', 'fence', 'tireStack', 'cone', 'brakingBoard', 'marshal', 'camera', 'crowd', 'flag', 'lightGantry', 'serviceVehicle', 'camper']) {
  assert.ok(plan[required]?.length > 0, `Missing ${required} placement descriptors`);
}

const scene = new THREE.Scene();
const visuals = new EnduranceScenarioVisuals(scene, liveTrack, ENDURANCE_PARK);
assert.ok(scene.children.includes(visuals.root), 'Visuals must attach one root group to the supplied scene');
assert.ok(visuals.metrics.instancedBatches <= 35, 'Visual batch count exceeds steady draw-call target');
assert.ok(visuals.metrics.plannedInstances >= 300, 'Visuals lost planned instance count');
let fallbackDrawCalls = 0;
visuals.root.traverse((object) => { if (object.isMesh) fallbackDrawCalls += 1; });
assert.ok(fallbackDrawCalls <= 35, `Fallback visuals exceed steady draw-call target: ${fallbackDrawCalls}`);
visuals.update(1 / 60, []);
visuals.dispose();

console.log(`Endurance scenario contract passed: ${estimatedLength.toFixed(1)} m, ${mainStraightM.toFixed(1)} m main straight, ${elevationDelta} m elevation, ${plan.instanceCount} planned props.`);
