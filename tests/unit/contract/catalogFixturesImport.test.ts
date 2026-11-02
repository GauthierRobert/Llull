/**
 * Contract: every piping catalogue fixture of the plant packs imports through `import_piping_catalog` (the family schemas of 01 PSC must not
 * reject the dimension names 02 RTE already uses), and the 02 RTE branch variations (run-only tee, height-only olet, olet without outlet distance,
 * sockolet) import too.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectRefusal } from '../../helpers/commandAssertions';

const PLANT = path.resolve(__dirname, '../../../docs/plant');
const stubs = readdirSync(PLANT)
  .filter((pack) => pack.startsWith('02-'))
  .flatMap((pack) => {
    const dir = path.join(PLANT, pack, 'validation', 'data');
    return readdirSync(dir)
      .filter((file) => /catalog.*\.json$/.test(file))
      .map((file) => path.join(dir, file));
  });
const provenance = { sourceId: 'test', citation: 'fixture' };
const wrap = (families: unknown[]): unknown => ({
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'fixture',
  licence: 'open-data',
  families,
});

describe('plant catalogue fixtures import through import_piping_catalog', () => {
  it('finds the 02 RTE stubs', () => {
    expect(stubs.length).toBeGreaterThanOrEqual(3);
  });

  it.each(stubs.map((file) => [path.basename(file), file]))('%s', (_name, file) => {
    const result = execute(createEmptyDocument(), 'import_piping_catalog', { catalog: JSON.parse(readFileSync(file as string, 'utf8')) });
    expect(result.rejected, result.summary).toBeUndefined();
  });

  it('imports the RTE branch variations: run-only tee, height-only olet, olet with no outlet distance, BW weldolet with a class, sockolet', () => {
    const families = [
      {
        id: 'asme-b16.9-tee-run-only-test',
        type: 'tee',
        standard: 'ASME B16.9',
        ends: ['BW'],
        sizes: [{ nps: 3, centreToEndRun: 86, provenance }],
      },
      {
        id: 'mss-sp-97-weldolet-h-test',
        type: 'weldolet',
        standard: 'MSS SP-97',
        ends: ['BW'],
        sizes: [
          { nps: 6, smallNps: 3, height: 60, provenance },
          { nps: 6, smallNps: 4, outsideDiameter: 100, provenance },
          { nps: 6, smallNps: 2, class: 3000, centreToOutlet: 80, provenance },
        ],
      },
      {
        id: 'mss-sp-97-sockolet-test',
        type: 'sockolet',
        standard: 'MSS SP-97',
        ends: ['SW'],
        sizes: [{ nps: 4, smallNps: 2, centreToOutlet: 100, provenance }],
      },
    ];
    const result = execute(createEmptyDocument(), 'import_piping_catalog', { catalog: wrap(families) });
    expect(result.rejected, result.summary).toBeUndefined();
  });

  it('still refuses a zero outlet distance and a class that is not an olet class', () => {
    const olet = (type: string, ends: string[], size: Record<string, unknown>): unknown =>
      wrap([{ id: 'o', type, standard: 'MSS SP-97', ends, sizes: [{ nps: 4, smallNps: 2, provenance, ...size }] }]);
    expectRefusal(
      createEmptyDocument(),
      'import_piping_catalog',
      { catalog: olet('weldolet', ['BW'], { centreToOutlet: 0 }) },
      'PSC_CATALOG_INVALID',
      'families.0.sizes.0.centreToOutlet',
    );
    expectRefusal(
      createEmptyDocument(),
      'import_piping_catalog',
      { catalog: olet('sockolet', ['SW'], { centreToOutlet: 50, class: 2000 }) },
      'PSC_CATALOG_INVALID',
      'families.0.sizes.0.class',
    );
    expectRefusal(
      createEmptyDocument(),
      'import_piping_catalog',
      { catalog: olet('threadolet', ['THD'], { centreToOutlet: 50, class: 9000 }) },
      'PSC_CATALOG_INVALID',
      'families.0.sizes.0.class',
    );
    expect(
      execute(createEmptyDocument(), 'import_piping_catalog', { catalog: olet('threadolet', ['THD'], { centreToOutlet: 50, class: 2000 }) })
        .rejected,
    ).toBeUndefined();
  });
});
