import assert from 'node:assert/strict';
import { PassQualityTracker } from '../src/simulation/PassQuality.js';

const track = { length: 1000 };
const car = (id, distance) => ({ id, distance, surface: { zone: 'road' }, finished: false, retired: false });
const attacker = car('attacker', 100);
const defender = car('defender', 104);
const tracker = new PassQualityTracker(track);
tracker.update([attacker, defender], {}, 0.1);
attacker.distance = 110;
defender.distance = 103;
for (let step = 0; step < 11; step += 1) tracker.update([attacker, defender], {}, 0.1);
assert.equal(tracker.snapshot().cleanPasses, 1, 'a legal contact-free pass held clear for one second must count');

tracker.reset();
attacker.distance = 100;
defender.distance = 104;
tracker.update([attacker, defender], {}, 0.1);
attacker.distance = 101;
tracker.update([attacker, defender], { contactPairs: [{ a: attacker.id, b: defender.id, impact: 2 }] }, 0.1);
attacker.distance = 110;
defender.distance = 103;
tracker.update([attacker, defender], {}, 0.1);
for (let step = 0; step < 10; step += 1) tracker.update([attacker, defender], {}, 0.1);
assert.equal(tracker.snapshot().cleanPasses, 0, 'contact must invalidate pass success');
assert.equal(tracker.snapshot().rejectedContact, 1);

tracker.reset();
attacker.distance = 100;
defender.distance = 104;
tracker.update([attacker, defender], {}, 0.1);
attacker.distance = 110;
defender.distance = 103;
defender.surface.zone = 'grass';
for (let step = 0; step < 11; step += 1) tracker.update([attacker, defender], {}, 0.1);
assert.equal(tracker.snapshot().rejectedOffTrack, 1, 'a pass that leaves either car off track must be rejected');
console.log(JSON.stringify(tracker.snapshot(), null, 2));
