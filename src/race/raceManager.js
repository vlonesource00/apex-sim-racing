// P6 owns this file. Contract: see ARCHITECTURE.md.
// createRace(track, cars, opts) -> race
// updateRace(race, dt) — laps, positions, timing, start/finish, penalties

export function createRace(track, cars, opts = {}) {
  return {
    track, cars,
    totalLaps: opts.totalLaps ?? 5,
    started: false,
    finished: false,
    time: 0,
  };
}

export function updateRace(race, dt) {
  // P6 implements timing/standings/lap counting here.
}
