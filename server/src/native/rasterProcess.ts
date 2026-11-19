/**
 * The persistent scene raster of a host (PERF1 §5 row 10): ONE long-lived `llull-compute raster-serve` drawing every native frame, behind a
 * SYNCHRONOUS call (commands are synchronous). The child is owned by a small relay worker thread (async pipes); the calling thread posts
 * the request bytes and sleeps on a shared counter (`Atomics.wait`) until the relay has forwarded the reply chunks, the pattern of
 * `isolatedKernel.ts`. Framing: `rasterFrames.ts`.
 * Lifecycle: started on the first frame; a frame whose process died (crash, kill) restarts it and is sent once more; a frame over its
 * timeout kills the process (no retry: the next frame starts a new one); `close()` ends it (its stdin closes, it exits; a straggler is
 * killed). Requests are serialised by construction: the calling thread blocks until the reply. The worker is unref'd and the child exits at
 * the end of its input, so neither keeps a CLI process alive nor outlives the host.
 * @failure no process / died twice / timed out / broken framing -> `{ ok: false, code, message }`, never a throw
 */

import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { errorMessage } from '@lib/errorMessage';
import { createRasterReplyReader, NotRasterServeError, type RasterReply } from './rasterFrames';

/** Relay: spawns the child, forwards request bytes to its stdin and every stdout chunk / the exit back, bumping the counter each time. */
const RELAY = `
const { workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { command, args, env, signalBuffer, port } = workerData;
const signal = new Int32Array(signalBuffer);
const send = (message) => { port.postMessage(message); Atomics.add(signal, 0, 1); Atomics.notify(signal, 0); };
let gone = false;
const exit = (reason) => { if (!gone) { gone = true; send({ exit: reason }); } };
process.on('uncaughtException', (error) => { exit('relay failed: ' + (error && error.message)); process.exit(1); });
try {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env, windowsHide: true });
  child.on('error', (error) => exit('cannot run ' + command + ': ' + error.message));
  child.on('exit', (code, sig) => exit(sig !== null ? 'was killed by ' + sig : 'exited with code ' + code));
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (chunk) => send({ data: chunk }));
  if (child.pid !== undefined) send({ pid: child.pid });
  port.on('message', (message) => {
    if (message.write !== undefined) child.stdin.write(message.write);
    else child.stdin.end();
  });
} catch (error) {
  exit('cannot run ' + command + ': ' + error.message);
}
`;

interface Live {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly signal: Int32Array;
  pid: number | null;
  exited: string | null;
}

export interface RasterProcessOptions {
  /** Executable and arguments (`llull-compute raster-serve`; a test fake in tests). */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Per frame, process start included. */
  readonly frameTimeoutMs: number;
  /** A new process must report its pid (or its exit) within this; else it counts as dead (default 5 s). */
  readonly startTimeoutMs?: number;
  /** Tests only: replaces the relay worker source. */
  readonly relaySource?: string;
}

export interface RasterProcess {
  /** One frame: `request` bytes in, the reply out (restarting a dead process once); a reply may carry at most `maxReplyBytes`. */
  request(request: Uint8Array, maxReplyBytes: number): RasterReply;
  /** Process id of the live process, or null when none runs. */
  pid(): number | null;
  /** How many processes were started so far. */
  starts(): number;
  close(): void;
}

/** How long a process is given to exit after its input ended or it was killed. */
const EXIT_GRACE_MS = 2_000;
/** How long a new relay has to report its process (spawned or failed). */
const START_TIMEOUT_MS = 5_000;

const failure = (code: string, message: string): RasterReply => ({ ok: false, code, message });

export function createRasterProcess(options: RasterProcessOptions): RasterProcess {
  let live: Live | null = null;
  let started = 0;

  const launch = (): Live => {
    const signalBuffer = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(options.relaySource ?? RELAY, {
      eval: true,
      workerData: { command: options.command, args: [...options.args], env: options.env, signalBuffer, port: port2 },
      transferList: [port2],
    });
    worker.on('error', () => undefined); // a relay failure surfaces as an exit message or a timeout
    worker.unref();
    started += 1;
    return { worker, port: port1, signal: new Int32Array(signalBuffer), pid: null, exited: null };
  };

  /** Applies the pid / exit messages waiting on `target`'s port and returns the stdout chunks among them. */
  const drain = (target: Live): Uint8Array[] => {
    const chunks: Uint8Array[] = [];
    for (let message = receiveMessageOnPort(target.port); message !== undefined; message = receiveMessageOnPort(target.port)) {
      const body = message.message as { data?: Uint8Array; pid?: number; exit?: string };
      if (body.pid !== undefined) target.pid = body.pid;
      if (body.exit !== undefined) target.exited = body.exit;
      if (body.data !== undefined) chunks.push(body.data);
    }
    return chunks;
  };

  /** Waits up to `ms` for the relay to report the exit of `target`'s process (the relay reaps it: no zombie is left behind). */
  const awaitExit = (target: Live, ms: number): void => {
    const deadline = Date.now() + ms;
    let seen = Atomics.load(target.signal, 0);
    drain(target);
    while (target.exited === null && Date.now() < deadline) {
      Atomics.wait(target.signal, 0, seen, Math.max(1, deadline - Date.now()));
      seen = Atomics.load(target.signal, 0);
      drain(target);
    }
  };

  /** Ends `target`: its process is killed unless it already exited (or `graceful`: its input was ended and it exits on its own). */
  const stop = (target: Live, graceful = false): void => {
    if (live === target) live = null;
    if (graceful) awaitExit(target, EXIT_GRACE_MS);
    drain(target);
    if (target.pid !== null && target.exited === null) {
      try {
        process.kill(target.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      awaitExit(target, EXIT_GRACE_MS);
    }
    target.port.close();
    void target.worker.terminate();
  };

  /** One exchange with `target`: a reply, or why there is none (`died` = the process exited, worth one restart). */
  const exchange = (target: Live, request: Uint8Array, maxReplyBytes: number): RasterReply | { died: string } => {
    const reader = createRasterReplyReader(maxReplyBytes);
    const deadline = Date.now() + options.frameTimeoutMs;
    const startMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    // a relay that never runs (or dies before spawning) says nothing: without a pid or exit by then the process counts as dead
    const startDeadline = target.pid === null && target.exited === null ? Date.now() + startMs : Infinity;
    let seen = Atomics.load(target.signal, 0);
    target.port.postMessage({ write: request });
    for (;;) {
      for (const chunk of drain(target)) {
        const [reply] = reader.push(chunk);
        if (reply !== undefined) return reply;
      }
      if (target.exited !== null) return { died: target.exited };
      const now = Date.now();
      if (target.pid === null && now >= startDeadline) return { died: `did not start within ${startMs} ms` };
      const left = deadline - now;
      if (left <= 0) return failure('NATIVE_TIMEOUT', `the raster process did not answer within ${options.frameTimeoutMs} ms`);
      Atomics.wait(target.signal, 0, seen, target.pid === null ? Math.min(left, startDeadline - now) : left);
      seen = Atomics.load(target.signal, 0);
    }
  };

  const attempt = (request: Uint8Array, maxReplyBytes: number): RasterReply | { died: string } => {
    live ??= launch();
    const target = live;
    try {
      const outcome = exchange(target, request, maxReplyBytes);
      // a dead process, a frame over its timeout and a broken stream end this process; a refused scene keeps it
      if ('died' in outcome || (!outcome.ok && (outcome.code === 'NATIVE_TIMEOUT' || outcome.code === 'NATIVE_PROTOCOL'))) stop(target);
      return outcome;
    } catch (error) {
      stop(target); // the framing is lost: the next frame starts a new process
      if (error instanceof NotRasterServeError) return failure('NATIVE_NO_RASTER_SERVE', error.message);
      return failure('NATIVE_PROTOCOL', `raster process reply: ${errorMessage(error)}`);
    }
  };

  return {
    request(request, maxReplyBytes) {
      const first = attempt(request, maxReplyBytes);
      if (!('died' in first)) return first;
      console.warn(`[raster] the raster process ${first.died}; starting a new one for this frame`);
      const second = attempt(request, maxReplyBytes);
      return 'died' in second ? failure('NATIVE_DIED', `the raster process ${second.died} twice in a row`) : second;
    },
    pid: () => (live !== null && live.exited === null ? live.pid : null),
    starts: () => started,
    close() {
      if (live === null) return;
      live.port.postMessage({ end: true });
      stop(live, true);
    },
  };
}
