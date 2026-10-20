import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { sphereSurface } from '../../helpers/revolvedSurfaces';

const empty = createEmptyDocument();
type P = [number, number, number];

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

const addSheet = (doc: CadDocument, surface: NurbsSurfaceData): { doc: CadDocument; id: string } => {
  const result = execute(doc, 'create_nurbs_surface', { ...surface });
  return { doc: result.document, id: result.affected[0]! };
};

interface Finding {
  code: string;
  severity: string;
  entityId: string;
  edgeIndex?: number;
  value: number;
  limit: number;
  worst: { point: number[] };
  remediation: string;
}
interface Quality {
  status: string;
  findings: Finding[];
  counts: { fail: number; warn: number; info: number };
  tolerances: Record<string, { value: number; defaulted: boolean; source: string }>;
  reviewRequired: boolean;
  reviewReason?: string;
  skipped: Array<{ id: string; kind: string }>;
}
const quality = (result: ReturnType<typeof execute>): Quality => result.data as Quality;
const given = { g0: 1e-6, g1AngleRad: 0.01, g2Rel: 0.1, g3Rel: 0.1, sewing: 1e-6 };

/** Two planes meeting at a right angle, sewn into one patch with a C0 crease along x = 3. */
const creased = (): { doc: CadDocument; id: string } => {
  const floor = addSheet(empty, quad([0, 0, 0], [0, 4, 0], [3, 0, 0], [3, 4, 0]));
  const wall = addSheet(floor.doc, quad([3, 0, 0], [3, 4, 0], [3, 0, 3], [3, 4, 3]));
  const sewn = execute(wall.doc, 'sew_surfaces', { ids: [floor.id, wall.id] });
  return { doc: sewn.document, id: sewn.affected[0]! };
};

describe('check_surface_quality', () => {
  it('a sphere (many C0 knot lines in parameters, G3 in geometry) passes at G3 when every tolerance is given; poles are noted', () => {
    const { doc, id } = addSheet(empty, sphereSurface(10));
    const result = execute(doc, 'check_surface_quality', { ids: [id], require: 'G3', ...given });
    const data = quality(result);
    expect(data.findings.filter((f) => f.severity === 'fail')).toEqual([]);
    expect(data.status).toBe('warn');
    expect(data.findings.map((f) => f.code)).toEqual(['SRF_CHECK_DEGENERATE_SAMPLES']);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('check_surface_quality');
  });

  it('a right-angle crease fails G1 with the angle, location and remediation; G0 accepts it', () => {
    const { doc, id } = creased();
    const result = execute(doc, 'check_surface_quality', { ids: [id], ...given });
    const data = quality(result);
    expect(data.status).toBe('fail');
    const finding = data.findings.find((f) => f.code === 'SRF_CHECK_G1_ANGLE')!;
    expect(finding).toMatchObject({ severity: 'fail', entityId: id, limit: 0.01 });
    expect(finding.value).toBeCloseTo(Math.PI / 2, 6);
    expect(finding.worst.point[0]).toBeCloseTo(3, 9);
    expect(finding.remediation.length).toBeGreaterThan(10);
    expect(quality(execute(doc, 'check_surface_quality', { ids: [id], require: 'G0', ...given })).status).toBe('pass');
  });

  it('names the defaulted tolerances with a warning, and the release purpose requires a human review', () => {
    const { doc, id } = creased();
    const result = execute(doc, 'check_surface_quality', { ids: [id], require: 'G0', purpose: 'release' });
    const data = quality(result);
    expect(data.tolerances['g0']).toMatchObject({ defaulted: true });
    expect(data.tolerances['g0']!.source).toContain('size');
    expect(data.findings.some((f) => f.code === 'SRF_CHECK_TOLERANCE_DEFAULTED')).toBe(true);
    expect(data.reviewRequired).toBe(true);
    expect(data.reviewReason).toContain('not approved');
    expect(result.summary).toContain('needs a qualified engineer');
    expect(quality(execute(doc, 'check_surface_quality', { ids: [id], require: 'G0', ...given })).reviewRequired).toBe(false);
  });

  it('reports free edges: informational by default, failures when a solid is expected, none for a sewn shell', () => {
    const lone = addSheet(empty, quad([0, 0, 0], [0, 4, 0], [3, 0, 0], [3, 4, 0]));
    const info = quality(execute(lone.doc, 'check_surface_quality', { ids: [lone.id], ...given }));
    expect(info.findings.filter((f) => f.code === 'SRF_CHECK_FREE_EDGES')).toHaveLength(4);
    expect(info.counts.fail).toBe(0);
    const strict = quality(execute(lone.doc, 'check_surface_quality', { ids: [lone.id], expectSolid: true, ...given }));
    expect(strict.status).toBe('fail');
    expect(strict.findings[0]).toMatchObject({ code: 'SRF_CHECK_FREE_EDGES', edgeIndex: 0 });
    const closed = addSheet(lone.doc, quad([0, 0, 0], [0, 4, 0], [3, 0, 0], [3, 4, 0]));
    const twin = quality(execute(closed.doc, 'check_surface_quality', { expectSolid: true, ...given }));
    expect(twin.findings.filter((f) => f.code === 'SRF_CHECK_FREE_EDGES')).toHaveLength(0);
  });

  it('checks draft against a pull direction', () => {
    const { doc, id } = addSheet(empty, quad([0, 0, 0], [0, 4, 0], [3, 0, 0], [3, 4, 0]));
    const flat = quality(execute(doc, 'check_surface_quality', { ids: [id], pullDirection: [1, 0, 0], minDraftDeg: 0, ...given }));
    expect(flat.findings.some((f) => f.code === 'SRF_CHECK_DRAFT_BELOW_MIN')).toBe(false);
    const steep = quality(execute(doc, 'check_surface_quality', { ids: [id], pullDirection: [1, 0, 0], minDraftDeg: 3, ...given }));
    expect(steep.findings.find((f) => f.code === 'SRF_CHECK_DRAFT_BELOW_MIN')).toMatchObject({ severity: 'fail', limit: 3 });
  });

  it('skips solids, defaults to every sheet, refuses bad input; is pure', () => {
    const { doc, id } = creased();
    const withBox = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const boxId = withBox.order[withBox.order.length - 1]!;
    const all = quality(execute(withBox, 'check_surface_quality', { ...given }));
    expect(all.skipped).toEqual([]);
    const listed = quality(execute(withBox, 'check_surface_quality', { ids: [id, boxId], ...given }));
    expect(listed.skipped).toEqual([{ id: boxId, kind: 'box' }]);
    expectNoOp(execute(doc, 'check_surface_quality', { ids: ['nope'] }), doc, 'SRF_ENTITY_NOT_FOUND');
    expectNoOp(execute(doc, 'check_surface_quality', { g0: -1 }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'check_surface_quality', { samples: 1 }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'check_surface_quality', { minDraftDeg: 120 }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'check_surface_quality', { pullDirection: [0, 0, 0] }), doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(doc, 'check_surface_quality', { ids: [] }), doc, 'SRF_PARAM_INVALID');
    expectPure(doc, () => execute(doc, 'check_surface_quality', { ids: [id] }));
  });
});
