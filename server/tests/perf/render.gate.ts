/**
 * PERF1 gate, native render: `render_view renderer='native'` at 1280 × 720 of a 36-part scene (boxes, cylinders, spheres; 2× supersampling)
 * through the persistent `llull-compute raster-serve` (budgets.ts `render.*`): the first frame of a host (process start included) and a
 * warm frame. The per-frame job runner (the path before PERF1 §5 row 10) and the reference TypeScript raster are measured, not gated.
 * Skipped without llull-compute.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { RasterPort } from '@core/model/raster';
import { nativeBinaryPath } from '../../src/native/nativeBinary';
import { createNativeRasterPort, createPersistentRasterPort } from '../../src/native/rasterPort';
import { requireTool } from '../../../tests/requireTool';
import { expectWithinBudget, medianMs, reportMeasurements } from './harness';

const BINARY = nativeBinaryPath('llull-compute');
const VIEW = { width: 1280, height: 720, renderer: 'native' } as const;

function scene(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): void => {
    const result = execute(doc, name, params);
    if (result.error !== undefined) throw new Error(result.summary);
    doc = result.document;
  };
  for (let index = 0; index < 36; index += 1) {
    const position = [(index % 6) * 15, Math.floor(index / 6) * 15, 0];
    if (index % 3 === 0) run('add_box', { size: [8, 6, 5 + (index % 4)], position, color: '#c05030' });
    else if (index % 3 === 1) run('add_cylinder', { radius: 4, height: 10, position, color: '#3070c0' });
    else run('add_sphere', { radius: 4, position: [position[0], position[1], 4], color: '#30a050' });
  }
  return doc;
}

const lines: string[] = [];
afterAll(() => console.warn([reportMeasurements(), ...lines].join('\n')));

describe.skipIf(requireTool('native:llull-compute', BINARY !== null))('native render budgets (PERF1)', () => {
  const doc = scene();
  const render = (raster: RasterPort): void => {
    const result = execute(doc, 'render_view', VIEW, { ...defaultContext(), raster });
    expect(result.error, result.summary).toBeUndefined();
  };

  it('render.view.native1280_first: the first native frame of a host, raster process start included', () => {
    render(createNativeRasterPort(BINARY ?? '')); // warms the module graph and the version probe, not the raster process
    const port = createPersistentRasterPort(BINARY ?? '');
    try {
      const started = performance.now();
      render(port);
      expectWithinBudget('render.view.native1280_first', performance.now() - started);
    } finally {
      port.close();
    }
  });

  it('render.view.native1280_warm: a native frame on the running raster process', async () => {
    const port = createPersistentRasterPort(BINARY ?? '');
    try {
      render(port);
      expectWithinBudget('render.view.native1280_warm', await medianMs(() => render(port)));
      expect(port.process.starts()).toBe(1);
    } finally {
      port.close();
    }
    const job = createNativeRasterPort(BINARY ?? '');
    lines.push(`measured: per-frame job runner ${(await medianMs(() => render(job))).toFixed(0)} ms (the path before PERF1 §5 row 10)`);
    const reference = await medianMs(() => execute(doc, 'render_view', { width: 1280, height: 720 }));
    lines.push(`measured: reference TypeScript raster ${reference.toFixed(0)} ms`);
  });
});
