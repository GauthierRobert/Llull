/** check_space_environment (PHY-14 FR-ENV-03..05, 09, 12, 13): outgassing screening, mass-loss budget and atomic-oxygen recession of the materials in use. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { aoItems } from './aoCheck';
import { budgetOf } from './budget';
import { partsOf, usersOf } from './parts';
import { covered, reviewItems, type ReviewedItem } from './deviations';
import { serviceMismatch } from './serviceCheck';
import { refuseEnv, type EnvItem } from './codes';
import { spaceEnvironmentOf } from './model';
import { outgassingOf, screenMaterial, type MaterialOutgassing, type OutgassingItem } from './outgassing';
import { resolveProfile, shippedProfile, SHIPPED_PROFILE_IDS } from './profiles';
import { appendAll } from '@lib/appendAll';
import { moistureSection, thicknessProblem } from './moistureCheck';
import { quantitySchema } from './units';

const COMMAND = 'check_space_environment';
const NOTE =
  'Screening against test-method limits (ASTM E595 / ECSS-Q-ST-70-02); not a contamination analysis. A qualified materials and processes reviewer must approve the result.';

/** The per-material findings of the outgassing items: RML derived, test method mismatched / unrecorded, value unverified. */
function materialFindings(material: string, items: readonly ReviewedItem[], testMethod: string): EnvItem[] {
  const own = items.filter((item) => item.material === material);
  const findings: EnvItem[] = [];
  if (own.some((item) => item.derived))
    findings.push({ code: 'ENV_RML_DERIVED', severity: 'info', message: `${material}: RML derived as TML - WVR (no measured RML)` });
  const mismatched = own.filter((item) => item.methodMismatch === true);
  if (mismatched.length > 0)
    findings.push({
      code: 'ENV_TEST_METHOD_MISMATCH',
      severity: 'warning',
      message: `${material}: ${mismatched.map((item) => `${item.quantity} (${item.testMethod ?? ''})`).join(', ')} measured with another test method than the profile's ${testMethod}: computed anyway; use data from the profile's method`,
    });
  const unrecorded = own.filter((item) => item.methodUnrecorded === true && item.value !== null);
  if (unrecorded.length > 0)
    findings.push({
      code: 'ENV_TEST_METHOD_UNRECORDED',
      severity: 'info',
      message: `${material}: ${unrecorded.map((item) => item.quantity).join(', ')}: no test method recorded; confirm it was ${testMethod}`,
    });
  if (own.some((item) => item.unverified && item.value !== null))
    findings.push({
      code: 'ENV_VALUE_UNVERIFIED',
      severity: 'warning',
      message: `${material}: a value used is typical, supplier-unstated or unspecified: not a verified basis`,
    });
  return findings;
}

/**
 * @affects nothing; read-only, data { status, profile, items[], findings[], materials[], budget, ao?, moisture?, notes[], reviewRequired }
 * @invariant a material without the data a limit needs is `unknown`, never `pass`; overall status = fail if any item fails, else unknown if any is unknown, else pass; the budget never changes the status; operators `<` / `<=` as stored, guard 1e-12 %
 * @invariant a value measured with another test method than the profile's is judged anyway and flagged ENV_TEST_METHOD_MISMATCH (OQ-ENV-02); moisture items (per part, mission humidity exposure) are info / unknown and never change the status
 * @failure no profile in params or mission -> ENV_PROFILE_UNSET; unknown profile id -> ENV_PROFILE_UNKNOWN; an entity id not in the document, a moistureThickness entity that is no screened part or is given twice, or moistureThickness without a mission humidity exposure -> ENV_PARAM_INVALID (rejections, document unchanged)
 */
export const checkSpaceEnvironment = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Screen the materials in use against an outgassing profile (ASTM E595 / ECSS-Q-ST-70-02 limits), with a screening mass-loss budget and, when the mission has an atomic-oxygen fluence, the recession per material. ' +
    'Profile: `profile` (shipped id nasa_gsfc_screening: TML <= 1.0 %, CVCM <= 0.10 %; ecss_q_st_70_02: RML < 1.00 %, CVCM < 0.10 %) or the mission profile (set_mission_environment); none -> ENV_PROFILE_UNSET. ' +
    'Material values TML, CVCM, WVR, RML (percent) are read from the material records (set_material_property); RML missing is derived as TML - WVR (ENV_RML_DERIVED). A material without a needed value is status ' +
    '"unknown" (ENV_OUTGASSING_DATA_MISSING), never a pass; a failing limit is ENV_OUTGASSING_FAIL. Without `entityIds` every entity (and component entity) with an assigned material is screened. ' +
    'Returns data { status (outgassing), profile, items[{material, entityIds, quantity, op, limit, value, status, code, derived, unverified, valueSource, ruleSource, reviewRequired}], findings[], ' +
    'materials[], budget { perPart[{entityId, material, massG, maxMassLossG, maxCondensableG}], totalMassLossG, totalCondensableG } (screening quantities, mass from mass_properties), ao?{items[]} }. ' +
    'Every item is reviewRequired; values without a verified basis carry the ENV_VALUE_UNVERIFIED finding. No E595 data is bundled: the values are yours (a test report) or an imported library. ' +
    'Test method: a value stored with set_material_property testMethod equal to the profile method (ASTM_E595 / ECSS_Q_ST_70_02) is preferred; a value of another method is judged anyway with ENV_TEST_METHOD_MISMATCH (warning); a value without a recorded method gives ENV_TEST_METHOD_UNRECORDED (info). An ambiguous or refused read of the profile method is unknown, never replaced by another method. ' +
    'Moisture: when the mission has a humidityExposure, data.moisture.items[] gives per part {entityId, rootId, material, status, code, thickness, moisturePercent, fraction, saturationPercent, massG, waterUptakeG, saturationWaterG} ' +
    'from moisture_uptake (material moistureDiffusivity / moistureSaturation) with the plate thickness from `moistureThickness`; a part without one is unknown (ENV_MOISTURE_THICKNESS_UNSET) with only the saturation bound. Moisture never changes the status. ' +
    'Example: a 200 g part, TML 0.95 %, CVCM 0.05 %: pass under nasa_gsfc_screening, maxMassLossG 1.9, maxCondensableG 0.1.',
  params: z.object({
    entityIds: z.array(z.string()).max(100000).optional().describe('Entities to screen (default: every entity with an assigned material).'),
    profile: z
      .string()
      .optional()
      .describe(
        'Shipped profile id (nasa_gsfc_screening, ecss_q_st_70_02) or the id of the mission custom profile; default: the mission profile.',
      ),
    moistureThickness: z
      .array(
        z.object({
          entityId: z
            .string()
            .describe(
              'A screened part: a top-level solid id, an instanced child id (expanded::<instance>::<source>) or a top-level instance id (all its children); an id inside a component definition is refused.',
            ),
          thickness: quantitySchema.describe('Plate thickness through which moisture diffuses, a length (e.g. {value: 2, unit: "mm"}).'),
        }),
      )
      .max(100000)
      .optional()
      .describe(
        'Part thicknesses for the per-part moisture state (needs the mission humidityExposure); a part id wins over its instance id.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const mission = spaceEnvironmentOf(doc);
    const reference = params.profile ?? mission.outgassingProfile;
    if (reference === undefined)
      return refuseEnv(
        doc,
        COMMAND,
        'ENV_PROFILE_UNSET',
        'no outgassing profile: pass `profile` or set one in the mission',
        [],
        ['profile'],
      );
    const custom = typeof mission.outgassingProfile === 'object' ? mission.outgassingProfile : undefined;
    const profile =
      typeof reference === 'string' && custom !== undefined && custom.id === reference ? custom : (resolveProfile(reference) ?? undefined);
    if (profile === undefined)
      return refuseEnv(
        doc,
        COMMAND,
        'ENV_PROFILE_UNKNOWN',
        `no profile '${String(reference)}' (shipped: ${SHIPPED_PROFILE_IDS.join(', ')})`,
        [],
        ['profile'],
      );
    const missingIds = (params.entityIds ?? []).filter((id) => !Object.hasOwn(doc.entities, id));
    if (missingIds.length > 0)
      return refuseEnv(
        doc,
        COMMAND,
        'ENV_PARAM_INVALID',
        `entities not found: ${missingIds.slice(0, 10).join(', ')}`,
        missingIds.slice(0, 10),
        ['entityIds'],
      );

    const { parts, skipped } = partsOf(doc, params.entityIds);
    const thicknesses = params.moistureThickness ?? [];
    const unusable = thicknessProblem(parts, thicknesses, mission.humidityExposure);
    if (unusable !== null) return refuseEnv(doc, COMMAND, 'ENV_PARAM_INVALID', unusable.message, unusable.ids, ['moistureThickness']);
    const users = usersOf(parts);
    const data = new Map<string, MaterialOutgassing>();
    const screened: OutgassingItem[] = [];
    for (const [material, entityIds] of users) {
      const read = outgassingOf(doc, ctx, material, profile.testMethod);
      data.set(material, read);
      appendAll(screened, screenMaterial(material, entityIds, read, profile));
    }
    const items = reviewItems(doc, ctx?.humanSignature ?? null, screened, profile.id, mission.deviations ?? {});
    const open = items.filter((item) => !covered(item));
    const failed = open.filter((item) => item.status === 'fail');
    const unknown = open.filter((item) => item.status === 'unknown');
    const status = items.length === 0 ? 'unknown' : failed.length > 0 ? 'fail' : unknown.length > 0 ? 'unknown' : 'pass';
    const accepted = items.length - open.length;

    const findings: EnvItem[] = [];
    for (const [material] of users) appendAll(findings, materialFindings(material, items, profile.testMethod));
    for (const entry of skipped)
      findings.push({
        code: 'ENV_PARTS_SKIPPED',
        severity: 'warning',
        message: `${entry.rootId}: parts not listed (${entry.reason}); the budget is incomplete`,
      });
    const mismatch = serviceMismatch(doc, mission.humidityExposure);
    if (mismatch !== null) findings.push({ code: 'ENV_SERVICE_ENVIRONMENT_MISMATCH', severity: 'warning', message: mismatch });
    const budget = budgetOf(ctx, parts, data, skipped);
    const ao =
      mission.aoFluence === undefined ? undefined : { fluence: mission.aoFluence, items: aoItems(doc, ctx, users, mission.aoFluence) };
    const moisture =
      mission.humidityExposure === undefined ? undefined : moistureSection(doc, ctx, mission.humidityExposure, parts, thicknesses, budget);
    if (moisture !== undefined) appendAll(findings, moisture.findings);
    const notes = [NOTE];
    const materials = [...users].map(([material, entityIds]) => {
      const own = open.filter((item) => item.material === material);
      return {
        material,
        entityIds,
        status: own.some((item) => item.status === 'fail') ? 'fail' : own.some((item) => item.status === 'unknown') ? 'unknown' : 'pass',
      };
    });
    const profileData = {
      id: profile.id,
      label: profile.label,
      testMethod: profile.testMethod,
      source: profile.source,
      status: profile.status,
    };
    const result = {
      status,
      profile: profileData,
      items,
      findings,
      materials,
      budget,
      ...(ao === undefined ? {} : { ao }),
      ...(moisture === undefined ? {} : { moisture: { exposure: moisture.exposure, items: moisture.items } }),
      notes,
      counts: { accepted },
      reviewRequired: true,
    };
    const name = (list: readonly { material: string; quantity: string }[]): string =>
      [...new Set(list.map((item) => `${item.material} ${item.quantity}`))].join(', ');
    const dataMissing = unknown.length > 0 ? ` Unknown (ENV_OUTGASSING_DATA_MISSING): ${name(unknown)}.` : '';
    const failing = failed.length > 0 ? ` Fail (ENV_OUTGASSING_FAIL): ${name(failed)}.` : '';
    const noneNote = items.length === 0 ? ' No entity with an assigned material was screened: status unknown.' : '';
    return report(
      doc,
      `${COMMAND}: profile ${profile.id}${shippedProfile(profile.id) === undefined ? ' (custom)' : ''}: ${status.toUpperCase()} over ${users.size} material(s), ${items.length} limit check(s): ${open.length - failed.length - unknown.length} pass, ${failed.length} fail, ${unknown.length} unknown${accepted > 0 ? `, ${accepted} covered by a confirmed human deviation` : ''}.${failing}${dataMissing}${noneNote} ` +
        `Screening budget (not a contamination prediction): max mass loss ${budget.totalMassLossG.toPrecision(6)} g, max condensables ${budget.totalCondensableG.toPrecision(6)} g over ${budget.counted} part(s)` +
        `${budget.uncounted > 0 ? `, ${budget.uncounted} part(s) without a figure` : ''}.${ao === undefined ? '' : ` AO fluence ${ao.fluence.value} ${ao.fluence.unit}: ${ao.items.filter((item) => item.status === 'info').length} material(s) with a recession figure.`}${moisture === undefined ? '' : ` Moisture over ${moisture.exposure.duration.value} ${moisture.exposure.duration.unit} at ${moisture.exposure.relativeHumidity} % RH: ${moisture.items.filter((item) => item.status === 'info').length} of ${moisture.items.length} part(s) with a moisture state.`} Review required.`,
      result,
    );
  },
});
