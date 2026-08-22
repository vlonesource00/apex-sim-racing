import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Circuit } from '../src/simulation/Track.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { AIController } from '../src/simulation/AI.js';
import { RaceState } from '../src/simulation/Race.js';
import { AIDebugRenderer } from '../src/render/AIDebugRenderer.js';

const DT = 1 / 120;

function makeWorld(debugEnabled) {
  const track = new Circuit();
  const player = new Vehicle({ id: 'player', name: 'PLAYER', player: true });
  const ai = new Vehicle({ id: 'ai-1', name: 'VEGA', color: '#3378a8', spec: 'prototype' });
  const vehicles = [player, ai];
  const controller = new AIController(1);
  const race = new RaceState(track, vehicles, 3);
  vehicles.forEach((vehicle, index) => {
    const grid = race.gridPosition(index);
    vehicle.resetTo(track, grid.distance, grid.lateral);
  });
  race.reset();
  controller.setDebugEnabled(debugEnabled);
  for (let step = 0; step < 1200; step += 1) {
    race.step(DT);
    player.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    controller.update(ai, vehicles, track, race, DT);
    for (const vehicle of vehicles) vehicle.step(DT, track, race.phase === 'racing');
  }
  return { track, vehicles, ai, controller, race };
}

function assertFiniteTree(value, label = 'value') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${label} must be finite`);
  else if (Array.isArray(value)) value.forEach((entry, index) => assertFiniteTree(entry, `${label}[${index}]`));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => assertFiniteTree(entry, `${label}.${key}`));
}

const off = makeWorld(false);
assert.equal(off.controller.debugState, null, 'debug state must stay absent while collection is disabled');
assert.equal(off.controller._debugPlanPath.length, 0, 'debug-off updates must not sample a plan path');

const on = makeWorld(true);
const state = on.controller.debugState;
assert.ok(state, 'debug state should publish when enabled');
assert.equal(state.vehicleId, 'ai-1');
assert.equal(state.name, 'VEGA');
assert.ok(['GRID', 'RACE', 'FOLLOW', 'PASS', 'DEFEND', 'AVOID', 'BRAKE', 'RECOVER', 'COOLDOWN', 'PIT'].includes(state.mode));
assert.deepEqual(state.controls, on.ai.controls, 'debug controls must be the exact AI output');
assert.equal(state.planPath.length, 24, 'debug plan must contain twenty-four world points');
assert.ok(Math.hypot(
  state.planPath[0].x - on.ai.position.x,
  state.planPath[0].z - on.ai.position.z
) < 0.35, 'debug point zero must equal the vehicle position');
assert.ok(state.planPath.at(-1).time >= 3, 'debug plan horizon must reach at least three seconds');
for (let i = 1; i < state.planPath.length; i += 1) {
  assert.ok(state.planPath[i].time > state.planPath[i - 1].time, 'debug plan time must increase');
  assert.ok(Number.isFinite(state.planPath[i].predictedSpeed), 'debug predicted speed must be finite');
}
assertFiniteTree(state, 'debugState');

const scene = new THREE.Scene();
const debugRenderer = new AIDebugRenderer(scene, on.track, on.vehicles, new Map([['ai-1', on.controller]]));
assert.equal(debugRenderer.group.visible, false);
debugRenderer.setVisible(true);
assert.equal(on.controller.debugEnabled, true);
debugRenderer.update();
assert.equal(debugRenderer.group.visible, true);
assert.equal(debugRenderer.entries[0].line.visible, true);
assert.equal(debugRenderer.entries[0].marker.visible, true);
assert.equal(debugRenderer.entries[0].material.depthTest, true);
assert.equal(debugRenderer.snapshot().selectedId, 'ai-1');
assert.equal(debugRenderer.snapshot().fieldView, false);
debugRenderer.setFieldView(true);
assert.equal(debugRenderer.snapshot().fieldView, true);
debugRenderer.setVisible(false);
assert.equal(on.controller.debugEnabled, false);
assert.equal(debugRenderer.entries[0].line.visible, false);
debugRenderer.dispose();
assert.equal(debugRenderer.group.parent, null);

const standings = on.race.standings(on.vehicles[0]);
assert.equal(standings.length, 2);
assert.deepEqual(Object.keys(standings[0]), ['position', 'id', 'name', 'classKey', 'lap', 'finished', 'distanceGapM']);
assert.equal(standings[0].position, on.race.positionFor(on.vehicles[standings[0].id === 'player' ? 0 : 1]));
assert.equal(on.race.statusFor(on.vehicles[0]).position, standings.find((row) => row.id === 'player').position);
assert.ok(standings.every((row) => Number.isFinite(row.distanceGapM)));

const deterministicOff = makeWorld(false);
const deterministicOn = makeWorld(true);
assert.deepEqual(deterministicOn.ai.controls, deterministicOff.ai.controls, 'debug toggle must not change final controls');
assert.deepEqual(
  { position: deterministicOn.ai.position, velocity: deterministicOn.ai.velocity, yaw: deterministicOn.ai.yaw, distance: deterministicOn.ai.distance },
  { position: deterministicOff.ai.position, velocity: deterministicOff.ai.velocity, yaw: deterministicOff.ai.yaw, distance: deterministicOff.ai.distance },
  'debug toggle must not change simulation state'
);

console.log('AI debug contract passed: finite intent/path, truthful controls, opt-in renderer, standings, and deterministic simulation.');
