import assert from 'node:assert/strict';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { updateAerodynamicWakes, resolveVehicleCollisions } from '../src/simulation/VehicleInteractions.js';

const finiteTree = (value, label = 'value') => {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${label} must be finite`);
  else if (Array.isArray(value)) value.forEach((entry, index) => finiteTree(entry, `${label}[${index}]`));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => finiteTree(entry, `${label}.${key}`));
};

const makeCar = (id, spec, x, z, speed = 40) => {
  const vehicle = new Vehicle({ id, spec });
  vehicle.place(x, z, 0);
  vehicle.velocity.z = speed;
  vehicle.speed = speed;
  return vehicle;
};

for (const leaderClass of ['prototype', 'gt', 'touring']) {
  const leader = makeCar(`leader-${leaderClass}`, leaderClass, 0, 0);
  const follower = makeCar(`follower-${leaderClass}`, leaderClass, 0, -15);
  const clean = follower._aeroForces(40);
  updateAerodynamicWakes([leader, follower]);
  const dirty = follower._aeroForces(40);
  const dragReduction = 1 - dirty.drag / clean.drag;
  assert.ok(dragReduction >= 0.05 && dragReduction <= 0.18, `${leaderClass} tow should be bounded`);
  assert.ok(follower.wake.frontDownforceLoss >= 0.04, `${leaderClass} dirty air should be measurable`);
  finiteTree(follower.wake, `${leaderClass}.wake`);
  finiteTree(follower.aero, `${leaderClass}.aero`);
}

const prototypeLeader = makeCar('proto-leader', 'prototype', 0, 0);
const protoFollower = makeCar('proto-follower', 'prototype', 0, -15);
const touringLeader = makeCar('tour-leader', 'touring', 20, 0);
const touringFollower = makeCar('tour-follower', 'touring', 20, -15);
updateAerodynamicWakes([prototypeLeader, protoFollower, touringLeader, touringFollower]);
assert.ok(protoFollower.wake.frontDownforceLoss > touringFollower.wake.frontDownforceLoss, 'prototype dirty air must exceed touring dirty air');

const offAxis = makeCar('off-axis', 'gt', 5, -15);
const ahead = makeCar('ahead', 'gt', 0, 15);
const leader = makeCar('clean-leader', 'gt', 0, 0);
updateAerodynamicWakes([leader, offAxis, ahead]);
assert.equal(offAxis.wake.dragReduction, 0, 'off-axis follower must remain clean');
assert.equal(ahead.wake.dragReduction, 0, 'vehicle ahead must remain clean');

const first = makeCar('contact-a', 'gt', 0, 0, 12);
const second = makeCar('contact-b', 'gt', 0.1, 0.1, 10);
const before = first.obbContact(second);
assert.ok(before?.penetration > 0, 'overlapping cars should expose an OBB contact');
const stats = resolveVehicleCollisions([first, second], 3);
assert.ok(stats.contacts > 0 && stats.maxPenetration > 0, 'resolver should report contacts');
assert.ok(stats.deepOverlaps === 0, 'three-pass resolver should clear deep overlap');
for (const car of [first, second]) finiteTree({ position: car.position, velocity: car.velocity, yawRate: car.yawRate }, car.id);

console.log('Vehicle interaction contract passed: bounded class wake, truthful dirty air, clean alignment gates, and finite SAT contacts.');
