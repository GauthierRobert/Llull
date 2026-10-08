/**
 * @layer server/tests
 * Exact recipes through the Python bridge: a drilled block whose hole lip is filleted on the OCC
 * kernel exports as CadQuery code that rebuilds the B-rep (boolean + fillet, not a triangle soup),
 * writes an exact STEP (a toroidal fillet face), and round-trips back into an editable llull history.
 * Skipped when the configured python has no CadQuery (CI).
 *
 *   LLULL_TEST_CADQUERY_PYTHON=/path/to/venv/bin/python npx vitest run tests/brepCodeExchange.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { createNodeOcctKernel } from '../src/occtNode';
import { createPythonExchangePort } from '../src/pythonExchange';
import { BRIDGE_SCRIPT, CADQUERY_PYTHON, probePython } from './exchangeTestSupport';

const hasCadQuery = probePython(CADQUERY_PYTHON).cadquery !== null;

const port = createPythonExchangePort({
  python: CADQUERY_PYTHON,
  build123dPython: CADQUERY_PYTHON,
  timeoutMs: 120_000,
  bridgeScript: BRIDGE_SCRIPT,
  exchangeDir: null,
});

function run(doc: CadDocument, name: string, params: unknown): ReturnType<typeof execute> {
  const result = execute(doc, name, params);
  if (result.affected.length === 0 && result.data === undefined) throw new Error(result.summary);
  return result;
}

/** A 40 mm block drilled through, the top lip of the hole filleted (r 2). */
function filletedBlock(): { doc: CadDocument; id: string } {
  const block = run(createEmptyDocument(), 'add_box', { size: [40, 40, 20], name: 'Block' });
  const drill = run(block.document, 'add_cylinder', { radius: 6, height: 40 });
  const drilled = run(drill.document, 'boolean_subtract', {
    a: block.affected[0],
    b: drill.affected[0],
  });
  const holed = drilled.affected[0]!;
  const topology = run(drilled.document, 'inspect_topology', { id: holed }).data as ShapeTopology;
  const lip = topology.edges.find((edge) => edge.curve === 'circle' && edge.mid[2] > 9);
  const filleted = run(drilled.document, 'fillet_edge', {
    id: holed,
    edgeIndices: [lip!.index],
    radius: 2,
  });
  return { doc: filleted.document, id: filleted.affected[0]! };
}

describe.skipIf(!hasCadQuery)('exact recipes through CadQuery', () => {
  let doc: CadDocument;
  let code: string;

  beforeAll(async () => {
    setGeometryKernel(await createNodeOcctKernel());
    doc = filletedBlock().doc;
    code = (execute(doc, 'export_code', { language: 'cadquery' }).data as { text: string }).text;
  }, 180_000);

  afterAll(() => setGeometryKernel(null));

  it('emits the construction (boolean + fillet with the lip mid point), not a triangle mesh', () => {
    expect(code).toMatch(/= cut\(/);
    expect(code).toMatch(/= fillet\(\w+, \[\d+\], 2, near=\[\(/);
    expect(code).not.toMatch(/= mesh\(\[/);
  });

  it('writes an exact STEP: planes, a cylinder and the toroidal fillet', async () => {
    const result = await port.runProgram({ language: 'cadquery', source: code, step: true });
    const step = Buffer.from(result.stepBase64 as string, 'base64').toString('utf8');
    expect(step).toMatch(/CYLINDRICAL_SURFACE/);
    expect(step).toMatch(/TOROIDAL_SURFACE/);
    expect(step).not.toMatch(/TRIANGULATED_FACE|POLY_LOOP/);
  }, 120_000);

  it('round-trips into an editable history with the same exact volume', async () => {
    const result = await port.runProgram({ language: 'cadquery', source: code, step: false });
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: result.trace });
    const names = applied.document.featureHistory.map((step) => step.name);
    expect(names).toEqual(['add_box', 'add_cylinder', 'boolean_subtract', 'fillet_edge']);
    const volumeOf = (source: CadDocument): number => {
      const [id] = source.order;
      return (execute(source, 'inspect_topology', { id }).data as ShapeTopology).volume;
    };
    expect(volumeOf(applied.document)).toBeCloseTo(volumeOf(doc), 3);
  }, 120_000);

  it('chamfer and shell also rebuild exactly through CadQuery (same volume as OCC)', async () => {
    const box = run(createEmptyDocument(), 'add_box', { size: [30, 30, 30] });
    const hollow = run(box.document, 'shell_solid', { id: box.affected[0], thickness: 2 });
    const shelled = run(hollow.document, 'chamfer_edge', {
      id: hollow.affected[0],
      edgeIndices: [0],
      distance: 3,
    });
    const source = (
      execute(shelled.document, 'export_code', { language: 'cadquery' }).data as {
        text: string;
      }
    ).text;
    expect(source).toMatch(/= chamfer\(/);
    expect(source).toMatch(/= shell\(\w+, 2\)/);
    const result = await port.runProgram({ language: 'cadquery', source, step: false });
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: result.trace });
    const volume = (target: CadDocument): number =>
      (execute(target, 'inspect_topology', { id: target.order[0] }).data as ShapeTopology).volume;
    expect(volume(applied.document)).toBeCloseTo(volume(shelled.document), 3);
    expect(volume(shelled.document)).toBeCloseTo(30 ** 3 - 26 ** 3 - (9 / 2) * 30, 3);
  }, 120_000);

  it('a snapshot export (no history) still rebuilds the exact recipe', () => {
    const snapshot = { ...doc, featureHistory: [] };
    const text = (
      execute(snapshot, 'export_code', { language: 'cadquery' }).data as { text: string }
    ).text;
    expect(text).toMatch(/= cut\(/);
    expect(text).toMatch(/= fillet\(/);
  });
});
