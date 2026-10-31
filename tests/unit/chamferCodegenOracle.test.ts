/**
 * DES-6c oracle (VC-BLD-26 style): the exported CadQuery / build123d program is RUN with real OCP and its volume compared with the exact removed volume of a
 * right-angle chamfer, 1/2 integral d1(s) d2(s) ds, which is what llull's native kernel is held to (06 BLD 13.14). Skipped, loudly, without a python that
 * imports OCP + cadquery + build123d (set LLULL_PYTHON to one).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { pythonRuntime, type PythonBackend } from '@core/codegen/pythonRuntime';
import { scriptedKernel } from '../helpers/blendKernel';

const PYTHON = process.env['LLULL_PYTHON'] ?? 'python3';
const probe = spawnSync(PYTHON, ['-I', '-c', 'import OCP, cadquery, build123d'], { encoding: 'utf8', timeout: 120_000 });
const available = probe.status === 0;
if (!available) console.warn(`chamferCodegenOracle skipped: ${PYTHON} cannot import OCP + cadquery + build123d (set LLULL_PYTHON)`);

const directory = mkdtempSync(join(tmpdir(), 'llull-chamfer-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => setGeometryKernel(null));

const DRIVER = String.raw`
import json, runpy, sys
space = runpy.run_path(sys.argv[1], run_name="llull_oracle")
shape = space["_shape_of"](list(space["LLULL_LIVE"].values())[-1].shape).wrapped
from OCP.BRep import BRep_Tool
from OCP.TopAbs import TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
vertices, explorer = [], TopExp_Explorer(shape, TopAbs_VERTEX)
while explorer.More():
    point = BRep_Tool.Pnt_s(space["_chamfer_cast"]("Vertex")(explorer.Current()))
    vertices.append([round(point.X(), 6), round(point.Y(), 6), round(point.Z(), 6)])
    explorer.Next()
vertices = [list(v) for v in sorted(set(tuple(v) for v in vertices))]
print("LLULLJSON" + json.dumps({"volume": space["_chamfer_volume"](shape), "vertices": vertices}))
`;

interface Outcome {
  readonly volume: number;
  readonly vertices: ReadonlyArray<readonly [number, number, number]>;
}

function runProgram(name: string, source: string): Outcome {
  const program = join(directory, `${name}.py`);
  const driver = join(directory, 'driver.py');
  writeFileSync(program, source);
  writeFileSync(driver, DRIVER);
  const run = spawnSync(PYTHON, ['-I', driver, program], { encoding: 'utf8', timeout: 120_000 });
  expect(run.status, run.stderr).toBe(0);
  const line = run.stdout.split('\n').find((text) => text.startsWith('LLULLJSON'));
  return JSON.parse((line ?? 'LLULLJSON{}').slice('LLULLJSON'.length)) as Outcome;
}

const BACKENDS: readonly PythonBackend[] = ['cadquery', 'build123d'];
/** 1/2 integral over [0, L] of (d1 + (e1 - d1) s)(d2 + (e2 - d2) s) ds with s = x / L. */
const removed = (length: number, d1: number, e1: number, d2: number, e2: number): number =>
  0.5 * length * (d1 * d2 + (d1 * (e2 - d2) + d2 * (e1 - d1)) / 2 + ((e1 - d1) * (e2 - d2)) / 3);

describe.skipIf(!available)('exported variable chamfers, run with OCP', () => {
  const exported = (params: Record<string, unknown>, language: PythonBackend): string => {
    setGeometryKernel(scriptedKernel({ distance: (face, point) => Math.abs(face - point[0]) }));
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const chamfer = execute(box.document, 'chamfer_edge', { id: box.affected[0], edgeIndices: [0], ...params });
    expect(chamfer.affected.length, chamfer.summary).toBeGreaterThan(0);
    return (execute(chamfer.document, 'export_code', { language }).data as { text: string }).text;
  };

  it.each(BACKENDS)('%s: a convex two-leg variable chamfer removes the exact volume and puts each leg on its face', (language) => {
    const outcome = runProgram(
      language,
      exported({ distance: 1, distance2: 2, distanceEnd: 1.5, distance2End: 2.5, side1Near: [0, 0, 0] }, language),
    );
    expect(outcome.volume).toBeCloseTo(1000 - removed(10, 1, 1.5, 2, 2.5), 6);
    // the edge x = 10, z = 2.5 along y: first leg runs down the x+ face (z = 2.5 - d1), second along the top (x = 10 - d2); both legs grow with y or both shrink
    const onSide = outcome.vertices.filter(([x, , z]) => Math.abs(x - 10) < 1e-6 && z > -2.4 && z < 2.5 - 1e-6);
    const onTop = outcome.vertices.filter(([x, , z]) => Math.abs(z - 2.5) < 1e-6 && x > -9 && x < 10 - 1e-6);
    expect(onSide.map(([, , z]) => z).sort((a, b) => a - b)).toEqual([1, 1.5]);
    expect(onTop.map(([x]) => x).sort((a, b) => a - b)).toEqual([7.5, 8]);
    for (const [, y, z] of onSide) {
      const partner = onTop.find(([, topY]) => Math.abs(topY - y) < 1e-6);
      expect(partner?.[0]).toBeCloseTo(z === 1.5 ? 8 : 7.5, 6);
    }
  });

  it.each(BACKENDS)('%s: swapping the leading face swaps the legs (the legs sit on the faces the document names)', (language) => {
    const outcome = runProgram(
      language,
      exported({ distance: 1, distance2: 2, distanceEnd: 1.5, distance2End: 2.5, side1Near: [1, 0, 0] }, language),
    );
    expect(outcome.volume).toBeCloseTo(1000 - removed(10, 1, 1.5, 2, 2.5), 6);
    const onSide = outcome.vertices.filter(([x, , z]) => Math.abs(x - 10) < 1e-6 && z > -2.4 && z < 2.5 - 1e-6);
    const onTop = outcome.vertices.filter(([x, , z]) => Math.abs(z - 2.5) < 1e-6 && x > -9 && x < 10 - 1e-6);
    expect(onSide.map(([, , z]) => z).sort((a, b) => a - b)).toEqual([0, 0.5]);
    expect(onTop.map(([x]) => x).sort((a, b) => a - b)).toEqual([8.5, 9]);
  });

  it.each(BACKENDS)('%s: a variable symmetric chamfer removes the exact volume', (language) => {
    const outcome = runProgram(language, exported({ distance: 1, distanceEnd: 2 }, language));
    expect(outcome.volume).toBeCloseTo(1000 - removed(10, 1, 2, 1, 2), 6);
  });

  it.each(BACKENDS)('%s: a concave edge is FUSED (the volume grows by the same exact amount)', (language) => {
    const model = [
      'a = box((20, 10, 5))',
      'b = box((10, 10, 5), position=(-5, 0, 5))',
      'joined = union(a, b)',
      'joined = chamfer_legs(joined, [0], 1, 1.5, 2, 2.5, lead=[(0, 0, 1)], near=[(0, 0, 2.5)])',
      'finish()',
    ];
    const outcome = runProgram(`concave-${language}`, ['LLULL_UNITS = "mm"', pythonRuntime(language), ...model].join('\n'));
    expect(outcome.volume).toBeCloseTo(1500 + removed(10, 1, 1.5, 2, 2.5), 6);
  });

  const refusedAtRun = (language: PythonBackend, name: string, model: readonly string[], message: string): void => {
    const path = join(directory, `${name}-${language}.py`);
    writeFileSync(path, ['LLULL_UNITS = "mm"', pythonRuntime(language), ...model].join('\n'));
    const run = spawnSync(PYTHON, ['-I', path], { encoding: 'utf8', timeout: 120_000 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(message);
  };

  it.each(BACKENDS)('%s: legs longer than a face, or an end that is not square to the edge, are refused by name', (language) => {
    refusedAtRun(
      language,
      'long',
      ['a = box((20, 10, 5))', 'a = chamfer_legs(a, [0], 1, 1.5, 21, 21.5, lead=[(1, 0, 0)], near=[(10, 0, 2.5)])'],
      'reaches past the faces',
    );
    refusedAtRun(
      language,
      'slanted',
      [
        'a = box((20, 10, 5))',
        'a = cut(a, box((10, 20, 20), position=(10, 0, 0), rotation=(0, 30, 0)))',
        'a = chamfer_legs(a, [0], 0.5, 1, 0.5, 1, near=[(-3, -5, 2.5)])',
      ],
      'flat square ends',
    );
  });

  it.each(BACKENDS)('%s: a curved edge raises BLD_CODEGEN_UNSUPPORTED at run time, never a constant chamfer', (language) => {
    refusedAtRun(
      language,
      'curved',
      ['c = cylinder(radius=5, height=10)', 'c = chamfer_legs(c, [0], 1, 1.5, 1, 1.5)'],
      'BLD_CODEGEN_UNSUPPORTED',
    );
  });
});
