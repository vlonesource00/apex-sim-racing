import assert from 'node:assert/strict';
import { PIT_STATES, PitSystem, applyPitIntentToControls, evaluatePitNeed } from '../src/simulation/PitSystem.js';

const track = { length: 3000 };
const tire = (wear, temperature = 108) => ({
  wear,
  temperatureInnerC: temperature,
  temperatureMiddleC: temperature,
  temperatureOuterC: temperature,
  carcassTemperatureC: temperature,
  flashTemperatureC: temperature + 8,
  pressurePa: 225000,
  energyJ: 1000,
  thermalEnergyJ: 800
});
const vehicle = {
  id: 'synthetic-01',
  distance: 0.805 * track.length,
  speed: 27,
  lateral: 1.2,
  wheels: [tire(0.86), tire(0.77), tire(0.72), tire(0.68)]
};
const config = {
  pit: {
    entryFraction: 0.80,
    limiterFraction: 0.82,
    boxStartFraction: 0.85,
    boxEndFraction: 0.88,
    exitFraction: 0.92,
    lateralM: -12,
    entryLateralM: -9,
    exitLateralM: -7,
    pitSpeedLimitMps: 16.67,
    entrySpeedLimitMps: 23,
    boxSpeedMps: 1.1,
    stoppedSpeedMps: 0.5,
    serviceDurationS: 2,
    ambientTemperatureC: 25,
    coldPressurePa: 185000
  }
};
const pits = new PitSystem(track, [vehicle], config);

assert.equal(pits.status(vehicle).state, PIT_STATES.NONE);
pits.request(vehicle);
pits.update(0.1);
assert.equal(pits.status(vehicle).state, PIT_STATES.ENTRY, 'Requested car must enter rather than teleport');
assert.equal(pits.intentFor(vehicle).targetLateralM, -9, 'Entry must guide AI to the entry lateral target');

vehicle.distance = 0.825 * track.length;
pits.update(0.1);
assert.equal(pits.status(vehicle).state, PIT_STATES.LIMITER, 'Car must reach pit limiter after entry');
const limiterIntent = pits.intentFor(vehicle);
assert.equal(limiterIntent.limiterActive, true, 'Limiter intent must be active');
assert.ok(limiterIntent.speedLimitMps <= 16.67 && limiterIntent.throttleLimit < 1 && limiterIntent.brakeRequest > 0, 'Limiter must publish enforceable control ceilings');
const limitedControls = applyPitIntentToControls({ throttle: 1, brake: 0 }, limiterIntent);
assert.ok(limitedControls.throttle < 1 && limitedControls.brake > 0, 'Control helper must apply limiter advisory without Vehicle internals');

vehicle.distance = 0.86 * track.length;
vehicle.speed = 3;
pits.update(0.1);
assert.equal(pits.status(vehicle).state, PIT_STATES.BOX, 'Car must reach a box before service');
pits.update(0.1);
assert.equal(pits.status(vehicle).state, PIT_STATES.BOX, 'Moving car must not receive service');

vehicle.speed = 0;
pits.update(0.1);
assert.equal(pits.status(vehicle).state, PIT_STATES.SERVICE, 'Stopped car in box must begin service');
pits.update(1);
assert.equal(pits.status(vehicle).state, PIT_STATES.SERVICE, 'Service must remain deterministic until duration expires');
pits.update(1.1);
assert.equal(pits.status(vehicle).state, PIT_STATES.EXIT, 'Completed service must send car to exit');
for (const wheel of vehicle.wheels) {
  assert.equal(wheel.wear, 0, 'Service must refresh tyre wear');
  assert.equal(wheel.temperatureInnerC, 25, 'Service must refresh tyre temperature');
  assert.equal(wheel.pressurePa, 185000, 'Service must reset cold pressure');
}
const serviced = pits.status(vehicle);
assert.equal(serviced.cumulativeStops, 1);
assert.ok(serviced.cumulativeServiceTimeS >= 2);

vehicle.distance = 0.95 * track.length;
pits.update(0.1);
assert.equal(pits.status(vehicle).state, PIT_STATES.NONE, 'Exit must return car to normal race state');

vehicle.wheels[0].wear = 0.95;
const need = evaluatePitNeed(vehicle, 5);
assert.equal(need.shouldPit, true, 'AI helper must call an emergency worn tyre');
assert.ok(need.maxWear >= 0.95 && need.tireCount === 4);
pits.reset([vehicle]);
assert.equal(pits.status(vehicle).state, PIT_STATES.NONE, 'Reset must restore deterministic pit state');
assert.equal(pits.status(vehicle).cumulativeStops, 0, 'Reset must clear stop accounting');

console.log('Pit system regression passed: full request-to-exit cycle, limiter intent, stopped-only service, tyre refresh, AI wear threshold.');
