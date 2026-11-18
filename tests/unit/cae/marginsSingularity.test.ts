/** compute_margins singularity policy (05 OQ 8): nodes near point / edge loads and supports are excluded from the part rows and reported apart. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { analysisInputHash } from '@cae/hash/inputHash';
import { marginDispositionPayload } from '@cae/margins/disposition';
import { screenSingularities } from '@cae/margins/singularity';
import { caseIn } from './helpers';
import { gridMesh, seeded } from './gridMesh';
import { timeBudgetMs } from '../../helpers/timeBudget';
import { barMesh, mustRun } from './deckFixtures';
import { marginBar, STAND_IN_MESH, type MarginBar } from './marginsFixtures';

interface Row {
  rowId: string;
  rowKey: string;
  region: string;
  groupRegion?: string;
  check: string;
  singular: boolean;
  singularNote?: string;
  node: number;
  ms: number | null;
  status: string;
}
interface Screening {
  performed: boolean;
  radius: { value: number; unit: string; source: string; defaulted: boolean };
  singularityNote?: string;
  sources: { kind: string; id: string; nodes: number }[];
  excludedNodes: number;
  reentrantEdges: string;
}
interface Margins {
  minMs: number | null;
  minMsRow: string | null;
  rows: Row[];
  singularScreening: Screening;
}

const margins = (bar: MarginBar, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId, ...STAND_IN_MESH, ...params }, bar.ctx);
const dataOf = (result: ReturnType<typeof execute>): Margins => result.data as Margins;

describe('compute_margins singularity screening', () => {
  const bar = marginBar({ pointSupportsSingular: true });
  const result = margins(bar);
  const data = dataOf(result);
  const regular = data.rows.filter((row) => !row.singular);
  const singular = data.rows.filter((row) => row.singular);

  it('reports the nodes of point supports in separate singular rows, after the regular rows, with their own rowKey and a note', () => {
    expect(regular.map((row) => row.rowId)).toEqual(['r1', 'r2']);
    expect(singular.map((row) => row.rowId)).toEqual(['r3', 'r4']);
    for (const row of singular) {
      expect(row.region).toBe('singular');
      expect(row.groupRegion).toBe('part');
      expect([1, 3]).toContain(row.node);
      expect(row.rowKey).toMatch(/\|singular$/);
      expect(row.singularNote).toContain('singularity radius');
      expect(row.status).toMatch(/PASS|FAIL/);
    }
    expect(result.summary).toContain('2 singular row(s) excluded from min MS');
  });

  it('leaves the rowKeys of the regular rows unchanged', () => {
    const plain = dataOf(margins(marginBar())).rows;
    expect(regular.map((row) => row.rowKey)).toEqual(plain.map((row) => row.rowKey));
  });

  it('names the default radius (2 x mesh globalSize) with its source and lists the sources', () => {
    const screening = data.singularScreening;
    expect(screening.performed).toBe(true);
    expect(screening.radius).toEqual({ value: 0.2, unit: 'mm', source: 'llull default (05 OQ 8): 2 x mesh globalSize', defaulted: true });
    expect(screening.sources).toEqual([
      { kind: 'constraint', id: bar.constraints['nodeA'], nodes: 1 },
      { kind: 'constraint', id: bar.constraints['nodeB'], nodes: 1 },
    ]);
    expect(screening.excludedNodes).toBe(2);
    expect(screening.reentrantEdges).toContain('not screened');
    expect(screening.singularityNote).toBeUndefined();
  });

  it('never counts a singular row towards minMs / minMsRow', () => {
    const lowest = Math.min(...regular.map((row) => row.ms ?? Infinity));
    expect(data.minMs).toBe(lowest);
    expect(regular.map((row) => row.rowId)).toContain(data.minMsRow);
  });

  it('makes no singular row and lists no source when every support and load has faces', () => {
    const plain = dataOf(margins(marginBar()));
    expect(plain.rows.every((row) => !row.singular)).toBe(true);
    expect(plain.singularScreening).toMatchObject({ performed: true, sources: [], excludedNodes: 0 });
  });

  it('is pure', () => {
    const before = JSON.stringify(bar.recorded);
    margins(bar);
    expect(JSON.stringify(bar.recorded)).toBe(before);
  });
});

describe('compute_margins singularityRadius override', () => {
  const bar = marginBar({ pointSupportsSingular: true });

  it('uses the radius in document units with the engineer note echoed and marks the radius as not defaulted', () => {
    const data = dataOf(margins(bar, { singularityRadius: 1.5, singularityNote: '  fillet radius 1.5 mm ignored per stress memo  ' }));
    expect(data.singularScreening.radius).toMatchObject({ value: 1.5, unit: 'mm', defaulted: false });
    expect(data.singularScreening.singularityNote).toBe('fillet radius 1.5 mm ignored per stress memo');
    expect(data.singularScreening.excludedNodes).toBe(4);
    expect(data.rows.filter((row) => row.singular)).toHaveLength(2);
  });

  it('a radius covering the whole part leaves only singular rows: no finite minimum margin, and it says so loudly', () => {
    const everything = margins(bar, { singularityRadius: 50, singularityNote: 'worst case' });
    const data = dataOf(everything);
    expect(data.rows.every((row) => row.singular)).toBe(true);
    expect(data.minMs).toBeNull();
    expect(data.minMsRow).toBeNull();
    expect(everything.summary).toContain('no finite margin');
    const warnings = (data as unknown as { warnings: string[] }).warnings;
    expect(warnings.some((text) => text.startsWith('FEA_MS_ALL_SINGULAR:'))).toBe(true);
    expect(warnings.some((text) => text.startsWith('FEA_SINGULAR_EXCLUSION_LARGE: 100 %'))).toBe(true);
  });

  it('radius 0 excludes nothing (no singular row) but still lists the sources', () => {
    const data = dataOf(margins(bar, { singularityRadius: 0, singularityNote: 'sharp support is the design intent' }));
    expect(data.rows.every((row) => !row.singular)).toBe(true);
    expect(data.singularScreening.excludedNodes).toBe(0);
    expect(data.singularScreening.sources).toHaveLength(2);
  });

  it('refuses a radius without a note (or a blank one) and a negative radius, leaving the document unchanged', () => {
    for (const params of [{ singularityRadius: 1 }, { singularityRadius: 1, singularityNote: '   ' }]) {
      const refused = margins(bar, params);
      expect(refused.rejected).toBe(true);
      expect(refused.error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
      expect(refused.summary).toContain('singularityNote');
      expect(refused.document).toBe(bar.recorded);
      expect(refused.affected).toEqual([]);
    }
    const negative = margins(bar, { singularityRadius: -1, singularityNote: 'x' });
    expect(negative.error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(negative.summary).toContain('singularityRadius');
  });
});

describe('singularity sources and units', () => {
  it('takes force / moment loads without a face as sources, ignores pressure-free loads with faces and unmeshed loads, and converts to inches', () => {
    const bar = marginBar();
    let doc = mustRun(bar.recorded, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'point',
      kind: 'force',
      loadCase: 'LC1',
      vector: [1, 0, 0],
      target: { entityId: bar.boxId, pointsNear: [[2, 0, 0]] },
    });
    doc = mustRun(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'weight',
      kind: 'gravity',
      loadCase: 'LC1',
      vector: [0, 0, -1],
    });
    const analysis = caseIn(doc, bar.analysisId);
    const pointId = analysis.loadOrder.find((id) => analysis.loads[id]?.kind === 'force') ?? '';
    const withLoad = barMesh(
      doc,
      bar.analysisId,
      bar.boxId,
      { ...bar.mesh.nodeSets, [`L_${pointId}`]: [2], [`L_missing`]: [4] },
      bar.mesh.faceSets,
    );
    const screen = screenSingularities(doc, analysis, withLoad, undefined);
    expect(screen.data['sources']).toEqual([{ kind: 'load', id: pointId, nodes: 1 }]);
    expect([...screen.excluded]).toEqual([2]);
    const inches = screenSingularities({ ...doc, units: 'in' }, { ...analysis, unitSystem: 'lbf-in-slinch-s' }, withLoad, {
      radius: 0.1,
      note: 'n',
    });
    expect(inches.data['radius']).toMatchObject({ value: 0.1, unit: 'in', defaulted: false });
    const metres = screenSingularities(doc, { ...analysis, unitSystem: 'N-m-kg-s' }, withLoad, { radius: 1000, note: 'n' });
    expect(metres.excluded.size).toBe(3);
  });
});

describe('singularity screen on a large node cloud (PERF1: grid of half-radius cells)', () => {
  const bar = marginBar();
  const doc = mustRun(bar.recorded, 'add_fea_load', {
    analysisId: bar.analysisId,
    name: 'point',
    kind: 'force',
    loadCase: 'LC1',
    vector: [1, 0, 0],
    target: { entityId: bar.boxId, pointsNear: [[2, 0, 0]] },
  });
  const analysis = caseIn(doc, bar.analysisId);
  const pointId = analysis.loadOrder.find((id) => analysis.loads[id]?.kind === 'force') ?? '';
  const next = seeded(7);
  const nodes: [number, number, number, number][] = Array.from({ length: 6000 }, (_, index) => [
    index + 1,
    next() * 40 - 20,
    next() * 10,
    next() * 4,
  ]);
  // Exact distances on the boundary: a node exactly one radius away is inside (inclusive).
  nodes.push([9001, 100, 100, 100], [9002, 100.5, 100, 100], [9003, 100, 100.25, 100], [9004, 100.5000001, 100, 100]);
  const sources = [3, 77, 1500, 4242, 9001];
  const mesh = { ...barMesh(doc, bar.analysisId, bar.boxId, { [`L_${pointId}`]: sources }), nodes };
  const bruteForce = (radius: number): number[] => {
    const at = new Map(nodes.map((node) => [node[0], node]));
    return nodes
      .filter(([, x, y, z]) =>
        sources.some((id) => {
          const source = at.get(id);
          return source !== undefined && Math.hypot(x - source[1], y - source[2], z - source[3]) <= radius;
        }),
      )
      .map((node) => node[0]);
  };

  it.each([0.5, 0.05, 3, 25, 1e-9, 500])('radius %d excludes exactly the nodes within it of a source', (radius) => {
    const screen = screenSingularities(doc, analysis, mesh, { radius, note: 'n' });
    expect([...screen.excluded].sort((a, b) => a - b)).toEqual(bruteForce(radius));
    expect(screen.data['excludedNodes']).toBe(screen.excluded.size);
  });

  it('includes the node exactly one radius away and not the one just beyond', () => {
    const screen = screenSingularities(doc, analysis, mesh, { radius: 0.5, note: 'n' });
    expect(screen.excluded.has(9002)).toBe(true);
    expect(screen.excluded.has(9003)).toBe(true);
    expect(screen.excluded.has(9004)).toBe(false);
  });

  it('compares with every source when a coordinate is too far for cell numbers to step by one', () => {
    const far = { ...mesh, nodes: [...nodes, [9100, 4e9, -4e9, 4e9] as [number, number, number, number]] };
    const spread = { ...far, nodeSets: { [`L_${pointId}`]: [...sources, 9100] } };
    const screen = screenSingularities(doc, analysis, spread, { radius: 1e-9, note: 'n' });
    expect([...screen.excluded].sort((a, b) => a - b)).toEqual([...sources, 9100].sort((a, b) => a - b));
  });

  it('screens 68k nodes around a point source within the interactive budget', () => {
    const grid = gridMesh({ cells: [40, 14, 14], size: [200, 40, 40], quadratic: true });
    const big = { ...mesh, nodes: grid.nodes, nodeSets: { [`L_${pointId}`]: [1, 2, 3] } };
    screenSingularities(doc, analysis, big, { radius: 10, note: 'n' });
    const started = performance.now();
    const screen = screenSingularities(doc, analysis, big, { radius: 10, note: 'n' });
    expect(screen.excluded.size).toBeGreaterThan(3);
    expect(performance.now() - started).toBeLessThan(timeBudgetMs(60));
  });
});

describe('dispose_margin on a singular row', () => {
  const bar = marginBar({ pointSupportsSingular: true });
  const query = { singularityRadius: 0.2, singularityNote: 'point support' };
  const signing: HumanSignaturePort = {
    verify: (signature, payload) =>
      isRecord(signature) && signature['payload'] === payload ? { signer: 'R', signatureId: 'sig-1' } : null,
  };
  const ctx: ExecutionContext = { ...bar.ctx, humanSignature: signing };

  it('is matched with the same query params and records the disposition under the |singular rowKey', () => {
    const rows = dataOf(margins(bar, query)).rows;
    const row = rows.find((candidate) => candidate.singular && candidate.status !== 'PASS');
    expect(row).toBeDefined();
    const resultsHash = caseIn(bar.recorded, bar.analysisId).results?.resultsHash ?? '';
    const payload = marginDispositionPayload(
      bar.analysisId,
      {
        rowKey: row?.rowKey ?? '',
        status: row?.status ?? '',
        ms: row?.ms ?? null,
        inputHash: analysisInputHash(bar.recorded, bar.analysisId, 'full'),
      },
      'accepted',
      'peak at a point support',
      resultsHash,
      bar.recorded.uid ?? '',
    );
    const done = execute(
      bar.recorded,
      'dispose_margin',
      {
        analysisId: bar.analysisId,
        ...STAND_IN_MESH,
        rowId: row?.rowId,
        decision: 'accepted',
        justification: 'peak at a point support',
        confirmation: { payload },
        ...query,
      },
      ctx,
    );
    expect(done.rejected).not.toBe(true);
    expect(Object.keys(caseIn(done.document, bar.analysisId).dispositions)).toEqual([row?.rowKey]);
  });

  it('refuses a radius override without a note', () => {
    const refused = execute(
      bar.recorded,
      'dispose_margin',
      {
        analysisId: bar.analysisId,
        rowId: 'r3',
        decision: 'accepted',
        justification: 'j',
        confirmation: { payload: 'x' },
        singularityRadius: 1,
      },
      ctx,
    );
    expect(refused.error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
  });

  it('check_analysis does not raise FEA_MS_NEGATIVE for a singular FAIL row', () => {
    const check = execute(bar.recorded, 'check_analysis', { analysisId: bar.analysisId, ...STAND_IN_MESH }, bar.ctx);
    const items = (check.data as { items: { code: string; ids: string[] }[] }).items;
    const negative = items.find((item) => item.code === 'FEA_MS_NEGATIVE');
    expect(negative?.ids.every((id) => id === bar.analysisId || !['r3', 'r4'].includes(id)) ?? true).toBe(true);
  });
});
