/** Request routing of the native kernel worker: translated for the sidecar, answered by it; refusals pass through. */

import { describe, expect, it } from 'vitest';
import { createKernelRouter, type KernelRouter } from '../src/native/kernelRouter';
import type { NativeKernelSession } from '../src/native/kernelSession';
import type { NativeInfo } from '../src/native/kernelProtocol';
import type { Entity } from '@core/model/types';
import { box, leaf } from './kernelTestSupport';

const NATIVE: NativeInfo = {
  occtVersion: '7.9.2',
  build: 'llull-kernel@0.1.0',
  capabilities: ['analyze', 'massProperties'],
  ops: ['info', 'evaluate', 'tessellate', 'massProperties'],
};

type Answer = (op: string, args: readonly unknown[]) => { result: unknown; error?: string };

interface Harness {
  readonly router: KernelRouter;
  readonly nativeCalls: { op: string; args: readonly unknown[] }[];
}

function harness(answer: Answer, native: NativeInfo = NATIVE): Harness {
  const nativeCalls: { op: string; args: readonly unknown[] }[] = [];
  const session: NativeKernelSession = {
    request: (op, args) => {
      nativeCalls.push({ op, args });
      return Promise.resolve(answer(op, args));
    },
    alive: () => true,
    close: () => undefined,
  };
  return { router: createKernelRouter({ native, session: () => session }), nativeCalls };
}

const cube = leaf(box([0, 0, 0], [1, 1, 1]));

describe('native kernel router', () => {
  it('serves native ops through the sidecar', async () => {
    const h = harness((op, args) => ({ result: op === 'evaluate' ? { key: (args[0] as { key: string }).key } : { volume: 1 } }));
    expect((await h.router.route({ op: 'evaluate', args: [cube] })).result).toMatchObject({ key: expect.any(String) });
    expect(await h.router.route({ op: 'massProperties', args: [{ key: 'k' }] })).toEqual({ result: { volume: 1 } });
    expect(h.nativeCalls.map((call) => call.op)).toEqual(['evaluate', 'massProperties']);
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

  it('refuses ops the sidecar lacks, without calling it', async () => {
    const h = harness(() => ({ result: null }));
    expect(await h.router.route({ op: 'topology', args: [{ key: 'k' }] })).toEqual({
      result: null,
      error: 'NATIVE_UNSUPPORTED: op topology',
    });
    expect(h.nativeCalls).toHaveLength(0);
  });

  it('answers the sidecar error (unsupported recipe, death) with a null result', async () => {
    const blob = { op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' } as const;
    const unsupported = harness(() => ({ result: null, error: "NATIVE_UNSUPPORTED: recipe op 'brep'" }));
    expect(await unsupported.router.route({ op: 'evaluate', args: [blob] })).toEqual({
      result: null,
      error: "NATIVE_UNSUPPORTED: recipe op 'brep'",
    });
    const died = harness(() => ({ result: null, error: 'NATIVE_DIED: killed by SIGSEGV' }));
    expect(await died.router.route({ op: 'tessellate', args: [{ key: 'k' }] })).toEqual({
      result: null,
      error: 'NATIVE_DIED: killed by SIGSEGV',
    });
  });

  it('sends fillet and chamfer to the sidecar (native topology numbers their edges)', async () => {
    const h = harness(() => ({ result: { key: 'k' } }));
    const fillet = { op: 'fillet', source: cube, edges: [0], size: 0.1 } as const;
    expect(await h.router.route({ op: 'evaluate', args: [fillet] })).toEqual({ result: { key: 'k' } });
    await h.router.route({ op: 'massProperties', args: [{ key: 'k', recipe: { ...fillet, op: 'chamfer' } }] });
    expect(h.nativeCalls).toHaveLength(2);
  });

  it('lowers a through-all hole on the host: the source mesh from the sidecar, then a featureCut node', async () => {
    const mesh = {
      encoding: 'base64-le',
      positions: Buffer.from(new Float64Array([0, 0, 0, 0, 0, 1, 1, 1, 1]).buffer).toString('base64'),
      indices: Buffer.from(new Uint32Array([0, 1, 2]).buffer).toString('base64'),
    };
    const h = harness((op, args) => ({ result: op === 'tessellate' ? mesh : { key: (args[0] as { key: string }).key } }));
    const hole = {
      op: 'feature',
      feature: 'hole',
      source: cube,
      frame: { origin: [0.5, 0.5, 1], normal: [0, 0, 1], xDir: [1, 0, 0] },
      points: [[0, 0]],
      hole: { kind: 'simple', diameter: 0.2 },
      extent: { kind: 'through_all' },
    };
    await h.router.route({ op: 'evaluate', args: [hole] });
    expect(h.nativeCalls.map((call) => call.op)).toEqual(['tessellate', 'evaluate']);
    const sent = (h.nativeCalls[1]!.args[0] as { recipe: Record<string, unknown> }).recipe;
    expect(sent).toMatchObject({ op: 'featureCut', mode: 'subtract', source: cube, holes: { normal: [0, 0, 1] } });
    expect(sent['tool']).toMatchObject({ op: 'solid', entity: { kind: 'revolution' } });
  });

  it('sends B-spline loft sections only to a sidecar that reported the bsplineSections capability', async () => {
    const section = (z: number): Record<string, unknown> => ({
      degree: 3,
      poles: [
        [1, 0, z],
        [0.5, 0.4, z],
        [-0.5, 0.4, z],
        [-1, 0, z],
        [-0.5, -0.4, z],
      ],
      knots: [0, 0.5, 1],
      multiplicities: [4, 1, 4],
    });
    const loft = leaf({
      id: 'loft',
      kind: 'loft',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      rings: [[[0, 0, 0]], [[0, 0, 1]]],
      ruled: false,
      sections: [section(0), section(2)],
      layerId: 'layer-0',
      color: '#999999',
    } as never);
    const payload = async (native: NativeInfo): Promise<Record<string, unknown>> => {
      const h = harness(() => ({ result: { key: 'k' } }), native);
      await h.router.route({ op: 'evaluate', args: [loft] });
      return (h.nativeCalls[0]!.args[0] as { recipe: { entity: { native: Record<string, unknown> } } }).recipe.entity.native;
    };
    expect((await payload(NATIVE))['bsplines']).toBeUndefined();
    const capable = await payload({ ...NATIVE, capabilities: [...NATIVE.capabilities, 'bsplineSections'] });
    expect(capable['bsplines']).toHaveLength(2);
    expect(capable['chains']).toHaveLength(2);
  });

  it('sends a sheet leaf with its surface only to a sidecar that reported the nurbsSurface capability', async () => {
    const sheet = leaf({
      id: 'sheet',
      kind: 'nurbs_surface',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'l',
      color: '#888',
      surface: {
        degreeU: 1,
        degreeV: 1,
        poles: [
          [
            [0, 0, 0],
            [0, 1, 0],
          ],
          [
            [1, 0, 0],
            [1, 1, 0],
          ],
        ],
        knotsU: [0, 1],
        multiplicitiesU: [2, 2],
        knotsV: [0, 1],
        multiplicitiesV: [2, 2],
      },
    } as unknown as Entity);
    const payload = async (native: NativeInfo): Promise<Record<string, unknown>> => {
      const h = harness(() => ({ result: { key: 'k' } }), native);
      await h.router.route({ op: 'evaluate', args: [sheet] });
      return (h.nativeCalls[0]!.args[0] as { recipe: { entity: Record<string, unknown> } }).recipe.entity;
    };
    expect((await payload(NATIVE))['native']).toBeUndefined();
    const capable = await payload({ ...NATIVE, capabilities: [...NATIVE.capabilities, 'nurbsSurface'] });
    expect(capable['native']).toMatchObject({ loops: [] });
    expect((capable['native'] as { surface: number[] }).surface).toHaveLength(7 + 12 + 8);
  });

  it('passes other native errors through (refusal or resend request)', async () => {
    const h = harness(() => ({ result: null, error: 'shape not cached: k' }));
    expect(await h.router.route({ op: 'evaluate', args: [cube] })).toEqual({ result: null, error: 'shape not cached: k' });
  });

  it('describes the native engine in info', async () => {
    const h = harness(() => ({ result: null }));
    const { result } = await h.router.route({ op: 'info', args: [] });
    expect(result).toEqual({
      occtVersion: '7.9.2',
      build: 'llull-kernel@0.1.0 (OCCT 7.9.2, native)',
      capabilities: ['analyze', 'massProperties'],
    });
  });

  it('loads document blobs into the sidecar now and again into a respawned one', async () => {
    const native: NativeInfo = { ...NATIVE, ops: [...NATIVE.ops, 'loadBlob'] };
    const nativeCalls: { op: string; args: readonly unknown[] }[] = [];
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
    const router = createKernelRouter({ native, session: () => sessions[live]! });
    expect(await router.route({ op: 'loadBlob', args: ['sha-a', 'text-a'] })).toEqual({ result: null });
    expect(nativeCalls).toEqual([{ op: '0:loadBlob', args: ['sha-a', 'text-a'] }]);
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
