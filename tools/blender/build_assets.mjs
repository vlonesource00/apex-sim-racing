import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const blenderPath = 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe';
const scriptPath = path.join(__dirname, 'generate_assets.py');

console.log('Running Blender asset generation pipeline...');
try {
    execSync(`"${blenderPath}" --background --python "${scriptPath}"`, { stdio: 'inherit' });
    console.log('Asset generation complete.');
} catch (error) {
    console.error('Failed to run Blender pipeline:', error);
    process.exit(1);
}
