const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return '--:--.---';
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const remainder = Math.max(0, seconds) - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
};

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const fixed = (value, digits = 2) => finite(value).toFixed(digits);
const percent = (value) => `${Math.round(finite(value) * 100)}%`;
const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const wheelCard = (name) => `<article class="telemetry-wheel" data-wheel="${name}">
  <strong>${name}</strong><span data-field="temp">-- / -- / --°C</span><span data-field="pressure">--.-- BAR</span>
  <span data-field="slip">κ --.-- α --.-°</span><i><em data-field="travel"></em></i>
</article>`;

const standingsMarkup = (rows, playerId) => rows.map((row) => {
  const gap = finite(row.distanceGapM);
  const gapLabel = Math.abs(gap) < 0.05 ? '—' : `${gap > 0 ? '+' : ''}${gap.toFixed(1)}M`;
  const selected = row.id === playerId ? ' player' : '';
  const finished = row.finished ? ' finished' : '';
  return `<div class="standings-row${selected}${finished}">
    <b>${String(row.position).padStart(2, '0')}</b><span>${escapeHtml(row.name)}</span><small>${escapeHtml(row.classKey ?? '—')}</small><em>${gapLabel}</em>
  </div>`;
}).join('');

export class HUD {
  constructor(onMute) {
    this.telemetryVisible = false;
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <header class="session-bar">
        <div class="hud-brand">APEX<i>//</i>73<small>EXTREME DYNAMICS</small></div>
        <div class="session-stats">
          <div><small>POS</small><strong data-role="position">P01</strong></div>
          <div><small>LAP</small><strong data-role="lap">1/3</strong></div>
          <div><small>RACE TIME</small><strong data-role="race-time">00:00.000</strong></div>
          <div><small>PHASE</small><strong data-role="phase">GRID</strong></div>
        </div>
      </header>

      <div class="countdown hidden" data-role="countdown">GRID</div>
      <div class="notice" data-role="notice">SELECT CLASS · PRESS ENTER TO START</div>

      <section class="hud-panel standings-panel" data-role="standings-panel">
        <header><b>LIVE ORDER</b><span>GAP / M</span></header>
        <div data-role="standings-rows"></div>
      </section>

      <section class="hud-panel electronics-panel">
        <header><b>ELECTRONICS</b><span>ACTIVE</span></header>
        <div class="electronics-grid">
          <article><small>TC</small><strong data-role="tc">0</strong><i data-role="tc-light"></i></article>
          <article><small>ABS</small><strong data-role="abs">0</strong><i data-role="abs-light"></i></article>
          <article><small>BB</small><strong data-role="bias">57.0%</strong></article>
        </div>
        <article class="ers-card" data-role="ers">
          <div><small>ERS <b data-role="ers-mode">OFF</b></small><strong data-role="ers-state">STANDBY</strong></div>
          <div class="bar"><i data-role="ers-fill"></i></div>
          <div class="ers-values"><span data-role="ers-soc">—%</span><span data-role="ers-power">0 KW</span></div>
        </article>
      </section>

      <section class="hud-panel ai-panel" data-role="ai-panel">
        <header><b>AI PLANNER // F3 · FIELD F4</b><span data-role="ai-selection">N NEXT AI</span><span data-role="ai-field">SELECTED</span></header>
        <div class="ai-driver"><strong data-role="ai-name">—</strong><span data-role="ai-class">—</span></div>
        <div class="ai-intent"><b data-role="ai-mode">OFF</b><span data-role="ai-reason">DEBUG DISARMED</span></div>
        <div class="ai-grid">
          <span>SPEED <b data-role="ai-speed">—</b></span><span>TARGET <b data-role="ai-target-speed">—</b></span>
          <span>OFFSET <b data-role="ai-offset">—</b></span><span>LINE <b data-role="ai-line">—</b></span>
          <span>GAPS <b data-role="ai-gaps">—</b></span><span>SIDE <b data-role="ai-side">—</b></span>
          <span>THREAT <b data-role="ai-threat">CLEAR</b></span><span>TTC <b data-role="ai-ttc">—</b></span>
        </div>
        <div class="ai-controls" data-role="ai-controls">S — · T — · B —</div>
        <div class="ai-thought">
          <div><small>PLANNER INTENT</small><b data-role="ai-request">—</b></div>
          <div><small>TACTICAL BASIS</small><b data-role="ai-alternatives">—</b></div>
          <div><small>PLANNER DEPLOYED</small><b data-role="ai-deployed">—</b></div>
          <div><small>TARGET / COMMIT</small><b data-role="ai-commit">—</b></div>
          <div><small>CORRIDOR</small><b data-role="ai-corridor">—</b></div>
          <div><small>SAFETY VERDICT</small><b data-role="ai-safety">—</b></div>
          <div><small>WAIT / ABORT</small><b data-role="ai-rejection">—</b></div>
          <div><small>PACE / ERS</small><b data-role="ai-energy">—</b></div>
        </div>
        <div class="ai-footer"><span data-role="ai-skill">SKILL — · AGG —</span><span>LINES = REACTIVE PLAN</span></div>
      </section>

      <section class="hud-panel motec" data-role="motec">
        <header><b>MoTeC // LIVE</b><span data-role="gg">+0.00 LAT · +0.00 LONG</span></header>
        <div class="gg"><i data-role="gg-dot"></i></div>
        <div class="wheel-grid">${['FL', 'FR', 'RL', 'RR'].map(wheelCard).join('')}</div>
      </section>

      <section class="driver-cluster">
        <div class="speed-readout"><strong data-role="speed">000</strong><span>KM/H</span></div>
        <div class="input-stack">
          <div class="input-bar"><span>THR</span><i><em data-role="throttle"></em></i><b data-role="throttle-value">0%</b></div>
          <div class="input-bar brake"><span>BRK</span><i><em data-role="brake"></em></i><b data-role="brake-value">0%</b></div>
        </div>
      </section>

      <section class="gear-cluster">
        <strong data-role="gear">1</strong>
        <div class="rpm-bar"><i data-role="rpm"></i></div>
        <span data-role="rpm-label">1,100 RPM</span>
        <span data-role="gearbox-mode">AUTO</span>
      </section>

      <div class="telemetry-strip">
        <span>FPS <b data-role="fps">--</b></span><span>PHYS <b data-role="physics">120HZ</b></span>
        <span>GRIP <b data-role="grip">ROAD</b></span><span>RUBBER <b data-role="rubber">0%</b></span>
        <span>TOW <b data-role="tow">0%</b></span><span>DIRTY <b data-role="dirty">0%</b></span>
        <span>PIT <b data-role="pit">NONE</b></span>
        <span>STEER <b data-role="steer">—</b></span><span>G <b data-role="gforce">0.00</b></span>
        <span>REF <b data-role="reference">IDLE</b></span>
      </div>

      <div class="help">WASD / ARROWS DRIVE · SPACE HANDBRAKE · C CAMERA · T TELEMETRY · P PIT REQUEST<br>G AUTO/MANUAL · , DOWNSHIFT · . UPSHIFT · [ / ] TC · ; / ' ABS · B BRAKE BIAS · E ERS · R RESET · M MUTE · F3 AI DEBUG · F4 FIELD · N NEXT AI · F5 SPECTATE · F6 NO-CLIP · F7 REFERENCE LAP</div>
      <button class="mute" data-role="mute" type="button">AUDIO: ON</button>

      <div class="finish" data-role="finish">
        <h1>FINISHED</h1><p>POSITION <b data-role="finish-position">P01</b> · <span data-role="finish-time">00:00.000</span><br><br>PRESS ENTER TO RESTART</p>
      </div>`;
    document.body.append(this.root);
    this.$ = (role) => this.root.querySelector(`[data-role="${role}"]`);
    this.wheelNodes = new Map([...this.root.querySelectorAll('[data-wheel]')].map((node) => [node.dataset.wheel, node]));
    this._standingsSignature = null;
    this._standingsLastRenderAt = Number.NEGATIVE_INFINITY;
    this.$('mute').addEventListener('click', () => this.setMuted(onMute?.() ?? false));
  }

  setTelemetryVisible(visible) {
    this.telemetryVisible = Boolean(visible);
    this.$('motec').classList.toggle('show', this.telemetryVisible);
    return this.telemetryVisible;
  }

  toggleTelemetry() { return this.setTelemetryVisible(!this.telemetryVisible); }
  setRaceActive(active) { this.root.classList.toggle('armed', Boolean(active)); return Boolean(active); }

  _updateTelemetry(vehicle) {
    const telemetry = vehicle.telemetry ?? {};
    const lat = finite(telemetry.lateralG);
    const longitudinal = finite(telemetry.longitudinalG);
    this.$('gg').textContent = `${lat >= 0 ? '+' : ''}${lat.toFixed(2)} LAT · ${longitudinal >= 0 ? '+' : ''}${longitudinal.toFixed(2)} LONG`;
    this.$('gg-dot').style.transform = `translate(${Math.max(-42, Math.min(42, lat * 18))}px, ${Math.max(-42, Math.min(42, -longitudinal * 18))}px)`;
    for (const wheel of vehicle.wheels ?? []) {
      const node = this.wheelNodes.get(wheel.name);
      if (!node) continue;
      node.querySelector('[data-field="temp"]').textContent = `${Math.round(finite(wheel.temperatureInnerC))} / ${Math.round(finite(wheel.temperatureMiddleC))} / ${Math.round(finite(wheel.temperatureOuterC))}°C`;
      node.querySelector('[data-field="pressure"]').textContent = `${(finite(wheel.pressurePa) / 100000).toFixed(2)} BAR`;
      node.querySelector('[data-field="slip"]').textContent = `κ ${fixed(wheel.slipRatio)} α ${(finite(wheel.slipAngle) * 57.2958).toFixed(1)}°`;
      node.querySelector('[data-field="travel"]').style.transform = `scaleX(${Math.max(0.02, Math.min(1, finite(wheel.compression) / Math.max(0.001, finite(vehicle.spec?.suspension?.travel, 0.1))))})`;
    }
  }

  _updateStandings(rows, playerId) {
    const list = Array.isArray(rows) ? rows : [];
    const signature = JSON.stringify([playerId, list.map((row) => [
      row.position, row.id, row.name, row.classKey, row.finished, finite(row.distanceGapM)
    ])]);
    if (signature === this._standingsSignature) return false;
    const now = monotonicNow();
    if (now - this._standingsLastRenderAt < 100) return false;
    this.$('standings-rows').innerHTML = list.length ? standingsMarkup(list, playerId) : '<div class="standings-empty">ORDER DATA PENDING</div>';
    this._standingsSignature = signature;
    this._standingsLastRenderAt = now;
    return true;
  }

  _updateAIDebug(snapshot) {
    const state = snapshot?.state?.vehicleId ? snapshot.state : snapshot?.vehicleId ? snapshot : null;
    const enabled = Boolean(snapshot?.enabled);
    this.$('ai-panel').classList.toggle('show', enabled);
    if (!enabled) return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (now - (this._aiDebugLastRenderAt ?? -Infinity) < 100) return;
    this._aiDebugLastRenderAt = now;
    this.$('ai-name').textContent = snapshot.selectedName ?? state?.name ?? '—';
    this.$('ai-class').textContent = String(state?.classKey ?? state?.class ?? '—').toUpperCase();
    this.$('ai-mode').textContent = state?.mode ?? 'WAIT';
    const thought = state?.thought ?? {};
    this.$('ai-reason').textContent = `${state?.reason ?? 'WAITING FOR AI TELEMETRY'} · GEMINI GAUNTLET`;
    this.$('ai-speed').textContent = state ? `${(finite(state.currentSpeed) * 3.6).toFixed(1)} KM/H` : '—';
    this.$('ai-target-speed').textContent = state ? `${(finite(state.desiredSpeed) * 3.6).toFixed(1)} KM/H` : '—';
    this.$('ai-offset').textContent = state ? `${fixed(state.targetOffset)} M` : '—';
    this.$('ai-line').textContent = state ? `${fixed(state.lineOffset)} M` : '—';
    const front = state?.closeFront;
    const behind = state?.closeBehind;
    this.$('ai-gaps').textContent = front ? `${front.name ?? front.id} ${fixed(front.deltaM, 1)}M` : behind ? `B ${fixed(behind.deltaM, 1)}M` : 'CLEAR';
    const side = state?.nearestSide;
    this.$('ai-side').textContent = side ? `${side.name ?? side.id} ${fixed(side.directM, 1)}M` : 'CLEAR';
    this.$('ai-threat').textContent = String(state?.trafficThreat ?? 'CLEAR');
    const ttc = finite(state?.trafficTTC, 99);
    this.$('ai-ttc').textContent = ttc >= 98 ? '—' : `${ttc.toFixed(2)}S`;
    const controls = state?.controls ?? state?.output;
    this.$('ai-controls').textContent = controls
      ? `S ${fixed(controls.steer)} · T ${fixed(controls.throttle)} · B ${fixed(controls.brake)}` : 'S — · T — · B —';
    this.$('ai-request').textContent = thought.requestedManeuver ?? state?.racecraftPhase ?? state?.mode ?? 'PACE';
    this.$('ai-alternatives').textContent = 'TRACK WIDTH · TIME GAIN · OCCUPANCY · COMMITMENT';
    const deployedManeuver = thought.deployedManeuver && thought.deployedManeuver !== 'NONE'
      ? thought.deployedManeuver : state?.racecraftPhase && state.racecraftPhase !== 'NONE' ? state.racecraftPhase : state?.mode ?? '—';
    this.$('ai-deployed').textContent = `${deployedManeuver} · ${thought.straightSend ? 'STRAIGHT SEND' : thought.committed ? 'COMMITTED' : thought.defending ? 'DEFENDING' : 'REPLANNING'}`;
    this.$('ai-commit').textContent = `${String(thought.targetId ?? state?.passTargetId ?? state?.draftTargetId ?? 'CLEAR').toUpperCase()} · ${finite(state?.passTimer).toFixed(2)}S LIVE`;
    const selectedOffset = finite(thought.trajectorySelectedOffsetM, finite(state?.trajectorySelectedOffsetM));
    const minimumClearance = finite(thought.trajectoryMinimumClearanceM, finite(state?.trajectoryMinimumClearanceM, 99));
    this.$('ai-corridor').textContent = `${fixed(selectedOffset)}M · CLR ${fixed(minimumClearance, 1)}M`;
    const thresholdSafe = Boolean(thought.thresholdSafeTrajectory);
    const safeTrajectory = (Boolean(thought.trajectoryCollisionFree ?? state?.trajectoryCollisionFree) || thresholdSafe)
      && Boolean(thought.trajectoryRoadLegal ?? state?.trajectoryRoadLegal);
    const collisionFree = Boolean(thought.trajectoryCollisionFree ?? state?.trajectoryCollisionFree);
    const roadLegal = Boolean(thought.trajectoryRoadLegal ?? state?.trajectoryRoadLegal);
    this.$('ai-safety').textContent = `${safeTrajectory ? thresholdSafe && !collisionFree ? 'THRESHOLD LEGAL' : 'VALID' : 'REJECTED'} · COLL ${collisionFree ? 'FREE' : 'MARGIN'} · ROAD ${roadLegal ? 'LEGAL' : 'ILLEGAL'}${thought.corridorBlockerId ? ` · ${String(thought.corridorBlockerId).toUpperCase()}` : ''}`;
    this.$('ai-rejection').textContent = thought.abortReason ?? thought.waitReason ?? state?.abortReason ?? state?.waitReason ?? 'NONE';
    this.$('ai-energy').textContent = `CLOSE ${fixed(finite(thought.requestedClosingSpeedMps))}M/S · GAIN ${fixed(thought.predictedTimeGainS, 2)}S`;
    this.$('ai-skill').textContent = state ? `SKILL ${Math.round(finite(state.skill) * 100)} · AGG ${Math.round(finite(state.aggression) * 100)}` : 'SKILL — · AGG —';
    this.$('ai-selection').textContent = 'N NEXT AI';
    this.$('ai-field').textContent = snapshot.fieldView ? 'FIELD' : 'SELECTED';
  }

  update(vehicle, status, perf, cameraMode, raceActive = true, context = {}) {
    const race = status ?? {};
    const performance = perf ?? {};
    this.$('position').textContent = `P${String(race.position ?? 0).padStart(2, '0')}`;
    this.$('lap').textContent = `${race.lap ?? 0}/${race.totalLaps ?? 0}`;
    this.$('race-time').textContent = formatTime(race.raceTime);
    this.$('phase').textContent = String(race.phase ?? 'grid').toUpperCase();
    this.$('speed').textContent = String(Math.round(finite(vehicle.speed) * 3.6)).padStart(3, '0');
    this.$('gear').textContent = vehicle.finished ? '—' : (vehicle.gear ?? 1);
    this.$('gearbox-mode').textContent = vehicle.transmissionMode === 'manual' ? 'MANUAL' : 'AUTO';
    const rpm = Math.round(finite(vehicle.rpm) / 100) * 100;
    this.$('rpm-label').textContent = `${rpm.toLocaleString('en-GB')} RPM`;
    const limiter = Math.max(1500, finite(vehicle.spec?.limiterRpm, 7700));
    const idle = Math.min(limiter - 1, Math.max(0, finite(vehicle.spec?.idleRpm, 900)));
    this.$('rpm').style.transform = `scaleX(${Math.max(0.04, Math.min(1, (finite(vehicle.rpm) - idle) / (limiter - idle)))})`;
    const throttle = Math.max(0, Math.min(1, finite(vehicle.controls?.throttle)));
    const brake = Math.max(0, Math.min(1, finite(vehicle.controls?.brake)));
    this.$('throttle').style.transform = `scaleX(${throttle})`;
    this.$('brake').style.transform = `scaleX(${brake})`;
    this.$('throttle-value').textContent = percent(throttle);
    this.$('brake-value').textContent = percent(brake);
    this.$('fps').textContent = finite(performance.fps).toFixed(0);
    this.$('physics').textContent = `${finite(performance.physicsHz, 120).toFixed(0)}HZ`;
    this.$('grip').textContent = vehicle.surface?.zone?.toUpperCase() ?? 'ROAD';
    const rubberValue = finite(vehicle.surface?.rubber);
    const towValue = finite(vehicle.telemetry?.dragReduction ?? vehicle.wake?.dragReduction);
    const dirtyValue = Math.max(
      finite(vehicle.telemetry?.frontDownforceLoss ?? vehicle.wake?.frontDownforceLoss),
      finite(vehicle.telemetry?.rearDownforceLoss ?? vehicle.wake?.rearDownforceLoss)
    );
    this.$('rubber').textContent = `${Math.round(Math.max(0, Math.min(1, rubberValue)) * 100)}%`;
    this.$('tow').textContent = `${Math.round(Math.max(0, Math.min(1, towValue)) * 100)}%`;
    this.$('dirty').textContent = `${Math.round(Math.max(0, Math.min(1, dirtyValue)) * 100)}%`;
    const pit = context?.pit;
    const pitState = String(pit?.state ?? vehicle.pit?.state ?? 'NONE');
    const service = finite(pit?.intent?.serviceProgress ?? vehicle.pitIntent?.serviceProgress);
    this.$('pit').textContent = pitState === 'SERVICE' ? `SERVICE ${Math.round(service * 100)}%` : pitState;
    this.$('steer').textContent = vehicle.steering > 0.012 ? 'L' : vehicle.steering < -0.012 ? 'R' : '—';
    const g = Math.hypot(finite(vehicle.localAcceleration?.x), finite(vehicle.localAcceleration?.z)) / 9.81;
    this.$('gforce').textContent = g.toFixed(2);
    const reference = context?.referenceLap;
    this.$('reference').textContent = reference?.recording
      ? reference.armed ? 'ARMED' : `REC ${reference.samples}`
      : reference?.lastExport?.complete ? `${finite(reference.lastExport.durationS).toFixed(1)}S` : 'IDLE';

    const electronics = vehicle.electronics ?? {};
    this.$('tc').textContent = electronics.tcLevel ?? 0;
    this.$('abs').textContent = electronics.absLevel ?? 0;
    this.$('bias').textContent = `${(finite(electronics.brakeBias, 0.57) * 100).toFixed(1)}%`;
    this.$('tc-light').classList.toggle('active', finite(electronics.tcActivity) > 0.12);
    this.$('abs-light').classList.toggle('active', finite(electronics.absActivity) > 0.12);
    const ers = vehicle.ers ?? {};
    const ersEnabled = Boolean(ers.enabled);
    const ersSoc = ersEnabled ? Math.max(0, Math.min(1, finite(ers.soc))) : 0;
    const power = ers.state === 'DEPLOY' ? finite(ers.deployPowerW) : ers.state === 'REGEN' ? finite(ers.regenPowerW) : 0;
    this.$('ers-mode').textContent = ersEnabled ? (ers.mode ?? 'AUTO') : 'OFF';
    this.$('ers-state').textContent = ersEnabled ? (ers.state ?? 'READY') : 'STANDBY';
    this.$('ers-soc').textContent = ersEnabled ? `${Math.round(ersSoc * 100)}% SOC` : '—';
    this.$('ers-power').textContent = ersEnabled ? `${power > 100 ? Math.round(power / 1000) : 0} KW` : '0 KW';
    this.$('ers-fill').style.transform = `scaleX(${ersSoc})`;
    this.$('ers').classList.toggle('active', ersEnabled && (ers.state === 'DEPLOY' || ers.state === 'REGEN'));

    const countdown = this.$('countdown');
    const notice = this.$('notice');
    if (!raceActive) {
      countdown.textContent = ''; countdown.className = 'countdown hidden'; notice.textContent = 'SELECT CLASS · PRESS ENTER TO START';
    } else if (race.phase === 'grid') {
      countdown.textContent = 'GRID'; countdown.className = 'countdown'; notice.textContent = 'WAIT FOR START SIGNAL';
    } else if (race.phase === 'countdown') {
      countdown.textContent = Math.max(1, Math.ceil(finite(race.countdown))); countdown.className = 'countdown'; notice.textContent = 'HOLD BRAKE · LAUNCH ON GREEN';
    } else if (race.phase === 'racing' && finite(race.raceTime) < 0.9) {
      countdown.textContent = 'GO'; countdown.className = 'countdown go'; notice.textContent = `CAMERA ${cameraMode} · T TELEMETRY`;
    } else {
      countdown.className = 'countdown hidden';
      notice.textContent = cameraMode === 'FREE'
        ? 'NO-CLIP · WASD MOVE · Q/E HEIGHT · ARROWS LOOK · SHIFT BOOST · F6 EXIT'
        : cameraMode === 'SPECTATE'
          ? `SPECTATE ${context?.spectatedName ?? 'AI'} · N NEXT · F5 EXIT · GEMINI GAUNTLET`
          : pitState !== 'NONE'
        ? `PIT ${pitState} · LIMIT ${vehicle.pitSpeedLimitMps ? Math.round(vehicle.pitSpeedLimitMps * 3.6) + ' KM/H' : 'OPEN'}`
        : `GEMINI GAUNTLET AI · ${context?.passQuality?.cleanPasses ?? 0} CLEAN PASSES · CAMERA ${cameraMode} · T TELEMETRY · P PIT · R RESET`;
    }

    this._updateStandings(context?.leaderboard, vehicle.id);
    this._updateAIDebug(context?.aiDebug);
    const finish = this.$('finish');
    if (race.finished) {
      finish.classList.add('show');
      this.$('finish-position').textContent = `P${String(race.finishPosition || race.position || 0).padStart(2, '0')}`;
      this.$('finish-time').textContent = formatTime(race.finishTime);
    } else finish.classList.remove('show');
    if (this.telemetryVisible) this._updateTelemetry(vehicle);
  }

  setMuted(muted) { this.$('mute').textContent = `AUDIO: ${muted ? 'OFF' : 'ON'}`; return Boolean(muted); }
}
