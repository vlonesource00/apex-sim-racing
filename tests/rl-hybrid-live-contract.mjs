import assert from 'node:assert/strict';
import policy from '../rl/policies/stage1_policy_compact.json' with { type: 'json' };
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';
import { Vehicle } from '../src/simulation/Vehicle.js';
import { RaceState } from '../src/simulation/Race.js';
import { AIController } from '../src/simulation/AI.js';
import { RLShadowController } from '../src/ai/RLShadowController.js';

const DT = 1 / 120;
const track = new Circuit(ENDURANCE_PARK);
const vehicle = new Vehicle({ id: 'hybrid-ai', name: 'HYBRID', spec: 'prototype' });
const race = new RaceState(track, [vehicle], 1);
const grid = race.gridPosition(0);
vehicle.resetTo(track, grid.distance, grid.lateral);
race.reset();
const lowLevel = new AIController(2);
lowLevel.setDebugEnabled(true);
const tactical = new RLShadowController(policy);

let learnedDecisions = 0;
let lastDecisionId = 0;
for (let step = 0; step < 18 / DT; step += 1) {
  race.step(DT);
  const decision = tactical.update(vehicle, track, DT);
  if (decision && decision.decisions !== lastDecisionId) {
    learnedDecisions += 1;
    lastDecisionId = decision.decisions;
    assert.equal(lowLevel.setTacticalPolicy(decision), true);
  }
  lowLevel.update(vehicle, [vehicle], track, race, DT);
  vehicle.step(DT, track, race.phase === 'racing');
}

assert.ok(learnedDecisions >= 340 && learnedDecisions <= 365, 'learned tactical loop must run at 20 Hz');
assert.equal(vehicle.aiTactical.source, 'RL_HYBRID');
assert.equal(lowLevel.debugState.tacticalPolicy.source, 'RL_HYBRID');
assert.ok(Math.abs(vehicle.aiTactical.lineBiasM) > 0.02, 'learned line action must reach the live tactical fusion');
assert.ok(Math.abs(vehicle.aiTactical.paceDelta) > 0.001, 'learned pace action must reach target-speed planning');
assert.ok(Math.abs(vehicle.aiTactical.lineBiasM) <= 1.45, 'live line bias must remain safety bounded');
assert.ok(Math.abs(vehicle.aiTactical.paceDelta) <= 0.025, 'live pace delta must remain safety bounded');
for (const value of Object.values(vehicle.controls)) assert.ok(Number.isFinite(value), 'deterministic low-level controls must remain finite');
assert.ok(vehicle.surface.zone === 'road' || vehicle.surface.zone === 'kerb', 'hybrid controller must remain on the racing surface');

console.log(JSON.stringify({ learnedDecisions, aiTactical: vehicle.aiTactical, controls: vehicle.controls }, null, 2));
