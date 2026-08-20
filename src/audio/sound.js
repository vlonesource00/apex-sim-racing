// Procedural Web Audio Engine for GT3 Sim Racing
// Features:
// - Multi-oscillator Flat-6 / V8 GT3 engine harmonics with wave shaping & throttle-open filtering
// - Sharp randomized exhaust pops / backfires on high-RPM lift-off and manual downshifts
// - Dynamic tire squeal mapped to lateral slip angle and longitudinal slip ratio
// - Tactile low-frequency curb rumble over rumble strips
// - Speed-proportional aerodynamic wind rush
// - Straight-cut racing transmission gear whine & wall impacts
// - Seamless gesture-based Web Audio unlocking

export function createSound() {
  let audioCtx = null;
  let isUnlocked = false;

  // Master nodes
  let masterGain = null;
  let compressor = null;

  // Engine harmonics nodes
  let engineGain = null;
  let engineFilter = null;
  let engineFormant = null;
  let engineShaper = null;
  let oscSub = null, oscSubGain = null;
  let osc1 = null, osc1Gain = null;
  let osc2 = null, osc2Gain = null;
  let osc3 = null, osc3Gain = null;
  let osc4 = null, osc4Gain = null;
  let osc6 = null, osc6Gain = null;

  // Tire squeal nodes
  let tireNoiseSource = null;
  let tireFilter1 = null, tireFilter2 = null;
  let tireGain = null;
  let offTrackFilter = null, offTrackGain = null;

  // Curb rumble nodes
  let curbOsc = null;
  let curbGain = null;
  let curbFilter = null;

  // Wind rush nodes
  let windNoiseSource = null;
  let windFilter = null;
  let windGain = null;

  // Transmission whine nodes
  let transOsc = null;
  let transGain = null;

  // Buffers
  let whiteNoiseBuffer = null;
  let pinkNoiseBuffer = null;

  // Tracking state for triggers
  let prevGear = 1;
  let prevThrottle = 0;
  let prevRpm = 1200;
  let prevWallHit = 0;
  let popCooldown = 0;
  let limiterTimer = 0;

  // Soft-saturation distortion curve
  function makeDistortionCurve(k = 2) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Soft-knee arctan/tanh saturation
      curve[i] = Math.tanh(x * k);
    }
    return curve;
  }

  // Pre-generate noise buffers
  function createNoiseBuffers(ctx) {
    const bufferSize = ctx.sampleRate * 2; // 2 seconds
    whiteNoiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const whiteData = whiteNoiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      whiteData[i] = Math.random() * 2 - 1;
    }

    pinkNoiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const pinkData = pinkNoiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      pinkData[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  }

  function initAudio() {
    if (audioCtx) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioCtx = new AudioContextClass();
    } catch (e) {
      return;
    }

    createNoiseBuffers(audioCtx);

    // Master Compressor & Gain
    compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 8;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.08;

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.85;

    compressor.connect(masterGain);
    masterGain.connect(audioCtx.destination);

    // --- 1. GT3 ENGINE HARMONICS ---
    engineGain = audioCtx.createGain();
    engineGain.gain.value = 0;

    engineFilter = audioCtx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 450;
    engineFilter.Q.value = 1.8;

    engineFormant = audioCtx.createBiquadFilter();
    engineFormant.type = 'peaking';
    engineFormant.frequency.value = 680;
    engineFormant.Q.value = 2.5;
    engineFormant.gain.value = 4.0;

    engineShaper = audioCtx.createWaveShaper();
    engineShaper.curve = makeDistortionCurve(2.8);
    engineShaper.oversample = '2x';

    // Harmonic Oscillators (Flat-6: 3 firing pulses per crank rev)
    // Sub-harmonic: 0.5x
    oscSub = audioCtx.createOscillator();
    oscSub.type = 'sawtooth';
    oscSub.frequency.value = 30;
    oscSubGain = audioCtx.createGain();
    oscSubGain.gain.value = 0.45;
    oscSub.connect(oscSubGain);
    oscSubGain.connect(engineFilter);

    // 1st Fundamental: 1.0x
    osc1 = audioCtx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 60;
    osc1Gain = audioCtx.createGain();
    osc1Gain.gain.value = 0.65;
    osc1.connect(osc1Gain);
    osc1Gain.connect(engineFilter);

    // 2nd Harmonic: 2.0x
    osc2 = audioCtx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = 120;
    osc2Gain = audioCtx.createGain();
    osc2Gain.gain.value = 0.50;
    osc2.connect(osc2Gain);
    osc2Gain.connect(engineFilter);

    // 3rd Harmonic: 3.0x
    osc3 = audioCtx.createOscillator();
    osc3.type = 'triangle';
    osc3.frequency.value = 180;
    osc3Gain = audioCtx.createGain();
    osc3Gain.gain.value = 0.40;
    osc3.connect(osc3Gain);
    osc3Gain.connect(engineFilter);

    // 4th Harmonic: 4.0x (metallic rasp)
    osc4 = audioCtx.createOscillator();
    osc4.type = 'sawtooth';
    osc4.frequency.value = 240;
    osc4Gain = audioCtx.createGain();
    osc4Gain.gain.value = 0.30;
    osc4.connect(osc4Gain);
    osc4Gain.connect(engineFilter);

    // 6th Harmonic: 6.0x (screaming top end)
    osc6 = audioCtx.createOscillator();
    osc6.type = 'sawtooth';
    osc6.frequency.value = 360;
    osc6Gain = audioCtx.createGain();
    osc6Gain.gain.value = 0.22;
    osc6.connect(osc6Gain);
    osc6Gain.connect(engineFilter);

    // Chain: Filter -> Formant -> Waveshaper -> Gain -> Master
    engineFilter.connect(engineFormant);
    engineFormant.connect(engineShaper);
    engineShaper.connect(engineGain);
    engineGain.connect(compressor);

    oscSub.start();
    osc1.start();
    osc2.start();
    osc3.start();
    osc4.start();
    osc6.start();

    // --- 2. TIRE SQUEAL & SURFACE NOISE ---
    tireNoiseSource = audioCtx.createBufferSource();
    tireNoiseSource.buffer = whiteNoiseBuffer;
    tireNoiseSource.loop = true;

    tireFilter1 = audioCtx.createBiquadFilter();
    tireFilter1.type = 'bandpass';
    tireFilter1.frequency.value = 950;
    tireFilter1.Q.value = 3.5;

    tireFilter2 = audioCtx.createBiquadFilter();
    tireFilter2.type = 'bandpass';
    tireFilter2.frequency.value = 2200;
    tireFilter2.Q.value = 4.0;

    tireGain = audioCtx.createGain();
    tireGain.gain.value = 0;

    tireNoiseSource.connect(tireFilter1);
    tireNoiseSource.connect(tireFilter2);
    tireFilter1.connect(tireGain);
    tireFilter2.connect(tireGain);
    tireGain.connect(compressor);
    tireNoiseSource.start();

    // Off-track gravel / grass scrub
    const offTrackSource = audioCtx.createBufferSource();
    offTrackSource.buffer = pinkNoiseBuffer;
    offTrackSource.loop = true;
    offTrackFilter = audioCtx.createBiquadFilter();
    offTrackFilter.type = 'lowpass';
    offTrackFilter.frequency.value = 380;
    offTrackGain = audioCtx.createGain();
    offTrackGain.gain.value = 0;
    offTrackSource.connect(offTrackFilter);
    offTrackFilter.connect(offTrackGain);
    offTrackGain.connect(compressor);
    offTrackSource.start();

    // --- 3. CURB RUMBLE ---
    curbOsc = audioCtx.createOscillator();
    curbOsc.type = 'square';
    curbOsc.frequency.value = 45;

    curbFilter = audioCtx.createBiquadFilter();
    curbFilter.type = 'lowpass';
    curbFilter.frequency.value = 160;
    curbFilter.Q.value = 2.0;

    curbGain = audioCtx.createGain();
    curbGain.gain.value = 0;

    curbOsc.connect(curbFilter);
    curbFilter.connect(curbGain);
    curbGain.connect(compressor);
    curbOsc.start();

    // --- 4. WIND RUSH ---
    windNoiseSource = audioCtx.createBufferSource();
    windNoiseSource.buffer = pinkNoiseBuffer;
    windNoiseSource.loop = true;

    windFilter = audioCtx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 250;
    windFilter.Q.value = 0.7;

    windGain = audioCtx.createGain();
    windGain.gain.value = 0;

    windNoiseSource.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(compressor);
    windNoiseSource.start();

    // --- 5. TRANSMISSION WHINE ---
    transOsc = audioCtx.createOscillator();
    transOsc.type = 'sine';
    transOsc.frequency.value = 400;

    transGain = audioCtx.createGain();
    transGain.gain.value = 0;

    transOsc.connect(transGain);
    transGain.connect(compressor);
    transOsc.start();
  }

  function unlock() {
    if (!audioCtx) initAudio();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => {
        isUnlocked = true;
        removeUnlockListeners();
      }).catch(() => {});
    } else if (audioCtx && audioCtx.state === 'running') {
      isUnlocked = true;
      removeUnlockListeners();
    }
  }

  const unlockEvents = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click'];
  const onUnlockEvent = () => unlock();
  unlockEvents.forEach(evt => {
    window.addEventListener(evt, onUnlockEvent, { passive: true });
  });

  function removeUnlockListeners() {
    unlockEvents.forEach(evt => {
      window.removeEventListener(evt, onUnlockEvent);
    });
  }

  // Sharp exhaust pop / backfire synthesis
  function triggerExhaustPop(intensity = 1.0, count = 1) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime;

    for (let c = 0; c < count; c++) {
      const delay = c * (0.035 + Math.random() * 0.055);
      const popTime = now + delay;
      const vol = (0.5 + Math.random() * 0.5) * intensity;

      // 1. Low sub thump (40-150Hz fast drop)
      const thump = audioCtx.createOscillator();
      const thumpGain = audioCtx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(140 + Math.random() * 50, popTime);
      thump.frequency.exponentialRampToValueAtTime(35, popTime + 0.05);

      thumpGain.gain.setValueAtTime(0.7 * vol, popTime);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.06);

      thump.connect(thumpGain);
      thumpGain.connect(compressor);

      thump.start(popTime);
      thump.stop(popTime + 0.07);

      // 2. High metallic crack (shaped noise)
      if (whiteNoiseBuffer) {
        const crackSource = audioCtx.createBufferSource();
        crackSource.buffer = whiteNoiseBuffer;
        const crackFilter = audioCtx.createBiquadFilter();
        crackFilter.type = 'bandpass';
        crackFilter.frequency.value = 1100 + Math.random() * 800;
        crackFilter.Q.value = 2.5;

        const crackGain = audioCtx.createGain();
        crackGain.gain.setValueAtTime(0.85 * vol, popTime);
        crackGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.045);

        crackSource.connect(crackFilter);
        crackFilter.connect(crackGain);
        crackGain.connect(compressor);

        crackSource.start(popTime);
        crackSource.stop(popTime + 0.05);
      }
    }
  }

  // Wall impact thud & metal crash
  function triggerImpact(severity) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime;
    const vol = Math.min(1.0, severity * 1.5);

    const hitOsc = audioCtx.createOscillator();
    const hitGain = audioCtx.createGain();
    hitOsc.type = 'triangle';
    hitOsc.frequency.setValueAtTime(90, now);
    hitOsc.frequency.exponentialRampToValueAtTime(25, now + 0.12);

    hitGain.gain.setValueAtTime(0.9 * vol, now);
    hitGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    hitOsc.connect(hitGain);
    hitGain.connect(compressor);

    hitOsc.start(now);
    hitOsc.stop(now + 0.15);
  }

  return {
    unlock,

    update(car, camera, dt = 0.016) {
      if (!audioCtx) initAudio();
      if (!audioCtx || audioCtx.state !== 'running') return;

      const p = car;
      if (!p) return;

      const now = audioCtx.currentTime;
      const redline = p.setup?.redline || 9000;
      const idleRpm = p.setup?.idleRpm || 1200;
      const rpm = Math.max(idleRpm, Math.min(redline + 400, p.rpm || idleRpm));
      const throttle = Math.max(0, Math.min(1, p.input?.throttle || 0));
      const speed = p.speed || 0; // m/s
      const speedKph = p.speedKph || (speed * 3.6);
      const gear = p.gear || 1;

      // 1. ENGINE SYNTHESIS (GT3 Flat-6: 3 pulses per rev)
      const f0 = (rpm / 60) * 3.0; // Fundamental firing frequency (Hz)
      const tConst = 0.035;

      oscSub.frequency.setTargetAtTime(f0 * 0.5, now, tConst);
      osc1.frequency.setTargetAtTime(f0, now, tConst);
      osc2.frequency.setTargetAtTime(f0 * 2.0, now, tConst);
      osc3.frequency.setTargetAtTime(f0 * 3.0, now, tConst);
      osc4.frequency.setTargetAtTime(f0 * 4.0, now, tConst);
      osc6.frequency.setTargetAtTime(f0 * 6.0, now, tConst);

      // Lowpass cutoff opens wide on throttle and high RPM
      const filterCutoff = Math.max(380, Math.min(8500, 350 + throttle * 4800 + (rpm / redline) * 2800));
      engineFilter.frequency.setTargetAtTime(filterCutoff, now, 0.04);

      // Peak formant shifts with RPM for cockpit exhaust resonance
      const formantFreq = 500 + (rpm / redline) * 600;
      engineFormant.frequency.setTargetAtTime(formantFreq, now, 0.05);

      // Volume based on RPM and throttle load
      const engineVol = 0.28 + (rpm / redline) * 0.35 + throttle * 0.25;
      engineGain.gain.setTargetAtTime(engineVol, now, 0.03);

      // 2. EXHAUST POPS & BACKFIRES DETECTION
      if (popCooldown > 0) popCooldown -= dt;
      if (limiterTimer > 0) limiterTimer -= dt;

      // Downshift backfires
      if (gear < prevGear && gear >= 1 && prevGear > 1) {
        triggerExhaustPop(1.1, Math.floor(1 + Math.random() * 2));
        popCooldown = 0.25;
      }

      // High-RPM throttle lift-off overrun crackles
      if (popCooldown <= 0 && prevThrottle > 0.45 && throttle < 0.12 && rpm > 3800) {
        const numPops = rpm > 6500 ? Math.floor(2 + Math.random() * 3) : Math.floor(1 + Math.random() * 2);
        triggerExhaustPop(0.85 + (rpm / redline) * 0.35, numPops);
        popCooldown = 0.35;
      }

      // Rev-limiter bounce
      if (rpm >= redline - 80 && throttle > 0.7 && limiterTimer <= 0) {
        triggerExhaustPop(0.9, 1);
        limiterTimer = 0.09;
      }

      prevGear = gear;
      prevThrottle = throttle;
      prevRpm = rpm;

      // 3. TIRE SQUEAL (Slip Angle + Slip Ratio)
      let maxSlip = 0;
      let totalLoad = 0;
      if (p.wheels && p.wheels.length === 4) {
        p.wheels.forEach(w => {
          const latSlip = Math.abs(w.slipAngle || 0) * 2.2;
          const lonSlip = Math.abs(w.slipRatio || 0) * 1.8;
          const s = Math.hypot(latSlip, lonSlip);
          if (s > maxSlip) maxSlip = s;
          totalLoad += (w.load || 0);
        });
      }

      const onTrack = !p.offTrack && p.surface !== 'grass' && p.surface !== 'gravel';
      if (onTrack && maxSlip > 0.12 && speed > 2.5) {
        const slipIntensity = Math.min(1.0, (maxSlip - 0.12) / 0.45);
        const squealVol = slipIntensity * 0.65 * Math.min(1.0, totalLoad / 10000);
        tireGain.gain.setTargetAtTime(squealVol, now, 0.03);
        
        // Screech pitch shifts with slip velocity
        const freq1 = 800 + slipIntensity * 450;
        const freq2 = 1900 + slipIntensity * 900;
        tireFilter1.frequency.setTargetAtTime(freq1, now, 0.03);
        tireFilter2.frequency.setTargetAtTime(freq2, now, 0.03);
        offTrackGain.gain.setTargetAtTime(0, now, 0.05);
      } else if (!onTrack && speed > 2.0) {
        // Off-track grass / gravel scrub
        tireGain.gain.setTargetAtTime(0, now, 0.05);
        const offVol = Math.min(0.6, (speed / 30) * 0.5);
        offTrackGain.gain.setTargetAtTime(offVol, now, 0.04);
      } else {
        tireGain.gain.setTargetAtTime(0, now, 0.05);
        offTrackGain.gain.setTargetAtTime(0, now, 0.05);
      }

      // 4. CURB RUMBLE (Rumble strips)
      const onCurb = p.surface === 'curb' || (p.wheels && p.wheels.some(w => w.surface === 'curb'));
      if (onCurb && speed > 2.0) {
        const curbFreq = Math.max(25, Math.min(80, speed * 2.2 + 20));
        curbOsc.frequency.setTargetAtTime(curbFreq, now, 0.02);
        const curbVol = Math.min(0.7, (speed / 35) * 0.65);
        curbGain.gain.setTargetAtTime(curbVol, now, 0.02);
      } else {
        curbGain.gain.setTargetAtTime(0, now, 0.04);
      }

      // 5. WIND RUSH NOISE
      const windSpeedNorm = Math.min(1.0, speed / 70); // 70 m/s ~ 252 km/h
      const windVol = Math.pow(windSpeedNorm, 1.6) * 0.32;
      const windCutoff = 180 + Math.pow(windSpeedNorm, 1.4) * 1400;
      windGain.gain.setTargetAtTime(windVol, now, 0.06);
      windFilter.frequency.setTargetAtTime(windCutoff, now, 0.06);

      // 6. TRANSMISSION GEAR WHINE
      if (speed > 2.0) {
        const whineFreq = Math.max(120, Math.min(3200, speed * 30 + (rpm / redline) * 400));
        transOsc.frequency.setTargetAtTime(whineFreq, now, 0.03);
        const whineVol = Math.min(0.18, (speed / 60) * 0.12 + throttle * 0.06);
        transGain.gain.setTargetAtTime(whineVol, now, 0.04);
      } else {
        transGain.gain.setTargetAtTime(0, now, 0.05);
      }

      // 7. WALL IMPACT
      const wallHit = p.wallHit || 0;
      if (wallHit > 0.08 && wallHit > prevWallHit + 0.05) {
        triggerImpact(wallHit);
      }
      prevWallHit = wallHit;
    },

    dispose() {
      removeUnlockListeners();
      if (audioCtx) {
        try {
          audioCtx.close();
        } catch (e) {}
      }
    }
  };
}
