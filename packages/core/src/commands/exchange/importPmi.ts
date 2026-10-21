/**
 * PMI read stage of `import_step_exact` (03 GDT M6, TR-GDT-15): the semantic PMI the XDE reader found on each product (04 XCH `ImportedProduct.pmi`,
 * face indices of the product shape as read) becomes `apply_pmi_set` input per imported solid, attached by a point ON each named face.
 * @invariant face indices run through the product's solids in order (a solid's faces follow the previous solid's); an item whose faces span
 *   several solids, or name no face, is counted unmapped - never attached to a guess; every created item is review-required
 * @failure no face query / a solid the kernel cannot open -> the product's PMI is counted unmapped, the import itself is unaffected
 */

import type { CadDocument, Vec3 } from '../../model/types';
import type { ExchangePmi } from '../../geometry/kernelExchange';
import type { GeometryKernel } from '../../geometry/kernel';
import type { FaceDetail } from '../../geometry/kernelPorts';
import { type SolidFaces, isFeatureProblem, openSolid, resolveIn } from '../../geometry/pmiFeatures';
import { operandRecipe } from '../../geometry/operandRecipe';
import { type PmiDraft, applyPmiDrafts, withImportRecord } from '../pmi/applySet';
import { fromExchangePmi } from '../pmi/xcafMapping';

export interface PmiImportOutcome {
  readonly document: CadDocument;
  readonly items: number;
  readonly unresolved: number;
  readonly unmapped: number;
}

/** Candidate points tried per face before the first sample is taken as it is. */
const CANDIDATES = 12;

/**
 * A point ON `detail` that the face query resolves to this face: the samples of a thin or highly trimmed face can lie within the
 * identification tolerance of an adjacent face of another surface (GDT_FACE_AMBIGUOUS), so a few evenly spaced ones are tried.
 */
function pointOn(frame: SolidFaces, detail: FaceDetail): Vec3 | undefined {
  const all = [...detail.samples, detail.centroid];
  const step = Math.max(1, Math.floor(all.length / CANDIDATES));
  for (let at = 0; at < all.length; at += step) {
    const candidate = all[at] as Vec3;
    const found = resolveIn(frame, [candidate]);
    if (!isFeatureProblem(found) && found.faces.some((face) => face.index === detail.index)) return candidate;
  }
  return detail.samples[0] ?? detail.centroid;
}

const itemCount = (pmi: ExchangePmi): number => pmi.datums.length + pmi.tolerances.length + pmi.dimensions.length;

/** One product's PMI applied to its solids' entities (`solidEntityIds` in solid order). */
export function importProductPmi(
  doc: CadDocument,
  kernel: GeometryKernel,
  pmi: ExchangePmi,
  solidEntityIds: readonly string[],
  source: string,
): PmiImportOutcome {
  const total = itemCount(pmi);
  let next = doc;
  let items = 0;
  let unresolved = 0;
  let mapped = 0;
  let offset = 0;
  for (const entityId of solidEntityIds) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined || kernel.faceQuery === undefined) break;
    const recipe = operandRecipe(kernel, entity);
    const frame = openSolid(kernel, recipe);
    if ('code' in frame) break;
    const start = offset;
    offset += frame.details.length;
    const chosen = new Map<number, Vec3 | undefined>();
    const pointsOf = (faces: readonly number[]): readonly Vec3[] | null => {
      const points: Vec3[] = [];
      for (const face of faces) {
        const detail = face >= start && face < offset ? frame.details[face - start] : undefined;
        if (detail === undefined) return null;
        if (!chosen.has(face)) chosen.set(face, pointOn(frame, detail));
        const point = chosen.get(face);
        if (point === undefined) return null;
        points.push(point);
      }
      return points;
    };
    const { drafts } = fromExchangePmi(pmi, pointsOf);
    if (drafts.length === 0) continue;
    const applied = applyPmiDrafts(next, { entity, recipe, kernel }, drafts as readonly PmiDraft[], source);
    next = applied.document;
    items += applied.ids.length;
    unresolved += applied.unresolved;
    mapped += applied.ids.length;
  }
  return { document: next, items, unresolved, unmapped: Math.max(0, total - mapped) };
}

/** `doc` with the totals of the whole import recorded in `doc.pmi.import` (nothing when the file held no PMI). */
export function recordPmiImport(doc: CadDocument, source: string, outcomes: readonly PmiImportOutcome[]): CadDocument {
  if (outcomes.length === 0) return doc;
  return withImportRecord(doc, {
    source,
    items: outcomes.reduce((sum, outcome) => sum + outcome.items, 0),
    unresolved: outcomes.reduce((sum, outcome) => sum + outcome.unresolved, 0),
    unmapped: outcomes.reduce((sum, outcome) => sum + outcome.unmapped, 0),
  });
}
