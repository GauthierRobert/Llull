/**
 * Plant 02 RTE M2: branches off a header run (`add_branch`, `delete_pipe_run` of branches). Expected numbers are hand calculations from the catalogue
 * stub: NPS 6 tee C = M = 143, 6x6x4 reducing tee C 143 / M 130, weldolet 6x2 outlet face 144 mm from the header centreline, NPS 4 tee 105,
 * NPS 6 pipe OD 168.3, NPS 4 114.3, NPS 3 88.9, NPS 2 60.3.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument, type RevolutionEntity } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, headerScene, rteJson, valveScene } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface BranchData {
  branchRunId: string;
  branchId: string;
  headerRunId: string;
  fitting: string;
  fittingCode: string;
  partId: string;
  headerDn: number;
  branchDn: number;
  position: number[];
  direction: number[];
  branchStartMm: number;
  branchStartSource: string;
  runCentreToEndMm: number | null;
  reviewRequired: boolean;
  pipePieces: Array<{ runId: string; dn: number; cutLengthMm: number }>;
}
interface Takeoff {
  counts: Record<string, number>;
  pipePieces: Array<{ runId: string; dn: number; cutLengthMm: number }>;
  branches: Array<{ id: string; kind: string; typeKey: string }>;
}

const cuts = (pieces: Array<{ cutLengthMm: number; dn?: number }>, dn?: number): number[] =>
  pieces.filter((piece) => dn === undefined || piece.dn === dn).map((piece) => piece.cutLengthMm);

describe('add_branch: tees and olets from the branch table (SC-RTE-03)', () => {
  const s = headerScene();
  const reducing = { runId: s.headerId, at: { point: [4000, 0, 3000] }, dn: 100, to: { portId: s.tieC } };

  it('picks the reducing tee 6x4: header pieces 3857 / 5857, branch piece 1870 (C 143, M 130)', () => {
    const result = data<BranchData>(s.doc, 'add_branch', reducing);
    expect(result).toMatchObject({
      fitting: 'reducingTee',
      fittingCode: 'RT',
      headerDn: 150,
      branchDn: 100,
      branchStartMm: 130,
      runCentreToEndMm: 143,
      position: [4000, 0, 3000],
      direction: [0, 1, 0],
      reviewRequired: false,
    });
    expect(result.branchStartSource).toContain('centreToEndBranch');
    // header: 4000 - 143 = 3857 ; 10000 - 4000 - 143 = 5857 ; branch: 2000 - 130 = 1870
    expect(cuts(result.pipePieces)).toEqual([3857, 5857, 1870]);
  });

  it('picks the weldolet 6x2 and leaves the header whole: the DN50 branch piece is 1000 - 144 = 856', () => {
    const result = data<BranchData>(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { point: [7000, 0, 3000] },
      dn: 50,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    expect(result).toMatchObject({
      fitting: 'weldolet',
      fittingCode: 'W',
      branchStartMm: 144,
      runCentreToEndMm: null,
      direction: [0, 0, 1],
    });
    expect(result.branchStartSource).toContain('centreToOutlet');
    expect(cuts(result.pipePieces)).toEqual([10000, 856]);
  });

  it('SC-RTE-03 end to end: 4 pieces, 1 tee, 1 olet, welds counted, one open end (the free DN50 branch)', () => {
    const withTee = apply(s.doc, 'add_branch', reducing);
    const both = apply(withTee, 'add_branch', {
      runId: s.headerId,
      at: { point: [7000, 0, 3000] },
      dn: 50,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const t = data<Takeoff>(both, 'piping_takeoff', { lineId: s.lineId });
    expect(t.counts).toMatchObject({ reducingTee: 1, weldolet: 1, pipePieces: 4 });
    expect(cuts(t.pipePieces, 150)).toEqual([3857, 5857]);
    expect(cuts(t.pipePieces, 100)).toEqual([1870]);
    expect(cuts(t.pipePieces, 50)).toEqual([856]);
    expect(t.branches.map((branch) => [branch.kind, branch.typeKey])).toEqual([
      ['tee', 'reducingTee'],
      ['olet', 'weldolet'],
    ]);
    const graph = data<{ openEnds: unknown[]; components: string[][] }>(both, 'piping_connectivity', { lineIds: [s.lineId] });
    expect(graph.openEnds).toHaveLength(1);
    expect(graph.components).toHaveLength(1);
    const checks = data<{ status: string; issues: Array<{ code: string }> }>(both, 'check_piping', { lineIds: [s.lineId] });
    expect(checks.issues.filter((issue) => issue.code === 'RTE_OPEN_END')).toHaveLength(1);
    expect(checks.status).toBe('warn');
  });

  it('stores the branch point on the header and a branch run whose start references it; affected = [branch run, branch point]', () => {
    const result = ok(s.doc, 'add_branch', reducing);
    const header = piping(result.document).runs[s.headerId] as PipeRun;
    const data1 = result.data as BranchData;
    expect(result.affected).toEqual([data1.branchRunId, data1.branchId]);
    expect(header.branches).toEqual([{ id: data1.branchId, leg: 0, distance: 4000, branchRunId: data1.branchRunId }]);
    const branch = piping(result.document).runs[data1.branchRunId] as PipeRun;
    expect(branch.dn).toBe(100);
    expect(branch.start.ref).toEqual({ kind: 'branch', runId: s.headerId, branchId: data1.branchId });
    expect(branch.end.ref).toEqual({ kind: 'tieIn', id: s.tieC });
    expect(branch.pis).toEqual([]);
  });

  it('accepts { leg, distance } in place of a point and gives the same result', () => {
    const byPoint = data<BranchData>(s.doc, 'add_branch', reducing);
    const byLeg = data<BranchData>(s.doc, 'add_branch', { ...reducing, at: { leg: 0, distance: 4000 } });
    expect(cuts(byLeg.pipePieces)).toEqual(cuts(byPoint.pipePieces));
  });

  it('draws the tee as two entities (header cylinder and branch stub) and the olet as one, none for the bolt sets', () => {
    const both = apply(apply(s.doc, 'add_branch', reducing), 'add_branch', {
      runId: s.headerId,
      at: { point: [7000, 0, 3000] },
      dn: 50,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const ids = piping(both).entityIds[s.headerId] as string[];
    expect(ids).toEqual(expect.arrayContaining([`${s.headerId}/tee-1`, `${s.headerId}/tee-1/branch`, `${s.headerId}/olet-1`]));
    const stub = both.entities[`${s.headerId}/tee-1/branch`] as RevolutionEntity;
    expect(stub.position).toEqual([4000, 0, 3000]);
    expect(stub.profile[2]?.[1]).toBeCloseTo(130, 9);
    expect(stub.profile[1]?.[0]).toBeCloseTo(57.15, 9);
    const olet = both.entities[`${s.headerId}/olet-1`] as RevolutionEntity;
    expect(olet.layerId).toBe('layer-P-FITT');
    expect(olet.profile[2]?.[1]).toBeCloseTo(144 - 84.15, 9);
  });

  it('is pure and deterministic: the input is untouched, a second run gives an identical document', () => {
    const before = structuredClone(s.doc);
    const first = execute(s.doc, 'add_branch', reducing);
    const second = execute(s.doc, 'add_branch', reducing);
    expect(s.doc).toEqual(before);
    expect(first.document).toEqual(second.document);
  });

  it('a load shows the same state: the saved file keeps the intent, the load re-derives identical branch entities', () => {
    const both = apply(apply(s.doc, 'add_branch', reducing), 'add_branch', {
      runId: s.headerId,
      at: { point: [7000, 0, 3000] },
      dn: 50,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const text = serializeDocument(both);
    expect(JSON.parse(text).document.entities).toEqual({});
    const loaded = deserializeDocument(text);
    expect(piping(loaded).entityIds).toEqual(piping(both).entityIds);
    for (const id of Object.values(piping(both).entityIds).flat()) expect(loaded.entities[id]).toEqual(both.entities[id]);
  });
});

describe('add_branch: other sizes and fittings', () => {
  it('an equal tee 6x6 has M = C = 143: header 3857 / 5857, branch 2000 - 143 = 1857', () => {
    const s = headerScene();
    const result = data<BranchData>(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { point: [4000, 0, 3000] },
      dn: 150,
      legs: [{ direction: '+Y', length: 2000 }],
    });
    expect(result).toMatchObject({ fitting: 'tee', fittingCode: 'T', branchStartMm: 143, runCentreToEndMm: 143 });
    expect(cuts(result.pipePieces)).toEqual([3857, 5857, 1857]);
  });

  it('the branch is a run of the header line by default, or of lineId; check_piping and the takeoff of the line include it', () => {
    const s = headerScene();
    const other = apply(s.doc, 'create_pipeline', { service: 'CW', sequence: '2002', spec: 'CS150', dn: 100 });
    const otherLine = piping(other).lineOrder.at(-1) as string;
    const result = data<BranchData>(other, 'add_branch', {
      runId: s.headerId,
      at: { point: [4000, 0, 3000] },
      dn: 100,
      to: { portId: s.tieC },
      lineId: otherLine,
    });
    const next = apply(other, 'add_branch', {
      runId: s.headerId,
      at: { point: [4000, 0, 3000] },
      dn: 100,
      to: { portId: s.tieC },
      lineId: otherLine,
    });
    expect((piping(next).runs[result.branchRunId] as PipeRun).lineId).toBe(otherLine);
    // Checking the header line pulls in the branch run of the other line, so the tee outlet is not reported open.
    const checks = data<{ runIds: string[]; issues: Array<{ code: string }> }>(next, 'check_piping', { lineIds: [s.lineId] });
    expect(checks.runIds).toEqual([s.headerId, result.branchRunId]);
    expect(checks.issues.some((issue) => issue.code === 'RTE_OPEN_END')).toBe(false);
  });

  it('a header that is reduced upstream uses the header size at the branch point: DN100 header after a 6x4 reducer takes an equal tee 4x4 (C 105)', () => {
    const line = cs150Line(150, '2001');
    const a = addTie(line.doc, 'HA', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const b = addTie(a.doc, 'HB', [10000, 0, 0], [-1, 0, 0], { dn: 100 });
    const routed = apply(b.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      to: { portId: b.id },
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    });
    const headerId = piping(routed).runOrder[0] as string;
    const result = data<BranchData>(routed, 'add_branch', {
      runId: headerId,
      at: { point: [7000, 0, 0] },
      dn: 100,
      legs: [{ direction: '+Y', length: 2000 }],
    });
    expect(result).toMatchObject({ headerDn: 100, branchDn: 100, fitting: 'tee', branchStartMm: 105 });
    // reducer 6x4 (140) at 3000: 2930 | 3070 -> 7000 - 105 = 3825 | 7105 -> 10000 = 2895 ; branch 2000 - 105 = 1895
    expect(cuts(result.pipePieces)).toEqual([2930, 3825, 2895, 1895]);
  });

  it('a branch can continue from the branch run end, but its start is taken (RTE_PORT_IN_USE)', () => {
    const s = headerScene();
    const next = apply(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { point: [7000, 0, 3000] },
      dn: 50,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const branchRun = piping(next).runOrder.at(-1) as string;
    const small = apply(next, 'create_pipeline', { service: 'CW', sequence: '2003', spec: 'CS150', dn: 50 });
    const smallLine = piping(small).lineOrder.at(-1) as string;
    const more = apply(small, 'route_pipe', {
      lineId: smallLine,
      from: { portId: `${branchRun}:end` },
      legs: [{ direction: '+Z', length: 500 }],
    });
    expect(piping(more).runOrder).toHaveLength(3);
    expectRefusal(
      small,
      'route_pipe',
      { lineId: smallLine, from: { portId: `${branchRun}:start` }, legs: [{ direction: '-Z', length: 500 }] },
      'RTE_PORT_IN_USE',
    );
  });
});

/** A catalogue and spec variation with the fittings the stub does not have: run-only tee, height-only olet, olet without dimension, sockolet, stub-in. */
function variantSpecDoc(): CadDocument {
  const catalog = {
    format: 'llull-piping-catalog',
    schemaVersion: 1,
    id: 'rte-branch-test',
    version: '1.0.0',
    licence: 'open-data',
    families: [
      {
        id: 'asme-b16.9-tee-run-only-test',
        type: 'tee',
        standard: 'ASME B16.9',
        dimensionalStandard: 'ASME',
        ends: ['BW'],
        sizes: [{ nps: 3, centreToEndRun: 86, provenance: { sourceId: 'S10', citation: 'tee NPS 3 C = M = 86 (run dimension only)' } }],
      },
      {
        id: 'mss-sp-97-weldolet-h-test',
        type: 'weldolet',
        standard: 'MSS SP-97',
        dimensionalStandard: 'ASME',
        ends: ['BW'],
        sizes: [
          { nps: 6, smallNps: 3, height: 60, provenance: { sourceId: 'test', citation: 'height 60 above the header surface' } },
          { nps: 6, smallNps: 4, outsideDiameter: 100, provenance: { sourceId: 'test', citation: 'olet without an outlet dimension' } },
        ],
      },
      {
        id: 'mss-sp-97-sockolet-test',
        type: 'sockolet',
        standard: 'MSS SP-97',
        dimensionalStandard: 'ASME',
        ends: ['SW'],
        sizes: [{ nps: 4, smallNps: 2, centreToOutlet: 100, provenance: { sourceId: 'test', citation: 'sockolet 4x2' } }],
      },
    ],
  };
  const spec = rteJson<{ components: unknown[]; branchTable: { cells: Record<string, Record<string, string>> } }>('spec_cs150.json');
  const variant = {
    ...spec,
    catalogs: ['rte-branch-test', 'rte-validation-stub', 'llull-open-piping'],
    components: [
      ...spec.components,
      { id: 'T-RUN', type: 'tee', fromNps: 3, toNps: 3, ends: 'BW', catalogRef: 'asme-b16.9-tee-run-only', priority: 50 },
      {
        id: 'W-H',
        type: 'weldolet',
        fromNps: 2,
        toNps: 6,
        branchFromNps: 3,
        branchToNps: 4,
        ends: 'BW',
        catalogRef: 'mss-sp-97-weldolet-h',
      },
      {
        id: 'S-SW',
        type: 'sockolet',
        fromNps: 2,
        toNps: 6,
        branchFromNps: 2,
        branchToNps: 2,
        ends: 'SW',
        catalogRef: 'mss-sp-97-sockolet',
      },
    ],
    branchTable: {
      system: 'NPS',
      cells: { '6': { '6': 'T', '4': 'W', '3': 'W', '2': 'W' }, '4': { '4': 'T', '3': 'SI', '2': 'S' }, '3': { '3': 'T' } },
    },
  };
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'import_piping_catalog', { catalog: rteJson('catalog_stub_cs150.json') });
  doc = apply(doc, 'import_piping_catalog', { catalog });
  return apply(doc, 'import_pipe_spec', { spec: variant });
}

/** A routed header of `dn` between two butt-weld tie-ins, 10000 mm long at z 3000, in the variant spec document. */
function variantHeader(dn: number): { doc: CadDocument; headerId: string } {
  let doc = apply(variantSpecDoc(), 'create_pipeline', { service: 'P', sequence: `${dn}`, spec: 'CS150', dn });
  const lineId = piping(doc).lineOrder[0] as string;
  const a = addTie(doc, 'TA', [0, 0, 3000], [1, 0, 0], { dn });
  const b = addTie(a.doc, 'TB', [10000, 0, 3000], [-1, 0, 0], { dn });
  doc = apply(b.doc, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
  return { doc, headerId: piping(doc).runOrder[0] as string };
}

describe('add_branch: catalogue variations', () => {
  it('an olet row with only a height: the outlet is header OD / 2 + height = 84.15 + 60 = 144.15, branch piece 1000 - 144.15 = 855.85', () => {
    const s = variantHeader(150);
    const result = data<BranchData>(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { point: [5000, 0, 3000] },
      dn: 80,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    expect(result.branchStartMm).toBeCloseTo(144.15, 9);
    expect(result.branchStartSource).toContain('height');
    expect(cuts(result.pipePieces)).toEqual([10000, expect.closeTo(855.85, 9)]);
  });

  it('an equal tee row with only the run dimension takes M = C (B16.9 equal tee) and says so: NPS 3 tee 86', () => {
    const s = variantHeader(80);
    const result = data<BranchData>(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { point: [5000, 0, 3000] },
      dn: 80,
      legs: [{ direction: '+Y', length: 1000 }],
    });
    expect(result).toMatchObject({ fitting: 'tee', branchStartMm: 86, runCentreToEndMm: 86 });
    expect(result.branchStartSource).toContain('equal tee: M = C');
    expect(cuts(result.pipePieces)).toEqual([4914, 4914, 914]);
  });

  it('a stub-in has no fitting: the branch pipe starts at the header surface (OD 114.3 / 2), review required, reported by check_piping', () => {
    const s = variantHeader(100);
    const result = data<BranchData>(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { point: [5000, 0, 3000] },
      dn: 80,
      legs: [{ direction: '+Y', length: 1000 }],
    });
    expect(result).toMatchObject({ fitting: 'stubIn', fittingCode: 'SI', reviewRequired: true });
    expect(result.branchStartMm).toBeCloseTo(57.15, 9);
    expect(cuts(result.pipePieces)).toEqual([10000, expect.closeTo(942.85, 9)]);
    const next = apply(s.doc, 'add_branch', {
      runId: s.headerId,
      at: { point: [5000, 0, 3000] },
      dn: 80,
      legs: [{ direction: '+Y', length: 1000 }],
    });
    const checks = data<{ reviewRequired: boolean; issues: Array<{ code: string; detail: Record<string, unknown> }> }>(
      next,
      'check_piping',
      {},
    );
    expect(checks.reviewRequired).toBe(true);
    expect(checks.issues.filter((issue) => issue.code === 'RTE_STUB_IN_REVIEW')).toHaveLength(1);
    // The stub-in is a part with no drawing: no entity of that id.
    expect(piping(next).entityIds[s.headerId]?.some((id) => id.includes('stubIn'))).toBe(false);
    const parts = data<{ parts: Array<{ kind: string }> }>(next, 'piping_takeoff', { runId: s.headerId }).parts;
    expect(parts.filter((part) => part.kind === 'stubIn')).toHaveLength(1);
  });

  it('refuses a sockolet (SW outlet) on a butt-weld branch pipe: RTE_NO_CONNECTION_RULE', () => {
    const s = variantHeader(100);
    expectRefusal(
      s.doc,
      'add_branch',
      { runId: s.headerId, at: { point: [5000, 0, 3000] }, dn: 50, legs: [{ direction: '+Y', length: 1000 }] },
      'RTE_NO_CONNECTION_RULE',
    );
  });

  it('refuses an olet row with neither centreToOutlet nor height: RTE_SPEC_NO_COMPONENT naming the row', () => {
    const s = variantHeader(150);
    const refused = expectRefusal(
      s.doc,
      'add_branch',
      { runId: s.headerId, at: { point: [5000, 0, 3000] }, dn: 100, legs: [{ direction: '+Y', length: 1000 }] },
      'RTE_SPEC_NO_COMPONENT',
    );
    expect(refused.summary).toContain('centreToOutlet');
  });
});

describe('add_branch: refusals leave the document unchanged', () => {
  const s = headerScene();
  const base = { runId: s.headerId, at: { point: [4000, 0, 3000] }, dn: 100, legs: [{ direction: '+Y', length: 2000 }] };

  it.each([
    ['unknown run', { ...base, runId: 'run-nope' }, 'RTE_UNKNOWN_RUN', 'runId'],
    ['unknown line', { ...base, lineId: 'line-nope' }, 'RTE_UNKNOWN_LINE', 'lineId'],
    ['a point off the header centreline', { ...base, at: { point: [4000, 50, 3000] } }, 'RTE_BRANCH_ON_FITTING', 'at'],
    ['a leg the header does not have', { ...base, at: { leg: 5, distance: 100 } }, 'RTE_BRANCH_ON_FITTING', 'at'],
    ['a branch size the table has no cell for (6 x 3)', { ...base, dn: 80 }, 'RTE_BRANCH_NO_TABLE_ROW', undefined],
    [
      'a branch along the header (0 deg, not perpendicular)',
      { ...base, legs: [{ direction: '+X', length: 2000 }] },
      'RTE_NO_FITTING_FOR_ANGLE',
      'legs.0.direction',
    ],
    ['a 45 deg branch', { ...base, legs: [{ direction: [1, 1, 0], length: 2000 }] }, 'RTE_NO_FITTING_FOR_ANGLE', 'legs.0.direction'],
    [
      'a tee 100 mm from the start (inside the tie-in weld)',
      { ...base, at: { point: [100, 0, 3000] } },
      'RTE_BRANCH_ON_FITTING',
      undefined,
    ],
    [
      'an olet 10 mm from the end of a piece',
      { runId: s.headerId, at: { point: [9990, 0, 3000] }, dn: 50, legs: [{ direction: '+Z', length: 1000 }] },
      'RTE_BRANCH_ON_FITTING',
      'branches',
    ],
    ['no direction (no legs, via or target)', { runId: s.headerId, at: { point: [4000, 0, 3000] }, dn: 100 }, 'RTE_ZERO_LEG', 'legs'],
    ['a port that is already used', { ...base, legs: undefined, to: { portId: s.tieA } }, 'RTE_PORT_IN_USE', undefined],
    ['an unknown target port', { ...base, legs: undefined, to: { portId: 'nowhere' } }, 'RTE_UNKNOWN_PORT', undefined],
    [
      'a target that is not on the branch axis',
      {
        ...base,
        legs: [
          { direction: '+Y', length: 500 },
          { direction: '+X', length: 200 },
        ],
        to: { portId: s.tieC },
      },
      'RTE_CLOSING_LEG_IMPOSSIBLE',
      undefined,
    ],
    [
      'a branch pipe too short for the tee (M 130)',
      { ...base, legs: [{ direction: '+Y', length: 100 }] },
      'RTE_SEGMENT_TOO_SHORT',
      undefined,
    ],
  ])('%s', (_name, params, code, path) => {
    expectRefusal(s.doc, 'add_branch', params, code, path);
  });

  it('refuses a target port of another size (DN150 port, DN100 branch)', () => {
    const big = addTie(s.doc, 'TP-4', [4000, 2000, 3000], [0, -1, 0], { dn: 150 });
    expectRefusal(big.doc, 'add_branch', { ...base, legs: undefined, to: { portId: big.id } }, 'RTE_SIZE_MISMATCH', 'to.portId');
  });

  it('refuses a document that is not in millimetres', () => {
    expectRefusal({ ...s.doc, units: 'in' as const }, 'add_branch', base, 'RTE_UNITS_UNSUPPORTED');
  });

  it('refuses a tee inside a valve and a valve on a tee (DN100 run of SC-RTE-02: valve 606.5 - 993.5 along leg 0)', () => {
    const v = valveScene();
    // equal tee 4x4 (C 105) at 800 spans 695 - 905: inside the valve
    const params = { runId: v.runId, at: { point: [0, 0, 1800] }, dn: 100, legs: [{ direction: '+X', length: 1000 }] };
    expectRefusal(v.doc, 'add_branch', params, 'RTE_BRANCH_ON_FITTING');
    // a tee at 1500 of the +Y leg (leg 1), then a valve on top of it
    const tee = apply(v.doc, 'add_branch', {
      runId: v.runId,
      at: { leg: 1, distance: 1500 },
      dn: 100,
      legs: [{ direction: '+X', length: 1000 }],
    });
    expectRefusal(
      tee,
      'insert_inline_component',
      { runId: v.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1500 } },
      'RTE_INLINE_DOES_NOT_FIT',
    );
  });
});

describe('delete_pipe_run with branches', () => {
  const s = headerScene();
  const withBranches = apply(
    apply(s.doc, 'add_branch', { runId: s.headerId, at: { point: [4000, 0, 3000] }, dn: 100, to: { portId: s.tieC } }),
    'add_branch',
    { runId: s.headerId, at: { point: [7000, 0, 3000] }, dn: 50, legs: [{ direction: '+Z', length: 1000 }] },
  );
  const [teeRun, oletRun] = piping(withBranches).runOrder.slice(1) as [string, string];

  it('refuses to delete the header while branches hang on it (RTE_HAS_BRANCHES lists them), nothing changes', () => {
    const refused = expectRefusal(withBranches, 'delete_pipe_run', { runId: s.headerId }, 'RTE_HAS_BRANCHES');
    expect(refused.error?.ids).toEqual([s.headerId, teeRun, oletRun]);
  });

  it('cascade deletes the header, its branches and every derived part', () => {
    const result = ok(withBranches, 'delete_pipe_run', { runId: s.headerId, cascade: true });
    expect(result.affected).toEqual([s.headerId, teeRun, oletRun]);
    expect(piping(result.document).runOrder).toEqual([]);
    expect(piping(result.document).entityIds).toEqual({});
    expect(Object.keys(result.document.entities)).toEqual([]);
    // The ports are free again.
    expect(
      ok(result.document, 'route_pipe', { lineId: s.lineId, from: { portId: s.tieA }, legs: [{ direction: '+X', length: 1000 }] }).rejected,
    ).toBeUndefined();
  });

  it('deleting a branch run removes its branch point and the tee: the header is one piece again, the other branch stays', () => {
    const result = ok(withBranches, 'delete_pipe_run', { runId: teeRun });
    const header = piping(result.document).runs[s.headerId] as PipeRun;
    expect(header.branches?.map((point) => point.branchRunId)).toEqual([oletRun]);
    const t = data<Takeoff>(result.document, 'piping_takeoff', { runId: s.headerId });
    expect(cuts(t.pipePieces)).toEqual([10000]);
    expect(piping(result.document).entityIds[s.headerId]?.some((id) => id.includes('tee'))).toBe(false);
    expect(result.summary).toContain(`header ${s.headerId} re-derived without the branch`);
    const last = ok(result.document, 'delete_pipe_run', { runId: oletRun });
    expect((piping(last.document).runs[s.headerId] as PipeRun).branches).toBeUndefined();
  });
});
