import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AIDebugRenderer } from '../src/render/AIDebugRenderer.js';
import { makeRace, simulate } from './ai-test-helpers.mjs';

const world = makeRace(['prototype', 'gt']);
for (const agent of world.director.agents.values()) agent.setDebugEnabled(true);
simulate(world, 2, { stopWhenFinished: false });
for (const agent of world.director.agents.values()) {
  const state = agent.debugState;
  assert.ok(state);
  assert.equal(state.planPath.length, 24);
  assert.ok(state.planPath.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
  assert.deepEqual(state.controls, world.vehicles.find((car) => car.id === state.vehicleId).controls);
  assert.ok('trajectoryDynamicallyFeasible' in state);
  assert.ok(state.candidates.length > 0);
  assert.ok(state.candidates.every((candidate) => candidate.points.length === 24));
  assert.ok(state.traffic.entries.length > 0);
}

const scene = new THREE.Scene();
const renderer = new AIDebugRenderer(scene, world.track, world.vehicles, world.director.agents);
renderer.setVisible(true);
renderer.update();
assert.equal(renderer.group.visible, true);
assert.equal(renderer.selectedSuite.layers.thoughtLabel, false);
assert.equal(renderer.selectedSuite.layers.hud, false);
assert.equal(renderer.textPanelEnabled, false);
assert.equal(renderer.fieldLabelsEnabled, false);
assert.ok(renderer.snapshot().fieldCars.length >= 1);
renderer.setFieldView(true);
assert.equal(renderer.selectedSuite.visible, false);
renderer.setFieldView(false);
assert.equal(renderer.selectedSuite.visible, true);
renderer.dispose();
assert.equal(renderer.group.parent, null);
console.log('AI debug contract passed: truthful 24-point plans and field/selected views.');
