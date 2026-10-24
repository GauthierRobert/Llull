/**
 * Plant 02 RTE M2: inline components from other catalogue rows (welded valves, wafer / mismatched / incomplete rows) and stored runs that no longer
 * derive (a hand-edited or stale document): every case ends in a coded failure or a hand-calculated cut, never a throw.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { addTie, headerScene, rteJson } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

const valve = (id: string, type: string, ends: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  id,
  type,
  standard: 'ASME B16.10',
  dimensionalStandard: 'ASME',
  ends: [ends],
  sizes: [{ nps: 4, ...extra, provenance: { sourceId: 'test', citation: 'test input' } }],
});

const VALVE_CATALOG = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'rte-valve-test',
  version: '1.0.0',
  licence: 'open-data',
  families: [
    valve('asme-b16.10-ball-bw-test', 'valveBall', 'BW', { faceToFace: 300 }),
    valve('asme-b16.10-bfly-wafer-test', 'valveButterfly', 'WAF', { faceToFace: 60 }),
    valve('asme-b16.10-plug-300-test', 'valvePlug', 'FL', { class: 300, facing: 'RF', faceToFace: 292 }),
    valve('asme-b16.10-check-ff-test', 'valveCheck', 'FL', { class: 150, facing: 'FF', faceToFace: 200 }),
    valve('asme-b16.10-globe-nolen-test', 'valveGlobe', 'FL', { class: 150, facing: 'RF', stemHeight: 100 }),
    {
      id: 'asme-b16.9-reducer-nolen-test',
      type: 'reducerConcentric',
      standard: 'ASME B16.9',
      dimensionalStandard: 'ASME',
      ends: ['BW'],
      sizes: [{ nps: 6, smallNps: 3, outsideDiameter: 1, provenance: { sourceId: 'test', citation: 'reducer row without a length' } }],
    },
  ],
};

/** CS150 with extra valve components; a DN100 run A -> +X 2000 -> +Y 2000 on it. */
function variantRun(): { doc: CadDocument; runId: string; lineId: string } {
  const component = (id: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    type,
    fromNps: 2,
    toNps: 6,
    catalogRef: `asme-b16.10-${extra['ref'] as string}`,
    ...(extra['ends'] === undefined ? {} : { ends: extra['ends'] }),
    ...(extra['class'] === undefined ? {} : { class: extra['class'] }),
    ...(extra['facing'] === undefined ? {} : { facing: extra['facing'] }),
  });
  const spec = rteJson<{ components: unknown[] }>('spec_cs150.json');
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'import_piping_catalog', { catalog: rteJson('catalog_stub_cs150.json') });
  doc = apply(doc, 'import_piping_catalog', { catalog: VALVE_CATALOG });
  doc = apply(doc, 'import_pipe_spec', {
    spec: {
      ...spec,
      catalogs: ['rte-valve-test', 'rte-validation-stub', 'llull-open-piping'],
      components: [
        ...spec.components,
        component('V-BALL', 'valveBall', { ref: 'ball-bw', ends: 'BW' }),
        component('V-BFLY', 'valveButterfly', { ref: 'bfly-wafer', ends: 'WAF' }),
        component('V-PLUG', 'valvePlug', { ref: 'plug-300', ends: 'FL', class: 300, facing: 'RF' }),
        component('V-CHK', 'valveCheck', { ref: 'check-ff', ends: 'FL', class: 150, facing: 'FF' }),
        component('V-GLB', 'valveGlobe', { ref: 'globe-nolen', ends: 'FL', class: 150, facing: 'RF' }),
      ],
    },
  });
  doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '1', spec: 'CS150', dn: 100 });
  const lineId = piping(doc).lineOrder[0] as string;
  const a = addTie(doc, 'A', [0, 0, 0], [1, 0, 0]);
  doc = apply(a.doc, 'route_pipe', {
    lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 2000 },
      { direction: '+Y', length: 2000 },
    ],
  });
  return { doc, runId: piping(doc).runOrder[0] as string, lineId };
}

describe('inline components from other catalogue rows', () => {
  const s = variantRun();
  const at = { leg: 0, centreDistance: 1000 };

  it('a welded (BW) valve takes no flange sets: face-to-face 300 at 1000 -> pieces 850 / 698, parts pipe, valve, pipe', () => {
    const result = data<{ legCutLengthsMm: number[]; partIds: string[] }>(s.doc, 'insert_inline_component', {
      runId: s.runId,
      type: 'valveBall',
      at,
    });
    // valve 850 - 1150 along the leg: piece 1 = 850 (open start), piece 2 = 1848 - 1150 = 698
    expect(result.legCutLengthsMm).toEqual([850, 698]);
    expect(result.partIds).toEqual([`${s.runId}/valve-1`]);
    const next = apply(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveBall', at });
    const counts = data<{ counts: Record<string, number> }>(next, 'piping_takeoff', { runId: s.runId }).counts;
    expect(counts).toMatchObject({ valveBall: 1, buttWelds: 5, flangedJoints: 0 });
    expect(counts['flangeWeldNeck']).toBeUndefined();
  });

  it.each([
    ['a wafer valve (no WAF-WAF connection rule)', 'valveButterfly', 'RTE_NO_CONNECTION_RULE'],
    ['a Class 300 valve in a Class 150 spec', 'valvePlug', 'RTE_RATING_MISMATCH'],
    ['a flat-face valve on raised-face flanges', 'valveCheck', 'RTE_FACING_MISMATCH'],
    ['a valve row without a face-to-face dimension', 'valveGlobe', 'RTE_SPEC_NO_COMPONENT'],
  ])('refuses %s', (_name, type, code) => {
    expectRefusal(s.doc, 'insert_inline_component', { runId: s.runId, type, at }, code);
  });

  it('names the missing dimension of a row that lacks the face-to-face length', () => {
    const refused = expectRefusal(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGlobe', at }, 'RTE_SPEC_NO_COMPONENT');
    expect(refused.summary).toContain('faceToFace');
  });

  it('refuses a reducer row without a length (6x3), naming it', () => {
    const line = apply(s.doc, 'create_pipeline', { service: 'P', sequence: '6', spec: 'CS150', dn: 150 });
    const lineId = piping(line).lineOrder.at(-1) as string;
    const a = addTie(line, 'B', [0, 5000, 0], [1, 0, 0], { dn: 150 });
    const routed = apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 4000 }] });
    const runId = piping(routed).runOrder.at(-1) as string;
    const refused = expectRefusal(
      routed,
      'insert_inline_component',
      { runId, type: 'reducerConcentric', dn2: 80, at: { leg: 0, centreDistance: 2000 } },
      'RTE_SPEC_NO_COMPONENT',
    );
    expect(refused.summary).toContain('length');
  });
});

describe('stored runs that no longer derive give coded failures', () => {
  const s = variantRun();
  const run = (): PipeRun => piping(s.doc).runs[s.runId] as PipeRun;
  const failure = (doc: CadDocument, edited: PipeRun): { code: string; message: string } => {
    const result = deriveRun(doc, edited);
    if (result.ok) throw new Error('expected a failure');
    return result;
  };

  it('an inline type the model cannot place (a coupling) is RTE_SPEC_NO_COMPONENT', () => {
    const edited = { ...run(), inline: [{ id: 'c-1', type: 'coupling', leg: 0, centreDistance: 500 }] };
    expect(failure(s.doc, edited).code).toBe('RTE_SPEC_NO_COMPONENT');
  });

  it('an inline component on a leg or at a distance the run does not have is RTE_INLINE_DOES_NOT_FIT', () => {
    expect(failure(s.doc, { ...run(), inline: [{ id: 'v-1', type: 'valveBall', leg: 7, centreDistance: 500 }] }).code).toBe(
      'RTE_INLINE_DOES_NOT_FIT',
    );
    expect(failure(s.doc, { ...run(), inline: [{ id: 'v-1', type: 'valveBall', leg: 0, centreDistance: 5000 }] }).code).toBe(
      'RTE_INLINE_DOES_NOT_FIT',
    );
  });
});

describe('stored branches that no longer derive give coded failures', () => {
  const h = headerScene();
  const both = apply(
    apply(h.doc, 'add_branch', { runId: h.headerId, at: { point: [4000, 0, 3000] }, dn: 100, to: { portId: h.tieC } }),
    'add_branch',
    { runId: h.headerId, at: { point: [7000, 0, 3000] }, dn: 50, legs: [{ direction: '+Z', length: 1000 }] },
  );
  const [teeRun, oletRun] = piping(both).runOrder.slice(1) as [string, string];
  const edit = (change: (model: PipingModel) => PipingModel): CadDocument => ({
    ...both,
    plant: { ...both.plant, piping: change(piping(both)) },
  });
  const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
  const run = (doc: CadDocument, id: string): PipeRun => piping(doc).runs[id] as PipeRun;
  const code = (doc: CadDocument, id: string): string => {
    const result = deriveRun(doc, run(doc, id));
    return result.ok ? 'ok' : result.code;
  };

  it('a branch point whose branch run is gone: the header is RTE_UNKNOWN_RUN, and so is the other branch (it reads the header)', () => {
    const doc = edit((model) => ({
      ...model,
      runs: without(model.runs, oletRun),
      runOrder: model.runOrder.filter((id) => id !== oletRun),
    }));
    expect(code(doc, h.headerId)).toBe('RTE_UNKNOWN_RUN');
    const result = deriveRun(doc, run(doc, teeRun));
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain(`header ${h.headerId}:`);
  });

  it('a branch point outside its leg is RTE_BRANCH_ON_FITTING', () => {
    const doc = edit((model) => {
      const header = model.runs[h.headerId] as PipeRun;
      const points = (header.branches ?? []).map((point) => (point.branchRunId === teeRun ? { ...point, distance: 99999 } : point));
      return { ...model, runs: { ...model.runs, [h.headerId]: { ...header, branches: points } } };
    });
    expect(code(doc, h.headerId)).toBe('RTE_BRANCH_ON_FITTING');
  });

  it('a branch run without a start direction is RTE_INVALID_PORT; a branch size outside the spec range is RTE_SPEC_NO_COMPONENT', () => {
    const noDirection = edit((model) => {
      const branch = model.runs[oletRun] as PipeRun;
      const { direction, ...start } = branch.start;
      void direction;
      return { ...model, runs: { ...model.runs, [oletRun]: { ...branch, start } } };
    });
    expect(code(noDirection, h.headerId)).toBe('RTE_INVALID_PORT');
    const tiny = edit((model) => ({ ...model, runs: { ...model.runs, [oletRun]: { ...(model.runs[oletRun] as PipeRun), dn: 25 } } }));
    expect(code(tiny, h.headerId)).toBe('RTE_SPEC_NO_COMPONENT');
  });

  it('a header whose branch table lost the cell: RTE_BRANCH_NO_TABLE_ROW for the header and for the branch run', () => {
    const specs = both.plant?.spec?.specs ?? {};
    const latest = (specs['CS150'] ?? [])[0];
    if (latest === undefined || both.plant?.spec === undefined) throw new Error('no spec');
    const doc: CadDocument = {
      ...both,
      plant: {
        ...both.plant,
        spec: {
          ...both.plant.spec,
          specs: { ...specs, CS150: [{ ...latest, branchTable: { system: 'NPS', cells: { '6': { '6': 'T' } } } }] },
        },
      },
    };
    expect(code(doc, h.headerId)).toBe('RTE_BRANCH_NO_TABLE_ROW');
    expect(code(doc, teeRun)).toBe('RTE_BRANCH_NO_TABLE_ROW');
  });
});
