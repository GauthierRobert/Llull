/** Access to `doc.plant.spec` (the pipe specs of the document, every revision) and the catalogues a spec searches. */

import type { CadDocument } from '@core/model/types';
import { findCatalog } from '../catalog/store';
import type { PipingCatalog } from '../catalog/types';
import type { PipeSpec, SpecModel } from './types';

export const EMPTY_SPEC_MODEL: SpecModel = { specs: {}, specOrder: [] };

export const getSpecModel = (doc: Pick<CadDocument, 'plant'>): SpecModel => doc.plant?.spec ?? EMPTY_SPEC_MODEL;

export const withSpecModel = (doc: CadDocument, spec: SpecModel): CadDocument => ({ ...doc, plant: { ...doc.plant, spec } });

/** The newest revision of spec `id`, or undefined. */
export const latestSpec = (doc: Pick<CadDocument, 'plant'>, id: string): PipeSpec | undefined => getSpecModel(doc).specs[id]?.at(-1);

/** Revision `revision` of spec `id` (the newest when omitted), or undefined. */
export const findSpec = (doc: Pick<CadDocument, 'plant'>, id: string, revision?: number): PipeSpec | undefined =>
  revision === undefined ? latestSpec(doc, id) : getSpecModel(doc).specs[id]?.find((spec) => spec.revision === revision);

/** The newest approved revision of spec `id`, or undefined. */
export const latestApproved = (doc: Pick<CadDocument, 'plant'>, id: string): PipeSpec | undefined =>
  getSpecModel(doc)
    .specs[id]?.filter((spec) => spec.status === 'approved')
    .at(-1);

/** The catalogues `spec` searches, in order, and the references that name none. */
export function specCatalogs(
  doc: Pick<CadDocument, 'plant'>,
  spec: PipeSpec,
): { readonly catalogs: readonly PipingCatalog[]; readonly missing: readonly string[] } {
  const found = spec.catalogs.map((reference) => ({ reference, catalog: findCatalog(doc, reference) }));
  return {
    catalogs: found.flatMap((entry) => entry.catalog ?? []),
    missing: found.filter((entry) => entry.catalog === undefined).map((entry) => entry.reference),
  };
}
