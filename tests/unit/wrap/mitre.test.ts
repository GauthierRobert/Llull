/**
 * 03 WRP mitred walls across a sharp edge (spec §14.15) on the stub kernel with a pair of plane faces (`fakeSplitKernel`, option `corner`): the corner filler of an emboss on a convex edge and of a
 * deboss on a concave edge, the overlap of the other two cases, other dihedral angles, and every refusal by name. The exact volumes are proved on the native kernel in server/tests/nativeWrapMitre.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { CadDocument, Vec2 } from '@core/model/types';
import { fakeSplitKernel, type FakeSplitOptions } from '../../helpers/fakeSplitKernel';
import { emptyDoc, make, type Made } from './support';

type Run = ReturnType<typeof execute>;
type Mitre = {
  reasons: string[];
  fillerVolume: number;
  overlapVolume: number;
  exact: boolean;
  edges: Array<{ kind: string; intervals: number; length: number; area: number }>;
};
afterEach(() => setGeometryKernel(null));

const quadArea = (theta: number, depth: number): number => {
  const nB: Vec2 = [Math.cos(theta), Math.sin(theta)];
  const k = depth / (1 + nB[1]);
  const quad: Vec2[] = [
    [0, 0],
    [0, depth],
    [k * nB[0], k * (1 + nB[1])],
    [depth * nB[0], depth * nB[1]],
  ];
  return Math.abs(quad.reduce((sum, p, i) => sum + p[0] * (quad[(i + 1) % 4] as Vec2)[1] - (quad[(i + 1) % 4] as Vec2)[0] * p[1], 0) / 2);
};

const rectangle = (doc: CadDocument): Made => make(doc, 'draw_rectangle', { width: 8, height: 6, position: [-4, -3, 0] });
const slanted = (doc: CadDocument): Made =>
  make(doc, 'draw_polyline', {
    points: [
      [-4, -3],
      [4, -2],
      [4, 3],
      [-4, 2],
    ],
    closed: true,
  });

function runMany(options: FakeSplitOptions, mode: string, sketch: (doc: CadDocument) => { doc: CadDocument; ids: string[] }): Run {
  setGeometryKernel(fakeSplitKernel(options));
  const solid = make(emptyDoc(), 'add_box', { size: [60, 40, 10] });
  const drawn = sketch(solid.doc);
  return execute(drawn.doc, 'emboss_on_face', {
    id: solid.id,
    face: { faceIndex: 0 },
    chain: [{ faceIndex: 1 }],
    profileIds: drawn.ids,
    mode,
    depth: 1,
    placement: { method: 'develop', anchor: { chart: [0, 0], on: [0, 0, 0] } },
  });
}
const run = (options: FakeSplitOptions, mode: string, sketch: (doc: CadDocument) => Made = rectangle): Run =>
  runMany(options, mode, (doc) => {
    const drawn = sketch(doc);
    return { doc: drawn.doc, ids: [drawn.id] };
  });
const rectangleAt = (doc: CadDocument, x: number, width: number): Made =>
  make(doc, 'draw_rectangle', { width, height: 6, position: [x, -3, 0] });
const mitre = (result: Run): Mitre => (result.data as unknown as { mitre: Mitre }).mitre;
const data = (result: Run): { volumeDelta: number; expectedVolumeDelta: number | null } =>
  result.data as unknown as { volumeDelta: number; expectedVolumeDelta: number | null };
const recipeOf = (result: Run): string => JSON.stringify(result.document.entities[result.affected[0] as string]);

describe('emboss_on_face across a sharp edge: the mitre', () => {
  it('emboss on a convex edge fills the corner column: 48 d + d^2 L = 54, the filler is a prism along the edge over the 6 the rectangle covers', () => {
    const done = run({ corner: { convexity: 'convex' } }, 'emboss');
    expect(done.rejected, done.summary).toBeUndefined();
    expect(mitre(done)).toMatchObject({ fillerVolume: 6, overlapVolume: 0, exact: true });
    expect(mitre(done).edges[0]).toMatchObject({ kind: 'filler', intervals: 1 });
    expect(mitre(done).edges[0]?.length).toBeCloseTo(6, 9);
    expect(mitre(done).edges[0]?.area).toBeCloseTo(1, 9);
    expect(data(done).expectedVolumeDelta).toBeCloseTo(54, 9);
    expect(recipeOf(done)).toContain('mitre-0.1');
  });

  it('deboss on a concave edge cuts the corner column away: -(48 d + d^2 L) = -54', () => {
    const done = run({ corner: { convexity: 'concave' } }, 'deboss');
    expect(done.rejected, done.summary).toBeUndefined();
    expect(mitre(done)).toMatchObject({ fillerVolume: 6, exact: true });
    expect(data(done).expectedVolumeDelta).toBeCloseTo(-54, 9);
    expect(recipeOf(done)).toContain('mitre-0.1');
  });

  it('the other two cases need no filler: the slabs overlap by the column (emboss on a concave edge 42, deboss on a convex edge -42)', () => {
    const concave = run({ corner: { convexity: 'concave' } }, 'emboss');
    expect(mitre(concave)).toMatchObject({ fillerVolume: 0, exact: true });
    expect(mitre(concave).overlapVolume).toBeCloseTo(6, 9);
    expect(data(concave).expectedVolumeDelta).toBeCloseTo(42, 9);
    const convex = run({ corner: { convexity: 'convex' } }, 'deboss');
    expect(mitre(convex).overlapVolume).toBeCloseTo(6, 9);
    expect(data(convex).expectedVolumeDelta).toBeCloseTo(-42, 9);
    expect(recipeOf(convex)).not.toContain('mitre-0');
  });

  it('another dihedral angle: the cross-section of the filler is the quadrilateral (edge, d nA, M, d nB)', () => {
    const done = run({ corner: { convexity: 'convex', theta: Math.PI / 6 } }, 'emboss');
    expect(done.rejected, done.summary).toBeUndefined();
    expect(mitre(done).edges[0]?.area).toBeCloseTo(quadArea(Math.PI / 6, 1), 9);
    expect(mitre(done).fillerVolume).toBeCloseTo(6 * quadArea(Math.PI / 6, 1), 9);
  });

  it('refuses by name what it cannot mitre: an oblique crossing, a vertex on the edge, a curved outline, an unknown convexity, an edge too sharp; scribe crosses freely', () => {
    const oblique = run({ corner: { convexity: 'convex' } }, 'emboss', slanted);
    expect(oblique.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(oblique.summary).toContain('at an angle');
    const vertex = run({ corner: { convexity: 'convex' } }, 'emboss', (doc) =>
      make(doc, 'draw_polyline', {
        points: [
          [-3, 0],
          [0, 3],
          [3, 0],
          [0, -3],
        ],
        closed: true,
      }),
    );
    expect(vertex.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(vertex.summary).toContain('vertex');
    const round = run({ corner: { convexity: 'convex' } }, 'emboss', (doc) => make(doc, 'draw_arc', { center: [0, 0], radius: 3 }));
    expect(round.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(round.summary).toContain('curved piece');
    const unknown = run({ corner: { convexity: 'unknown' } }, 'emboss');
    expect(unknown.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(unknown.summary).toContain('convex or concave');
    const sharp = run({ corner: { convexity: 'convex', theta: -Math.PI / 2 + 0.02 } }, 'emboss');
    expect(sharp.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(sharp.summary).toContain('sharper');
    const scribed = run({ corner: { convexity: 'convex' } }, 'scribe');
    expect(scribed.error).toBeUndefined();
    expect(scribed.data).not.toHaveProperty('mitre');
  });

  it('an oblique crossing where the slabs overlap anyway is built, without a closed-form volume', () => {
    const done = run({ corner: { convexity: 'convex' } }, 'deboss', slanted);
    expect(done.rejected, done.summary).toBeUndefined();
    expect(mitre(done).exact).toBe(false);
    expect(data(done).expectedVolumeDelta).toBeNull();
  });

  it('the filler sits on the side of the offset planes: the profile of an emboss on a convex edge has M = +(1, 1) d, a deboss on a concave edge M = -(1, 1) d (the sign of s)', () => {
    const profileOf = (result: Run): number[][] => JSON.parse(/"profile":(\[\[.*?\]\])/.exec(recipeOf(result))?.[1] ?? '[]') as number[][];
    const emboss = profileOf(run({ corner: { convexity: 'convex' } }, 'emboss'));
    const deboss = profileOf(run({ corner: { convexity: 'concave' } }, 'deboss'));
    expect(emboss.some(([x, y]) => Math.abs((x as number) - 1) < 1e-9 && Math.abs((y as number) - 1) < 1e-9)).toBe(true);
    expect(deboss.some(([x, y]) => Math.abs((x as number) + 1) < 1e-9 && Math.abs((y as number) + 1) < 1e-9)).toBe(true);
    expect(emboss.some(([x]) => (x as number) < -1e-9)).toBe(false);
    expect(deboss.some(([x]) => (x as number) > 1e-9)).toBe(false);
  });

  it('an outline that does not reach the overlap of the slabs makes the closed form inexact: a 1.5 wide rectangle across a concave edge (overlap reach 1), and two rectangles 0.2 off the edge', () => {
    const narrow = run({ corner: { convexity: 'concave' } }, 'emboss', (doc) => rectangleAt(doc, -0.5, 1.5));
    expect(narrow.rejected, narrow.summary).toBeUndefined();
    expect(mitre(narrow).exact).toBe(false);
    expect(data(narrow).expectedVolumeDelta).toBeNull();
    expect(narrow.summary).toContain('overlap not in the closed form');
    const wide = run({ corner: { convexity: 'concave' } }, 'emboss', (doc) => rectangleAt(doc, -1.5, 3));
    expect(mitre(wide).exact).toBe(true);
    const beside = runMany({ corner: { convexity: 'concave' } }, 'emboss', (doc) => {
      const a = rectangleAt(doc, -4, 3.8);
      const b = rectangleAt(a.doc, 0.2, 3.8);
      return { doc: b.doc, ids: [a.id, b.id] };
    });
    expect(beside.rejected, beside.summary).toBeUndefined();
    expect(mitre(beside).exact).toBe(false);
    expect(mitre(beside).reasons.join(' ')).toContain('without crossing');
    expect(data(beside).expectedVolumeDelta).toBeNull();
    // a filler is a column outside both slabs: a narrow outline still gets it (1.5 x 6 + the column 1 x 6 = 15)
    const column = run({ corner: { convexity: 'convex' } }, 'emboss', (doc) => rectangleAt(doc, -0.5, 1.5));
    expect(mitre(column).exact).toBe(true);
    expect(data(column).expectedVolumeDelta).toBeCloseTo(15, 9);
  });

  it('the other refusals: a face with no normal at the edge, and an odd number of crossings (the outline ends beyond a shorter edge)', () => {
    const blind = run({ corner: { convexity: 'convex', noNormal: 0 } }, 'emboss');
    expect(blind.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(blind.summary).toContain('no normal');
    // the edge is 10 long (y in -5..5): the rectangle y -3..8 crosses its line at -3 and 8, only the first is on the edge
    const odd = run({ corner: { convexity: 'convex', edgeHalf: 5 } }, 'emboss', (doc) =>
      make(doc, 'draw_rectangle', { width: 8, height: 11, position: [-4, -3, 0] }),
    );
    expect(odd.error?.code).toBe('WRP_CHAIN_EDGE_SHARP');
    expect(odd.summary).toContain('odd number');
    const inside = run({ corner: { convexity: 'convex', edgeHalf: 5 } }, 'emboss', (doc) =>
      make(doc, 'draw_rectangle', { width: 8, height: 4, position: [-4, -2, 0] }),
    );
    expect(inside.error, inside.summary).toBeUndefined();
  });

  it('where only an overlap is concerned a vertex on the edge or a curved piece crossing it is built without a closed form', () => {
    const diamond = run({ corner: { convexity: 'convex' } }, 'deboss', (doc) =>
      make(doc, 'draw_polyline', {
        points: [
          [-3, 0],
          [0, 3],
          [3, 0],
          [0, -3],
        ],
        closed: true,
      }),
    );
    expect(mitre(diamond).exact).toBe(false);
    expect(mitre(diamond).reasons.join(' ')).toContain('vertex');
    const round = run({ corner: { convexity: 'convex' } }, 'deboss', (doc) => make(doc, 'draw_arc', { center: [0, 0], radius: 3 }));
    expect(mitre(round).exact).toBe(false);
    expect(mitre(round).reasons.join(' ')).toContain('curved piece');
  });
});
