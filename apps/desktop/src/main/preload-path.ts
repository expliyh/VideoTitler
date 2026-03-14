import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PRELOAD_CANDIDATES = ['../preload/index.cjs', '../preload/index.js', '../preload/index.mjs'];

export function resolvePreloadPath(mainDir: string): string {
  for (const relativePath of PRELOAD_CANDIDATES) {
    const preloadPath = join(mainDir, relativePath);
    if (existsSync(preloadPath)) {
      return preloadPath;
    }
  }

  throw new Error(`Unable to locate a preload bundle from ${mainDir}`);
}
