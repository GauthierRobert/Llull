/** Flange set at an FL port (02 RTE §5.4): flange + gasket + bolt set from the spec, with the dimension each needs named when it is missing. */

import { describe, expect, it } from 'vitest';
import { resolveFlangeSet, type FlangeSet, type FlangeSetFailure } from '@aec/plant/piping/flangeSet';
import { createSpecLookup, isMiss, type SpecLookup } from '@aec/plant/piping/specLookup';
import type { CadDocument } from '@core/model/types';
import type { PortSpec } from '@aec/plant/types';
import { apply } from '../../../helpers/commandAssertions';
import { cs150Document, rteJson } from './rteFixtures';

const port: PortSpec = { position: [0, 0, 0], direction: [1, 0, 0], dn: 100, endType: 'FL', rating: 'CL150', facing: 'RF' };

function lookupOf(doc: CadDocument): SpecLookup {
  const lookup = createSpecLookup(doc, 'CS150');
  if (isMiss(lookup)) throw new Error(lookup.detail);
  return lookup;
}
const set = (result: FlangeSet | FlangeSetFailure): FlangeSet => {
  expect('flange' in result, JSON.stringify(result)).toBe(true);
  return result as FlangeSet;
};
const failure = (result: FlangeSet | FlangeSetFailure): FlangeSetFailure => {
  expect('code' in result, JSON.stringify(result)).toBe(true);
  return result as FlangeSetFailure;
};

/** A one-family catalogue: `type` rows of NPS 4 Class 150 RF with `dims`. */
const catalogOf = (id: string, type: string, standard: string, dims: Record<string, number>): Record<string, unknown> => ({
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id,
  licence: 'open-data',
  families: [
    {
      id: `${standard.toLowerCase().replace(/\s+/g, '-')}-${id}`,
      type,
      standard,
      ends: ['FL'],
      sizes: [{ nps: 4, class: 150, facing: 'RF', ...dims, verified: true, provenance: { citation: 'unit test' } }],
    },
  ],
});

describe('resolveFlangeSet', () => {
  it('SC-RTE-01 set: hub 76 + gasket 3 = 79 mm, 8 studs from the bolt-set row', () => {
    const result = set(resolveFlangeSet(lookupOf(cs150Document()), port, 100));
    expect([result.hub, result.gasketThickness, result.length, result.studs]).toEqual([76, 3, 79, 8]);
    expect(result.studSource).toBe('bolt set CS150/B-STUD/100');
    expect(result.flange.rating).toBe('CL150');
  });

  it('takes the stud count from the flange row when the bolt-set row has none, and names that', () => {
    const spec = { ...rteJson<Record<string, unknown>>('spec_cs150.json'), catalogs: ['hub', 'gasket', 'llull-open-piping'] };
    let doc = apply(cs150Document(), 'import_piping_catalog', {
      catalog: catalogOf('hub', 'flangeWeldNeck', 'ASME B16.5', {
        lengthThroughHub: 76,
        boltCount: 8,
        outsideDiameter: 228.6,
        thickness: 22.4,
      }),
    });
    doc = apply(doc, 'import_piping_catalog', { catalog: catalogOf('gasket', 'gasketSpiralWound', 'ASME B16.20', { thickness: 3 }) });
    doc = apply(doc, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'setHeader', fields: { catalogs: spec.catalogs } }] });
    const result = set(resolveFlangeSet(lookupOf(doc), port, 100));
    expect(result.studs).toBe(8);
    expect(result.studSource).toContain('flange row');
  });

  it('names the missing gasket thickness, flange hub, bolt set and stud count', () => {
    const base = cs150Document();
    const bundled = apply(base, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'setHeader', fields: { catalogs: ['llull-open-piping'] } }],
    });
    expect(failure(resolveFlangeSet(lookupOf(bundled), port, 100)).message).toContain('lengthThroughHub');
    const hubOnly = apply(bundled, 'import_piping_catalog', {
      catalog: catalogOf('hub', 'flangeWeldNeck', 'ASME B16.5', { lengthThroughHub: 76, outsideDiameter: 228.6, thickness: 22.4 }),
    });
    const noThickness = apply(hubOnly, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'setHeader', fields: { catalogs: ['hub', 'llull-open-piping'] } }],
    });
    expect(failure(resolveFlangeSet(lookupOf(noThickness), port, 100)).message).toContain('thickness');
    const noBolts = apply(base, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'removeComponent', id: 'B-STUD' }] });
    expect(failure(resolveFlangeSet(lookupOf(noBolts), port, 100)).code).toBe('RTE_SPEC_NO_COMPONENT');
    const withGasket = apply(hubOnly, 'import_piping_catalog', {
      catalog: catalogOf('gasket', 'gasketSpiralWound', 'ASME B16.20', { thickness: 3 }),
    });
    const noStuds = apply(withGasket, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'setHeader', fields: { catalogs: ['hub', 'gasket', 'llull-open-piping'] } }],
    });
    const noStudCount = failure(resolveFlangeSet(lookupOf(noStuds), port, 100));
    expect(noStudCount.message).toContain('stud count');
  });

  it('a port with the spec rating and facing, or with neither stated, is accepted; another rating or facing is a mismatch', () => {
    const lookup = lookupOf(cs150Document());
    expect(
      set(resolveFlangeSet(lookup, { position: port.position, direction: port.direction, dn: 100, endType: 'FL' }, 100)).flange.rating,
    ).toBe('CL150');
    expect(set(resolveFlangeSet(lookup, { ...port, rating: ' cl150 ' }, 100)).flange.key).toBe('CS150/F-WN/100');
    const rating = failure(resolveFlangeSet(lookup, { ...port, rating: 'CL300' }, 100));
    expect(rating.code).toBe('RTE_RATING_MISMATCH');
    expect(rating.detail).toEqual({ portRating: 'CL300', specRating: 'CL150' });
    const facing = failure(resolveFlangeSet(lookup, { ...port, facing: 'FF' }, 100));
    expect(facing.code).toBe('RTE_FACING_MISMATCH');
    expect(facing.detail).toEqual({ portFacing: 'FF', specFacing: 'RF' });
    expect(failure(resolveFlangeSet(lookup, { ...port, dn: 700 }, 700)).code).toBe('RTE_SPEC_NO_COMPONENT');
  });
});
