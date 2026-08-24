import assert from 'node:assert/strict';
import { Vehicle } from '../src/simulation/Vehicle.js';

const car = new Vehicle({ id: 'manual-gearbox', player: true, spec: 'prototype' });
assert.equal(car.transmissionMode, 'automatic', 'Vehicles must default to automatic mode');
assert.equal(car.toggleTransmissionMode(), 'manual', 'G must select manual sequential mode');

car.gear = 1;
assert.equal(car.requestShift(1), true, 'Manual upshift must be accepted');
assert.equal(car.gear, 2);
assert.equal(car.shiftTimer, 0.09, 'Upshift must use the upshift torque-cut duration');
assert.equal(car.requestShift(1), false, 'A second shift must be rejected during the active torque cut');

car.shiftTimer = 0;
car.localVelocity.z = 5;
assert.equal(car.requestShift(-1), true, 'Safe downshift must be accepted');
assert.equal(car.gear, 1);
assert.equal(car.shiftTimer, 0.075, 'Downshift must use the shorter blip duration');
assert.equal(car.autoBlip, 1, 'Accepted downshift must request a throttle blip');

car.gear = 6;
car.shiftTimer = 0;
car.localVelocity.z = 95;
const gearBeforeRejectedShift = car.gear;
assert.equal(car.requestShift(-1), false, 'Over-rev downshift must be rejected');
assert.equal(car.gear, gearBeforeRejectedShift, 'Rejected downshift must not change gear');
assert.equal(car.lastShiftRejected, 'OVERREV');

car.place({ x: 0, z: 0, y: 0 }, 0);
assert.equal(car.transmissionMode, 'manual', 'Resetting the car must preserve the player transmission choice');
assert.equal(car.toggleTransmissionMode(), 'automatic');
assert.equal(car.requestShift(1), false, 'Manual shift commands must not override automatic mode');

console.log('Manual gearbox regression passed: sequential shifts, torque cut, blip, over-rev protection, and reset persistence.');
