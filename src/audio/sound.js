// P7 owns this file. Contract: see ARCHITECTURE.md.
// createSound() -> { update(car, camera, dt), unlock() }
// Procedural WebAudio: engine (rpm harmonics), tire squeal (slip), wind,
// transmission whine, impacts. Must unlock on first user gesture.

export function createSound() {
  return {
    update(car, camera, dt) {},
    unlock() {},
  };
}
