import * as THREE from 'three';
import { AIDebugSuiteRenderer } from './AIDebugSuiteRenderer.js';

export const MAX_PATH_POINTS = 24;
const MODE_COLORS = {
  GRID: '#8e9a9a',
  RACE: '#35e6ed',
  FOLLOW: '#4d8dff',
  PASS: '#b7f542',
  DEFEND: '#f05cff',
  AVOID: '#ff9b3d',
  BRAKE: '#ffe15a',
  RECOVER: '#ff4d4d',
  COOLDOWN: '#8e9a9a',
  PIT: '#55ffd2'
};

const MODE_HIGHLIGHT_COLORS = {
  GRID: '#d8e1e1',
  RACE: '#b6fbff',
  FOLLOW: '#b8caff',
  PASS: '#e6ff9c',
  DEFEND: '#ffc0ff',
  AVOID: '#ffd09c',
  BRAKE: '#fff5ae',
  RECOVER: '#ffaaaa',
  COOLDOWN: '#d8e1e1',
  PIT: '#baffec'
};

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export class AIDebugRenderer {
  constructor(scene, track, vehicles = [], controllers = new Map()) {
    this.scene = scene;
    this.track = track;
    this.vehicles = vehicles;
    this.controllers = controllers;
    this.group = new THREE.Group();
    this.group.name = 'AI_DEBUG_PLANNER';
    this.group.visible = false;
    this.visible = false;
    this.fieldView = false;
    // F3/F4 are visual-first views. The legacy telemetry board and floating
    // thought badges remain available to tooling, but are deliberately not
    // part of the driving/debugging view because they obscure the race.
    this.textPanelEnabled = false;
    this.fieldLabelsEnabled = false;
    this.selectionIndex = 0;
    this.entries = [];
    this._suiteLastUpdateAt = -Infinity;
    this._suiteUpdateIntervalMs = 80;
    this._markerGeometry = new THREE.SphereGeometry(0.34, 8, 6);

    for (const vehicle of vehicles) {
      const controller = controllers instanceof Map ? controllers.get(vehicle.id) : controllers?.[vehicle.id];
      if (!controller) continue;
      const positions = new Float32Array(MAX_PATH_POINTS * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setDrawRange(0, 0);
      const material = new THREE.LineBasicMaterial({
        color: MODE_COLORS.RACE,
        transparent: true,
        opacity: 0.76,
        depthTest: true,
        depthWrite: false
      });
      const line = new THREE.Line(geometry, material);
      line.name = `AI_DEBUG_PLAN_${vehicle.id}`;
      line.frustumCulled = false;
      const markerMaterial = new THREE.MeshBasicMaterial({
        color: MODE_COLORS.RACE,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
        depthWrite: false
      });
      const marker = new THREE.Mesh(this._markerGeometry, markerMaterial);
      marker.name = `AI_DEBUG_TARGET_${vehicle.id}`;
      marker.visible = false;
      marker.frustumCulled = false;
      const label = this._createThoughtLabel();
      this.group.add(line, marker);
      if (label) this.group.add(label.sprite);
      this.entries.push({ vehicle, controller, geometry, material, line, marker, markerMaterial,
        label: label?.sprite ?? null, labelCanvas: label?.canvas ?? null,
        labelContext: label?.context ?? null, labelTexture: label?.texture ?? null,
        labelSignature: '', labelUpdatedAt: -Infinity, lastPath: null });
    }
    scene.add(this.group);
    // Gemini's full selected-car laboratory sits beside the lightweight
    // whole-field lines retained for F4.
    this.selectedSuite = new AIDebugSuiteRenderer(scene, track);
    this.selectedSuite.setVisible(false);
    this._refreshStyles();
  }

  _createThoughtLabel() {
    if (!globalThis.document?.createElement) return null;
    const canvas = document.createElement('canvas');
    // Field badges are deliberately compact: one readable two-line summary
    // per car, with the selected vehicle getting a modest emphasis rather
    // than a full thought paragraph floating over the field.
    canvas.width = 256; canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false,
      depthWrite: false, sizeAttenuation: true });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 200;
    sprite.visible = false;
    return { canvas, context, texture, sprite };
  }

  _updateThoughtLabel(entry, state, selected, now) {
    if (!entry.label || !entry.labelContext || !state) return;
    const thought = state.thought ?? {};
    const phase = state.racecraftPhase ?? thought.deployedManeuver ?? state.mode ?? 'PACE';
    const mode = state.mode ?? 'RACE';
    const target = thought.targetId ?? state.targetId ?? state.passTargetId ?? state.draftTargetId ?? 'CLEAR';
    const safe = Boolean(state.trajectoryCollisionFree ?? thought.trajectoryCollisionFree)
      && Boolean(state.trajectoryRoadLegal ?? thought.trajectoryRoadLegal);
    const clearance = finite(state.trajectoryMinimumClearanceM, finite(thought.trajectoryMinimumClearanceM, 99));
    const signature = [entry.vehicle.name, mode, phase, target, safe, clearance.toFixed(1)].join('|');
    const minimumIntervalMs = selected ? 160 : 400;
    if (signature !== entry.labelSignature && now - entry.labelUpdatedAt >= minimumIntervalMs) {
      entry.labelSignature = signature;
      entry.labelUpdatedAt = now;
      const context = entry.labelContext;
      context.clearRect(0, 0, entry.labelCanvas.width, entry.labelCanvas.height);
      context.fillStyle = selected ? 'rgba(4,15,12,.96)' : 'rgba(4,11,9,.84)';
      context.strokeStyle = safe ? '#35e6ed' : '#ff6b55';
      context.lineWidth = selected ? 2 : 1;
      context.fillRect(1, 1, 254, 62); context.strokeRect(2, 2, 252, 60);
      context.font = '700 12px Consolas, monospace'; context.fillStyle = '#e9ff45';
      context.fillText(`${entry.vehicle.name}  ${String(mode).toUpperCase()}`, 7, 17);
      context.font = '600 10px Consolas, monospace'; context.fillStyle = '#f4f8f1';
      context.fillText(`PH ${String(phase).slice(0, 16).toUpperCase()}`, 7, 33);
      context.fillStyle = safe ? '#70f5e8' : '#ff826f';
      context.fillText(`${safe ? 'SAFE' : 'BLOCK'} CLR ${clearance.toFixed(1)}M`, 7, 48);
      context.font = '600 9px Consolas, monospace'; context.fillStyle = '#b5c9bb';
      context.fillText(`TGT ${String(target).toUpperCase().slice(0, 25)}`, 7, 59);
      entry.labelTexture.needsUpdate = true;
    }
    entry.label.position.set(entry.vehicle.position.x, entry.vehicle.position.y + 2.35, entry.vehicle.position.z);
    entry.label.scale.set(selected ? 2.25 : 1.65, selected ? 0.62 : 0.46, 1);
  }

  _setControllerDebug(enabled) {
    for (const [index, entry] of this.entries.entries()) {
      // F3 collects only the selected car. F4's field view deliberately opts
      // into collection for the complete grid.
      entry.controller.setDebugEnabled?.(Boolean(enabled) && (this.fieldView || index === this.selectionIndex));
    }
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.group.visible = this.visible;
    this.selectedSuite?.setVisible(this.visible && !this.fieldView);
    this._setControllerDebug(this.visible);
    if (!this.visible) {
      for (const entry of this.entries) {
        entry.line.visible = false;
        entry.marker.visible = false;
        if (entry.label) entry.label.visible = false;
      }
      return false;
    }
    this._refreshStyles();
    return true;
  }

  toggle() { return this.setVisible(!this.visible); }

  setFieldView(enabled) {
    this.fieldView = Boolean(enabled);
    this._setControllerDebug(this.visible);
    this.selectedSuite?.setVisible(this.visible && !this.fieldView);
    this._refreshStyles();
    if (this.visible) this.update();
    return this.fieldView;
  }

  toggleFieldView() { return this.setFieldView(!this.fieldView); }

  _liveEntries() {
    const live = this.entries.filter((entry) => !entry.vehicle.despawned);
    return live.length ? live : this.entries;
  }

  cycleSelection(step = 1) {
    const candidates = this._liveEntries();
    if (!candidates.length) return null;
    const current = candidates.indexOf(this.entries[this.selectionIndex]);
    const next = (current + Math.trunc(step) + candidates.length) % candidates.length;
    this.selectionIndex = this.entries.indexOf(candidates[next]);
    this._setControllerDebug(this.visible);
    this._refreshStyles();
    return candidates[next].vehicle.id;
  }

  _selectedEntry() { return this.entries[this.selectionIndex] ?? null; }

  selectedVehicle() { return this._selectedEntry()?.vehicle ?? null; }

  _refreshStyles() {
    for (const [index, entry] of this.entries.entries()) {
      const state = entry.controller.debugState;
      const modeColor = MODE_COLORS[state?.mode] ?? MODE_COLORS.RACE;
      const highlightColor = MODE_HIGHLIGHT_COLORS[state?.mode] ?? MODE_HIGHLIGHT_COLORS.RACE;
      const selected = index === this.selectionIndex;
      entry.material.color.set(selected ? highlightColor : modeColor);
      entry.markerMaterial.color.set(selected ? highlightColor : modeColor);
      entry.material.opacity = selected ? 0.98 : 0.47;
      entry.markerMaterial.opacity = selected ? 1 : 0.68;
      entry.marker.scale.setScalar(selected ? 0.78 : 0.52);
    }
  }

  update() {
    if (!this.visible) return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    for (let entryIndex = 0; entryIndex < this.entries.length; entryIndex += 1) {
      const entry = this.entries[entryIndex];
      const selected = entryIndex === this.selectionIndex;
      const state = entry.controller.debugState;
      const path = state?.planPath ?? state?.path;
      const target = state?.target;
      if (!this.fieldView && !selected) {
        entry.line.visible = false;
        entry.marker.visible = false;
        if (entry.label) entry.label.visible = false;
        continue;
      }
      if (!state || !Array.isArray(path) || !path.length || entry.vehicle.despawned) {
        entry.line.visible = false;
        entry.marker.visible = false;
        if (entry.label) entry.label.visible = false;
        continue;
      }
      if (entry.lastPath !== path) {
        entry.lastPath = path;
        const count = Math.min(MAX_PATH_POINTS, path.length);
        const positions = entry.geometry.attributes.position.array;
        for (let index = 0; index < count; index += 1) {
          const point = path[index] ?? {};
          positions[index * 3] = finite(point.x);
          positions[index * 3 + 1] = finite(point.y);
          positions[index * 3 + 2] = finite(point.z);
        }
        entry.geometry.setDrawRange(0, count);
        entry.geometry.attributes.position.needsUpdate = true;
      }
      entry.line.visible = true;
      if (this.fieldView && this.fieldLabelsEnabled) this._updateThoughtLabel(entry, state, selected, now);
      if (entry.label) entry.label.visible = this.fieldView && this.fieldLabelsEnabled;
      if (target && Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z)) {
        entry.marker.position.set(target.x, target.y + 0.12, target.z);
        entry.marker.visible = true;
      } else {
        entry.marker.visible = false;
      }
    }
    const selected = this._selectedEntry();
    if (!this.fieldView && selected?.controller?.debugState && selected?.vehicle
      && now - this._suiteLastUpdateAt >= this._suiteUpdateIntervalMs) {
      this._suiteLastUpdateAt = now;
      this.selectedSuite?.update(selected.controller, selected.vehicle, this.vehicles, this.track, now);
    }
    this._refreshStyles();
  }

  _fieldCars() {
    return this.entries.map((entry, index) => {
      const state = entry.controller.debugState ?? {};
      const mode = state.mode ?? 'WAIT';
      const safe = Boolean(state.trajectoryCollisionFree) && Boolean(state.trajectoryRoadLegal);
      return {
        id: entry.vehicle.id,
        name: entry.vehicle.name,
        class: entry.vehicle.classKey ?? entry.vehicle.spec?.key ?? null,
        mode,
        phase: state.racecraftPhase ?? state.thought?.deployedManeuver ?? mode,
        target: state.targetId ?? state.thought?.targetId ?? null,
        safe,
        clearance: finite(state.trajectoryMinimumClearanceM, 99),
        speed: finite(state.currentSpeed, entry.vehicle.speed),
        targetSpeed: finite(state.desiredSpeed, state.targetSpeed),
        selected: index === this.selectionIndex,
        color: MODE_COLORS[mode] ?? MODE_COLORS.RACE
      };
    });
  }

  snapshot() {
    const selected = this._selectedEntry();
    const state = selected?.controller.debugState ?? null;
    if (!state) return {
      enabled: this.visible, fieldView: this.fieldView,
      textPanelEnabled: this.textPanelEnabled,
      selectedId: selected?.vehicle.id ?? null, selectedName: selected?.vehicle.name ?? null,
      fieldCars: this._fieldCars(), state: null
    };
    return {
      ...state,
      enabled: this.visible,
      fieldView: this.fieldView,
      textPanelEnabled: this.textPanelEnabled,
      selectedId: selected.vehicle.id,
      selectedName: selected.vehicle.name,
      fieldCars: this._fieldCars(),
      state
    };
  }

  dispose() {
    this._setControllerDebug(false);
    this.selectedSuite?.dispose();
    for (const entry of this.entries) {
      this.group.remove(entry.line, entry.marker);
      entry.geometry.dispose();
      entry.material.dispose();
      entry.markerMaterial.dispose();
      entry.label?.removeFromParent();
      entry.labelTexture?.dispose();
      entry.label?.material?.dispose();
    }
    this._markerGeometry.dispose();
    this.entries.length = 0;
    this.group.removeFromParent();
    this.visible = false;
    this.group.visible = false;
  }
}
