/**
 * TR-PSC-02: the committed bundled-catalogue data modules equal the validation pack (no drift). `npm run piping-catalog` rewrites them
 * (this suite with LLULL_WRITE_PIPING_CATALOG=1) and formats them.
 */

import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildPipingData, DATA_MODULE_DIR, MODULES, renderModule } from '../../../../scripts/pipingCatalogGen';
import * as pipeB3610 from '@aec/plant/catalog/data/pipeB3610';
import * as pipeB3619 from '@aec/plant/catalog/data/pipeB3619';
import * as fittingsB169 from '@aec/plant/catalog/data/fittingsB169';
import * as flanges from '@aec/plant/catalog/data/flanges';
import * as gasketsValves from '@aec/plant/catalog/data/gasketsValves';
import * as ratings from '@aec/plant/catalog/data/ratings';

const committed: Record<string, Record<string, unknown>> = { pipeB3610, pipeB3619, fittingsB169, flanges, gasketsValves, ratings };
const data = buildPipingData();

if (process.env['LLULL_WRITE_PIPING_CATALOG'] === '1') {
  for (const name of Object.keys(MODULES)) writeFileSync(path.join(DATA_MODULE_DIR, `${name}.ts`), renderModule(name, data));
}

describe('bundled piping catalogue data vs the 01 PSC validation pack', () => {
  for (const [name, spec] of Object.entries(MODULES)) {
    it(`${name} equals the pack rows`, () => {
      for (const [constant, [, key]] of Object.entries(spec.constants)) {
        expect(committed[name]?.[constant], `${name}.${constant} (npm run piping-catalog)`).toEqual(data[key]);
      }
    });
  }

  it('covers every pack row: 382 pipe rows (86 grade A), 24 B16.5 flanges, 15 + 2 ratings', () => {
    expect(data.pipeB3610.length + data.pipeB3619.length).toBe(382);
    expect([...data.pipeB3610, ...data.pipeB3619].filter((row) => row[4]).length).toBe(86);
    expect(data.flangesB165).toHaveLength(24);
    expect(data.ratingBar).toHaveLength(15);
    expect(data.ratingPsi).toHaveLength(2);
  });
});
