/**
 * The derivation memo is keyed on exactly what a derivation reads: `plant.piping.{runs, lines, tieIns}`, `plant.spec`, `plant.catalog`, `building` and
 * the run object. Editing anything else (units, entities, layers, draw order, run / line order lists, the entity-id table) is a hit on the very same frozen
 * result; editing a key slice is a miss that shows the edit. Results are frozen copies, so nothing a caller does can change what the next one reads.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { frozenCopy } from '@aec/plant/piping/derivationMemo';
import type { DerivationFailure, RunDerivation } from '@aec/plant/piping/deriveTypes';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { apply } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, routedPumpToVessel } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;
const ok = (result: RunDerivation | DerivationFailure): RunDerivation => {
  if (!result.ok) throw new Error(result.message);
  return result;
};
const cuts = (result: RunDerivation): number[] => result.parts.filter((part) => part.kind === 'pipe').map((part) => part.cutLength ?? 0);

describe('derivation memo keys', () => {
  const s = routedPumpToVessel();
  const run = piping(s.doc).runs[s.runId] as PipeRun;
  const first = ok(deriveRun(s.doc, run));

  it('returns the same frozen result for the same document, and the numbers are the SC-RTE-01 ones', () => {
    expect(deriveRun(s.doc, run)).toBe(first);
    expect(Object.isFrozen(first) && Object.isFrozen(first.parts) && Object.isFrozen(first.parts[0])).toBe(true);
    expect(cuts(first)).toEqual([1269, 2696, 2696, 1196, 2769]);
  });

  it.each([
    ['units', (d: CadDocument): CadDocument => ({ ...d, units: 'in' })],
    ['entities', (d: CadDocument): CadDocument => ({ ...d, entities: {} })],
    ['draw order', (d: CadDocument): CadDocument => ({ ...d, order: [] })],
    ['layers', (d: CadDocument): CadDocument => ({ ...d, layers: {} })],
    ['run order', (d: CadDocument): CadDocument => ({ ...d, plant: { ...d.plant, piping: { ...piping(d), runOrder: [] } } })],
    ['line order', (d: CadDocument): CadDocument => ({ ...d, plant: { ...d.plant, piping: { ...piping(d), lineOrder: [] } } })],
    ['tie-in order', (d: CadDocument): CadDocument => ({ ...d, plant: { ...d.plant, piping: { ...piping(d), tieInOrder: [] } } })],
    ['entity-id table', (d: CadDocument): CadDocument => ({ ...d, plant: { ...d.plant, piping: { ...piping(d), entityIds: {} } } })],
    [
      'project settings (line-number template; M3)',
      (d: CadDocument): CadDocument => ({
        ...d,
        plant: { ...d.plant, piping: { ...piping(d), settings: { lineNumberTemplate: '{sequence}' } } },
      }),
    ],
  ])('editing %s (not read by a derivation) is a hit on the same result', (_name, edit) => {
    expect(deriveRun(edit(s.doc), run)).toBe(first);
  });

  it('a copy of a key slice with the same content is a miss with an equal result (identity is the key)', () => {
    const copy: CadDocument = { ...s.doc, plant: { ...s.doc.plant, spec: { ...s.doc.plant?.spec } as never } };
    const again = deriveRun(copy, run);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    const sameValueRun = { ...run };
    expect(deriveRun(s.doc, sameValueRun)).not.toBe(first);
    expect(deriveRun(s.doc, sameValueRun)).toEqual(first);
  });

  it('the M3 members that no derivation reads (line insulation, declared slope) change the lines slice: a miss with an equal result', () => {
    const lines = piping(s.doc).lines;
    const line = lines[s.line] as NonNullable<(typeof lines)[string]>;
    const doc: CadDocument = {
      ...s.doc,
      plant: {
        ...s.doc.plant,
        piping: {
          ...piping(s.doc),
          lines: {
            ...lines,
            [s.line]: {
              ...line,
              insulation: { code: 'H', thicknessMm: 50, source: 'explicit' },
              slope: { value: 1, unit: 'percent', fall: true },
            },
          },
        },
      },
    };
    const again = deriveRun(doc, run);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  it('editing the catalogue shows in the result: a 160 mm elbow centre-to-end leaves the first piece 1261 (1500 - 79 - 160)', () => {
    const catalogs = s.doc.plant?.catalog?.catalogs ?? {};
    const stub = catalogs['rte-validation-stub'];
    if (stub === undefined || s.doc.plant?.catalog === undefined) throw new Error('no stub catalogue');
    const families = stub.families.map((family) =>
      family.type === 'elbow90'
        ? {
            ...family,
            sizes: family.sizes.map((size) => ({
              ...size,
              dims: { ...size.dims, centreToEnd: { ...(size.dims['centreToEnd'] as never as { value: number }), value: 160 } },
            })),
          }
        : family,
    );
    const doc: CadDocument = {
      ...s.doc,
      plant: {
        ...s.doc.plant,
        catalog: { ...s.doc.plant.catalog, catalogs: { ...catalogs, 'rte-validation-stub': { ...stub, families } } },
      },
    } as CadDocument;
    expect(cuts(ok(deriveRun(doc, run)))[0]).toBe(1261);
  });

  it('editing the spec shows in the result: an approved spec is no longer reported as a draft', () => {
    const spec = s.doc.plant?.spec;
    const latest = spec?.specs['CS150']?.[0];
    if (spec === undefined || latest === undefined) throw new Error('no spec');
    const doc: CadDocument = {
      ...s.doc,
      plant: { ...s.doc.plant, spec: { ...spec, specs: { ...spec.specs, CS150: [{ ...latest, status: 'approved' as const }] } } },
    };
    expect(first.spec.status).toBe('draft');
    expect(ok(deriveRun(doc, run)).spec.status).toBe('approved');
  });

  it('editing the lines shows in the result: another line size no longer derives (RTE_SIZE_MISMATCH at the DN100 nozzles)', () => {
    const lines = piping(s.doc).lines;
    const doc: CadDocument = {
      ...s.doc,
      plant: {
        ...s.doc.plant,
        piping: { ...piping(s.doc), lines: { ...lines, [s.line]: { ...(lines[s.line] as never as { dn: number }), dn: 150 } } as never },
      },
    };
    const result = deriveRun(doc, run);
    expect(result.ok).toBe(false);
    expect((result as DerivationFailure).code).toBe('RTE_SIZE_MISMATCH');
  });

  it('editing the building shows in the result: a moved pump breaks the run (RTE_STRETCH_FAILED)', () => {
    const pump = Object.values(s.doc.building?.elements ?? {}).find(
      (element) => element.category === 'equipment' && element.mark === 'P-101',
    );
    const moved = apply(s.doc, 'move_building_element', { elementIds: [pump?.id], delta: [100, 0] });
    const result = deriveRun(moved, run);
    expect(result.ok).toBe(false);
    expect((result as DerivationFailure).code).toBe('RTE_STRETCH_FAILED');
  });

  it('editing the tie-ins shows in the result: a moved tie-in breaks its run', () => {
    const line = cs150Line();
    const a = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0]);
    const routed = apply(a.doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 2000 }] });
    const tied = piping(routed).runs[piping(routed).runOrder[0] as string] as PipeRun;
    expect(ok(deriveRun(routed, tied)).totalPipeMm).toBe(2000);
    const tieIns = piping(routed).tieIns;
    const tie = tieIns[a.id];
    if (tie === undefined) throw new Error('no tie-in');
    const doc: CadDocument = {
      ...routed,
      plant: {
        ...routed.plant,
        piping: { ...piping(routed), tieIns: { ...tieIns, [a.id]: { ...tie, port: { ...tie.port, position: [0, 0, 5] } } } },
      },
    };
    const result = deriveRun(doc, tied);
    expect(result.ok).toBe(false);
    expect((result as DerivationFailure).code).toBe('RTE_STRETCH_FAILED');
  });
});

describe('frozenCopy', () => {
  it('copies and freezes arrays and objects all the way down and shares nothing with the source', () => {
    const source = { list: [1, [2, 3]], nested: { value: 4 }, none: undefined as number | undefined, text: 'x' };
    const copy = frozenCopy(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.list).not.toBe(source.list);
    expect(Object.isFrozen(copy) && Object.isFrozen(copy.list) && Object.isFrozen(copy.list[1]) && Object.isFrozen(copy.nested)).toBe(true);
    source.nested.value = 9;
    expect(copy.nested.value).toBe(4);
    expect(frozenCopy(null)).toBeNull();
    expect(frozenCopy(7)).toBe(7);
  });
});

describe('derivation memo: what V1 part 1 reads is on the run or in the spec', () => {
  const line = cs150Line(150, '9001');
  const tie = addTie(line.doc, 'M', [0, 0, 0], [1, 0, 0], { dn: 150 });
  const routed = apply(tie.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: tie.id },
    legs: [
      { direction: '+X', length: 4000 },
      { direction: '+Z', length: 1000 },
    ],
    inline: [{ type: 'reducerEccentric', dn2: 100, flat: 'top', at: { leg: 0, centreDistance: 2000 } }],
  });
  const stored = piping(routed).runs[piping(routed).runOrder[0] as string] as PipeRun;
  const base = ok(deriveRun(routed, stored));

  it('the flat side is read from the run component: a run with the flat turned is a miss with the other offset', () => {
    const item = stored.inline?.[0];
    if (item === undefined) throw new Error('no reducer');
    const turned: PipeRun = { ...stored, inline: [{ ...item, flatDirection: [0, 0, -1] }] };
    const other = ok(deriveRun(routed, turned));
    expect(other).not.toBe(base);
    expect(cuts(base)).toEqual([1930, 1778, 821]);
    expect(cuts(other)).toEqual([1930, 1778, 875]);
  });

  it('the bend radius is read from the run, the trimmed / bend rule from the spec slice: both are keys, nothing else is read', () => {
    const bent: PipeRun = { ...stored, pis: stored.pis, bendRadiusMm: 500 };
    // standard turns ignore the radius: an equal result, but a different run object is a miss
    expect(ok(deriveRun(routed, bent))).not.toBe(base);
    expect(ok(deriveRun(routed, bent))).toEqual(base);
    expect(ok(deriveRun(routed, stored))).toBe(base);
  });

  it('the valve operator and the clash bodies are read from the derivation: a hit on the same frozen result', () => {
    expect(ok(deriveRun({ ...routed, units: 'mm' }, stored))).toBe(base);
  });
});
