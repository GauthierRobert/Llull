/**
 * DISP1: the native display mesh scales its deflection with the size of the part, and the fabrication exports re-tessellate at chordTolerance
 * (docs/design/06-variable-blends 13.15.3). A sphere of diameter 2000 (union with a box inside it, so it is a kernel result with an exact recipe).
 * Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

const RADIUS = 1000;
const AREA = 4 * Math.PI * RADIUS ** 2;
const VOLUME = (4 / 3) * Math.PI * RADIUS ** 3;
const DIAGONAL = 2 * RADIUS * Math.sqrt(3);

/** Signed volume of an indexed triangle mesh. */
function meshVolume(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const p = (corner: number): [number, number, number] => {
      const at = (indices[t + corner] as number) * 3;
      return [positions[at] as number, positions[at + 1] as number, positions[at + 2] as number];
    };
    const [pa, pb, pc] = [p(0), p(1), p(2)];
    total +=
      (pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])) / 6;
  }
  return total;
}

/** Volume of the triangles of an ASCII STL. */
function stlVolume(stl: string): number {
  const vertices = [...stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)].flatMap((match) => [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ]);
  return meshVolume(
    vertices,
    Array.from({ length: vertices.length / 3 }, (_, i) => i),
  );
}

describeNative('native display deflection scales with the part (DISP1)', () => {
  let kernel: IsolatedKernel;
  let doc: CadDocument;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
    let built = createEmptyDocument();
    built = execute(built, 'add_sphere', { radius: RADIUS }).document;
    built = execute(built, 'add_box', { size: [10, 10, 10] }).document;
    const union = execute(built, 'boolean', { op: 'union', a: built.order[0] as string, b: built.order[1] as string });
    expect(union.summary).toMatch(/^boolean/);
    expect(union.error).toBeUndefined();
    doc = union.document;
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const body = (): MeshSolidEntity => {
    const entity = Object.values(doc.entities).find((candidate) => candidate.kind === 'mesh');
    if (entity?.kind !== 'mesh') throw new Error('the union is not a kernel result');
    return entity;
  };

  it('honours explicit tessellation options (capability) and keeps the display mesh apart', () => {
    expect(kernel.honoursTessellationOptions).toBe(true);
    const shape = kernel.evaluate(body().brep as never);
    const display = kernel.tessellate(shape as never);
    const fine = kernel.tessellate(shape as never, { linearDeflection: 0.5, angularDeflection: 0.5 });
    expect((fine?.indices.length ?? 0) > 5 * (display?.indices.length ?? 1)).toBe(true);
    expect(kernel.tessellate(shape as never)?.indices.length).toBe(display?.indices.length);
  });

  it('the stored display mesh is bounded in triangles and within 1e-3 of the diagonal of the exact volume', () => {
    const { mesh } = body();
    expect(mesh.indices.length / 3).toBeLessThan(20_000);
    const deficit = VOLUME - meshVolume(mesh.positions, mesh.indices);
    expect(deficit).toBeGreaterThan(0);
    expect(deficit).toBeLessThanOrEqual(AREA * 1e-3 * DIAGONAL);
  });

  it('export_stl re-tessellates at chordTolerance: the exported volume is within area x tolerance of the exact one', () => {
    const result = execute(doc, 'export_stl', { chordTolerance: 0.5 });
    const data = result.data as { stl: string; triangleCount: number };
    expect(result.summary).toContain('re-tessellated by the exact kernel at chordTolerance 0.5');
    expect(data.triangleCount).toBeGreaterThan(body().mesh.indices.length / 3);
    const deficit = VOLUME - stlVolume(data.stl);
    expect(deficit).toBeGreaterThan(0);
    expect(deficit).toBeLessThanOrEqual(AREA * 0.5);
  }, 120_000);
});
