import assert from 'node:assert/strict';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { orderVehiclesByClassPace } from '../src/simulation/GridOrder.js';

const vehicles = ['touring', 'gt', 'prototype', 'touring', 'prototype', 'gt']
  .map((spec, index) => new Vehicle({ id: `grid-${index}`, spec }));
const ordered = orderVehiclesByClassPace(vehicles);

assert.deepEqual(ordered.map((vehicle) => vehicle.classKey),
  ['prototype', 'prototype', 'gt', 'gt', 'touring', 'touring']);
assert.deepEqual(ordered.map((vehicle) => vehicle.id),
  ['grid-2', 'grid-4', 'grid-1', 'grid-5', 'grid-0', 'grid-3'],
  'drivers within a class must retain their original order');
assert.deepEqual(vehicles.map((vehicle) => vehicle.id),
  ['grid-0', 'grid-1', 'grid-2', 'grid-3', 'grid-4', 'grid-5'],
  'grid ordering must not mutate the canonical vehicle array');

console.log('Grid class-order contract passed: Prototype, GT, Touring with stable teammates.');
