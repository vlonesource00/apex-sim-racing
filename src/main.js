import { createGame } from './game/game.js';
import { state } from './game/state.js';
import { createHud } from './ui/hud.js';
import { createMenus } from './ui/menus.js';

const app = document.getElementById('app');
const canvas = document.createElement('canvas');
app.appendChild(canvas);

const loader = document.getElementById('loader');
const loadbar = document.getElementById('loadbar');
loadbar.style.width = '60%';

const game = createGame(canvas);
const hud = createHud(document.getElementById('hud'));
const menus = createMenus(document.getElementById('menus'), game);
window.__APEX_MENUS__ = menus;
loadbar.style.width = '100%';
setTimeout(() => loader.classList.add('hidden'), 250);

let last = performance.now();
let fpsAcc = 0, fpsCount = 0, fpsTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // clamp huge frame gaps (tab switch)

  fpsAcc += dt; fpsCount++; fpsTimer += dt;
  if (fpsTimer >= 0.5) { state.fps = Math.round(fpsCount / fpsAcc); fpsAcc = 0; fpsCount = 0; fpsTimer = 0; }

  if (state.mode !== 'paused') game.update(dt);
  game.render();
  hud.update(state);
}
requestAnimationFrame(frame);

// Expose for headless tooling / critics
window.__APEX__ = { state, game };
