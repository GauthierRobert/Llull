/**
 * Plant 02 RTE M2 plumbing: branch references as ports (`portOfRef`, `portIdOf`, `portOccupant`), the stored-model validation of inline components and
 * branch points, and the display entities of the M2 parts when their data is incomplete (nothing is drawn rather than a wrong shape).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeLine, PipeRun, PipingModel, PortRef, RoutedPart } from '@aec/plant/types';
import { partEntities } from '@aec/plant/piping/geometryInline';
import { portIdOf, portOccupant, portOfRef } from '@aec/plant/piping/ports';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, headerScene, valveScene } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

const h = headerScene();
const withBranch = apply(h.doc, 'add_branch', { runId: h.headerId, at: { point: [4000, 0, 3000] }, dn: 100, to: { portId: h.tieC } });
const branchRunId = piping(withBranch).runOrder.at(-1) as string;
const branchId = (piping(withBranch).runs[h.headerId] as PipeRun).branches?.[0]?.id as string;
const ref: PortRef = { kind: 'branch', runId: h.headerId, branchId };

/** `doc` with the piping model rewritten. */
const edit = (doc: CadDocument, change: (model: PipingModel) => PipingModel): CadDocument => ({
  ...doc,
  plant: { ...doc.plant, piping: change(piping(doc)) },
});
const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));

describe('a branch point as a port', () => {
  it('is the branch start on the header centreline, facing along the branch, at the branch size, butt weld', () => {
    expect(portOfRef(withBranch, ref)).toEqual({ position: [4000, 0, 3000], direction: [0, 1, 0], dn: 100, endType: 'BW' });
    expect(portIdOf(withBranch, ref)).toBe(`${h.headerId}#${branchId}`);
  });

  it('is used by its branch run (RTE_PORT_IN_USE for anything else); a run end connected to a branch reports the branch as its occupant', () => {
    expect(portOccupant(withBranch, ref)).toBe(branchRunId);
    expect(portOccupant(withBranch, { kind: 'runEnd', runId: branchRunId, end: 'start' })).toBe(`${h.headerId}#${branchId}`);
  });

  it('is gone with the branch point, the branch run, the branch line or the header', () => {
    expect(
      portOfRef(
        edit(withBranch, (model) => ({
          ...model,
          runs: { ...model.runs, [h.headerId]: { ...(model.runs[h.headerId] as PipeRun), branches: [] } },
        })),
        ref,
      ),
    ).toBeNull();
    expect(
      portOfRef(
        edit(withBranch, (model) => ({ ...model, runs: withoutKey(model.runs, branchRunId) })),
        ref,
      ),
    ).toBeNull();
    expect(
      portOfRef(
        edit(withBranch, (model) => ({ ...model, lines: withoutKey(model.lines, h.lineId) })),
        ref,
      ),
    ).toBeNull();
    expect(
      portOfRef(
        edit(withBranch, (model) => ({ ...model, runs: withoutKey(model.runs, h.headerId) })),
        ref,
      ),
    ).toBeNull();
  });
});

describe('validation of the stored M2 members', () => {
  const run = (extra: Record<string, unknown>, ref0: unknown = undefined): Record<string, unknown> => ({
    tieIns: {},
    tieInOrder: [],
    lines: { l: { id: 'l', lineNumber: 'L', spec: 'S', dn: 1 } },
    lineOrder: ['l'],
    runs: {
      r: {
        id: 'r',
        lineId: 'l',
        start: { point: [0, 0, 0], ...(ref0 === undefined ? {} : { ref: ref0 }) },
        end: { point: [1, 0, 0] },
        pis: [],
        ...extra,
      },
    },
    runOrder: ['r'],
    entityIds: {},
  });

  it('accepts a well-formed run size, inline components, branch points and a branch start reference', () => {
    const good = run(
      {
        dn: 100,
        inline: [
          { id: 'v', type: 'valveGate', leg: 0, centreDistance: 5, stemDirection: [0, 0, 1] },
          { id: 'x', type: 'reducerConcentric', leg: 0, centreDistance: 9, dn2: 50 },
        ],
        branches: [{ id: 'b', leg: 0, distance: 2, branchRunId: 'r' }],
      },
      { kind: 'branch', runId: 'r', branchId: 'b' },
    );
    expect(pipingErrors(good)).toEqual([]);
  });

  it.each([
    ['a non-positive run size', { dn: 0 }, 'plant.piping.runs.r.dn must be a positive size'],
    ['inline that is not a list', { inline: {} }, 'plant.piping.runs.r.inline must be a list'],
    [
      'an inline component without an integer leg',
      { inline: [{ id: 'v', type: 'valveGate', leg: 0.5, centreDistance: 5 }] },
      'plant.piping.runs.r.inline.0 needs an id',
    ],
    [
      'an inline component with a bad stem',
      { inline: [{ id: 'v', type: 'valveGate', leg: 0, centreDistance: 5, stemDirection: [1] }] },
      'plant.piping.runs.r.inline.0 needs an id',
    ],
    ['branches that are not a list', { branches: 1 }, 'plant.piping.runs.r.branches must be a list'],
    [
      'a branch point naming a run that does not exist',
      { branches: [{ id: 'b', leg: 0, distance: 2, branchRunId: 'nope' }] },
      'plant.piping.runs.r.branches.0 needs an id',
    ],
  ])('reports %s', (_name, extra, message) => {
    expect(pipingErrors(run(extra)).some((error) => error.startsWith(message))).toBe(true);
  });

  it('a branch reference is allowed at a run start and refused at a run end', () => {
    const atEnd = run({});
    const runs = atEnd['runs'] as Record<string, { end: Record<string, unknown> }>;
    (runs['r'] as { end: Record<string, unknown> }).end['ref'] = { kind: 'branch', runId: 'r', branchId: 'b' };
    expect(pipingErrors(atEnd)).toEqual(['plant.piping.runs.r.end.ref must be a tieIn, nozzle or runEnd reference']);
  });
});

describe('display entities of incomplete M2 parts', () => {
  const v = valveScene();
  const lineOf = (doc: CadDocument): PipeLine => Object.values(piping(doc).lines)[0] as PipeLine;
  const partsOf = (doc: CadDocument, runId: string): readonly RoutedPart[] => {
    const derived = deriveRun(doc, piping(doc).runs[runId] as PipeRun);
    if (!derived.ok) throw new Error(derived.message);
    return derived.parts;
  };
  const valve = partsOf(v.doc, v.runId).find((part) => part.kind === 'valve') as RoutedPart;

  /** A DN150 -> DN100 run with a reducer, plus the header scene's tee and olet. */
  const reduced = (() => {
    const line = cs150Line(150, '2001');
    const a = addTie(line.doc, 'RA', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const b = addTie(a.doc, 'RB', [6000, 0, 0], [-1, 0, 0], { dn: 100 });
    const doc = apply(b.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      to: { portId: b.id },
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    });
    return { doc, runId: piping(doc).runOrder[0] as string };
  })();
  const reducer = partsOf(reduced.doc, reduced.runId).find((part) => part.kind === 'reducer') as RoutedPart;
  const branches = apply(withBranch, 'add_branch', {
    runId: h.headerId,
    at: { point: [7000, 0, 3000] },
    dn: 50,
    legs: [{ direction: '+Z', length: 1000 }],
  });
  const headerParts = partsOf(branches, h.headerId);
  const tee = headerParts.find((part) => part.kind === 'tee') as RoutedPart;
  const olet = headerParts.find((part) => part.kind === 'olet') as RoutedPart;

  it('draws a valve as body, stem and wheel; without a stem only the body; without ports or an OD nothing', () => {
    expect(partEntities(valve, lineOf(v.doc)).map((entity) => entity.id.split('/').slice(1).join('/'))).toEqual([
      'valve-1',
      'valve-1/stem',
      'valve-1/wheel',
    ]);
    const { stemDirection, ...noStem } = valve;
    void stemDirection;
    expect(partEntities(noStem, lineOf(v.doc))).toHaveLength(1);
    expect(partEntities({ ...valve, stemDirection: [0, 0, 0] }, lineOf(v.doc))).toHaveLength(1);
    expect(partEntities({ ...valve, ports: [] }, lineOf(v.doc))).toEqual([]);
    expect(partEntities({ ...valve, dims: {} }, lineOf(v.doc))).toEqual([]);
  });

  it('draws a valve stem to the catalogue stem height when the row has one', () => {
    const tall = partEntities({ ...valve, dims: { ...valve.dims, stemHeight: 500 } }, lineOf(v.doc));
    const stem = tall.find((entity) => entity.id.endsWith('/stem'));
    expect(stem?.kind === 'revolution' && stem.profile[2]?.[1]).toBe(500);
  });

  it('draws a reducer as a frustum from the big to the small end; nothing without its two outside diameters', () => {
    expect(partEntities(reducer, lineOf(reduced.doc))).toHaveLength(1);
    expect(
      partEntities({ ...reducer, dims: { ...reducer.dims, outsideDiameterOut: undefined as unknown as number } }, lineOf(reduced.doc)),
    ).toEqual([]);
    expect(partEntities({ ...reducer, ports: [] }, lineOf(reduced.doc))).toEqual([]);
  });

  it('draws a tee as header cylinder plus branch stub and an olet as one cylinder; incomplete data draws nothing', () => {
    expect(partEntities(tee, lineOf(branches))).toHaveLength(2);
    expect(partEntities(olet, lineOf(branches))).toHaveLength(1);
    expect(partEntities({ ...tee, ports: tee.ports.slice(0, 2) }, lineOf(branches))).toEqual([]);
    expect(partEntities({ ...tee, dims: { outsideDiameter: 168.3 } }, lineOf(branches))).toEqual([]);
    const { centre, ...noCentre } = tee;
    void centre;
    expect(partEntities(noCentre, lineOf(branches))).toEqual([]);
    expect(partEntities({ ...tee, centre: tee.ports[2]?.position as [number, number, number] }, lineOf(branches))).toEqual([]);
    expect(partEntities({ ...olet, dims: {} }, lineOf(branches))).toEqual([]);
    expect(partEntities({ ...olet, ports: [] }, lineOf(branches))).toEqual([]);
  });

  it('draws nothing for a stub-in or a bolt set (no body)', () => {
    expect(partEntities({ ...olet, kind: 'stubIn' }, lineOf(branches))).toEqual([]);
    expect(partEntities({ ...olet, kind: 'boltSet', ports: [] }, lineOf(branches))).toEqual([]);
  });
});
