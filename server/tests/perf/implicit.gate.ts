/** PERF1 gate, implicit bodies: checking and measuring a multi-million-triangle body (budgets.ts `implicit.*`); skipped without llull-compute. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { createMeshAssetStore } from '../../src/meshAssets/store';
import { createNativeFieldEngine } from '../../src/native/fieldEngine';
import { nativeBinaryPath } from '../../src/native/nativeBinary';
import { requireTool } from '../../../tests/requireTool';
import { expectWithinBudget, medianMs, reportMeasurements } from './harness';

const directory = mkdtempSync(path.join(tmpdir(), 'llull-perf-implicit-'));
const BINARY = nativeBinaryPath('llull-compute');

afterAll(() => {
  console.warn(reportMeasurements());
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(requireTool('native:llull-compute', BINARY !== null))('implicit body performance budgets (PERF1)', () => {
  it('implicit.{create,check,properties}.gyroid7m: a 7.3M-triangle gyroid body in the mesh asset store', async () => {
    const engine = createNativeFieldEngine(BINARY === null ? {} : { binary: BINARY });
    if (engine === null) return;
    const context: ExecutionContext = { ...defaultContext(), fieldEngine: engine, meshAssets: createMeshAssetStore(directory) };
    let doc: CadDocument = createEmptyDocument();
    const run = (name: string, params: Record<string, unknown>): CommandResult => {
      const result = execute(doc, name, params, context);
      if (result.rejected === true || result.error !== undefined) throw new Error(`${name}: ${result.summary}`);
      doc = result.document;
      return result;
    };
    const cell = run('add_field_primitive', { shape: 'box', size: [60, 60, 60], position: [30, 30, 30] }).affected[0];
    const gyroid = run('add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.8, cellSize: 6, origin: [0, 0, 0], region: cell });
    const started = performance.now();
    const body = run('create_implicit_body', { field: gyroid.affected[0], voxel: 0.5 });
    const created = performance.now() - started;
    const id = body.affected[0] as string;
    expect((body.data as { triangles: number }).triangles).toBeGreaterThan(7_000_000);
    expectWithinBudget('implicit.create.gyroid7m', created);
    const process = { minWallMm: 0.4, buildDirection: [0, 0, 1], criticalAngleDeg: 45, source: 'perf gate' };
    let checked: CommandResult = body;
    const check = await medianMs(() => {
      checked = run('check_implicit', { id, process });
    }, 3);
    expect(checked.summary).toContain('check_implicit');
    expectWithinBudget('implicit.check.gyroid7m', check);
    let measured: CommandResult = body;
    const properties = await medianMs(() => {
      measured = run('implicit_properties', { id });
    }, 3);
    expect((measured.data as { volumeMesh: number }).volumeMesh).toBe((body.data as { volumeMesh: number }).volumeMesh);
    expectWithinBudget('implicit.properties.gyroid7m', properties);
  });
});
