/** thermo_static deck sections (PHY-04 §5.1, TR-TMC-11): secant `*EXPANSION, ZERO=`, initial temperature, `*TEMPERATURE` per node, outputs. */

import { isCteRefusal } from '@core/model/materialCte';
import type { DeckContext, DeckSections } from '../decks/context';
import { commentText, num } from '../decks/format';
import { mechanicalStepLines } from '../decks/mechanical';
import { providerFor, secantExpansion } from './cte';
import { resolveTemperatureField, thermomechOf } from './field';
import { kelvinOf, temperatureIn } from './units';

const refused = (code: string, message: string, ids: readonly string[]): DeckSections => ({ code, message, ids });

/**
 * Lines appended inside the part's open `*MATERIAL`: header comment (model, sha256, basis, conversion) and `*EXPANSION, ZERO=<T_ref>`.
 * @failure not thermo_static -> THM_CASE_TYPE; no material -> TMC_MATERIAL_NO_CTE; TMC_CTE_BASIS_UNKNOWN / PHY-01 codes from the CTE
 *   provider; field codes of `resolveTemperatureField`
 */
export function thermomechMaterialCards(ctx: DeckContext, entityId: string): DeckSections {
  const setup = thermomechOf(ctx.analysis);
  if (setup === undefined)
    return refused('THM_CASE_TYPE', `analysis '${ctx.analysisId}' is not a thermo_static analysis`, [ctx.analysisId]);
  const entity = Object.hasOwn(ctx.doc.entities, entityId) ? ctx.doc.entities[entityId] : undefined;
  const materialId = entity?.materialId;
  if (materialId === undefined)
    return refused('TMC_MATERIAL_NO_CTE', `part '${entityId}' has no material, so it has no thermal expansion`, [entityId]);
  const scale = setup.temperatureScale;
  const reference = temperatureIn(setup.referenceTemperature, scale);
  if (reference === null) return refused('THM_UNITS_MISMATCH', 'the reference temperature has an invalid unit', [ctx.analysisId]);
  const field = resolveTemperatureField(ctx.doc, ctx.analysisId, ctx.mesh, ctx.artifacts);
  if (!field.ok) return refused(field.code, field.message, field.ids);
  const provider = providerFor(ctx.doc, setup, materialId, 'material');
  if (isCteRefusal(provider)) return refused(provider.code, provider.reason, [materialId, entityId]);
  const table = secantExpansion(
    ctx.doc,
    materialId,
    provider,
    kelvinOf(reference, scale),
    kelvinOf(field.min, scale),
    kelvinOf(field.max, scale),
    scale,
  );
  if ('code' in table) return refused(table.code, table.reason, [materialId, entityId]);
  const lines = [
    `** thermal expansion of '${commentText(materialId)}' for part ${commentText(entityId)}: secant alpha about T_ref = ${num(reference)} ${scale}`,
    `** source ${commentText(table.provider.source)}; basis ${commentText(table.provider.basis)}; model sha256 ${commentText(table.modelSha256)}`,
    `** conversion ${commentText(table.provider.conversion)}`,
    ...(table.unverifiedReasons.length > 0 ? [`** UNVERIFIED: ${commentText(table.unverifiedReasons.join('; '), 400)}`] : []),
    `*EXPANSION, ZERO=${num(reference)}`,
    ...table.rows.map((row) => row.map(num).join(', ')),
  ];
  return { text: `${lines.join('\n')}\n` };
}

/**
 * Initial temperature (T_ref on every node), the `*STATIC` step with the mechanical loads of 05, the per-node `*TEMPERATURE` block and
 * the outputs `U`, `S`, `E`, `THE`.
 * @failure not thermo_static -> THM_CASE_TYPE; field codes (TMC_FIELD_*, TMC_MESH_MISMATCH, TMC_THERMAL_RESULT_STALE, FEA_RESULTS_MISSING);
 *   the 05 mechanical step refusal is passed through
 */
export function thermomechSections(ctx: DeckContext): DeckSections {
  const setup = thermomechOf(ctx.analysis);
  if (setup === undefined)
    return refused('THM_CASE_TYPE', `analysis '${ctx.analysisId}' is not a thermo_static analysis`, [ctx.analysisId]);
  const reference = temperatureIn(setup.referenceTemperature, setup.temperatureScale);
  if (reference === null) return refused('THM_UNITS_MISMATCH', 'the reference temperature has an invalid unit', [ctx.analysisId]);
  const field = resolveTemperatureField(ctx.doc, ctx.analysisId, ctx.mesh, ctx.artifacts);
  if (!field.ok) return refused(field.code, field.message, field.ids);
  const mechanical = mechanicalStepLines(ctx);
  if (!('text' in mechanical)) return mechanical;
  const lines = [
    `** thermo-mechanical analysis ${commentText(ctx.analysisId)}: T_ref ${num(reference)} ${setup.temperatureScale}; field ${commentText(field.description, 240)}`,
    '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
    ...ctx.mesh.nodes.map(([id]) => `${id}, ${num(reference)}`),
    '*STEP',
    '*STATIC',
  ];
  const step = [
    '*TEMPERATURE',
    ...ctx.mesh.nodes.map(([id], i) => `${id}, ${num(field.values[i] ?? Number.NaN)}`),
    '*NODE FILE',
    'U, NT',
    '*EL FILE',
    'S, E, THE',
    '*END STEP',
  ];
  return { text: `${lines.join('\n')}\n${mechanical.text.replace(/\n*$/, '\n')}${step.join('\n')}\n` };
}
