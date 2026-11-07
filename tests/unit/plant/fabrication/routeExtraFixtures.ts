/**
 * Fixtures of the ISO M6c route-import tests: the CS150 stub document extended with DECLARED TEST INPUT rows (a butt-weld cap) that the bundled catalogue does not have.
 * The numbers are round test inputs labelled as such, never a standard's values.
 */

import type { CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { cs150Document } from '../piping/rteFixtures';

const cite = { citation: 'declared test input, not from a standard (ISO M6c route import)' };

export const CAP_LENGTH_MM = 64;

const extraCatalog = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'test-bw-extras',
  licence: 'company-proprietary',
  families: [
    {
      id: 'cap-bw',
      type: 'cap',
      standard: 'company test table',
      ends: ['BW'],
      unit: 'mm',
      sizes: [{ nps: 4, length: CAP_LENGTH_MM, provenance: cite }],
    },
  ],
};

/** CS150 with the test cap catalogue named in the spec and a DN100 cap component. */
export function extrasDocument(): CadDocument {
  let doc = apply(cs150Document(), 'import_piping_catalog', { catalog: extraCatalog });
  const spec = doc.plant?.spec?.specs['CS150']?.at(-1);
  doc = apply(doc, 'edit_pipe_spec', {
    specId: 'CS150',
    ops: [
      { op: 'setHeader', fields: { catalogs: [...(spec?.catalogs ?? []), 'test-bw-extras'] } },
      {
        op: 'addComponent',
        component: { id: 'CAP-BW', type: 'cap', fromNps: 4, toNps: 4, ends: 'BW', catalogRef: 'cap-bw', scheduleFromPipe: true },
      },
    ],
  });
  return doc;
}
