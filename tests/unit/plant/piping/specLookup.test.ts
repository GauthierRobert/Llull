/** `SpecLookup` (02 RTE §3.3): the thin adapter over 01 PSC resolution; PSC codes mapped to RTE_SPEC_*, trust carried (AF-32). */

import { describe, expect, it } from 'vitest';
import {
  createSpecLookup,
  isMiss,
  pipeOutsideDiameter,
  type CatalogueRow,
  type SpecLookup,
  type SpecMiss,
} from '@aec/plant/piping/specLookup';
import { createEmptyDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { cs150Document, rteJson } from './rteFixtures';
import { mixSpec } from './specFixture';

function lookupOf(doc = cs150Document(), spec = 'CS150'): SpecLookup {
  const lookup = createSpecLookup(doc, spec);
  if (isMiss(lookup)) throw new Error(lookup.detail);
  return lookup;
}
const row = (result: CatalogueRow | SpecMiss): CatalogueRow => {
  expect(isMiss(result), JSON.stringify(result)).toBe(false);
  return result as CatalogueRow;
};
const miss = (result: CatalogueRow | SpecMiss): SpecMiss => {
  expect(isMiss(result), JSON.stringify(result)).toBe(true);
  return result as SpecMiss;
};

describe('createSpecLookup', () => {
  it('reads the newest revision of a loaded spec: id, revision, status', () => {
    const lookup = lookupOf();
    expect([lookup.id, lookup.revision, lookup.status()]).toEqual(['CS150', 1, 'draft']);
  });

  it('maps an unknown spec to RTE_SPEC_UNKNOWN (PSC_SPEC_UNKNOWN in the detail)', () => {
    const result = createSpecLookup(createEmptyDocument(), 'CS150') as SpecMiss;
    expect(result.miss).toBe('RTE_SPEC_UNKNOWN');
    expect(result.detail).toContain('PSC_SPEC_UNKNOWN');
  });

  it('refuses a spec whose catalogue is not loaded instead of silently reading the next one', () => {
    const mm = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    const result = createSpecLookup(apply(mm, 'import_pipe_spec', { spec: rteJson('spec_cs150.json') }), 'CS150') as SpecMiss;
    expect(result.miss).toBe('RTE_SPEC_UNKNOWN');
    expect(result.detail).toContain('rte-validation-stub');
  });
});

describe('pipe and component rows', () => {
  it('pipe: OD and wall from the bundled B36.10M Sch 40 row, grade A (DN100 = NPS 4: 114.3 x 6.02)', () => {
    const pipe = row(lookupOf().pipe(100));
    expect(pipe.dims['outsideDiameter']).toBe(114.3);
    expect(pipe.dims['wall']).toBe(6.02);
    expect(pipe.unverified).toBe(false);
    expect(pipe.key).toBe('CS150/P-BW/100');
    expect(pipe.ends).toEqual(['BW', 'PL']);
    expect(pipe.source).toContain('llull-open-piping');
  });

  it('elbow: the stub catalogue is searched first (152), the bundled row stays within 0.4 mm of it (VC-RTE-15)', () => {
    const stub = row(lookupOf().component({ types: ['elbow90'], dn: 100 }));
    expect(stub.dims['centreToEnd']).toBe(152);
    expect(stub.unverified).toBe(true);
    expect(stub.radius).toBe('LR');
    expect(stub.source).toContain('rte-validation-stub');
    const bundledOnly = apply(cs150Document(), 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'setHeader', fields: { catalogs: ['llull-open-piping'] } }],
    });
    const bundled = row(lookupOf(bundledOnly).component({ types: ['elbow90'], dn: 100 }));
    expect(bundled.dims['centreToEnd']).toBe(152.4);
    expect(Math.abs((bundled.dims['centreToEnd'] as number) - 152)).toBeLessThan(0.4 + 1e-9);
    expect(bundled.unverified).toBe(false);
  });

  it('flange: rating CL150 and facing RF from the row; length through hub and bolt count from the stub; rating and facing filters select', () => {
    const flange = row(lookupOf().component({ types: ['flangeWeldNeck'], dn: 100, rating: 'CL150', facing: 'RF' }));
    expect(flange.rating).toBe('CL150');
    expect(flange.facing).toBe('RF');
    expect(flange.dims).toMatchObject({ lengthThroughHub: 76, boltCount: 8, outsideDiameter: 228.6, thickness: 22.4 });
    expect(miss(lookupOf().component({ types: ['flangeWeldNeck'], dn: 100, rating: 'CL300' })).miss).toBe('RTE_SPEC_NO_COMPONENT');
    expect(row(lookupOf().component({ types: ['flangeWeldNeck'], dn: 100, rating: 'unparsed' })).rating).toBe('CL150');
  });

  it('tries the types in order and returns the first miss when none resolves', () => {
    const gasket = row(lookupOf().component({ types: ['gasketSheet', 'gasketSpiralWound'], dn: 100, rating: 'CL150' }));
    expect(gasket.type).toBe('gasketSpiralWound');
    expect(gasket.dims['thickness']).toBe(3);
    const none = miss(lookupOf().component({ types: ['gasketSheet', 'gasketRing'], dn: 100 }));
    expect(none.miss).toBe('RTE_SPEC_NO_COMPONENT');
    expect(none.detail).toContain('PSC_NO_COMPONENT');
    expect(miss(lookupOf().component({ types: [], dn: 100 })).detail).toContain('no component type');
  });

  it('maps an out-of-range size and an unknown component to RTE_SPEC_NO_COMPONENT, ambiguity to RTE_SPEC_AMBIGUOUS', () => {
    expect(miss(lookupOf().pipe(700)).miss).toBe('RTE_SPEC_NO_COMPONENT');
    expect(miss(lookupOf().pipe(700)).detail).toContain('PSC_SIZE_OUT_OF_RANGE');
    const twice = apply(cs150Document(), 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [
        {
          op: 'addComponent',
          component: { id: 'E90-B', type: 'elbow90', fromNps: 2, toNps: 6, radius: 'LR', ends: 'BW', catalogRef: 'asme-b16.9' },
        },
      ],
    });
    const ambiguous = miss(lookupOf(twice).component({ types: ['elbow90'], dn: 100 }));
    expect(ambiguous.miss).toBe('RTE_SPEC_AMBIGUOUS');
    expect(ambiguous.ids).toEqual(['E90-LR', 'E90-B']);
  });

  it('carries the unverified flag of the row; the spec status is separate', () => {
    expect(lookupOf().status()).toBe('draft');
    expect(row(lookupOf().component({ types: ['boltSet'], dn: 100, rating: 'CL150', facing: 'RF' })).unverified).toBe(true);
  });
});

describe('rows without a catalogue family', () => {
  it('an EN 10220 pipe is read from the spec component: OD from the series, wall from the spec, not verified, source says so', () => {
    const doc = apply(createEmptyDocument(), 'import_pipe_spec', { spec: mixSpec() });
    const pipe = row(lookupOf(doc, 'MIX-1').pipe(100));
    expect(pipe.dims).toMatchObject({ outsideDiameter: 114.3, wall: 3.6 });
    expect(pipe.unverified).toBe(true);
    expect(pipe.key).toBe('MIX-1/P/100');
    expect(pipe.source).toContain('MIX-1');
    expect(lookupOf(doc, 'MIX-1').elbowAngles()).toMatchObject({ anglesDeg: [90], toleranceDeg: 1, defaulted: true });
  });
});

describe('elbow angles and connection rules', () => {
  it('elbowAngles comes from the spec (90 / 45, 1 degree) and connection() knows BW-BW and FL-FL only', () => {
    const lookup = lookupOf();
    expect(lookup.elbowAngles()).toEqual({ anglesDeg: [90, 45], toleranceDeg: 1, trimmedAllowed: false, defaulted: false });
    expect(lookup.connection('BW', 'BW')).toEqual({ joint: 'buttWeld', gapMm: 0, requires: [] });
    expect(lookup.connection('FL', 'FL')?.joint).toBe('flanged');
    expect(lookup.connection('BW', 'SW')).toBeNull();
    expect(lookup.connection('BW', 'FL')).toBeNull();
  });
});

describe('pipeOutsideDiameter', () => {
  it('is the pipe OD of the spec at the DN, or null for an unknown spec / size', () => {
    expect(pipeOutsideDiameter(cs150Document(), 'CS150', 80)).toBe(88.9);
    expect(pipeOutsideDiameter(cs150Document(), 'CS150', 700)).toBeNull();
    expect(pipeOutsideDiameter(cs150Document(), 'NOPE', 100)).toBeNull();
  });
});
