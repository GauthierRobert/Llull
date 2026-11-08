/** substitute_material (PHY-12 FR-SEL-07, 11): the what-if of a material swap on parts - mass (exact path), stiffness and mass under a named design rule. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument, Entity } from '@core/model/types';
import { issue, REVIEW_SENTENCE, refuseSel } from './codes';
import { DESIGN_RULES, isStrengthRule, ratiosOf, type DesignRule, type Side } from './designRules';
import { MAX_CANDIDATES, strengthSchema, unique } from './inputs';
import { resolveProperty } from './properties';
import { substituteMargins, type MarginsOutcome } from './substituteMargins';
import type { PropertyUse, StrengthProperty } from './types';

const COMMAND = 'substitute_material';

type Failure = { readonly code: string; readonly message: string; readonly ids: readonly string[]; readonly path: string };

interface Measured {
  readonly massG: number;
  readonly geometryMethods: readonly string[];
  readonly reviewReasons: readonly string[];
}

/** Total mass of `entityIds` by the core mass path (mass_properties through the registry, never a second implementation). */
function measureMass(doc: CadDocument, entityIds: readonly string[], ctx: ExecutionContext | undefined): Measured | Failure {
  let massG = 0;
  const geometryMethods = new Set<string>();
  const reviewReasons = new Set<string>();
  for (const entityId of entityIds) {
    const result = execute(doc, 'mass_properties', { entityId }, ctx);
    const data = result.data as { massG?: number; method?: string; reviewRequired?: { reasons?: readonly string[] } } | undefined;
    if (data?.massG === undefined || !Number.isFinite(data.massG))
      return {
        code: 'SEL_ENTITY_NOT_FOUND',
        message: `'${entityId}' is not measurable by mass_properties (${result.summary})`,
        ids: [entityId],
        path: 'entityIds',
      };
    massG += data.massG;
    if (data.method !== undefined) geometryMethods.add(data.method);
    for (const reason of data.reviewRequired?.reasons ?? []) reviewReasons.add(reason);
  }
  return { massG, geometryMethods: [...geometryMethods].sort(), reviewReasons: [...reviewReasons].sort() };
}

const isFailure = (value: Measured | Failure): value is Failure => 'code' in value;

/** An in-memory copy with `entityIds` made of `material`: used for the measurement only, never returned. */
function swapped(doc: CadDocument, entityIds: readonly string[], material: string): CadDocument {
  const entities: Record<string, Entity> = { ...doc.entities };
  for (const id of entityIds) {
    const entity = entities[id];
    if (entity !== undefined) entities[id] = { ...entity, materialId: material };
  }
  return { ...doc, entities };
}

/** One side's values in base units, or the first refusal. */
function sideOf(
  doc: CadDocument,
  material: string,
  needs: { readonly e: boolean; readonly strength: StrengthProperty | undefined },
): { readonly side: Side; readonly inputs: PropertyUse[] } | Failure {
  const inputs: PropertyUse[] = [];
  const read = (property: string, unit: string): number | Failure => {
    const found = resolveProperty(doc, material, property, unit);
    if (!found.ok) return { code: found.code, message: `'${material}': ${found.reason}`, ids: [material], path: property };
    if (!(found.use.value > 0))
      return { code: 'SEL_PROPERTY_MISSING', message: `'${material}': ${property} is not positive`, ids: [material], path: property };
    inputs.push(found.use);
    return found.use.value;
  };
  const rho = read('density', 'Mg/m^3');
  if (typeof rho !== 'number') return rho;
  const e = needs.e ? read('E', 'GPa') : undefined;
  if (e !== undefined && typeof e !== 'number') return e;
  const strength = needs.strength === undefined ? undefined : read(needs.strength, 'MPa');
  if (strength !== undefined && typeof strength !== 'number') return strength;
  return { side: { rho, ...(e !== undefined ? { e } : {}), ...(strength !== undefined ? { strength } : {}) }, inputs };
}

function marginsSummary(margins: MarginsOutcome | undefined): string {
  if (margins?.kind !== 'data') return '';
  const data = margins.data as { code?: string; failedConditions?: string[]; minMs?: { from: number | null; to: number | null } };
  if (data.code === 'SEL_MARGINS_NEED_RESOLVE')
    return `; margins NOT rescaled (${data.failedConditions?.join(', ') ?? ''} fail): run data.margins.resolvePlan`;
  if (data.code === 'SEL_NO_ANALYSIS') return '; margins: no analysis (SEL_NO_ANALYSIS)';
  return `; min MS ${data.minMs?.from ?? 'n/a'} -> ${data.minMs?.to ?? 'n/a'} (rescaled, exact for one material)`;
}

const percent = (ratio: number): string => `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)} %`;

/**
 * @affects nothing - read-only (the swap is made on an in-memory copy that is never returned); data { entityIds, from, to, designRule, mass, stiffness?, resized?, inputs, unverified, unverifiedReasons, reviewRequired }
 * @invariant same_geometry: mass before / after by mass_properties on the real and the swapped copy (exact path, ratio = after / before), stiffness E2 / E1, deflection E1 / E2, modal frequency sqrt((E2/rho2) / (E1/rho1)), buckling E2 / E1;
 *   equal_* rules: closed forms of the index rule table on the idealised part (method index_rule), never the CAD geometry; no value imputed
 * @failure designRule omitted SEL_DESIGN_RULE_UNSET, equal_strength without strengthProperty SEL_STRENGTH_PROPERTY_UNSET, unknown entity SEL_ENTITY_NOT_FOUND, an entity not made of `from`
 *   SEL_MATERIAL_NOT_ASSIGNED, unknown material SEL_MATERIAL_NOT_FOUND, a missing density / E / strength SEL_PROPERTY_MISSING (refusals, unchanged doc)
 */
export const substituteMaterial = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'What-if of changing the material of parts, without changing the document: how mass and stiffness move if entityIds (made of `from`) were made of `to`. You MUST name the designRule: ' +
    'same_geometry keeps the CAD shape: mass is measured with mass_properties on the real and on an in-memory swapped copy (exact path; data.mass.method same_geometry), stiffness ratio E2/E1, deflection E1/E2, ' +
    'modal frequency sqrt((E2/rho2)/(E1/rho1)), linear buckling factor E2/E1 (a single-material part with the same Poisson ratio). equal_stiffness_tie / beam / panel and equal_strength_tie / beam / panel re-size an idealised part of that loading case so that ' +
    'stiffness (or strength, with strengthProperty Fty / Ftu / Fcy) is unchanged: mass ratio (rho2/rho1)(P1/P2)^n with n = 1, 1/2, 1/3 (stiffness) or 1, 2/3, 1/2 (strength), data.resized gives the new size factor; ' +
    'data.mass.method is index_rule: an idealised part, not your geometry (rebuild with parameters for an exact mass). Values come from the stored sourced properties; a missing density / E / strength refuses with SEL_PROPERTY_MISSING (never imputed); ' +
    'typical / supplier / legacy values make the answer unverified. Returns data { entityIds, from, to, designRule, mass: { beforeG, afterG, ratio, method }, stiffness?: { ratio, deflectionRatio, modalFrequencyRatio?, bucklingFactorRatio? }, resized?, inputs, ' +
    'unverified, unverifiedReasons, reviewRequired: true, margins? }. include margins (same_geometry only) rescales the compute_margins rows of the current 05 results as MS2 = (1 + MS1) A2/A1 - 1, EXACT only for one material with the same ' +
    'Poisson ratio (nuTolerance, default 0), no gravity, no thermal load, no non-zero prescribed displacement and current results; data.margins.method is then rescaled with rows { msFrom, msTo, allowable from / to }. If a condition fails data.margins is ' +
    '{ code SEL_MARGINS_NEED_RESOLVE, failedConditions, conditions, resolvePlan } (run the plan on a copy: assign_material, fea_mesh, fea_solve, compute_margins) and no margin is guessed; no analysis gives SEL_NO_ANALYSIS. ' +
    'Applying the swap is assign_material (a released part needs a change order first). Read-only.',
  params: z.object({
    entityIds: z.array(z.string()).max(MAX_CANDIDATES).describe('3D solid entities to re-material, all made of `from`.'),
    from: z.string().describe('Current material id of every entity.'),
    to: z.string().describe('Candidate material id (must exist in the document: import_material_library / define_material_record).'),
    designRule: z
      .enum(DESIGN_RULES)
      .optional()
      .describe(
        'REQUIRED: same_geometry | equal_stiffness_tie | equal_stiffness_beam | equal_stiffness_panel | equal_strength_tie | equal_strength_beam | equal_strength_panel.',
      ),
    strengthProperty: strengthSchema.optional(),
    include: z
      .array(z.enum(['mass', 'stiffness', 'margins']))
      .optional()
      .describe(
        'Parts of the answer: mass, stiffness, margins. Omit for mass and stiffness (stiffness is not defined for the equal_strength rules). margins needs designRule same_geometry and an analysis (static / thermo_static) with verified, current results.',
      ),
    analysisId: z
      .string()
      .optional()
      .describe('Analysis case whose margins are rescaled (include margins). Omit when exactly one case has the entities as parts.'),
    marginalBand: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Same as compute_margins marginalBand: rows with MS below it are MARGINAL (include margins). Omit for none: no row is MARGINAL.',
      ),
    nuTolerance: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Largest |nu_to - nu_from| accepted for rescaling margins. Omit for the named default 0 (identical Poisson ratios); a band needs a sourced error bound.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { from, to, designRule } = params;
    const entityIds = unique(params.entityIds);
    const refuse = (failure: Failure): CommandResult => refuseSel(doc, COMMAND, failure.code, failure.message, failure.ids, [failure.path]);
    if (designRule === undefined)
      return refuseSel(doc, COMMAND, 'SEL_DESIGN_RULE_UNSET', `name the designRule (${DESIGN_RULES.join(', ')})`, [], ['designRule']);
    const rule: DesignRule = designRule;
    if (isStrengthRule(rule) && params.strengthProperty === undefined)
      return refuseSel(doc, COMMAND, 'SEL_STRENGTH_PROPERTY_UNSET', `${rule} needs a strength property`, [], ['strengthProperty']);
    if (entityIds.length === 0 || from === to)
      return refuseSel(
        doc,
        COMMAND,
        'SEL_PARAMS_INVALID',
        entityIds.length === 0 ? 'no entity given' : `from and to are both '${from}'`,
        [],
        [entityIds.length === 0 ? 'entityIds' : 'to'],
      );
    const unknownMaterials = [from, to].filter((id) => !Object.hasOwn(doc.materials, id));
    if (unknownMaterials.length > 0)
      return refuse({
        code: 'SEL_MATERIAL_NOT_FOUND',
        message: `no material ${unknownMaterials.map((id) => `'${id}'`).join(', ')}`,
        ids: unknownMaterials,
        path: 'from',
      });
    const missingEntities = entityIds.filter((id) => !Object.hasOwn(doc.entities, id));
    if (missingEntities.length > 0)
      return refuse({
        code: 'SEL_ENTITY_NOT_FOUND',
        message: `no entity ${missingEntities.map((id) => `'${id}'`).join(', ')}`,
        ids: missingEntities,
        path: 'entityIds',
      });
    const wrong = entityIds.filter((id) => doc.entities[id]?.materialId !== from);
    if (wrong.length > 0)
      return refuse({
        code: 'SEL_MATERIAL_NOT_ASSIGNED',
        message: `${wrong.map((id) => `'${id}'`).join(', ')} not made of '${from}'`,
        ids: wrong,
        path: 'from',
      });
    const include = params.include ?? ['mass', 'stiffness'];
    if (include.includes('margins') && rule !== 'same_geometry')
      return refuseSel(
        doc,
        COMMAND,
        'SEL_PARAMS_INVALID',
        'margins need designRule same_geometry: the analysed geometry must not change',
        [],
        ['include'],
      );
    const strength = isStrengthRule(rule) ? params.strengthProperty : undefined;
    const needsE = rule !== 'same_geometry' ? !isStrengthRule(rule) : include.includes('stiffness');
    const before = sideOf(doc, from, { e: needsE, strength });
    if ('code' in before) return refuse(before);
    const after = sideOf(doc, to, { e: needsE, strength });
    if ('code' in after) return refuse(after);
    const ratios = ratiosOf(rule, before.side, after.side);
    if (ratios === null)
      return refuse({
        code: 'SEL_PROPERTY_MISSING',
        message: `${rule} needs E / strength of both materials`,
        ids: [from, to],
        path: 'designRule',
      });
    const beforeMass = measureMass(doc, entityIds, ctx);
    if (isFailure(beforeMass)) return refuse(beforeMass);
    const afterMass = rule === 'same_geometry' ? measureMass(swapped(doc, entityIds, to), entityIds, ctx) : beforeMass;
    if (isFailure(afterMass)) return refuse(afterMass);
    const massRatio = rule === 'same_geometry' ? afterMass.massG / beforeMass.massG : ratios.massRatio;
    const afterG = rule === 'same_geometry' ? afterMass.massG : beforeMass.massG * ratios.massRatio;
    const inputs = { from: before.inputs, to: after.inputs };
    const weak = [...before.inputs.map((input) => [from, input] as const), ...after.inputs.map((input) => [to, input] as const)].filter(
      ([, input]) => input.unverified,
    );
    const unverifiedReasons = [
      ...new Set(weak.map(([material, input]) => `${material} ${input.property}: ${input.unverifiedReasons.join(', ')}`)),
    ];
    const margins = include.includes('margins')
      ? substituteMargins(
          doc,
          { entityIds, from, to, analysisId: params.analysisId, nuTolerance: params.nuTolerance, marginalBand: params.marginalBand },
          ctx,
        )
      : undefined;
    if (margins?.kind === 'refused') return refuse({ code: margins.code, message: margins.message, ids: [], path: margins.path });
    const marginsUnverified = margins?.unverified === true;
    const warnings = [
      ...(weak.length === 0 ? [] : [issue('SEL_VALUE_UNVERIFIED', 'warning', unverifiedReasons.join('; '), [from, to])]),
      ...(margins?.warnings ?? []),
    ];
    const stiffness = include.includes('stiffness') ? ratios.stiffness : undefined;
    const mass = {
      beforeG: beforeMass.massG,
      afterG,
      ratio: massRatio,
      method: rule === 'same_geometry' ? 'same_geometry' : 'index_rule',
      geometryMethods: beforeMass.geometryMethods,
    };
    const data = {
      entityIds,
      from,
      to,
      designRule: rule,
      ...(include.includes('mass') ? { mass } : {}),
      ...(stiffness !== undefined ? { stiffness } : {}),
      ...(ratios.resized !== undefined ? { resized: ratios.resized } : {}),
      ...(margins === undefined ? {} : { margins: margins.data }),
      inputs,
      warnings,
      unverified: weak.length > 0 || marginsUnverified,
      unverifiedReasons,
      reviewRequired: true,
      reviewReasons: beforeMass.reviewReasons,
    };
    return report(
      doc,
      `${COMMAND}: ${entityIds.join(', ')} '${from}' -> '${to}' (${rule}): ` +
        `${include.includes('mass') ? `mass ${Number(beforeMass.massG.toPrecision(7))} g -> ${Number(afterG.toPrecision(7))} g (x${Number(massRatio.toPrecision(7))}, ${percent(massRatio)}${rule === 'same_geometry' ? '' : ', idealised part'})` : ''}` +
        `${stiffness === undefined ? '' : `; stiffness x${Number(stiffness.ratio.toPrecision(7))}`}` +
        `${ratios.resized === undefined ? '' : `; ${ratios.resized.dimension} x${Number(ratios.resized.factor.toPrecision(7))}`}` +
        `${marginsSummary(margins)}${weak.length > 0 || marginsUnverified ? '; UNVERIFIED inputs (typical / supplier / legacy values)' : ''}; ${REVIEW_SENTENCE}.`,
      data,
    );
  },
});
