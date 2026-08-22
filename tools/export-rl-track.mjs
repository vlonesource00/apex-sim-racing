import fs from 'node:fs';
import { Circuit } from '../src/simulation/Track.js';
import { ENDURANCE_PARK } from '../src/scenarios/EndurancePark.js';

const track = new Circuit(ENDURANCE_PARK);
const sampleCount = 2048;
const samples = Array.from({ length: sampleCount }, (_, index) => {
  const s = track.length * index / sampleCount;
  const point = track.atDistance(s);
  return {
    s: Number(s.toFixed(6)),
    curvature: Number(point.curvature.toFixed(9)),
    targetSpeedMps: Number(track.targetSpeed(s, 0.96).toFixed(6)),
    bank: Number(point.bank.toFixed(8)),
    grade: Number(point.grade.toFixed(8))
  };
});
const payload = { name: ENDURANCE_PARK.name, lengthM: track.length, sampleCount, samples };
fs.writeFileSync(new URL('../rl/track_profile.json', import.meta.url), `${JSON.stringify(payload)}\n`);
console.log(JSON.stringify({ name: payload.name, lengthM: payload.lengthM, sampleCount }));
