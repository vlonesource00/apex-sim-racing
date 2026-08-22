import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { CarVisual } from '../src/render/CarVisual.js';
import { CameraRig } from '../src/render/Cameras.js';

function fixtureModel() {
  const root = new THREE.Group();
  for (const label of ['FL', 'FR', 'RL', 'RR']) {
    const pivot = new THREE.Group();
    pivot.name = label;
    const spin = new THREE.Group();
    spin.name = label + '_SPIN';
    pivot.add(spin);
    root.add(pivot);
  }
  const anchor = new THREE.Group();
  anchor.name = 'COCKPIT_CAMERA';
  anchor.position.set(-0.23, 1.06, -0.16);
  root.add(anchor);
  const glass = new THREE.MeshStandardMaterial({ color: '#16242a', transparent: true, opacity: 0.76 });
  glass.name = 'MAT_GLASS';
  const shell = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glass);
  shell.name = 'COCKPIT_HIDE_TEST_SHELL';
  root.add(shell);
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 0.3), new THREE.MeshStandardMaterial({ color: '#121613' }));
  dash.name = 'TEST_DASH';
  root.add(dash);
  return root;
}

function attach(vehicle) {
  const visual = new CarVisual(vehicle);
  assert.equal(visual.attachAsset({ cloneCar: () => fixtureModel() }), true);
  visual.update(0);
  return visual;
}

const player = new Vehicle({ id: 'player', name: 'PLAYER', color: '#e85038', player: true });
player.yaw = 0.31;
const playerVisual = attach(player);
const shell = playerVisual.assetModel.getObjectByName('COCKPIT_HIDE_TEST_SHELL');
const dash = playerVisual.assetModel.getObjectByName('TEST_DASH');
const originalGlass = shell.material;
const pose = playerVisual.getCockpitPose();
assert.ok(pose, 'player asset must expose a world cockpit pose');
assert.ok(pose.forward.z > 0.8, 'unrotated anchor must look forward in local vehicle space');

assert.equal(playerVisual.setCockpitView(true), true);
assert.equal(shell.visible, false, 'only tagged exterior shell should hide');
assert.equal(dash.visible, true, 'dash remains visible in cockpit');
assert.notEqual(shell.material, originalGlass, 'glass material must clone for cockpit');
assert.equal(shell.material.depthWrite, false);
assert.equal(shell.material.side, THREE.DoubleSide);
assert.ok(shell.material.opacity <= 0.12);

const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.035, 780);
const rig = new CameraRig(camera);
rig.mode = 'COCKPIT';
rig.position.copy(pose.position);
rig.look.copy(pose.position).addScaledVector(pose.forward, 24);
rig.update(player, 0.2, pose);
const cameraForward = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
const poseForward = pose.forward.clone().setY(0).normalize();
assert.ok(cameraForward.dot(poseForward) > 0.99, 'cockpit camera must use anchor forward orientation');

assert.equal(playerVisual.setCockpitView(false), true);
assert.equal(shell.visible, true, 'chase must restore tagged shell');
assert.equal(shell.material, originalGlass, 'chase must restore original glass material');

const opponent = new Vehicle({ id: 'ai', name: 'AI', color: '#3378a8' });
const opponentVisual = attach(opponent);
const opponentShell = opponentVisual.assetModel.getObjectByName('COCKPIT_HIDE_TEST_SHELL');
assert.equal(opponentVisual.setCockpitView(true), false, 'opponents must ignore player cockpit state');
assert.equal(opponentShell.visible, true, 'opponent exterior remains unchanged');

console.log('Cockpit contract passed: anchor pose, tagged-shell hiding, glass restore, player-only scope.');
