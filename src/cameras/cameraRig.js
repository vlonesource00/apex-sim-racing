import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, lambda, dt) => THREE.MathUtils.damp(a, b, lambda, dt);

export function createCameraRig(camera) {
  const rig = {
    camera,
    mode: 'chase',
    _pos: new THREE.Vector3(0, 3, -8),
    _look: new THREE.Vector3(),
    _fov: 70,
    _shake: 0,
  };
  return rig;
}

const forwardOf = (heading, out) => out.set(Math.cos(heading), 0, -Math.sin(heading));
const leftOf = (heading, out) => out.set(-Math.sin(heading), 0, -Math.cos(heading));

const _f = new THREE.Vector3();
const _l = new THREE.Vector3();
const _target = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

export function updateCameraRig(rig, car, dt, mode) {
  if (mode) rig.mode = mode;
  const cam = rig.camera;
  const speed = car.speed;

  if (rig.mode === 'cockpit' || rig.mode === 'hood') {
    updateCockpit(rig, car, dt);
    return;
  }

  // ---- Chase ----
  forwardOf(car.heading, _f);
  leftOf(car.heading, _l);

  const dist = 6.2 + speed * 0.055;         // pulls back with speed
  const height = 2.1 + speed * 0.012;
  // Desired camera position behind the car
  _target.copy(car.pos)
    .addScaledVector(_f, -dist)
    .addScaledVector(_l, car.yawRate * -0.6) // swing out slightly in corners
    .add(new THREE.Vector3(0, height, 0));

  // Keep camera above ground
  const groundY = car.pos.y;
  if (_target.y < groundY + 0.6) _target.y = groundY + 0.6;

  // Speed-dependent lag: tighter at low speed, more float at high speed
  const lag = clamp(6.5 - speed * 0.05, 2.2, 6.5);
  rig._pos.x = damp(rig._pos.x, _target.x, lag, dt);
  rig._pos.y = damp(rig._pos.y, _target.y, lag * 1.4, dt);
  rig._pos.z = damp(rig._pos.z, _target.z, lag, dt);

  // Look ahead of the car
  const lookAhead = 4 + speed * 0.12;
  _lookTarget.copy(car.pos).addScaledVector(_f, lookAhead).add(new THREE.Vector3(0, 1.0, 0));
  rig._look.x = damp(rig._look.x, _lookTarget.x, 8, dt);
  rig._look.y = damp(rig._look.y, _lookTarget.y, 8, dt);
  rig._look.z = damp(rig._look.z, _lookTarget.z, 8, dt);

  cam.position.copy(rig._pos);
  cam.lookAt(rig._look);

  // FOV grows with speed for speed sense
  const targetFov = 62 + clamp(speed * 0.28, 0, 26) + rig._shake * 4;
  rig._fov = damp(rig._fov, targetFov, 4, dt);
  if (Math.abs(cam.fov - rig._fov) > 0.01) { cam.fov = rig._fov; cam.updateProjectionMatrix(); }

  rig._shake = Math.max(0, rig._shake - dt * 2);
}

function updateCockpit(rig, car, dt) {
  const cam = rig.camera;
  forwardOf(car.heading, _f);
  leftOf(car.heading, _l);
  const isHood = rig.mode === 'hood';
  const fwdOff = isHood ? 1.9 : 0.35;
  const height = isHood ? 1.02 : 1.12;

  _target.copy(car.pos)
    .addScaledVector(_f, fwdOff)
    .add(new THREE.Vector3(0, height, 0));

  // Subtle head lag (more in cockpit than hood)
  const lag = isHood ? 30 : 14;
  rig._pos.x = damp(rig._pos.x, _target.x, lag, dt);
  rig._pos.y = damp(rig._pos.y, _target.y, lag, dt);
  rig._pos.z = damp(rig._pos.z, _target.z, lag, dt);

  // Look direction: car heading + a hint of yaw rate (eyes lead the corner)
  const lookDist = 30;
  _lookTarget.copy(rig._pos)
    .addScaledVector(_f, lookDist)
    .addScaledVector(_l, clamp(car.yawRate * 2.2, -3, 3));

  cam.position.copy(rig._pos);
  cam.lookAt(_lookTarget);

  // Body roll/pitch translates into camera tilt for immersion
  cam.rotation.z += car.roll * (isHood ? 0.5 : 0.9);
  cam.rotation.x += car.pitch * (isHood ? 0.4 : 0.7);

  const targetFov = isHood ? 70 : 74;
  rig._fov = damp(rig._fov, targetFov, 4, dt);
  if (Math.abs(cam.fov - rig._fov) > 0.01) { cam.fov = rig._fov; cam.updateProjectionMatrix(); }
}

export function addShake(rig, amount) {
  rig._shake = Math.min(1, rig._shake + amount);
}
