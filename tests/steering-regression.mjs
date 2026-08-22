import assert from 'node:assert/strict';
import * as THREE from 'three';
import { playerSteerFromScreenAxis } from '../src/core/conventions.js';
import { KeyboardDynamics } from '../src/input/KeyboardDynamics.js';
import { CameraRig } from '../src/render/Cameras.js';
import { CarVisual } from '../src/render/CarVisual.js';
import { Vehicle } from '../src/simulation/Vehicle.js';

const vehicle = { position: { x: 0, z: 0 }, yaw: 0, speed: 0 };
const playerRightPhysicsX = playerSteerFromScreenAxis(1);
assert.equal(playerRightPhysicsX, -1, 'Right/D must map to negative physics-X for the +Z-forward camera convention');
assert.equal(playerSteerFromScreenAxis(-1), 1, 'Left/A must map to positive physics-X for the +Z-forward camera convention');

for (const mode of ['CHASE', 'COCKPIT']) {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 780);
  const rig = new CameraRig(camera);
  rig.mode = mode;
  rig.update(vehicle, 2);
  camera.updateMatrixWorld(true);
  // With yaw=0, player-facing right is local -X in the rendered +Z-forward convention.
  const aheadRight = new THREE.Vector3(playerRightPhysicsX * 2, 0.8, 12).project(camera);
  assert.ok(aheadRight.x > 0.02, `${mode}: a player-facing right turn must project to positive screen X; got ${aheadRight.x}`);
}

console.log('Steering projection regression passed: Right/D is screen-right in CHASE and COCKPIT.');

const DT = 1 / 120;
const flatTrack = {
  length: 1000,
  atDistance: (distance) => ({
    x: 0, y: 0, z: distance, s: distance, index: 0,
    tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 },
    normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0,
    curvature: 0, turnSign: 0, turnStrength: 0
  }),
  surfaceAt: (x, z) => ({
    x, y: 0, z, s: 0, index: 0, lateral: -x,
    tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 },
    normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0, height: 0,
    grip: 1.08, zone: 'road', barrierDepth: 0, curbHeight: 0, roughness: 0,
    roadEdge: 6.5, curbEdge: 7.55, barrierEdge: 16.05, turnStrength: 0
  })
};

// Keyboard steering is a road-wheel request limited by curvature, not a
// direct yaw command. At 22 m/s the settled full-key angle remains modest.
const keyboard = new KeyboardDynamics();
const keyboardVehicle = new Vehicle({ id: 'keyboard-regression', spec: 'gt', player: true });
keyboardVehicle.speed = 22;
keyboardVehicle.localVelocity.z = 22;
let keyboardOut;
for (let i = 0; i < 360; i += 1) keyboardOut = keyboard.update({ steer: 1 }, keyboardVehicle, DT);
const keyboardRoadWheel = Math.abs(keyboardOut.steer * keyboardVehicle.spec.steeringLock);
assert.ok(keyboard.diagnostics.roadWheelLimit > 0.055 && keyboard.diagnostics.roadWheelLimit < 0.1, '22 m/s cap must be a credible road-wheel angle');
assert.ok(keyboardRoadWheel <= keyboard.diagnostics.roadWheelLimit + 1e-9, 'keyboard output must respect road-wheel curvature cap');

// Ackermann signs: FR is inner for positive local-X steer; FL is inner for
// negative steer. Rear wheels never receive steer.
const ack = new Vehicle({ id: 'ackermann-regression', spec: 'gt' });
const positiveFL = ack.ackermannSteer(0.24, ack.wheels[0].x);
const positiveFR = ack.ackermannSteer(0.24, ack.wheels[1].x);
const negativeFL = ack.ackermannSteer(-0.24, ack.wheels[0].x);
const negativeFR = ack.ackermannSteer(-0.24, ack.wheels[1].x);
assert.ok(positiveFR > positiveFL, 'positive steer must give FR the larger inner angle');
assert.ok(Math.abs(negativeFL) > Math.abs(negativeFR), 'negative steer must give FL the larger inner angle');
ack.place(0, 0, 0, ack.rideHeight);
ack.velocity.z = 18;
for (const wheel of ack.wheels) wheel.omega = ack.velocity.z / ack.wheelRadius;
ack.controls = { throttle: 0, brake: 0, steer: 0.24, handbrake: 0 };
ack.step(DT, flatTrack, true);
assert.equal(ack.wheels[2].steer, 0, 'RL must remain straight');
assert.equal(ack.wheels[3].steer, 0, 'RR must remain straight');

// A stationary car can acquire steering state without changing yaw. Once
// tyre forces integrate at speed, yaw changes with the force-generated sign.
const forceVehicle = new Vehicle({ id: 'force-yaw-regression', spec: 'gt', player: true });
forceVehicle.place(0, 0, 0, forceVehicle.rideHeight);
forceVehicle.controls = { throttle: 0, brake: 0, steer: 0.24, handbrake: 0 };
forceVehicle.step(DT, flatTrack, true);
assert.ok(Math.abs(forceVehicle.yaw) < 1e-6, 'steering input alone must not directly set yaw');
forceVehicle.velocity.z = 22;
for (const wheel of forceVehicle.wheels) wheel.omega = forceVehicle.velocity.z / forceVehicle.wheelRadius;
forceVehicle.step(DT, flatTrack, true);
assert.ok(forceVehicle.yaw > 0, 'positive steering must produce positive yaw after tire-force integration');

// Visual contract: the road root follows elevation/bank/grade while the
// sprung chassis rotates around its explicit low pivot and wheels stay unsprung.
const visualVehicle = new Vehicle({ id: 'visual-regression', spec: 'gt', player: true });
visualVehicle.place(0, 0, 0, visualVehicle.spec.aero.designRideHeight + 0.006);
visualVehicle.roadBank = 0.12;
visualVehicle.roadGrade = 0.06;
visualVehicle.roll = 0.035;
visualVehicle.pitch = -0.025;
const visual = new CarVisual(visualVehicle);
visual.update(0);
assert.ok(Math.abs(visual.group.position.y - 0.04) < 1e-9, 'zero-heave root must preserve the flat-track datum');
assert.ok(Math.abs(visual.group.rotation.x + 0.06) < 1e-9, 'road grade must align the unsprung root');
assert.ok(Math.abs(visual.group.rotation.z + 0.12) < 1e-9, 'road bank must align the unsprung root');
assert.ok(Math.abs(visual.chassisPivot.rotation.x + 0.025) < 1e-9, 'pitch must apply at the chassis pivot');
assert.ok(Math.abs(visual.chassisPivot.rotation.z - 0.035) < 1e-9, 'roll must apply at the chassis pivot');
assert.equal(visual.fallbackWheels[0].pivot.parent, visual.group, 'wheel must remain on road-pose root');
visualVehicle.position.y = 3 + visualVehicle.spec.aero.designRideHeight + 0.006;
visual.update(0);
assert.ok(Math.abs(visual.group.position.y - 3.04) < 1e-9, 'visual root must follow elevated vehicle datum');

console.log('Steering dynamics regression passed: curvature cap, Ackermann, force-generated yaw, sprung pivot, and road pose.');
