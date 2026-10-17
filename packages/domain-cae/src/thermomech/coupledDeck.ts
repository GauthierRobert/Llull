/**
 * coupled_temperature_displacement deck sections (PHY-04 TR-TMC-22, steady state): conductivity and secant expansion per material, the
 * initial temperature (= T_ref), one `*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE` step with the 05 mechanical lines and the PHY-03 thermal
 * BCs, outputs `U, NT` and `S, HFL`.
 */

import type { ThermoMechSetup } from '@core/model/analysis';
import { siToSystem } from '@lib/thermalUnits';
import type { DeckContext, DeckSections } from '../decks/context';
import { commentText, linesText, num, row } from '../decks/format';
import { mechanicalStepLines } from '../decks/mechanical';
import { checkThermalItems } from '../thermal/check';
import { stefanBoltzmannOf, hasRadiation } from '../thermal/constants';
import { bcLines } from '../thermal/deckLoads';
import { propertyCards } from '../thermal/deckMaterial';
import { indexMesh, partVolumes } from '../thermal/meshGeometry';
import { caseTemperatureRange } from '../thermal/material';
import { absoluteZeroOf } from '../thermal/quantities';
import { expansionCards, refused } from './deck';
import { temperatureIn } from './units';

/** The thermo-mechanical set-up (with its thermal set-up) of a coupled case, else undefined. */
export const coupledOf = (
  analysis: DeckContext['analysis'],
): (ThermoMechSetup & { readonly thermal: NonNullable<ThermoMechSetup['thermal']> }) | undefined =>
  analysis.type === 'coupled_temperature_displacement' && analysis.thermomech?.thermal !== undefined
    ? { ...analysis.thermomech, thermal: analysis.thermomech.thermal }
    : undefined;

const notCoupled = (ctx: DeckContext): DeckSections =>
  refused('THM_CASE_TYPE', `analysis '${ctx.analysisId}' is not a coupled_temperature_displacement analysis`, [ctx.analysisId]);

/**
 * `*CONDUCTIVITY` (PHY-03 tables over the BC temperature range) and `*EXPANSION, ZERO=<T_ref>` (secant table over the BC temperatures and
 * the reference) of the part's material, to sit under the open `*MATERIAL` after the 05 elastic cards.
 * @failure not coupled -> THM_CASE_TYPE; THM_MATERIAL_NO_K / PHY-01 refusals of the conductivity; TMC_MATERIAL_NO_CTE / TMC_CTE_BASIS_UNKNOWN /
 *   TMC_PROPERTY_OUT_OF_RANGE of the expansion
 */
export function coupledMaterialCards(ctx: DeckContext, entityId: string): DeckSections {
  const setup = coupledOf(ctx.analysis);
  if (setup === undefined) return notCoupled(ctx);
  const conductivity = propertyCards(ctx, setup.thermal, entityId);
  if (!('text' in conductivity)) return conductivity;
  const reference = temperatureIn(setup.referenceTemperature, setup.temperatureScale) ?? Number.NaN;
  const range = caseTemperatureRange(setup.thermal) ?? [reference, reference];
  const expansion = expansionCards(ctx, entityId, setup, range[0], range[1]);
  if (!('text' in expansion)) return expansion;
  return { text: `${conductivity.text}${expansion.text}` };
}

/** Features of the thermal set-up the coupled step does not write (cavities, contacts, amplitudes, h(T) tables): their name, else null. */
function unsupported(setup: NonNullable<ReturnType<typeof coupledOf>>): string | null {
  const { thermal } = setup;
  if (Object.keys(thermal.cavities).length > 0) return 'cavity radiation';
  if (Object.keys(thermal.contacts).length > 0) return 'thermal contact conductance';
  for (const id of thermal.bcOrder) {
    const record = thermal.bcs[id];
    if (record?.amplitude !== undefined) return 'amplitudes (a coupled step is steady state)';
    if (record?.bc.kind === 'film' && !('value' in record.bc.filmCoefficient)) return 'film coefficient tables';
  }
  return null;
}

/**
 * Physical constants (radiation), initial temperature (T_ref on every node), the coupled steady step with the mechanical lines of 05 then
 * the thermal BCs, and the outputs `U, NT` (nodes) and `S, HFL` (elements).
 * @invariant the mechanical `*BOUNDARY, OP=NEW` precedes the thermal `*BOUNDARY` (DOF 11) lines, so the thermal ones are not cleared
 * @failure not coupled -> THM_CASE_TYPE; a set-up error of the thermal part (check_thermal items of severity error, e.g. THM_NO_HEAT_PATH) ->
 *   its code; cavities, contacts, amplitudes, h(T) tables -> TMC_COUPLED_UNSUPPORTED; thermal BC without nodes / faces -> FEA_TARGET_UNRESOLVED;
 *   the mechanical refusals of 05
 */
export function coupledSections(ctx: DeckContext): DeckSections {
  const setup = coupledOf(ctx.analysis);
  if (setup === undefined) return notCoupled(ctx);
  const { thermal } = setup;
  const blocking = checkThermalItems(ctx.doc, ctx.analysisId).find((entry) => entry.severity === 'error');
  if (blocking !== undefined) return refused(blocking.code, blocking.message, blocking.ids);
  const missing = unsupported(setup);
  if (missing !== null)
    return refused(
      'TMC_COUPLED_UNSUPPORTED',
      `the coupled step does not write ${missing} (steady conduction, convection, radiation and flux BCs only)`,
      [ctx.analysisId],
    );
  const reference = temperatureIn(setup.referenceTemperature, setup.temperatureScale);
  if (reference === null) return refused('THM_UNITS_MISMATCH', 'the reference temperature has an invalid unit', [ctx.analysisId]);
  const mechanical = mechanicalStepLines(ctx);
  if (!('text' in mechanical)) return mechanical;
  const volumes = partVolumes(indexMesh(ctx.mesh));
  const thermalLines: string[] = [];
  for (const id of thermal.bcOrder) {
    const record = thermal.bcs[id];
    if (record === undefined) continue;
    const block = bcLines(ctx, thermal, record, volumes);
    if ('code' in block) return block;
    thermalLines.push(...block.lines);
  }
  const lines = [
    `** coupled temperature-displacement analysis ${commentText(ctx.analysisId)}: steady state, T_ref ${num(reference)} ${setup.temperatureScale}`,
    ...(hasRadiation(thermal)
      ? [
          `*PHYSICAL CONSTANTS, ABSOLUTE ZERO=${num(absoluteZeroOf(setup.temperatureScale))}, STEFAN BOLTZMANN=${num(siToSystem('stefanBoltzmann', stefanBoltzmannOf(thermal), ctx.unitSystem))}`,
        ]
      : []),
    '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
    ...ctx.mesh.nodes.map(([id]) => row(id, reference)),
    '*STEP, INC=200',
    '*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE',
    row(1, 1),
  ];
  const outputs = ['*NODE FILE', 'U, NT', '*EL FILE', 'S, HFL', '*END STEP'];
  return { text: `${linesText(lines)}${mechanical.text.replace(/\n*$/, '\n')}${linesText([...thermalLines, ...outputs])}` };
}
