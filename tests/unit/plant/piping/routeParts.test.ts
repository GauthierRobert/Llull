/** Run derivation (02 RTE §2): the failures of a stored run whose document changed under it, and the unverified bookkeeping. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import type { DerivationFailure, RunDerivation } from '@aec/plant/piping/deriveTypes';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { apply } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, rteJson, routedPumpToVessel } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

/** `doc` with run `runId` replaced by `change(run)`. */
function withRun(doc: CadDocument, runId: string, change: (run: PipeRun) => PipeRun): CadDocument {
  const model = piping(doc);
  const run = model.runs[runId] as PipeRun;
  return { ...doc, plant: { ...doc.plant, piping: { ...model, runs: { ...model.runs, [runId]: change(run) } } } };
}

const failure = (result: RunDerivation | DerivationFailure): DerivationFailure => {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  return result as DerivationFailure;
};

/** One BW run A -> +X 2000 -> +Y 2000 (one elbow, two pieces). */
function simple(): { doc: CadDocument; runId: string; lineId: string; tie: string } {
  const { doc: withLine, lineId } = cs150Line();
  const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
  const doc = apply(a.doc, 'route_pipe', {
    lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 2000 },
      { direction: '+Y', length: 2000 },
    ],
  });
  return { doc, runId: piping(doc).runOrder[0] as string, lineId, tie: a.id };
}

describe('deriveRun on a stored run', () => {
  it('derives parts, joints, turns and legs in route order for the simple run', () => {
    const { doc, runId } = simple();
    const derived = deriveRun(doc, piping(doc).runs[runId] as PipeRun);
    if (!derived.ok) throw new Error(derived.message);
    expect(derived.parts.map((part) => part.id.split('/')[1])).toEqual(['pipe-1', 'elbow-1', 'pipe-2']);
    // Weld to the tie-in, pipe-elbow, elbow-pipe; the far end is open, so it has no joint.
    expect(derived.joints.map((joint) => joint.kind)).toEqual(['buttWeld', 'buttWeld', 'buttWeld']);
    expect(derived.legs.map((leg) => leg.cutLengthsMm)).toEqual([[1848], [1848]]);
    expect(derived.turns).toHaveLength(1);
    expect(derived.pipe).toMatchObject({ outsideDiameterMm: 114.3, wallMm: 6.02 });
    expect(derived.studs).toBe(0);
  });

  it('refuses a run of an unknown line, an unknown spec and a DN the spec has no pipe for', () => {
    const { doc, runId } = simple();
    expect(failure(deriveRun(doc, { ...(piping(doc).runs[runId] as PipeRun), lineId: 'line-nope' })).code).toBe('RTE_UNKNOWN_LINE');
    const noSpec = { ...doc, plant: { ...doc.plant, spec: { specs: {}, specOrder: [] } } };
    expect(failure(deriveRun(noSpec, piping(doc).runs[runId] as PipeRun)).code).toBe('RTE_SPEC_UNKNOWN');
    const bigLine: CadDocument = {
      ...doc,
      plant: {
        ...doc.plant,
        piping: {
          ...piping(doc),
          lines: Object.fromEntries(Object.entries(piping(doc).lines).map(([id, line]) => [id, { ...line, dn: 700 }])),
        },
      },
    };
    expect(failure(deriveRun(bigLine, piping(doc).runs[runId] as PipeRun)).code).toBe('RTE_SPEC_NO_COMPONENT');
  });

  it('refuses a pipe row without outside diameter / wall (a catalogue that only gives the OD)', () => {
    const { doc: base, lineId } = cs150Line();
    const odOnly = {
      format: 'llull-piping-catalog',
      schemaVersion: 1,
      id: 'od-only',
      licence: 'open-data',
      families: [
        {
          id: 'asme-b36.10m-od-only',
          type: 'pipe',
          standard: 'ASME B36.10M',
          sizes: [{ nps: 4, schedule: '40', outsideDiameter: 114.3, provenance: { citation: 'test' } }],
        },
      ],
    };
    const spec = { ...rteJson<Record<string, unknown>>('spec_cs150.json'), id: 'OD-ONLY', catalogs: ['od-only'] };
    const doc = apply(apply(base, 'import_piping_catalog', { catalog: odOnly }), 'import_pipe_spec', { spec });
    const line = apply(doc, 'create_pipeline', { service: 'P', sequence: '77', spec: 'OD-ONLY', dn: 100 });
    // The line cannot even be created without the wall; a stored line on that spec derives to the same refusal.
    expect(line.plant?.piping?.lineOrder).toHaveLength(2);
    const lines = piping(line).lines;
    const run: PipeRun = { id: 'run-x', lineId: lineId, start: { point: [0, 0, 0] }, end: { point: [1000, 0, 0] }, pis: [] };
    const odLine = { ...(lines[lineId] as NonNullable<(typeof lines)[string]>), spec: 'OD-ONLY' };
    const patched = {
      ...line,
      plant: { ...line.plant, piping: { ...piping(line), lines: { ...lines, [lineId]: odLine } } },
    } as CadDocument;
    const result = failure(deriveRun(patched, run));
    expect(result.code).toBe('RTE_SPEC_NO_COMPONENT');
    expect(result.message).toContain('wall');
  });

  it('refuses stored geometry that no longer fits: zero leg, 60 degree turn, short leg', () => {
    const { doc, runId } = simple();
    const zero = withRun(doc, runId, (run) => ({ ...run, pis: [run.end.point] }));
    const zeroFailure = failure(deriveRun(zero, piping(zero).runs[runId] as PipeRun));
    expect(zeroFailure.code).toBe('RTE_ZERO_LEG');
    expect(zeroFailure.paths).toEqual(['legs.1']);
    const sixty = withRun(doc, runId, (run) => ({ ...run, pis: [[2000, 0, 0]], end: { point: [3000, 1732.050808, 0] } }));
    const angle = failure(deriveRun(sixty, piping(sixty).runs[runId] as PipeRun));
    expect(angle.code).toBe('RTE_NO_FITTING_FOR_ANGLE');
    expect(angle.paths).toEqual(['legs.1']);
    const short = withRun(doc, runId, (run) => ({
      ...run,
      pis: [
        [2000, 0, 0],
        [2000, 250, 0],
      ],
      end: { point: [4000, 250, 0] },
    }));
    const tooShort = failure(deriveRun(short, piping(short).runs[runId] as PipeRun));
    expect(tooShort.code).toBe('RTE_SEGMENT_TOO_SHORT');
    expect(tooShort.paths).toEqual(['legs.1']);
    expect(tooShort.ids).toEqual([runId, `${runId}/elbow-1`, `${runId}/elbow-2`]);
    expect(tooShort.detail).toMatchObject({ cutLengthMm: -54, leg: 1 });
    const empty = withRun(doc, runId, (run) => ({ ...run, pis: [], end: { point: run.start.point } }));
    expect(failure(deriveRun(empty, piping(empty).runs[runId] as PipeRun)).code).toBe('RTE_ZERO_LEG');
  });

  it('refuses a run whose port disappeared or changed size since it was routed', () => {
    const { doc, runId, tie } = simple();
    const model = piping(doc);
    const { [tie]: gone, ...tieIns } = model.tieIns;
    expect(gone).toBeDefined();
    const missing: CadDocument = { ...doc, plant: { ...doc.plant, piping: { ...model, tieIns } } };
    const unknown = failure(deriveRun(missing, model.runs[runId] as PipeRun));
    expect(unknown.code).toBe('RTE_UNKNOWN_PORT');
    expect(unknown.paths).toEqual(['start']);
    const resized: CadDocument = {
      ...doc,
      plant: {
        ...doc.plant,
        piping: {
          ...model,
          tieIns: {
            ...tieIns,
            [tie]: { ...(gone as NonNullable<typeof gone>), port: { ...(gone as NonNullable<typeof gone>).port, dn: 50 } },
          },
        },
      },
    };
    expect(failure(deriveRun(resized, model.runs[runId] as PipeRun)).code).toBe('RTE_SIZE_MISMATCH');
  });

  it('a flanged first leg shorter than gasket + hub + elbow is too short, naming the parts (not the external port)', () => {
    const { doc: withLine, lineId } = cs150Line();
    const f = addTie(withLine, 'F', [0, 0, 0], [1, 0, 0], { endType: 'FL', rating: 'CL150', facing: 'RF' });
    const attempt = (length: number): ReturnType<typeof deriveRun> => {
      const run: PipeRun = {
        id: 'run-x',
        lineId,
        start: { point: [0, 0, 0], ref: { kind: 'tieIn', id: f.id } },
        end: { point: [length, 1000, 0] },
        pis: [[length, 0, 0]],
      };
      return deriveRun(f.doc, run);
    };
    // 79 (gasket + hub) + 152 (elbow) = 231 mm needed.
    const tooShort = failure(attempt(200));
    expect(tooShort.code).toBe('RTE_SEGMENT_TOO_SHORT');
    expect(tooShort.ids).toEqual(['run-x', 'run-x/flange-1', 'run-x/elbow-1']);
    const exact = attempt(231);
    if (!exact.ok) throw new Error(exact.message);
    // Zero cut: the elbow touches the flange hub (fitting-to-fitting) and no pipe piece lies on the leg.
    expect(exact.legs[0]?.cutLengthsMm).toEqual([]);
    expect(exact.warnings.map((warning) => warning.code)).toEqual(['RTE_FITTING_TO_FITTING']);
    expect(exact.joints.map((joint) => joint.kind)).toEqual(['flanged', 'fittingToFitting', 'buttWeld']);
  });
});

describe('unverified reasons (AF-32)', () => {
  it('names the draft status and the rows that are not grade A', () => {
    const { doc, runId } = routedPumpToVessel();
    const derived = deriveRun(doc, piping(doc).runs[runId] as PipeRun);
    if (!derived.ok) throw new Error(derived.message);
    expect(derived.unverified).toBe(true);
    expect(derived.unverifiedReasons).toEqual([
      'spec CS150 r1 is draft, not approved',
      'catalogue rows not grade A: CS150/G-SW/100, CS150/B-STUD/100, CS150/F-WN/100, CS150/E90-LR/100',
    ]);
    expect(derived.spec).toEqual({ id: 'CS150', revision: 1, status: 'draft' });
  });
});
