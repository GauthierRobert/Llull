/**
 * Request routing of the native kernel worker (RS-1, KI7): each request is rewritten for the `llull-kernel` sidecar (feature nodes lowered
 * on the host first, `kernelFeatures.ts`; recipes, args and meshes translated, `kernelProtocol.ts`) and answered by it. A recipe or op the
 * sidecar refuses answers its error with a null result, as a refusal does; there is no second kernel behind it.
 * Document blobs (`loadBlob`) reach the sidecar at once and again after a respawn, since `brep` leaves evaluate there.
 * @invariant replies keep the `KernelOps` shapes: a native `evaluate` answers a key-only handle, `tessellate` plain-array MeshData
 * @failure a throw anywhere -> `{ result: null, error }`, never a rejection
 */

import { errorMessage } from '@lib/errorMessage';
import type { KernelReply, KernelRequest } from '../kernelWorkerProtocol';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { decodeMesh, isUnsupported, NATIVE_DIED, nativeArgs, nativeRecipe, type NativeInfo } from './kernelProtocol';
import { prepareFeatures, type SourceMesher } from './kernelFeatures';
import type { NativeKernelSession } from './kernelSession';

export interface KernelRouterDeps {
  /** A live session (the caller respawns a dead sidecar here). */
  readonly session: () => NativeKernelSession;
  readonly native: NativeInfo;
}

export interface KernelRouter {
  route(request: KernelRequest): Promise<KernelReply>;
}

export function createKernelRouter(deps: KernelRouterDeps): KernelRouter {
  const nativeOps = new Set(deps.native.ops);
  const blobs = new Map<string, string>();
  let blobsSentTo: NativeKernelSession | null = null;

  /** The live session, holding every blob loaded so far (a respawned sidecar gets them again). */
  const nativeSession = async (): Promise<NativeKernelSession> => {
    const session = deps.session();
    if (blobsSentTo !== session && nativeOps.has('loadBlob')) {
      blobsSentTo = session;
      for (const [sha256, text] of blobs) await session.request('loadBlob', [sha256, text]);
    }
    return session;
  };

  const loadBlob = async (request: KernelRequest): Promise<KernelReply> => {
    const [sha256, text] = request.args;
    if (typeof sha256 !== 'string' || typeof text !== 'string') return { result: null, error: 'loadBlob expects (sha256, text)' };
    if (!nativeOps.has('loadBlob')) return { result: null, error: 'NATIVE_UNSUPPORTED: op loadBlob' };
    const session = await nativeSession();
    blobs.set(sha256, text);
    const reply = await session.request('loadBlob', [sha256, text]);
    return reply.error === undefined ? { result: null } : { result: null, error: reply.error };
  };

  const describe = (): KernelReply => ({
    result: {
      occtVersion: deps.native.occtVersion,
      build: `${deps.native.build} (OCCT ${deps.native.occtVersion}, native)`,
      capabilities: deps.native.capabilities,
    },
  });

  // what the host may send beyond the baseline wire format follows the capabilities the sidecar reported
  const wire = { bsplineSections: deps.native.capabilities.includes('bsplineSections') };

  const sourceMesh: SourceMesher = async (source, features) => {
    const reply = await (await nativeSession()).request('tessellate', [{ key: recipeKey(source), recipe: nativeRecipe(source, features, wire) }]);
    if (isUnsupported(reply.error) || reply.error?.startsWith(NATIVE_DIED) === true) return 'unsupported';
    return decodeMesh(reply.result);
  };

  const route = async (request: KernelRequest): Promise<KernelReply> => {
    if (request.op === 'info') return describe();
    if (request.op === 'loadBlob') return loadBlob(request);
    if (!nativeOps.has(request.op)) return { result: null, error: `NATIVE_UNSUPPORTED: op ${request.op}` };
    const prepared = await prepareFeatures(request.op, request.args, sourceMesh);
    if ('unsupported' in prepared) return { result: null, error: prepared.unsupported };
    const reply = await (await nativeSession()).request(request.op, nativeArgs(request.op, request.args, prepared.features, wire));
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
  };
}
