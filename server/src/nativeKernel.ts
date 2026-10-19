/**
 * The native OCC kernel (RS-1, opt-in `LLULL_KERNEL=occt-native`): `GeometryKernel` over the `llull-kernel` sidecar, through the same
 * synchronous worker proxy as the WASM kernel (`isolatedKernel.ts`: timeout, recycle, blob resend). Ops the sidecar does not implement
 * yet are answered per op by the WASM OCC kernel inside the same worker (`native/kernelRouter.ts`).
 * @failure binary missing -> `NATIVE_TOOL_MISSING` reason with the install hint; worker or sidecar not starting -> a reason; the caller
 *   falls back to the WASM kernel
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createIsolatedKernel, type IsolatedKernel } from './isolatedKernel';
import { nativeBinaryPath, nativeInstallHint } from './native/nativeBinary';

/** `LLULL_KERNEL` value selecting the native kernel. */
export const NATIVE_KERNEL_CHOICE = 'occt-native';

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
  return { reason: `${binary} did not start (see the server log)` };
}
