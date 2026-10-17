import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { toRadians } from '@lib/angle';
import { FORMULAS, bendQuantities, dinToAnsiK, faaBendQuantities } from '@lib/sheetMath';
import type { FtrUnverifiedInput } from '@core/model/manufacturing';
import { findRadiusRow } from '../rules';
import { getModel } from '../graph';
import { REVIEW_NOTE, fixed, refuse, resultMeta, unverifiedNote } from '../result';

/**
 * @affects none; data = SheetMetalCalcData { mode, kFactor?, ba, ossb, issb, bd, kChart, rOverT, minRadius?, lengthUnit, angleUnit, unverified, unverifiedInputs, reviewRequired, provenance }
 * @invariant K never defaulted; every value carries its formula id in provenance.formulas
 * @failure K missing in k_factor mode (FTR_K_FACTOR_MISSING), K out of range, angle outside (0, 180) degrees, non-positive thickness -> rejected with error.code
 */
export const sheetMetalCalc = defineCommand({
  name: 'sheet_metal_calc',
  description:
    'Compute sheet-metal bend quantities for one bend with no part needed: bend allowance BA = theta*(R+K*T), outside setback OSSB = tan(theta/2)*(R+T), ' +
    'inside setback, bend deduction BD = 2*OSSB-BA (flat length = sum of mold-line legs - BD) and the AC 43.13-1B K-chart value tan(theta/2). ' +
    "All lengths are in `units` ('mm' or 'in', required). The angle is the angle bent THROUGH in degrees (a closed 45-degree angle is a 135-degree bend). " +
    'Mode k_factor needs kFactor (never defaulted; refusal FTR_K_FACTOR_MISSING); mode faa_empirical uses BA = (0.01743*R+0.0078*T)*theta_deg. ' +
    'Other refusals: FTR_K_FACTOR_OUT_OF_RANGE, FTR_BEND_ANGLE_OUT_OF_RANGE (0 < angle < 180), FTR_PARAM_INVALID. ' +
    'Give material and temper to also return the minimum inside radius of a matching imported radius-table row (import_bend_radius_table). ' +
    'The result carries provenance (formulas, inputs, sources), unverified flags and reviewRequired. Next: create_sheet_metal_rule, then add_sheet_metal_base.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    units: z.enum(['mm', 'in']).describe("Unit of thickness, insideRadius and of every returned length: 'mm' or 'in'. Required."),
    thickness: z.number().describe('Sheet thickness T in `units`; must be > 0.'),
    insideRadius: z.number().describe('Inside bend radius R in `units`; >= 0.'),
    angle: z
      .number()
      .describe(
        'Bend angle in degrees: the angle bent THROUGH (0 = flat, 90 = right angle, closed 45-degree angle = 135). Must satisfy 0 < angle < 180.',
      ),
    kFactor: z
      .number()
      .optional()
      .describe(
        'K-factor (dimensionless, neutral-axis offset / T). Required in mode k_factor and never defaulted. ANSI 0 < K <= 0.5; DIN 0 < K <= 1 (DIN K = 2 x ANSI K).',
      ),
    kStandard: z
      .enum(['ansi', 'din'])
      .optional()
      .describe(
        "Convention of kFactor (dimensionless K): 'ansi' (default, reported as defaulted) or 'din' (converted to ANSI by halving).",
      ),
    mode: z
      .enum(['k_factor', 'faa_empirical'])
      .optional()
      .describe(
        "'k_factor' (default) uses BA = theta*(R+K*T); 'faa_empirical' uses the FAA/EAA formula BA = (0.01743*R+0.0078*T)*theta_deg and ignores kFactor.",
      ),
    material: z
      .string()
      .optional()
      .describe('Material label (e.g. 2024) used with temper to look up the minimum radius row; text, no unit.'),
    temper: z.string().optional().describe('Temper label (e.g. T3) used with material to look up the minimum radius row; text, no unit.'),
  }),
  run: (doc, params): CommandResult => {
    const { units, thickness, insideRadius, angle, kFactor, material, temper } = params;
    const mode = params.mode ?? 'k_factor';
    const kStandard = params.kStandard ?? 'ansi';
    if (!(thickness > 0) || !(insideRadius >= 0))
      return refuse(
        doc,
        'sheet_metal_calc',
        'FTR_PARAM_INVALID',
        `thickness must be > 0 and insideRadius >= 0 (got ${thickness}, ${insideRadius})`,
        'Give positive lengths in `units`.',
        { paths: [!(thickness > 0) ? 'thickness' : 'insideRadius'] },
      );
    if (!(angle > 0 && angle < 180))
      return refuse(
        doc,
        'sheet_metal_calc',
        'FTR_BEND_ANGLE_OUT_OF_RANGE',
        `angle ${angle} degrees is outside (0, 180)`,
        'Bend angle is the angle bent through, 0 < angle < 180 degrees (hems at 180 are not supported).',
        { paths: ['angle'] },
      );
    if (mode === 'k_factor' && kFactor === undefined)
      return refuse(
        doc,
        'sheet_metal_calc',
        'FTR_K_FACTOR_MISSING',
        'mode k_factor needs kFactor',
        'Give kFactor (ANSI 0-0.5) or use mode=faa_empirical.',
        { paths: ['kFactor'] },
      );
    const limit = kStandard === 'din' ? 1 : 0.5;
    if (mode === 'k_factor' && kFactor !== undefined && !(kFactor > 0 && kFactor <= limit))
      return refuse(
        doc,
        'sheet_metal_calc',
        'FTR_K_FACTOR_OUT_OF_RANGE',
        `${kStandard.toUpperCase()} kFactor ${kFactor} is outside (0, ${limit}]`,
        'ANSI K is neutral-axis offset / T, 0 < K <= 0.5 (DIN = 2 x ANSI).',
        { paths: ['kFactor'] },
      );

    const theta = toRadians(angle);
    const ansiK = mode === 'k_factor' && kFactor !== undefined ? (kStandard === 'din' ? dinToAnsiK(kFactor).value : kFactor) : undefined;
    const q =
      mode === 'faa_empirical'
        ? faaBendQuantities({ theta, insideRadius, thickness })
        : bendQuantities({ theta, insideRadius, thickness, k: ansiK as number });
    const row = findRadiusRow(getModel(doc).radiusTable, { material: material ?? '', temper, thickness, unit: units, angleDeg: angle });
    const matched = material !== undefined ? row : undefined;
    const unverifiedInputs: FtrUnverifiedInput[] =
      matched !== undefined && matched.row.verification === 'unverified'
        ? [{ kind: 'radius_row', id: matched.id, source: matched.row.source }]
        : [];
    const meta = resultMeta({
      lengthUnit: units,
      unverifiedInputs,
      formulas: {
        ba: q.ba.formula,
        ossb: q.ossb.formula,
        issb: q.issb.formula,
        bd: q.bd.formula,
        kChart: q.kChart.formula,
        rOverT: q.rOverT.formula,
        ...(kStandard === 'din' && mode === 'k_factor' ? { kFactor: FORMULAS.kDinToAnsi } : {}),
      },
      inputs: {
        thickness: { value: thickness, unit: units, source: 'param thickness' },
        insideRadius: { value: insideRadius, unit: units, source: 'param insideRadius' },
        angle: { value: angle, unit: 'deg', source: 'param angle' },
        ...(kFactor !== undefined && mode === 'k_factor' ? { kFactor: { value: kFactor, source: `param kFactor (${kStandard})` } } : {}),
        kStandard: {
          value: kStandard,
          source: params.kStandard === undefined ? 'default' : 'param kStandard',
          defaulted: params.kStandard === undefined,
        },
      },
      sources: mode === 'faa_empirical' ? ['R2', 'R3'] : ['R2', 'R7', 'R14'],
    });
    const data = {
      mode,
      ...(ansiK !== undefined
        ? {
            kFactor: {
              value: ansiK,
              standard: 'ansi' as const,
              source: `param kFactor (${kStandard})`,
              defaulted: false,
              verification: 'verified' as const,
            },
          }
        : {}),
      ba: q.ba.value,
      ossb: q.ossb.value,
      issb: q.issb.value,
      bd: q.bd.value,
      kChart: q.kChart.value,
      rOverT: q.rOverT.value,
      ...(matched !== undefined
        ? {
            minRadius: {
              value: matched.minInsideRadius,
              source: matched.row.source,
              defaulted: false,
              verification: matched.row.verification,
              rowId: matched.id,
            },
          }
        : {}),
      ...meta,
    };
    const radiusNote =
      matched !== undefined
        ? ` Minimum inside radius ${fixed(matched.minInsideRadius)} ${units} (row ${matched.id}).`
        : material !== undefined
          ? ' No radius-table row matches material/temper/thickness.'
          : '';
    return report(
      doc,
      `sheet_metal_calc (${mode}, ${units}): BA ${fixed(q.ba.value)}, OSSB ${fixed(q.ossb.value)}, ISSB ${fixed(q.issb.value)}, BD ${fixed(q.bd.value)}, K-chart ${fixed(q.kChart.value)}, R/T ${fixed(q.rOverT.value)}.${radiusNote}${unverifiedNote(meta)} ${REVIEW_NOTE}`,
      data,
    );
  },
});
