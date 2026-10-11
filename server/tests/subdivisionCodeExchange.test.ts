/**
 * @layer server/tests
 * Subdivision solids in generated code. The pure Python port of Catmull-Clark + Bézier patches
 * (codegen/pythonSubdivision.ts) must reproduce the TypeScript patches (any python3). With
 * CadQuery available, the exported script builds exact B-spline faces (STEP) and its trace
 * round-trips into an editable subdivision solid (skipped in CI otherwise:
 * LLULL_TEST_CADQUERY_PYTHON=/path/to/venv/bin/python).
 */

import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEmptyDocument, type CadDocument, type SubdivisionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { cylinderCage } from '@core/geometry/subdivision';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { SUBDIVISION_PY } from '@core/codegen/pythonSubdivision';
import { createNodeOcctKernel } from '../src/occtNode';
import { createPythonExchangePort } from '../src/pythonExchange';
import { BRIDGE_SCRIPT, CADQUERY_PYTHON, probePython } from './exchangeTestSupport';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasCadQuery = probePython(CADQUERY_PYTHON).cadquery !== null;

/** A creased cylinder cage (valence-6 cap centres after refinement, crease rings). */
function creasedCage(): Pick<SubdivisionEntity, 'vertices' | 'faces' | 'creases'> {
  const cage = cylinderCage(2, 5, 6, 2);
  const rim = (cage.faces[cage.faces.length - 1] ?? []).map(
    (a, i, face) => [a, face[(i + 1) % face.length]] as [number, number],
  );
  return { ...cage, vertices: cage.vertices.map(([x, y, z]) => [x + 0.3 * z, y, z]), creases: rim };
}

describe.skipIf(!hasPython)('python subdivision port', () => {
  it('reproduces the TypeScript Bézier patches', () => {
    const cage = creasedCage();
    const driver = [
      'import json, sys',
      SUBDIVISION_PY,
      'cage = json.load(sys.stdin)',
      "print(json.dumps(_subdivision_patches(cage['vertices'], cage['faces'], cage['creases'])))",
    ].join('\n');
    const run = spawnSync('python3', ['-c', driver], {
      input: JSON.stringify(cage),
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const fromPython = JSON.parse(run.stdout) as number[][][];
    const fromTypeScript = subdivisionPatches(cage);
    expect(fromPython).toHaveLength(fromTypeScript.length);
    fromTypeScript.forEach((poles, p) =>
      poles.forEach((pole, k) =>
        pole.forEach((value, axis) => expect(fromPython[p]?.[k]?.[axis]).toBeCloseTo(value, 9)),
      ),
    );
  });
});

describe.skipIf(!hasPython)('exported subdivision code', () => {
  const cage = creasedCage();
  const doc = execute(createEmptyDocument(), 'add_subdivision_solid', {
    ...cage,
    levels: 2,
    position: [5, 0, 0],
    name: 'grip',
  }).document;

  it.each(['cadquery', 'build123d', 'freecad'] as const)(
    '%s calls subdivision(...) and parses as Python',
    (language) => {
      const text = (execute(doc, 'export_code', { language }).data as { text: string }).text;
      expect(text).toMatch(/= subdivision\(\[/);
      expect(text).toContain('levels=2');
      expect(text).not.toMatch(/= mesh\(\[/);
      const parse = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
        input: text,
        encoding: 'utf8',
      });
      expect(parse.status, parse.stderr).toBe(0);
    },
  );

  it('openscad gets the subdivided surface as a placed polyhedron', () => {
    const text = (execute(doc, 'export_code', { language: 'openscad' }).data as { text: string })
      .text;
    expect(text).toMatch(/translate\(\[5, 0, 0\]\) polyhedron\(/);
  });
});

describe.skipIf(!hasCadQuery)('subdivision solids through CadQuery', () => {
  const port = createPythonExchangePort({
    python: CADQUERY_PYTHON,
    build123dPython: CADQUERY_PYTHON,
    timeoutMs: 120_000,
    bridgeScript: BRIDGE_SCRIPT,
    exchangeDir: null,
  });
  let doc: CadDocument;
  let code: string;

  beforeAll(async () => {
    setGeometryKernel(await createNodeOcctKernel());
    const cage = creasedCage();
    doc = execute(createEmptyDocument(), 'add_subdivision_solid', {
      vertices: cage.vertices,
      faces: cage.faces,
      creases: cage.creases,
      levels: 2,
      position: [5, 0, 0],
    }).document;
    code = (execute(doc, 'export_code', { language: 'cadquery' }).data as { text: string }).text;
  }, 180_000);

  afterAll(() => setGeometryKernel(null));

  it('writes exact B-spline faces to STEP', async () => {
    const result = await port.runProgram({ language: 'cadquery', source: code, step: true });
    const step = Buffer.from(result.stepBase64 as string, 'base64').toString('utf8');
    expect(step).toMatch(/B_SPLINE_SURFACE_WITH_KNOTS/);
  }, 120_000);

  it('round-trips into an editable subdivision solid with the same exact volume', async () => {
    const result = await port.runProgram({ language: 'cadquery', source: code, step: false });
    const applied = execute(createEmptyDocument(), 'apply_code_trace', { trace: result.trace });
    const [id] = applied.document.order;
    expect(applied.document.entities[id as string]?.kind).toBe('subdivision');
    const volume = (target: CadDocument): number =>
      (execute(target, 'inspect_topology', { id: target.order[0] }).data as ShapeTopology).volume;
    expect(volume(applied.document)).toBeCloseTo(volume(doc), 3);
  }, 120_000);
});
