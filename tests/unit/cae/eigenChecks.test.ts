/** Modal / buckling hardening (FR-FEA-19 / 20): mass participation, rigid-body and buckling-factor guards, supports, adequacy, frequency band. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { eigenNote, eigenReport } from '@cae/results/eigenReport';
import { partAdequacy } from '@cae/results/adequacy';
import { partRestraints } from '@cae/results/restraint';
import { buildDeckContext, type DeckContext } from '@cae/decks/context';
import { bucklingDat, eigenCase, modalDat } from './eigenFixtures';
import { caseIn, run } from './helpers';
import { barDocument, barMesh, X0_NODES } from './deckFixtures';

const contextOf = (...args: Parameters<typeof buildDeckContext>): DeckContext => {
  const built = buildDeckContext(...args);
  if (built === null) throw new Error('no deck context');
  return built;
};

interface Check {
  status: string;
  items: { code: string; severity: string; ids: string[]; message: string; remediation: string }[];
}
const codesOf = (result: ReturnType<typeof execute>): string[] => (result.data as Check).items.map((entry) => entry.code);

const MASS = [
  [0.4, 0.0, 0.0],
  [0.0, 0.3, 0.0],
  [0.1, 0.0, 0.2],
] as const;
const PARTICIPATION = [
  [0.9, 0, 0],
  [0, 0.7, 0],
  [0.2, 0, 0.5],
] as const;

describe('modal mass tables of the .dat', () => {
  const dat = parseDat(modalDat([100, 200, 300], PARTICIPATION, MASS, [1, 1, 1]));

  it('are read next to the eigenvalue table: participation factors, effective modal mass, total effective mass', () => {
    expect(dat.tables.map((table) => table.title.split(' (')[0])).toEqual([
      'eigenvalues',
      'participation factors',
      'effective modal mass',
      'total effective mass',
    ]);
    expect(dat.tables[1]?.rows[2]).toEqual([3, 0.2, 0, 0.5]);
    expect(dat.tables[3]?.rows).toEqual([[1, 1, 1]]);
  });

  it('a heading without rows under it is dropped (the eigenvalue table is kept)', () => {
    const bare = parseDat(`${modalDat([100])}\n     P A R T I C I P A T I O N   F A C T O R S\n`);
    expect(bare.tables.map((table) => table.title.split(' (')[0])).toEqual(['eigenvalues']);
  });
});

describe('eigenReport', () => {
  it('modal: frequencies, participation, effective mass and its fraction of the total, cumulative share, mass unit', () => {
    const modal = eigenCase({ type: 'modal', dat: modalDat([100, 200, 300], PARTICIPATION, MASS, [1, 1, 1]) });
    const report = eigenReport(caseIn(modal.recorded, modal.bar.analysisId), modal.results as FeResultsArtifact);
    expect(report?.kind).toBe('modal');
    if (report?.kind !== 'modal') return;
    expect(report.modes.map((mode) => mode.frequencyHz)).toEqual([100, 200, 300]);
    expect(report.modes[0]?.participation).toEqual([0.9, 0, 0]);
    expect(report.modes[2]?.effectiveMass).toEqual([0.1, 0, 0.2]);
    expect(report.modes[2]?.effectiveMassFraction).toEqual([0.1, 0, 0.2]);
    expect(report.totalEffectiveMass).toEqual([1, 1, 1]);
    expect(report.cumulativeMassFraction?.map((share) => Number(share.toFixed(6)))).toEqual([0.5, 0.3, 0.2]);
    expect(report.massUnit).toBe('tonne');
    expect(report.rigidBodyModes).toBe(0);
    expect(eigenNote(report)).toContain('mass participation x/y/z 50% / 30% / 20%');
  });

  it('modal without mass tables keeps the frequencies only; rigid-body modes are counted from the frequencies', () => {
    const bare = eigenCase({ type: 'modal', dat: modalDat([0.0004, 0.0005, 1200, 3400]) });
    const report = eigenReport(caseIn(bare.recorded, bare.bar.analysisId), bare.results as FeResultsArtifact);
    expect(report).toMatchObject({ kind: 'modal', totalEffectiveMass: null, cumulativeMassFraction: null, rigidBodyModes: 2 });
    if (report?.kind === 'modal') {
      expect(report.modes[0]).not.toHaveProperty('participation');
      expect(eigenNote(report)).toContain('2 rigid-body mode(s)');
    }
  });

  it('buckling: critical factor = smallest positive, negative and near-zero factors counted', () => {
    const buckling = eigenCase({ type: 'buckling', load: true, dat: bucklingDat([-2.5, 0.0000001, 4.8, 7.1]) });
    const report = eigenReport(caseIn(buckling.recorded, buckling.bar.analysisId), buckling.results as FeResultsArtifact);
    expect(report).toMatchObject({ kind: 'buckling', criticalFactor: 4.8, criticalMode: 3, negativeFactors: 1, nearZeroFactors: 1 });
    expect(report !== null && eigenNote(report)).toContain('critical buckling load = 4.8 x the applied load (mode 3)');
  });

  it('is null for a static case and for results without the eigenvalue table', () => {
    const bare = eigenCase({ type: 'modal', dat: '' });
    expect(eigenReport(caseIn(bare.recorded, bare.bar.analysisId), bare.results as FeResultsArtifact)).toBeNull();
    const staticCase = barDocument();
    expect(eigenReport(caseIn(staticCase.doc, staticCase.analysisId), { kind: 'fe_results' } as never)).toBeNull();
    const noBuckling = eigenCase({ type: 'buckling', load: true, dat: '' });
    expect(eigenReport(caseIn(noBuckling.recorded, noBuckling.bar.analysisId), noBuckling.results as FeResultsArtifact)).toBeNull();
  });
});

describe('fea_report of eigenvalue analyses', () => {
  it('modal: data.eigen holds the modes with mass participation and the summary names the rigid-body modes', () => {
    const modal = eigenCase({ type: 'modal', dat: modalDat([0.0002, 120, 340], PARTICIPATION, MASS, [1, 1, 1]) });
    const result = execute(modal.recorded, 'fea_report', { analysisId: modal.bar.analysisId }, modal.ctx);
    const eigen = (result.data as { eigen: { kind: string; modes: unknown[]; rigidBodyModes: number } }).eigen;
    expect(eigen).toMatchObject({ kind: 'modal', rigidBodyModes: 1 });
    expect(eigen.modes).toHaveLength(3);
    expect(result.summary).toContain('1 rigid-body mode(s)');
    expect(result.document).toBe(modal.recorded);
  });

  it('buckling: data.eigen holds the critical factor; a static case has eigen null', () => {
    const buckling = eigenCase({ type: 'buckling', load: true, dat: bucklingDat([3.2, 5]) });
    const result = execute(buckling.recorded, 'fea_report', { analysisId: buckling.bar.analysisId }, buckling.ctx);
    expect((result.data as { eigen: unknown }).eigen).toMatchObject({ kind: 'buckling', criticalFactor: 3.2, criticalMode: 1 });
    expect(result.summary).toContain('critical buckling load = 3.2 x the applied load');
    const staticBar = barDocument();
    expect((execute(staticBar.doc, 'fea_report', { analysisId: staticBar.analysisId }).data as { eigen: unknown }).eigen).toBeNull();
  });

  it('describe_analysis names the frequencies of a verified modal result', () => {
    const modal = eigenCase({ type: 'modal', dat: modalDat([120, 340]) });
    const described = execute(modal.recorded, 'describe_analysis', { analysisId: modal.bar.analysisId }, modal.ctx);
    expect(described.summary).toContain('2 natural frequencies: 120, 340 Hz');
  });
});

describe('check_analysis: modal', () => {
  it('a modal analysis without a support is a free-free model: FEA_UNDERCONSTRAINED, no error', () => {
    const bar = barDocument({ analysisType: 'modal', supports: false });
    const result = execute(bar.doc, 'check_analysis', { analysisId: bar.analysisId });
    expect(codesOf(result)).toContain('FEA_UNDERCONSTRAINED');
    expect((result.data as Check).items.find((entry) => entry.code === 'FEA_UNDERCONSTRAINED')?.severity).toBe('warning');
    expect(codesOf(result)).not.toContain('FEA_NO_CONSTRAINTS');
  });

  it('loads are ignored by a modal analysis (warning), and rigid-body modes in the results are flagged', () => {
    const modal = eigenCase({ type: 'modal', fine: true, load: true, dat: modalDat([0.0001, 0.0002, 850, 2100]) });
    const result = execute(modal.recorded, 'check_analysis', { analysisId: modal.bar.analysisId }, modal.ctx);
    expect(codesOf(result)).toEqual(['FEA_LOADS_IGNORED', 'FEA_RIGID_BODY_MODES']);
    expect((result.data as Check).status).toBe('warn');
    expect((result.data as Check).items.every((entry) => entry.remediation.length > 0)).toBe(true);
  });

  it('a supported modal result on a fine mesh passes', () => {
    const modal = eigenCase({ type: 'modal', fine: true, dat: modalDat([850, 2100]) });
    const result = execute(modal.recorded, 'check_analysis', { analysisId: modal.bar.analysisId }, modal.ctx);
    expect((result.data as Check).status).toBe('pass');
  });
});

describe('check_analysis: buckling', () => {
  it('needs supports and a load; only the first load case is the reference', () => {
    const bare = barDocument({ analysisType: 'buckling', supports: false });
    expect(codesOf(execute(bare.doc, 'check_analysis', { analysisId: bare.analysisId }))).toEqual(
      expect.arrayContaining(['FEA_NO_CONSTRAINTS', 'FEA_NO_LOADS']),
    );
    const supported = barDocument({ analysisType: 'buckling' });
    let doc = supported.doc;
    for (const loadCase of ['LC1', 'LC2'])
      doc = execute(doc, 'add_fea_load', {
        analysisId: supported.analysisId,
        name: loadCase,
        kind: 'force',
        loadCase,
        vector: [-1, 0, 0],
        target: { entityId: supported.boxId, facesNear: [[2, 0.5, 0.5]] },
      }).document;
    const result = execute(doc, 'check_analysis', { analysisId: supported.analysisId });
    const ignored = (result.data as Check).items.find((entry) => entry.code === 'FEA_BUCKLING_LOAD_CASE_IGNORED');
    expect(ignored?.message).toContain("first load case 'LC1'");
    expect(ignored?.message).toContain('LC2 ignored');
  });

  it.each([
    ['negative factors', [-3, 4, 6], ['FEA_BUCKLING_NEGATIVE_FACTOR']],
    ['a factor below 1', [0.6, 4], ['FEA_BUCKLING_BELOW_APPLIED']],
    ['numerically zero factors', [0.0000001, 5], ['FEA_BUCKLING_NEAR_ZERO']],
    ['no positive factor', [-2, -5], ['FEA_BUCKLING_NEGATIVE_FACTOR', 'FEA_BUCKLING_NO_POSITIVE']],
    ['healthy factors', [3.1, 4.5], []],
  ])('guards %s', (_name, factors, expected) => {
    const buckling = eigenCase({ type: 'buckling', fine: true, load: true, dat: bucklingDat(factors) });
    const result = execute(buckling.recorded, 'check_analysis', { analysisId: buckling.bar.analysisId }, buckling.ctx);
    expect(codesOf(result)).toEqual(expected);
    expect((result.data as Check).status).toBe(
      expected.length === 0
        ? 'pass'
        : expected.some((code) => ['FEA_BUCKLING_NEAR_ZERO', 'FEA_BUCKLING_NO_POSITIVE'].includes(code))
          ? 'fail'
          : 'warn',
    );
  });
});

describe('supports and mesh adequacy from the mesh artifact', () => {
  it('a single fixed point removes 3 of 6 rigid-body motions; a fixed face removes all 6', () => {
    const bar = barDocument({ analysisType: 'static', supports: false });
    const one = execute(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'pin',
      kind: 'fixed',
      target: { entityId: bar.boxId, pointsNear: [[0, 0, 0]] },
    });
    const key = `C_${one.affected[0]}`;
    const ctx = contextOf(one.document, bar.analysisId, barMesh(one.document, bar.analysisId, bar.boxId, { [key]: [1] }));
    expect(partRestraints(ctx)).toEqual([{ entityId: bar.boxId, rank: 3, restrainedDofs: 3 }]);
    const face = contextOf(one.document, bar.analysisId, barMesh(one.document, bar.analysisId, bar.boxId, { [key]: X0_NODES }));
    expect(partRestraints(face)[0]).toMatchObject({ rank: 6, restrainedDofs: 12 });
    const edge = contextOf(one.document, bar.analysisId, barMesh(one.document, bar.analysisId, bar.boxId, { [key]: [1, 3] }));
    expect(partRestraints(edge)[0]?.rank).toBe(5);
  });

  it('a symmetry plane restrains its normal only; displacement dofs count; rotational dofs and unknown nodes do not', () => {
    const bar = barDocument({ analysisType: 'static', supports: false });
    const symmetric = execute(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'sym',
      kind: 'symmetry',
      target: { entityId: bar.boxId, facesNear: [[0, 0.5, 0.5]] },
    });
    const key = `C_${symmetric.affected[0]}`;
    const ctx = contextOf(symmetric.document, bar.analysisId, barMesh(symmetric.document, bar.analysisId, bar.boxId, { [key]: X0_NODES }));
    expect(partRestraints(ctx)[0]).toMatchObject({ rank: 3, restrainedDofs: 4 });
    const missing = contextOf(symmetric.document, bar.analysisId, barMesh(symmetric.document, bar.analysisId, bar.boxId, { [key]: [999] }));
    expect(partRestraints(missing)[0]).toMatchObject({ rank: 0, restrainedDofs: 0 });
    const none = contextOf(symmetric.document, bar.analysisId, barMesh(symmetric.document, bar.analysisId, bar.boxId, {}));
    expect(partRestraints(none)[0]?.rank).toBe(0);
  });

  it('check_analysis warns FEA_UNDERCONSTRAINED for a part held by one point, naming the rank; a fixed face does not', () => {
    const pinned = eigenCase({ type: 'modal', fine: true, support: 'point', dat: modalDat([850, 2100]) });
    const result = execute(pinned.recorded, 'check_analysis', { analysisId: pinned.bar.analysisId }, pinned.ctx);
    expect(codesOf(result)).toEqual(['FEA_UNDERCONSTRAINED']);
    expect((result.data as Check).items[0]?.message).toContain('remove 3 of 6 rigid-body motions (3 restrained dofs)');
    const free = eigenCase({ type: 'modal', fine: true, support: 'none', dat: modalDat([850, 2100]) });
    expect(codesOf(execute(free.recorded, 'check_analysis', { analysisId: free.bar.analysisId }, free.ctx))).toEqual([
      'FEA_UNDERCONSTRAINED',
    ]);
  });

  it('mesh adequacy: a fine bar has 2+ edges across its thinnest side, the 6-tet bar does not', () => {
    const fine = eigenCase({ type: 'modal', fine: true });
    expect(partAdequacy(fine.mesh)[0]?.elementsAcross).toBeGreaterThan(2);
    const coarse = eigenCase({ type: 'modal' });
    const [part] = partAdequacy(coarse.mesh);
    expect(part?.elementsAcross).toBeLessThan(1);
    expect(part?.thinnestExtent).toBe(1);
    const warned = execute(coarse.recorded, 'check_analysis', { analysisId: coarse.bar.analysisId }, coarse.ctx);
    expect((warned.data as Check).items.find((entry) => entry.code === 'FEA_MESH_ADEQUACY')?.message).toContain(
      'element edge(s) across its thinnest',
    );
  });

  it('adequacy skips tets that reference a missing node and parts without elements', () => {
    const fine = eigenCase({ type: 'modal', fine: true });
    expect(partAdequacy({ ...fine.mesh, blocks: [] })).toEqual([]);
    const broken = {
      ...fine.mesh,
      blocks: [{ ...(fine.mesh.blocks[0] as never as { type: 'C3D4'; entityId: string }), elements: [[1, 1, 2, 3, 99999]] }],
    };
    expect(partAdequacy(broken)).toEqual([]);
  });
});

describe('create_analysis frequencyRangeHz and the modal deck', () => {
  const empty = barDocument().doc;

  it('stores the band, names it in the summary and writes `n, min, max` on the *FREQUENCY data line', () => {
    const created = run(empty, 'create_analysis', {
      name: 'band',
      analysisType: 'modal',
      modes: 8,
      frequencyRangeHz: { min: 100, max: 2000 },
    });
    expect(created.summary).toContain('8 mode(s) in 100-2000 Hz');
    const id = created.affected[0] ?? '';
    expect(caseIn(created.document, id).frequencyRangeHz).toEqual({ min: 100, max: 2000 });
    const lowOnly = run(empty, 'create_analysis', { name: 'low', analysisType: 'modal', frequencyRangeHz: { min: 50 } });
    expect(caseIn(lowOnly.document, lowOnly.affected[0] ?? '').frequencyRangeHz).toEqual({ min: 50 });
    const highOnly = run(empty, 'create_analysis', { name: 'high', analysisType: 'modal', frequencyRangeHz: { max: 900 } });
    expect(highOnly.summary).toContain('in 0-900 Hz');
  });

  it('refuses a band on other types, an empty or inverted band, and a negative minimum', () => {
    expect(run(empty, 'create_analysis', { name: 's', analysisType: 'static', frequencyRangeHz: { min: 1, max: 2 } }).error?.code).toBe(
      'FEA_PARAM_NOT_APPLICABLE',
    );
    for (const band of [{}, { min: 500, max: 100 }, { min: -1 }, { max: 0 }, { min: 10, max: 10 }])
      expect(run(empty, 'create_analysis', { name: 'm', analysisType: 'modal', frequencyRangeHz: band }).error?.code).toBe(
        'FEA_PARAM_INVALID',
      );
  });

  const deckLine = (band: Record<string, number> | undefined): string => {
    const modal = eigenCase({ type: 'modal', fine: true });
    const withBand =
      band === undefined
        ? modal.doc
        : {
            ...modal.doc,
            analysis: {
              ...(modal.doc.analysis as NonNullable<typeof modal.doc.analysis>),
              cases: {
                ...(modal.doc.analysis?.cases ?? {}),
                [modal.bar.analysisId]: { ...caseIn(modal.doc, modal.bar.analysisId), frequencyRangeHz: band },
              },
            },
          };
    const mesh = { ...modal.mesh, inputHash: analysisInputHash(withBand, modal.bar.analysisId, 'mesh') };
    const written = writeInp(withBand, modal.bar.analysisId, mesh);
    const text = 'text' in written ? written.text : JSON.stringify(written);
    return text.split('\n')[text.split('\n').indexOf('*FREQUENCY') + 1] ?? '';
  };

  it('writes the data line: n, n, min, max, n, min, and n, , max', () => {
    expect(deckLine(undefined)).toBe('6');
    expect(deckLine({ min: 100, max: 2000 })).toBe('6, 100, 2000');
    expect(deckLine({ min: 100 })).toBe('6, 100');
    expect(deckLine({ max: 900 })).toBe('6, , 900');
  });

  it('the band changes the input hash; no band leaves it unchanged', () => {
    const modal = eigenCase({ type: 'modal' });
    const base = analysisInputHash(modal.doc, modal.bar.analysisId, 'full');
    const banded = {
      ...modal.doc,
      analysis: {
        ...(modal.doc.analysis as NonNullable<typeof modal.doc.analysis>),
        cases: {
          ...(modal.doc.analysis?.cases ?? {}),
          [modal.bar.analysisId]: { ...caseIn(modal.doc, modal.bar.analysisId), frequencyRangeHz: { min: 1 } },
        },
      },
    };
    expect(analysisInputHash(banded, modal.bar.analysisId, 'full')).not.toBe(base);
    expect(analysisInputHash(banded, modal.bar.analysisId, 'mesh')).toBe(analysisInputHash(modal.doc, modal.bar.analysisId, 'mesh'));
  });

  it('a free-free modal deck is written (no *BOUNDARY); a free buckling deck is refused', () => {
    const free = barDocument({ analysisType: 'modal', supports: false });
    const written = writeInp(free.doc, free.analysisId, barMesh(free.doc, free.analysisId, free.boxId, {}));
    const text = 'text' in written ? written.text : JSON.stringify(written);
    expect(text).toContain('*FREQUENCY');
    expect(text).not.toContain('*BOUNDARY');
    const buckling = barDocument({ analysisType: 'buckling', supports: false });
    expect(writeInp(buckling.doc, buckling.analysisId, barMesh(buckling.doc, buckling.analysisId, buckling.boxId, {}))).toMatchObject({
      code: 'FEA_NO_CONSTRAINTS',
    });
  });
});
