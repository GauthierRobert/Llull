/**
 * Shared vocabulary between `isolatedKernel.ts` (server thread) and `nativeKernelWorker.ts` (worker).
 * Status word (shared `Int32Array`): 0 = busy, 3 = kernel ready, 1 = a reply waits on the message
 * port, 2 = the worker died while handling a request.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';

export const STATUS_REPLY = 1;
export const STATUS_DIED = 2;
export const STATUS_READY = 3;

/** `faceQuery.<method>`: one request per face-query port method (the port is an object, not a method). */
type FaceQueryOperation = `faceQuery.${keyof FaceQueryPort}`;
export type KernelOperation = keyof GeometryKernel | FaceQueryOperation;
export type TestHook = '__abort' | '__hang' | '__exitIdle';
/** Host-to-worker message (no reply): stop the native op that is running (it answers `KRN_TIMEOUT`). */
export const CANCEL_OPERATION = '__cancel';

export interface KernelRequest {
  readonly op: KernelOperation | TestHook | typeof CANCEL_OPERATION;
  readonly args: readonly unknown[];
}

export interface KernelReply {
  readonly result: unknown;
  readonly error?: string;
}
