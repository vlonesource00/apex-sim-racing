import assert from 'node:assert/strict';
import { SynthAudio } from '../src/audio.js';

class Param {
  constructor(value = 0) { this.value = value; this.calls = []; }
  setTargetAtTime(value, time, constant) { this.value = value; this.calls.push({ value, time, constant }); }
  setValueAtTime(value, time) { this.value = value; this.calls.push({ value, time }); }
  exponentialRampToValueAtTime(value, time) { this.value = value; this.calls.push({ value, time }); }
}
class Node {
  constructor() { this.connections = []; this.disconnected = 0; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected += 1; }
}
class Oscillator extends Node {
  constructor() { super(); this.frequency = new Param(); this.type = ''; this.started = 0; this.stopped = 0; this.onended = null; }
  start() { this.started += 1; }
  stop() { this.stopped += 1; this.onended?.(); }
}
class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
class Filter extends Node { constructor() { super(); this.frequency = new Param(); this.Q = new Param(); this.type = ''; } }
class BufferSource extends Node { constructor() { super(); this.loop = false; this.buffer = null; this.started = 0; this.stopped = 0; } start() { this.started += 1; } stop() { this.stopped += 1; } }
class MockAudioContext {
  constructor() { this.currentTime = 3; this.sampleRate = 16; this.destination = new Node(); this.state = 'running'; this.oscillators = []; this.sources = []; }
  createGain() { return new Gain(); }
  createBiquadFilter() { return new Filter(); }
  createOscillator() { const node = new Oscillator(); this.oscillators.push(node); return node; }
  createBufferSource() { const node = new BufferSource(); this.sources.push(node); return node; }
  createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
  async resume() { this.state = 'running'; }
}

const previousWindow = globalThis.window;
globalThis.window = { AudioContext: MockAudioContext };
const audio = new SynthAudio();
await audio.unlock();
assert.equal(audio.ready, true, 'Unlock must preserve public ready behavior');
assert.ok(audio.ersOscillator && audio.regenOscillator && audio.pitLimiterOscillator, 'Continuous ERS/regen/pit limiter sources missing');
assert.ok(audio.curbGain && audio.continuousSources.length >= 10, 'Continuous curb/noise graph missing');
const vehicle = {
  rpm: 6500,
  speed: 42,
  gear: 3,
  engineTorque: 480,
  controls: { throttle: 0.82 },
  ers: { deployPowerW: 120000, regenPowerW: 70000 },
  pitLimiterActive: true,
  wheels: [{ slip: 0.3, utilisation: 0.9, surface: 'curb', suspensionVelocity: 2.1, contactHeight: 0.05 }]
};
audio.update(vehicle, 1);
assert.ok(audio.ersGain.gain.value > 0.01, 'ERS deployment must drive its gain');
assert.ok(audio.regenGain.gain.value > 0.005, 'Regen must drive its distinct gain');
assert.ok(audio.curbGain.gain.value > 0.01, 'Curb contact must drive rumble');
assert.ok(audio.pitLimiterGain.gain.value > 0.004, 'Pit limiter must drive harmonic');
const beforeShift = audio.context.oscillators.length;
vehicle.gear = 4;
audio.update(vehicle, 0.2);
assert.ok(audio.context.oscillators.length >= beforeShift + 2, 'Upshift must emit decisive transient pair');
for (let index = 0; index < 55; index += 1) audio.update(vehicle, 1);
assert.ok(audio.ambientIndex >= 2, 'Ambient horn/warning/PA scheduler must advance deterministically');
assert.equal(typeof audio.toggleMute(), 'boolean', 'toggleMute public contract regressed');
const continuous = [...audio.continuousSources];
audio.dispose();
assert.equal(audio.ready, false, 'Dispose must clear ready state');
assert.ok(continuous.every((source) => source.stopped > 0 && source.disconnected > 0), 'Continuous sources must stop and disconnect during cleanup');

delete globalThis.window;
const noContext = new SynthAudio();
await noContext.unlock();
assert.equal(noContext.ready, false, 'Audio must safely no-op without AudioContext');
noContext.update({}, 0.1);
if (previousWindow !== undefined) globalThis.window = previousWindow;

console.log('Audio contract passed: ERS, regen, shifts, curb rumble, pit limiter, bounded ambient scheduler, and cleanup.');
