import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT } from '@core/model/units';
import { getBuilding } from '../../../building/model';
import { exchangerReinforcement } from '../codecheck/exchangerReinforcement';
import { vesselReinforcement, type NozzleReinforcement } from '../codecheck/reinforcement';
import { pressureToMpa, stressToMpa } from '../codecheck/units';
import { refuse } from '../model';
import { REVIEW_REASON } from './vesselThickness';
import { equipmentRefParam, findEquipment } from './equipmentRef';
import { pressureSchema } from './vesselParams';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant UG-37 area replacement per nozzle: A = d t_r F + 2 t_n t_r F (1 - f_r1) against A1 + A2 (no pad, no weld metal, no inward projection: the
 *   available area is conservative); corroded dimensions; E1 = 1; S and the pressure are never defaulted; small openings are exempt (UG-36(c)(3));
 *   reviewRequired is always true
 * @failure unknown equipment / nozzle mark -> EQP_NOZZLE_NOT_FOUND / EQP_NOT_FOUND; not a vessel -> EQP_NOT_PARAMETRIC; no P / S -> EQP_DESIGN_DATA_MISSING /
 *   EQP_ALLOWABLE_MISSING; a nozzle outside the covered cases is refused as a whole only when it is the one asked for, else listed under `notCovered`
 */
export const nozzleReinforcement = defineCommand({
  name: 'nozzle_reinforcement',
  description:
    'Query: ASME VIII-1 UG-37 opening reinforcement (area replacement) of the shell and head nozzles of a parametric vessel, or of the shell and channel nozzles of a heat exchanger (tag or id; an exchanger shell nozzle uses design.shellSide and the shell wall, a channel nozzle design.tubeSide and the channel wall, each as a cylinder; storage tanks are NOT covered: API 650 5.7 rules). Per nozzle: ' +
    'required area A = d t_r F + 2 t_n t_r F (1 - f_r1) (d = finished opening diameter, corroded; t_r = required thickness of a seamless shell, or of a ' +
    'seamless sphere of radius K1 D = 0.9 D for a 2:1 head, the radius of a hemispherical head or the crown radius of a torispherical head), available area ' +
    'A1 (excess vessel wall) + A2 (excess neck wall), margin, and status fail | pass_with_review | exempt (UG-36(c)(3): d <= 89 mm for a wall of 9.525 mm or less, ' +
    '60 mm above; boundary 9.525 mm = 3/8 in nominal wall). The nozzle is taken as set-in (inserted through the wall); an abutting nozzle is not modelled. No pad and no weld metal is modelled (A41 = A5 = 0), so a fail means "add a pad or thicken, reviewed by an engineer". The neck comes from ' +
    'the nozzle record (OD and wall); neck and vessel are taken as the same material unless nozzleAllowableStress is given. Uses design.pressure ' +
    '(or `pressure`), design.allowableStress; never defaulted. mark restricts to one nozzle. Returns nozzles[{ mark, on, clause, requiredAreaMm2, a1Mm2, ' +
    'a2Mm2, availableAreaMm2, marginMm2, requiredShellThicknessMm, requiredNeckThicknessMm, exempt, status, inputs, notChecked }], notCovered[{ mark, code, ' +
    'message, paths }] (free nozzles, openings outside the central 80 % of a head, head types without a rule), status, reviewRequired (always true). ' +
    'Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC (tank, pump, block), EQP_NOZZLE_NOT_FOUND, EQP_DESIGN_DATA_MISSING, EQP_ALLOWABLE_MISSING, EQP_HEAD_INVALID. Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    equipment: equipmentRefParam,
    mark: z
      .string()
      .min(1)
      .optional()
      .describe('Nozzle mark to check (e.g. "N1"). Default: every shell and head nozzle (exchanger: shell and channel nozzles).'),
    pressure: pressureSchema.optional().describe('Internal design pressure, gauge, replacing design.pressure for this call (what-if).'),
    nozzleAllowableStress: z
      .object({
        value: z.number().positive().describe('Allowable stress of the neck material at the design temperature.'),
        unit: z.enum(['MPa', 'psi']).describe('Stress unit.'),
      })
      .optional()
      .describe(
        'Allowable stress S_n of the nozzle neck when it differs from the vessel (f_r = min(1, S_n / S_v)). Default: the vessel S.',
      ),
  }),
  run: (doc, { equipment, mark, pressure, nozzleAllowableStress }): CommandResult => {
    const element = findEquipment(getBuilding(doc), equipment);
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuse(doc, 'nozzle_reinforcement', code, `nozzle_reinforcement: ${message}`, element === undefined ? [] : [element.id], [path]);
    if (element === undefined) return fail('EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, 'equipment');
    const kind = element.plant?.template.kind;
    if (element.plant === undefined || (kind !== 'vessel' && kind !== 'exchanger'))
      return fail(
        'EQP_NOT_PARAMETRIC',
        kind === 'tank'
          ? `${element.mark} is a tank: API 650 5.7 opening rules, not UG-37, apply to its shell nozzles and are not covered`
          : `${element.mark} (${element.id}) is not a parametric vessel or exchanger`,
        'equipment',
      );
    if (mark !== undefined && !element.plant.nozzles.some((nozzle) => nozzle.mark === mark))
      return fail('EQP_NOZZLE_NOT_FOUND', `${element.mark} has no nozzle '${mark}'`, 'mark');
    const plant =
      mark === undefined ? element.plant : { ...element.plant, nozzles: element.plant.nozzles.filter((nozzle) => nozzle.mark === mark) };
    const options = {
      mmPerUnit: MM_PER_UNIT[doc.units],
      pressureMPa: pressure === undefined ? undefined : pressureToMpa(pressure.value, pressure.unit),
      nozzleStressMPa:
        nozzleAllowableStress === undefined ? undefined : stressToMpa(nozzleAllowableStress.value, nozzleAllowableStress.unit),
    };
    const result:
      | { nozzles: readonly NozzleReinforcement[]; basis: object }
      | { refusal: { code: string; message: string; paths: readonly string[] } } =
      plant.template.kind === 'exchanger'
        ? (({ nozzles, sides }) => ({ nozzles, basis: { sides } }))(exchangerReinforcement(plant.template, plant.nozzles, options))
        : (() => {
            const vessel = vesselReinforcement(plant, options);
            return 'refusal' in vessel
              ? vessel
              : { nozzles: vessel.nozzles, basis: { designPressureMPa: vessel.pressureMPa, allowableStressMPa: vessel.stressMPa } };
          })();
    if ('refusal' in result) return fail(result.refusal.code, result.refusal.message, result.refusal.paths[0] ?? 'equipment');
    const computed = result.nozzles.flatMap((nozzle) => ('result' in nozzle ? [nozzle.result] : []));
    const notCovered = result.nozzles.flatMap((nozzle) => ('refusal' in nozzle ? [{ mark: nozzle.mark, ...nozzle.refusal }] : []));
    if (mark !== undefined && notCovered[0] !== undefined)
      return fail(notCovered[0].code, notCovered[0].message, notCovered[0].paths[0] ?? 'mark');
    const failed = computed.filter((nozzle) => nozzle.status === 'fail').map((nozzle) => nozzle.mark);
    const status = failed.length > 0 ? 'fail' : 'pass_with_review';
    const data = {
      equipment: element.mark,
      elementId: element.id,
      ...result.basis,
      nozzles: computed,
      notCovered,
      failed,
      status,
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
      provenance: {
        formulas: 'ASME BPVC VIII-1 UG-36, UG-37 as printed in public sources (validation/sources.md); the Code is paywalled',
        units: 'mm, MPa, mm2',
      },
    };
    return report(
      doc,
      `nozzle_reinforcement: ${element.mark} ${computed.length} nozzle(s) checked, ${failed.length} fail${failed.length > 0 ? ` (${failed.join(', ')})` : ''}, ${notCovered.length} not covered; review required.`,
      data,
    );
  },
});
