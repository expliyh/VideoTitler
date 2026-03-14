import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function hasElectronVite() {
  try {
    require.resolve('electron-vite/package.json');
    return true;
  } catch {
    return false;
  }
}

if (hasElectronVite()) {
  console.log('Desktop dev tooling is ready (electron-vite found).');
  process.exit(0);
}

console.warn('electron-vite is missing. Installing desktop workspace dependencies...');

const install = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['install', '--filter', '@videotitler/desktop...'],
  {
    stdio: 'inherit',
    env: process.env
  }
);

if (install.status !== 0) {
  console.error('Failed to install desktop dependencies. Please run `pnpm install` at the workspace root.');
  process.exit(install.status ?? 1);
}

if (!hasElectronVite()) {
  console.error('electron-vite is still missing after install. Please run `pnpm install` at the workspace root.');
  process.exit(1);
}

console.log('Desktop tooling installed successfully (electron-vite found).');
