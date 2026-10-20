import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { LaminaMaterial } from '@core/model/composites';
import {
  engineeringConstants,
  laminateStiffness,
  plyStressAt,
  strainsFor,
  type Load6,
  type StackPly,
  type Triple,
} from '@lib/laminate/clt';
import { DEFAULT_F12_STAR, strengthRatio, strengthsOf, type Strengths } from '@lib/laminate/failure';
import { recoverPlyStresses } from '@lib/laminate/recover';
import { plyMarginRows, type PlyMarginInput } from '@cae/margins/plyMargins';
import { factorReport } from '@cae/margins/marginMath';
import type { AnalysisCase } from '@core/model/analysis';
import { TAPE, compositeShell } from './plyMarginsFixtures';

interface Row {
  rowId: string;
  rowKey: string;
  ms: number | null;
  status: string;
  strengthRatio: number | null;
  strengthRatios: { max_stress: number | null; tsai_wu: number | null };
  plyCriterion: string;
  ply: { id: string; index: number; angleDeg: number; position: string };
  criterion: string;
  factorApplied: number;
  reviewRequired: boolean;
  unverified: boolean;
  allowable: { tsaiWuF12Star: { value: number; defaulted: boolean } };
  failureMode?: string;
  [key: string]: unknown;
}
interface Margins {
  minMs: number | null;
  rows: Row[];
  warnings: string[];
}

const stack = (angles: readonly number[], material: LaminaMaterial = TAPE): StackPly[] => angles.map((angle) => ({ material, angle }));

/** Global stress components [xx, yy, zz, xy, yz, zx] of the laminate-axes in-plane stress (the plate lies in z = 0, x = rosette 0 degrees). */
const globalOf = ([sx, sy, txy]: Triple): number[] => [sx, sy, 0, txy, 0, 0];

/** CLT truth: the outer-surface stresses under `load` and the per-ply material-axes stresses at both surfaces of every ply. */
function clt(angles: readonly number[], load: Load6): { top: number[]; bottom: number[]; plies: { bottom: Triple; top: Triple }[] } {
  const plies = stack(angles);
  const laminate = laminateStiffness(plies);
  const constants = engineeringConstants(laminate);
  if (constants === null) throw new Error('singular');
  const { strain, curvature } = strainsFor(constants.abdInverse, load);
  const at = (index: number, z: number): ReturnType<typeof plyStressAt> => plyStressAt(TAPE, angles[index] as number, strain, curvature, z);
  return {
    bottom: globalOf(at(0, laminate.z[0] as number).xy),
    top: globalOf(at(angles.length - 1, laminate.z[angles.length] as number).xy),
    plies: angles.map((_, index) => ({
      bottom: at(index, laminate.z[index] as number).material,
      top: at(index, laminate.z[index + 1] as number).material,
    })),
  };
}

describe('recoverPlyStresses (pure laminate recovery)', () => {
  it.each([
    [
      [0, 90, 90, 0],
      [120, 30, 10, 0, 0, 0],
    ],
    [
      [0, 45, -45, 90, 90, -45, 45, 0],
      [200, -40, 25, 15, -8, 4],
    ],
    [
      [0, 90],
      [50, 20, 0, 3, 1, 0],
    ],
    [[30], [10, 0, 0, 2, 0, 0]],
  ] as const)('reproduces the per-ply stresses of a CLT solution (%j)', (angles, load) => {
    const truth = clt(angles, load as unknown as Load6);
    const recovered = recoverPlyStresses(
      stack(angles),
      [truth.bottom[0], truth.bottom[1], truth.bottom[3]] as unknown as Triple,
      [truth.top[0], truth.top[1], truth.top[3]] as unknown as Triple,
    );
    expect(recovered).not.toBeNull();
    for (const [index, ply] of (recovered ?? []).entries())
      for (const surface of ['bottom', 'top'] as const)
        ply[surface].forEach((value, k) => expect(value).toBeCloseTo(truth.plies[index]?.[surface][k] ?? Number.NaN, 7));
  });

  it('returns null for an empty stack or a singular ply', () => {
    expect(recoverPlyStresses([], [0, 0, 0], [0, 0, 0])).toBeNull();
    expect(recoverPlyStresses(stack([0], { ...TAPE, plyThickness: 0 }), [1, 0, 0], [1, 0, 0])).toBeNull();
    expect(recoverPlyStresses(stack([0], { ...TAPE, E2: 0, G12: 0 }), [1, 0, 0], [1, 0, 0])).toBeNull();
  });
});

describe('compute_margins on composite shells (ply failure)', () => {
  const angles = [0, 90, 90, 0];
  const load: Load6 = [300, 20, 5, 25, 3, 1];
  const truth = clt(angles, load);

  it('gives one row per ply with the first-ply strength ratio and MS = R / factor - 1', () => {
    const shell = compositeShell({ top: truth.top, bottom: truth.bottom, angles });
    const result = execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx);
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Margins;
    expect(data.rows).toHaveLength(4);
    const strengths = strengthsOf(TAPE) as Strengths;
    for (const row of data.rows) {
      const surfaces = (['bottom', 'top'] as const).map((surface) => truth.plies[row.ply.index]?.[surface] as Triple);
      const expected = Math.min(
        ...surfaces.flatMap((stress) => [
          strengthRatio('max_stress', stress, strengths).R,
          strengthRatio('tsai_wu', stress, strengths, DEFAULT_F12_STAR).R,
        ]),
      );
      expect(row.strengthRatio).toBeCloseTo(expected, 8);
      expect(row.factorApplied).toBe(1.5);
      expect(row.ms).toBeCloseTo(expected / 1.5 - 1, 8);
      expect(row.criterion).toBe('ply_failure');
      expect(row.reviewRequired).toBe(true);
      expect(row.unverified).toBe(false);
      expect(row.allowable.tsaiWuF12Star).toEqual({ value: DEFAULT_F12_STAR, defaulted: true });
      expect(row.rowKey).toContain(`|ply_failure|p${row.ply.index + 1}`);
      expect(row.ply.angleDeg).toBe(angles[row.ply.index]);
      expect(Math.min(row.strengthRatios.max_stress ?? Infinity, row.strengthRatios.tsai_wu ?? Infinity)).toBeCloseTo(expected, 8);
    }
    expect(data.minMs).toBeCloseTo(Math.min(...data.rows.map((row) => row.ms ?? Infinity)), 12);
    expect(data.warnings.some((text) => text.startsWith('FEA_COMPOSITE_MARGINS_UNSUPPORTED'))).toBe(false);
    expect(result.summary).toContain('min MS');
  });

  it('flags a failing ply, its mode and the pending human disposition; a stated factor changes the margin', () => {
    const heavy = clt(angles, [900, 60, 10, 0, 0, 0]);
    const shell = compositeShell({ top: heavy.top, bottom: heavy.bottom, angles, factorUltimate: 2 });
    const data = execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx).data as Margins;
    const failing = data.rows.filter((row) => row.status === 'FAIL');
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((row) => row['disposition'] === 'pending_human' && row.ms !== null && row.ms < 0)).toBe(true);
    expect(data.rows.every((row) => row.factorApplied === 2)).toBe(true);
    const matrixPly = data.rows.find((row) => row.ply.angleDeg === 90);
    expect(matrixPly?.failureMode === undefined || ['matrix', 'fibre', 'shear'].includes(matrixPly.failureMode)).toBe(true);
  });

  it('refuses when the laminate lacks allowables and warns when only some data is missing', () => {
    const lacking = Object.fromEntries(Object.entries(TAPE).filter(([key]) => key !== 'Yt' && key !== 'S')) as unknown as LaminaMaterial;
    const shell = compositeShell({ top: truth.top, bottom: truth.bottom, angles, material: lacking });
    const result = execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FEA_COMPOSITE_MARGINS_UNSUPPORTED');
    expect(result.summary).toContain('lacks Yt, S');
  });

  it('refuses when the results have no fibre stresses', () => {
    const shell = compositeShell({ top: null, bottom: null, angles });
    const result = execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FEA_COMPOSITE_MARGINS_UNSUPPORTED');
    expect(result.summary).toContain('STRESS_TOP');
  });

  it('marks mean data unverified and reports a stated Tsai-Wu interaction factor', () => {
    const shell = compositeShell({
      top: truth.top,
      bottom: truth.bottom,
      angles,
      material: { ...TAPE, basis: 'mean', tsaiWuF12Star: -0.2 },
    });
    const row = (execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx).data as Margins).rows[0] as Row;
    expect(row.unverified).toBe(true);
    expect(row['unverifiedReasons']).toHaveLength(1);
    expect(row.allowable.tsaiWuF12Star).toEqual({ value: -0.2, defaulted: false });
  });

  it('surfaces a negative ply margin in check_analysis and refuses a target grouping without target sets', () => {
    const heavy = clt(angles, [900, 60, 10, 0, 0, 0]);
    const shell = compositeShell({ top: heavy.top, bottom: heavy.bottom, angles });
    const found = execute(shell.recorded, 'check_analysis', { analysisId: shell.analysisId }, shell.ctx);
    expect(JSON.stringify(found.data)).toContain('FEA_MS_NEGATIVE');
    const byTarget = execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId, groupBy: 'target' }, shell.ctx);
    expect(byTarget.rejected).toBe(true);
  });
});

describe('plyMarginRows branches', () => {
  const shell = compositeShell({ top: [10, 0, 0, 0, 0, 0], bottom: [-10, 0, 0, 0, 0, 0] });
  const analysis = shell.recorded.analysis?.cases[shell.analysisId] as AnalysisCase;
  const fibre = (stress: number[]): { values: Record<string, number[]> } => ({ values: { '1': stress, '2': stress } });
  const input = (over: Partial<PlyMarginInput> = {}): PlyMarginInput => ({
    doc: shell.recorded,
    analysis,
    mesh: shell.mesh,
    fields: { STRESS_TOP: fibre([40, 0, 0, 0, 0, 0]), STRESS_BOT: fibre([-40, 0, 0, 0, 0, 0]) },
    entityId: shell.boxId,
    region: 'part',
    nodes: [1, 2],
    singular: false,
    loadCase: { name: 'LC1', category: 'limit' },
    factors: factorReport(analysis),
    marginalBand: undefined,
    port: null,
    ...over,
  });
  const skipped = (over: Partial<PlyMarginInput>): string => {
    const outcome = plyMarginRows(input(over));
    return 'skipped' in outcome ? outcome.skipped : 'rows';
  };

  it('computes the rows of a group and labels singular groups', () => {
    const outcome = plyMarginRows(input({ singular: true, marginalBand: 100 }));
    expect('rows' in outcome).toBe(true);
    const rows = 'rows' in outcome ? outcome.rows : [];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row['singular'] === true && row['region'] === 'singular' && row['groupRegion'] === 'part')).toBe(true);
    expect(rows.every((row) => String(row['rowKey']).endsWith('|singular') && row.status === 'MARGINAL')).toBe(true);
  });

  it('gives a null margin where a ply carries no stress', () => {
    const outcome = plyMarginRows(input({ fields: { STRESS_TOP: fibre([0, 0, 0, 0, 0, 0]), STRESS_BOT: fibre([0, 0, 0, 0, 0, 0]) } }));
    const rows = 'rows' in outcome ? outcome.rows : [];
    expect(rows.every((row) => row.ms === null && row['strengthRatio'] === null)).toBe(true);
    expect(rows.every((row) => (row['provenance'] as { note?: string }).note !== undefined)).toBe(true);
  });

  it('reports why a shell gets no rows', () => {
    expect(skipped({ entityId: 'ghost' })).toContain('no composite shell');
    expect(skipped({ nodes: [] })).toContain('no node of the group');
    expect(skipped({ nodes: [99] })).toContain('no node of the group');
    expect(skipped({ fields: { STRESS_TOP: fibre([1, 0, 0, 0, 0, 0]) } })).toContain('STRESS_TOP / STRESS_BOT');
    const noPart = {
      ...shell.recorded,
      composites: { ...(shell.recorded.composites as NonNullable<typeof shell.recorded.composites>), parts: {} },
    };
    expect(skipped({ doc: noPart })).toContain('FEA_COMPOSITE_INVALID');
    const upright = {
      ...shell.recorded,
      composites: {
        ...(shell.recorded.composites as NonNullable<typeof shell.recorded.composites>),
        rosettes: {
          'ro-1': {
            id: 'ro-1',
            name: 'ro',
            origin: [0, 0, 0] as [number, number, number],
            axis0: [0, 0, 1] as [number, number, number],
            normal: [0, 0, 1] as [number, number, number],
            method: 'translational' as const,
          },
        },
      },
    };
    expect(skipped({ doc: upright })).toContain('normal to the shell');
    const bent = {
      ...shell.mesh,
      nodes: [...shell.mesh.nodes, [5, 10, 0, 10], [6, 0, 0, 10]] as typeof shell.mesh.nodes,
      blocks: [
        {
          type: 'S4' as const,
          entityId: shell.boxId,
          elements: [
            [1, 1, 2, 3, 4],
            [2, 2, 5, 6, 1],
          ],
        },
      ],
    };
    expect(skipped({ mesh: bent })).toContain('not planar');
    const noMesh = { ...shell.mesh, blocks: [] };
    expect(skipped({ mesh: noMesh })).toContain('no shell element');
  });
});

describe('ply rows: frame verification flag and per-ply rosettes', () => {
  const angles = [0, 90, 90, 0];
  const truth = clt(angles, [300, 20, 5, 25, 3, 1]);

  it('states the ccx-confirmed frame in the provenance and adds no frame warning (verified lamina data stays verified)', () => {
    const shell = compositeShell({ top: truth.top, bottom: truth.bottom, angles });
    const data = execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx).data as Margins;
    for (const row of data.rows) {
      expect((row['provenance'] as { method: string }).method).toContain('confirmed against CalculiX 2.21');
      expect((row['unverifiedReasons'] as string[]).some((text) => text.includes('STRESS_TOP/BOT frame'))).toBe(false);
    }
    expect(data.warnings.some((text) => text.startsWith('FEA_COMPOSITE_PLY_UNVERIFIED'))).toBe(false);
  });

  it('measures every ply angle from its own rosette: ro-2 at 0 degrees equals ro-1 at 90', () => {
    const base = compositeShell({ top: truth.top, bottom: truth.bottom, angles });
    const mixed = compositeShell({
      top: truth.top,
      bottom: truth.bottom,
      angles: [0, 0, 0, 0],
      rosettes: ['ro-1', 'ro-2', 'ro-2', 'ro-1'],
    });
    const rows = (shell: typeof base): Row[] =>
      (execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx).data as Margins).rows;
    const [a, b] = [rows(base), rows(mixed)];
    expect(b).toHaveLength(4);
    a.forEach((row, k) => expect(b[k]?.strengthRatio).toBeCloseTo(row.strengthRatio ?? Number.NaN, 8));
  });

  it('skips a laminate whose ply rosette is normal to the shell and flags thermo-mechanical cases', () => {
    const thermal = compositeShell({ top: truth.top, bottom: truth.bottom, angles, analysisType: 'thermo_static' });
    const rows =
      (execute(thermal.recorded, 'compute_margins', { analysisId: thermal.analysisId }, thermal.ctx).data as Margins | undefined)?.rows ??
      [];
    for (const row of rows) expect((row['unverifiedReasons'] as string[]).some((text) => text.includes('thermal strain'))).toBe(true);
  });

  it('reports a skip reason only for composite shells that end without rows', () => {
    const shell = compositeShell({ top: truth.top, bottom: truth.bottom, angles });
    const data = execute(shell.recorded, 'compute_margins', { analysisId: shell.analysisId }, shell.ctx).data as Margins;
    expect(data.warnings.some((text) => text.startsWith('FEA_COMPOSITE_MARGINS_UNSUPPORTED'))).toBe(false);
  });
});
