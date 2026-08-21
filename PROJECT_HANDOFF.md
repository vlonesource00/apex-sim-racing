# APEX Sim Racing — Project Handoff & Vision Roadmap

**Project Name**: APEX Sim Racing  
**Current State**: Full Visual Revamp, Living 3D Scenery, Procedural GT3 Physics, Multi-Archetype Racecraft AI, 3D/2D Diagnostic Suite, and Real-Time Spectate AI Debug Engine.  
**Active Branch**: [`feat/visual-revamp-hud-ai`](https://github.com/vlonesource00/apex-sim-racing/tree/feat/visual-revamp-hud-ai)  
**Live Development Port**: [http://localhost:5199/](http://localhost:5199/)  
**Primary Engine**: Three.js r170, Vite 5, Web Audio API, Headless Node.js Physics/AI Benchmark Harness.

---

## 1. Executive Summary & Vision

APEX Sim Racing is an authentic, high-performance motorsport racing simulation built entirely for modern web browsers. It merges the physical fidelity and chassis dynamics of desktop simulators (Pacejka combined slip tire model, dynamic weight transfer, soft composite collision impulses, sequential manual transmission with rev-matching, switchable TC/ABS) with 60+ FPS Three.js rendering, living alpine trackside scenery, diverse multi-personality AI opponents, comprehensive telemetry, and in-depth AI debugging and spectating tools.

---

## 2. Implemented Features & Core Systems

### 🏎️ Vehicle Dynamics & Drivetrain (`src/physics/`)
* **Pacejka 'Magic Formula' Combined Slip**: 4-wheel independent tire contact model calculating longitudinal grip ($F_x$), lateral cornering grip ($F_y$), load sensitivity, pneumatic trail aligning torque, and friction circle limits.
* **Chassis & Weight Transfer**: 240Hz fixed-step integration (`PHYS_DT = 1/240`) modeling sprung mass inertia, longitudinal acceleration squat/dive, lateral cornering roll, anti-roll bar roll stiffness distribution (`rollSplit: 0.52`), and brake bias (`brakeBias: 0.57`).
* **Sequential Transmission & Manual Mode**: 6 forward gears, Neutral (0), and Reverse (-1) with realistic mechanical gear ratios and final drive. Supports automatic shifting and sequential manual mode (`E`/`Shift` up, `Q`/`Ctrl` down) with authentic throttle blip rev-matching on downshifts.
* **Driver Assists**: Switchable multi-level Traction Control (`TC`) and Anti-Lock Braking System (`ABS`) with slip-ratio intervention.
* **Multi-Body Collision Dynamics**: Dual-circle bounding volume collision detection, soft composite body restitution ($e=0.08$), damped angular momentum transfer, and impact damage scaling.

### 🧠 AI Racecraft & Multi-Archetypes (`src/ai/`)
* **5 Distinct Driver Archetypes**:
  1. **Alex "Viper" Vance [VIPER]**: Aggressive divebomber, late braker, high draft aggression.
  2. **Marco "The Surgeon" Rossi [SURGEON]**: Precision apex clipping, clean overtakes, high corner carry speed.
  3. **Viktor "The Wall" Steiner [WALL]**: Inside line defensive blocker, wide track presence.
  4. **Elena "Rocket" Rostova [ROCKET]**: Daring straight-line slingshot attacker, deep trail-braker.
  5. **Lucas "Rookie" Silva [ROOKIE]**: Variable braking points, yields room under pressure.
* **Dynamic Slipstream & Passing Corridor**: Trailing cars catch high-speed draft tow ($+8\%$ speed boost), pull out into the clear passing corridor ($\pm 1.5\text{m}$ lateral offset), and out-accelerate defenders on straights.
* **Inside Defensive Covering**: Leading cars detect closing opponents and position themselves on the inside apex line to protect position into braking zones.
* **Corner Entry Speed Pacing & 2-Wide Clearance**: Trailing cars pace cleanly behind lead cars ($3-5\text{m}$ following distance); side-by-side cars share track width without clipping.
* **Automated Off-Track Recovery Controller**: AI cars pushed off-line steer downstream onto the asphalt (`track.sampleAt(progressS + 18)`), apply modulated tractive throttle ($0.52$), and immediately resume 100% racing pace upon rejoining.
* **Reinforcement Learning Pipeline**: Pure JS neural policy evaluator (`src/ai/nnPolicy.js`) with headless training harness (`tools/train_ai.mjs`).

### 🏔️ Living Alpine Track & World Scenery (`src/track/`, `src/gfx/`)
* **Alpine Ring Circuit**: 2.5 km club circuit featuring high-speed pit straight, heavy braking hairpin, sweeping esses, and flowing back sections with terrain-conforming elevations.
* **Trackside Infrastructure**: Pit lane complex with concrete pit wall, catch fencing, team pit boxes with overhead air gantries, tire stacks, and safety car.
* **Dynamic Props**: 6 animated spinning wind turbines on alpine ridges, 3D distance braking marker boards (200m, 150m, 100m, 50m), marshal flag posts, and branded motorsport sponsor hoardings along Armco barriers.

### 📊 MoTeC HUD, Audio & Visual FX (`src/ui/`, `src/audio/`, `src/gfx/`)
* **MoTeC Digital Dash**: Live speedometer, gear indicator, 15-LED multi-color RPM shift lights, real-time throttle and brake pedal input bars, and TC/ABS assist status pills.
* **Timing & Deltas**: Live lap timer, best lap, last lap, sector delta, and interactive circuit minimap with car markers and heading arrows.
* **Proximity Spotter Radar**: Left, right, and rear radar chevrons with real-time distance readouts ($< 6.5\text{m}$) to alert the driver of side-by-side traffic.
* **Procedural Web Audio Engine**: Synthesized GT3 Flat-6/V8 engine roar, randomized exhaust pops/backfires on downshifts and throttle lift-off, dynamic tire squeal mapped to slip angle, and low-frequency curb rumble.
* **Visual Effects**: Tire smoke on lockups/wheelspin, asphalt skid marks, and titanium chassis spark particles on bottoming out.

### 🔬 3D Visualizer, Fleet Inspector & Spectate AI Debug Engine
* **3D Visual Debug Visualizer (`src/gfx/debugVisualizer.js`)**: Real-time 3D racing line ribbon (Green = accel, Yellow = apex, Red = braking), dynamic lookahead target rays, glowing target spheres, 3D tire force vectors ($F_x$ red, $F_y$ blue), wireframe slipstream drafting cones, and 3D floating driver billboard tags.
* **2D Live Fleet Inspector (`src/ui/debugPanel.js`)**: Real-time telemetry table monitoring all 6 cars on track (position, driver badge, state, speed vs target, throttle/brake/steer gauges, rear slip ratio, slip angle, lap/progress).
* **Spectate AI Debug Mode**: Ability to dynamically mount the camera onto ANY AI driver on track, view the race from their cockpit view (<kbd>C</kbd>), observe their live MoTeC pedal inputs and decision-making, and cycle across the grid.

---

## 3. Complete Controls & Shortcuts Map

| Action | Keyboard | Gamepad | UI / Mouse |
| :--- | :--- | :--- | :--- |
| **Throttle / Accelerate** | <kbd>W</kbd> / <kbd>ArrowUp</kbd> | Right Trigger (RT) | — |
| **Brake / Reverse** | <kbd>S</kbd> / <kbd>ArrowDown</kbd> | Left Trigger (LT) | — |
| **Steer Left / Right** | <kbd>A</kbd> / <kbd>D</kbd> or <kbd>←</kbd> / <kbd>→</kbd> | Left Analog Stick | — |
| **Sequential Shift Up** | <kbd>E</kbd> / <kbd>Shift</kbd> | Right Bumper (RB) | — |
| **Sequential Shift Down** | <kbd>Q</kbd> / <kbd>Ctrl</kbd> | Left Bumper (LB) | — |
| **Transmission Mode (Auto/Manual)** | <kbd>T</kbd> | — | Click `[AUTO/MAN]` on HUD |
| **Traction Control Toggle** | <kbd>F</kbd> | — | Click `[TC]` on HUD |
| **ABS Toggle** | <kbd>B</kbd> | — | Click `[ABS]` on HUD |
| **Cycle Camera View** | <kbd>C</kbd> | Button A (Cross) | Click Camera Tag on HUD |
| **Toggle Fleet Inspector & 3D Debug** | <kbd>U</kbd> or <kbd>\`</kbd> | — | Click `[DEBUG]` button on top HUD |
| **Spectate Next AI Car** | <kbd>Tab</kbd> or <kbd>]</kbd> | D-Pad Right | Click `[NEXT ▶]` in Spectate bar |
| **Spectate Previous AI Car** | <kbd>Shift + Tab</kbd> or <kbd>[</kbd> | D-Pad Left | Click `[◀ PREV]` in Spectate bar |
| **Direct Jump to Car 1–6** | <kbd>1</kbd> .. <kbd>6</kbd> | — | Click any driver row in Fleet Inspector |
| **Return to Player Car** | <kbd>0</kbd> or <kbd>ESC</kbd> | — | Click `[★ YOU]` / `[✕ RETURN]` |
| **Reset Car / Grid** | <kbd>R</kbd> | Button Y (Triangle) | — |
| **Pause Race** | <kbd>P</kbd> / <kbd>ESC</kbd> | Start Button | — |

---

## 4. Codebase Architecture & File Map

```
apex-sim-racing/
├── src/
│   ├── ai/
│   │   ├── aiDriver.js          # Multi-archetype racecraft, passing corridors, recovery controller
│   │   ├── nnPolicy.js          # Pure JS neural policy evaluator
│   │   └── trainedWeights.json  # Exported neural network weights
│   ├── audio/
│   │   └── sound.js             # Procedural Web Audio (engine roar, exhaust pops, squeal, rumble)
│   ├── cameras/
│   │   └── cameraRig.js         # Smooth lag chase cam, cockpit view, hood view, camera shake
│   ├── core/
│   │   └── input.js             # Keyboard & gamepad input aggregator, shifting & spectate bindings
│   ├── game/
│   │   ├── game.js              # Central simulation loop, car lifecycle, spectator orchestrator
│   │   └── state.js             # Shared mutable simulation state (cars, player, spectate state)
│   ├── gfx/
│   │   ├── carMesh.js           # 3D car geometry, wheel spin/steer, brake disc glow, shadows
│   │   ├── debugVisualizer.js   # 3D racing line, lookahead rays, tire force arrows, halo rings, tags
│   │   ├── effects.js           # Particle systems: tire smoke, skidmarks, titanium spark trails
│   │   ├── environment.js       # Pit lane, team pit boxes, wind turbines, brake boards, hoardings
│   │   └── scene.js             # Three.js WebGLRenderer, directional sun, HDR sky gradient, fog
│   ├── physics/
│   │   ├── car.js               # 240Hz physics engine, drivetrain, auto/manual gearboxes, collisions
│   │   ├── setups.js            # Vehicle parameters (GT3, diff lock, roll split, brake bias)
│   │   └── tires.js             # Pacejka Magic Formula, surface friction, aligning torque
│   ├── race/
│   │   └── raceManager.js       # Lap timing, standings, driver roster, position tracking
│   ├── track/
│   │   ├── defs/alpine.js       # Alpine Ring track spline definitions and elevations
│   │   └── trackBuilder.js      # Catmull-Rom closed ribbon generator, spatial hash nearest()
│   ├── ui/
│   │   ├── debugPanel.css       # Fleet inspector & spectator bar stylesheet
│   │   ├── debugPanel.js        # 2D live telemetry inspector table & spectator switcher
│   │   ├── hud.css              # MoTeC digital dash, spotter radar, spectate banner styling
│   │   └── hud.js               # HUD controller, shift LEDs, minimap renderer
│   └── main.js                  # Application entry point, RAF loop, fixed physics accumulator
├── tools/
│   ├── aitest-p5.mjs            # Headless 3-lap AI physics & track limits benchmark
│   ├── pack-test.mjs            # 60s/120s multi-car pack race simulation benchmark
│   ├── screenshot.mjs           # Automated Puppeteer screenshot suite
│   ├── telemetry.mjs            # 0-100 acceleration, top speed, and skidpad telemetry tester
│   └── train_ai.mjs             # Headless Reinforcement Learning policy trainer (PPO/SAC)
├── ARCHITECTURE.md              # Core module contracts & coordinate frame specifications
├── PROGRESS.md                  # Development piece board & wave milestones
└── PROJECT_HANDOFF.md           # Master handoff document
```

---

## 5. Execution, Build & Test Commands

### 🚀 Running the Game
```bash
# Install dependencies
npm install

# Start Vite dev server on port 5199
npm run dev -- --port 5199
```

### 🧪 Automated Testing & Verification
```bash
# Run 3-lap AI benchmark (checks offtrack, slip angle, lap times)
node tools/aitest-p5.mjs

# Run full 6-car pack race simulation benchmark
node tools/pack-test.mjs

# Run physics & acceleration telemetry test
node tools/telemetry.mjs

# Capture full headless screenshot suite (10 views)
npm run shot

# Production build compilation
npm run build
```

---

## 6. Project Roadmap & Future Heading

### 🎯 Milestone 1: Dynamic Weather & Day/Night Lighting
- **Rain Shader & Wet Track Surfaces**: Implement dynamic puddles, wet asphalt reflections with roughness maps, and spray particle plumes behind cars.
- **Wet Tire Compounds**: Implement intermediate and full-wet tire compounds in `src/physics/tires.js` with altered $F_z$ load sensitivity and hydroplaning thresholds.
- **Day/Night Cycle**: Animated sun position, sunset orange ambient transitions, dusk lighting, and functional 3D LED headlights with shadow casting for night racing.

### 🎯 Milestone 2: Multi-Circuit Roster & Track Selector
- **Monza Autodromo**: Low-downforce high-speed temple with heavy chicane braking zones.
- **Suzuka International**: Technical high-speed esses, Degner curves, and 130R flat-out kink.
- **Circuit de Spa-Francorchamps**: Radical elevation change through Eau Rouge/Raidillon and Kemmel Straight.
- **UI Circuit Selection Modal**: Interactive track selection screen with track previews and difficulty ratings.

### 🎯 Milestone 3: Multiple Car Classes & Setup Tuning Garage
- **LMP1 / Hypercar Class**: 1000+ hp hybrid all-wheel-drive with intense downforce and active energy recovery.
- **Formula Open-Wheel Class**: Ultra-lightweight 600kg single-seater with extreme lateral $g$-limits ($> 3.5g$).
- **Interactive Garage / Setup Screen**: In-game tuning sliders for front/rear spring stiffness, damper bump/rebound, anti-roll bar stiffness, brake bias, tire pressures, and aerodynamic wing angles.

### 🎯 Milestone 4: Multiplayer Netcode (WebRTC / Rollback)
- **Peer-to-Peer WebRTC DataChannels**: Ultra-low latency state synchronization between browser clients.
- **Client-Side Prediction & Hermite Interpolation**: Smooth out latency jitter with local vehicle prediction and server/host authority reconciliation.

### 🎯 Milestone 5: WebXR Virtual Reality & Head Tracking
- **Immersive VR Cockpit Mode**: Support WebXR headsets (Meta Quest, Valve Index, Apple Vision Pro) with 6-DOF head tracking.
- **Interactive VR Mirrors**: Real-time render-target rearview and side mirrors.

### 🎯 Milestone 6: Scaled Reinforcement Learning Checkpoints
- Train 10,000+ episode PPO neural network policies using `tools/train_ai.mjs` to master complex tracks with superhuman trail-braking and tire slip optimization.

---

## 7. Key Engineering Invariants & Nuances

1. **240Hz Physics vs 60Hz Rendering**:
   - `src/main.js` accumulates delta time and steps `stepCar()` in fixed `1/240s` slices. Rendering smoothly interpolates car position and orientation.
2. **Zero Allocation in 240Hz Loop**:
   - All vector calculations, collision bounding tests, and tire force math use pre-allocated scratch objects (`_scratchTarget`, `_scratchContact`, `_scratchFwd`, etc.) to prevent V8 garbage collection pauses.
3. **Collision Restitution Calibration ($e=0.08$)**:
   - High restitution ($e > 0.3$) causes cars to bounce like pinballs; calibrated composite composite body restitution ($e=0.08$) with soft normal de-penetration creates realistic GT3 door-to-door bumping without instability.
4. **Straight-Line Overtaking Guard**:
   - Overtaking lane splits ($\pm 1.5\text{m}$) are strictly gated to straights (`!isUpcomingCorner` and low curvature). In corners, cars lock to the racing line and modulate speed according to physical grip limits ($a_{\text{lat}} \le 8.2\text{ m/s²}$).
5. **Drivetrain RPM Coupling**:
   - In gear, engine speed is strictly mechanically locked to drive wheel angular velocity ($\text{RPM} = \frac{\omega_{\text{wheel}} \cdot \text{ratio}_{\text{total}} \cdot 60}{2\pi}$), preventing engine rev runaway during braking while enabling crisp downshift blips.
