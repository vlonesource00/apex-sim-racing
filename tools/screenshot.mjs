import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

import os from 'node:os';

function findChrome() {
  const cache = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(cache)) {
    const versions = fs.readdirSync(cache).sort().reverse();
    for (const v of versions) {
      const p = path.join(cache, v, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => fs.existsSync(p));
}
const EDGE = findChrome();

const url = process.env.URL || 'http://localhost:5199';
const outDir = process.env.OUT || path.resolve('shots');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  defaultViewport: { width: 1600, height: 900 },
  args: [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--no-sandbox',
    '--window-size=1600,900',
  ],
});

const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__APEX__ && window.__APEX__.state.mode !== "loading"', { timeout: 30000 });

const key = async (code, down) => page.keyboard[down ? 'down' : 'up'](code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(outDir, name + '.png') });

// countdown ends at 3.5s
await sleep(4000);
await shot('01_grid');

// launch and drive
await key('KeyW', true);
await sleep(2500);
await shot('02_chase_accel');

// steer through first corner
await key('KeyA', true);
await sleep(600);
await key('KeyA', false);
await sleep(1500);
await shot('03_chase_corner');

// cockpit
await key('KeyC', true); await key('KeyC', false);
await sleep(1000);
await shot('04_cockpit');

// hood
await key('KeyC', true); await key('KeyC', false);
await sleep(1000);
await shot('05_hood');

// continue driving further down the circuit
await key('KeyC', true); await key('KeyC', false); // back to chase
await sleep(3000);
await shot('06_back_straight');

const info = await page.evaluate(() => {
  const s = window.__APEX__.state;
  return {
    mode: s.mode, fps: s.fps, cam: s.cameraMode,
    speed: Math.round(s.player.speedKph),
    pos: s.player.pos.toArray().map((v) => v.toFixed(1)),
    cars: s.cars.length,
  };
});
console.log('STATE', JSON.stringify(info));
console.log('ERRORS', errors.length ? errors.slice(0, 10) : 'none');
await browser.close();
