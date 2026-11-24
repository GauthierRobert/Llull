/**
 * 12 CFD M3b `cfd_render`: render_view with the computed flow drawn over it (fake llull-compute answering the queries; the picture is the real
 * render_view). The slice and the streamlines are in the SVG as projected polygons / segments with a legend, the PNG rasterizes, and the
 * refusals of the queries (no result, stale result, no binary) come back before anything is rendered; the document never changes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { makeProjector } from '@core/commands/render/camera';
import { createEmptyDocument } from '@core/model/types';
import { _stopAllCfdSolves, runCfdSolve } from '../src/cfd/flowSolve';
import { runCfdRender } from '../src/cfd/flowRender';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { rasterizeSvg } from '../src/renderImage';
import { runNativeTool } from '../src/native/tools';
import { fakeRunner, hostOf, missingRunner, sha, sphereModel, type TestHost } from './cfdTestSupport';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-render-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => {
  _stopAllCfdSolves();
  rmSync(dir, { recursive: true, force: true });
});

/** A 5 x 5 patch in the z = 0 plane, 0.5 m apart, centred on the origin: speed rises along u, the corners are bodies (NaN). */
function llsl(): Buffer {
  const bytes = Buffer.alloc(72 + 4 * 25);
  bytes.write('LLSL', 0, 'latin1');
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(5, 8);
  bytes.writeUInt32LE(5, 12);
  [-1, -1, 0, 1, 0, 0, 0, 1, 0, 0.5].forEach((value, k) => bytes.writeFloatLE(value, 16 + 4 * k));
  bytes.write('speed', 56, 'latin1');
  for (let iv = 0; iv < 5; iv++)
    for (let iu = 0; iu < 5; iu++)
      bytes.writeFloatLE((iu + iv) % 4 === 0 && iu !== iv ? Number.NaN : 1 + 0.25 * iu, 72 + 4 * (iv * 5 + iu));
  return bytes;
}

function llst(): Buffer {
  const bytes = Buffer.alloc(16 + 8 + 16 * 3);
  bytes.write('LLST', 0, 'latin1');
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(1, 8);
  bytes.writeUInt32LE(3, 12);
  bytes.writeUInt32LE(0, 16);
  bytes.writeUInt32LE(3, 20);
  [-1, 0, 0, 0, 0, 0.5, 1, 0, 0].forEach((value, k) => bytes.writeFloatLE(value, 24 + 4 * k));
  [1, 1.5, 2].forEach((value, k) => bytes.writeFloatLE(value, 60 + 4 * k));
  return bytes;
}

const sliceFile = llsl();
const valid = [...Array(25).keys()].filter((k) => !Number.isNaN(sliceFile.readFloatLE(72 + 4 * k))).length;
const queryAnswers = (op: string): { json: Record<string, unknown>; file: Buffer } =>
  op === 'slice'
    ? {
        json: {
          slice: {
            file: 'slice.bin',
            field: 'speed',
            samples: 5,
            spacingM: 0.5,
            originM: [-1, -1, 0],
            axisU: [1, 0, 0],
            axisV: [0, 1, 0],
            validSamples: valid,
            min: 1,
            max: 2,
          },
        },
        file: sliceFile,
      }
    : {
        json: {
          streamlines: {
            file: 'streamlines.bin',
            device: 'cpu',
            deterministic: true,
            precision: 'f64',
            points: 3,
            lines: [{ seed: 0, points: 3, lengthM: 2, stopBackward: 'left_domain', stopForward: 'left_domain' }],
          },
        },
        file: llst(),
      };

const runner = (): ReturnType<typeof fakeRunner> => fakeRunner({ query: (job) => queryAnswers(String((job as { op?: string }).op)) });

async function solvedHost(): Promise<TestHost> {
  const host = hostOf(sphereModel(), store);
  const solved = await runCfdSolve('re100', {}, host, { store, runner: fakeRunner() });
  if (solved.isError) throw new Error(solved.summary);
  return host;
}

const slice = { origin: [0, 0, 0], normal: [0, 0, 1], field: 'speed', spacingM: 0.5, extentM: 2 };
const streamlines = { rake: { kind: 'line', start: [-1, 0, 0], end: [-1, 0, 0], count: 1 } };

describe('cfd_render', () => {
  it('draws the slice polygons and the streamline segments with a legend over the render_view picture, projected with its camera', async () => {
    const host = await solvedHost();
    const before = host.current();
    const result = await runCfdRender({ caseId: 're100', view: 'top', width: 400, height: 300, slice, streamlines }, host, {
      store,
      runner: runner(),
    });
    expect(result.isError, result.summary).toBe(false);
    expect(host.current()).toBe(before);
    const data = result.data as { svg: string; width: number; cfd: Record<string, { cells?: number; segments?: number; range: unknown }> };
    const plain = execute(before, 'render_view', { view: 'top', width: 400, height: 300 }).data as { svg: string };
    expect(data.svg.startsWith(plain.svg.slice(0, 200))).toBe(true);
    expect(data.svg).toContain('class="cfd-slice"');
    expect(data.svg.match(/<polygon points="[^"]+" fill="#[0-9a-f]{6}"\/>/g)).toHaveLength(valid);
    expect(data.cfd['slice']).toMatchObject({ cells: valid, range: { min: 1, max: 2 } });
    expect(data.svg).toContain('class="cfd-streamlines"');
    expect(data.svg.match(/<line x1=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(data.cfd['streamlines']).toMatchObject({ segments: 2, range: { min: 1, max: 2 } });
    expect(data.svg).toContain('>speed (m/s)<');
    expect(data.svg).toContain('streamline speed (m/s)');
    // projected with the render camera: the cell centred on the world origin (top view) is centred on the picture
    const sliceGroup = data.svg.slice(data.svg.indexOf('class="cfd-slice"'), data.svg.indexOf('class="cfd-streamlines"'));
    const centroids = [...sliceGroup.matchAll(/<polygon points="([^"]+)"/g)].map((m) => {
      const points = (m[1] ?? '').split(' ').map((pair) => pair.split(',').map(Number) as [number, number]);
      return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
    });
    expect(centroids.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(centroids.some(([x, y]) => Math.abs((x ?? 0) - 200) < 1 && Math.abs((y ?? 0) - 150) < 1)).toBe(true);
    expect(result.summary).toContain('a slice and streamlines');
    const png = rasterizeSvg(data.svg, data.width);
    expect(png).not.toBeNull();
    const withoutOverlay = rasterizeSvg(plain.svg, data.width);
    expect(Buffer.from(png ?? '', 'base64').equals(Buffer.from(withoutOverlay ?? '', 'base64'))).toBe(false);
  });

  it('recomputes the reference provenance over the composed svg', async () => {
    const host = await solvedHost();
    const result = await runCfdRender({ caseId: 're100', view: 'top', slice }, host, { store, runner: runner() });
    const data = result.data as { svg: string; svgSha256: string; renderer: string };
    expect(data.renderer).toBe('reference');
    expect(data.svgSha256).toBe(sha(Buffer.from(data.svg, 'utf8')));
    const plain = execute(host.current(), 'render_view', { view: 'top' }).data as { svgSha256: string };
    expect(data.svgSha256).not.toBe(plain.svgSha256);
  });

  it('projects a world point off the origin of a millimetre document with the camera of the picture', async () => {
    const model = sphereModel();
    const mm = execute({ ...createEmptyDocument(), units: 'mm' }, 'add_sphere', { radius: 500, position: [0, 0, 0] });
    const ballId = mm.affected[0] as string;
    const doc = execute(mm.document, 'create_cfd_case', {
      id: 're100',
      entityIds: [ballId],
      freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.01 } },
      reference: { areaM2: 0.7853981634, lengthM: 1 },
      cellsPerReferenceLength: 8,
      outputs: { probes: [[2, 0, 0]], slices: [{ origin: [0, 0, 0], normal: [0, 1, 0], field: 'speed' }] },
    }).document;
    expect(model.ballId).toBeDefined();
    const host = hostOf({ doc, ballId }, store);
    const solved = await runCfdSolve('re100', {}, host, { store, runner: fakeRunner() });
    expect(solved.isError, solved.summary).toBe(false);
    const result = await runCfdRender({ caseId: 're100', view: 'top', width: 400, height: 300, slice }, host, { store, runner: runner() });
    expect(result.isError, result.summary).toBe(false);
    const data = result.data as { svg: string; camera: Parameters<typeof makeProjector>[0]; orthoHalf: number };
    const project = makeProjector(data.camera, data.orthoHalf, 400, 300);
    // sample (iu 3, iv 2) is at world (0.5 m, 0) = (500 mm, 0, 0)
    const [wantX, wantY] = project([500, 0, 0]);
    const group = data.svg.slice(data.svg.indexOf('class="cfd-slice"'), data.svg.indexOf('class="cfd-legend"'));
    const centroids = [...group.matchAll(/<polygon points="([^"]+)"/g)].map((m) => {
      const points = (m[1] ?? '').split(' ').map((pair) => pair.split(',').map(Number) as [number, number]);
      return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
    });
    expect(centroids.some(([x, y]) => Math.abs((x ?? 0) - wantX) < 0.5 && Math.abs((y ?? 0) - wantY) < 0.5)).toBe(true);
    expect(Math.abs(wantX - 200)).toBeGreaterThan(10);
  });

  it('refuses views the overlay cannot be projected on (turntable, perspective, fovDeg, a perspective viewpoint) before any query runs', async () => {
    const host = await solvedHost();
    const fake = runner();
    for (const extra of [{ turntable: { frames: 4 } }, { projection: 'perspective' }, { fovDeg: 50 }]) {
      const refused = await runCfdRender({ caseId: 're100', slice, ...extra }, host, { store, runner: fake });
      expect(refused, JSON.stringify(extra)).toMatchObject({ isError: true, data: { code: 'CFD_PARAM_INVALID' } });
    }
    expect(fake.calls).toHaveLength(0);
    host.set(
      execute(host.current(), 'save_viewpoint', {
        name: 'inside',
        camera: { projection: 'perspective', eye: [0, -4, 0.5], direction: [0, 1, 0], fovDeg: 60 },
      }).document,
    );
    const viewpoint = await runCfdRender({ caseId: 're100', slice, viewpointId: 'vp-1', mode: 'raster' }, host, { store, runner: fake });
    expect(viewpoint).toMatchObject({ isError: true });
    expect(String(viewpoint.data && (viewpoint.data as { code?: string }).code)).toBe('CFD_PARAM_INVALID');
  });

  it('refuses a stored file it cannot decode (CFD_SOLVER_FAILED)', async () => {
    const host = await solvedHost();
    // a valid length and sample count (the query transport checks those), but a NaN origin in the header: only the decoder refuses it
    const broken = Uint8Array.from(sliceFile);
    new DataView(broken.buffer).setFloat32(16, Number.NaN, true);
    const damaged = fakeRunner({ query: () => ({ ...queryAnswers('slice'), file: broken }) });
    const refused = await runCfdRender({ caseId: 're100', slice }, host, { store, runner: damaged });
    expect(refused).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED' } });
    expect(refused.summary).toContain('non-finite');
  });

  it('is reachable as the cfd_render transport tool and offers render_view params next to slice and streamlines', async () => {
    const host = await solvedHost();
    const outcome = await runNativeTool('cfd_render', { caseId: 're100', view: 'top', slice }, host, {
      store,
      runner: runner(),
      env: process.env,
    });
    expect(outcome).toMatchObject({ isError: false, changed: false });
  });

  it('refuses without a result, with a stale result and without the binary, before rendering', async () => {
    const fresh = hostOf(sphereModel(), store);
    const fake = runner();
    expect(await runCfdRender({ caseId: 're100', slice }, fresh, { store, runner: fake })).toMatchObject({
      isError: true,
      data: { code: 'CFD_NO_RESULT' },
    });
    const model = sphereModel();
    const host = await solvedHost();
    const moved = execute(host.current(), 'move_entities', { ids: [model.ballId], delta: [0.25, 0, 0] }).document;
    const stale = { ...host, getDoc: () => moved };
    const refused = await runCfdRender({ caseId: 're100', slice }, stale, { store, runner: fake });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.data).toMatchObject({ code: 'CFD_RESULT_STALE' });
    expect(await runCfdRender({ caseId: 're100', slice }, host, { store, runner: missingRunner() })).toMatchObject({
      data: { code: 'CFD_SOLVER_MISSING' },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a call with neither slice nor streamlines, a missing caseId and a refused render_view', async () => {
    const host = await solvedHost();
    expect(await runCfdRender({ caseId: 're100' }, host, { store, runner: runner() })).toMatchObject({
      data: { code: 'CFD_PARAM_INVALID' },
    });
    expect(await runCfdRender({ slice }, host, { store, runner: runner() })).toMatchObject({ data: { code: 'CFD_PARAM_INVALID' } });
    expect(await runCfdRender({ caseId: 're100', slice: 3 }, host, { store, runner: runner() })).toMatchObject({
      data: { code: 'CFD_PARAM_INVALID' },
    });
    const rejected = await runCfdRender({ caseId: 're100', slice, view: 'sideways' }, host, { store, runner: runner() });
    expect(rejected).toMatchObject({ isError: true });
  });
});
