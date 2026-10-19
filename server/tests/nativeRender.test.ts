/**
 * fea_render (05 TR-FEA-92, VC-FEA-29): the native CPU twin draws the same SVG as the TypeScript raster (identical bytes); the GPU path is a
 * picture compared by pixel agreement and needs a build with `--features gpu` plus an adapter (else it falls back, reason logged). Native
 * runs need `cargo build --release` in solver/ and are skipped with a logged reason otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CadDocument } from '@core/model/types';
import type { FeaHost } from '@mcp/index';
import { prepareRaster, rasterPixels } from '@cae/results/fieldRaster';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner, f64Bytes, readOutput, withJobFolder } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runFeaRender } from '../src/native/renderField';
import { runNativeTool, nativeToolDefinitions } from '../src/native/tools';
import { feFatigue } from '../../tests/unit/cae/fatigue/feFixtures';
import { rasterCases } from '../../tests/unit/native/rasterCases';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('nativeRender: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

type Json = Record<string, unknown>;
let dir = '';
let store: FeArtifactCache;
let doc: CadDocument;
let analysisId = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-native-render-'));
  store = createFeArtifactStore(dir);
  const fixture = feFatigue({ cells: [8, 4, 4], steps: 4 });
  store.put(fixture.mesh);
  store.put(fixture.results);
  doc = fixture.doc;
  analysisId = fixture.analysisId;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const host = (): FeaHost => ({
  getDoc: () => doc,
  applyCommand: (name, params) => {
    const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
    return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
  },
});

const svgOf = (result: { data?: unknown }): string => String((result.data as Json)['svg']);
const rasterOf = (result: { data?: unknown }): Json => (result.data as Json)['raster'] as Json;

describe('fea_render', () => {
  it('ts draws exactly the render_fea_results plot; bad params and unsolved cases are refused; no binary falls back', async () => {
    const reference = host().applyCommand('render_fea_results', { analysisId, width: 640, height: 400 });
    const ts = await runFeaRender({ analysisId, width: 640, height: 400, raster: 'ts' }, host(), {
      store,
      runner: createComputeRunner({}, null),
    });
    expect(ts.isError).toBe(false);
    expect(svgOf(ts)).toBe(svgOf(reference));
    expect(rasterOf(ts)).toMatchObject({ engine: 'ts', deterministic: true });
    const fallback = await runFeaRender({ analysisId, raster: 'cpu' }, host(), { store, runner: createComputeRunner({}, null) });
    expect(rasterOf(fallback)).toMatchObject({ engine: 'ts', reason: expect.stringContaining('NATIVE_TOOL_MISSING') });
    expect(await runFeaRender({ analysisId, raster: 'vulkan' }, host(), { store, runner: createComputeRunner({}, null) })).toMatchObject({
      isError: true,
    });
    expect(await runFeaRender({ analysisId, bands: 99 }, host(), { store, runner: createComputeRunner({}, null) })).toMatchObject({
      isError: true,
    });
    const unsolved = await runFeaRender({ analysisId: 'nope' }, host(), { store, runner: createComputeRunner({}, null) });
    expect(unsolved.isError).toBe(true);
    expect(nativeToolDefinitions().find((tool) => tool.name === 'fea_render')?.inputSchema.properties).toHaveProperty('raster');
  });

  native('the native CPU twin gives the identical SVG (VC-FEA-29), auto stays in TS for small plots, gpu reports its engine', async () => {
    const runner = createComputeRunner({}, BINARY);
    const params = { analysisId, width: 900, height: 600, showMesh: true };
    const ts = await runFeaRender({ ...params, raster: 'ts' }, host(), { store, runner });
    const cpu = await runFeaRender({ ...params, raster: 'cpu' }, host(), { store, runner });
    expect(rasterOf(cpu)).toMatchObject({ engine: 'native-cpu', deterministic: true });
    expect(svgOf(cpu)).toBe(svgOf(ts));
    const auto = await runFeaRender({ analysisId, width: 400, height: 300, raster: 'auto' }, host(), { store, runner });
    expect(rasterOf(auto)).toMatchObject({ engine: 'ts' });
    const big = await runFeaRender({ analysisId, raster: 'auto' }, host(), { store, runner });
    expect(rasterOf(big)).toMatchObject({ engine: 'native-cpu' });
    const gpu = await runFeaRender({ ...params, raster: 'gpu' }, host(), { store, runner });
    const engine = rasterOf(gpu);
    if (engine['engine'] === 'native-gpu') expect(engine).toMatchObject({ deterministic: false, device: expect.any(String) });
    else {
      console.warn(`nativeRender: gpu raster not used (${String(engine['reason'])})`);
      expect(engine).toMatchObject({ engine: 'native-cpu', reason: expect.any(String) });
    }
    const viaTool = await runNativeTool('fea_render', { ...params, raster: 'cpu' }, host(), { store, runner });
    expect(viaTool).toMatchObject({ isError: false, changed: false });
  });

  native('raw raster jobs reproduce rasterPixels on the reference plots byte for byte', async () => {
    const runner = createComputeRunner({}, BINARY);
    for (const { name, raster } of rasterCases()) {
      const prepared = prepareRaster(raster);
      const reference = rasterPixels(prepared);
      const { ghostTriangles, triangles, light, normals, owners, caps, ...scalars } = prepared;
      const files = {
        'job.json': JSON.stringify({ ...scalars, engine: 'cpu' }),
        'ghost.f64': f64Bytes(ghostTriangles),
        'triangles.f64': f64Bytes(triangles),
        'light.f64': f64Bytes(light),
        'normals.f64': f64Bytes(normals),
        'owners.f64': f64Bytes(owners),
        'caps.f64': f64Bytes(caps),
      };
      const rgba = await withJobFolder(files, async (folder) => {
        const run = await runner.run(['raster'], folder, 60_000);
        expect(run.ok, `${name}: ${run.message ?? ''}`).toBe(true);
        return readOutput(folder, run, 'rgba.bin');
      });
      expect(Buffer.compare(rgba, Buffer.from(reference.rgba)), name).toBe(0);
    }
  });
});
