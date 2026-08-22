import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraRig } from '../src/render/Cameras.js';
import { InputManager } from '../src/input.js';

const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.035, 2000);
camera.position.set(0, 5, -9);
camera.lookAt(0, 0, 10);
camera.updateMatrixWorld(true);
const rig = new CameraRig(camera);
const ai = {
  id: 'ai-1', name: 'VEGA', position: new THREE.Vector3(45, 1.2, 80),
  yaw: 0.4, speed: 61, localAcceleration: { x: 0, z: 0 },
  localVelocity: { x: 0, z: 61 }, acceleration: { y: 0 }
};

assert.equal(rig.setSpectate(), 'SPECTATE');
for (let frame = 0; frame < 120; frame += 1) rig.update(ai, 1 / 60);
assert.ok(camera.position.distanceTo(ai.position) > 8, 'spectate camera should keep a readable broadcast distance');
assert.ok(camera.position.distanceTo(ai.position) < 35, 'spectate camera must follow the selected AI');
assert.ok(Number.isFinite(camera.rotation.y), 'spectate orientation must remain finite');
assert.equal(rig.setSpectate(), 'CHASE', 'F5-style toggle must restore the prior standard camera');

assert.equal(rig.setFree(), 'FREE');
const before = camera.position.clone();
for (let frame = 0; frame < 60; frame += 1) {
  rig.updateFree({ forward: 1, right: 0.3, up: 0.2, yaw: 0.15, pitch: 0.05, boost: false }, 1 / 60);
}
assert.ok(camera.position.distanceTo(before) > 20, 'no-clip must translate independently through world space');
assert.ok(Number.isFinite(camera.position.x + camera.position.y + camera.position.z), 'no-clip position must remain finite');
assert.equal(rig.setFree(), 'CHASE', 'F6-style toggle must restore the prior standard camera');

const input = Object.create(InputManager.prototype);
input.keys = new Set(['KeyW', 'KeyD', 'KeyE', 'ArrowLeft', 'ArrowUp', 'ShiftLeft']);
const free = input.freeCameraRaw();
assert.deepEqual(free, { forward: 1, right: 1, up: 1, yaw: -1, pitch: 1, boost: true });

console.log('Debug camera contract passed: selected-AI spectate, global no-clip motion, and dedicated controls.');
