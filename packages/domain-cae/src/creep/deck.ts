/** PHY-11 §5.3 deck sections of a `creep` case: temperature, time points, an optional elastic preload step and the `*VISCO` hold. */

import { isDeckRefusal, type DeckContext, type DeckRefusal, type DeckSections } from '../decks/context';
import { linesText, num, row } from '../decks/format';
import { mechanicalStepLines } from '../decks/mechanical';
import { partIssues } from './readiness';
import { outputTimesS } from './times';

const refuse = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

const TIME_POINTS = 'TP_HOLD';

/** CalculiX default minimum increment of `*VISCO` (1e-5 x the period, never above the initial increment): written when only the maximum is given, so the card never forces another minimum. */
const MIN_INCREMENT_FRACTION = 1e-5;

/** Refusal when the case cannot be written: no hold, a part without a usable law (all parts without one: CRP_NO_VISCOUS_MATERIAL). */
function problem(ctx: DeckContext): DeckRefusal | null {
  const id = ctx.analysisId;
  const { creep } = ctx.analysis;
  if (creep === undefined) return refuse('CRP_STEP_MISSING', `analysis '${id}' has no creep step: call set_creep_step`, [id]);
  const errors = partIssues(ctx.doc, ctx.analysis, creep.temperature.valueK).filter((issue) => issue.severity === 'error');
  if (errors.length === 0) return null;
  const first = errors[0];
  if (first === undefined) return null;
  if (errors.length === Object.keys(ctx.analysis.parts).length && errors.every((issue) => issue.code === 'CRP_LAW_MISSING'))
    return refuse('CRP_NO_VISCOUS_MATERIAL', `no part of '${id}' has a creep law: ${first.message}`, [id]);
  return refuse(first.code, first.message, first.ids);
}

/**
 * The creep procedure. Materials (`*ELASTIC` + `*CREEP, LAW=NORTON`) are written by the shared constitutive writer; this adds `*INITIAL CONDITIONS` at
 * the hold temperature, the `*TIME POINTS` of the outputs, an elastic `*STATIC` preload step of `preloadPeriodS` (creep is off in `*STATIC`) when
 * `preloadStep`, and the `*VISCO, CETOL=` hold step (`INC=maxIncrements`, increments initial, duration, min, max) with the loads restated (step loads),
 * `*NODE FILE U` and `*EL FILE S, CEEQ` at the time points. The hold is CalculiX step 2 (1 without a preload step); its total time starts at `preloadPeriodS`.
 * @invariant a case without `creep` is never written; pure and byte-deterministic; every load case acts
 * @failure CRP_STEP_MISSING, CRP_NO_VISCOUS_MATERIAL, CRP_LAW_MISSING, CRP_LAW_FORM_UNSUPPORTED, CRP_ORTHOTROPIC_V2, CRP_LAW_OUT_OF_RANGE; mechanical refusals
 */
export function creepSteps(ctx: DeckContext): DeckSections {
  const blocked = problem(ctx);
  if (blocked !== null) return blocked;
  const creep = ctx.analysis.creep;
  if (creep === undefined) return refuse('CRP_STEP_MISSING', `analysis '${ctx.analysisId}' has no creep step`, [ctx.analysisId]);
  const mechanical = mechanicalStepLines(ctx);
  if (isDeckRefusal(mechanical)) return mechanical;
  const loads = mechanical.text.split('\n').filter((line) => line !== '');
  const temperature = row('NALL', creep.temperature.valueK);
  const times = outputTimesS(creep);
  const nlgeom = creep.nlgeom ? ', NLGEOM' : '';
  const lines = [
    '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
    temperature,
    `*TIME POINTS, NAME=${TIME_POINTS}`,
    ...Array.from({ length: Math.ceil(times.length / 8) }, (_, index) =>
      times
        .slice(index * 8, index * 8 + 8)
        .map(num)
        .join(', '),
    ),
  ];
  if (creep.preloadStep)
    lines.push(
      '** step 1: elastic preload (creep is off in *STATIC)',
      `*STEP${nlgeom}`,
      '*STATIC',
      row(creep.preloadPeriodS, creep.preloadPeriodS),
      ...loads,
      '*TEMPERATURE',
      temperature,
      '*END STEP',
    );
  const control = [
    creep.initialIncrementS,
    creep.durationS,
    ...(creep.minIncrementS !== undefined || creep.maxIncrementS !== undefined
      ? [
          creep.minIncrementS ?? Math.min(MIN_INCREMENT_FRACTION * creep.durationS, creep.initialIncrementS),
          creep.maxIncrementS ?? creep.durationS,
        ]
      : []),
  ];
  lines.push(
    `** ${creep.preloadStep ? 'step 2: ' : ''}creep hold of ${num(creep.durationS)} s`,
    `*STEP${nlgeom}, INC=${creep.maxIncrements}`,
    `*VISCO, CETOL=${num(creep.cetol)}`,
    row(...control),
    ...loads,
    '*TEMPERATURE',
    temperature,
    `*NODE FILE, TIME POINTS=${TIME_POINTS}`,
    'U',
    `*EL FILE, TIME POINTS=${TIME_POINTS}`,
    'S, CEEQ',
    '*END STEP',
  );
  return { text: linesText(lines) };
}
