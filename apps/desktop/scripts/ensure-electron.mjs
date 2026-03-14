import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronPackageJsonPath = require.resolve('electron/package.json');
const electronDir = dirname(electronPackageJsonPath);
const pathFile = join(electronDir, 'path.txt');

function getInstalledBinaryPath() {
  if (!existsSync(pathFile)) {
    return null;
  }

  const executable = readFileSync(pathFile, 'utf8').trim();
  if (!executable) {
    return null;
  }

  return join(electronDir, 'dist', executable);
}

const installedBinaryPath = getInstalledBinaryPath();
if (installedBinaryPath && existsSync(installedBinaryPath)) {
  console.log(`Electron already installed at ${installedBinaryPath}`);
  process.exit(0);
}

const installScript = join(electronDir, 'install.js');
console.log('Electron binary is missing, running electron/install.js...');

const result = spawnSync(process.execPath, [installScript], {
  cwd: electronDir,
  stdio: 'inherit',
  env: process.env
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const resolvedBinaryPath = getInstalledBinaryPath();
if (!resolvedBinaryPath || !existsSync(resolvedBinaryPath)) {
  console.error('Electron installation completed, but no runnable binary was found.');
  process.exit(1);
}

console.log(`Electron installed at ${resolvedBinaryPath}`);
