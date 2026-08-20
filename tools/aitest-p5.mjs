import { buildTrack } from '../src/track/trackBuilder.js';
import alpineDef from '../src/track/defs/alpine.js';
import { createCar, stepCar } from '../src/physics/car.js';
import { getSetup } from '../src/physics/setups.js';
import { createAiDriver, updateAiDriver } from '../src/ai/aiDriver.js';

globalThis.__APEX__ = { state: { mode: 'racing' } };
const DT = 1 / 240;
const track = buildTrack(alpineDef);
const car = createCar(getSetup('gt3'), {});
const s0 = track.sampleAt(track.startS);
car.pos.set(s0.pos.x, s0.pos.y, s0.pos.z);
car.heading = Math.atan2(-s0.dir.y, s0.dir.x);
const drv = createAiDriver(car, track, 1);

let laps = 0, off = 0, lastS = car.progressS, lapStart = 0, maxSpin = 0;
for (let t = 0; t < 300 && laps < 3; t += DT) {
  updateAiDriver(drv, [car], DT);
  stepCar(car, track, DT);
  maxSpin = Math.max(maxSpin, Math.abs(car.wheels[0].slipAngle));
  if (car.offTrack) off += DT;
  if (car.progressS < lastS - track.length / 2) {
    laps++;
    console.log(`lap ${laps}: ${(t - lapStart).toFixed(2)}s`);
    lapStart = t;
  }
  lastS = car.progressS;
}
console.log(`done laps=${laps} offtrack=${off.toFixed(2)}s maxSlip=${(maxSpin * 57.3).toFixed(1)}deg topKph=${car.speedKph.toFixed(0)}`);
