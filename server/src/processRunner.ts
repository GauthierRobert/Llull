/**
 * The one external-tool runner (CalculiX, MFront / MTest, the Python bridge, DWG converters, llull-compute, the SVG rasterizer): hard timeout
 * that kills the WHOLE process tree (win32: `taskkill /T /F /PID <pid>`, by PID only; elsewhere the child leads its own process group and
 * the group is killed), resolution on 'exit' so the timeout holds even when a grandchild keeps the pipes open, last 64 KB of stdout + stderr
 * kept. `runProcess` is async; `runProcessSync` serves the synchronous host ports (ctx.raster, ctx.pointCloud) by running the same async
 * logic in a short-lived node helper, so a timed-out tool never leaves descendants behind.
 */

import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { isRecord } from '@lib/isRecord';
import { trackChild } from './childProcesses';

const LOG_TAIL_BYTES = 64 * 1024;
const PIPE_DRAIN_GRACE_MS = 1000;
/** Named guard: the sync helper gets this long beyond the tool's own timeout to kill the tree and report before it is itself killed. */
const SYNC_HELPER_GRACE_MS = 15_000;
const DEFAULT_SYNC_MAX_BYTES = 64 * 1024 * 1024;

/** Keep the last `maxBytes` of a child's stream; the getter returns them as UTF-8. */
function captureTail(stream: Readable, maxBytes: number): () => string {
  let tail = Buffer.alloc(0);
  stream.on('data', (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-maxBytes);
  });
  return () => tail.toString('utf8');
}

export interface ProcessResult {
  /** null = killed (timeout) or not started. */
  readonly exitCode: number | null;
  readonly log: string;
  readonly timedOut: boolean;
  /** Set when the executable could not be started (ENOENT, EACCES). */
  readonly startError?: string;
}

export interface ProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Written to the child's stdin, then closed. */
  readonly input?: string;
  /** Stderr (and stdout, without `onStdout`) tail size in bytes. */
  readonly tailBytes?: number;
  /** Sees every stdout chunk (the tail is then not kept); returning `false` kills the tree and ends the run with `aborted`. */
  readonly onStdout?: (chunk: Buffer) => boolean | void;
  /** Aborting kills the tree and ends the run with `cancelled` (async runner only). */
  readonly signal?: AbortSignal;
  /**
   * Windows: start the child detached (own process group, no console, still no window: windowsHide), so a console Ctrl-C reaches only this process and
   * only `killProcessTree` stops the child. Elsewhere every child already leads its own group. Off by default: tools that expect a console keep it.
   */
  readonly ownProcessGroup?: boolean;
  /**
   * Start the child with a stdin pipe the host never writes to and never closes while it lives. A detached child is not in the host's kill-on-close job
   * on Windows and outlives a hard kill of the host; the pipe closes with the host however it died, and a child that reads it (`llull-compute` with
   * `LLULL_EXIT_ON_STDIN_EOF=1`) exits on that end of input.
   */
  readonly holdStdin?: boolean;
}

export interface ProcessOutcome extends ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  /** `onStdout` returned false (or the sync output cap was hit). */
  readonly aborted: boolean;
  /** `signal` was aborted before the child ended on its own. */
  readonly cancelled: boolean;
  /** `error.code` of a start failure (ENOENT, EACCES, ...). */
  readonly startErrorCode?: string;
}

export interface SyncProcessOutcome extends ProcessOutcome {
  readonly stdoutBytes: Buffer;
}

export type SyncProcessSpec = Omit<ProcessSpec, 'onStdout'> & { readonly maxBuffer?: number };

interface SpawnPlan {
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly detached: boolean;
  readonly pipeInput: boolean;
}

export interface ProcessRunnerHooks {
  readonly spawnProcess: (
    executable: string,
    args: readonly string[],
    options: SpawnPlan,
  ) => ChildProcessByStdio<Writable | null, Readable, Readable>;
  /** Kills `child` and every descendant. */
  readonly killTree: (child: ChildProcess) => void;
  readonly platform: NodeJS.Platform;
}

/**
 * Kill the process tree rooted at `pid` (never by image name): `taskkill /T /F /PID` on Windows (the parent links find detached descendants too), the
 * process group elsewhere. `fallback` runs when the tree kill cannot be done (no such group, taskkill missing).
 */
export function killPidTree(pid: number, fallback: () => void, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    killer.on('error', fallback);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

/** Kill the process tree rooted at `child`. */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (child.pid === undefined) return;
  killPidTree(child.pid, () => void child.kill('SIGKILL'), platform);
}

const REAL_HOOKS: ProcessRunnerHooks = {
  spawnProcess: (executable, args, options) =>
    spawn(executable, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      detached: options.detached,
      stdio: [options.pipeInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>,
  killTree: killProcessTree,
  platform: process.platform,
};

/** `holdStdin` keeps the pipe open and unwritten; `input` writes and closes it: asking for both is a programming error. */
function refuseHeldStdinWithInput(spec: { readonly input?: string | undefined; readonly holdStdin?: boolean | undefined }): void {
  if (spec.holdStdin === true && spec.input !== undefined)
    throw new Error('runProcess: holdStdin and input cannot be combined (input closes the pipe holdStdin keeps open)');
}

/** Run one tracked child to completion, timeout or abort; never rejects. */
export function runProcess(spec: ProcessSpec, hooks: ProcessRunnerHooks = REAL_HOOKS): Promise<ProcessOutcome> {
  refuseHeldStdinWithInput(spec);
  return new Promise((resolve) => {
    const tailBytes = spec.tailBytes ?? LOG_TAIL_BYTES;
    const child = trackChild(
      hooks.spawnProcess(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: hooks.platform !== 'win32' || spec.ownProcessGroup === true,
        pipeInput: spec.input !== undefined || spec.holdStdin === true,
      }),
    );
    const onStdout = spec.onStdout;
    const stdout = onStdout === undefined ? captureTail(child.stdout, tailBytes) : () => '';
    const stderr = captureTail(child.stderr, tailBytes);
    let timedOut = false;
    let aborted = false;
    let cancelled = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      spec.signal?.removeEventListener('abort', onCancel);
      resolve(outcome);
    };
    const outcome = (code: number | null): ProcessOutcome => ({
      exitCode: code,
      log: `${stdout()}${stderr()}`.slice(-LOG_TAIL_BYTES),
      stdout: stdout(),
      stderr: stderr(),
      timedOut,
      aborted,
      cancelled,
    });
    const onCancel = (): void => {
      if (settled || cancelled) return;
      cancelled = true;
      hooks.killTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      hooks.killTree(child);
    }, spec.timeoutMs);
    if (spec.signal?.aborted === true) onCancel();
    else spec.signal?.addEventListener('abort', onCancel, { once: true });
    if (onStdout !== undefined)
      child.stdout.on('data', (chunk: Buffer) => {
        if (aborted || onStdout(chunk) !== false) return;
        aborted = true;
        hooks.killTree(child);
        finish(outcome(null));
      });
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({
        exitCode: null,
        log: '',
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        cancelled: false,
        startError: error.message,
        ...(error.code !== undefined ? { startErrorCode: error.code } : {}),
      }),
    );
    child.on('exit', (code) => {
      if (timedOut || cancelled) finish(outcome(code));
      else drain = setTimeout(() => finish(outcome(code)), PIPE_DRAIN_GRACE_MS);
    });
    child.on('close', (code) => finish(outcome(code)));
    if (spec.holdStdin === true) child.stdin?.on('error', () => undefined); // the child may exit first; the pipe is never written to
    if (spec.input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => undefined); // the exit handler reports the failure
      child.stdin.end(spec.input);
    }
  });
}

/** `runProcess` reduced to the CalculiX / MTest shape (the combined log tail). */
export async function runTrackedProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  hooks: ProcessRunnerHooks = REAL_HOOKS,
): Promise<ProcessResult> {
  const run = await runProcess({ executable, args, cwd, timeoutMs, env }, hooks);
  return {
    exitCode: run.exitCode,
    log: run.log,
    timedOut: run.timedOut,
    ...(run.startError !== undefined ? { startError: run.startError } : {}),
  };
}

/**
 * The async runner above, as a self-contained script for a throw-away node process (its kill logic mirrors `killProcessTree`): reads the
 * spec as JSON on stdin, writes `{exitCode, timedOut, aborted, startError, startErrorCode, stdout, stderr}` (the streams base64) on stdout.
 */
const SYNC_HELPER_SCRIPT = `
const { spawn } = require('child_process');
const spec = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const win = process.platform === 'win32';
const out = [];
let err = Buffer.alloc(0), size = 0, timedOut = false, aborted = false, done = false, startError, startErrorCode, timer, drain;
const finish = (exitCode) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  clearTimeout(drain);
  const reply = { exitCode, timedOut, aborted, startError, startErrorCode, stdout: Buffer.concat(out).toString('base64'), stderr: err.toString('base64') };
  process.stdout.write(JSON.stringify(reply), () => process.exit(0));
};
const child = spawn(spec.executable, spec.args, {
  cwd: spec.cwd, env: spec.env, detached: !win, windowsHide: true,
  stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
});
const kill = () => {
  if (child.pid === undefined) return;
  if (win) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'));
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
};
timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);
child.stdout.on('data', (chunk) => {
  if (aborted) return;
  size += chunk.length;
  if (size > spec.maxBuffer) { aborted = true; kill(); finish(null); } else out.push(chunk);
});
child.stderr.on('data', (chunk) => { err = Buffer.concat([err, chunk]).subarray(-spec.tailBytes); });
child.on('error', (e) => { startError = e.message; startErrorCode = e.code; finish(null); });
child.on('exit', (code) => { if (timedOut) finish(code); else drain = setTimeout(() => finish(code), ${PIPE_DRAIN_GRACE_MS}); });
child.on('close', (code) => finish(code));
if (spec.input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(spec.input); }
`;

const failedSync = (startError: string, extra: Partial<SyncProcessOutcome> = {}): SyncProcessOutcome => ({
  exitCode: null,
  log: '',
  stdout: '',
  stderr: '',
  stdoutBytes: Buffer.alloc(0),
  timedOut: false,
  aborted: false,
  cancelled: false,
  startError,
  ...extra,
});

/** Blocking `runProcess` (same timeout, tree kill and tails) for the synchronous ports; never throws. */
export function runProcessSync(spec: SyncProcessSpec): SyncProcessOutcome {
  refuseHeldStdinWithInput(spec);
  const maxBuffer = spec.maxBuffer ?? DEFAULT_SYNC_MAX_BYTES;
  const tailBytes = spec.tailBytes ?? LOG_TAIL_BYTES;
  const request = {
    executable: spec.executable,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: spec.timeoutMs,
    input: spec.input,
    maxBuffer,
    tailBytes,
  };
  const helper = spawnSync(process.execPath, ['-e', SYNC_HELPER_SCRIPT], {
    input: JSON.stringify(request),
    timeout: spec.timeoutMs + SYNC_HELPER_GRACE_MS,
    maxBuffer: Math.ceil((maxBuffer * 4) / 3) + 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    encoding: 'utf8',
  });
  if (helper.error !== undefined) {
    const timedOut = (helper.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return timedOut ? { ...failedSync(''), timedOut: true } : failedSync(helper.error.message);
  }
  let reply: unknown;
  try {
    reply = JSON.parse(helper.stdout);
  } catch {
    return failedSync('the process helper returned no result');
  }
  if (!isRecord(reply)) return failedSync('the process helper returned no result');
  const bytes = (field: unknown): Buffer => Buffer.from(typeof field === 'string' ? field : '', 'base64');
  const stdoutBytes = bytes(reply['stdout']);
  const stderr = bytes(reply['stderr']).toString('utf8');
  const stdout = stdoutBytes.toString('utf8');
  const startError = reply['startError'];
  const startErrorCode = reply['startErrorCode'];
  return {
    exitCode: typeof reply['exitCode'] === 'number' ? reply['exitCode'] : null,
    log: `${stdout}${stderr}`.slice(-LOG_TAIL_BYTES),
    stdout,
    stderr,
    stdoutBytes,
    timedOut: reply['timedOut'] === true,
    aborted: reply['aborted'] === true,
    cancelled: false,
    ...(typeof startError === 'string' ? { startError } : {}),
    ...(typeof startErrorCode === 'string' ? { startErrorCode } : {}),
  };
}
