/** The single solver-card implementation (PHY-02 §6): `export_material_cards` and the CalculiX deck writer both call `writeMaterialCards`. */

import { canonicalJson } from '../../lib/canonicalJson';
import { sha256Hex } from '../../lib/sha256';
import { SET_SLOTS, type MaterialModel, type SetSlot } from '../materialModel';
import type { PropertyRecord } from '../propertyModelEval';
import { writeCalculixCards } from './cardsCalculix';
import { writeNastranCards } from './cardsNastran';
import type { MatlIssue } from './issues';
import { modelUnverifiedReasonsOf, needsReview } from './references';

type CardTarget = 'calculix' | 'nastran';

export interface MaterialCardsRequest {
  readonly record: PropertyRecord;
  /** Document material id (provenance header). */
  readonly materialId: string;
  readonly setId: string;
  readonly slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>;
  readonly target: CardTarget;
  /** Card name (`*MATERIAL,NAME=`). */
  readonly name: string;
  readonly mid: number;
  readonly temperaturesK: readonly number[];
  readonly forCertification?: boolean;
}

export interface MaterialCards {
  readonly lines: readonly string[];
  /** Provenance comment line (hash, unverified reasons) to put above the lines. */
  readonly header: string;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean;
  readonly warnings: readonly MatlIssue[];
  readonly usedDefaults: readonly string[];
}

export interface MaterialCardsRefusal {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly remediation?: string;
  /** Present with MAT_VALUE_UNVERIFIED. */
  readonly unverifiedReasons?: readonly string[];
}

export const isMaterialCardsRefusal = (value: MaterialCards | MaterialCardsRefusal): value is MaterialCardsRefusal => 'code' in value;

/** Default card name: `<MATERIAL>_<SET>` upper-cased, characters outside A-Z0-9_ replaced. */
export const defaultCardName = (material: string, set: string): string =>
  `${material}_${set}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80);

/** Ids in the provenance comment: no line breaks, no commas. */
const commentId = (id: string): string => id.replace(/[\r\n,]/g, ' ');

/** The models of a slot map, in set-slot order. */
const slotModels = (
  slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>,
): { readonly slot: SetSlot; readonly model: MaterialModel }[] =>
  SET_SLOTS.flatMap((slot) => {
    const model = slots[slot];
    return model === undefined ? [] : [{ slot, model }];
  });

/**
 * Solver cards of a constitutive set (stress MPa, temperature K).
 * @invariant one text for the UI, CLI and deck writers
 * @failure law the target cannot represent -> MATL_EXPORT_UNSUPPORTED; model without validity -> MATL_VALIDITY_MISSING; forCertification with
 *   unverified data -> MAT_VALUE_UNVERIFIED; property-model refusals pass through
 */
export function writeMaterialCards(request: MaterialCardsRequest): MaterialCards | MaterialCardsRefusal {
  const models = slotModels(request.slots);
  const missing = models.find(({ model }) => model.validity === undefined || model.validity.length === 0);
  if (missing !== undefined)
    return {
      code: 'MATL_VALIDITY_MISSING',
      message: `model '${missing.model.id}' has no validity ranges`,
      path: `models.${missing.model.id}.validity`,
      remediation: 'add validity (equivalentPlasticStrain, T, stretch …) with add_material_model replace: true',
    };
  const output = (request.target === 'calculix' ? writeCalculixCards : writeNastranCards)({
    record: request.record,
    slots: request.slots,
    name: request.name,
    mid: request.mid,
    temperaturesK: request.temperaturesK,
  });
  if ('code' in output) return output;
  const reasons = new Set<string>(output.unverifiedReasons);
  for (const { slot, model } of models)
    for (const reason of modelUnverifiedReasonsOf(model, request.record)) reasons.add(`${slot} '${model.id}': ${reason}`);
  if (request.forCertification === true && reasons.size > 0)
    return {
      code: 'MAT_VALUE_UNVERIFIED',
      message: `the cards are unverified (${[...reasons].join('; ')}) and cannot be used for certification`,
      path: 'forCertification',
      remediation: 'use verified bases and sourced, reviewed models',
      unverifiedReasons: [...reasons],
    };
  const hash = sha256Hex(canonicalJson(Object.fromEntries(models.map(({ slot, model }) => [slot, model.parametersSha256]))));
  const marker = request.target === 'calculix' ? '**' : '$';
  return {
    lines: output.lines,
    header: `${marker} llull material ${commentId(request.materialId)}/${commentId(request.setId)} sha256=${hash} unverified=${
      reasons.size > 0 ? [...reasons].map(commentId).join('; ') : 'none'
    }`,
    unverified: reasons.size > 0,
    unverifiedReasons: [...reasons],
    reviewRequired: request.forCertification === true || output.reviewRequired || models.some(({ model }) => needsReview(model)),
    warnings: output.warnings,
    usedDefaults: output.usedDefaults,
  };
}
