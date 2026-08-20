import * as THREE from 'three';
import { buildScene } from '../gfx/scene.js';
import { buildCarMesh } from '../gfx/carMesh.js';
import { createCar, stepCar } from '../physics/car.js';
import { getSetup } from '../physics/setups.js';
import { buildTrack } from '../track/trackBuilder.js';
import alpineDef from '../track/defs/alpine.js';
import { createCameraRig, updateCameraRig, addShake } from '../cameras/cameraRig.js';
import { createInput } from '../core/input.js';
import { createAiDriver, updateAiDriver } from '../ai/aiDriver.js';
import { createRace, updateRace } from '../race/raceManager.js';
import { createSound } from '../audio/sound.js';
import { buildEnvironment } from '../gfx/environment.js';
import { createEffects } from '../gfx/effects.js';
import { state } from './state.js';

export const PHYS_DT = 1 / 240;

export function createGame(canvas) {
  const gfx = buildScene(canvas);
  const { scene, camera, renderer } = gfx;

  // Track + environment
  const track = buildTrack(alpineDef);
  scene.add(track.mesh);
  const env = buildEnvironment(track, scene);
  state.track = track;

  // Cars: player + a few AI placeholders
  const cars = [];
  const player = createCar(getSetup('gt3'), { isPlayer: true, name: 'You', colorHex: 0xe10600 });
  cars.push(player);
  const aiColors = [0x2f6feb, 0x2ea043, 0xf5a623, 0x9b59d0, 0x12b5cb];
  for (let i = 0; i < 5; i++) {
    const ai = createCar(getSetup('gt3'), { isPlayer: false, name: `AI ${i + 1}`, colorHex: aiColors[i % aiColors.length] });
    cars.push(ai);
  }
  state.cars = cars;
  state.player = player;

  // Place on grid along the start line
  placeGrid(cars, track);

  // Meshes
  const meshes = new Map();
  for (const c of cars) {
    const m = buildCarMesh(c);
    scene.add(m.group);
    meshes.set(c.id, m);
  }

  const rig = createCameraRig(camera);
  const input = createInput();

  // AI drivers + race orchestration + sound + effects
  const drivers = new Map();
  for (const c of cars) if (!c.isPlayer) drivers.set(c.id, createAiDriver(c, track, 0.9 + Math.random() * 0.2));
  const race = createRace(track, cars, { totalLaps: 5 });
  state.race = race;
  const sound = createSound();
  const fx = createEffects(scene);

  // Sun follows player for stable shadows
  const sun = gfx.sun;

  const game = {
    scene, camera, renderer, track, cars, player, rig, input, meshes,
    _acc: 0,
    _last: performance.now(),

    reset() {
      placeGrid(cars, track);
      for (const c of cars) { c.vx = c.vy = c.yawRate = 0; c.vel.set(0, 0, 0); c.gear = 1; c.damage = 0; }
      state.mode = 'countdown';
      state.countdown = 3.5;
    },

    update(dt) {
      input.update(dt);
      const bi = input.state.buttons;
      if (bi.camera) cycleCamera();
      if (bi.reset) game.reset();
      if (bi.pause) state.mode = state.mode === 'paused' ? 'racing' : 'paused';

      if (state.mode === 'countdown') {
        state.countdown -= dt;
        if (state.countdown <= 0) state.mode = 'racing';
      }

      const driving = state.mode === 'racing';

      // Player control
      const pi = input.getDriverInput();
      if (driving) {
        player.input.throttle = pi.throttle;
        player.input.brake = pi.brake;
        player.input.steer = pi.steer;
        player.input.gearRequest = pi.gearRequest;
        if (bi.shiftUp) player.shiftUp?.();
        if (bi.shiftDown) player.shiftDown?.();
        if (bi.toggleTransmission) player.toggleTransmission?.();
        if (bi.toggleTC) player.toggleTC?.();
        if (bi.toggleABS) player.toggleABS?.();
      } else {
        player.input.throttle = 0;
        player.input.brake = 1;
        player.input.steer = 0;
        player.input.gearRequest = 0;
      }

      // AI racecraft (P5)
      for (const c of cars) if (!c.isPlayer) updateAiDriver(drivers.get(c.id), cars, dt, driving);

      // Race orchestration (P6)
      updateRace(race, dt);

      // Environment props update (wind turbines, flags)
      if (env && env.update) env.update(dt);

      // Fixed-step physics
      this._acc += dt;
      let steps = 0;
      while (this._acc >= PHYS_DT && steps < 12) {
        for (const c of cars) stepCar(c, track, PHYS_DT);
        this._acc -= PHYS_DT;
        steps++;
      }

      // Wall-hit shake
      if (player.wallHit > 0.15) addShake(rig, player.wallHit * 0.5);

      // Effects (P10)
      fx.update(cars, dt);

      // Camera
      updateCameraRig(rig, player, dt, state.cameraMode);

      // Sound (P7)
      sound.update(player, camera, dt);

      // Sun follows player
      sun.position.set(player.pos.x + 120, 160, player.pos.z + 80);
      sun.target.position.copy(player.pos);
      sun.target.updateMatrixWorld();

      // Meshes
      for (const c of cars) meshes.get(c.id).update(c, dt);

      state.time += dt;
    },

    render() {
      renderer.render(scene, camera);
    },

    dispose() {
      input.dispose?.();
      sound.dispose?.();
      env.dispose?.();
      renderer.dispose?.();
    },
  };

  function cycleCamera() {
    const order = ['chase', 'cockpit', 'hood'];
    const i = order.indexOf(state.cameraMode);
    state.cameraMode = order[(i + 1) % order.length];
  }

  state.mode = 'countdown';
  state.countdown = 3.5;
  return game;
}

function placeGrid(cars, track) {
  const startS = track.startS;
  cars.forEach((c, i) => {
    const back = 8 + i * 7;
    const lateral = (i % 2 === 0 ? -1 : 1) * 2.2;
    const s = startS - back;
    const sm = track.sampleAt(s);
    c.pos.set(
      sm.pos.x + sm.left.x * lateral,
      sm.pos.y,
      sm.pos.z + sm.left.y * lateral
    );
    c.heading = Math.atan2(-sm.dir.y, sm.dir.x); // forward along track dir
    c.vel.set(0, 0, 0);
    c.vx = c.vy = c.yawRate = 0;
    c.gear = 1;
    c._steer = 0;
  });
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
