/**
 * PMI write stage of `export_step_ap242 { includePmi }` (03 GDT M6, TR-GDT-16): the semantic PMI of the document (`doc.pmi`) is attached, by
 * face index, to the product that holds its solid, through the 04 XCH `ExchangePmi` transport.
 * @invariant faces are re-found from the persisted `facesNear` points on the exact shape the writer receives (same recipe, same face numbering);
 *   only a loose solid written as its own product carries PMI; every item not written is listed with its reason
 * @failure no face query / unresolvable feature / unsupported kind -> the item is skipped and reported, the export itself is unaffected
 */

import type { CadDocument } from '../../model/types';
import type { PmiFeature, PmiItem } from '../../model/pmi';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ExchangeProduct } from '../../geometry/kernelExchange';
import { isFeatureProblem, openSolid, resolveIn } from '../../geometry/pmiFeatures';
import { operandRecipe } from '../brep/kernelShape';
import { pmiItems } from '../pmi/pmiOps';
import { toExchangePmi } from '../pmi/xcafMapping';
import type { ExchangePlan } from './stepPlan';

export interface PmiWriteReport {
  readonly requested: number;
  readonly written: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly lossy: readonly { readonly id: string; readonly lost: readonly string[] }[];
  /** Written items still awaiting a qualified human review (AF-33): the file carries unapproved PMI. */
  readonly reviewRequired: readonly string[];
}

/** The solid an item attaches to (a frame on a size dimension takes the dimension's solid). */
function entityOf(item: PmiItem, byId: ReadonlyMap<string, PmiItem>): string | undefined {
  switch (item.kind) {
    case 'location_dimension':
      return item.from.entityId;
    case 'geometric_tolerance': {
      if ('feature' in item.target) return item.target.feature.entityId;
      const target = byId.get(item.target.pmiId);
      return target !== undefined && 'feature' in target && target.feature !== undefined ? target.feature.entityId : undefined;
    }
    case 'note':
      return item.feature?.entityId;
    default:
      return item.feature.entityId;
  }
}

/** Products with the PMI of their solid attached, and what happened to every item. */
export function attachPmi(
  doc: CadDocument,
  kernel: GeometryKernel,
  plan: ExchangePlan,
): { readonly products: readonly ExchangeProduct[]; readonly report: PmiWriteReport } {
  const items = pmiItems(doc);
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const skipped: { id: string; reason: string }[] = [];
  const written: string[] = [];
  const lossy: { id: string; lost: readonly string[] }[] = [];
  const productOf = new Map(Object.entries(plan.productEntities).map(([key, entityId]) => [entityId, key] as const));
  const grouped = new Map<string, PmiItem[]>();
  for (const item of items) {
    const entityId = entityOf(item, byId);
    if (entityId === undefined) skipped.push({ id: item.id, reason: 'the item has no resolvable target solid' });
    else if (!productOf.has(entityId))
      skipped.push({
        id: item.id,
        reason: `solid '${entityId}' is not written as a free product (not selected, inside a component, or faceted)`,
      });
    else grouped.set(entityId, [...(grouped.get(entityId) ?? []), item]);
  }
  const attached = new Map<string, NonNullable<ExchangeProduct['pmi']>>();
  for (const [entityId, group] of grouped) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    const frame = entity === undefined ? null : openSolid(kernel, operandRecipe(kernel, entity));
    const open = frame === null || 'code' in frame ? null : frame;
    const facesOf = (feature: PmiFeature): readonly number[] => {
      const resolved = open === null ? null : resolveIn(open, feature.facesNear);
      return resolved === null || isFeatureProblem(resolved) ? [] : resolved.faces.map((face) => face.index);
    };
    const mapped = toExchangePmi(group, facesOf);
    written.push(...mapped.written);
    skipped.push(...mapped.skipped);
    lossy.push(...mapped.lossy);
    const key = productOf.get(entityId);
    if (mapped.pmi !== null && key !== undefined) attached.set(key, mapped.pmi);
  }
  const writtenSet = new Set(written);
  return {
    products: plan.products.map((product) => {
      const pmi = attached.get(product.key);
      return pmi === undefined ? product : { ...product, pmi };
    }),
    report: {
      requested: items.length,
      written,
      skipped,
      lossy,
      reviewRequired: items.filter((item) => writtenSet.has(item.id) && item.review.required).map((item) => item.id),
    },
  };
}
