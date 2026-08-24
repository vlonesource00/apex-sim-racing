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
    this.selectionIndex = 0;
    this.entries = [];
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
    this.geminiSuite = new AIDebugSuiteRenderer(scene, track);
    this.geminiSuite.setVisible(false);
    this._refreshStyles();
  }

  _createThoughtLabel() {
    if (!globalThis.document?.createElement) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 192;
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
    const requested = thought.requestedManeuver ?? state.racecraftPhase ?? 'PACE';
    const deployed = thought.deployedManeuver && thought.deployedManeuver !== 'NONE'
      ? thought.deployedManeuver : state.racecraftPhase && state.racecraftPhase !== 'NONE'
        ? state.racecraftPhase : state.mode ?? 'WAIT';
    const reason = thought.abortReason ?? thought.waitReason ?? state.abortReason ?? state.waitReason ?? state.reason ?? 'CLEAR';
    const target = thought.targetId ?? state.passTargetId ?? state.draftTargetId ?? 'CLEAR';
    const safe = (Boolean(thought.trajectoryCollisionFree ?? state.trajectoryCollisionFree)
      || Boolean(thought.thresholdSafeTrajectory))
      && Boolean(thought.trajectoryRoadLegal ?? state.trajectoryRoadLegal);
    const signature = [entry.vehicle.name, requested, deployed, reason, target, safe,
      finite(thought.trajectoryMinimumClearanceM, finite(state.trajectoryMinimumClearanceM, 99)).toFixed(1)].join('|');
    const minimumIntervalMs = selected ? 160 : 400;
    if (signature !== entry.labelSignature && now - entry.labelUpdatedAt >= minimumIntervalMs) {
      entry.labelSignature = signature;
      entry.labelUpdatedAt = now;
      const context = entry.labelContext;
      context.clearRect(0, 0, entry.labelCanvas.width, entry.labelCanvas.height);
      context.fillStyle = selected ? 'rgba(4,15,12,.94)' : 'rgba(4,11,9,.82)';
      context.strokeStyle = safe ? '#35e6ed' : '#ff6b55';
      context.lineWidth = selected ? 5 : 3;
      context.fillRect(2, 2, 636, 188); context.strokeRect(3, 3, 634, 186);
      context.font = '700 29px Consolas, monospace'; context.fillStyle = '#e9ff45';
      context.fillText(`${entry.vehicle.name} // ${entry.vehicle.classKey?.toUpperCase() ?? ''}`, 18, 39);
      context.font = '700 24px Consolas, monospace'; context.fillStyle = '#f4f8f1';
      context.fillText(`PLAN ${requested}`, 18, 76);
      context.fillStyle = safe ? '#70f5e8' : '#ff826f';
      context.fillText(`STATE ${deployed} // ${safe ? 'VALID' : 'BLOCKED'}`, 18, 110);
      context.font = '600 20px Consolas, monospace'; context.fillStyle = '#b5c9bb';
      context.fillText(`TGT ${String(target).toUpperCase()} // ${String(reason).slice(0, 34)}`, 18, 145);
      context.fillText(`CLR ${finite(thought.trajectoryMinimumClearanceM, finite(state.trajectoryMinimumClearanceM, 99)).toFixed(1)}M`, 18, 174);
      entry.labelTexture.needsUpdate = true;
    }
    entry.label.position.set(entry.vehicle.position.x, entry.vehicle.position.y + 3.5, entry.vehicle.position.z);
    entry.label.scale.set(selected ? 8.4 : 6.4, selected ? 2.52 : 1.92, 1);
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
    this.geminiSuite?.setVisible(this.visible);
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
    for (const entry of this.entries) {
      const entryIndex = this.entries.indexOf(entry);
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
      // The selected F3 panel already contains all thought data. CanvasTexture
      // labels are reserved for F4 and are throttled above to avoid GPU uploads.
      if (this.fieldView) this._updateThoughtLabel(entry, state, selected, now);
      if (entry.label) entry.label.visible = this.fieldView;
      if (target && Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z)) {
        entry.marker.position.set(target.x, target.y + 0.12, target.z);
        entry.marker.visible = true;
      } else {
        entry.marker.visible = false;
      }
    }
    const selected = this._selectedEntry();
    if (selected?.controller && selected?.vehicle) {
      this.geminiSuite?.update(selected.controller, selected.vehicle, this.vehicles, this.track, now);
    }
    this._refreshStyles();
  }

  snapshot() {
    const selected = this._selectedEntry();
    const state = selected?.controller.debugState ?? null;
    if (!state) return {
      enabled: this.visible, fieldView: this.fieldView,
      selectedId: selected?.vehicle.id ?? null, selectedName: selected?.vehicle.name ?? null,
      rlShadow: selected?.vehicle.rlShadow ?? null, state: null
    };
    return {
      ...state,
      enabled: this.visible,
      fieldView: this.fieldView,
      selectedId: selected.vehicle.id,
      selectedName: selected.vehicle.name,
      rlShadow: selected.vehicle.rlShadow ?? null,
      state
    };
  }

  dispose() {
    this._setControllerDebug(false);
    this.geminiSuite?.dispose();
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
