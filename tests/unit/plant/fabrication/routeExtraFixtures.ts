/**
 * Fixtures of the ISO M6c route-import tests: the CS150 stub document extended with DECLARED TEST INPUT rows (a butt-weld cap) that the bundled catalogue does not have.
 * The numbers are round test inputs labelled as such, never a standard's values.
 */

import type { CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { cs150Document } from '../piping/rteFixtures';

const cite = { citation: 'declared test input, not from a standard (ISO M6c route import)' };

export const CAP_LENGTH_MM = 64;
/** Thickness of the DN100 Class 150 blind flange row: the bundled weld-neck stub's 22.4 mm, a declared test input for a blind. */
export const BLIND_THICKNESS_MM = 22.4;

export const extraCatalog = {
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
    {
      id: 'blind-rf',
      type: 'flangeBlind',
      standard: 'company test table',
      ends: ['FL'],
      unit: 'mm',
      sizes: [
        {
          nps: 4,
          class: 150,
          facing: 'RF',
          outsideDiameter: 228.6,
          thickness: BLIND_THICKNESS_MM,
          boltCircle: 190.5,
          boltCount: 8,
          boltDiameter: 15.875,
          raisedFaceDiameter: 157.2,
          provenance: cite,
        },
      ],
    },
  ],
};

/** `edit_pipe_spec` ops that name the test catalogue in CS150 and add the DN100 cap and blind flange components. */
export const extrasSpecOps = (catalogs: readonly string[]): unknown[] => [
  { op: 'setHeader', fields: { catalogs: [...catalogs, 'test-bw-extras'] } },
  {
    op: 'addComponent',
    component: { id: 'CAP-BW', type: 'cap', fromNps: 4, toNps: 4, ends: 'BW', catalogRef: 'cap-bw', scheduleFromPipe: true },
  },
  {
    op: 'addComponent',
    component: { id: 'F-BL', type: 'flangeBlind', fromNps: 4, toNps: 4, facing: 'RF', class: 150, catalogRef: 'blind-rf' },
  },
];

/** CS150 with the test catalogue (cap, blind flange) named in the spec and a DN100 cap and blind flange component. */
export function extrasDocument(): CadDocument {
  const doc = apply(cs150Document(), 'import_piping_catalog', { catalog: extraCatalog });
  const spec = doc.plant?.spec?.specs['CS150']?.at(-1);
  return apply(doc, 'edit_pipe_spec', { specId: 'CS150', ops: extrasSpecOps(spec?.catalogs ?? []) });
}
