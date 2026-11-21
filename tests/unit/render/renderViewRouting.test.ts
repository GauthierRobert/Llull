/** ASC M6b: render_view over its polygon budget routes to ctx.viewportCapture, else ctx.raster, else the best effort with RENDER_BUDGET_EXCEEDED. */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import type { RasterPort } from '@core/model/raster';
import type { ViewportCapturePort, ViewportCaptureRequest } from '@core/model/viewportCapture';
import { rasterScenePixels } from '@core/commands/render/raster';
import { encodePng } from '@lib/png';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { createResolveMemo } from '@core/commands/resolveMemo';
import { NATIVE_ROUTE_BUDGET, routeOverBudget } from '@core/commands/render/renderViewRouting';
import { expectPure } from '../../helpers/expectNoOp';

/** Above the 400000-polygon raster budget of the reference renderer. */
const TRIANGLES = 420_000;
const PARAMS = { width: 96, height: 64, showAxes: false, showGrid: false } as const;

function bigMeshDoc(): CadDocument {
  const positions = new Float64Array(TRIANGLES * 9);
  const indices: number[] = [];
  for (let t = 0; t < TRIANGLES; t++) {
    const x = (t % 700) * 0.01;
    const y = Math.floor(t / 700) * 0.01;
    positions.set([x, y, 0, x + 0.01, y, 0, x, y + 0.01, 0.01], t * 9);
    indices.push(3 * t, 3 * t + 1, 3 * t + 2);
  }
  const mesh: MeshSolidEntity = {
    id: 'big',
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
    mesh: { positions: Array.from(positions), indices },
  };
  const base = createEmptyDocument();
  return { ...base, entities: { big: mesh }, order: ['big'] };
}

let big: CadDocument;
const small = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 6] }).document;

beforeAll(() => {
  big = bigMeshDoc();
}, 60_000);

function viewport(outcome: 'ok' | 'pending' | 'unavailable' | 'stale'): {
  port: ViewportCapturePort;
  requests: ViewportCaptureRequest[];
  docs: CadDocument[];
} {
  const requests: ViewportCaptureRequest[] = [];
  const docs: CadDocument[] = [];
  return {
    requests,
    docs,
    port: {
      capture: (request, doc) => {
        requests.push(request);
        docs.push(doc);
        if (outcome === 'pending') return { ok: false, code: 'VIEWPORT_PENDING', message: 'drawing' };
        if (outcome === 'stale') return { ok: false, code: 'VIEWPORT_STALE', message: 'not the live document' };
        if (outcome === 'unavailable') return { ok: false, code: 'VIEWPORT_UNAVAILABLE', message: 'no app' };
        return { ok: true, png: encodePng(request.width, request.height, new Uint8Array(request.width * request.height * 4)), ...request };
      },
    },
  };
}

function raster(): { port: RasterPort; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    port: {
      render: (scene) => {
        calls.push(scene.faces.length);
        return {
          ok: true,
          image: { rgba: rasterScenePixels(scene), device: 'cpu', deterministic: false, engine: 'native-cpu', version: 'test' },
        };
      },
    },
  };
}

const run = (
  doc: CadDocument,
  params: Record<string, unknown>,
  extra: Partial<ReturnType<typeof defaultContext>> = {},
): ReturnType<typeof execute> => execute(doc, 'render_view', { ...PARAMS, ...params }, { ...defaultContext(), ...extra });

type Data = Record<string, unknown> & { svg: string };

describe('render_view over budget (M6b)', { timeout: 120_000 }, () => {
  it('under budget nothing changes: the reference picture with its digest, no routing fields', () => {
    const { port, requests } = viewport('ok');
    const result = run(small, {}, { viewportCapture: port });
    const data = result.data as Data;
    expect(requests).toEqual([]);
    expect(data['svgSha256']).toEqual(expect.any(String));
    for (const key of ['routedTo', 'drawnShare', 'warnings', 'polygonTotal']) expect(key in data).toBe(false);
    expect(run(small, {}).data).toEqual(data);
  });

  it('routes to the desktop viewport when present: same camera request, a picture marked non-deterministic, differences in the summary', () => {
    const { port, requests, docs } = viewport('ok');
    const result = run(big, { view: 'front', zoom: 2, background: '#fff' }, { viewportCapture: port, raster: raster().port });
    const data = result.data as Data;
    expect(result.error).toBeUndefined();
    expect(requests).toEqual([{ view: 'front', zoom: 2, width: 96, height: 64, background: '#fff', hideLayers: [] }]);
    expect(docs[0]).toBe(big);
    expect(data).toMatchObject({ routedTo: 'viewport', renderer: 'viewport', deterministic: false, drawnShare: 1, width: 96, height: 64 });
    expect(data['svgSha256']).toBeUndefined();
    expect(data['simplifiedEntityIds']).toEqual([]);
    expect(data['polygonCount']).toBeUndefined();
    expect(data['polygonTotal']).toBeUndefined();
    expect(data['referencePolygonTotal']).toBe(TRIANGLES);
    expect(data.svg).toMatch(/^<svg[^>]*>.*href="data:image\/png;base64,/);
    expect(result.summary).toMatch(/desktop viewport/);
    expect(result.summary).toMatch(/perspective/);
    expect(result.document).toBe(big);
  });

  it('a viewport frame still being drawn is returned as VIEWPORT_PENDING so the host runs the command again', () => {
    const result = run(big, {}, { viewportCapture: viewport('pending').port });
    expect(result.error?.code).toBe('VIEWPORT_PENDING');
  });

  it('a viewport refusal falls through to the native raster and says why', () => {
    const { port, calls } = raster();
    const result = run(big, {}, { viewportCapture: viewport('stale').port, raster: port });
    const data = result.data as Data;
    expect(calls.length).toBeGreaterThan(0);
    expect(data).toMatchObject({ routedTo: 'raster', drawnShare: 1, renderer: 'native', deterministic: false });
    expect(data['svgSha256']).toBeUndefined();
    expect(result.summary).toContain('VIEWPORT_STALE');
    expect(result.summary).toMatch(/native raster/);
  });

  it('without either port: the reference best effort with RENDER_BUDGET_EXCEEDED and drawnShare', () => {
    const result = run(big, {});
    const data = result.data as Data;
    expect(result.error).toBeUndefined();
    expect(data['svgSha256']).toEqual(expect.any(String));
    expect(data['drawnShare']).toBeGreaterThan(0);
    expect(data['drawnShare']).toBeLessThan(1);
    expect(data['warnings']).toEqual([{ code: 'RENDER_BUDGET_EXCEEDED', message: expect.stringContaining('%') }]);
    expect(result.summary).toContain('RENDER_BUDGET_EXCEEDED');
    expect(data['simplifiedEntityIds']).toEqual(['big']);
  });

  it('a request a GPU path cannot honour is not routed: warning only, the port is never asked', () => {
    const { port, requests } = viewport('ok');
    for (const extra of [{ isolate: 'big' }, { turntable: { frames: 2 } }, { hide2D: true }, { mode: 'vector' }]) {
      const result = run(big, extra, { viewportCapture: port });
      expect(result.summary).toContain('RENDER_BUDGET_EXCEEDED');
      expect((result.data as Data)['routedTo']).toBeUndefined();
    }
    expect(requests).toEqual([]);
  });

  it('no app is not a failure: VIEWPORT_UNAVAILABLE is left out of the summary of the fallback', () => {
    const result = run(big, {}, { viewportCapture: viewport('unavailable').port });
    expect(result.summary).toContain('RENDER_BUDGET_EXCEEDED');
    expect(result.summary).not.toContain('VIEWPORT_UNAVAILABLE');
  });

  it('is pure', () => {
    expectPure(big, () => run(big, {}, { viewportCapture: viewport('ok').port }));
  });
});

/** The router alone, on a stub reference result: the cases that would cost a multi-million polygon render. */
describe('routeOverBudget (stubbed reference result)', { timeout: 120_000 }, () => {
  const stub = (polygonTotal: number): CommandResult => ({
    document: small,
    summary: 'Rendered.',
    affected: [],
    data: {
      simplifiedEntityIds: ['a'],
      skippedEntityIds: [],
      polygonCount: 400_000,
      polygonTotal,
      polygonBudget: 400_000,
      width: 96,
      height: 64,
      svg: '<svg/>',
    },
  });
  const ctxOf = (raster: RasterPort): ExecutionContext => ({ ...defaultContext(), raster });
  const failing = (code: string): CommandResult => ({
    document: small,
    summary: 'x',
    affected: [],
    error: { code, ids: [], paths: [], remediation: '' },
  });

  it('never asks the native raster for a scene above its limit, and says so', () => {
    const renderCalls: unknown[] = [];
    const port: RasterPort = { render: (scene) => void renderCalls.push(scene) as never };
    let rendered = 0;
    const result = routeOverBudget(small, {}, ctxOf(port), stub(NATIVE_ROUTE_BUDGET + 1), () => {
      rendered += 1;
      return stub(1);
    });
    expect(renderCalls).toEqual([]);
    expect(rendered).toBe(0);
    expect(result.summary).toContain('RENDER_BUDGET_EXCEEDED');
    expect(result.summary).toContain(`limit of ${NATIVE_ROUTE_BUDGET}`);
    expect((result.data as Data)['routedTo']).toBeUndefined();
  });

  it('a native render that is still over budget, or that fails, is not returned: the warning names why', () => {
    const port = raster().port;
    const still = routeOverBudget(small, {}, ctxOf(port), stub(500_000), () => stub(500_000));
    expect(still.summary).toContain('still over its budget');
    expect((still.data as Data)['routedTo']).toBeUndefined();
    const failed = routeOverBudget(small, {}, ctxOf(port), stub(500_000), () => failing('NATIVE_JOB_FAILED'));
    expect(failed.summary).toContain('NATIVE_JOB_FAILED');
    expect((failed.data as Data)['warnings']).toEqual([expect.objectContaining({ code: 'RENDER_BUDGET_EXCEEDED' })]);
  });

  it('projection, fovDeg, title, labels and dimensions make a request non-plain: warning only, no port asked', () => {
    const { port, requests } = viewport('ok');
    const ctx = { ...defaultContext(), viewportCapture: port, raster: raster().port };
    for (const extra of [
      { projection: 'perspective' },
      { fovDeg: 30 },
      { title: 'T' },
      { showLabels: true },
      { showDimensions: true },
      { renderer: 'reference' },
    ]) {
      const result = routeOverBudget(small, extra as never, ctx, stub(500_000), () => stub(1));
      expect(result.summary).toContain('RENDER_BUDGET_EXCEEDED');
      expect((result.data as Data)['routedTo']).toBeUndefined();
    }
    expect(requests).toEqual([]);
  });

  it('the reference render is memoized for the pending run and the re-run of a resolve', () => {
    const memo = createResolveMemo();
    const ctx = { ...defaultContext(), resolveMemo: memo };
    const first = execute(small, 'render_view', PARAMS, ctx);
    const second = execute(small, 'render_view', PARAMS, ctx);
    expect(memo.size).toBeGreaterThan(0);
    expect(second.data).toEqual(first.data);
  });
});
