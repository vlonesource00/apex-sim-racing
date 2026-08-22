import * as THREE from 'three';
import './style.css';
import { Circuit } from './simulation/Track.js';
import { Vehicle } from './simulation/Vehicle.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from './simulation/VehicleInteractions.js';
import { carClassSummaries } from './simulation/CarSpecs.js';
import { AIController } from './simulation/AI.js';
import { RaceState } from './simulation/Race.js';
import { CircuitEnvironment } from './render/Environment.js';
import { CarVisual } from './render/CarVisual.js';
import { AssetLibrary } from './render/AssetLibrary.js';
import { AIDebugRenderer } from './render/AIDebugRenderer.js';
import { CameraRig } from './render/Cameras.js';
import { InputManager } from './input.js';
import { SynthAudio } from './audio.js';
import { HUD } from './ui/HUD.js';
import { ENDURANCE_PARK } from './scenarios/EndurancePark.js';
import { EnduranceScenarioVisuals } from './render/EnduranceScenarioVisuals.js';
import { PitSystem, PIT_STATES, applyPitIntentToControls } from './simulation/PitSystem.js';
import { RLShadowController } from './ai/RLShadowController.js';
import stage1Policy from '../rl/policies/stage1_policy_compact.json';

const FIXED_TIMESTEP = 1 / 120;
const MAX_STEPS_PER_FRAME = 14;
const rlShadowEnabled = new URLSearchParams(window.location.search).get('rl') === 'shadow';
const app = document.querySelector('#app');
const menu = document.querySelector('#start-menu');
const menuStart = document.querySelector('[data-action="start-race"]');
const menuSummary = document.querySelector('[data-role="class-summary"]');
const menuCards = [...document.querySelectorAll('[data-class]')];

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', 'APEX 73 racing game canvas');
app.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.035, 1800);
const track = new Circuit(ENDURANCE_PARK);
const environment = new CircuitEnvironment(scene, track);
const paint = ['#e85038', '#3378a8', '#e1ad31', '#8f44a5', '#25a176', '#dbd8d0', '#e15d93', '#2c4d89', '#df742d'];
const driverNames = ['MARTIM', 'VEGA', 'KLINE', 'SATO', 'ROWE', 'MORA', 'NAKAMURA', 'BELL', 'LUCAS'];
// Define class allocation before construction: Vehicle defaults remain valid for tests.
const gridVariants = ['gt', 'prototype', 'touring', 'gt', 'touring', 'prototype', 'gt', 'touring', 'prototype'];
let selectedClass = gridVariants[0];
const player = new Vehicle({ id: 'player', name: driverNames[0], color: paint[0], player: true, spec: selectedClass });
const vehicles = [player];
for (let i = 1; i <= 8; i += 1) vehicles.push(new Vehicle({ id: `ai-${i}`, name: driverNames[i], color: paint[i], spec: gridVariants[i] }));
const controllers = new Map(vehicles.slice(1).map((vehicle, index) => [vehicle.id, new AIController(index + 1)]));
const rlShadowControllers = new Map(vehicles.slice(1).map((vehicle) => [vehicle.id, new RLShadowController(stage1Policy)]));
const race = new RaceState(track, vehicles, 3);
const pitSystem = new PitSystem(track, vehicles, ENDURANCE_PARK);

function placeGrid() {
  vehicles.forEach((vehicle, index) => {
    const grid = race.gridPosition(index);
    vehicle.resetTo(track, grid.distance, grid.lateral);
  });
}
placeGrid();
race.reset();

const visuals = vehicles.map((vehicle, index) => {
  const visual = new CarVisual(vehicle, { variant: gridVariants[index] });
  scene.add(visual.group);
  return visual;
});
const aiDebug = new AIDebugRenderer(scene, track, vehicles, controllers);
let enduranceVisuals = null;
const playerVisual = visuals[0];
const cameraRig = new CameraRig(camera);
const loadingScreen = document.querySelector('#loading-screen');
const loadingMessage = loadingScreen?.querySelector('p');
const audio = new SynthAudio();
const input = new InputManager(() => { audio.unlock().catch(() => {}); });
const hud = new HUD(() => audio.toggleMute());
hud.setRaceActive(false);
let raceStarted = false;
let assetsReady = false;
const assets = new AssetLibrary({
  onStatus: ({ state, key }) => {
    if (!loadingMessage) return;
    loadingMessage.textContent = state === 'ready' ? 'LOADED ' + key.toUpperCase() : 'LOADING ' + key.toUpperCase();
  }
});

function attachPlayerAsset() {
  if (!assetsReady || playerVisual.assetModel) return;
  playerVisual.variant = selectedClass;
  playerVisual.attachAsset(assets);
  playerVisual.setCockpitView(cameraRig.mode === 'COCKPIT');
}

assets.preload().then((result) => {
  assetsReady = true;
  const attachedCars = visuals.slice(1).filter((visual) => visual.attachAsset(assets)).length;
  const propsInstalled = environment.installAssets(assets);
  enduranceVisuals ??= new EnduranceScenarioVisuals(scene, track, ENDURANCE_PARK, assets);
  if (raceStarted) attachPlayerAsset();
  if (loadingMessage) {
    loadingMessage.textContent = result.failed
      ? 'ASSET FALLBACK ACTIVE'
      : 'BLENDER ASSETS ONLINE // ' + attachedCars + ' GRID CARS' + (propsInstalled ? ' // PROPS' : '');
  }
});

const metrics = { fps: 60, physicsHz: 120 };
let accumulator = 0;
let previousTime = performance.now();
let frameCounter = 0;
let physicsCounter = 0;
let metricsAt = previousTime;
let pitDecisionClock = 0;

function selectClass(key) {
  const summary = carClassSummaries().find((item) => item.key === key);
  if (!summary) return;
  selectedClass = key;
  menuCards.forEach((card) => card.classList.toggle('selected', card.dataset.class === key));
  if (menuSummary) menuSummary.textContent = `${summary.label} // ${summary.subtitle} // ${summary.summary}`;
}

function startRace() {
  if (raceStarted) return;
  player.setSpec(selectedClass);
  playerVisual.variant = selectedClass;
  attachPlayerAsset();
  placeGrid();
  race.reset();
  pitSystem.reset(vehicles);
  input.keyboardDynamics.reset();
  raceStarted = true;
  hud.setRaceActive(true);
  menu?.classList.add('dismissed');
  audio.unlock().catch(() => {});
}

function resetPlayer() {
  const before = player.distance;
  const recoveredAt = track.surfaceAt(player.position.x, player.position.z);
  player.resetTo(track, recoveredAt.s - 7, 0);
  const entry = race.entries.get(player.id);
  entry.lastDistance = player.distance;
  const wrappedDelta = ((player.distance - before + track.length * 1.5) % track.length) - track.length * 0.5;
  entry.unwrappedDistance += wrappedDelta;
}

function restartRace() {
  placeGrid();
  race.reset();
  pitSystem.reset(vehicles);
  input.keyboardDynamics.reset();
}

function fixedStep() {
  if (!raceStarted) return;
  race.step(FIXED_TIMESTEP);
  Object.assign(player.controls, cameraRig.mode === 'FREE'
    ? { throttle: 0, brake: 0, steer: 0, handbrake: 0 }
    : input.controls(player, FIXED_TIMESTEP));
  pitDecisionClock += FIXED_TIMESTEP;
  if (pitDecisionClock >= 1) {
    pitDecisionClock = 0;
    for (const vehicle of vehicles.slice(1)) {
      const raceEntry = race.entries.get(vehicle.id);
      const lapsRemaining = Math.max(0, race.totalLaps - (raceEntry?.lap ?? 0));
      const pitNeed = pitSystem.pitNeedFor(vehicle, lapsRemaining, { baseThreshold: 0.31, perLapMargin: 0.015, emergencyWear: 0.58 });
      if (pitSystem.status(vehicle).state === PIT_STATES.NONE && pitNeed.shouldPit) pitSystem.request(vehicle);
    }
  }
  pitSystem.update(FIXED_TIMESTEP, vehicles);
  for (const vehicle of vehicles.slice(1)) controllers.get(vehicle.id).update(vehicle, vehicles, track, race, FIXED_TIMESTEP);
  if (rlShadowEnabled) for (const vehicle of vehicles.slice(1)) rlShadowControllers.get(vehicle.id).update(vehicle, track, FIXED_TIMESTEP);
  for (const vehicle of vehicles) applyPitIntentToControls(vehicle.controls, vehicle.pitIntent);
  const canDrive = race.phase === 'racing';
  updateAerodynamicWakes(vehicles);
  for (const vehicle of vehicles) vehicle.step(FIXED_TIMESTEP, track, canDrive);
  const collisionStats = resolveVehicleCollisions(vehicles, 3);
  race.lastImpact = Math.max(race.lastImpact, collisionStats.maxImpact / 18);
  physicsCounter += 1;
}

function processActions() {
  if (!raceStarted && input.consume('Enter')) startRace();
  if (input.consume('F3')) aiDebug.toggle();
  if (input.consume('F4')) aiDebug.toggleFieldView();
  if (input.consume('KeyN')) aiDebug.cycleSelection();
  if (input.consume('F5')) {
    aiDebug.setVisible(true);
    const mode = cameraRig.setSpectate();
    playerVisual.setCockpitView(mode === 'COCKPIT');
  }
  if (input.consume('F6')) {
    const mode = cameraRig.setFree();
    playerVisual.setCockpitView(mode === 'COCKPIT');
  }
  if (!raceStarted) return;
  if (input.consume('KeyC')) playerVisual.setCockpitView(cameraRig.toggle() === 'COCKPIT');
  if (input.consume('KeyM')) hud.setMuted(audio.toggleMute());
  if (input.consume('KeyR')) resetPlayer();
  if (input.consume('KeyT')) hud.toggleTelemetry();
  if (input.consume('BracketLeft')) player.adjustTC(-1);
  if (input.consume('BracketRight')) player.adjustTC(1);
  if (input.consume('Semicolon')) player.adjustABS(-1);
  if (input.consume('Quote')) player.adjustABS(1);
  if (input.consume('KeyB')) player.cycleBrakeBias();
  if (input.consume('KeyE')) player.cycleERSMode?.();
  if (input.consume('KeyP')) {
    const state = pitSystem.status(player).state;
    if (state === PIT_STATES.NONE) pitSystem.request(player);
    else if (state === PIT_STATES.REQUESTED) pitSystem.cancel(player);
  }
  if (input.consume('Enter') && (player.finished || race.phase === 'complete')) restartRace();
}

function frame(now) {
  const rawDelta = Math.min(0.1, (now - previousTime) / 1000);
  previousTime = now;
  accumulator += rawDelta;
  processActions();
  let steps = 0;
  while (accumulator >= FIXED_TIMESTEP && steps < MAX_STEPS_PER_FRAME) {
    fixedStep();
    accumulator -= FIXED_TIMESTEP;
    steps += 1;
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  for (const visual of visuals) {
    visual.update(rawDelta);
  }
  environment.update(rawDelta);
  enduranceVisuals?.update(rawDelta, vehicles, race);
  aiDebug.update();
  const selectedAI = aiDebug.selectedVehicle();
  if (cameraRig.mode === 'FREE') cameraRig.updateFree(input.freeCameraRaw(), rawDelta);
  else if (cameraRig.mode === 'SPECTATE' && selectedAI) cameraRig.update(selectedAI, rawDelta);
  else cameraRig.update(player, rawDelta, cameraRig.mode === 'COCKPIT' ? playerVisual.getCockpitPose() : null);
  if (raceStarted) audio.update(player, rawDelta);
  frameCounter += 1;
  if (now - metricsAt > 500) {
    const span = (now - metricsAt) / 1000;
    metrics.fps = frameCounter / span;
    metrics.physicsHz = physicsCounter / span;
    frameCounter = 0; physicsCounter = 0; metricsAt = now;
  }
  hud.update(player, race.statusFor(player), metrics, cameraRig.mode, raceStarted, {
    leaderboard: race.standings(player),
    aiDebug: aiDebug.snapshot(),
    pit: pitSystem.status(player),
    rlShadow: rlShadowEnabled ? selectedAI?.rlShadow : null,
    spectatedName: cameraRig.mode === 'SPECTATE' ? selectedAI?.name : null
  });
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

menuCards.forEach((card) => card.addEventListener('click', () => selectClass(card.dataset.class)));
menuStart?.addEventListener('click', startRace);
selectClass(selectedClass);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
requestAnimationFrame(frame);
window.__APEX73__ = {
  track, vehicles, visuals, environment, assets, metrics, race, controllers, aiDebug, cameraRig, rlShadowControllers,
  interactions: { updateAerodynamicWakes, resolveVehicleCollisions }, pitSystem, scenario: ENDURANCE_PARK,
  get enduranceVisuals() { return enduranceVisuals; },
  startRace, selectClass, rlShadowEnabled, get raceStarted() { return raceStarted; }
};
setTimeout(() => loadingScreen?.classList.add('dismissed'), 650);
