/** Per-op routing of the native kernel worker: native first, WASM for what the sidecar lacks, logged once per op. */

import { describe, expect, it } from 'vitest';
import type { KernelReply, KernelRequest } from '../src/occtWorkerProtocol';
import { createKernelRouter, type FallbackRunner, type KernelRouter } from '../src/native/kernelRouter';
import type { NativeKernelSession } from '../src/native/kernelSession';
import type { NativeInfo } from '../src/native/kernelProtocol';
import { box, leaf } from './kernelTestSupport';

const NATIVE: NativeInfo = {
  occtVersion: '7.8.1',
  build: 'llull-kernel@0.1.0',
  capabilities: ['analyze', 'massProperties'],
  ops: ['info', 'evaluate', 'tessellate', 'massProperties'],
};

type Answer = (op: string, args: readonly unknown[]) => { result: unknown; error?: string };

interface Harness {
  readonly router: KernelRouter;
  readonly nativeCalls: { op: string; args: readonly unknown[] }[];
  readonly fallbackCalls: KernelRequest[];
  readonly warnings: string[];
  fallbackLoads(): number;
}

function harness(answer: Answer): Harness {
  const nativeCalls: { op: string; args: readonly unknown[] }[] = [];
  const fallbackCalls: KernelRequest[] = [];
  const warnings: string[] = [];
  let fallbackLoads = 0;
  const session: NativeKernelSession = {
    request: (op, args) => {
      nativeCalls.push({ op, args });
      return Promise.resolve(answer(op, args));
    },
    alive: () => true,
    close: () => undefined,
  };
  const runner: FallbackRunner = (request): KernelReply => {
    fallbackCalls.push(request);
    if (request.op === 'info')
      return { result: { occtVersion: '7.4.0p1', build: 'opencascade.js@1.1.1', capabilities: ['topology', 'analyze'] } };
    return { result: `wasm:${request.op}` };
  };
  const router = createKernelRouter({
    native: NATIVE,
    session: () => session,
    fallback: () => {
      fallbackLoads++;
      return Promise.resolve(runner);
    },
    warn: (message) => void warnings.push(message),
  });
  return { router, nativeCalls, fallbackCalls, warnings, fallbackLoads: () => fallbackLoads };
}

const cube = leaf(box([0, 0, 0], [1, 1, 1]));

describe('native kernel router', () => {
  it('serves native ops natively and never loads the WASM kernel for them', async () => {
    const h = harness((op, args) => ({ result: op === 'evaluate' ? { key: (args[0] as { key: string }).key } : { volume: 1 } }));
    expect((await h.router.route({ op: 'evaluate', args: [cube] })).result).toMatchObject({ key: expect.any(String) });
    expect(await h.router.route({ op: 'massProperties', args: [{ key: 'k' }] })).toEqual({ result: { volume: 1 } });
    expect(h.fallbackLoads()).toBe(0);
    expect(h.router.served()).toEqual({ native: { evaluate: 1, massProperties: 1 }, wasm: {} });
  });

  it('decodes native meshes into plain arrays', async () => {
    const encoded = {
      encoding: 'base64-le',
      positions: Buffer.from(new Float64Array([0, 0, 1]).buffer).toString('base64'),
      indices: Buffer.from(new Uint32Array([0, 0, 0]).buffer).toString('base64'),
    };
    const h = harness(() => ({ result: encoded }));
    expect(await h.router.route({ op: 'tessellate', args: [{ key: 'k' }] })).toEqual({
      result: { positions: [0, 0, 1], indices: [0, 0, 0] },
    });
  });

  it('sends ops the sidecar lacks straight to WASM, logging each op once', async () => {
    const h = harness(() => ({ result: null }));
    expect(await h.router.route({ op: 'topology', args: [{ key: 'k' }] })).toEqual({ result: 'wasm:topology' });
    await h.router.route({ op: 'topology', args: [{ key: 'k' }] });
    expect(h.nativeCalls).toHaveLength(0);
    expect(h.warnings).toEqual(['[occt-native] topology: answered by the WASM OCC kernel (op not native yet)']);
  });

  it('falls back with the original request when the sidecar answers NATIVE_UNSUPPORTED or dies', async () => {
    const fillet = { op: 'fillet', source: cube, edges: [0], size: 0.1 } as const;
    const unsupported = harness(() => ({ result: null, error: "NATIVE_UNSUPPORTED: recipe op 'fillet'" }));
    expect(await unsupported.router.route({ op: 'evaluate', args: [fillet] })).toEqual({ result: 'wasm:evaluate' });
    expect(unsupported.fallbackCalls).toEqual([{ op: 'evaluate', args: [fillet] }]);
    expect(unsupported.warnings[0]).toContain("recipe op 'fillet'");

    const died = harness(() => ({ result: null, error: 'NATIVE_DIED: killed by SIGSEGV' }));
    expect(await died.router.route({ op: 'tessellate', args: [{ key: 'k' }] })).toEqual({ result: 'wasm:tessellate' });
  });

  it('passes other native errors through (refusal or resend request), without falling back', async () => {
    const h = harness(() => ({ result: null, error: 'shape not cached: k' }));
    expect(await h.router.route({ op: 'tessellate', args: [{ key: 'k' }] })).toEqual({ result: null, error: 'shape not cached: k' });
    expect(h.fallbackLoads()).toBe(0);
  });

  it('describes both engines in info', async () => {
    const h = harness(() => ({ result: null }));
    const { result } = await h.router.route({ op: 'info', args: [] });
    expect(result).toEqual({
      occtVersion: '7.8.1',
      build: 'llull-kernel@0.1.0 (OCCT 7.8.1, native) + opencascade.js@1.1.1 for ops it lacks',
      capabilities: ['topology', 'analyze', 'massProperties'],
    });
  });

  it('loads document blobs into the sidecar now and into the WASM kernel before its first request', async () => {
    const native: NativeInfo = { ...NATIVE, ops: [...NATIVE.ops, 'loadBlob'] };
    const nativeCalls: { op: string; args: readonly unknown[] }[] = [];
    const fallbackCalls: KernelRequest[] = [];
    let live = 0;
    const sessions = [0, 1].map(
      (index): NativeKernelSession => ({
        request: (op, args) => {
          nativeCalls.push({ op: `${index}:${op}`, args });
          return Promise.resolve({ result: op === 'loadBlob' ? null : 'native' });
        },
        alive: () => index === live,
        close: () => undefined,
      }),
    );
    const router = createKernelRouter({
      native,
      session: () => sessions[live]!,
      fallback: () =>
        Promise.resolve((request: KernelRequest): KernelReply => {
          fallbackCalls.push(request);
          return { result: `wasm:${request.op}` };
        }),
      warn: () => undefined,
    });
    expect(await router.route({ op: 'loadBlob', args: ['sha-a', 'text-a'] })).toEqual({ result: null });
    expect(nativeCalls).toEqual([{ op: '0:loadBlob', args: ['sha-a', 'text-a'] }]);
    expect(fallbackCalls).toEqual([]);

    await router.route({ op: 'topology', args: [{ key: 'k' }] }); // not native here: the WASM kernel gets the blob first
    expect(fallbackCalls.map((request) => request.op)).toEqual(['loadBlob', 'topology']);
    await router.route({ op: 'topology', args: [{ key: 'k' }] });
    expect(fallbackCalls.filter((request) => request.op === 'loadBlob')).toHaveLength(1);

    live = 1; // the sidecar died and was respawned: it gets every blob again before the next request
    await router.route({ op: 'massProperties', args: [{ key: 'k' }] });
    expect(nativeCalls.slice(1).map((call) => call.op)).toEqual(['1:loadBlob', '1:massProperties']);
    expect((await router.route({ op: 'loadBlob', args: ['sha', 7] })).error).toMatch(/expects/);
  });

  it('turns a throw into an error reply', async () => {
    const h = harness(() => {
      throw new Error('broken pipe');
    });
    expect(await h.router.route({ op: 'evaluate', args: [cube] })).toEqual({ result: null, error: 'broken pipe' });
  });
});
