import * as THREE from 'three';
import { buildScene } from '../gfx/scene.js';
import { buildCarMesh } from '../gfx/carMesh.js';
import { createCar, stepCar, collideCars } from '../physics/car.js';
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
import { createDebugVisualizer } from '../gfx/debugVisualizer.js';
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
  const debugVisualizer = createDebugVisualizer(scene, track, cars);

  // Initialize spectator state
  state.spectating = false;
  state.spectateIndex = 0;
  state.spectatedCar = player;
  state.spectatedDriver = null;

  // Sun follows active focus car for stable shadows
  const sun = gfx.sun;

  const game = {
    scene, camera, renderer, track, cars, player, rig, input, meshes, debugVisualizer, drivers,
    _acc: 0,
    _last: performance.now(),

    spectateCar(indexOrId) {
      if (typeof indexOrId === 'number') {
        const idx = Math.max(0, Math.min(indexOrId, cars.length - 1));
        state.spectateIndex = idx;
        state.spectatedCar = cars[idx] || player;
        state.spectating = (state.spectatedCar !== player);
      } else if (typeof indexOrId === 'string') {
        const foundIdx = cars.findIndex((c) => c.id === indexOrId);
        if (foundIdx >= 0) {
          state.spectateIndex = foundIdx;
          state.spectatedCar = cars[foundIdx];
          state.spectating = (state.spectatedCar !== player);
        }
      }
      state.spectatedDriver = drivers.get(state.spectatedCar?.id) || null;
      window.dispatchEvent(new CustomEvent('apex:spectate-changed', { detail: { car: state.spectatedCar, index: state.spectateIndex } }));
    },

    spectateNextCar() {
      const nextIdx = (state.spectateIndex + 1) % cars.length;
      game.spectateCar(nextIdx);
    },

    spectatePrevCar() {
      const prevIdx = (state.spectateIndex - 1 + cars.length) % cars.length;
      game.spectateCar(prevIdx);
    },

    returnToPlayer() {
      game.spectateCar(0);
    },

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
      if (bi.toggleDebug) window.dispatchEvent(new CustomEvent('apex:toggle-debug'));

      // Handle Spectator AI cycling
      if (bi.spectateNext) game.spectateNextCar();
      if (bi.spectatePrev) game.spectatePrevCar();
      if (bi.spectatePlayer) game.returnToPlayer();
      if (bi.spectateCarIndex >= 0) game.spectateCar(bi.spectateCarIndex);

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
        collideCars(cars, PHYS_DT);
        this._acc -= PHYS_DT;
        steps++;
      }

      // Active camera / audio focus car (Player or Spectated AI)
      const focusCar = (state.spectating && state.spectatedCar) ? state.spectatedCar : player;
      state.spectatedCar = focusCar;
      state.spectatedDriver = drivers.get(focusCar.id) || null;

      // Wall-hit shake for focused car
      if (focusCar.wallHit > 0.15) addShake(rig, focusCar.wallHit * 0.5);

      // Effects (P10)
      fx.update(cars, dt);

      // 3D Debug Visualizer update
      if (debugVisualizer && debugVisualizer.update) {
        debugVisualizer.update(dt, state);
      }

      // Camera follows focused car
      updateCameraRig(rig, focusCar, dt, state.cameraMode);

      // Sound follows focused car
      sound.update(focusCar, camera, dt);

      // Sun follows focused car
      sun.position.set(focusCar.pos.x + 120, 160, focusCar.pos.z + 80);
      sun.target.position.copy(focusCar.pos);
      sun.target.updateMatrixWorld();

      // Meshes
      for (const c of cars) meshes.get(c.id).update(c, dt);

      state.time += dt;
    },

    render() {
      renderer.render(scene, camera);
    },

    dispose() {
      window.removeEventListener('apex:spectate-car', onSpectateCar);
      window.removeEventListener('apex:spectate-next', onSpectateNext);
      window.removeEventListener('apex:spectate-prev', onSpectatePrev);
      window.removeEventListener('apex:spectate-player', onSpectatePlayer);

      input.dispose?.();
      sound.dispose?.();
      env.dispose?.();
      debugVisualizer.dispose?.();
      fx.dispose?.();
      for (const m of meshes.values()) m.dispose?.();
      renderer.dispose?.();
    },
  };

  const onSpectateCar = (e) => game.spectateCar(e.detail?.index ?? e.detail?.id ?? 0);
  const onSpectateNext = () => game.spectateNextCar();
  const onSpectatePrev = () => game.spectatePrevCar();
  const onSpectatePlayer = () => game.returnToPlayer();

  window.addEventListener('apex:spectate-car', onSpectateCar);
  window.addEventListener('apex:spectate-next', onSpectateNext);
  window.addEventListener('apex:spectate-prev', onSpectatePrev);
  window.addEventListener('apex:spectate-player', onSpectatePlayer);

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
