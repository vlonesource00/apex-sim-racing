import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const candidates = [
  process.env.BLENDER_PATH,
  'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
  'blender'
].filter(Boolean);

const blender = candidates.find((candidate) => candidate === 'blender' || existsSync(candidate));
if (!blender) {
  throw new Error('Blender not found. Set BLENDER_PATH or install Blender 5.1.');
}

const assetArgs = process.argv.slice(2);
const result = spawnSync(blender, ['--background', '--python', 'tools/blender/build_assets.py', ...(assetArgs.length ? ['--', ...assetArgs] : [])], {
  cwd: root,
  stdio: 'inherit'
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
