# APEX — Architecture & Module Contracts

Single source of truth for every builder/critic agent. Respect module boundaries. Do NOT
edit files outside your assigned piece unless you are the integration agent. Import across
pieces ONLY through the contracts below.

## Runtime model
- ES modules, Three.js r170, bundled by Vite. No other runtime deps without approval.
- Fixed-timestep physics: `PHYS_DT = 1/240`. Render loop accumulates real time and steps
  physics N times per frame; rendering interpolates. See `src/main.js`.
- One shared mutable simulation state object lives in `src/game/state.js` (`export const state`).
  Physics writes it, everything else reads it. Do not create parallel state.
- Units: metres, seconds, kilograms, radians. Speed shown to user in km/h.

## Coordinate frame
- World: +X right, +Y up, +Z toward viewer (Three.js default). Track lies mostly on X/Z plane.
- Car body frame: +X forward, +Y left, +Z up is NOT used; we use heading (yaw) about world Y.
  In body frame math: forward = +x, lateral left = +y.

## Core data shapes

### CarState (one per car, player + AI)
```js
{
  id, isPlayer, name, colorHex,
  // pose (written by physics)
  pos: THREE.Vector3,       // world position of CG projected on ground
  heading: number,          // yaw rad, 0 = +X, CCW positive
  pitch: number, roll: number,   // visual body attitude (rad), from suspension
  vel: THREE.Vector3,       // world velocity
  vx: number, vy: number,   // body-frame forward / lateral velocity
  yawRate: number,          // rad/s
  speed: number,            // m/s (|vel|)
  // per wheel [FL, FR, RL, RR]
  wheels: [ { load, slipAngle, slipRatio, suspDefl, spin, onTrack, grip } x4 ],
  // powertrain / driver intent (written by controller, read by physics)
  input: { throttle, brake, steer, clutch, gearRequest },  // all 0..1 except steer -1..1, gear int
  rpm, gear, speedKph,
  // race state (written by race orchestrator)
  lap, progressS, lastLap, bestLap, totalTime, finished, place,
  damage, surface: 'track'|'curb'|'grass'|'gravel',
}
```

### Track
```js
{
  name, length,                       // metres
  samples: [ { s, pos:V3, dir:V2, width, grip, camber } ],  // dense centreline, s = arc length
  mesh: THREE.Group,                  // road+curbs+grass+walls+props, added to scene
  startS,                             // arc-length of start/finish line
  nearest(pos) -> { idx, s, lateral, dist, surface, grip },  // lateral signed (+left)
  sampleAt(s) -> { pos, dir, width }, // wrap-safe
  heightAt(x, z) -> y,
  walls: [ {a:V3, b:V3} ],            // collision segments
}
```

## Contracts (function signatures)

### P1 physics — `src/physics/*`
```js
createCar(setup, opts) -> CarState
stepCar(car, track, dt)            // reads car.input, integrates one fixed step
```
`setup` is a plain object of tuneable constants (mass, cg height, wheelbase, track width,
gear ratios, aero, tire mu, brake torque...). One setup per car class in `src/physics/setups.js`.

### P2 track — `src/track/*`
```js
buildTrack(def) -> Track           // def from src/track/defs/<name>.js
```
Track defs are arrays of control points `{x, z, w?, camber?}`; builder smooths to a dense
centreline and generates geometry. `nearest()` must be O(1)-ish via spatial index.

### P3 input — `src/core/input.js`
```js
createInput() -> { update(dt), getDriverInput() -> {throttle,brake,steer,clutch,gearRequest,buttons} }
```
Smooths raw device input into stable actuator targets (rate limits, steering speed by rpm).

### P4 cameras — `src/cameras/cameraRig.js`
```js
createCameraRig(camera) -> rig
updateCameraRig(rig, car, dt, mode)   // mode: 'chase'|'cockpit'|'hood'|'tv'
```

### P5 AI — `src/ai/*`
```js
createAiDriver(car, track, skill) -> AiDriver
updateAiDriver(driver, cars, dt) -> fills car.input
computeRacingLine(track) -> { samples:[{s, lateral, targetSpeed}] }
```

### P6 race — `src/race/raceManager.js`
```js
createRace(track, cars, opts) -> race
updateRace(race, dt)    // laps, positions, timing, start/finish
```

### P7 sound — `src/audio/sound.js`
```js
createSound() -> sound
sound.update(car, camera, dt)   // engine/tire/wind from telemetry
```

### P8/P9/P10 graphics — `src/gfx/*`
```js
buildScene(canvas) -> { scene, camera, renderer, resize() }
buildCarMesh(car) -> { group, update(car, dt) }     // wheels, suspension, body motion
buildEnvironment(track, scene) -> env
createEffects(scene) -> fx;  fx.update(cars, dt)    // smoke, skids, sparks
```

### P11 UI — `src/ui/*`
```js
createHud(el) -> hud;  hud.update(state)
createMenus(el, game) -> menus
```

### Game orchestration — `src/game/game.js`
Owns the state machine (menu → loading → countdown → racing → results), creates track/cars,
calls physics/AI/race/sound/fx/hud each step. Only `game.js` and `main.js` wire pieces together.

## Quality bar
Compare against iRacing, not against "good for a browser game". Physics must reward smoothness
and punish overdriving; AI must brake at real points and race wheel-to-wheel cleanly; cameras
must have correct speed sense and lag; the whole thing must feel like ONE coherent product.
