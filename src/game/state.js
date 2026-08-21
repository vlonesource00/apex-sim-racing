// Shared mutable simulation state. Physics writes; everything else reads.
export const state = {
  mode: 'loading',      // loading | countdown | racing | paused | results
  time: 0,              // session seconds
  countdown: 0,
  track: null,
  cars: [],
  player: null,
  cameraMode: 'chase',  // chase | cockpit | hood | tv
  race: null,
  fps: 60,

  // Spectate AI Debug Mode
  spectating: false,
  spectateIndex: 0,     // 0 = Player, 1..N = AI cars
  spectatedCar: null,
  spectatedDriver: null,
};

