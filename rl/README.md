# APEX//73 Hybrid RL Lab

This branch trains a high-level tactical policy while the browser keeps deterministic 120 Hz vehicle control, ABS/TC, collision safety, flags and pit rules.

## Boundary

- Policy rate: 10–20 Hz.
- Policy outputs: line offset, pace, aggression and ERS strategy.
- Deterministic controller outputs: steering, throttle and brake.
- Current curriculum stage: single-car line and pace learning on Endurance Park.
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
```

Measured on the local RTX 5060 Ti:

- Reduced dynamics only: 167.1 million steps/s for 4,096 environments.
- PPO including policy/value networks and gradient updates: 0.46–1.15 million environment steps/s depending on batch shape.
- Accepted Stage-1 candidate: 8.39 million steps in 18.17 s.
- Unseen evaluation: 0.0992% reset rate versus 0.1000% for the heuristic, with lower tire utilisation but approximately 1% less progress.
- JavaScript/JAX 500-frame parity error: below `7e-16` in float64.

These are reduced-order high-level-policy numbers, not full `Vehicle.js` throughput. The policy remains opt-in shadow telemetry at `?rl=shadow`; it cannot mutate live controls.

## Next curriculum stages

1. Single-car line/pace convergence and deterministic evaluation.
2. Domain randomization for grip, tire wear, aero balance and car class.
3. Ghost traffic observations and overtake-side actions.
4. Contact-enabled multi-agent self-play behind a deterministic safety shield.
5. Browser shadow mode, where RL decisions are logged but do not control cars.
6. Opt-in live A/B testing against the heuristic controller.
