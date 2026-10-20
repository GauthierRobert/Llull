import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type NurbsSurfaceEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { sheetTriangles, tessellateSheet } from '@core/geometry/nurbsSurface';
import { sheetArea } from '@core/geometry/sheetArea';
import { collectExportTriangles } from '@core/geometry/entityTriangles';
import { domainLoop, insideRegion, trimmedArea } from '@lib/nurbs/trimRegion';
import { surfaceTriangles } from '@core/geometry/nurbsSurface';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cylinderSurface, sphereSurface } from '../../helpers/revolvedSurfaces';

const empty = createEmptyDocument();
const SQRT_HALF = Math.SQRT1_2;

/** Planar [0, side] x [0, side] sheet, bilinear (degrees 1 x 1). */
const plane = (side: number): NurbsSurfaceData => ({
  degreeU: 1,
  degreeV: 1,
  poles: [
    [
      [0, 0, 0],
      [0, side, 0],
    ],
    [
      [side, 0, 0],
      [side, side, 0],
    ],
  ],
  knotsU: [0, 1],
  multiplicitiesU: [2, 2],
  knotsV: [0, 1],
  multiplicitiesV: [2, 2],
});

const addSheet = (doc: CadDocument, surface: NurbsSurfaceData): { doc: CadDocument; id: string } => {
  const result = execute(doc, 'create_nurbs_surface', { ...surface });
  expect(result.affected).toHaveLength(1);
  return { doc: result.document, id: result.affected[0]! };
};

/** Exact circle (nine-pole rational quadratic) of radius `r` about [cx, cy, z]. */
const circleParams = (cx: number, cy: number, z: number, r: number): Record<string, unknown> => ({
  degree: 2,
  poles: [
    [cx + r, cy, z],
    [cx + r, cy + r, z],
    [cx, cy + r, z],
    [cx - r, cy + r, z],
    [cx - r, cy, z],
    [cx - r, cy - r, z],
    [cx, cy - r, z],
    [cx + r, cy - r, z],
    [cx + r, cy, z],
  ],
  weights: [1, SQRT_HALF, 1, SQRT_HALF, 1, SQRT_HALF, 1, SQRT_HALF, 1],
  knots: [0, 0.25, 0.5, 0.75, 1],
  multiplicities: [3, 2, 2, 2, 3],
});

const addCurve = (doc: CadDocument, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
  const result = execute(doc, 'create_nurbs_curve', params);
  expect(result.affected).toHaveLength(1);
  return { doc: result.document, id: result.affected[0]! };
};

const trimData = (result: ReturnType<typeof execute>): { area: number; untrimmedArea: number; loops: number } =>
  result.data as { area: number; untrimmedArea: number; loops: number };

describe('trim_surface by curves (VC-SRF-23)', () => {
  const sheet = addSheet(empty, plane(10));
  const circle = addCurve(sheet.doc, circleParams(5, 5, 0, 3));

  it('trims a planar 10 x 10 sheet by a circle r = 3 keeping the inside: area pi r^2 to 1e-6', () => {
    const result = execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id], keep: 'inside' });
    expect(result.affected).toEqual([sheet.id]);
    expect(trimData(result).area).toBeCloseTo(28.274334, 6);
    expect(trimData(result).untrimmedArea).toBeCloseTo(100, 9);
    expect(result.document.order).toEqual(circle.doc.order);
    const entity = result.document.entities[sheet.id] as NurbsSurfaceEntity;
    expect(entity.trims).toHaveLength(1);
    expect(entity.surface).toBe((circle.doc.entities[sheet.id] as NurbsSurfaceEntity).surface);
    const measured = execute(result.document, 'measure_area', { entityId: sheet.id });
    expect((measured.data as { area: number }).area).toBeCloseTo(28.274334, 6);
    expect(sheetArea(entity)).toBeCloseTo(Math.PI * 9, 6);
  });

  it('keeping the outside leaves a hole: 100 - pi r^2; the display mesh covers the trimmed region', () => {
    const inside = execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id] });
    const outside = execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id], keep: 'outside' });
    expect(trimData(outside).area).toBeCloseTo(100 - Math.PI * 9, 6);
    expect(trimData(outside).loops).toBe(2);
    const meshArea = (doc: CadDocument): number =>
      sheetTriangles(doc.entities[sheet.id] as NurbsSurfaceEntity).reduce((sum, [a, b, c]) => {
        const [ux, uy, uz, vx, vy, vz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2], c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        return sum + Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }, 0);
    expect(meshArea(inside.document)).toBeCloseTo(Math.PI * 9, 0);
    expect(Math.abs(meshArea(inside.document) / (Math.PI * 9) - 1)).toBeLessThan(0.01);
    expect(Math.abs(meshArea(outside.document) / (100 - Math.PI * 9) - 1)).toBeLessThan(0.01);
    const exported = collectExportTriangles(inside.document, undefined);
    expect(exported.tris.length).toBeGreaterThan(50);
  });

  it('projects along a direction (the circle floats above the sheet) and refuses a direction that misses', () => {
    const high = addCurve(sheet.doc, circleParams(5, 5, 4, 3));
    const along = execute(high.doc, 'trim_surface', { id: sheet.id, curveIds: [high.id], projectAlong: [0, 0, -1] });
    expect(trimData(along).area).toBeCloseTo(Math.PI * 9, 6);
    expect(along.summary).toContain('trimmed area');
    const closest = execute(high.doc, 'trim_surface', { id: sheet.id, curveIds: [high.id] });
    expect(trimData(closest).area).toBeCloseTo(Math.PI * 9, 6);
    expectNoOp(
      execute(high.doc, 'trim_surface', { id: sheet.id, curveIds: [high.id], projectAlong: [1, 0, 0] }),
      high.doc,
      'SRF_TRIM_MISS',
    );
  });

  it('an open curve floating above the sheet and carried down along projectAlong cuts it (the ray misses beyond the edges)', () => {
    const line = addCurve(sheet.doc, {
      degree: 1,
      poles: [
        [-2, 3, 4],
        [12, 3, 4],
      ],
    });
    const cut = execute(line.doc, 'trim_surface', { id: sheet.id, curveIds: [line.id], projectAlong: [0, 0, -1], keepPoint: [5, 1, 0] });
    expect(trimData(cut).area).toBeCloseTo(30, 6);
    expectNoOp(
      execute(line.doc, 'trim_surface', { id: sheet.id, curveIds: [line.id], projectAlong: [0, 1, 0], keepPoint: [5, 1, 0] }),
      line.doc,
      'SRF_TRIM_MISS',
    );
  });

  it('an open curve across the sheet cuts it in two and keepPoint chooses the side (exact area 50)', () => {
    const line = addCurve(sheet.doc, {
      degree: 1,
      poles: [
        [-2, 3, 0],
        [12, 3, 0],
      ],
    });
    const below = execute(line.doc, 'trim_surface', { id: sheet.id, curveIds: [line.id], keepPoint: [5, 1, 0] });
    expect(trimData(below).area).toBeCloseTo(30, 6);
    const above = execute(line.doc, 'trim_surface', { id: sheet.id, curveIds: [line.id], keepPoint: [5, 8, 0] });
    expect(trimData(above).area).toBeCloseTo(70, 6);
    const entity = above.document.entities[sheet.id] as NurbsSurfaceEntity;
    expect(insideRegion(entity.trims!, [0.5, 0.9])).toBe(true);
    expect(insideRegion(entity.trims!, [0.5, 0.1])).toBe(false);
    const diagonal = addCurve(sheet.doc, {
      degree: 1,
      poles: [
        [-1, -1, 0],
        [11, 11, 0],
      ],
    });
    expect(
      trimData(execute(diagonal.doc, 'trim_surface', { id: sheet.id, curveIds: [diagonal.id], keepPoint: [8, 2, 0] })).area,
    ).toBeCloseTo(50, 6);
  });

  it('a second closed curve adds a hole; overlaps and rectangle cuts of a trimmed sheet are refused', () => {
    const small = addCurve(circle.doc, circleParams(8.5, 8.5, 0, 1));
    const first = execute(small.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id], keep: 'outside' });
    const second = execute(first.document, 'trim_surface', { id: sheet.id, curveIds: [small.id], keep: 'outside' });
    expect(trimData(second).area).toBeCloseTo(100 - Math.PI * 9 - Math.PI, 6);
    expect((second.document.entities[sheet.id] as NurbsSurfaceEntity).trims).toHaveLength(3);
    const crossing = addCurve(first.document, circleParams(7.5, 5, 0, 1.5));
    expectNoOp(
      execute(crossing.doc, 'trim_surface', { id: sheet.id, curveIds: [crossing.id], keep: 'outside' }),
      crossing.doc,
      'SRF_TRIM_UNSUPPORTED',
    );
    expectNoOp(
      execute(first.document, 'trim_surface', { id: sheet.id, curveIds: [small.id], keep: 'inside' }),
      first.document,
      'SRF_TRIM_UNSUPPORTED',
    );
    expectNoOp(execute(first.document, 'trim_surface', { id: sheet.id, u: [0, 0.5], v: [0, 1] }), first.document, 'SRF_TRIM_UNSUPPORTED');
    expectNoOp(execute(first.document, 'thicken_surface', { id: sheet.id, thickness: 1 }), first.document, 'SRF_TRIM_UNSUPPORTED');
    const other = addSheet(first.document, plane(10));
    expectNoOp(execute(other.doc, 'sew_surfaces', { ids: [sheet.id, other.id] }), other.doc, 'SRF_TRIM_UNSUPPORTED');
  });

  it('refuses unusable curves, missing keep information and bad parameters without changing the document', () => {
    const partly = addCurve(sheet.doc, circleParams(9, 5, 0, 3));
    expectNoOp(execute(partly.doc, 'trim_surface', { id: sheet.id, curveIds: [partly.id] }), partly.doc, 'SRF_TRIM_MISS');
    const line = addCurve(sheet.doc, {
      degree: 1,
      poles: [
        [-2, 3, 0],
        [12, 3, 0],
      ],
    });
    expectNoOp(execute(line.doc, 'trim_surface', { id: sheet.id, curveIds: [line.id] }), line.doc, 'SRF_TRIM_AMBIGUOUS');
    const inner = addCurve(sheet.doc, {
      degree: 1,
      poles: [
        [2, 3, 0],
        [8, 3, 0],
      ],
    });
    expectNoOp(
      execute(inner.doc, 'trim_surface', { id: sheet.id, curveIds: [inner.id], keepPoint: [5, 1, 0] }),
      inner.doc,
      'SRF_TRIM_LOOP_INVALID',
    );
    const apart = addCurve(inner.doc, {
      degree: 1,
      poles: [
        [20, 20, 0],
        [22, 20, 0],
      ],
    });
    expectNoOp(
      execute(apart.doc, 'trim_surface', { id: sheet.id, curveIds: [inner.id, apart.id], keepPoint: [5, 1, 0] }),
      apart.doc,
      'SRF_TRIM_LOOP_INVALID',
    );
    expectNoOp(execute(circle.doc, 'trim_surface', { id: sheet.id }), circle.doc, 'SRF_PARAM_INVALID');
    expectNoOp(
      execute(circle.doc, 'trim_surface', { id: sheet.id, u: [0, 1], v: [0, 1], curveIds: [circle.id] }),
      circle.doc,
      'SRF_PARAM_INVALID',
    );
    expectNoOp(
      execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id], projectAlong: [0, 0, 0] }),
      circle.doc,
      'SRF_PARAM_INVALID',
    );
    expectNoOp(execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [] }), circle.doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: ['nope'] }), circle.doc, 'SRF_ENTITY_NOT_FOUND');
    expectNoOp(execute(circle.doc, 'trim_surface', { id: circle.id, curveIds: [circle.id] }), circle.doc, 'SRF_NOT_SURFACE');
    expectNoOp(execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [sheet.id] }), circle.doc, 'SRF_NOT_NURBS');
    expectNoOp(
      execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id], tolerance: -1 }),
      circle.doc,
      'SRF_PARAM_INVALID',
    );
  });

  it('trims by a chain of curves forming a closed square, in any order and orientation', () => {
    const edge = (a: number[], b: number[]): Record<string, unknown> => ({ degree: 1, poles: [a, b] });
    let doc = sheet.doc;
    const ids: string[] = [];
    for (const [a, b] of [
      [
        [2, 2, 0],
        [6, 2, 0],
      ],
      [
        [6, 6, 0],
        [6, 2, 0],
      ],
      [
        [6, 6, 0],
        [2, 6, 0],
      ],
      [
        [2, 2, 0],
        [2, 6, 0],
      ],
    ] as const) {
      const made = addCurve(doc, edge([...a], [...b]));
      doc = made.doc;
      ids.push(made.id);
    }
    expect(trimData(execute(doc, 'trim_surface', { id: sheet.id, curveIds: ids })).area).toBeCloseTo(16, 9);
  });

  it('survives save / load, and the guard rejects malformed trims', () => {
    const trimmed = execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id] });
    const loaded = deserializeDocument(serializeDocument(trimmed.document));
    const entity = loaded.entities[sheet.id] as NurbsSurfaceEntity;
    expect(sheetArea(entity)).toBeCloseTo(Math.PI * 9, 6);
    const stored = JSON.parse(JSON.stringify(trimmed.document.entities[sheet.id])) as Record<string, unknown>;
    expect(validateEntityValue(stored)).toBeNull();
    for (const bad of [
      { outer: 1, polygon: [] },
      { outer: true, polygon: [[0, 0]] },
      {
        outer: true,
        polygon: [
          [0, 0],
          [1, 1],
          [1, 'x'],
        ],
      },
    ]) {
      expect(validateEntityValue({ ...stored, trims: [bad] })).not.toBeNull();
    }
    expect(validateEntityValue({ ...stored, trims: 'x' })).not.toBeNull();
  });

  it('is pure', () => {
    expectPure(circle.doc, () => execute(circle.doc, 'trim_surface', { id: sheet.id, curveIds: [circle.id] }));
  });
});

describe('trimmed sheets on curved surfaces', () => {
  it('area of a uv region on a sphere agrees with the fine tessellation; a cylinder trimmed by a uv loop keeps its area law', () => {
    const sphere = sphereSurface(10);
    const loop = {
      outer: true,
      polygon: Array.from({ length: 64 }, (_, k) => {
        const angle = (2 * Math.PI * k) / 64;
        return [0.5 + 0.2 * Math.cos(angle), 0.5 + 0.2 * Math.sin(angle)] as const;
      }),
    };
    const area = trimmedArea(sphere, [loop]);
    const mesh = surfaceTriangles(sphere, [0, 0, 0], 24, [loop]);
    const tessellated = mesh.reduce((sum, [a, b, c]) => {
      const [ux, uy, uz, vx, vy, vz] = [b![0] - a![0], b![1] - a![1], b![2] - a![2], c![0] - a![0], c![1] - a![1], c![2] - a![2]];
      return sum + Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }, 0);
    expect(Math.abs(tessellated / area - 1)).toBeLessThan(0.02);
    const wall = cylinderSurface(2, 5);
    expect(trimmedArea(wall, [domainLoop(wall)])).toBeCloseTo(2 * Math.PI * 2 * 5, 6);
    const half = {
      outer: true,
      polygon: [
        [0, 0],
        [0.5, 0],
        [1, 0],
        [1, 0.5],
        [1, 1],
        [0.5, 1],
        [0, 1],
        [0, 0.5],
      ] as const,
    };
    const [[u0, u1], [v0, v1]] = [
      [wall.knotsU[0]!, wall.knotsU[wall.knotsU.length - 1]!],
      [wall.knotsV[0]!, wall.knotsV[wall.knotsV.length - 1]!],
    ];
    const rescaled = { ...half, polygon: half.polygon.map(([u, v]) => [u0 + u * (u1 - u0), v0 + v * (v1 - v0)] as const) };
    expect(trimmedArea(wall, [rescaled])).toBeCloseTo(2 * Math.PI * 2 * 5, 6);
    expect(tessellateSheet(sphere, undefined, 4).indices.length).toBeGreaterThan(0);
  });
});

describe('trimmed sheets in other commands, stored trims', () => {
  const sheetDoc = addSheet(empty, plane(10));
  const circle = addCurve(sheetDoc.doc, circleParams(5, 5, 0, 3));
  const trimmed = execute(circle.doc, 'trim_surface', { id: sheetDoc.id, curveIds: [circle.id] });
  const other = addSheet(trimmed.document, plane(10));

  it('blend_surfaces and fill_surface neighbours refuse a trimmed sheet; check_surface_quality lists trims as not checked', () => {
    expectNoOp(execute(other.doc, 'blend_surfaces', { a: { id: sheetDoc.id }, b: { id: other.id } }), other.doc, 'SRF_TRIM_UNSUPPORTED');
    const line = (a: number[], b: number[]): Record<string, unknown> => ({ degree: 1, poles: [a, b] });
    let doc = other.doc;
    const ids: string[] = [];
    for (const [a, b] of [
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      [
        [10, 0, 0],
        [10, 10, 0],
      ],
      [
        [10, 10, 0],
        [0, 10, 0],
      ],
      [
        [0, 10, 0],
        [0, 0, 0],
      ],
    ] as const) {
      const made = addCurve(doc, line([...a], [...b]));
      doc = made.doc;
      ids.push(made.id);
    }
    expectNoOp(
      execute(doc, 'fill_surface', { boundaryIds: ids, neighbours: [{ curveId: ids[0]!, surfaceId: sheetDoc.id, continuity: 'G1' }] }),
      doc,
      'SRF_TRIM_UNSUPPORTED',
    );
    const quality = execute(trimmed.document, 'check_surface_quality', { ids: [sheetDoc.id] }).data as { notChecked: string[] };
    expect(quality.notChecked.some((text) => text.includes('trim loops'))).toBe(true);
  });

  it('the saved-document guard wants an even vertex count and points inside the parameter domain', () => {
    const stored = JSON.parse(JSON.stringify(trimmed.document.entities[sheetDoc.id])) as Record<string, unknown>;
    expect(validateEntityValue(stored)).toBeNull();
    const square = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(validateEntityValue({ ...stored, trims: [{ outer: true, polygon: square }] })).toBeNull();
    expect(
      validateEntityValue({
        ...stored,
        trims: [
          {
            outer: true,
            polygon: square.slice(0, 3).concat([
              [0, 1],
              [0, 0.5],
            ]),
          },
        ],
      }),
    ).not.toBeNull();
    expect(
      validateEntityValue({
        ...stored,
        trims: [
          {
            outer: true,
            polygon: [
              [0, 0],
              [2, 0],
              [2, 1],
              [0, 1],
            ],
          },
        ],
      }),
    ).not.toBeNull();
    expect(validateEntityValue({ ...stored, trims: Array.from({ length: 65 }, () => ({ outer: true, polygon: square })) })).not.toBeNull();
  });
});
