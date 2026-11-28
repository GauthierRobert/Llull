/**
 * PERF1 gate, render_realistic (RV1 §7 layer V4; budgets.ts `render.realistic.*`, MEMORY_BUDGETS): time to the first image of a reference
 * scene (balls-uniform of the render reference corpus, 256 x 256 at 16 samples, native process start included), a 1,000,000-member
 * instance array built and rendered small within a time and memory ceiling (the native peak RSS is read through a wrapper of
 * llull-compute), and the over-budget refusals: RENDER_SCENE_TOO_LARGE above the 8,000,000-instance guard, TEXTURE_BUDGET_EXCEEDED when
 * 4 GiB of textures are imported (the unit test of that refusal is tests/unit/appearance.test.ts "refuses over the 1 GiB decoded
 * budget"). Skipped without llull-compute.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { nativeBinaryPath } from '../../src/native/nativeBinary';
import { createPathTracePort } from '../../src/native/pathTracePort';
import { requireTool } from '../../../tests/requireTool';
import { pngBytes, toBase64 } from '../../../tests/helpers/imageHeaderFixtures';
import { createImageAssetStore } from '../../src/imageAssets/store';
import { RENDER_SCENES } from '../quality/renderScenes';
import { MEMORY_BUDGETS, type MemoryBudgetId } from './budgets';
import { expectWithinBudget, reportMeasurements } from './harness';

const BINARY = nativeBinaryPath('llull-compute');
const scratch = mkdtempSync(path.join(tmpdir(), 'llull-perf-render-'));
const lines: string[] = [];

afterAll(() => {
  console.warn([reportMeasurements(), ...lines].join('\n'));
  rmSync(scratch, { recursive: true, force: true });
});

/** A wrapper of llull-compute that records the peak resident set of the job (ru_maxrss of its child, KiB) in $LLULL_PEAK_RSS_FILE. */
function peakRssWrapper(binary: string): string {
  const wrapper = path.join(scratch, 'llull-compute-rss');
  const script = [
    '#!/usr/bin/env python3',
    'import os, resource, subprocess, sys',
    `run = subprocess.run([${JSON.stringify(binary)}] + sys.argv[1:])`,
    "target = os.environ.get('LLULL_PEAK_RSS_FILE')",
    "if target and sys.argv[1:2] == ['pathtrace']:",
    "    open(target, 'w').write(str(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss))",
    'sys.exit(run.returncode)',
  ].join('\n');
  writeFileSync(wrapper, `${script}\n`, { mode: 0o755 });
  return wrapper;
}

const python = spawnSync('python3', ['-c', 'import resource'], { encoding: 'utf8' });

/** Records `mib` against its memory ceiling (MiB) and fails over it. Memory does not scale with the machine factor. */
function expectWithinMemory(id: MemoryBudgetId, mib: number): void {
  const budget = MEMORY_BUDGETS[id];
  lines.push(
    `${mib <= budget.budgetMiB ? 'ok  ' : 'OVER'} ${id.padEnd(34)} ${mib.toFixed(0).padStart(7)} MiB budget ${budget.budgetMiB} MiB`,
  );
  expect(mib, `${id} (${budget.title}): ${mib.toFixed(0)} MiB over ${budget.budgetMiB} MiB`).toBeLessThanOrEqual(budget.budgetMiB);
}

const maxRssMiB = (): number => process.resourceUsage().maxRSS / 1024;

function runner(ctx: ExecutionContext): { run: (name: string, params: Record<string, unknown>) => CommandResult; doc: () => CadDocument } {
  let doc = createEmptyDocument();
  return {
    run(name, params) {
      const result = execute(doc, name, params, ctx);
      if (result.error !== undefined || result.rejected === true) throw new Error(`${name}: ${result.summary}`);
      doc = result.document;
      return result;
    },
    doc: () => doc,
  };
}

/** A component of one small box (12 triangles). */
function boxComponent(run: (name: string, params: Record<string, unknown>) => CommandResult): string {
  const id = run('add_box', { size: [0.6, 0.6, 0.6], position: [0, 0, 0.3] }).affected[0] as string;
  run('create_component', { name: 'cell', entityIds: [id], componentId: 'cell' });
  return 'cell';
}

describe.skipIf(requireTool('native:llull-compute', BINARY !== null && python.status === 0))(
  'render_realistic budgets (PERF1, RV1 V4)',
  () => {
    it('render.realistic.first256: the first image of a reference scene, native process start included', () => {
      const ctx: ExecutionContext = { ...defaultContext(), pathTrace: createPathTracePort(BINARY ?? '') };
      const build = RENDER_SCENES['balls-uniform'];
      if (build === undefined) throw new Error('balls-uniform scene missing');
      const scene = build(ctx);
      const started = performance.now();
      const result = execute(scene.doc, 'render_realistic', { ...scene.render, width: 256, height: 256, samples: 16, seed: 1 }, ctx);
      const elapsed = performance.now() - started;
      expect(result.error, result.summary).toBeUndefined();
      expectWithinBudget('render.realistic.first256', elapsed);
    });

    it('render.realistic.instances1m: a 1,000,000-member instance array built and rendered at 256 x 256, 4 samples', () => {
      const rssFile = path.join(scratch, 'peak-rss');
      const env = { ...process.env, LLULL_PEAK_RSS_FILE: rssFile };
      const ctx: ExecutionContext = { ...defaultContext(), pathTrace: createPathTracePort(peakRssWrapper(BINARY ?? ''), env) };
      const before = maxRssMiB();
      const started = performance.now();
      const { run } = runner(ctx);
      const component = boxComponent(run);
      run('add_instance_array', { componentId: component, counts: [100, 100, 100], step: [1, 1, 1], origin: [2, 0, 0] });
      const built = performance.now() - started;
      const result = run('render_realistic', { view: 'iso', width: 256, height: 256, samples: 4, seed: 1, exr: false });
      const elapsed = performance.now() - started;
      const data = result.data as { instances: number; elapsedMs: number };
      expect(data.instances).toBeGreaterThanOrEqual(1_000_000);
      expectWithinBudget('render.realistic.instances1m', elapsed);
      const nativeMiB = Number(readFileSync(rssFile, 'utf8')) / 1024;
      const hostMiB = maxRssMiB() - before;
      lines.push(
        `measured: instances1m build ${built.toFixed(0)} ms, native render ${data.elapsedMs.toFixed(0)} ms (stats), total ${elapsed.toFixed(0)} ms`,
      );
      expectWithinMemory('render.realistic.instances1m.native', nativeMiB);
      expectWithinMemory('render.realistic.instances1m.host', hostMiB);
    });

    it('render.realistic.refuse_too_large: over 8,000,000 placed parts is refused before any buffer grows', () => {
      let reached = false;
      const ctx: ExecutionContext = {
        ...defaultContext(),
        pathTrace: {
          render: () => {
            reached = true;
            return { ok: false, code: 'UNEXPECTED', message: 'the port must not be reached' };
          },
        },
      };
      const { run, doc } = runner(ctx);
      const component = boxComponent(run);
      run('add_instance_array', { componentId: component, counts: [200, 200, 100], step: [1, 1, 1] });
      run('add_instance_array', { componentId: component, counts: [200, 200, 100], step: [1, 1, 1], origin: [0, 0, 200] });
      run('add_box', { size: [1, 1, 1], position: [-5, 0, 0] });
      const before = maxRssMiB();
      const started = performance.now();
      const result = execute(doc(), 'render_realistic', { width: 64, height: 64, samples: 1 }, ctx);
      const elapsed = performance.now() - started;
      expect(result.error?.code).toBe('RENDER_SCENE_TOO_LARGE');
      expect(result.document).toBe(doc());
      expect(reached).toBe(false);
      expectWithinBudget('render.realistic.refuse_too_large', elapsed);
      expectWithinMemory('render.realistic.refuse_too_large.host', maxRssMiB() - before);
    });

    it('render.realistic.texture_budget: importing 4 GiB of textures (16 x 8192^2) refuses past 1 GiB, document unchanged', () => {
      const ctx: ExecutionContext = { ...defaultContext(), imageAssets: createImageAssetStore(path.join(scratch, 'images')) };
      let doc = createEmptyDocument();
      const big = toBase64(pngBytes(8192, 8192));
      const codes: string[] = [];
      const started = performance.now();
      for (let index = 0; index < 16; index++) {
        const result = execute(doc, 'import_texture', { name: `big-${index}`, base64: big }, ctx);
        if (result.error !== undefined) {
          codes.push(result.error.code);
          expect(result.document).toBe(doc);
        } else doc = result.document;
      }
      const elapsed = performance.now() - started;
      expect(Object.keys(doc.appearance?.textures ?? {})).toHaveLength(4);
      expect(codes).toEqual(Array.from({ length: 12 }, () => 'TEXTURE_BUDGET_EXCEEDED'));
      expectWithinBudget('render.realistic.texture_budget', elapsed);
    });
  },
);
