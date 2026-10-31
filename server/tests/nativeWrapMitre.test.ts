/**
 * 03 WRP mitred walls across a sharp edge on the native OCCT kernel (spec §14.15). A rectangle 8 x 6 centred on the 40 long edge of a box (convex) or of an L-shaped solid (concave) crosses it at
 * right angles; the slabs of the two faces are built face by face and the corner column is a prism along the edge: area A = 48 and d = 1 give 48 d + d^2 x 6 = 54 for an emboss on the convex edge
 * (the column filled) and 48 d - d^2 x 6 = 42 for an emboss on the concave edge (the slabs overlap by the column); a deboss mirrors them. Skipped without the llull-kernel binary (with `emboss`).
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

vi.setConfig({ testTimeout: 280_000 });
type Run = ReturnType<typeof execute>;
type Row = Record<string, unknown>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP mitre' })('WRP mitred walls across a sharp edge (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const base = (): CadDocument => ({ ...createEmptyDocument(), units: 'mm' });
  const must = (doc: CadDocument, name: string, params: Row): Run => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    return result;
  };
  const solidOf = (done: Run): string => done.affected.find((id) => done.document.entities[id]?.kind !== 'nurbs_curve') as string;

  /** A box 60 x 40 x 10 about the origin: top z = 5, side x = 30, the convex edge along y at (30, z = 5). */
  const box = (): { doc: CadDocument; id: string } => {
    const made = must(base(), 'add_box', { size: [60, 40, 10] });
    return { doc: made.document, id: made.affected[0] as string };
  };
  /** The same box with a block 20 x 40 x 10 on its right: the floor z = 5 meets the wall x = 10 along y in a concave edge. */
  const stepped = (): { doc: CadDocument; id: string } => {
    const low = box();
    const block = must(low.doc, 'add_box', { size: [20, 40, 10], position: [20, 0, 10] });
    const joined = must(block.document, 'boolean', { op: 'union', a: low.id, b: block.affected[0] });
    return { doc: joined.document, id: joined.affected[0] as string };
  };
  const rectangle = (doc: CadDocument): { doc: CadDocument; id: string } => {
    const made = must(doc, 'draw_rectangle', { width: 8, height: 6, position: [-4, -3, 0] });
    return { doc: made.document, id: made.affected[0] as string };
  };

  const run = (solid: { doc: CadDocument; id: string }, onTop: number[], onSide: number[], at: number[], mode: string): Run => {
    const sketch = rectangle(solid.doc);
    return must(sketch.doc, 'emboss_on_face', {
      id: solid.id,
      face: { faceNear: onTop },
      chain: [{ faceNear: onSide }],
      profileIds: [sketch.id],
      mode,
      depth: 1,
      placement: { method: 'develop', anchor: { chart: [0, 0], on: at } },
    });
  };

  it('emboss on a convex edge: the corner column is filled, 48 d + d^2 L = 54', () => {
    const done = run(box(), [28, 0, 5], [30, 0, 3], [30, 0, 5], 'emboss');
    const data = done.data as {
      volumeDelta: number;
      expectedVolumeDelta: number;
      mitre: { fillerVolume: number; exact: boolean; edges: Array<{ kind: string; length: number }> };
    };
    expect(data.mitre.edges).toEqual([expect.objectContaining({ kind: 'filler', length: expect.closeTo(6, 9) as number })]);
    expect(data.mitre.fillerVolume).toBeCloseTo(6, 9);
    expect(relative(data.volumeDelta, 54)).toBeLessThan(1e-5);
    expect(relative(data.expectedVolumeDelta, 54)).toBeLessThan(1e-9);
    expect(solidOf(done)).toBeDefined();
  });

  it('deboss on a convex edge: the pockets overlap in the column, so the removed volume is 48 d - d^2 L = 42', () => {
    const done = run(box(), [28, 0, 5], [30, 0, 3], [30, 0, 5], 'deboss');
    const data = done.data as { volumeDelta: number; expectedVolumeDelta: number; mitre: { overlapVolume: number; fillerVolume: number } };
    expect(data.mitre.fillerVolume).toBe(0);
    expect(data.mitre.overlapVolume).toBeCloseTo(6, 9);
    expect(relative(data.volumeDelta, -42)).toBeLessThan(1e-5);
    expect(relative(data.expectedVolumeDelta, -42)).toBeLessThan(1e-9);
  });

  it('emboss on a concave edge: the slabs overlap (42); deboss on it: the corner column is cut away (54)', () => {
    const emboss = run(stepped(), [8, 0, 5], [10, 0, 8], [10, 0, 5], 'emboss');
    const e = emboss.data as { volumeDelta: number; expectedVolumeDelta: number; mitre: { fillerVolume: number } };
    expect(e.mitre.fillerVolume).toBe(0);
    expect(relative(e.volumeDelta, 42)).toBeLessThan(1e-5);
    expect(relative(e.expectedVolumeDelta, 42)).toBeLessThan(1e-9);
    const deboss = run(stepped(), [8, 0, 5], [10, 0, 8], [10, 0, 5], 'deboss');
    const d = deboss.data as { volumeDelta: number; expectedVolumeDelta: number; mitre: { fillerVolume: number } };
    expect(d.mitre.fillerVolume).toBeCloseTo(6, 9);
    expect(relative(d.volumeDelta, -54)).toBeLessThan(1e-5);
    expect(relative(d.expectedVolumeDelta, -54)).toBeLessThan(1e-9);
  });

  it('an outline that meets the edge at an angle is refused by name where a filler is needed, and built (no closed form) where the slabs overlap', () => {
    const solid = box();
    const slanted = must(solid.doc, 'draw_polyline', {
      points: [
        [-4, -3],
        [4, -2],
        [4, 3],
        [-4, 2],
      ],
      closed: true,
    });
    const params = {
      id: solid.id,
      face: { faceNear: [28, 0, 5] },
      chain: [{ faceNear: [30, 0, 3] }],
      profileIds: [slanted.affected[0]],
      depth: 1,
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [30, 0, 5] } },
    };
    const refused = execute(slanted.document, 'emboss_on_face', { ...params, mode: 'emboss' });
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(refused.summary).toContain('at an angle');
    const overlapping = must(slanted.document, 'emboss_on_face', { ...params, mode: 'deboss' });
    expect((overlapping.data as { expectedVolumeDelta: unknown }).expectedVolumeDelta).toBeNull();
  });
});
