import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type WorkerEnvelope = {
  type: 'event' | 'response';
  requestId?: string;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  [key: string]: unknown;
};

export type PythonWorkerClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export class PythonWorkerClient extends EventEmitter {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env?: NodeJS.ProcessEnv;
  private child: ChildProcessWithoutNullStreams | null;
  private nextRequestId: number;
  private readonly pendingRequests: Map<string, PendingRequest>;
  private stdoutBuffer: string;
  private stderrBuffer: string;
  private exitPromise: Promise<void> | null;

  constructor(options: PythonWorkerClientOptions) {
    super();
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    this.env = options.env;
    this.child = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.exitPromise = null;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: 'pipe'
    });

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.flushBuffer('stdout');
    });

    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      this.flushBuffer('stderr');
    });

    child.on('error', (error) => {
      this.rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
      this.emit('error', error);
    });

    this.exitPromise = new Promise((resolvePromise) => {
      child.once('exit', (code, signal) => {
        this.child = null;
        const reason = code === 0
          ? 'Worker exited.'
          : `Worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
        this.rejectPendingRequests(new Error(reason));
        this.emit('exit', { code, signal });
        resolvePromise();
      });
    });
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.child) {
      throw new Error('Python worker is not running.');
    }

    const requestId = String(this.nextRequestId++);
    const payload = JSON.stringify({
      requestId,
      method,
      params
    });

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
    });

    this.child.stdin.write(`${payload}\n`);
    return responsePromise;
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }

    try {
      await this.request('shutdown', {});
    } catch {
      this.child.kill();
    }

    await this.exitPromise;
  }

  private flushBuffer(stream: 'stdout' | 'stderr'): void {
    let buffer = stream === 'stdout' ? this.stdoutBuffer : this.stderrBuffer;
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        if (stream === 'stdout') {
          this.handleStdoutLine(line);
        } else {
          this.emit('stderr', line);
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }

    if (stream === 'stdout') {
      this.stdoutBuffer = buffer;
    } else {
      this.stderrBuffer = buffer;
    }
  }

  private handleStdoutLine(line: string): void {
    let envelope: WorkerEnvelope;
    try {
      envelope = JSON.parse(line) as WorkerEnvelope;
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (envelope.type === 'event') {
      this.emit('event', envelope);
      return;
    }

    if (envelope.type !== 'response') {
      return;
    }

    const requestId = String(envelope.requestId ?? '');
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(requestId);
    if (envelope.ok) {
      pending.resolve(envelope.payload);
      return;
    }

    pending.reject(new Error(envelope.error || 'Worker request failed.'));
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
