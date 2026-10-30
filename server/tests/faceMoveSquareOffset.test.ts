/**
 * DES-4c: `move_faces` offset of ONE planar face whose neighbours are all square to it (planes square to it, bores and bosses along its normal) takes the
 * prism path; any slanted neighbour keeps BRepOffset_MakeOffset. On the real native kernel. With LLULL_REFERENCE_KERNEL_BIN naming a kernel built BEFORE the
 * routing (whole-solid offset for everything), the routed result is compared with it: volume within 1e-9 relative, same face count, same face names
 * except that the faces keep their names instead of gaining `~offset`.
 */

import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createNativeKernel } from '../src/nativeKernel';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const referenceBinary = process.env['LLULL_REFERENCE_KERNEL_BIN'];
const context = (kernel: GeometryKernel): ExecutionContext => ({ ...defaultContext(), kernel });

interface Moved {
  readonly volume: number;
  readonly names: string[];
  readonly faces: number;
  readonly summary: string;
}

/** Offsets the face nearest to `near` by `distance` and reads the exact volume, the face count and the face names of the result on `kernel`. */
function offsetOn(kernel: GeometryKernel, doc: CadDocument, id: string, near: [number, number, number], distance: number): Moved {
  const moved = execute(doc, 'move_faces', { id, facesNear: [near], mode: 'offset', distance }, context(kernel));
  expect(moved.affected, moved.summary).toHaveLength(1);
  const entity = moved.document.entities[moved.affected[0] as string] as MeshSolidEntity;
  const shape = kernel.evaluate(entity.brep as never);
  const topology = kernel.topology(shape as never);
  return {
    volume: (moved.data as { volumeAfter: number }).volumeAfter,
    names: (topology?.faces ?? []).map((face) => face.name ?? '').sort(),
    faces: topology?.faces.length ?? 0,
    summary: moved.summary,
  };
}

function prism(kernel: GeometryKernel, profile: number[][], depth: number): { doc: CadDocument; id: string } {
  const made = execute(createEmptyDocument(), 'extrude_profile', { profile, depth }, context(kernel));
  expect(made.affected, made.summary).toHaveLength(1);
  return { doc: made.document, id: made.affected[0] as string };
}

const polygon = (sides: number): number[][] =>
  Array.from({ length: sides }, (_, i) => [20 * Math.cos((2 * Math.PI * i) / sides), 20 * Math.sin((2 * Math.PI * i) / sides)]);
const trapezoid = [
  [0, 0],
  [10, 0],
  [8, 10],
  [2, 10],
];

describeNative('offset of a planar face: the prism path against the whole-solid offset (DES-4c, native kernel)', () => {
  it('square neighbours: the exact result of a box top, a 24-gon prism top and a bore-through top, in and out', () => {
    const cases: Array<[string, number[][], [number, number, number], number]> = [
      [
        'box top out',
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        [5, 5, 10],
        2,
      ],
      [
        'box top in',
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        [5, 5, 10],
        -3,
      ],
      ['24-gon top out', polygon(24), [0, 0, 10], 1.5],
    ];
    for (const [label, profile, near, distance] of cases) {
      const { doc, id } = prism(kernels.occt, profile, 10);
      const routed = offsetOn(kernels.occt, doc, id, near, distance);
      const area = label.startsWith('box') ? 100 : (24 / 2) * 20 * 20 * Math.sin((2 * Math.PI) / 24);
      expect(Math.abs(routed.volume - area * (10 + distance)) / (area * (10 + distance)), label).toBeLessThan(1e-9);
      expect(routed.faces, label).toBe(label.startsWith('box') ? 6 : 26);
      expect(new Set(routed.names).size, `${label}: names stay distinct`).toBe(routed.faces);
      if (referenceBinary !== undefined) {
        const reference = createNativeKernel(referenceBinary, { callTimeoutMs: 120_000 });
        expect(reference.start()).toBe(true);
        try {
          const old = offsetOn(reference, prism(reference, profile, 10).doc, id, near, distance);
          expect(Math.abs(old.volume - routed.volume) / old.volume, `${label} volume`).toBeLessThan(1e-9);
          expect(routed.faces, `${label} faces`).toBe(old.faces);
          // the whole-solid offset renames EVERY face `<name>~offset`; the prism path keeps the names (the documented invariant: a moved face keeps its name), so the names equal the old ones without the suffix.
          expect(routed.names, `${label} names`).toEqual(old.names.map((name) => name.replace(/~offset$/, '')).sort());
          expect(
            old.names.every((name) => name.endsWith('~offset')),
            label,
          ).toBe(true);
        } finally {
          reference.dispose();
        }
      }
    }
  }, 180_000);

  it('a slanted neighbour keeps the whole-solid offset: a trapezoid wall moves to the offset line (closed form)', () => {
    const { doc, id } = prism(kernels.occt, trapezoid, 10);
    const distance = 1;
    const moved = offsetOn(kernels.occt, doc, id, [9, 5, 5], distance);
    // the right wall runs (10,0) -> (8,10), outward normal (10, 2) / |.|; the offset line meets y = 0 and y = 10
    const [nx, ny] = [10 / Math.hypot(10, 2), 2 / Math.hypot(10, 2)];
    const xAt = (y: number): number => (nx * 10 + ny * 0 + distance - ny * y) / nx;
    const polygonArea = (pts: number[][]): number =>
      Math.abs(
        pts.reduce(
          (s, p, i) =>
            s + (p[0] as number) * (pts[(i + 1) % pts.length]![1] as number) - (pts[(i + 1) % pts.length]![0] as number) * (p[1] as number),
          0,
        ),
      ) / 2;
    const expected =
      polygonArea([
        [0, 0],
        [xAt(0), 0],
        [xAt(10), 10],
        [2, 10],
      ]) * 10;
    expect(Math.abs(moved.volume - expected) / expected).toBeLessThan(1e-9);
    expect(moved.faces).toBe(6);
  }, 180_000);

  it('the preview flag skips the volume report and the topology note and builds the same solid', () => {
    const { doc, id } = prism(kernels.occt, trapezoid, 10);
    const full = execute(doc, 'move_faces', { id, facesNear: [[5, 5, 10]], mode: 'offset', distance: 1 }, context(kernels.occt));
    const dry = execute(
      doc,
      'move_faces',
      { id, facesNear: [[5, 5, 10]], mode: 'offset', distance: 1, preview: true },
      context(kernels.occt),
    );
    expect(full.data).toMatchObject({ volumeUnit: 'mm^3' });
    expect(full.summary).toContain('Volume');
    expect(full.summary).toContain('Exact B-rep kept');
    expect(dry.data).toBeUndefined();
    expect(dry.summary).not.toContain('Volume');
    expect(dry.summary).not.toContain('Exact B-rep kept');
    const [a, b] = [full, dry].map((r) => r.document.entities[r.affected[0] as string] as MeshSolidEntity);
    expect(b?.mesh.indices.length).toBe(a?.mesh.indices.length);
  }, 180_000);
});
