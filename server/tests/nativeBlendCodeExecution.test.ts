/**
 * VC-BLD-26 at run time: the CadQuery code `export_code` writes for a radius-law fillet is executed under CPython + OCP and its volume is compared
 * to the native kernel's. Skipped, with the reason logged, when no native llull-kernel is built or the python has no cadquery
 * (`LLULL_TEST_CADQUERY_PYTHON=<python with cadquery>`, the bundled desktop interpreter or any `pip install cadquery`).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { CADQUERY_PYTHON, probePython } from './exchangeTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

vi.setConfig({ testTimeout: 300_000 });

const pythonHasCadQuery = probePython(CADQUERY_PYTHON).cadquery !== null;
const skipReason =
  nativeKernelBinary === null
    ? 'no native llull-kernel binary'
    : !pythonHasCadQuery
      ? 'no CPython with cadquery (LLULL_TEST_CADQUERY_PYTHON)'
      : null;
if (skipReason !== null) console.warn(`[nativeBlendCodeExecution] skipped: ${skipReason}`);

const DRIVER = `
import sys, json
namespace = {"__name__": "llull_script"}
exec(compile(open(sys.argv[1], encoding="utf8").read(), sys.argv[1], "exec"), namespace)
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps


def adaptive(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape.wrapped, props, 1e-10)
    return props.Mass()


solids = [solid.shape for solid in namespace["LLULL_LIVE"].values()]
print(json.dumps({"volumes": [shape.Volume() for shape in solids], "adaptive": [abs(adaptive(shape)) for shape in solids]}))
`;

describe.skipIf(skipReason !== null)('VC-BLD-26: exported radius-law fillets run under CPython + OCP', () => {
  let kernel: IsolatedKernel;
  let dir: string;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
    dir = mkdtempSync(path.join(tmpdir(), 'llull-blend-code-'));
    writeFileSync(path.join(dir, 'driver.py'), DRIVER);
  }, 120_000);
  const rows: string[] = [];
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
    rmSync(dir, { recursive: true, force: true });
    const table = process.env['LLULL_BLEND_TABLE'];
    if (table !== undefined) appendFileSync(table, `${rows.join('\n')}\n`);
  });

  const block = (edges: unknown[], size: number[] = [20, 10, 5]): { doc: CadDocument; id: string } => {
    const box = execute(createEmptyDocument(), 'add_box', { size });
    const id = box.affected[0] as string;
    const done = execute(box.document, 'fillet_edge', { id, edges });
    return { doc: done.document, id: done.affected[0] as string };
  };
  const nativeVolume = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const exported = (doc: CadDocument): { text: string; summary: string } => {
    const result = execute(doc, 'export_code', { language: 'cadquery' });
    return { text: (result.data as { text: string }).text, summary: result.summary };
  };
  const meshVolume = (entity: MeshSolidEntity): number => {
    const { positions, indices } = entity.mesh;
    let sum = 0;
    for (let k = 0; k < indices.length; k += 3) {
      const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]].map((index) => (index ?? 0) * 3);
      const p = (o: number | undefined, axis: number): number => positions[(o ?? 0) + axis] ?? 0;
      sum +=
        p(a, 0) * (p(b, 1) * p(c, 2) - p(b, 2) * p(c, 1)) -
        p(a, 1) * (p(b, 0) * p(c, 2) - p(b, 2) * p(c, 0)) +
        p(a, 2) * (p(b, 0) * p(c, 1) - p(b, 1) * p(c, 0));
    }
    return Math.abs(sum / 6);
  };
  /** Volume of the one solid the script leaves: OCP's default rule (`fixed`) and the adaptive rule at 1e-10 (`adaptive`). */
  const runVolumes = (text: string): { fixed: number; adaptive: number } => {
    const script = path.join(dir, 'model.py');
    writeFileSync(script, text);
    const run = spawnSync(CADQUERY_PYTHON, [path.join(dir, 'driver.py'), script], { encoding: 'utf8', timeout: 240_000 });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as { volumes: number[]; adaptive: number[] };
    expect(out.volumes, 'the script leaves exactly one solid').toHaveLength(1);
    return { fixed: out.volumes[0] ?? Number.NaN, adaptive: out.adaptive[0] ?? Number.NaN };
  };
  const runVolume = (text: string): number => runVolumes(text).fixed;

  /** Block 20 x 10 x 5, top edge, straight law through (t, r) nodes: 1000 - (1 - pi/4) integral r^2 ds, a piece of length L being L (a^2 + a b + b^2) / 3. */
  const sectionVolume = (nodes: ReadonlyArray<readonly [number, number]>): number => {
    let integral = 0;
    for (let k = 0; k + 1 < nodes.length; k++) {
      const [t0, a0] = nodes[k] as readonly [number, number];
      const [t1, a1] = nodes[k + 1] as readonly [number, number];
      integral += (20 * (t1 - t0) * (a0 * a0 + a0 * a1 + a1 * a1)) / 3;
    }
    return 1000 - (1 - Math.PI / 4) * integral;
  };
  const straightCases = [
    {
      label: 'linear law 1 -> 2 (VC-BLD-02)',
      law: { size: 1, sizeEnd: 2 },
      nodes: [
        [0, 1],
        [1, 2],
      ],
    },
    {
      label: 'kinked 1 / 2 / 1',
      law: { size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] },
      nodes: [
        [0, 1],
        [0.5, 2],
        [1, 1],
      ],
    },
    {
      label: 'off-centre kinks 1 / 2 / 1.5 / 1',
      law: {
        size: 1,
        sizeEnd: 1,
        sizes: [
          { t: 0.3, size: 2 },
          { t: 0.7, size: 1.5 },
        ],
      },
      nodes: [
        [0, 1],
        [0.3, 2],
        [0.7, 1.5],
        [1, 1],
      ],
    },
  ] as const;
  it.each(straightCases)(
    '$label: the exported code (graded nodes) reads the closed-form volume with the adaptive rule',
    ({ label, law, nodes }) => {
      const { doc, id } = block([{ near: [0, 5, 2.5], ...law, interpolation: 'linear' }]);
      const { text, summary } = exported(doc);
      expect(summary).not.toContain('BLD_CODEGEN_UNSUPPORTED');
      expect(summary).toContain('graded-node spline');
      const closed = sectionVolume(nodes);
      const python = runVolumes(text);
      const native = nativeVolume(doc, id);
      rows.push(
        `| ${label} | python adaptive ${python.adaptive.toFixed(6)} (${(Math.abs(python.adaptive - closed) / closed).toExponential(1)}), fixed ${python.fixed.toFixed(6)} | native ${native.toFixed(6)} (${(Math.abs(native - closed) / closed).toExponential(1)}) | closed ${closed.toFixed(6)} |`,
      );
      expect(Math.abs(native - closed) / closed).toBeLessThan(1e-9);
      // the graded nodes of the export: 3e-10 measured (adaptive rule); the fixed rule misreads the kinks by 1e-4
      expect(Math.abs(python.adaptive - closed) / closed).toBeLessThan(1e-8);
    },
  );

  it('control points 1 / 2 / 1 (smooth) run and equal the native volume', () => {
    const { doc, id } = block([{ near: [0, 5, 2.5], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] }]);
    const python = runVolume(exported(doc).text);
    rows.push(`| control points 1 / 2 / 1 (smooth) | python ${python.toFixed(6)} | native ${nativeVolume(doc, id).toFixed(6)} |`);
    expect(Math.abs(python - nativeVolume(doc, id))).toBeLessThan(1e-3);
  });

  it('an expression law 1 + 0.5 t runs and equals the native volume', () => {
    const { doc, id } = block([{ near: [0, 5, 2.5], law: { expression: '1 + 0.5*t', samples: 17 } }]);
    const python = runVolume(exported(doc).text);
    rows.push(`| expression 1 + 0.5 t | python ${python.toFixed(6)} | native ${nativeVolume(doc, id).toFixed(6)} |`);
    expect(Math.abs(python - nativeVolume(doc, id))).toBeLessThan(1e-3);
  });

  it('a conic profile export names BLD_CODEGEN_UNSUPPORTED and its mesh is the exact geometry', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const id = box.affected[0] as string;
    const done = execute(box.document, 'fillet_edge', { id, edgesNear: [[0, 5, 2.5]], radius: 1, profile: { type: 'conic', rho: 0.5 } });
    expect(done.affected).toHaveLength(1);
    const { text, summary } = exported(done.document);
    expect(summary).toContain('BLD_CODEGEN_UNSUPPORTED');
    expect(text).not.toContain('= fillet_laws(');
    expect(text).toContain('mesh([');
    const entity = done.document.entities[done.affected[0] as string] as MeshSolidEntity;
    const exact = nativeVolume(done.document, entity.id);
    expect(Math.abs(exact - 996.666667)).toBeLessThan(1e-3);
    // the code rebuilds the kernel's display mesh of the exact result, triangle for triangle ...
    const python = runVolume(text);
    rows.push(`| conic rho 0.5 | python mesh ${python.toFixed(6)} | native ${exact.toFixed(6)} |`);
    expect(Math.abs(python - meshVolume(entity))).toBeLessThan(1e-6 * exact);
    // ... which is the conic blend to the tessellation tolerance (chords of the arc), far from the unblended block (1000)
    expect(Math.abs(python - exact) / exact).toBeLessThan(2e-3);
  });
});
