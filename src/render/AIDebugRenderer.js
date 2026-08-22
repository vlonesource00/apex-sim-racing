import * as THREE from 'three';

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
      this.group.add(line, marker);
      this.entries.push({ vehicle, controller, geometry, material, line, marker, markerMaterial });
    }
    scene.add(this.group);
    this._refreshStyles();
  }

  _setControllerDebug(enabled) {
    for (const entry of this.entries) entry.controller.setDebugEnabled?.(enabled);
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.group.visible = this.visible;
    this._setControllerDebug(this.visible);
    if (!this.visible) {
      for (const entry of this.entries) {
        entry.line.visible = false;
        entry.marker.visible = false;
      }
      return false;
    }
    this._refreshStyles();
    return true;
  }

  toggle() { return this.setVisible(!this.visible); }

  setFieldView(enabled) {
    this.fieldView = Boolean(enabled);
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
    for (const entry of this.entries) {
      const entryIndex = this.entries.indexOf(entry);
      const selected = entryIndex === this.selectionIndex;
      const state = entry.controller.debugState;
      const path = state?.planPath ?? state?.path;
      const target = state?.target;
      if (!this.fieldView && !selected) {
        entry.line.visible = false;
        entry.marker.visible = false;
        continue;
      }
      if (!state || !Array.isArray(path) || !path.length || entry.vehicle.despawned) {
        entry.line.visible = false;
        entry.marker.visible = false;
        continue;
      }
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
      entry.line.visible = true;
      if (target && Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z)) {
        entry.marker.position.set(target.x, target.y + 0.12, target.z);
        entry.marker.visible = true;
      } else {
        entry.marker.visible = false;
      }
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
    for (const entry of this.entries) {
      this.group.remove(entry.line, entry.marker);
      entry.geometry.dispose();
      entry.material.dispose();
      entry.markerMaterial.dispose();
    }
    this._markerGeometry.dispose();
    this.entries.length = 0;
    this.group.removeFromParent();
    this.visible = false;
    this.group.visible = false;
  }
}
