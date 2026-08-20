// src/ui/debugPanel.js
import './debugPanel.css';

function formatTime(s) {
  if (!s || s <= 0) return '00:00.0';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms}`;
}

const BADGE_CLASSES = {
  YOU: 'badge-you',
  VIPER: 'badge-viper',
  SURGEON: 'badge-surgeon',
  WALL: 'badge-wall',
  ROCKET: 'badge-rocket',
  ROOKIE: 'badge-rookie',
};

const STATE_CLASSES = {
  CRUISING: 'state-cruising',
  DRAFTING: 'state-drafting',
  DEFENDING: 'state-defending',
  SLINGSHOT: 'state-slingshot',
  DIVEBOMB: 'state-divebomb',
  MISTAKE: 'state-mistake',
};

export function createDebugPanel(container, game) {
  let isPanelVisible = false;

  const panel = document.createElement('div');
  panel.id = 'apex-debug-panel';
  panel.className = 'hidden';

  panel.innerHTML = `
    <!-- Header -->
    <div class="debug-header">
      <div class="debug-title-area">
        <div class="debug-title">
          <span class="debug-title-icon"></span>
          APEX // FLEET TELEMETRY & 3D DEBUG INSPECTOR
        </div>
        <div class="debug-stats-bar">
          <div class="debug-stat-chip">FPS: <strong id="debug-fps">60</strong></div>
          <div class="debug-stat-chip">SESSION: <strong id="debug-time">00:00.0</strong></div>
          <div class="debug-stat-chip">GRID: <strong id="debug-grid">6 CARS</strong></div>
        </div>
      </div>
      <div class="debug-header-actions">
        <div class="debug-shortcut-hint">TOGGLE <kbd>U</kbd> / <kbd>\`</kbd></div>
        <button class="debug-close-btn" id="debug-close-btn" title="Close Inspector">✕</button>
      </div>
    </div>

    <!-- Layer Filter Controls -->
    <div class="debug-toolbar">
      <div class="debug-layer-group">
        <span class="debug-layer-label">3D Visualizer Layers:</span>
        <label class="debug-checkbox-label">
          <input type="checkbox" id="layer-racingLine" checked />
          <span class="layer-tag line"></span> 3D Racing Line
        </label>
        <label class="debug-checkbox-label">
          <input type="checkbox" id="layer-lookahead" checked />
          <span class="layer-tag rays"></span> Lookahead Rays & Targets
        </label>
        <label class="debug-checkbox-label">
          <input type="checkbox" id="layer-tireVectors" checked />
          <span class="layer-tag vectors"></span> 3D Tire Force Vectors
        </label>
        <label class="debug-checkbox-label">
          <input type="checkbox" id="layer-draftCones" checked />
          <span class="layer-tag draft"></span> Slipstream Draft Cones
        </label>
        <label class="debug-checkbox-label">
          <input type="checkbox" id="layer-overheadTags" checked />
          <span class="layer-tag tags"></span> Overhead 3D Tags
        </label>
      </div>
      <div class="debug-quick-toggles">
        <button class="debug-btn-mini" id="btn-layers-all">ALL ON</button>
        <button class="debug-btn-mini" id="btn-layers-none">ALL OFF</button>
      </div>
    </div>

    <!-- Live Telemetry Inspector Table -->
    <div class="debug-table-container">
      <table class="debug-table">
        <thead>
          <tr>
            <th style="width: 45px;">POS</th>
            <th style="width: 80px;">BADGE</th>
            <th style="width: 170px;">DRIVER</th>
            <th style="width: 120px;">STATE</th>
            <th style="width: 140px;">SPEED (ACT/TGT)</th>
            <th class="gauge-cell">THROTTLE</th>
            <th class="gauge-cell">BRAKE</th>
            <th class="gauge-cell">STEER</th>
            <th style="width: 130px;">REAR SLIP (RL/RR)</th>
            <th style="width: 95px;">SLIP ANGLE</th>
            <th style="width: 130px;">LAP / PROGRESS</th>
          </tr>
        </thead>
        <tbody id="debug-table-body">
        </tbody>
      </table>
    </div>
  `;

  container.appendChild(panel);

  // Cache elements
  const fpsEl = panel.querySelector('#debug-fps');
  const timeEl = panel.querySelector('#debug-time');
  const gridEl = panel.querySelector('#debug-grid');
  const tbodyEl = panel.querySelector('#debug-table-body');
  const closeBtn = panel.querySelector('#debug-close-btn');

  const layerCheckboxes = {
    racingLine: panel.querySelector('#layer-racingLine'),
    lookahead: panel.querySelector('#layer-lookahead'),
    tireVectors: panel.querySelector('#layer-tireVectors'),
    draftCones: panel.querySelector('#layer-draftCones'),
    overheadTags: panel.querySelector('#layer-overheadTags'),
  };

  // Wire Layer Checkboxes
  Object.keys(layerCheckboxes).forEach((key) => {
    const cb = layerCheckboxes[key];
    if (cb) {
      cb.addEventListener('change', () => {
        if (game && game.debugVisualizer && game.debugVisualizer.setLayerVisibility) {
          game.debugVisualizer.setLayerVisibility(key, cb.checked);
        }
      });
    }
  });

  // Quick Action Buttons
  const btnAll = panel.querySelector('#btn-layers-all');
  const btnNone = panel.querySelector('#btn-layers-none');

  if (btnAll) {
    btnAll.addEventListener('click', () => {
      Object.keys(layerCheckboxes).forEach((k) => {
        layerCheckboxes[k].checked = true;
        if (game && game.debugVisualizer && game.debugVisualizer.setLayerVisibility) {
          game.debugVisualizer.setLayerVisibility(k, true);
        }
      });
    });
  }

  if (btnNone) {
    btnNone.addEventListener('click', () => {
      Object.keys(layerCheckboxes).forEach((k) => {
        layerCheckboxes[k].checked = false;
        if (game && game.debugVisualizer && game.debugVisualizer.setLayerVisibility) {
          game.debugVisualizer.setLayerVisibility(k, false);
        }
      });
    });
  }

  closeBtn.addEventListener('click', () => {
    hide();
  });

  // Telemetry Rows Cache
  const rowElements = new Map();

  function getCarState(car) {
    if (car.isPlayer) {
      if (car.speed < 1) return { state: 'IDLE', css: 'CRUISING' };
      if (car.input.brake > 0.5) return { state: 'BRAKING', css: 'DIVEBOMB' };
      if (car.input.throttle > 0.8) return { state: 'FULL THROTTLE', css: 'SLINGSHOT' };
      const rearSlip = Math.max(Math.abs(car.wheels?.[2]?.slipRatio || 0), Math.abs(car.wheels?.[3]?.slipRatio || 0));
      if (rearSlip > 0.2) return { state: 'SLIPPING', css: 'MISTAKE' };
      return { state: 'CRUISING', css: 'CRUISING' };
    }

    const d = car._aiDriver;
    if (!d) return { state: 'CRUISING', css: 'CRUISING' };

    if (d.mistakeType) {
      return { state: `MISTAKE (${d.mistakeType})`, css: 'MISTAKE' };
    }
    if (d.divebombActive) {
      return { state: 'DIVEBOMB', css: 'DIVEBOMB' };
    }
    if (d.slingshotActive) {
      return { state: 'SLINGSHOT', css: 'SLINGSHOT' };
    }
    if (Math.abs(d.defendLat || 0) > 0.25) {
      return { state: 'DEFENDING', css: 'DEFENDING' };
    }
    if ((d.draftTimer || 0) > 0.2) {
      return { state: 'DRAFTING', css: 'DRAFTING' };
    }
    return { state: 'CRUISING', css: 'CRUISING' };
  }

  function getTargetSpeedKph(car, track) {
    if (!track) return 0;
    const line = track._racingLine;
    if (!line || !line.vT || !track.samples) return 0;

    const t = ((car.progressS || 0) % track.length + track.length) % track.length;
    const S = track.samples;
    let lo = 0, hi = S.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].s < t) lo = m + 1; else hi = m; }
    const i = lo, j = (i + 1) % S.length;
    const f = Math.max(0, Math.min(1, (t - S[i].s) / Math.max(S[j].s - S[i].s, 0.1)));
    const targetMs = line.vT[i] + (line.vT[j] - line.vT[i]) * f;
    return Math.round(targetMs * 3.6);
  }

  function ensureRow(car) {
    if (rowElements.has(car.id)) return rowElements.get(car.id);

    const tr = document.createElement('tr');
    tr.className = `debug-row ${car.isPlayer ? 'player-row' : ''}`;

    tr.innerHTML = `
      <td><span class="pos-pill">P1</span></td>
      <td><span class="car-badge badge-you">YOU</span></td>
      <td><div class="driver-name">Driver Name</div></td>
      <td><span class="state-pill state-cruising">CRUISING</span></td>
      <td class="speed-cell">
        <span class="speed-act">0</span><span class="speed-sep">/</span><span class="speed-tgt">0</span>
        <span class="speed-delta-fast"></span>
      </td>
      <td class="gauge-cell">
        <div class="gauge-bar-bg"><div class="gauge-fill-throttle" style="width: 0%;"></div></div>
      </td>
      <td class="gauge-cell">
        <div class="gauge-bar-bg"><div class="gauge-fill-brake" style="width: 0%;"></div></div>
      </td>
      <td class="gauge-cell">
        <div class="gauge-steer-bg">
          <div class="gauge-steer-center"></div>
          <div class="gauge-steer-fill" style="left: 50%; width: 0%;"></div>
        </div>
      </td>
      <td class="slip-cell"><span class="slip-val slip-good">0.0% / 0.0%</span></td>
      <td class="slip-cell"><span class="slip-val slip-good">0.0°</span></td>
      <td class="prog-cell"><span class="prog-lap">L1</span><span class="prog-s">0m (0%)</span></td>
    `;

    tbodyEl.appendChild(tr);

    const refs = {
      row: tr,
      pos: tr.querySelector('.pos-pill'),
      badge: tr.querySelector('.car-badge'),
      name: tr.querySelector('.driver-name'),
      state: tr.querySelector('.state-pill'),
      speedAct: tr.querySelector('.speed-act'),
      speedTgt: tr.querySelector('.speed-tgt'),
      speedDelta: tr.querySelector('.speed-delta-fast'),
      throttleFill: tr.querySelector('.gauge-fill-throttle'),
      brakeFill: tr.querySelector('.gauge-fill-brake'),
      steerFill: tr.querySelector('.gauge-steer-fill'),
      rearSlip: tr.querySelector('.slip-val'),
      slipAngle: tr.querySelectorAll('.slip-val')[1],
      progLap: tr.querySelector('.prog-lap'),
      progS: tr.querySelector('.prog-s'),
    };

    rowElements.set(car.id, refs);
    return refs;
  }

  function update(dt, state) {
    if (!state) return;

    if (!isPanelVisible) return;

    // Header stats
    fpsEl.innerText = state.fps || 60;
    timeEl.innerText = formatTime(state.time || 0);
    gridEl.innerText = `${(state.cars || []).length} CARS`;

    const track = state.track || game.track;
    const cars = state.cars || game.cars || [];

    // Sort by race position for clean live leader ordering
    const sortedCars = [...cars].sort((a, b) => (a.place || 99) - (b.place || 99));

    // Reorder DOM rows if needed
    sortedCars.forEach((car) => {
      const refs = ensureRow(car);
      tbodyEl.appendChild(refs.row);

      // Pos
      const place = car.place || 1;
      refs.pos.innerText = `P${place}`;
      refs.pos.className = `pos-pill ${place === 1 ? 'p1' : place === 2 ? 'p2' : place === 3 ? 'p3' : ''}`;

      // Badge
      const badge = car.badge || (car.isPlayer ? 'YOU' : 'AI');
      refs.badge.innerText = badge;
      const badgeCls = BADGE_CLASSES[badge] || 'badge-you';
      refs.badge.className = `car-badge ${badgeCls}`;

      // Name
      refs.name.innerText = car.name || (car.isPlayer ? 'You (Player)' : 'AI Driver');

      // State
      const st = getCarState(car);
      refs.state.innerText = st.state;
      const stateCls = STATE_CLASSES[st.css] || 'state-cruising';
      refs.state.className = `state-pill ${stateCls}`;

      // Speed vs Target
      const actKph = Math.round(car.speedKph || (car.speed * 3.6) || 0);
      const tgtKph = getTargetSpeedKph(car, track);
      refs.speedAct.innerText = `${actKph}`;
      refs.speedTgt.innerText = `${tgtKph} km/h`;

      const delta = actKph - tgtKph;
      if (Math.abs(delta) > 3) {
        refs.speedDelta.innerText = delta > 0 ? `+${delta}` : `${delta}`;
        refs.speedDelta.className = delta > 0 ? 'speed-delta-fast' : 'speed-delta-slow';
      } else {
        refs.speedDelta.innerText = '';
      }

      // Gauges
      const thr = Math.max(0, Math.min(1, car.input?.throttle || 0));
      const brk = Math.max(0, Math.min(1, car.input?.brake || 0));
      const str = Math.max(-1, Math.min(1, car.input?.steer || 0));

      refs.throttleFill.style.width = `${(thr * 100).toFixed(0)}%`;
      refs.brakeFill.style.width = `${(brk * 100).toFixed(0)}%`;

      if (str >= 0) {
        refs.steerFill.style.left = '50%';
        refs.steerFill.style.width = `${(str * 50).toFixed(0)}%`;
      } else {
        const w = -str * 50;
        refs.steerFill.style.left = `${(50 - w).toFixed(0)}%`;
        refs.steerFill.style.width = `${w.toFixed(0)}%`;
      }

      // Rear Slip Ratio (RL / RR)
      const wRL = car.wheels ? car.wheels[2] : null;
      const wRR = car.wheels ? car.wheels[3] : null;
      const rlSlip = wRL ? wRL.slipRatio : 0;
      const rrSlip = wRR ? wRR.slipRatio : 0;
      const maxSlip = Math.max(Math.abs(rlSlip), Math.abs(rrSlip));

      refs.rearSlip.innerText = `${(rlSlip * 100).toFixed(1)}% / ${(rrSlip * 100).toFixed(1)}%`;
      refs.rearSlip.className = `slip-val ${maxSlip > 0.25 ? 'slip-high' : maxSlip > 0.12 ? 'slip-med' : 'slip-good'}`;

      // Rear Slip Angle (deg)
      const rlAngle = wRL ? Math.abs(wRL.slipAngle) : 0;
      const rrAngle = wRR ? Math.abs(wRR.slipAngle) : 0;
      const maxAngleDeg = (Math.max(rlAngle, rrAngle) * (180 / Math.PI)).toFixed(1);
      refs.slipAngle.innerText = `${maxAngleDeg}°`;
      refs.slipAngle.className = `slip-val ${maxAngleDeg > 12 ? 'slip-high' : maxAngleDeg > 6 ? 'slip-med' : 'slip-good'}`;

      // Lap & Progress
      const lap = car.lap || 1;
      const progS = Math.round(car.progressS || 0);
      const trackLen = track ? track.length : 1000;
      const progPct = Math.round(((car.progressS || 0) / trackLen) * 100);

      refs.progLap.innerText = `L${lap}`;
      refs.progS.innerText = `${progS}m (${progPct}%)`;
    });
  }

  function show() {
    isPanelVisible = true;
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    // Notify HUD button
    const hudDebugBtn = document.querySelector('#hud-debug-btn');
    if (hudDebugBtn) hudDebugBtn.classList.add('active');
  }

  function hide() {
    isPanelVisible = false;
    panel.classList.remove('visible');
    panel.classList.add('hidden');
    // Notify HUD button
    const hudDebugBtn = document.querySelector('#hud-debug-btn');
    if (hudDebugBtn) hudDebugBtn.classList.remove('active');
  }

  function toggle() {
    if (isPanelVisible) hide();
    else show();
  }

  function isVisible() {
    return isPanelVisible;
  }

  function dispose() {
    window.removeEventListener('apex:toggle-debug', onToggleDebug);
    if (panel.parentNode) panel.parentNode.removeChild(panel);
  }

  // Listen for custom toggle events
  const onToggleDebug = () => {
    toggle();
  };
  window.addEventListener('apex:toggle-debug', onToggleDebug);

  return {
    panel,
    update,
    show,
    hide,
    toggle,
    isVisible,
    dispose,
  };
}
