/**
 * @layer server
 * Shared vocabulary between `isolatedKernel.ts` (server thread) and `occtWorker.ts` (worker).
 * Status word (shared `Int32Array`): 0 = busy, 3 = kernel ready, 1 = a reply waits on the message
 * port, 2 = the worker died while handling a request.
 */

import type { GeometryKernel } from '@core/geometry/kernel';

export const STATUS_REPLY = 1;
export const STATUS_DIED = 2;
export const STATUS_READY = 3;

export type KernelOperation = keyof GeometryKernel;
export type TestHook = '__abort' | '__hang';

export interface KernelRequest {
  readonly op: KernelOperation | TestHook;
  readonly args: readonly unknown[];
}

export interface KernelReply {
  readonly result: unknown;
  readonly error?: string;
  /** The operation ended in a native OCC exception: the module may be degraded, restart it. */
  readonly recycle?: boolean;
}
