/**
 * DES-6c oracle (VC-BLD-26 style): the exported CadQuery / build123d program is RUN with real OCP and its volume compared with the exact removed volume of a
 * right-angle chamfer, 1/2 integral d1(s) d2(s) ds, which is what llull's native kernel is held to (06 BLD 13.14), and its vertices are placed absolutely:
 * the leg of the kernel's edge start sits at the kernel's start end, whichever way the target solid runs the edge. Needs a python importing OCP + cadquery +
 * build123d (LLULL_PYTHON; docs/QUALITY_GATES.md): skipped loudly without one, and a FAILURE when CI is set.
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
import { edgeOf, scriptedKernel, TOPOLOGY } from '../helpers/blendKernel';

const PYTHON = process.env['LLULL_PYTHON'] ?? 'python3';
const probe = spawnSync(PYTHON, ['-I', '-c', 'import OCP'], { encoding: 'utf8', timeout: 60_000 });
const available = probe.status === 0;
const inCi = process.env['CI'] !== undefined && process.env['CI'] !== '';
if (!available && !inCi)
  console.warn(`chamferCodegenOracle skipped: ${PYTHON} cannot import OCP (set LLULL_PYTHON to a python with OCP + cadquery + build123d)`);

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
print("LLULLJSON" + json.dumps({"volume": space["_chamfer_volume"](shape), "vertices": vertices, "flips": space.get("FLIPS", [])}))
`;

/** Records, per chamfered edge, whether the helper had to flip the target's edge to the kernel's direction. */
const FLIP_PROBE = [
  '_orient = _chamfer_oriented',
  'FLIPS = []',
  'def _chamfer_oriented(start, end, hint, varying):',
  '    result = _orient(start, end, hint, varying)',
  '    FLIPS.append(result[0] != start)',
  '    return result',
].join('\n');

type Vertex = readonly [number, number, number];
interface Outcome {
  readonly volume: number;
  readonly vertices: readonly Vertex[];
  readonly flips: readonly boolean[];
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

const hasVertex = (outcome: Outcome, point: Vertex): boolean =>
  outcome.vertices.some((vertex) => vertex.every((coordinate, axis) => Math.abs(coordinate - (point[axis] ?? 0)) < 1e-6));

/** The kernel's start of the edge x = 10, z = 2.5 (along y) is at y = -5 (forward) or y = 5 (reversed). */
const startY = (forward: boolean): number => (forward ? -5 : 5);

/** The vertices of legs 1 -> 1.5 and 2 -> 2.5 on the edge x = 10, z = 2.5, the first leg on the x+ face (side) or the z+ face (top), and their mirror images. */
function legVertices(forward: boolean, firstOnSide: boolean): { present: Vertex[]; absent: Vertex[] } {
  const [from, to] = [startY(forward), -startY(forward)];
  const side = (d: number): number => 2.5 - d;
  const top = (d: number): number => 10 - d;
  const [d1, e1, d2, e2] = firstOnSide ? [1, 1.5, 2, 2.5] : [2, 2.5, 1, 1.5];
  return {
    present: [
      [10, from, side(d1)],
      [10, to, side(e1)],
      [top(d2), from, 2.5],
      [top(e2), to, 2.5],
    ],
    absent: [
      [10, to, side(d1)],
      [10, from, side(e1)],
      [top(d2), to, 2.5],
      [top(e2), from, 2.5],
    ],
  };
}

describe.skipIf(available || !inCi)('chamfer oracle prerequisites', () => {
  it('a python with OCP, cadquery and build123d is available (CI must run this oracle)', () => {
    expect(available, 'set LLULL_PYTHON to a python that imports OCP + cadquery + build123d (docs/QUALITY_GATES.md)').toBe(true);
  });
});

describe.skipIf(!available)('exported variable chamfers, run with OCP', () => {
  /** Export a chamfer whose kernel edge 0 is x = 10, z = 2.5 and starts at y = startY(forward). */
  const exported = (params: Record<string, unknown>, language: PythonBackend, forward = true): string => {
    const edge = edgeOf(0, { start: [10, startY(forward), 2.5], end: [10, -startY(forward), 2.5], mid: [10, 0, 2.5], length: 10 });
    const topology = { ...TOPOLOGY, edges: [edge, ...TOPOLOGY.edges.slice(1)] };
    setGeometryKernel(scriptedKernel({ topology, distance: (face, point) => Math.abs(face - point[0]) }));
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const chamfer = execute(box.document, 'chamfer_edge', { id: box.affected[0], edgeIndices: [0], ...params });
    expect(chamfer.affected.length, chamfer.summary).toBeGreaterThan(0);
    const text = (execute(chamfer.document, 'export_code', { language }).data as { text: string }).text;
    return text.replace(/^(box_1 = chamfer_legs)/m, `${FLIP_PROBE}\n$1`);
  };
  const TWO_LEG = { distance: 1, distance2: 2, distanceEnd: 1.5, distance2End: 2.5 };

  const expectLegs = (outcome: Outcome, forward: boolean, firstOnSide: boolean): void => {
    expect(outcome.volume).toBeCloseTo(1000 - removed(10, 1, 1.5, 2, 2.5), 6);
    const { present, absent } = legVertices(forward, firstOnSide);
    for (const point of present) expect(hasVertex(outcome, point), `missing vertex ${point.join(',')}`).toBe(true);
    for (const point of absent) expect(hasVertex(outcome, point), `mirrored vertex ${point.join(',')}`).toBe(false);
  };

  it.each(BACKENDS)('%s: the first leg sits at the kernel start of the edge, whichever way the target runs it', (language) => {
    const forward = runProgram(`${language}-fwd`, exported({ ...TWO_LEG, side1Near: [0, 0, 0] }, language, true));
    const reversed = runProgram(`${language}-rev`, exported({ ...TWO_LEG, side1Near: [0, 0, 0] }, language, false));
    expectLegs(forward, true, true);
    expectLegs(reversed, false, true);
    // one of the two runs had to flip the target's own direction, the other not: both branches are exercised
    expect([forward.flips[0], reversed.flips[0]].sort()).toEqual([false, true]);
  });

  it.each(BACKENDS)('%s: swapping the leading face swaps the legs (the legs sit on the faces the document names)', (language) => {
    for (const forward of [true, false])
      expectLegs(
        runProgram(`${language}-top-${forward}`, exported({ ...TWO_LEG, side1Near: [1, 0, 0] }, language, forward)),
        forward,
        false,
      );
  });

  it.each(BACKENDS)('%s: a block built another way (a union of halves) gets the same absolute legs for either start', (language) => {
    for (const forward of [true, false]) {
      const model = [
        'a = union(box((10, 10, 5), position=(-5, 0, 0)), box((10, 10, 5), position=(5, 0, 0)))',
        `a = chamfer_legs(a, [0], 1, 1.5, 2, 2.5, lead=[(1, 0, 0)], near=[(10, 0, 2.5)], start=[(10, ${startY(forward)}, 2.5)])`,
        'finish()',
      ];
      const source = ['LLULL_UNITS = "mm"', pythonRuntime(language), FLIP_PROBE, ...model].join('\n');
      expectLegs(runProgram(`union-${language}-${forward}`, source), forward, true);
    }
  });

  it.each(BACKENDS)('%s: a variable symmetric chamfer removes the exact volume', (language) => {
    const outcome = runProgram(language, exported({ distance: 1, distanceEnd: 2 }, language));
    expect(outcome.volume).toBeCloseTo(1000 - removed(10, 1, 2, 1, 2), 6);
    expect(hasVertex(outcome, [10, -5, 1.5])).toBe(true);
    expect(hasVertex(outcome, [10, 5, 0.5])).toBe(true);
  });

  it.each(BACKENDS)('%s: a concave edge is FUSED (the volume grows by the same exact amount)', (language) => {
    const model = [
      'a = box((20, 10, 5))',
      'b = box((10, 10, 5), position=(-5, 0, 5))',
      'joined = union(a, b)',
      'joined = chamfer_legs(joined, [0], 1, 1.5, 2, 2.5, lead=[(0, 0, 1)], near=[(0, 0, 2.5)], start=[(0, -5, 2.5)])',
      'finish()',
    ];
    const outcome = runProgram(`concave-${language}`, ['LLULL_UNITS = "mm"', pythonRuntime(language), ...model].join('\n'));
    expect(outcome.volume).toBeCloseTo(1500 + removed(10, 1, 1.5, 2, 2.5), 6);
  });

  const CALL = 'a = chamfer_legs(box((20, 10, 5)), [0], 1, 1.5, 2, 2.5, lead=[(1, 0, 0)], near=[(10, 0, 2.5)], start=[(10, -5, 2.5)])';
  const PATCH_TOOL = ['_tool = _chamfer_tool', 'def _chamfer_tool(*args):', '    solid, convex, point, area = _tool(*args)'];
  const REFUSALS: ReadonlyArray<{ name: string; patch?: readonly string[]; model: readonly string[]; message: string }> = [
    {
      name: 'long',
      model: ['a = chamfer_legs(box((20, 10, 5)), [0], 1, 1.5, 21, 21.5, lead=[(1, 0, 0)], near=[(10, 0, 2.5)], start=[(10, -5, 2.5)])'],
      message: 'reaches past the faces',
    },
    {
      name: 'slanted',
      model: [
        'a = cut(box((20, 10, 5)), box((10, 20, 20), position=(10, 0, 0), rotation=(0, 30, 0)))',
        'a = chamfer_legs(a, [0], 0.5, 0.5, 1, 1, near=[(-2.1650635094610973, -5, 2.5)])',
      ],
      message: 'flat square ends',
    },
    {
      name: 'curved',
      model: ['c = chamfer_legs(cylinder(radius=5, height=10), [0], 1, 1.5, 1, 1.5, start=[(0, 0, 0)])'],
      message: 'BLD_CODEGEN_UNSUPPORTED',
    },
    {
      name: 'wronglead',
      model: ['a = chamfer_legs(box((20, 10, 5)), [0], 1, 1.5, 2, 2.5, lead=[(0.6, 0.8, 0)], near=[(10, 0, 2.5)], start=[(10, -5, 2.5)])'],
      message: 'outward normal of neither face',
    },
    { name: 'nostart', model: ['a = chamfer_legs(box((20, 10, 5)), [0], 1, 1.5, 1, 1.5, near=[(10, 0, 2.5)])'], message: 'needs start=' },
    {
      name: 'strangestart',
      model: ['a = chamfer_legs(box((20, 10, 5)), [0], 1, 1.5, 1, 1.5, near=[(10, 0, 2.5)], start=[(0, 0, 0)])'],
      message: 'cannot tell which end',
    },
    {
      name: 'adjacent',
      model: [
        'a = chamfer_legs(box((20, 10, 5)), [0, 1], 1, 1.5, 1, 1.5, near=[(10, 0, 2.5), (0, 5, 2.5)], start=[(10, -5, 2.5), (10, 5, 2.5)])',
      ],
      message: 'share a corner',
    },
    {
      name: 'nowhere',
      model: ['a = chamfer_legs(box((20, 10, 5)), [0], 1, 1.5, 1, 1.5, near=[(3, 3, 3)], start=[(10, -5, 2.5)])'],
      message: 'has its mid point at',
    },
    { name: 'wrongway', patch: [...PATCH_TOOL, '    return solid, not convex, point, area'], model: [CALL], message: 'the legs ask for' },
    {
      name: 'wrongsize',
      patch: [...PATCH_TOOL, '    return solid, convex, point, area * 1.01'],
      model: [CALL],
      message: 'the legs ask for',
    },
  ];

  for (const language of BACKENDS)
    for (const refusal of REFUSALS)
      it(`${language}: ${refusal.name} is refused by name`, () => {
        const path = join(directory, `refused-${refusal.name}-${language}.py`);
        writeFileSync(path, ['LLULL_UNITS = "mm"', pythonRuntime(language), ...(refusal.patch ?? []), ...refusal.model].join('\n'));
        const run = spawnSync(PYTHON, ['-I', path], { encoding: 'utf8', timeout: 120_000 });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain(refusal.message);
      });
});
