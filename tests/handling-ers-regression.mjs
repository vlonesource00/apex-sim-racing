import assert from 'node:assert/strict';
import { KeyboardDynamics } from '../src/input/KeyboardDynamics.js';
import { carSpecFor } from '../src/simulation/CarSpecs.js';
import { createTireState, tireForces } from '../src/simulation/Tire.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { Circuit } from '../src/simulation/Track.js';
import { terrainHeightAt } from '../src/render/Environment.js';

const DT = 1 / 120;
const flatTrack = {
  length: 5000,
  atDistance: (s) => ({ x: 0, y: 0, z: s, s, index: 0, tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 }, normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0, curvature: 0, turnSign: 0, turnStrength: 0 }),
  surfaceAt: (x, z) => ({ x, y: 0, z, s: z, index: 0, lateral: -x, tangent: { x: 0, z: 1 }, normal: { x: -1, z: 0 }, normal3: { x: 0, y: 1, z: 0 }, grade: 0, bank: 0, height: 0, grip: 1.08, zone: 'road', barrierDepth: 0, curbHeight: 0, roughness: 0, roadEdge: 6.5, curbEdge: 7.55, barrierEdge: 16.05, turnStrength: 0 }),
  updateTirePass() {}
};

const settledVehicle = (classKey, id = `handling-${classKey}`) => {
  const vehicle = new Vehicle({ id, spec: classKey, player: true });
  vehicle.place(0, 0, 0, vehicle.rideHeight);
  const speed = 25;
  vehicle.velocity.z = speed;
  vehicle.localVelocity.z = speed;
  vehicle.speed = speed;
  vehicle.gear = 3;
  const ratio = vehicle.spec.gearRatios[vehicle.gear] * vehicle.spec.finalDrive;
  const wheelOmega = speed / vehicle.wheelRadius;
  for (const wheel of vehicle.wheels) wheel.omega = wheelOmega;
  vehicle.rpm = Math.max(vehicle.spec.idleRpm, wheelOmega * ratio * 9.5493);
  vehicle.engineOmega = vehicle.rpm * Math.PI * 2 / 60;
  return vehicle;
};

const measureHandlingPhase = (classKey, name) => {
  const vehicle = settledVehicle(classKey, `handling-${classKey}-${name}`);
  const keyboard = new KeyboardDynamics();
  // Lift is a powered corner followed by throttle zero.  The short lead-in
  // also settles load transfer and wheel speed before the measured phase.
  const leadIn = name === 'lift' || name === 'power' ? 72 : 0;
  const leadThrottle = name === 'power' ? 0.72 : 0.68;
  for (let i = 0; i < leadIn; i += 1) {
    vehicle.controls = keyboard.update({ steer: 1, throttle: leadThrottle }, vehicle, DT);
    vehicle.step(DT, flatTrack, true);
  }
  const throttle = name === 'power' ? 0.9 : 0;
  let maxBodySlip = 0;
  let maxFrontSlip = 0;
  let maxRearSlip = 0;
  let maxYawRate = 0;
  let tcActive = 0;
  const frames = 180;
  for (let i = 0; i < frames; i += 1) {
    vehicle.controls = keyboard.update({ steer: 1, throttle }, vehicle, DT);
    vehicle.step(DT, flatTrack, true);
    maxBodySlip = Math.max(maxBodySlip, Math.abs(Math.atan2(vehicle.localVelocity.x, Math.max(1, Math.abs(vehicle.localVelocity.z))) * 180 / Math.PI));
    maxFrontSlip = Math.max(maxFrontSlip, ...vehicle.wheels.slice(0, 2).map((wheel) => Math.abs(wheel.slipAngle) * 180 / Math.PI));
    maxRearSlip = Math.max(maxRearSlip, ...vehicle.wheels.slice(2).map((wheel) => Math.abs(wheel.slipAngle) * 180 / Math.PI));
    maxYawRate = Math.max(maxYawRate, Math.abs(vehicle.yawRate));
    tcActive += vehicle.electronics.tcActivity > 0.1 ? 1 : 0;
  }
  return { maxBodySlip, maxFrontSlip, maxRearSlip, maxYawRate, tcDuty: tcActive / frames };
};

const phaseProbe = (classKey) => Object.fromEntries(
  ['coast', 'lift', 'power'].map((name) => [name, measureHandlingPhase(classKey, name)])
);

const handling = Object.fromEntries(['gt', 'prototype', 'touring'].map((classKey) => [classKey, phaseProbe(classKey)]));
for (const [classKey, phases] of Object.entries(handling)) {
  const bodyLimit = classKey === 'touring' ? 15 : 12;
  for (const [phase, result] of Object.entries(phases)) {
    assert.ok(result.maxBodySlip <= bodyLimit + 1.5, `${classKey} ${phase} body slip: ${result.maxBodySlip.toFixed(1)}°`);
    assert.ok(result.maxFrontSlip <= 18.5, `${classKey} ${phase} front slip: ${result.maxFrontSlip.toFixed(1)}°`);
    assert.ok(result.maxRearSlip <= 18.5, `${classKey} ${phase} rear slip: ${result.maxRearSlip.toFixed(1)}°`);
    assert.ok(result.maxYawRate < 5.5, `${classKey} ${phase} yaw rate/cap: ${result.maxYawRate.toFixed(2)} rad/s`);
  }
  assert.ok(phases.power.tcDuty < 0.65, `${classKey} power TC must pulse, not stay active: ${phases.power.tcDuty.toFixed(2)}`);
}

const settledStraightTcDuty = (classKey) => {
  const vehicle = settledVehicle(classKey, `straight-${classKey}`);
  const keyboard = new KeyboardDynamics();
  const frames = Math.round(15 / DT);
  let active = 0;
  for (let i = 0; i < frames; i += 1) {
    vehicle.controls = keyboard.update({ steer: 0, throttle: 0.75 }, vehicle, DT);
    vehicle.step(DT, flatTrack, true);
    if (i >= frames - Math.round(5 / DT) && vehicle.electronics.tcActivity > 0.1) active += 1;
  }
  return active / Math.round(5 / DT);
};

const straightTc = Object.fromEntries(['gt', 'prototype', 'touring'].map((classKey) => [classKey, settledStraightTcDuty(classKey)]));
for (const [classKey, duty] of Object.entries(straightTc)) {
  assert.ok(duty <= 0.1, `${classKey} settled straight TC duty must be <=10%; got ${(duty * 100).toFixed(1)}%`);
}

const tractionLimitProbe = (tcLevel) => {
  const vehicle = new Vehicle({ id: `traction-tc-${tcLevel}`, spec: 'gt', player: true });
  vehicle.place(0, 0, 0, vehicle.rideHeight);
  vehicle.setTCLevel(tcLevel);
  let active = 0;
  const frames = 360;
  for (let i = 0; i < frames; i += 1) {
    vehicle.controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    vehicle.step(DT, flatTrack, true);
    if (vehicle.electronics.tcActivity > 0.1) active += 1;
  }
  return { duty: active / frames, finalSpeed: vehicle.speed, intervention: vehicle.electronics.tcIntervention };
};

const tractionWithTc = tractionLimitProbe(4);
const tractionWithoutTc = tractionLimitProbe(0);
assert.ok(tractionWithTc.duty > 0 && tractionWithTc.duty < 1, `traction-limit TC must intervene transiently; got ${tractionWithTc.duty.toFixed(2)}`);
assert.equal(tractionWithoutTc.duty, 0, 'TC level 0 must fully bypass intervention');

const thermal = {};
for (const classKey of ['gt', 'prototype', 'touring']) {
  const spec = carSpecFor(classKey).tire;
  const normal = createTireState(spec);
  const abuse = createTireState(spec);
  const cooled = createTireState(spec);
  const start = normal.temperatureMiddleC;
  for (let i = 0; i < 90 / DT; i += 1) {
    tireForces({ longitudinalVelocity: 28, lateralVelocity: 2, wheelAngularSpeed: 28 / 0.335 * 1.01, radius: 0.335, normalLoad: 3300, grip: 1, spec }, normal, DT);
    tireForces({ longitudinalVelocity: 31, lateralVelocity: 7, wheelAngularSpeed: 31 / 0.335 * 1.3, radius: 0.335, normalLoad: 3300, grip: 1, spec }, abuse, DT);
    tireForces({ longitudinalVelocity: 0, lateralVelocity: 0, wheelAngularSpeed: 0, radius: 0.335, normalLoad: 0, grip: 1, spec }, cooled, DT);
  }
  const mean = (state) => (state.temperatureInnerC + state.temperatureMiddleC + state.temperatureOuterC) / 3;
  thermal[classKey] = { prepared: start, normal: mean(normal), normalCarcass: normal.carcassTemperatureC, abuse: mean(abuse), cooled: mean(cooled) };
  assert.ok(start >= 50 && start <= 75, `${classKey} prepared temperature must be plausible`);
  assert.ok(thermal[classKey].normal >= 60 && thermal[classKey].normal <= 110, `${classKey} normal temperature out of range`);
  assert.ok(thermal[classKey].abuse > thermal[classKey].normal + 10, `${classKey} abuse must be hotter than normal`);
  assert.ok(thermal[classKey].cooled < start, `${classKey} stationary tyre must cool`);
}

const prototype = settledVehicle('prototype', 'ers-regression');
prototype.setERSMode('ATTACK');
const initialEnergy = prototype.ers.energyJ;
const deployFrames = 120;
let maxDeployPower = 0;
let deployElectricalIntegral = 0;
let deployMechanicalIntegral = 0;
for (let i = 0; i < deployFrames; i += 1) {
  prototype.controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
  prototype.step(DT, flatTrack, true);
  const ers = prototype.ers;
  maxDeployPower = Math.max(maxDeployPower, ers.deployPowerW);
  deployElectricalIntegral += ers.deployPowerW * DT;
  deployMechanicalIntegral += ers.deployMechanicalPowerW * DT;
  if (ers.deployPowerW > 1) {
    const dimensionalPower = ers.driveTorqueNm * ers.rearAxleOmegaRadS;
    assert.ok(Math.abs(dimensionalPower - ers.deployMechanicalPowerW) <= Math.max(0.02, ers.deployMechanicalPowerW * 1e-7), 'deploy torque must convert to mechanical power through axle omega');
  }
}
assert.ok(maxDeployPower <= prototype.ers.maxDeployPowerW + 1e-6, 'ERS deployment must stay within configured electrical power');
assert.ok(maxDeployPower >= 100e3, 'prototype boost must deliver a materially stronger deployment than the previous 50 kW system');
assert.ok(prototype.ers.energyJ < initialEnergy, 'ERS deployment must consume SOC');
assert.ok(Math.abs((initialEnergy - prototype.ers.energyJ) - deployElectricalIntegral) <= Math.max(0.2, deployElectricalIntegral * 1e-6), 'deploy SOC delta must match electrical power integral');
assert.ok(deployMechanicalIntegral <= deployElectricalIntegral * prototype.ers.deployEfficiency + 0.2, 'deploy mechanical energy must respect efficiency');
const postDeployEnergy = prototype.ers.energyJ;
const regenFrames = 120;
let maxRegenPower = 0;
let regenElectricalIntegral = 0;
let regenMechanicalIntegral = 0;
for (let i = 0; i < regenFrames; i += 1) {
  prototype.controls = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
  prototype.step(DT, flatTrack, true);
  const ers = prototype.ers;
  maxRegenPower = Math.max(maxRegenPower, ers.regenMechanicalPowerW);
  regenElectricalIntegral += ers.regenElectricalPowerW * DT;
  regenMechanicalIntegral += ers.regenMechanicalPowerW * DT;
  if (ers.regenMechanicalPowerW > 1) {
    const dimensionalPower = ers.regenTorqueNm * ers.rearAxleOmegaRadS;
    assert.ok(Math.abs(dimensionalPower - ers.regenMechanicalPowerW) <= Math.max(0.02, ers.regenMechanicalPowerW * 1e-7), 'regen torque must convert to mechanical power through axle omega');
  }
}
assert.ok(maxRegenPower <= 200e3 + 1e-6, 'ERS regeneration must stay within 200 kW mechanical');
assert.ok(prototype.ers.energyJ > postDeployEnergy, 'ERS regeneration must recover energy');
assert.ok(Math.abs((prototype.ers.energyJ - postDeployEnergy) - regenElectricalIntegral) <= Math.max(0.2, regenElectricalIntegral * 1e-6), 'regen SOC delta must match electrical power integral');
assert.ok(regenElectricalIntegral <= regenMechanicalIntegral * prototype.ers.regenEfficiency + 0.2, 'regen electrical recovery must respect efficiency');
assert.ok(prototype.ers.capacityJ >= 6e6 && prototype.ers.capacityJ <= 10e6, 'prototype ERS store must stay tactically finite');
assert.ok(prototype.ers.soc >= 0 && prototype.ers.soc <= 1, 'ERS SOC must stay bounded');

const empty = settledVehicle('prototype', 'ers-empty');
empty.setERSMode('ATTACK');
empty.ers.energyJ = 0;
empty.controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
empty.step(DT, flatTrack, true);
assert.equal(empty.ers.deployPowerW, 0, 'empty ERS store must not deploy');
assert.equal(empty.ers.energyJ, 0, 'empty ERS store must remain empty');

const full = settledVehicle('prototype', 'ers-full');
full.setERSMode('AUTO');
full.ers.energyJ = full.ers.capacityJ;
full.controls = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
full.step(DT, flatTrack, true);
assert.equal(full.ers.regenMechanicalPowerW, 0, 'full ERS store must not accept regen');
assert.ok(full.ers.energyJ <= full.ers.capacityJ, 'full ERS store must not exceed capacity');

const off = settledVehicle('prototype', 'ers-off');
off.setERSMode('OFF');
off.controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
off.step(DT, flatTrack, true);
assert.equal(off.ers.deployPowerW, 0, 'OFF ERS mode must not deploy');
assert.equal(off.ers.regenMechanicalPowerW, 0, 'OFF ERS mode must not regen');
assert.equal(new Vehicle({ spec: 'gt' }).ers.enabled, false, 'non-prototype ERS must be disabled');

const track = new Circuit();
let worstClearance = Infinity;
let samples = 0;
for (let i = 0; i < track.samples.length; i += 2) {
  const point = track.samples[i];
  for (let lateral = -16; lateral <= 16; lateral += 1) {
    const placed = track.lateralPoint(point, lateral);
    const surface = track.surfaceAt(placed.x, placed.z);
    worstClearance = Math.min(worstClearance, surface.height - terrainHeightAt(track, placed.x, placed.z));
    samples += 1;
  }
}
assert.ok(worstClearance >= 0.18, `terrain corridor clearance must stay >= 0.18 m; got ${worstClearance}`);

console.log(JSON.stringify({
  handling,
  straightTc,
  traction: { withTc: tractionWithTc, withoutTc: tractionWithoutTc },
  thermal,
  ers: {
    capacityJ: prototype.ers.capacityJ,
    maxDeployPower,
    maxRegenPower,
    deployElectricalIntegral,
    deployMechanicalIntegral,
    regenElectricalIntegral,
    regenMechanicalIntegral,
    soc: prototype.ers.soc
  },
  terrain: { samples, worstClearance }
}, null, 2));
