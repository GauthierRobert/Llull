/**
 * Asynchronous request/reply session with one `llull-kernel` process over NDJSON stdio (protocol: `kernelProtocol.ts`). Replies are
 * matched by id; anything on stdout that is not a reply is ignored with one warning.
 * @failure the process exits or cannot start -> every pending and later request resolves `{ result: null, error: NATIVE_DIED… }`
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { encodeRequest, NATIVE_DIED, parseReplyLine, type NativeReply } from './kernelProtocol';
import { nativeRuntimeEnv } from './nativeBinary';

/** The process as the session sees it (a fake in unit tests). */
export interface KernelChild {
  write(text: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (reason: string) => void): void;
  kill(): void;
}

export interface NativeKernelSession {
  request(op: string, args: readonly unknown[]): Promise<Omit<NativeReply, 'id'>>;
  alive(): boolean;
  close(): void;
}

export function createKernelSession(child: KernelChild): NativeKernelSession {
  const pending = new Map<number, (reply: Omit<NativeReply, 'id'>) => void>();
  let nextId = 1;
  let exitReason: string | null = null;
  let warnedNoise = false;

  child.onLine((line) => {
    const reply = parseReplyLine(line);
    const settle = reply === null ? undefined : pending.get(reply.id);
    if (reply === null || settle === undefined) {
      if (!warnedNoise && line.trim() !== '') console.warn(`[occt-native] ignoring non-protocol output: ${line.slice(0, 120)}`);
      warnedNoise = true;
      return;
    }
    pending.delete(reply.id);
    settle(reply.error === undefined ? { result: reply.result } : { result: reply.result, error: reply.error });
  });
  child.onExit((reason) => {
    exitReason = reason;
    for (const settle of pending.values()) settle({ result: null, error: `${NATIVE_DIED}: ${reason}` });
    pending.clear();
  });

  return {
    request: (op, args) => {
      if (exitReason !== null) return Promise.resolve({ result: null, error: `${NATIVE_DIED}: ${exitReason}` });
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        try {
          child.write(encodeRequest(id, op, args));
        } catch (error) {
          pending.delete(id);
          resolve({ result: null, error: `${NATIVE_DIED}: ${error instanceof Error ? error.message : String(error)}` });
        }
      });
    },
    alive: () => exitReason === null,
    close: () => child.kill(),
  };
}

/** `binary --exit-on-eof` with piped stdin/stdout; stderr (OCCT messages) goes to the server's stderr. */
export function spawnKernelChild(binary: string): KernelChild {
  const kernelProcess = spawn(binary, ['--exit-on-eof'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: nativeRuntimeEnv(binary),
  });
  const exitListeners: ((reason: string) => void)[] = [];
  let exited = false;
  const exit = (reason: string): void => {
    if (exited) return;
    exited = true;
    exitListeners.forEach((listener) => listener(reason));
  };
  kernelProcess.on('error', (error) => exit(`cannot run ${binary}: ${error.message}`));
  kernelProcess.on('exit', (code, signal) => exit(signal !== null ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`));
  kernelProcess.stdin.on('error', () => undefined); // a write after death surfaces through the exit event
  const lines = createInterface({ input: kernelProcess.stdout });
  return {
    write: (text) => void kernelProcess.stdin.write(text),
    onLine: (listener) => void lines.on('line', listener),
    onExit: (listener) => void exitListeners.push(listener),
    kill: () => {
      kernelProcess.stdin.end();
      kernelProcess.kill();
    },
  };
}
