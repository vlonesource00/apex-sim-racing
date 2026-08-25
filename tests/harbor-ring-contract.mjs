import assert from 'node:assert/strict';
import { Circuit } from '../src/simulation/Track.js';
import { HARBOR_RING } from '../src/scenarios/HarborRing.js';
import { createCircuitPlacementPlan } from '../src/render/CircuitScenarioVisuals.js';

const track = new Circuit(HARBOR_RING);
assert.ok(track.length >= 2400 && track.length <= 3600, `unexpected Harbor Ring length ${track.length}`);
assert.equal(HARBOR_RING.id, 'harbor-ring');
assert.ok(HARBOR_RING.sectors.some((sector) => sector.character === 'heavy-braking'));
assert.ok(HARBOR_RING.sectors.filter((sector) => sector.character === 'technical').length >= 2);
for (const [index, point] of track.samples.entries()) {
  assert.ok(Math.abs(point.y) < 1e-9, `sample ${index} has elevation`);
  assert.ok(Math.abs(point.grade) < 1e-9, `sample ${index} has grade`);
  assert.ok(Math.abs(point.bank) < 1e-9, `sample ${index} has banking`);
}
const plan = createCircuitPlacementPlan(HARBOR_RING);
assert.equal(plan.instanceCount,
  HARBOR_RING.scenery.expectedInstanceCount + HARBOR_RING.landmarks.length);
console.log(`Harbor Ring contract passed: ${track.length.toFixed(1)} m and completely flat.`);
