const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createInput() {
  const keys = new Set();
  const state = {
    throttle: 0, brake: 0, steer: 0, clutch: 0, gearRequest: 0,
    steerRaw: 0, throttleRaw: 0, brakeRaw: 0,
    buttons: {
      pause: false, camera: false, reset: false,
      shiftUp: false, shiftDown: false,
      toggleTransmission: false, toggleTC: false, toggleABS: false,
      toggleDebug: false,
      spectateNext: false, spectatePrev: false, spectatePlayer: false,
      spectateCarIndex: -1,
    },
    _prevPause: false, _prevCam: false, _prevReset: false,
  };

  let camToggle = false, pauseToggle = false, resetToggle = false;
  let shiftUpReq = false, shiftDownReq = false;
  let transToggleReq = false, tcToggleReq = false, absToggleReq = false;
  let debugToggleReq = false;
  let spectateNextReq = false, spectatePrevReq = false, spectatePlayerReq = false;
  let spectateDirectIndex = -1;

  let prevPadLB = false, prevPadRB = false;
  let prevPadDLeft = false, prevPadDRight = false;

  const SHIFT_UP_KEYS = new Set(['KeyE', 'ShiftLeft', 'ShiftRight', 'ArrowUp']);
  const SHIFT_DOWN_KEYS = new Set(['KeyQ', 'ControlLeft', 'ControlRight', 'ArrowDown']);

  const down = (e) => {
    keys.add(e.code);
    if (!e.repeat) {
      if (e.code === 'KeyC') camToggle = true;
      if (e.code === 'Escape' || e.code === 'KeyP') pauseToggle = true;
      if (e.code === 'KeyR') resetToggle = true;

      if (SHIFT_UP_KEYS.has(e.code)) shiftUpReq = true;
      if (SHIFT_DOWN_KEYS.has(e.code)) shiftDownReq = true;
      if (e.code === 'KeyT') transToggleReq = true;
      if (e.code === 'KeyF') tcToggleReq = true;
      if (e.code === 'KeyB') absToggleReq = true;
      if (e.code === 'KeyU' || e.code === 'Backquote') debugToggleReq = true;

      // Spectator AI Mode Keybindings
      if (e.code === 'Tab' || e.code === 'BracketRight') {
        if (e.shiftKey) spectatePrevReq = true;
        else spectateNextReq = true;
        e.preventDefault();
      } else if (e.code === 'BracketLeft') {
        spectatePrevReq = true;
        e.preventDefault();
      } else if (e.code === 'Digit0') {
        spectatePlayerReq = true;
      } else if (e.code === 'Digit1') {
        spectateDirectIndex = 0; // Player
      } else if (e.code === 'Digit2') {
        spectateDirectIndex = 1; // AI 1
      } else if (e.code === 'Digit3') {
        spectateDirectIndex = 2; // AI 2
      } else if (e.code === 'Digit4') {
        spectateDirectIndex = 3; // AI 3
      } else if (e.code === 'Digit5') {
        spectateDirectIndex = 4; // AI 4
      } else if (e.code === 'Digit6') {
        spectateDirectIndex = 5; // AI 5
      }
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) {
      e.preventDefault();
    }
  };

  const up = (e) => keys.delete(e.code);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);

  function update(dt) {
    // Keyboard raw
    let thr = 0, brk = 0, str = 0;
    if (keys.has('KeyW')) thr = 1;
    if (keys.has('KeyS')) brk = 1;
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

      // Gamepad D-pad left / right (buttons 14/15) for spectating
      const padDLeft = pad.buttons[14]?.pressed ?? false;
      const padDRight = pad.buttons[15]?.pressed ?? false;
      if (padDLeft && !prevPadDLeft) spectatePrevReq = true;
      if (padDRight && !prevPadDRight) spectateNextReq = true;
      prevPadDLeft = padDLeft;
      prevPadDRight = padDRight;
    }

    state.throttleRaw = thr;
    state.brakeRaw = brk;
    state.steerRaw = str;

    // Smooth actuators toward raw targets (keyboard needs ramping)
    const thrRate = 3.5, brkRate = 4.0, strRate = 3.2;
    state.throttle += clamp(thr - state.throttle, -thrRate * dt, thrRate * dt);
    state.brake += clamp(brk - state.brake, -brkRate * dt, brkRate * dt);
    state.steer += clamp(str - state.steer, -strRate * dt, strRate * dt);
    state.throttle = clamp(state.throttle, 0, 1);
    state.brake = clamp(state.brake, 0, 1);
    state.steer = clamp(state.steer, -1, 1);

    state.buttons.camera = camToggle; camToggle = false;
    state.buttons.pause = pauseToggle; pauseToggle = false;
    state.buttons.reset = resetToggle; resetToggle = false;
    state.buttons.shiftUp = shiftUpReq;
    state.buttons.shiftDown = shiftDownReq;
    state.buttons.toggleTransmission = transToggleReq;
    state.buttons.toggleTC = tcToggleReq;
    state.buttons.toggleABS = absToggleReq;
    state.buttons.toggleDebug = debugToggleReq;

    // Spectator AI Buttons
    state.buttons.spectateNext = spectateNextReq;
    state.buttons.spectatePrev = spectatePrevReq;
    state.buttons.spectatePlayer = spectatePlayerReq;
    state.buttons.spectateCarIndex = spectateDirectIndex;

    // Export gearRequest in state
    if (shiftUpReq) state.gearRequest = 1;
    else if (shiftDownReq) state.gearRequest = -1;

    shiftUpReq = false;
    shiftDownReq = false;
    transToggleReq = false;
    tcToggleReq = false;
    absToggleReq = false;
    debugToggleReq = false;
    spectateNextReq = false;
    spectatePrevReq = false;
    spectatePlayerReq = false;
    spectateDirectIndex = -1;
  }

  function getDriverInput() {
    const gearReq = state.gearRequest;
    state.gearRequest = 0;
    return {
      throttle: state.throttle,
      brake: state.brake,
      steer: state.steer,
      clutch: 0,
      gearRequest: gearReq,
      buttons: state.buttons,
    };
  }

  function dispose() {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
  }

  return { update, getDriverInput, dispose, state };
}
