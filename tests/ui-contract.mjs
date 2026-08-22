import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const hud = read('../src/ui/HUD.js');
const input = read('../src/input.js');
const main = read('../src/main.js');
const style = read('../src/style.css');

for (const role of [
  'position', 'lap', 'race-time', 'phase', 'speed', 'gear', 'rpm', 'throttle', 'brake',
  'tc', 'abs', 'bias', 'ers-soc', 'ers-power', 'standings-rows', 'motec', 'ai-panel',
  'ai-name', 'ai-mode', 'ai-reason', 'ai-controls', 'ai-threat', 'ai-ttc', 'ai-field', 'rubber', 'tow', 'dirty', 'pit',
  'countdown', 'notice', 'finish', 'mute'
]) assert.match(hud, new RegExp(`data-role="${role}"`), `HUD role missing: ${role}`);

assert.match(hud, /update\(vehicle, status, perf, cameraMode, raceActive = true, context = \{\}\)/);
assert.match(hud, /leaderboard/);
assert.match(hud, /aiDebug/);
assert.match(hud, /monotonicNow = \(\) => globalThis\.performance\?\.now\?\.\(\) \?\? Date\.now\(\)/);
assert.match(hud, /_standingsSignature/);
assert.match(hud, /_standingsLastRenderAt/);
assert.match(hud, /< 100/);
assert.match(hud, /GAP \/ M/);
assert.match(input, /'F3'/);
assert.match(input, /'F4'/);
assert.match(input, /'F5'/);
assert.match(input, /'F6'/);
assert.match(input, /'KeyP'/);
assert.match(input, /'KeyN'/);
assert.match(main, /aiDebug\.toggle\(\)/);
assert.match(main, /aiDebug\.toggleFieldView\(\)/);
assert.match(main, /aiDebug\.cycleSelection\(\)/);
assert.match(main, /cameraRig\.setSpectate\(\)/);
assert.match(main, /cameraRig\.setFree\(\)/);
assert.match(main, /cameraRig\.updateFree\(input\.freeCameraRaw\(\), rawDelta\)/);
assert.match(main, /race\.standings\(player\)/);
assert.match(main, /controllers, aiDebug/);
for (const token of ['.standings-panel', '.electronics-panel', '.ai-panel', '.driver-cluster', '.gear-cluster', '.motec', '@media (max-width: 640px)']) {
  assert.match(style, new RegExp(token.replace(/[().]/g, '\\$&')), `HUD CSS missing: ${token}`);
}
assert.match(style, /\.hud\.armed \.help\s*\{\s*display:\s*none;/, 'in-race help must hide to protect telemetry/RPM area');

console.log('UI contract passed: required HUD roles, F3/N actions, context wiring, and responsive panel rules.');
