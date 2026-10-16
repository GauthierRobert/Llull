/** PHY-03: compute_view_factors (VC-THM-09.a-d through the contour integral, reciprocity, obstruction, refusals). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { viewFactorCoaxialDiscs, viewFactorParallel, viewFactorPerpendicular } from '@lib/thermalClosedForms';
import { expectCase } from '../benchmarkCases';

const PACK = '03-thermal-analysis';
const doc = createEmptyDocument();

type V3 = [number, number, number];
interface Surface {
  name: string;
  vertices: V3[];
  flip?: boolean;
}
interface Data {
  surfaces: { name: string; areaM2: number; facets: number; normal: V3 }[];
  matrix: number[][];
  rowSums: number[];
  facetCounts: number[];
  reciprocityMaxError: number;
  obstruction: boolean;
  findings: { code: string; remediation: string }[];
  closedCavity?: { ok: boolean; maxDeviation: number };
  method: string;
}

const factors = (surfaces: Surface[], extra: Record<string, unknown> = {}): { result: CommandResult; data: Data } => {
  const result = execute(doc, 'compute_view_factors', { lengthUnit: 'm', surfaces, ...extra });
  return { result, data: result.data as Data };
};

/** Rectangle in the plane z = height spanning [0, a] x [0, b], emitting towards +z (up = true) or -z. */
const horizontal = (name: string, a: number, b: number, height: number, up: boolean): Surface => ({
  name,
  vertices: [
    [0, 0, height],
    [a, 0, height],
    [a, b, height],
    [0, b, height],
  ],
  ...(up ? {} : { flip: true }),
});

/** Rectangle in the plane x = 0 spanning y in [0, w], z in [0, h], emitting towards +x. */
const vertical = (name: string, w: number, h: number): Surface => ({
  name,
  vertices: [
    [0, 0, 0],
    [0, w, 0],
    [0, w, h],
    [0, 0, h],
  ],
});

const parallelPair = (side: number, spacing = 1): Surface[] => [
  horizontal('bottom', side, side, 0, true),
  horizontal('top', side, side, spacing, false),
];

describe('compute_view_factors against the closed forms (VC-THM-09)', () => {
  it('parallel opposed unit squares (VC-THM-09.a)', () => {
    const { result, data } = factors(parallelPair(1));
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expectCase(PACK, 'VC-THM-09.a', data.matrix[0]?.[1] as number, '1');
    expect(Math.abs((data.matrix[0]?.[1] ?? 0) - viewFactorParallel(1, 1, 1))).toBeLessThan(1e-12);
    expect(data.matrix[1]?.[0]).toBeCloseTo(data.matrix[0]?.[1] ?? 0, 14);
    expect(data.matrix[0]?.[0]).toBe(0);
    expect(data.surfaces[0]).toMatchObject({ name: 'bottom', areaM2: 1, facets: 2 });
    expect(data.surfaces[0]?.normal).toEqual([0, 0, 1]);
    expect(data.surfaces[1]?.normal).toEqual([0, 0, -1]);
    expect(data.reciprocityMaxError).toBeLessThan(1e-12);
    expect(data.findings).toEqual([]);
    expect(result.summary).toMatch(/compute_view_factors: 2 surfaces, 4 facets/);
  });

  it('perpendicular unit squares with a common edge (VC-THM-09.b)', () => {
    const { data } = factors([horizontal('floor', 1, 1, 0, true), vertical('wall', 1, 1)]);
    expectCase(PACK, 'VC-THM-09.b', data.matrix[0]?.[1] as number, '1');
    expect(Math.abs((data.matrix[0]?.[1] ?? 0) - viewFactorPerpendicular(1, 1, 1))).toBeLessThan(1e-12);
  });

  it('closed unit cube: opposite + 4 adjacent = 1 and every row sums to 1 (VC-THM-09.c)', () => {
    const inward: Surface[] = [
      {
        name: 'z0',
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ],
      },
      {
        name: 'z1',
        vertices: [
          [0, 0, 1],
          [0, 1, 1],
          [1, 1, 1],
          [1, 0, 1],
        ],
      },
      {
        name: 'x0',
        vertices: [
          [0, 0, 0],
          [0, 1, 0],
          [0, 1, 1],
          [0, 0, 1],
        ],
      },
      {
        name: 'x1',
        vertices: [
          [1, 0, 0],
          [1, 0, 1],
          [1, 1, 1],
          [1, 1, 0],
        ],
      },
      {
        name: 'y0',
        vertices: [
          [0, 0, 0],
          [0, 0, 1],
          [1, 0, 1],
          [1, 0, 0],
        ],
      },
      {
        name: 'y1',
        vertices: [
          [0, 1, 0],
          [1, 1, 0],
          [1, 1, 1],
          [0, 1, 1],
        ],
      },
    ];
    const { data, result } = factors(inward, { closed: true });
    const row = data.matrix[0] as number[];
    expectCase(PACK, 'VC-THM-09.c', (row[1] ?? 0) + 4 * (row[2] ?? 0), '1');
    expect(row[2]).toBeCloseTo(row[3] ?? 0, 13);
    for (const sum of data.rowSums) expect(sum).toBeCloseTo(1, 12);
    expect(data.closedCavity?.ok).toBe(true);
    expect(data.closedCavity?.maxDeviation).toBeLessThan(1e-12);
    expect(data.reciprocityMaxError).toBeLessThan(1e-12);
    expect(data.facetCounts).toEqual([2, 2, 2, 2, 2, 2]);
    expect(result.summary).toContain('6 surfaces, 12 facets');
  });

  it('coaxial discs as 64-gons (VC-THM-09.d, within the polygon discretisation)', () => {
    const disc = (name: string, z: number, flip: boolean): Surface => ({
      name,
      vertices: Array.from({ length: 64 }, (_, k): V3 => [Math.cos((2 * Math.PI * k) / 64), Math.sin((2 * Math.PI * k) / 64), z]),
      ...(flip ? { flip } : {}),
    });
    const { data } = factors([disc('lower', 0, false), disc('upper', 1, true)]);
    expectCase(PACK, 'VC-THM-09.d', data.matrix[0]?.[1] as number, '1');
    expect(Math.abs((data.matrix[0]?.[1] ?? 0) - viewFactorCoaxialDiscs(1, 1, 1))).toBeLessThan(1e-3);
  });

  it('reproduces the parallel and perpendicular rows of view_factors.csv', () => {
    const rows = readFileSync('docs/physics/03-thermal-analysis/validation/view_factors.csv', 'utf8').trim().split('\n').slice(1);
    let checked = 0;
    for (const row of rows) {
      const [name, parameter, closed] = row.split(',') as [string, string, string];
      const r = Number(parameter);
      if (name.startsWith('parallel')) {
        expect(factors(parallelPair(r)).data.matrix[0]?.[1], row).toBeCloseTo(Number(closed), 8);
        checked += 1;
      } else if (name.startsWith('perpendicular')) {
        expect(factors([horizontal('floor', 1, 1, 0, true), vertical('wall', 1, r)]).data.matrix[0]?.[1], row).toBeCloseTo(
          Number(closed),
          8,
        );
        checked += 1;
      }
    }
    expect(checked).toBe(11);
  });
});

describe('compute_view_factors geometry handling', () => {
  it('is reciprocal for unequal surfaces and areas weigh the transposed factor', () => {
    const { data } = factors([horizontal('big', 2, 2, 0, true), horizontal('small', 0.5, 0.5, 1, false)]);
    const [big, small] = data.surfaces;
    const forward = (data.matrix[0]?.[1] ?? 0) * (big?.areaM2 ?? 0);
    const backward = (data.matrix[1]?.[0] ?? 0) * (small?.areaM2 ?? 0);
    expect(forward).toBeGreaterThan(0);
    expect(Math.abs(forward - backward)).toBeLessThan(1e-14);
    expect(data.reciprocityMaxError).toBeLessThan(1e-12);
  });

  it('refinement splits facets and keeps the exact value for fully visible planar pairs', () => {
    const refined = factors(parallelPair(1), { maxFacetSize: { value: 250, unit: 'mm' } });
    expect(refined.data.facetCounts).toEqual([128, 128]);
    expect(refined.data.matrix[0]?.[1]).toBeCloseTo(viewFactorParallel(1, 1, 1), 9);
    expect(refined.data.reciprocityMaxError).toBeLessThan(1e-9);
    const perpendicular = factors([horizontal('floor', 1, 1, 0, true), vertical('wall', 1, 1)], {
      maxFacetSize: { value: 0.5, unit: 'm' },
    });
    expect(perpendicular.data.facetCounts).toEqual([32, 32]);
    expect(perpendicular.data.matrix[0]?.[1]).toBeCloseTo(viewFactorPerpendicular(1, 1, 1), 9);
  });

  it('is independent of the length unit', () => {
    const millimetres = parallelPair(1000, 1000).map((s) => ({ ...s, vertices: s.vertices }));
    const { data } = factors(millimetres, { lengthUnit: 'mm' });
    expect(data.matrix[0]?.[1]).toBeCloseTo(viewFactorParallel(1, 1, 1), 12);
    expect(data.surfaces[0]?.areaM2).toBeCloseTo(1, 12);
  });

  it('back-to-back and coplanar surfaces do not see each other', () => {
    const { data } = factors([horizontal('a', 1, 1, 0, true), horizontal('b', 1, 1, 1, true)]);
    expect(data.matrix).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('flags an open enclosure when closed is requested', () => {
    const { data, result } = factors(parallelPair(1), { closed: true });
    expect(data.closedCavity?.ok).toBe(false);
    expect(data.findings[0]?.code).toBe('THM_VIEW_FACTOR_ROWSUM');
    expect(result.summary).toContain('WARNING THM_VIEW_FACTOR_ROWSUM');
  });

  it('shadows pairs behind an opaque blocker only when obstruction is on', () => {
    const wall: Surface = {
      name: 'wall',
      vertices: [
        [-1, -1, 0.5],
        [3, -1, 0.5],
        [3, 3, 0.5],
        [-1, 3, 0.5],
      ],
    };
    const blockers = [{ vertices: wall.vertices }];
    expect(factors(parallelPair(1), { blockers }).data.matrix[0]?.[1]).toBeCloseTo(viewFactorParallel(1, 1, 1), 12);
    const shadowed = factors(parallelPair(1), { blockers, obstruction: true });
    expect(shadowed.data.obstruction).toBe(true);
    expect(shadowed.data.matrix[0]?.[1]).toBe(0);
    const small = [
      {
        vertices: [
          [0.1, 0.1, 0.5],
          [0.4, 0.1, 0.5],
          [0.4, 0.4, 0.5],
          [0.1, 0.4, 0.5],
        ] as V3[],
      },
    ];
    const partial = factors(parallelPair(1), { blockers: small, obstruction: true, maxFacetSize: { value: 0.5, unit: 'm' } });
    const reference = viewFactorParallel(1, 1, 1);
    expect(partial.data.matrix[0]?.[1]).toBeGreaterThan(0);
    expect(partial.data.matrix[0]?.[1]).toBeLessThan(reference);
    expect(factors(parallelPair(1), { obstruction: true }).data.matrix[0]?.[1]).toBeCloseTo(reference, 12);
  });

  it('a third surface in the line of sight blocks the pair', () => {
    const middle = horizontal('shield', 3, 3, 0.5, false);
    const { data } = factors([...parallelPair(1), { ...middle, vertices: middle.vertices.map((v): V3 => [v[0] - 1, v[1] - 1, v[2]]) }], {
      obstruction: true,
    });
    expect(data.matrix[0]?.[1]).toBe(0);
    expect(data.matrix[1]?.[0]).toBe(0);
    expect(data.matrix[0]?.[2]).toBeGreaterThan(0);
  });
});

describe('compute_view_factors refusals', () => {
  const refused = (surfaces: Surface[], code: string, extra: Record<string, unknown> = {}): CommandResult => {
    const { result } = factors(surfaces, extra);
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.error?.code).toBe(code);
    expect(result.error?.remediation.length).toBeGreaterThan(10);
    return result;
  };

  it('refuses a bad length unit or facet size', () => {
    refused(parallelPair(1), 'THM_UNITS_MISMATCH', { lengthUnit: 'kg' });
    refused(parallelPair(1), 'THM_UNITS_MISMATCH', { maxFacetSize: { value: 1, unit: 's' } });
    refused(parallelPair(1), 'THM_SURFACE_INVALID', { maxFacetSize: { value: 0, unit: 'm' } });
  });

  it('refuses duplicate names, degenerate and non-planar polygons', () => {
    refused([horizontal('same', 1, 1, 0, true), horizontal('same', 1, 1, 1, false)], 'THM_SURFACE_INVALID');
    const line: Surface = {
      name: 'line',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
    };
    expect(refused([horizontal('a', 1, 1, 0, true), line], 'THM_SURFACE_INVALID').error?.paths).toEqual(['surfaces[1]']);
    const warped: Surface = {
      name: 'warped',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0.3],
        [0, 1, 0],
      ],
    };
    expect(refused([horizontal('a', 1, 1, 0, true), warped], 'THM_SURFACE_INVALID').summary).toContain('not planar');
    refused(parallelPair(1), 'THM_SURFACE_INVALID', { obstruction: true, blockers: [{ vertices: line.vertices }] });
  });

  it('refuses more facets than the limit', () => {
    refused(parallelPair(1), 'THM_FACET_LIMIT', { maxFacetSize: { value: 1, unit: 'mm' } });
  });

  it('counts blocker facets in the facet budget and bounds blocker size', () => {
    const ngon = Array.from({ length: 256 }, (_, k): V3 => [Math.cos((2 * Math.PI * k) / 256), Math.sin((2 * Math.PI * k) / 256), 0.5]);
    const blockers = [{ vertices: ngon }, { vertices: ngon }];
    refused(parallelPair(1), 'THM_FACET_LIMIT', { obstruction: true, blockers });
    expect(factors(parallelPair(1), { blockers }).result.rejected).toBeUndefined();
    const tooMany = Array.from({ length: 17 }, () => ({ vertices: ngon.slice(0, 3) }));
    expect(execute(doc, 'compute_view_factors', { lengthUnit: 'm', surfaces: parallelPair(1), blockers: tooMany }).summary).toMatch(
      /rejected: invalid params/,
    );
    const huge = Array.from({ length: 300 }, (_, k): V3 => [Math.cos(k), Math.sin(k), 0]);
    expect(
      execute(doc, 'compute_view_factors', { lengthUnit: 'm', surfaces: [{ name: 'h', vertices: huge }, ...parallelPair(1)] }).summary,
    ).toMatch(/rejected: invalid params/);
  });

  it('rejects fewer than two surfaces through the schema', () => {
    const result = execute(doc, 'compute_view_factors', { lengthUnit: 'm', surfaces: [horizontal('a', 1, 1, 0, true)] });
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/rejected: invalid params/);
  });

  it('does not mutate the document', () => {
    const before = JSON.stringify(doc);
    factors(parallelPair(1));
    expect(JSON.stringify(doc)).toBe(before);
  });
});
