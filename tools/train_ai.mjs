import { buildTrack } from '../src/track/trackBuilder.js';
import alpineDef from '../src/track/defs/alpine.js';
import { createCar, stepCar } from '../src/physics/car.js';
import { getSetup } from '../src/physics/setups.js';
import { createPolicy, evaluatePolicy, mutatePolicy, crossoverPolicy, saveWeights, NUM_WEIGHTS, loadWeights } from '../src/ai/nnPolicy.js';
import { computeRacingLine } from '../src/ai/aiDriver.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEIGHTS_FILE = path.join(__dirname, '../src/ai/trainedWeights.json');

globalThis.__APEX__ = { state: { mode: 'racing' } };

const POPULATION = 150;
const GENERATIONS = 30; // Just enough for demonstration
const MAX_TICKS = 240 * 60; // 60 seconds at 240Hz
const DT = 1 / 240;

const track = buildTrack(alpineDef);
const line = computeRacingLine(track);

// Observation Extraction
function getObs(car) {
  const obs = new Float32Array(16);
  const n = track.nearest(car.pos);
  const s = n.s;
  const sample = track.samples[n.idx] || track.samples[0];
  
  obs[0] = car.speed / 100.0;
  obs[1] = car.yawRate / 5.0;
  obs[2] = n.lateral / 10.0;
  
  let headingErr = car.heading - Math.atan2(-sample.dir.y, sample.dir.x);
  while(headingErr > Math.PI) headingErr -= 2 * Math.PI;
  while(headingErr < -Math.PI) headingErr += 2 * Math.PI;
  obs[3] = headingErr / Math.PI;
  
  const lookaheads = [10, 25, 50, 80, 120];
  for(let i=0; i<5; i++) {
    const ls = (s + lookaheads[i]) % track.length;
    let lo = 0, hi = track.samples.length - 1;
    while(lo < hi) { const m = (lo + hi) >> 1; if(track.samples[m].s < ls) lo = m + 1; else hi = m; }
    obs[4 + i] = line.curv[lo] * 10;
  }
  
  for(let i=0; i<4; i++) {
    obs[9 + i] = car.wheels[i].slipAngle / (Math.PI / 4);
  }
  
  obs[13] = car.input.throttle;
  obs[14] = car.input.brake;
  obs[15] = car.input.steer;
  return obs;
}

function evaluateAgent(policy) {
  const car = createCar(getSetup('gt3'), {});
  const s0 = track.sampleAt(track.startS);
  car.pos.set(s0.pos.x, s0.pos.y, s0.pos.z);
  car.heading = Math.atan2(-s0.dir.y, s0.dir.x);
  
  let fitness = 0;
  let ticks = 0;
  let lastS = car.progressS;
  
  while(ticks < MAX_TICKS) {
    const obs = getObs(car);
    const action = evaluatePolicy(policy, obs);
    
    car.input.steer = action.steer;
    car.input.throttle = action.throttle;
    car.input.brake = action.brake;
    
    stepCar(car, track, DT);
    
    const ds = car.progressS - lastS;
    if (ds > 0 && ds < 100) {
      fitness += ds; // Progress bonus
    } else if (ds < -track.length / 2) {
      fitness += track.length; // Wrapped around
    }
    lastS = car.progressS;
    
    if (car.offTrack) fitness -= 100 * DT;
    if (car.wallHit > 0) fitness -= 500 * DT;
    
    let maxSlip = 0;
    for(let i=0; i<4; i++) maxSlip = Math.max(maxSlip, Math.abs(car.wheels[i].slipAngle));
    if (maxSlip > 0.5) fitness -= maxSlip * 10 * DT;
    
    if (car.speed < 1 && ticks > 240 * 2) {
      break; // Stuck
    }
    if (Math.abs(obs[2]) > 1.5) {
      break; // Way off track
    }
    
    ticks++;
  }
  return fitness;
}

async function run() {
  let population = Array.from({length: POPULATION}, () => createPolicy());
  
  let bestGlobal = null;
  let bestFitnessGlobal = -Infinity;

  console.log(`Starting headless RL training with population ${POPULATION} for ${GENERATIONS} generations...`);
  
  for (let g = 0; g < GENERATIONS; g++) {
    const scores = population.map((p, i) => {
      const f = evaluateAgent(p);
      return { policy: p, fitness: f };
    });
    
    scores.sort((a, b) => b.fitness - a.fitness);
    const best = scores[0];
    
    if (best.fitness > bestFitnessGlobal) {
      bestFitnessGlobal = best.fitness;
      bestGlobal = new Float32Array(best.policy);
    }
    
    console.log(`Gen ${g}: Best Fitness = ${best.fitness.toFixed(2)} | Global Best = ${bestFitnessGlobal.toFixed(2)}`);
    
    // Elitism
    const nextGen = [new Float32Array(best.policy), new Float32Array(scores[1].policy)];
    
    // Breed and mutate
    while(nextGen.length < POPULATION) {
      const p1 = scores[Math.floor(Math.random() * 10)].policy;
      const p2 = scores[Math.floor(Math.random() * 10)].policy;
      let child = crossoverPolicy(p1, p2);
      child = mutatePolicy(child, 0.1, 0.2);
      nextGen.push(child);
    }
    
    population = nextGen;
  }
  
  console.log('Training complete. Saving weights...');
  fs.writeFileSync(WEIGHTS_FILE, saveWeights(bestGlobal));
  console.log(`Saved best weights to ${WEIGHTS_FILE}`);
}

run().catch(console.error);
