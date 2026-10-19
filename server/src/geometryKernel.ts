/**
 * Inject the configured geometry kernel into the core at startup (architecture L9) so boolean and
 * fillet commands work for the CLI exactly as in the desktop app. `LLULL_KERNEL` unset (or any unknown value) installs
 * the native `llull-kernel` sidecar (RS-1, KI7, LC1 step 1) when the binary is found (`native/nativeBinary.ts`), else Manifold with a
 * warning and `kernel_info.fallbackReason`. `LLULL_KERNEL=manifold` is a diagnostic override (Manifold, no warning);
 * `LLULL_KERNEL=occt-native` requires the sidecar (falls back to the WASM OpenCascade, then Manifold); `LLULL_KERNEL=occt` is the WASM
 * OpenCascade (falls back to Manifold on failure).
 */

import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { KernelInfo } from '@core/geometry/kernelPorts';
import { createIsolatedKernel, defaultWorkerEntry } from './isolatedKernel';
import type { KernelChoice } from '@core/geometry/kernelChoice';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { errorMessage } from '@lib/errorMessage';
import { positiveInteger } from './env';
import { NATIVE_KERNEL_CHOICE, startNativeKernel } from './nativeKernel';

let activeKernel: KernelChoice | null = null;

/** Kernel actually installed, or null before/without one. */
export function getActiveKernelName(): KernelChoice | null {
  return activeKernel;
}

function warnUnavailable(label: string, error: unknown): void {
  console.warn(`[server] ${label}:`, errorMessage(error));
}

/** One OCC call blocks the whole server (HTTP, SSE keepalives) while it runs, so it is bounded. */
const DEFAULT_OCC_CALL_TIMEOUT_MS = 30_000;

/** `LLULL_OCC_TIMEOUT_MS`: positive milliseconds a single OCC call may run before its worker is killed. */
export function occtCallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env['LLULL_OCC_TIMEOUT_MS'], DEFAULT_OCC_CALL_TIMEOUT_MS);
}

/**
 * OCC in a worker thread, so a WASM abort kills the worker, not the server. Null (in-process OCC is
 * used instead, with a warning) when `LLULL_OCC_ISOLATION=off`, when the worker entry is not
 * shipped (`npm run build` emits dist/occtWorker.js) or when the worker cannot start.
 */
function startIsolatedOcct(): GeometryKernel | null {
  if (process.env['LLULL_OCC_ISOLATION'] === 'off' || defaultWorkerEntry() === null) return null;
  const isolated = createIsolatedKernel({ callTimeoutMs: occtCallTimeoutMs() });
  if (isolated.start()) return isolated;
  isolated.dispose();
  warnUnavailable('OCC worker unavailable; running OCC in-process', 'a WASM abort would stop the server');
  return null;
}

/** `kernel` whose `info()` also tells how the server runs it (`kernel_info`, TR-KRN-04); every other member is the kernel's own. */
function described(kernel: GeometryKernel, extra: Pick<KernelInfo, 'isolation' | 'fallbackReason'>): GeometryKernel {
  return { ...kernel, info: () => ({ capabilities: [], ...kernel.info?.(), ...extra }) };
}

export interface KernelInstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Native sidecar start (tests inject the discovery and the process). */
  readonly startNative?: typeof startNativeKernel;
}

/** Load the configured kernel; on failure commands keep their graceful "no kernel" no-op. */
export async function installGeometryKernel(options: KernelInstallOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const startNative = options.startNative ?? startNativeKernel;
  let fallbackReason: string | undefined;
  const requested = env['LLULL_KERNEL']?.trim().toLowerCase();
  const wasmRequested = requested === 'occt';
  const nativeRequested = requested === NATIVE_KERNEL_CHOICE;
  if (requested !== 'manifold' && !wasmRequested) {
    const native = startNative({ callTimeoutMs: occtCallTimeoutMs(env) }, env);
    if ('kernel' in native) {
      setGeometryKernel(described(native.kernel, { isolation: 'process' }));
      activeKernel = 'occt';
      return true;
    }
    fallbackReason = native.reason;
    warnUnavailable(
      nativeRequested
        ? 'native OCC kernel unavailable; falling back to the WASM OCC kernel'
        : 'native OCC kernel unavailable; using Manifold',
      native.reason,
    );
  }
  if (nativeRequested || wasmRequested) {
    try {
      const { createNodeOcctKernel } = await import('./occtNode');
      const isolated = startIsolatedOcct();
      const isolation = isolated === null ? 'in-process' : 'worker';
      setGeometryKernel(
        described(isolated ?? (await createNodeOcctKernel()), { isolation, ...(fallbackReason === undefined ? {} : { fallbackReason }) }),
      );
      activeKernel = 'occt';
      return true;
    } catch (error) {
      fallbackReason = fallbackReason === undefined ? errorMessage(error) : `${fallbackReason}; ${errorMessage(error)}`;
      warnUnavailable('OCC kernel unavailable; falling back to Manifold', error);
    }
  }
  try {
    setGeometryKernel(
      described(await createManifoldKernel(), { isolation: 'in-process', ...(fallbackReason === undefined ? {} : { fallbackReason }) }),
    );
    activeKernel = 'manifold';
    return true;
  } catch (error) {
    warnUnavailable('geometry kernel unavailable; boolean commands will no-op', error);
    return false;
  }
}
