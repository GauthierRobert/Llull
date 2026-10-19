/**
 * Per-op routing of the native kernel worker (RS-1): an op the sidecar implements goes to `llull-kernel`; an op it lacks, a recipe it
 * answers `NATIVE_UNSUPPORTED`, or a call during which the sidecar died goes to the WASM OCC kernel instead (loaded on first need).
 * Each op's first fallback is logged once. `info` describes both engines.
 * @invariant replies keep the `KernelOps` shapes: a native `evaluate` answers a key-only handle, `tessellate` plain-array MeshData
 * @failure a throw anywhere -> `{ result: null, error }`, never a rejection
 */

import type { KernelInfo } from '@core/geometry/kernelPorts';
import { errorMessage } from '@lib/errorMessage';
import type { KernelReply, KernelRequest } from '../occtWorkerProtocol';
import { decodeMesh, isUnsupported, NATIVE_DIED, nativeArgs, type NativeInfo } from './kernelProtocol';
import type { NativeKernelSession } from './kernelSession';

/** One request answered by the fallback kernel, synchronously (the WASM kernel in the worker thread). */
export type FallbackRunner = (request: KernelRequest) => KernelReply;

type KernelEngine = 'native' | 'wasm';

export interface KernelRouterDeps {
  /** A live session (the caller respawns a dead sidecar here). */
  readonly session: () => NativeKernelSession;
  readonly fallback: () => Promise<FallbackRunner>;
  readonly native: NativeInfo;
  readonly warn?: (message: string) => void;
}

export interface KernelRouter {
  route(request: KernelRequest): Promise<KernelReply>;
  /** Requests answered per engine and op (observability, tests). */
  served(): Readonly<Record<KernelEngine, Readonly<Record<string, number>>>>;
}

/** Version label of the fallback build, from its `info()`. */
function fallbackLabel(info: KernelInfo | null): string {
  return info?.build ?? 'opencascade.js';
}

export function createKernelRouter(deps: KernelRouterDeps): KernelRouter {
  const nativeOps = new Set(deps.native.ops);
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const logged = new Set<string>();
  const served: Record<KernelEngine, Record<string, number>> = { native: {}, wasm: {} };
  const count = (engine: KernelEngine, op: string): void => void (served[engine][op] = (served[engine][op] ?? 0) + 1);

  const viaFallback = async (request: KernelRequest, reason: string): Promise<KernelReply> => {
    if (!logged.has(request.op)) {
      logged.add(request.op);
      warn(`[occt-native] ${request.op}: answered by the WASM OCC kernel (${reason})`);
    }
    const run = await deps.fallback();
    count('wasm', request.op);
    return run(request);
  };

  const describe = async (): Promise<KernelReply> => {
    const run = await deps.fallback();
    const wasm = run({ op: 'info', args: [] }).result as KernelInfo | null;
    const info: KernelInfo = {
      ...wasm,
      occtVersion: deps.native.occtVersion,
      build: `${deps.native.build} (OCCT ${deps.native.occtVersion}, native) + ${fallbackLabel(wasm)} for ops it lacks`,
      capabilities: [...new Set([...(wasm?.capabilities ?? []), ...deps.native.capabilities])],
    };
    return { result: info };
  };

  const route = async (request: KernelRequest): Promise<KernelReply> => {
    if (request.op === 'info') return describe();
    if (!nativeOps.has(request.op)) return viaFallback(request, 'op not native yet');
    const reply = await deps.session().request(request.op, nativeArgs(request.op, request.args));
    if (isUnsupported(reply.error) || reply.error?.startsWith(NATIVE_DIED) === true) return viaFallback(request, reply.error ?? '');
    count('native', request.op);
    const result = request.op === 'tessellate' ? decodeMesh(reply.result) : reply.result;
    return reply.error === undefined ? { result } : { result, error: reply.error };
  };

  return {
    route: async (request) => {
      try {
        return await route(request);
      } catch (error) {
        return { result: null, error: errorMessage(error) };
      }
    },
    served: () => served,
  };
}
