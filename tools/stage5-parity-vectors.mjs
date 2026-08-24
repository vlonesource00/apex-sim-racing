import { TrafficAwareness } from '../src/ai/TrafficAwareness.js';
import { minimumJerk } from '../src/ai/FrenetTrajectoryPlanner.js';
import { basePedals, steeringCommand } from '../src/ai/DeterministicDriver.js';

const scenarios = [
  { name: 'clear-left-pass', terminal: [-4.1, 0.2, 2.8, -1.8], target: [1, 0, 0, 1],
    cars: [[100, 0, 0, 38, 0, 0, 0, 0.7], [124, 0, 0, 24, 0, 0, 0, 0], [92, 3.4, 0, 35, 0, 0, 0, 0], [145, -2.8, 0, 31, 0, 0, 0, 0]] },
  { name: 'blocked-left-pass', terminal: [-4.2, 0, -3.9, 3.6], target: [1, 0, 0, 1],
    cars: [[300, 0.1, 0, 42, 0, 0, 0, 0.8], [322, 0, 0, 30, 0, 0, 0, 0], [309, -4.0, 0, 39, 0, 0, 0, 0], [292, 3.2, 0, 38, 0, 0, 0, 0]] },
  { name: 'three-wide', terminal: [0, -3.7, 3.7, 0], target: [1, 0, 0, 1],
    cars: [[600, 0, 0, 34, 0, 0, 0, 0.6], [604, -3.3, 0, 33, 0, 0, 0, 0], [604.5, 3.3, 0, 33, 0, 0, 0, 0], [625, 0, 0, 26, 0, 0, 0, 0]] }
];

const awareness = new TrafficAwareness();
const track = { length: 3120, roadHalfWidth: 7.2,
  atDistance: (distance) => ({ s: ((distance % 3120) + 3120) % 3120 }),
  planningLateralLimit: () => 5.45 };

const results = scenarios.map((scenario) => {
  const cars = scenario.cars.map((state, index) => ({ id: `car-${index}`, index, distance: state[0], speed: state[3] }));
  const output = cars.map((vehicle, ego) => {
    const traffic = { current: { lateral: scenario.cars[ego][1] }, entries: cars
      .filter((_, opponent) => opponent !== ego)
      .map((other) => ({ other, delta: other.distance - vehicle.distance,
        otherLateral: scenario.cars[other.index][1], otherTargetLateral: scenario.cars[other.index][1] })) };
    const result = awareness.evaluateCorridor({ vehicle, track, traffic,
      terminalOffset: scenario.terminal[ego], targetId: cars[scenario.target[ego]].id,
      targetSpeed: vehicle.speed + 7 });
    return { collisionFree: result.collisionFree, legal: result.legal,
      minimumClearanceM: result.minimumClearanceM, targetSeparationM: result.targetSeparationM };
  });
  return { ...scenario, output };
});

const controlInputs = [
  { previous: 0, headingError: 0.12, lateralError: -2.4, yawRate: 0.2, dt: 1 / 120,
    committed: true, recovering: false, yielding: false, speedError: 7, straight: true, vehicleSpeed: 35, desiredSpeed: 42 },
  { previous: -0.4, headingError: -0.5, lateralError: 4.2, yawRate: -0.8, dt: 1 / 120,
    committed: false, recovering: false, yielding: false, speedError: -5, straight: false, vehicleSpeed: 31, desiredSpeed: 26 },
  { previous: 0.7, headingError: 1.3, lateralError: -8, yawRate: 1.1, dt: 1 / 120,
    committed: false, recovering: true, yielding: true, speedError: -12, straight: false, vehicleSpeed: 24, desiredSpeed: 7 }
];
const controls = controlInputs.map((input) => ({ input,
  steering: steeringCommand(input), pedals: basePedals(input) }));
console.log(JSON.stringify({ minimumJerk: [0, 0.1, 0.25, 0.5, 0.75, 1].map(minimumJerk),
  controls, scenarios: results }));
