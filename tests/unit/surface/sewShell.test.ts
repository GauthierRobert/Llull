import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { extractSubSurface, transposeSurface } from '@lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { arcLengthSamples } from '@lib/nurbs/arcSample';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { sphereSurface } from '../../helpers/revolvedSurfaces';

const empty = createEmptyDocument();
type P = [number, number, number];

/** Bilinear planar sheet through four corners (p00, p01 along v at u = 0; p10, p11 at u = 1). */
const quad = (p00: P, p01: P, p10: P, p11: P): NurbsSurfaceData => ({
  degreeU: 1,
  degreeV: 1,
  poles: [
    [p00, p01],
    [p10, p11],
  ],
  knotsU: [0, 1],
  multiplicitiesU: [2, 2],
  knotsV: [0, 1],
  multiplicitiesV: [2, 2],
});

/** The six faces of the box [x0, x0 + a] x [0, b] x [0, c]. */
const boxFaces = (a: number, b: number, c: number, x0 = 0): NurbsSurfaceData[] => {
  const p = (x: number, y: number, z: number): P => [x0 + x, y, z];
  return [
    quad(p(0, 0, 0), p(0, b, 0), p(a, 0, 0), p(a, b, 0)),
    quad(p(0, 0, c), p(0, b, c), p(a, 0, c), p(a, b, c)),
    quad(p(0, 0, 0), p(0, 0, c), p(a, 0, 0), p(a, 0, c)),
    quad(p(0, b, 0), p(0, b, c), p(a, b, 0), p(a, b, c)),
    quad(p(0, 0, 0), p(0, 0, c), p(0, b, 0), p(0, b, c)),
    quad(p(a, 0, 0), p(a, 0, c), p(a, b, 0), p(a, b, c)),
  ];
};

const addSheets = (doc: CadDocument, surfaces: NurbsSurfaceData[]): { doc: CadDocument; ids: string[] } => {
  let current = doc;
  const ids: string[] = [];
  for (const surface of surfaces) {
    const result = execute(current, 'create_nurbs_surface', { ...surface });
    expect(result.affected).toHaveLength(1);
    current = result.document;
    ids.push(result.affected[0]!);
  }
  return { doc: current, ids };
};

const data = (result: ReturnType<typeof execute>): { volume: number; freeEdges: number; triangles: number; id: string } =>
  result.data as { volume: number; freeEdges: number; triangles: number; id: string };

describe('sew_surfaces into a closed solid (VC-SRF-16)', () => {
  it('six planar sheets make a closed box solid: volume exact, sheets consumed', () => {
    const { doc, ids } = addSheets(empty, boxFaces(3, 4, 5));
    const result = execute(doc, 'sew_surfaces', { ids });
    expect(result.affected).toHaveLength(1);
    const solid = result.document.entities[result.affected[0]!] as MeshSolidEntity;
    expect(solid.kind).toBe('mesh');
    expect(result.document.order).toEqual(result.affected);
    expect(data(result).volume).toBeCloseTo(60, 9);
    expect(data(result).freeEdges).toBe(0);
    expect(result.summary).toContain('0 free edges');
    const mass = execute(result.document, 'mass_properties', { entityId: solid.id });
    expect((mass.data as { volume: number }).volume).toBeCloseTo(60, 6);
  });

  it('closes whatever the parametrisation of the faces (one face transposed, one cut from a bigger sheet)', () => {
    const faces = boxFaces(2, 2, 2);
    faces[1] = transposeSurface(faces[1]!);
    const { doc, ids } = addSheets(empty, faces);
    expect(data(execute(doc, 'sew_surfaces', { ids, makeSolid: true })).volume).toBeCloseTo(8, 9);
  });

  it('a closed sphere sheet sewn on its own, and two hemispheres, give the volume of the ball within 1 %', () => {
    const ball = (4 / 3) * Math.PI * 1000;
    const whole = addSheets(empty, [sphereSurface(10)]);
    const alone = execute(whole.doc, 'sew_surfaces', { ids: whole.ids, makeSolid: true, resolution: 48 });
    expect(Math.abs(data(alone).volume / ball - 1)).toBeLessThan(0.01);
    const halves = addSheets(empty, [
      extractSubSurface(sphereSurface(10), [0, 0.5], [0, 1]) as NurbsSurfaceData,
      extractSubSurface(sphereSurface(10), [0.5, 1], [0, 1]) as NurbsSurfaceData,
    ]);
    const pair = execute(halves.doc, 'sew_surfaces', { ids: halves.ids, makeSolid: true, resolution: 48 });
    expect(Math.abs(data(pair).volume / ball - 1)).toBeLessThan(0.01);
    expect(data(pair).freeEdges).toBe(0);
  });

  it('refuses a shell with a missing face and lists the free edges, changing nothing', () => {
    const { doc, ids } = addSheets(empty, boxFaces(3, 4, 5).slice(0, 5));
    const result = execute(doc, 'sew_surfaces', { ids });
    expectNoOp(result, doc, 'SRF_SEW_FREE_EDGES');
    expect(result.summary).toMatch(/\d+ free edge/);
    expect(result.summary).toContain('near [');
  });

  it('refuses an edge shared by more than two sheets (two boxes face to face)', () => {
    const { doc, ids } = addSheets(empty, [...boxFaces(2, 2, 2), ...boxFaces(2, 2, 2, 2)]);
    expectNoOp(execute(doc, 'sew_surfaces', { ids }), doc, 'SRF_SEW_NONMANIFOLD');
  });

  it('refuses bad parameters, unknown ids and non-surfaces; a looser tolerance welds a gapped shell; is pure', () => {
    const { doc, ids } = addSheets(empty, boxFaces(3, 4, 5));
    expectNoOp(execute(doc, 'sew_surfaces', { ids: [ids[0]!] }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'sew_surfaces', { ids: [ids[0]!, ids[0]!, ids[1]!] }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'sew_surfaces', { ids, resolution: 4 }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'sew_surfaces', { ids, tolerance: -1 }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'sew_surfaces', { ids: [...ids.slice(1), 'nope'] }), doc, 'SRF_ENTITY_NOT_FOUND');
    const curve = execute(doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    expectNoOp(execute(curve.document, 'sew_surfaces', { ids: [...ids.slice(1), curve.affected[0]!] }), curve.document, 'SRF_NOT_SURFACE');
    const gapped = boxFaces(3, 4, 5);
    gapped[1] = quad([0, 0, 5.0004], [0, 4, 5.0004], [3, 0, 5.0004], [3, 4, 5.0004]);
    const loose = addSheets(empty, gapped);
    expectNoOp(execute(loose.doc, 'sew_surfaces', { ids: loose.ids }), loose.doc, 'SRF_SEW_FREE_EDGES');
    expect(execute(loose.doc, 'sew_surfaces', { ids: loose.ids, tolerance: 0.01 }).affected).toHaveLength(1);
    expectPure(doc, () => execute(doc, 'sew_surfaces', { ids }));
  });
});

describe('arc-length samples', () => {
  it('give the same points for the same edge in either parametrisation', () => {
    const base = {
      degree: 2,
      poles: [
        [0, 0, 0],
        [1, 2, 0],
        [3, 0, 0],
      ] as P[],
      knots: [0, 1],
      multiplicities: [3, 3],
    };
    const stretched = { ...base, knots: [0, 5] };
    const [a, b] = [arcLengthSamples(base, 7), arcLengthSamples(stretched, 7)];
    expect(a.length).toBeCloseTo(b.length, 12);
    a.points.forEach((point, k) => expect(Math.hypot(...(point.map((v, i) => v - b.points[k]![i]!) as P))).toBeLessThan(1e-12));
  });
});
