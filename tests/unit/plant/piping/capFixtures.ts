/** Cap catalogue for the cap-run-end tests and golden plan: DECLARED TEST INPUTS on the small-bore scene (SW800), never a standard's values. */

const cite = { citation: 'declared test input, not from a standard (CAT-FU cap run end)' };
const family = (id: string, size: Record<string, unknown>): Record<string, unknown> => ({
  id,
  type: 'cap',
  standard: 'company test table',
  ends: ['SW'],
  unit: 'mm',
  sizes: [{ nps: 1, class: 3000, socketDepth: 13, ...size, provenance: cite }],
});

const CAP_CATALOG_ID = 'test-sw-caps';
export const capCatalog = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: CAP_CATALOG_ID,
  licence: 'company-proprietary',
  families: [family('cap-sw', { length: 20 }), family('cap-nolength', {}), family('cap-huge', { length: 1600 })],
};

/** `edit_pipe_spec` ops that name the cap catalogue in the SW800 spec and add a DN25 cap component reading family `ref`. */
export const capSpecOps = (ref: string, catalogs: readonly string[]): unknown[] => [
  { op: 'setHeader', fields: { catalogs: [...catalogs, CAP_CATALOG_ID] } },
  { op: 'addComponent', component: { id: 'CAP', type: 'cap', fromNps: 1, toNps: 1, ends: 'SW', catalogRef: ref, class: 3000 } },
];
