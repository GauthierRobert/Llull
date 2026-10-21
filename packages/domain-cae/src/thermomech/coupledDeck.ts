/**
 * coupled_temperature_displacement deck sections (PHY-04 TR-TMC-22): conductivity (and, for a transient, specific heat) and secant expansion per
 * material, the initial temperature (= T_ref), one `*COUPLED TEMPERATURE-DISPLACEMENT` step (`STEADY STATE`, or a time period with increments for a
 * transient, M4b) with the 05 mechanical lines and the PHY-03 thermal BCs, outputs `U, NT` and `S, HFL`.
 */

import type { ThermoMechSetup } from '@core/model/analysis';
import { siToSystem } from '../thermal/thermalUnits';
import type { DeckContext, DeckSections } from '../decks/context';
import { commentText, linesText, num, row } from '../decks/format';
import { mechanicalStepLines } from '../decks/mechanical';
import { temperatureConflictRefusal } from '../thermal/bcConflicts';
import { checkThermalItems } from '../thermal/check';
import { stefanBoltzmannOf, hasRadiation } from '../thermal/constants';
import { isTransientCase } from '../thermal/access';
import { amplitudeLines } from '../thermal/deckAmplitude';
import { allBcLines } from '../thermal/deckLoads';
import { planStep } from '../thermal/deckStep';
import { propertyCards } from '../thermal/deckMaterial';
import { indexMesh, partVolumes } from '../thermal/meshGeometry';
import { caseTemperatureRange } from '../thermal/material';
import { absoluteZeroOf } from '../thermal/quantities';
import { expansionCards, refused } from './deck';
import { PREHEAT_PERIOD_S, startOf } from './preheat';
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

/** Features of the thermal set-up the coupled step does not write (cavities, contacts, steady amplitudes, h(T) tables): their name, else null. */
function unsupported(setup: NonNullable<ReturnType<typeof coupledOf>>, transient: boolean): string | null {
  const { thermal } = setup;
  if (Object.keys(thermal.cavities).length > 0) return 'cavity radiation';
  if (Object.keys(thermal.contacts).length > 0) return 'thermal contact conductance';
  for (const id of thermal.bcOrder) {
    const record = thermal.bcs[id];
    if (record?.amplitude !== undefined && !transient)
      return 'amplitudes (a steady-state coupled step has no time: set_thermal_step endTimeS makes it transient)';
    if (record?.bc.kind === 'film' && !('value' in record.bc.filmCoefficient)) return 'film coefficient tables';
  }
  return null;
}

/**
 * Physical constants (radiation), amplitudes, initial temperature (T_ref on every node), the coupled step (steady state, or transient with
 * its time period, increments, DELTMX and result times) with the mechanical lines of 05 then the thermal BCs, and the outputs `U, NT` (nodes)
 * and `S, HFL` (elements). A transient whose initial temperature differs from T_ref first runs a `*STATIC` pre-heating step that brings every
 * node from T_ref to it (CalculiX treats the initial temperature as stress-free, so the thermal strain of T_ref -> T0 is made there).
 * @invariant the mechanical `*BOUNDARY, OP=NEW` precedes the thermal `*BOUNDARY` (DOF 11) lines, so the thermal ones are not cleared
 * @failure not coupled -> THM_CASE_TYPE; a set-up error of the thermal part (check_thermal items of severity error, e.g. THM_NO_HEAT_PATH) ->
 *   its code; cavities, contacts, steady-state amplitudes, h(T) tables -> TMC_COUPLED_UNSUPPORTED; more than 20000 result times -> THM_STEP_INVALID;
 *   thermal BC without nodes / faces -> FEA_TARGET_UNRESOLVED; the mechanical refusals of 05
 */
export function coupledSections(ctx: DeckContext): DeckSections {
  const setup = coupledOf(ctx.analysis);
  if (setup === undefined) return notCoupled(ctx);
  const { thermal } = setup;
  const blocking = checkThermalItems(ctx.doc, ctx.analysisId).find((entry) => entry.severity === 'error');
  if (blocking !== undefined) return refused(blocking.code, blocking.message, blocking.ids);
  const conflict = temperatureConflictRefusal(thermal, ctx.mesh);
  if (conflict !== null) return conflict;
  const transient = isTransientCase(ctx.analysis);
  const missing = unsupported(setup, transient);
  if (missing !== null)
    return refused(
      'TMC_COUPLED_UNSUPPORTED',
      `the coupled step does not write ${missing} (conduction, convection, radiation and flux BCs only)`,
      [ctx.analysisId],
    );
  const reference = temperatureIn(setup.referenceTemperature, setup.temperatureScale);
  if (reference === null) return refused('THM_UNITS_MISMATCH', 'the reference temperature has an invalid unit', [ctx.analysisId]);
  const plan = planStep(thermal, !transient, 'COUPLED TEMPERATURE-DISPLACEMENT');
  if (plan === null) return refused('THM_STEP_INVALID', 'more than 20000 result times: raise outputEveryS', [ctx.analysisId]);
  const mechanical = mechanicalStepLines(ctx);
  if (!('text' in mechanical)) return mechanical;
  const mechanicalText = mechanical.text.replace(/\n*$/, '\n');
  const volumes = partVolumes(indexMesh(ctx.mesh));
  const bcBlocks = allBcLines(ctx, thermal, volumes);
  if ('code' in bcBlocks) return bcBlocks;
  const start = startOf(setup, reference, transient);
  const scale = setup.temperatureScale;
  const what = transient
    ? `transient to ${num(thermal.step.endTimeS ?? 0)} s, T_ref ${num(reference)} ${scale}, start ${num(start.value)} ${scale}`
    : `steady state, T_ref ${num(reference)} ${scale}`;
  const lines = [
    `** coupled temperature-displacement analysis ${commentText(ctx.analysisId)}: ${what}`,
    ...(hasRadiation(thermal)
      ? [
          `*PHYSICAL CONSTANTS, ABSOLUTE ZERO=${num(absoluteZeroOf(scale))}, STEFAN BOLTZMANN=${num(siToSystem('stefanBoltzmann', stefanBoltzmannOf(thermal), ctx.unitSystem))}`,
        ]
      : []),
    ...plan.timePoints,
    ...amplitudeLines(thermal),
    '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
    ...ctx.mesh.nodes.map(([id]) => row(id, reference)),
  ];
  if (start.preheat)
    lines.push(
      `** pre-heating: every node from T_ref ${num(reference)} to the start temperature ${num(start.value)} ${scale} (stress-free at T_ref)`,
      '*STEP',
      '*STATIC',
      row(PREHEAT_PERIOD_S, PREHEAT_PERIOD_S),
      ...mechanicalText.split('\n').filter((line) => line !== ''),
      '*TEMPERATURE',
      ...ctx.mesh.nodes.map(([id]) => row(id, start.value)),
      // ccx 2.21 stops a later nonlinear (coupled) step unless energy output is requested in the FIRST step ("energy output requests, if any, must be
      // specified in the first step"); the step temperatures carry over as the start of the coupled step, and a *TEMPERATURE card in the coupled step
      // is refused ("no thermal *INITIAL CONDITIONS"), so none is written there (measured, server/tests/feaThermomechTransient.test.ts).
      '*EL FILE',
      'ENER',
      '*END STEP',
    );
  const output = plan.output === '' ? '' : `, ${plan.output}`;
  const stepLines = [...plan.notes, ...plan.stepLines];
  const outputs = [`*NODE FILE${output}`, 'U, NT', `*EL FILE${output}`, 'S, HFL', '*END STEP'];
  return { text: `${linesText([...lines, ...stepLines])}${mechanicalText}${linesText([...bcBlocks.lines, ...outputs])}` };
}
