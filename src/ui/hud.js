import './hud.css';

// format time MM:SS.mmm
function formatTime(s) {
  if (!s || s <= 0) return "--:--.---";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

export function createHud(el) {
  el.innerHTML = `
    <div class="hud-panel hud-timing">
      <div class="timing-header">
        <span class="pos">P1 <span style="font-size:14px;color:#aaa">/ 6</span></span>
        <span class="lap">L1 <span style="font-size:14px;color:#aaa">/ 5</span></span>
      </div>
      <div class="timing-row">
        <span class="timing-label">LAP</span>
        <span class="current-time">00:00.000</span>
      </div>
      <div class="timing-row">
        <span class="timing-label">BEST</span>
        <span class="best-time">--:--.---</span>
      </div>
      <div class="timing-row">
        <span class="timing-label">LAST</span>
        <span class="last-time">--:--.---</span>
      </div>
      <div class="timing-row">
        <span class="timing-label">DELTA</span>
        <span class="delta">+0.00</span>
      </div>
    </div>

    <div class="hud-panel hud-minimap">
      <canvas class="minimap-canvas" width="200" height="200"></canvas>
    </div>

    <!-- Proximity Spotter Radar -->
    <div class="spotter-radar spotter-left" id="spotter-left">
      <div class="spotter-arrows">◀◀◀</div>
      <div class="spotter-dist" id="spotter-left-dist"></div>
    </div>
    <div class="spotter-radar spotter-right" id="spotter-right">
      <div class="spotter-arrows">▶▶▶</div>
      <div class="spotter-dist" id="spotter-right-dist"></div>
    </div>
    <div class="spotter-radar spotter-rear" id="spotter-rear">
      <div class="spotter-arrows">▼ CAR BEHIND ▼</div>
      <div class="spotter-dist" id="spotter-rear-dist"></div>
    </div>

    <div class="hud-cluster">
      <div class="shift-helper" id="shift-helper">▲ SHIFT UP ▲</div>
      <div class="rpm-bar-container" id="rpm-bar">
        ${Array.from({length: 15}).map(() => `<div class="rpm-led"></div>`).join('')}
      </div>
      <div class="cluster-main">
        <div class="pedals">
          <div class="pedal-bar pedal-brake"><div class="pedal-fill" id="brake-bar"></div></div>
        </div>
        <div class="gear-box">
          <div class="gear" id="gear">N</div>
          <div class="trans-mode auto" id="trans-mode" title="Click or Press M to Toggle Mode">AUTO</div>
        </div>
        <div class="speed"><span id="speed">0</span><span class="speed-unit">KM/H</span></div>
        <div class="assists-container">
          <div class="assist-pill active" id="tc-pill"><span class="assist-dot"></span>TC</div>
          <div class="assist-pill active" id="abs-pill"><span class="assist-dot"></span>ABS</div>
        </div>
        <div class="pedals">
          <div class="pedal-bar pedal-throttle"><div class="pedal-fill" id="throttle-bar"></div></div>
        </div>
      </div>
    </div>

    <div class="cam-mode" id="cam-mode">CHASE</div>

    <div class="damage-bar">
      <div class="damage-fill" id="damage-bar"></div>
    </div>

    <div class="hud-panel hud-telemetry">
      <div class="tires" id="tires">
        <div class="tire fl"><div class="tire-fill"></div><div class="tire-slip"></div></div>
        <div class="tire fr"><div class="tire-fill"></div><div class="tire-slip"></div></div>
        <div class="tire rl"><div class="tire-fill"></div><div class="tire-slip"></div></div>
        <div class="tire rr"><div class="tire-fill"></div><div class="tire-slip"></div></div>
      </div>
      <div class="g-meter">
        <div class="g-dot" id="g-dot"></div>
      </div>
    </div>

    <div class="overlay-center" id="overlay"></div>
  `;

  const rpmLeds = el.querySelectorAll('.rpm-led');
  const gearEl = el.querySelector('#gear');
  const transModeEl = el.querySelector('#trans-mode');
  const shiftHelperEl = el.querySelector('#shift-helper');
  const tcPillEl = el.querySelector('#tc-pill');
  const absPillEl = el.querySelector('#abs-pill');
  const speedEl = el.querySelector('#speed');
  const throttleBar = el.querySelector('#throttle-bar');
  const brakeBar = el.querySelector('#brake-bar');
  const posEl = el.querySelector('.pos');
  const lapEl = el.querySelector('.lap');
  const currentTimeEl = el.querySelector('.current-time');
  const bestTimeEl = el.querySelector('.best-time');
  const lastTimeEl = el.querySelector('.last-time');
  const deltaEl = el.querySelector('.delta');
  const minimapCanvas = el.querySelector('.minimap-canvas');
  const ctx = minimapCanvas.getContext('2d');
  const camModeEl = el.querySelector('#cam-mode');
  const damageBar = el.querySelector('#damage-bar');
  const gDot = el.querySelector('#g-dot');
  const overlay = el.querySelector('#overlay');

  const spotterLeft = el.querySelector('#spotter-left');
  const spotterLeftDist = el.querySelector('#spotter-left-dist');
  const spotterRight = el.querySelector('#spotter-right');
  const spotterRightDist = el.querySelector('#spotter-right-dist');
  const spotterRear = el.querySelector('#spotter-rear');
  const spotterRearDist = el.querySelector('#spotter-rear-dist');
  
  const tireFills = Array.from(el.querySelectorAll('.tire-fill'));
  const tireSlips = Array.from(el.querySelectorAll('.tire-slip'));

  let lapStartTime = 0;
  let currentLap = -1;
  let trackBounds = null;

  function updateSpotter(spotterEl, distEl, dist) {
    if (dist < Infinity && dist <= 6.5) {
      spotterEl.classList.add('active');
      distEl.innerText = `${dist.toFixed(1)}m`;
      if (dist < 2.8) {
        spotterEl.classList.remove('warning');
        spotterEl.classList.add('critical');
      } else {
        spotterEl.classList.remove('critical');
        spotterEl.classList.add('warning');
      }
    } else {
      spotterEl.classList.remove('active', 'warning', 'critical');
      distEl.innerText = '';
    }
  }

  return {
    update(state) {
      if (!state) return;

      if (state.mode === 'countdown') {
        const cd = Math.ceil(state.countdown);
        overlay.innerHTML = `<div class="countdown">${cd > 0 ? cd : 'GO!'}</div>`;
      } else if (state.mode === 'results') {
        overlay.innerHTML = `<div class="finish-banner">FINISH</div>`;
      } else {
        overlay.innerHTML = '';
      }

      camModeEl.innerText = (state.cameraMode || 'CHASE').toUpperCase();

      const p = state.player;
      if (!p) return;

      // Speed, Gear, Transmission Mode
      speedEl.innerText = Math.abs(Math.round(p.speedKph || 0));
      let gStr = p.gear === 0 ? 'N' : p.gear === -1 ? 'R' : p.gear;
      gearEl.innerText = gStr;

      const isAuto = p.autoShift !== false;
      transModeEl.innerText = isAuto ? 'AUTO' : 'MAN';
      transModeEl.className = 'trans-mode ' + (isAuto ? 'auto' : 'man');
      
      const maxRpm = p.setup?.redline || 9000;
      const rpm = p.rpm || 0;
      const shiftPoint = maxRpm * 0.93; // ~8370 RPM
      const atRedline = rpm >= shiftPoint;
      
      // Shift indicator & Redline flash
      if (atRedline) {
        gearEl.classList.add('shift-flash');
        if (!isAuto) {
          shiftHelperEl.classList.add('visible');
        } else {
          shiftHelperEl.classList.remove('visible');
        }
      } else {
        gearEl.classList.remove('shift-flash');
        shiftHelperEl.classList.remove('visible');
      }

      const rpmRatio = Math.max(0, Math.min(1, rpm / maxRpm));
      const activeLeds = Math.floor(rpmRatio * rpmLeds.length);
      rpmLeds.forEach((led, i) => {
        led.className = 'rpm-led';
        if (i < activeLeds) {
          led.classList.add('on');
          if (atRedline) led.classList.add('blue', 'flash');
          else if (i > rpmLeds.length * 0.8) led.classList.add('red');
          else if (i > rpmLeds.length * 0.5) led.classList.add('yellow');
          else led.classList.add('green');
        }
      });

      const throttle = p.input?.throttle || 0;
      const brake = p.input?.brake || 0;
      throttleBar.style.height = (throttle * 100) + '%';
      brakeBar.style.height = (brake * 100) + '%';

      // TC & ABS assist indicator status & intervention detection
      const tcEnabled = p.tcEnabled !== false && p.tc !== false;
      const absEnabled = p.absEnabled !== false && p.abs !== false;

      // TC intervention: throttle applied + rear wheel slip
      const rearWheels = p.wheels && p.wheels.length === 4 ? [p.wheels[2], p.wheels[3]] : [];
      const tcIntervening = tcEnabled && (
        p.tcIntervening ||
        (throttle > 0.15 && rearWheels.some(w => Math.abs(w.slipRatio) > 0.18 || Math.abs(w.slipAngle) > 0.22))
      );

      // ABS intervention: brake applied + wheel lockup / negative slip
      const absIntervening = absEnabled && (
        p.absIntervening ||
        (brake > 0.2 && p.wheels && p.wheels.some(w => w.slipRatio < -0.16 || Math.abs(w.slipRatio) > 0.22))
      );

      if (!tcEnabled) {
        tcPillEl.className = 'assist-pill off';
      } else if (tcIntervening) {
        tcPillEl.className = 'assist-pill active intervening';
      } else {
        tcPillEl.className = 'assist-pill active';
      }

      if (!absEnabled) {
        absPillEl.className = 'assist-pill off';
      } else if (absIntervening) {
        absPillEl.className = 'assist-pill active intervening';
      } else {
        absPillEl.className = 'assist-pill active';
      }

      // Proximity Spotter Radar
      if (state.cars && state.cars.length > 1) {
        let minLeftDist = Infinity;
        let minRightDist = Infinity;
        let minRearDist = Infinity;

        const cosH = Math.cos(p.heading || 0);
        const sinH = Math.sin(p.heading || 0);

        for (let i = 0; i < state.cars.length; i++) {
          const c = state.cars[i];
          if (c === p) continue;
          const cpos = c.pos || c.position;
          if (!cpos) continue;

          const dx = cpos.x - p.pos.x;
          const dz = cpos.z - p.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 12) continue; // outside radar range

          // Local frame conversion
          const localForward = dx * cosH - dz * sinH;
          const localLeft = -(dx * sinH + dz * cosH);

          // Left alongside (within lateral 0.6m - 5.2m, longitudinal -5.5m - 4.5m)
          if (localLeft > 0.6 && localLeft < 5.2 && localForward > -5.5 && localForward < 4.5) {
            if (dist < minLeftDist) minLeftDist = dist;
          }
          // Right alongside (within lateral -5.2m - -0.6m, longitudinal -5.5m - 4.5m)
          if (localLeft < -0.6 && localLeft > -5.2 && localForward > -5.5 && localForward < 4.5) {
            if (dist < minRightDist) minRightDist = dist;
          }
          // Rear warning (within lateral +-3.2m, longitudinal -8.0m - -0.5m)
          if (localForward >= -8.0 && localForward <= -0.5 && Math.abs(localLeft) < 3.2) {
            if (dist < minRearDist) minRearDist = dist;
          }
        }

        updateSpotter(spotterLeft, spotterLeftDist, minLeftDist);
        updateSpotter(spotterRight, spotterRightDist, minRightDist);
        updateSpotter(spotterRear, spotterRearDist, minRearDist);
      } else {
        updateSpotter(spotterLeft, spotterLeftDist, Infinity);
        updateSpotter(spotterRight, spotterRightDist, Infinity);
        updateSpotter(spotterRear, spotterRearDist, Infinity);
      }

      // Timing
      if (p.lap !== currentLap) {
        currentLap = p.lap || 1;
        lapStartTime = state.time || 0;
      }
      
      let totalLaps = 5;
      if (state.race && state.race.laps) totalLaps = state.race.laps;
      
      posEl.innerHTML = `P${p.place || 1} <span style="font-size:14px;color:#aaa">/ ${state.cars ? state.cars.length : 1}</span>`;
      lapEl.innerHTML = `L${currentLap} <span style="font-size:14px;color:#aaa">/ ${totalLaps}</span>`;
      
      let elapsed = (state.time || 0) - lapStartTime;
      if (state.mode === 'countdown' || state.mode === 'loading') elapsed = 0;
      
      currentTimeEl.innerText = formatTime(elapsed);
      bestTimeEl.innerText = formatTime(p.bestLap);
      lastTimeEl.innerText = formatTime(p.lastLap);

      if (p.bestLap && p.bestLap > 0 && state.track && state.track.length) {
        let expectedTime = p.bestLap * ((p.progressS || 0) / state.track.length);
        let delta = elapsed - expectedTime;
        let sign = delta >= 0 ? '+' : '';
        deltaEl.innerText = `${sign}${delta.toFixed(2)}`;
        deltaEl.className = 'delta ' + (delta < -0.5 ? 'purple' : delta < 0 ? 'negative' : 'positive');
      } else {
        deltaEl.innerText = '+0.00';
        deltaEl.className = 'delta';
      }

      // Damage
      damageBar.style.width = Math.min(100, (p.damage || 0) * 100) + '%';

      // G-Meter
      const ax = p._ax || 0; // longitudinal accel
      const ay = p._ay || 0; // lateral accel
      // Scale: 20 m/s^2 ~ 2.0g
      let gx = Math.max(-1, Math.min(1, ay / 20)); 
      let gy = Math.max(-1, Math.min(1, ax / 20));
      gDot.style.left = (50 + gx * 45) + '%';
      gDot.style.top = (50 - gy * 45) + '%'; // positive ax moves dot up

      // Tires
      if (p.wheels && p.wheels.length === 4) {
        p.wheels.forEach((w, i) => {
          if (!tireFills[i]) return;
          const temp = Math.min(1, w.slipAngle / 0.5);
          const color = temp > 0.8 ? '#f00' : temp > 0.5 ? '#ff0' : '#0f0';
          tireFills[i].style.background = color;
          // opacity based on load
          tireFills[i].style.opacity = Math.max(0.2, Math.min(1, w.load / 5000));
          tireSlips[i].style.borderColor = !w.onTrack ? '#8b4513' : 'transparent';
        });
      }

      // Minimap
      if (state.track && state.track.samples && state.track.samples.length > 0) {
        ctx.clearRect(0, 0, 200, 200);
        
        if (!trackBounds) {
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          state.track.samples.forEach(s => {
            minX = Math.min(minX, s.pos.x);
            maxX = Math.max(maxX, s.pos.x);
            minZ = Math.min(minZ, s.pos.z);
            maxZ = Math.max(maxZ, s.pos.z);
          });
          trackBounds = { minX, maxX, minZ, maxZ };
          trackBounds.w = maxX - minX;
          trackBounds.h = maxZ - minZ;
          trackBounds.scale = 160 / Math.max(trackBounds.w, trackBounds.h); // 20px padding
        }

        const toMap = (x, z) => {
          return {
            x: 100 + (x - (trackBounds.minX + trackBounds.w/2)) * trackBounds.scale,
            y: 100 + (z - (trackBounds.minZ + trackBounds.h/2)) * trackBounds.scale
          };
        };

        // Draw track
        ctx.beginPath();
        state.track.samples.forEach((s, i) => {
          const pt = toMap(s.pos.x, s.pos.z);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.closePath();
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 6;
        ctx.stroke();

        ctx.strokeStyle = '#888';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Draw Start/Finish
        const sf = toMap(state.track.samples[0].pos.x, state.track.samples[0].pos.z);
        ctx.fillStyle = '#fff';
        ctx.fillRect(sf.x - 3, sf.y - 3, 6, 6);

        // Draw Cars
        if (state.cars) {
          state.cars.forEach((c) => {
            const isPlayer = c === p;
            const pos = c.pos || c.position;
            const px = pos ? pos.x : 0;
            const pz = pos ? pos.z : 0;
            const pt = toMap(px, pz);
            
            if (isPlayer) {
              // Arrow for player
              ctx.save();
              ctx.translate(pt.x, pt.y);
              ctx.rotate(-(c.heading || 0));
              ctx.fillStyle = '#ff2222';
              ctx.beginPath();
              ctx.moveTo(0, -7);
              ctx.lineTo(5, 5);
              ctx.lineTo(-5, 5);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            } else {
              const hex = c.colorHex != null ? '#' + Number(c.colorHex).toString(16).padStart(6, '0') : '#00ddff';
              ctx.fillStyle = hex;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
              ctx.fill();
            }
          });
        }
      }
    }
  };
}
