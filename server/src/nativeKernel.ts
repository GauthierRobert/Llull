/**
 * The native OCC kernel (RS-1, KI7): `GeometryKernel` over the `llull-kernel` sidecar, through a synchronous worker proxy
 * (`isolatedKernel.ts`: timeout, restart, blob resend).
 * @failure binary missing -> `NATIVE_TOOL_MISSING` reason with the install hint; worker or sidecar not starting -> a reason; the caller
 *   falls back to Manifold
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createIsolatedKernel, type IsolatedKernel } from './isolatedKernel';
import { nativeBinaryPath, nativeInstallHint, nativeRuntimeEnv } from './native/nativeBinary';

/** Path of the worker entry next to this module (source `.ts` or bundled `.js`), or null when not shipped. */
function nativeKernelWorkerEntry(): string | null {
  for (const extension of ['.ts', '.js']) {
    const candidate = path.join(__dirname, `nativeKernelWorker${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface NativeKernelOptions {
  readonly callTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly testHooks?: boolean;
}

/** The proxy over `binary` (not started: call `start()`). */
export function createNativeKernel(binary: string, options: NativeKernelOptions = {}): IsolatedKernel {
  const entry = nativeKernelWorkerEntry();
  if (entry === null) throw new Error('native kernel worker entry not found next to the server modules');
  return createIsolatedKernel({ ...options, entry, workerData: { binary } });
}

/** The started native kernel, or why it is not available (the caller logs the reason and falls back). */
export function startNativeKernel(
  options: NativeKernelOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): { readonly kernel: IsolatedKernel } | { readonly reason: string } {
  const binary = nativeBinaryPath('llull-kernel', env);
  if (binary === null) return { reason: `NATIVE_TOOL_MISSING: ${nativeInstallHint('llull-kernel')}` };
  if (nativeKernelWorkerEntry() === null) return { reason: 'native kernel worker entry not shipped with the server' };
  const kernel = createNativeKernel(binary, options);
  if (kernel.start()) return { kernel };
  kernel.dispose();
  return { reason: `${binary} did not start: ${startFailureCause(binary, env)}` };
}

/** Windows exit code of a process whose DLLs cannot be loaded (STATUS_DLL_NOT_FOUND). */
const STATUS_DLL_NOT_FOUND = 0xc0000135;

/** Why `binary` does not run, from a one-shot `--version` probe (the worker's own death only reaches the debug log). */
function startFailureCause(binary: string, env: NodeJS.ProcessEnv = process.env): string {
  const probe = spawnSync(binary, ['--version'], {
    env: nativeRuntimeEnv(binary, env),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.error !== undefined) return probe.error.message;
  if (probe.status === STATUS_DLL_NOT_FOUND || /shared libraries|TKw+.dll/.test(probe.stderr ?? '')) {
    return 'its OCCT libraries (TK*.dll) were not found; set LLULL_OCCT_DIR to the OCCT install prefix or put them next to the binary';
  }
  if (probe.status !== 0) return `it exited with code ${probe.status ?? probe.signal ?? 'unknown'}`;
  return 'its worker failed to start (set LLULL_DEBUG=1 for details)';
}
