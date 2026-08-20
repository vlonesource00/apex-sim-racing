const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createInput() {
  const keys = new Set();
  const state = {
    throttle: 0, brake: 0, steer: 0, clutch: 0, gearRequest: 0,
    steerRaw: 0, throttleRaw: 0, brakeRaw: 0,
    buttons: { pause: false, camera: false, reset: false },
    _prevPause: false, _prevCam: false, _prevReset: false,
  };
  let camToggle = false, pauseToggle = false, resetToggle = false;

  const down = (e) => {
    keys.add(e.code);
    if (e.code === 'KeyC') camToggle = true;
    if (e.code === 'Escape' || e.code === 'KeyP') pauseToggle = true;
    if (e.code === 'KeyR') resetToggle = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  const up = (e) => keys.delete(e.code);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);

  function update(dt) {
    // Keyboard raw
    let thr = 0, brk = 0, str = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) thr = 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) brk = 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) str += 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) str -= 1;

    // Gamepad overrides (if present and touched)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (pad) {
      const rt = pad.buttons[7]?.value ?? 0;   // right trigger = throttle
      const lt = pad.buttons[6]?.value ?? 0;   // left trigger = brake
      const ax = pad.axes[0] ?? 0;             // left stick X = steer
      if (rt > 0.02) thr = Math.max(thr, rt);
      if (lt > 0.02) brk = Math.max(brk, lt);
      if (Math.abs(ax) > 0.06) str = -ax;
      if (pad.buttons[0]?.pressed) camToggle = true; // A = camera
    }

    state.throttleRaw = thr;
    state.brakeRaw = brk;
    state.steerRaw = str;

    // Smooth actuators toward raw targets (keyboard needs ramping)
    const thrRate = 3.5, brkRate = 4.0, strRate = 2.6;
    state.throttle += clamp(thr - state.throttle, -thrRate * dt, thrRate * dt);
    state.brake += clamp(brk - state.brake, -brkRate * dt, brkRate * dt);
    state.steer += clamp(str - state.steer, -strRate * dt, strRate * dt);
    state.throttle = clamp(state.throttle, 0, 1);
    state.brake = clamp(state.brake, 0, 1);
    state.steer = clamp(state.steer, -1, 1);

    state.buttons.camera = camToggle; camToggle = false;
    state.buttons.pause = pauseToggle; pauseToggle = false;
    state.buttons.reset = resetToggle; resetToggle = false;
  }

  function getDriverInput() {
    return {
      throttle: state.throttle,
      brake: state.brake,
      steer: state.steer,
      clutch: 0,
      gearRequest: 0,
      buttons: state.buttons,
    };
  }

  return { update, getDriverInput, state };
}
