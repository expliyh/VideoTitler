import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type ProjectRootContext = {
  cwd: string;
  mainDir: string;
};

export type PythonExecutableContext = {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

function hasWorkerModule(rootPath: string): boolean {
  return existsSync(join(rootPath, 'videotitler', 'worker.py'));
}

export function resolveProjectRoot(context: ProjectRootContext): string {
  const candidates = [
    context.cwd,
    resolve(context.mainDir, '../../../..')
  ];

  for (const candidate of candidates) {
    if (hasWorkerModule(candidate)) {
      return candidate;
    }
  }

  return context.cwd;
}

export function resolvePythonExecutable(context: PythonExecutableContext): string {
  const override = context.env.VIDEOTITLER_PYTHON?.trim();
  if (override) {
    return override;
  }

  const venvPath = context.platform === 'win32'
    ? join(context.projectRoot, '.venv', 'Scripts', 'python.exe')
    : join(context.projectRoot, '.venv', 'bin', 'python');

  if (existsSync(venvPath)) {
    return venvPath;
  }

  return 'python';
}
