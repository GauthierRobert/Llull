/**
 * CalculiX deck sections of a heat_steady / heat_transient case (PHY-03 §5.1): material cards (`*CONDUCTIVITY`, `*SPECIFIC HEAT`,
 * `*DENSITY`) from the PHY-01 models, and the sections after the sets (physical constants, initial conditions, amplitudes, the heat transfer
 * step with its loads and output requests).
 */

import { siToSystem } from '@lib/thermalUnits';
import { analysisInputHash } from '../hash/inputHash';
import { ALL_NODES, type DeckContext, type DeckRefusal, type DeckSections } from '../decks/context';
import { linesText, num, row } from '../decks/format';
import { absoluteZeroOf, inScale } from './quantities';
import { checkThermalItems } from './check';
import { propertyCards } from './deckMaterial';
import { allBcLines, cavityLines } from './deckLoads';
import { contactBlocks } from './deckContact';
import { filmSinkBlocks } from './deckFilmSink';
import { amplitudeName } from './deckNames';
import { planStep } from './deckStep';
import { hasRadiation, stefanBoltzmannOf } from './constants';
import { partVolumes, indexMesh } from './meshGeometry';

const refusal = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

/**
 * `*CONDUCTIVITY` (always), `*SPECIFIC HEAT` and `*DENSITY` (transient) lines for the material of `entityId`, to sit under the open `*MATERIAL`.
 * Each table is preceded by a comment with the model id, coefficientsSha256, the tabulation tolerance and range.
 * @failure no thermal set-up -> THM_CASE_TYPE; missing property -> THM_MATERIAL_NO_K / THM_MATERIAL_NO_CP; PHY-01 `PROP_OUT_OF_RANGE` and the
 *   other property refusals pass through with their code
 */
export function thermalMaterialCards(ctx: DeckContext, entityId: string): DeckSections {
  const thermal = ctx.analysis.thermal;
  if (thermal === undefined) return refusal('THM_CASE_TYPE', `analysis '${ctx.analysisId}' has no thermal set-up`, [ctx.analysisId]);
  return propertyCards(ctx, thermal, entityId);
}

/** Errors that make the solve meaningless: they stop the deck (the others stay `check_thermal` items). */
const BLOCKING = new Set([
  'THM_INITIAL_TEMPERATURE_MISSING',
  'THM_STEP_INVALID',
  'THM_NO_HEAT_PATH',
  'THM_EMISSIVITY_INVALID',
  'THM_FILM_INVALID',
  'THM_SOURCE_REQUIRED',
  'THM_UNITS_MISMATCH',
  'THM_AMPLITUDE_INVALID',
  'THM_CAVITY_INVALID',
  'THM_CONTACT_INVALID',
]);

/**
 * Initial conditions, amplitudes, physical constants and the `*HEAT TRANSFER` step (loads, output requests) of the case.
 * @failure blocking set-up errors (see `check_thermal`) -> their THM_* code; a BC, cavity face or contact face set that
 *   is not in the mesh -> FEA_TARGET_UNRESOLVED
 */
export function thermalSections(ctx: DeckContext): DeckSections {
  const thermal = ctx.analysis.thermal;
  if (thermal === undefined) return refusal('THM_CASE_TYPE', `analysis '${ctx.analysisId}' has no thermal set-up`, [ctx.analysisId]);
  const blocking = checkThermalItems(ctx.doc, ctx.analysisId).find((item) => item.severity === 'error' && BLOCKING.has(item.code));
  if (blocking !== undefined) return refusal(blocking.code, blocking.message, blocking.ids);
  const steady = ctx.analysis.type === 'heat_steady';
  const scale = thermal.temperatureScale;
  const plan = planStep(thermal, steady);
  if (plan === null) return refusal('THM_STEP_INVALID', 'more than 20000 result times: raise outputEveryS', [ctx.analysisId]);
  const index = indexMesh(ctx.mesh);
  const volumes = partVolumes(index);
  const lines: string[] = [
    `** llull thermal type=${ctx.analysis.type} scale=${scale} unitSystem=${ctx.unitSystem} inputHash=${analysisInputHash(ctx.doc, ctx.analysisId, 'full')}`,
  ];
  if (hasRadiation(thermal))
    lines.push(
      `*PHYSICAL CONSTANTS, ABSOLUTE ZERO=${num(absoluteZeroOf(scale))}, STEFAN BOLTZMANN=${num(siToSystem('stefanBoltzmann', stefanBoltzmannOf(thermal), ctx.unitSystem))}`,
    );
  lines.push(...plan.timePoints);
  if (thermal.initialTemperature !== undefined)
    lines.push('*INITIAL CONDITIONS, TYPE=TEMPERATURE', row(ALL_NODES, inScale(thermal.initialTemperature, scale)));
  const used = [...new Set(thermal.bcOrder.map((id) => thermal.bcs[id]?.amplitude).filter((id): id is string => id !== undefined))].sort();
  for (const id of used) {
    const points = thermal.amplitudes[id]?.points ?? [];
    lines.push(`*AMPLITUDE, NAME=${amplitudeName(id)}`);
    for (let i = 0; i < points.length; i += 4) lines.push(row(...points.slice(i, i + 4).flat()));
  }
  for (const contact of Object.values(thermal.contacts)) {
    const block = contactBlocks(ctx, contact);
    if ('code' in block) return block;
    lines.push(...block.lines);
  }
  const sink = filmSinkBlocks(ctx, thermal);
  if (sink !== null && 'code' in sink) return sink;
  if (sink !== null) lines.push(...sink.model);
  lines.push(...plan.notes, ...plan.stepLines);
  const bcBlocks = allBcLines(ctx, thermal, volumes);
  if ('code' in bcBlocks) return bcBlocks;
  lines.push(...bcBlocks.lines);
  if (sink !== null) lines.push(...sink.step);
  for (const cavity of Object.values(thermal.cavities)) {
    const block = cavityLines(ctx, thermal, cavity);
    if ('code' in block) return block;
    lines.push(...block.lines);
  }
  const output = plan.output === '' ? '' : `, ${plan.output}`;
  lines.push(`*NODE FILE${output}`, 'NT, RFL', `*EL FILE${output}`, 'HFL');
  for (const [probeId, probe] of Object.entries(ctx.analysis.probes)) {
    const key = `P_${probeId}`;
    if (probe.quantity === 'temperature' && Object.hasOwn(ctx.mesh.nodeSets, key))
      lines.push(`*NODE PRINT, NSET=${ctx.nset(key)}${output}`, 'NT');
  }
  lines.push('*END STEP');
  return { text: linesText(lines) };
}
