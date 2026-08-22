# APEX//73 Hybrid RL Lab

This branch trains a high-level tactical policy while the browser keeps deterministic 120 Hz vehicle control, ABS/TC, collision safety, flags and pit rules.

## Boundary

- Policy rate: 10–20 Hz.
- Policy outputs: line offset, pace, aggression and ERS strategy.
- Deterministic controller outputs: steering, throttle and brake.
- Current curriculum stage: Stage-2 traffic-aware clean overtaking on Endurance Park.
- The reduced-order model is intentionally not presented as the complete `Vehicle.js` four-wheel simulation. It is a matched training abstraction for high-level decisions.

## Reproducible commands

```powershell
npm run rl:export-track
npm run rl:parity
npm run rl:benchmark -- --envs 4096 --steps 2000
npm run rl:train-smoke
npm run test:rl-js
```

The Windows virtual environment uses JAX CPU. WSL2 Ubuntu and an isolated CUDA JAX environment are installed at `/opt/apex73-jax`; they use the existing Windows NVIDIA driver without a global CUDA Toolkit installation.

```powershell
npm run rl:gpu:benchmark
npm run rl:gpu:train
npm run rl:gpu:evaluate
npm run rl:gpu:multi-train
npm run rl:gpu:multi-evaluate
```

Measured on the local RTX 5060 Ti:

- Reduced dynamics only: 167.1 million steps/s for 4,096 environments.
- PPO including policy/value networks and gradient updates: 0.46–1.15 million environment steps/s depending on batch shape.
- Accepted Stage-1 candidate: 8.39 million steps in 18.17 s.
- Unseen evaluation: 0.0992% reset rate versus 0.1000% for the heuristic, with lower tire utilisation but approximately 1% less progress.
- JavaScript/JAX 500-frame parity error: below `7e-16` in float64.
- Accepted Stage-2 candidate: 25.17 million transitions at about 697,637 steps/s on the RTX 5060 Ti.
- Unseen multi-agent audit: 20.20 clean passes per 100 episodes versus 14.47 for the heuristic baseline; 0.092 deep-contact incidents and 0.011 forced-opponent-offs per 100 episodes.

These are reduced-order high-level-policy numbers, not full `Vehicle.js` throughput.

- `?rl=shadow` logs learned decisions and cannot mutate live controls.
- `?rl=hybrid` applies the safety-shielded learned line, pace, aggression and ERS outputs to the live tactical planner at exactly 20 Hz. The deterministic controller still owns steering, throttle, braking, collision avoidance and recovery.

The accepted Stage-2 policy adds eight live traffic observations: signed gap, lateral delta, relative speed, closing speed, TTC, lateral clearance, ahead state and side-by-side state. It was trained against randomized rivals in a contact-enabled two-car curriculum. The same deterministic racing-room shield runs in JAX and JavaScript; it reserves an alternate lane early, brakes when clearance has not developed, and prevents ERS deployment into a collision course. The debugger exposes the selected opponent, gap, TTC, overlap state and shield intervention.

A pass only scores after the rival is more than five metres behind with no contact and both cars still racing. The browser independently audits every position crossover for one second of durable clearance, rejecting contact, attacker shortcutting and defender off-track outcomes.

## Next curriculum stages

1. Single-car line/pace convergence and deterministic evaluation.
2. Domain randomization for grip, tire wear, aero balance and car class.
3. Ghost traffic observations and overtake-side actions. Complete.
4. Contact-enabled multi-agent training behind a deterministic reciprocal safety shield. Complete for one attacker/one randomized rival; population self-play remains future work.
5. Browser shadow mode, where RL decisions are logged but do not control cars. Complete.
6. Opt-in live A/B testing against the heuristic controller. Stage-2 hybrid integration and clean-pass audit complete.
