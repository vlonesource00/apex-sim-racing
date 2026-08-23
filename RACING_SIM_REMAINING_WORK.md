# Apex 73 Racing — Remaining Work

This is the living backlog for bringing the browser simulator closer to a coherent, believable prototype/GT3/touring racing simulator. It records what is already in the tree, what is still weak, and the evidence required before calling a subsystem finished.

**Baseline branch:** `main`
**Next-development branch:** `codex/human-reference-racecraft`
**Last audited:** 2026-08-23
**Current mode:** JavaScript deterministic controller with optional RL shadow/hybrid policy; JAX training tools exist but a new 4096-agent policy has not yet been validated in the browser.

## Current evidence

The deterministic racecraft foundation has been replaced and is now the authority beneath optional RL tactics.

- Controlled prototype-versus-touring pass: completes at 13.57 s, 3.67 s deliberate attack, 2.24 s at attack/full throttle, 0 contact/deep-overlap frames, 0 off-track seconds, and 5.486 m minimum separation.
- Slow/stopped-player bypass: stopped, crawling, and slow-driving cases all complete with 0 contact/deep-overlap frames, 0 off-track seconds, and no false drafting behind the stopped car.
- Mixed six-car, three-class field: every car finishes; 0 active-race contact frames, 0 deep overlaps, 0 maximum contact impact, 86.8–95.6% clean-straight full throttle, and prototype/GT/touring finish order remains correct. Two touring cars still briefly touch the coarse off-track boundary near the lap seam (0.23 s and 0.54 s), so edge tracking is improved but not yet signed off.
- Three-lap eight-AI flow around an idle player: 8/8 finish, no collision deadlocks, no continuous low-speed stalls, no off-track/recovery time, and 101.1 km/h median active speed.
- Legal defense contract: defender commits one 3.7 m move at a 19.95 m pre-overlap gap, never weaves, and records 0 contact/off-track frames.
- Trajectory planner contract: 24-point minimum-jerk path with the selected trajectory shared by steering, speed control, and debug rendering.
- A 20 Hz reference-lap recorder now exports player physics/inputs/tyres/ERS JSON with F7. A distance-indexed profile/report tool now computes lap delta, pace percentage, speed delta, throttle use, braking use, and tyre utilisation for human/AI comparisons before RL imitation or residual training.
- Hidden AI-only yaw/lateral forces remain removed; player and AI use the same vehicle physics.

The pass test is the minimum proof of intent, not proof that the whole field races well. Do not loosen safety gates just to make the racecraft count pass.

## P0 — AI racecraft and controller (highest priority)

### 1. Make committed attacks decisive

- [x] Replace the remaining “draft then wait” behaviour with a time-bounded attack state. A legal corridor now commits immediately; draft is only a blocked-corridor setup.
- [x] Keep the current full-body clearance gate, then release meaningful closing speed/full attack power once actual lateral body clearance exists.
- [ ] Give the attack state explicit phases: setup, lateral commitment, alongside, nose-ahead, clear, and return. Each phase needs entry/exit conditions and a timeout.
- [ ] Permit an aggressive inside dive only when entry speed, predicted lateral acceleration, braking distance, and road bounds are legal. “Aggressive” means late and decisive, not teleporting or steering through another car.
- [x] Add a switchback candidate and independently score the opposite corridor.
- [x] Add a failed-attack cooldown/target lock so the same completed target is not immediately attacked again.
- [ ] Measure attack latency, lateral commitment distance, closing speed, alongside time, successful pass rate, aborted pass rate, and contact rate per car/class.

### 2. Stop headbutts and lateral indecision

- [x] Use one selected trajectory as the authority for lateral target, steering preview, speed release, pass safety, and debug rendering.
- [x] Add swept-volume prediction for both cars' planned lateral motion and third-car blockers.
- [x] Reserve lanes before overlap; longitudinal priority and stateful return prevent mutual convergence.
- [x] Distinguish front/rear/side threats and use separate longitudinal responses.
- [ ] Add a “yield and retry” behaviour after an unsafe attempt. The attacker should lift or tuck behind, not oscillate between two lanes or continue into the opponent.
- [ ] Add contact-quality metrics to the race report: active contacts, deep overlaps, maximum impact, side-by-side duration, and contacts during a declared pass.

### 3. Make the planner capable of sharp, realistic trajectories

- [ ] Expand candidate generation beyond straight/one-radius curves: late-apex, early-apex, hairpin rotation, chicane transition, braking-to-apex, and exit unwind candidates.
- [x] Include heading, curvature, speed, and lateral-acceleration limits in candidate scoring; trajectory curvature now creates a class-specific, braking-distance-aware speed envelope instead of an arbitrary minimum corner speed.
- [ ] Use track width and corner entry/exit geometry when selecting an inside/outside lane. A lane that is legal at the current sample but closes at the apex must be rejected early.
- [ ] Add a trajectory cost for unnecessary steering reversals and excess tyre slip so the AI does not “drift” through tight corners.
- [ ] Add a candidate for staying behind when every pass candidate is unsafe; expose the reason (`NO_ROOM`, `THIRD_CAR`, `ROAD_EDGE`, `TTC`) in debug telemetry.
- [ ] Verify the selected trajectory is the one rendered in AI Planner debug mode at every update.

### 4. Increase race pace without making the cars invulnerable

- [x] Validate full-throttle feed-forward on clean straights for every class; the mixed run records 86.8–95.6% full throttle while still braking early enough for the actual future trajectory.
- [ ] Replace the single conservative corner pace scalar with class- and corner-dependent entry, apex, and exit targets.
- [ ] Allow trail braking into legal high-load corners while releasing brake pressure as steering builds; emergency collision braking remains the final authority.
- [x] Add the measurement foundation for prototype, GT3, and touring targets: F7 reference recording plus `npm run lap:report -- <baseline.json> [candidate.json]`; current deterministic mixed-field order is prototype, GT3, touring.
- [ ] Add a pace envelope per skill/aggression level so “aggressive” changes line choice and commitment more than it changes tyre-breaking physics.
- [ ] Record sector speed, minimum corner speed, throttle-at-apex, brake release point, and lap-time variance.

### 5. Recovery and off-track behaviour

- [ ] Fix the long touring-car recovery excursions shown in the mixed-field run.
- [ ] Separate spin recovery, grass/runoff recovery, and traffic queueing. They currently share too much state and can leave a car in recovery for too long.
- [ ] During recovery, choose a legal rejoin point with a clear lane and a heading aligned to the track; never rejoin across an occupied racing line.
- [ ] Keep physical steering and tyre forces active. Do not reintroduce hidden AI-only yaw torque or lateral teleport forces.
- [ ] Add a recovery timeout and marshal/tow event only after the car has genuinely stalled or cannot regain the road.
- [ ] Gate rejoin on a safe gap and publish `RECOVERING`, `REJOINING`, or `YIELDING` so the HUD explains why the car is slow.

### 6. Live multi-agent racecraft

- [ ] Add target selection using speed delta, class priority, tyre state, ERS state, position, and pit strategy rather than nearest car only.
- [x] Add defensive driving: one legal move before overlap, hold the chosen lane once overlap begins, no reactionary weaving, and release rather than block indefinitely.
- [ ] Add different personalities: clean/aggressive, late-braking, defensive, opportunistic, tyre-saving, and mistake-prone. Personality must change decisions, not collision tolerances.
- [ ] Add explicit traffic etiquette for multiclass racing: prototypes announce/prepare a pass, GT3/touring hold a predictable line, and lapped cars yield when a safe blue-flag opportunity exists.
- [ ] Add slipstream and split-stream behaviour: wake strength should change closing speed, and a car should be able to move out of the wake to keep momentum or create a pass.
- [ ] Add rubbering and line evolution so the preferred line changes grip over time and AI can choose a dirty but strategically useful alternate line.
- [ ] Add a live race event log for attack, defend, switchback, yield, contact avoidance, mistake, recovery, pit request, and ERS deployment.

## P0 — Vehicle physics and class behaviour

### Tires, grip, and temperature

- [ ] Validate combined-slip tyre forces at low, medium, and high speed; the car must not permanently scrub or trigger TC on a normal lap.
- [ ] Add a stable carcass/ tread thermal model with heat from longitudinal slip, lateral slip, load, ambient temperature, and cooling. Cold tyres should warm at normal pace; overheated tyres should lose grip progressively.
- [ ] Add pressure evolution and pressure-dependent grip/stiffness.
- [ ] Add tyre wear by axle and compound, including degradation over a stint and recovery/cooling during coasting or pit service.
- [ ] Expose tyre temperature, pressure, slip ratio, slip angle, wear, and friction-circle utilisation in debug telemetry.

### Chassis, suspension, and drivetrain

- [ ] Verify steering acts through the front contact patches and rack geometry, not a centre-of-mass yaw shortcut. Keep the input sign consistent for keyboard, gamepad, AI, and replay.
- [ ] Tune suspension travel, damping, bump stops, anti-roll bars, and load transfer so kerbs and bumps create believable transient response.
- [ ] Validate longitudinal/lateral weight transfer and yaw inertia against telemetry probes.
- [ ] Validate drivetrain torque, gear changes, traction control, ABS, engine braking, differential preload/ramp, and wheel-speed behaviour.
- [ ] Add drivetrain heat/failure placeholders only if they improve racing decisions; avoid fake complexity that does not affect the car.
- [ ] Keep fixed-step integration stable at the target physics rate and test frame-rate independence.

### Aero, ERS, and class balance

- [ ] Make prototype downforce progressive with ride height, pitch, yaw, speed, and diffuser stall; avoid the current “on/off” aero feeling.
- [ ] Add front/rear aero balance telemetry and tune turn-in versus high-speed understeer.
- [ ] Make prototypes materially faster in acceleration, high-speed cornering, and ERS deployment than GT3/touring while preserving believable low-speed traction.
- [ ] Implement ERS deployment, harvesting, battery state, regen limits, deployment modes, and a per-lap energy budget.
- [ ] Increase harvest from lift/brake in a physically stable way; regen must not create an abrupt rear torque spike or make the car unstable.
- [ ] Add ERS sounds and HUD feedback for deployment, harvesting, clipping, and empty battery.

## P1 — RL and offline training

The browser controller must remain safe and deterministic even when the learned policy is absent or uncertain. RL supplies tactical targets/residuals; it does not bypass collision or vehicle safety.

### Parity and infrastructure

- [ ] Keep the JAX vehicle environment mathematically aligned with the JavaScript fixed-step model.
- [ ] Run the parity suite on steering, throttle, brake, position, yaw, wheel speeds, tyre temperature, and ERS state; investigate any drift above the declared tolerance.
- [ ] Confirm the local WSL/JAX environment, CUDA driver, and cuDNN status before GPU claims. Record exact versions and benchmark output.
- [ ] Add deterministic seeds and a reproducible artifact manifest for every training run.
- [ ] Do not claim “4096 cars” until a headless benchmark shows 4096 environments, stable memory use, steps/second, and a saved checkpoint.

### Better policy training

- [ ] Train mixed-class domain randomisation: mass, power, downforce, tyre grip, wheelbase, track width, ambient conditions, and fuel load.
- [ ] Train on multiple procedural track families: long straights, hairpins, chicanes, elevation changes, off-camber corners, and variable grip.
- [ ] Use historical self-play checkpoints plus heuristic, defensive, opportunistic, and aggressive opponents.
- [ ] Add recurrent memory (GRU/LSTM) only after the observation/reward contract is stable; memory should track opponent tendencies, tyre state, and energy trends.
- [ ] Keep the hierarchy: high-level policy at tactical rate, deterministic low-level controller at high rate, optional bounded residual steering/brake head.
- [ ] Add rewards for legal closing, clean side-by-side racing, successful passes, switchbacks, defending, tyre conservation, ERS strategy, and recovery. Penalise contact, deep overlap, off-track time, unsafe rejoin, and repeated blocked attempts.
- [ ] Export a compact policy with schema/version, observation normalisation, action limits, class metadata, and checksum.
- [ ] Run offline evaluation against held-out tracks and opponents before loading a policy in the browser.
- [ ] Compare RL decisions against the heuristic baseline; reject a checkpoint if it is slower, less decisive, or less safe.

## P1 — Track, environment, and assets

- [ ] Fully rebuild the main circuit procedurally with a long passing straight, technical sector, clear apex/exit geometry, elevation variation, and safe runoff.
- [ ] Ensure the asphalt, curbs, runoff, and green terrain never overlap visually or physically; add a terrain-containment test around the entire spline.
- [ ] Add procedural track-surface zones for grip, rubber, marbles, wetness, kerb impact, and off-track recovery.
- [ ] Replace placeholder props with authored Blender assets: barriers, kerbs, marshal posts, lights, signs, grandstands, pit buildings, service vehicles, fencing, cones, tire stacks, and scenery.
- [ ] Rebuild the three car bodies in Blender with consistent scale, wheel placement, collision proxy, materials, emissive lights, cockpit silhouette, and aerodynamic appendages.
- [ ] Add LODs, instancing, texture atlases, shadow budgets, and culling so the detailed scene remains browser-safe.
- [ ] Improve lighting, sky, fog, contact shadows, reflections, surface roughness, and night/overcast variants.
- [ ] Add a complete pit lane, pit entry/exit, pit boxes, speed limit, service animation, and safe release logic.

## P1 — Audio, camera, HUD, and presentation

- [ ] Add layered engine audio keyed to RPM/load/throttle, intake, transmission whine, gear changes, wheel slip, kerbs, impacts, wind, and exhaust.
- [ ] Add ERS deployment/regen audio, tyre scrub, brake squeal, warnings, horns, marshal/track messages, pit limiter, and radio cues.
- [ ] Finish the HUD: speed/RPM/gear, lap/position/gaps, tyre temperatures/pressures/wear, ERS battery/harvest/deploy, ABS/TC, damage, pit status, flags, and penalties.
- [ ] Make the AI Planner panel show the actual selected trajectory, candidate count, target lane, transition time, predicted clearance, TTC, reason for waiting, and current action—not only intent text.
- [ ] Keep debug mode readable and toggleable without affecting normal performance.
- [ ] Finish global no-clip spectator mode: free camera, follow any vehicle, orbit/telemetry view, pause/step, and AI planner overlays.
- [ ] Add camera modes for cockpit, chase, bumper, broadcast, replay, and spectator; cockpit motion must reflect yaw/acceleration without nausea.
- [ ] Add race presentation: grid, lights, countdown, formation, flags, penalties, pit stops, finish, results, replay, and restart flow.

## P2 — Performance, tooling, and maintainability

- [ ] Keep simulation, AI, rendering, audio, UI, and track generation in separate modules.
- [ ] Profile physics, AI planning, collision checks, draw calls, shader cost, allocations, and debug overlays at 60/120 Hz.
- [ ] Add an AI telemetry recorder and a compact replay format for reproducing a bad pass or spin.
- [ ] Add scenario seeds for: straight-line draft, slow stopped player, side-by-side corner, blocked inside, switchback, multiclass traffic, recovery, pit entry, and ERS depletion.
- [ ] Add automated screenshot/browser smoke checks for normal, `?extreme=1`, `?rl=hybrid`, and debug/spectator modes.
- [ ] Add CI gates for build, physics regressions, AI contracts, RL schema/parity, and asset loading.
- [ ] Commit changes in small subsystem commits with a short evidence note; never mix an unmeasured physics change with a visual-only change.

## Acceptance gates

Before describing the AI as “aggressive and race-ready,” the following must pass on fixed seeds and at least three independent seeds:

- [ ] All cars finish the mixed-field race.
- [ ] At least four cars show committed passing attempts, including at least one signed inside attack and one switchback.
- [ ] Clean straight full-throttle ratio is at least 82% for the field and at least 98% in the dedicated prototype straight probe.
- [ ] Active-race contact frames are near zero; deep-overlap frames are zero; maximum impact remains below the declared limit.
- [ ] No car spends more than 8 s off track or more than 2.5 s in a severe spin state in the regression scenario.
- [ ] A controlled pass completes with zero contacts, zero deep overlaps, zero off-track time, a deliberate attack phase, and more than 4 m final progress.
- [ ] Slow, crawling, and stopped player bypasses complete without contact or off-track time.
- [ ] The planner debug path and the actual vehicle motion agree within a small measured lateral/heading tolerance.
- [ ] Prototypes are faster than GT3 and touring over a clean lap without relying on hidden forces.
- [ ] Tyres reach the intended operating window at normal pace, degrade over a stint, and influence pit strategy.
- [ ] ERS deploys and regenerates over a lap without destabilising the rear axle.
- [ ] Browser build succeeds and the scene remains within the frame-time/draw-call budget.

## Verification commands

Run from the repository root:

```powershell
npm run build
npm run test:ai-trajectory
npm run test:ai-overtake
npm run test:ai-slow-player
npm run test:ai-racecraft
npm run test:pass-quality
npm run test:classes
npm run test:prototype-aero
npm run test:handling
npm run test:rl-js
npm run test:rl-hybrid-live
npm run test:rl-multiagent
npm run test:rl-pack
npm run rl:parity
```

For GPU work, run the benchmark first, then record the environment and artifact path before training:

```powershell
npm run rl:gpu:benchmark
npm run rl:gpu:pack-train
npm run rl:gpu:pack-evaluate
```

## Recommended execution order

1. Finish the Frenet planner/controller contract and the aggressive clean pass.
2. Fix recovery/off-track behaviour and rerun mixed-field racecraft with three seeds.
3. Add side-by-side reservations, defender response, switchbacks, split-stream, and rubbering.
4. Tune class pace, prototype aero, tyre temperature/wear, ERS harvesting, and pit strategy together.
5. Lock JS/JAX parity and run a documented 4096-environment headless benchmark.
6. Train mixed-class/self-play policies and compare them against the heuristic baseline.
7. Rebuild the track and Blender assets, then profile the browser scene.
8. Finish audio, HUD, spectator/debug tools, race presentation, replay, and final visual QA.

## Do not call these finished yet

- The AI is not yet proven to make frequent, clean passes in a full pack.
- The latest mixed-field run still needs recovery and pass-count improvements.
- A 4096-car JAX training result has not been validated here.
- RL has not yet demonstrated an improvement over the deterministic controller on held-out scenarios.
- Rubbering, split stream, full tyre strategy, and pit strategy are not complete quality features.
- The procedural track, Blender props/cars, audio, and final HUD still need a full polish pass.
