/** MaterialCardWriter (PHY-02 §3.5 / FE_PIPELINE_DESIGN §5): constitutive sets beyond linear elasticity reach the INP through the PHY-02 card writer. */

import { combinationIssues, findSet, setMembers } from '@core/model/materialLaws/combination';
import { isMaterialCardsRefusal, writeMaterialCards } from '@core/model/materialLaws/cardWriter';
import { buildFeaConstitutiveView, type FeaConstitutiveView } from '@core/model/materialLaws/feaView';
import { SET_SLOTS } from '@core/model/materialModel';
import type { DeckContext, DeckRefusal } from './context';
import { commentText, linesText, row } from './format';
import { densityToAnalysis } from './units';

/** What a constitutive material contributes to the deck: provenance comment lines, the `*MATERIAL` block and its view. */
interface ConstitutiveDeckCards {
  /** `** llull material …` header, then `** UNVERIFIED` / `** REVIEW REQUIRED` flags when they apply. */
  readonly comments: readonly string[];
  /** Exactly the lines `export_material_cards` returns (starting with `*MATERIAL,NAME=`), then `*DENSITY`. */
  readonly lines: readonly string[];
  readonly view: FeaConstitutiveView;
}

/** Deck hook: constitutive cards of the material of a part, null when the part keeps the elastic / thermal cards. */
export type MaterialCardWriter = (ctx: DeckContext, entityId: string) => ConstitutiveDeckCards | DeckRefusal | null;

/**
 * Cards of the default constitutive set of the part's material when that set has a member besides the elastic law (plastic, hyperelastic,
 * creep, rate, viscoelastic); null otherwise (the elastic-only output is written by `mechanicalMaterialLines`).
 * @invariant lines are `writeMaterialCards` output verbatim (the text `export_material_cards` returns) plus `*DENSITY`; N-mm-t-s only (cards are MPa)
 * @failure other unit system / law the target cannot represent -> MATL_EXPORT_UNSUPPORTED; broken set -> MATL_COMBINATION_INVALID;
 *   model without validity -> MATL_VALIDITY_MISSING; property-model refusals pass through
 */
export const constitutiveMaterialCards: MaterialCardWriter = (ctx, entityId) => {
  const material = ctx.materialOf(entityId);
  const materialId = ctx.materialId(entityId);
  if (material === null || materialId === undefined) return null;
  const set = findSet(material.constitutiveSets, material.defaultConstitutiveSet);
  if (set === undefined || !SET_SLOTS.some((slot) => slot !== 'elastic' && set[slot] !== undefined)) return null;
  const refuse = (code: string, message: string): DeckRefusal => ({ code, message, ids: [entityId] });
  if (ctx.unitSystem !== 'N-mm-t-s')
    return refuse(
      'MATL_EXPORT_UNSUPPORTED',
      `material '${materialId}' set '${set.id}': constitutive cards are written in MPa; unit system ${ctx.unitSystem} is not supported (use N-mm-t-s)`,
    );
  const models = material.materialModels ?? [];
  const slots = setMembers(set, models);
  const issue = combinationIssues(set, Object.values(slots))[0];
  if (issue !== undefined) return refuse(issue.code, `material '${materialId}' set '${set.id}': ${issue.message}`);
  const record = { name: materialId, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  const cards = writeMaterialCards({
    record,
    materialId,
    setId: set.id,
    slots,
    target: 'calculix',
    name: ctx.materialName(entityId),
    mid: 1,
    temperaturesK: [],
  });
  if (isMaterialCardsRefusal(cards)) return refuse(cards.code, `material '${materialId}' set '${set.id}': ${cards.message}`);
  const view = buildFeaConstitutiveView(materialId, set.id, ctx.unitSystem, slots, cards);
  const density = densityToAnalysis(material.density, ctx.doc.units, ctx.unitSystem);
  return {
    comments: [
      cards.header,
      ...(view.unverified ? [`** UNVERIFIED: ${commentText(view.unverifiedReasons.join('; '), 400)}`] : []),
      ...(view.reviewRequired ? ['** REVIEW REQUIRED: fitted model not accepted by a reviewer'] : []),
    ],
    lines: [
      ...cards.lines,
      ...linesText(['*DENSITY', row(density)])
        .split('\n')
        .filter((line) => line !== ''),
    ],
    view,
  };
};

/** Views of the constitutive materials of an analysis (one per distinct material), in part order; refusals are skipped (the deck reports them). */
export function deckConstitutiveViews(ctx: DeckContext, write: MaterialCardWriter = constitutiveMaterialCards): FeaConstitutiveView[] {
  const views = new Map<string, FeaConstitutiveView>();
  for (const entityId of Object.keys(ctx.analysis.parts)) {
    const cards = write(ctx, entityId);
    if (cards !== null && 'view' in cards) views.set(cards.view.recordId, cards.view);
  }
  return [...views.values()];
}
