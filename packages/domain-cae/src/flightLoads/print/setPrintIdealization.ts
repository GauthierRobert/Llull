/** set_print_idealization: a printed part (walls + infill + build direction) analysed as a homogenised orthotropic solid (14 FLL-M3). */

import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import type { AnalysisCase } from '@core/model/analysis';
import { PRINT_PATTERNS, type PrintExponent, type PrintIdealization } from '@core/model/printIdealization';
import type { Vec3 } from '@core/model/vectors';
import { analysisOf, caseOf, withCase } from '../../shared/access';
import { analysisIdSchema, quantitySchema } from '../../shared/schemas';
import { refuseFll } from '../codes';
import { cleanSource, fitCoupons, sourceSchema, toMpa } from './couponCommands';
import { isPrintedRefusal, printedProperties } from './properties';
import { PRINT_CASE_TYPES } from './validate';

const NAME = 'set_print_idealization';
/** Relative gap between the fitted solid modulus C and the solid coupon modulus above which the result carries a warning. */
const SOLID_MISMATCH = 0.1;

/**
 * @affects doc.analysis.cases[analysisId].printed[entityId] (set, replaced or removed; part of the full input hash: results become stale; affected: [analysisId])
 * @invariant the inputs are stored, the orthotropic constants are derived from them and the part geometry at deck time (skin fraction from the triangles, Poisson ratio and density from the part material); infill density 1 recovers the solid coupon moduli, the E_z / E_xy ratio of the coupons is kept
 *   at every infill density; no coupon values and no exponent are ever defaulted; strengths are reported, never homogenised
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not static / modal / buckling -> FLL_PRINT_CASE_TYPE; not a solid part of the case -> FEA_PART_NOT_IN_ANALYSIS; invalid settings -> FLL_PRINT_PARAM;
 *   no coupon -> FLL_PRINT_COUPON_MISSING; no exponent -> FLL_PRINT_EXPONENT_MISSING; fit without 2 coupons -> FLL_PRINT_FIT_POINTS; open geometry -> FLL_PRINT_GEOMETRY; no material -> FEA_MATERIAL_MISSING;
 *   unstable constants -> FLL_PRINT_STIFFNESS (rejections, unchanged document)
 */
export const setPrintIdealization = defineCommand({
  name: NAME,
  annotations: { readsMeshTriangles: true },
  description:
    'Analyse a printed (FDM) solid part of a static, modal or buckling analysis as a homogenised orthotropic solid instead of a solid isotropic material (14 FLL). Inputs: walls and lineWidthMm, ' +
    'layerHeightMm and topBottomLayers (skin thickness: walls x lineWidth laterally, topBottomLayers x layerHeight along the build direction), infill { pattern, density (volume fraction)}, ' +
    'layerAxis (build direction in the document frame), the SOLID coupon values coupon { E_xy, E_z, uts_xy, uts_z, source } (moduli and strengths as { value, unit }, measured on 100 % infill ' +
    'coupons pulled in the build plane and along the build direction; required, there are no typical values) and the infill exponent m of E_core = E_solid x density^m: infillExponent { value, source } ' +
    'or { fitDirection: "xy" | "z" } to fit it from the coupons recorded with record_print_coupon for that infill pattern (fit_print_infill_exponent previews it); no default exponent exists. ' +
    'The skin fraction f is measured on the part triangles (first order); direction modulus = coupon modulus x (f + (1 - f) density^m), directions 1 and 2 in the build plane, 3 along layerAxis; ' +
    'Poisson ratios (nu12 = nu13 = nu23) and density come from the material of the part (density x (f + (1 - f) density)); shear is not measured: G12 = E_xy / (2 (1 + nu)), G13 = G23 = E_z / (2 (1 + nu)) (flagged). Skin and core are mixed in parallel, which over-estimates E_z (series along the build direction is softer). The deck writes ' +
    '*ELASTIC, TYPE=ENGINEERING CONSTANTS and *ORIENTATION (layerAxis is the material direction 3). Strengths are reported unhomogenised. clear: true removes the idealization. ' +
    'Returns data { skinFraction, volume, effective { E_xy, E_z, nu, G_xy, G_z (MPa), densityRatio, coreFactor }, exponent, ratio E_z / E_xy, strengths, unverified, unverifiedReasons, warnings }.',
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of a static, modal or buckling analysis.'),
    entityId: z.string().describe('Id of a solid part of the analysis (set_part_idealization, solid idealization).'),
    clear: z.boolean().optional().describe('true: remove the printed idealization of this part (every other parameter is then ignored).'),
    walls: z.number().int().min(0).max(100).optional().describe('Number of perimeter walls (integer >= 0).'),
    lineWidthMm: z.number().positive().optional().describe('Extrusion line width, mm.'),
    layerHeightMm: z.number().positive().optional().describe('Layer height, mm.'),
    topBottomLayers: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe('Solid layers at the top and the bottom (along layerAxis), integer >= 0.'),
    infill: z
      .object({
        pattern: z.enum(PRINT_PATTERNS).describe('gyroid | grid | lightning | honeycomb.'),
        density: z.number().gt(0).max(1).describe('Infill volume fraction in (0, 1]; 1 = solid.'),
      })
      .optional()
      .describe('Infill of the core.'),
    layerAxis: z
      .tuple([z.number(), z.number(), z.number()])
      .optional()
      .describe('Build direction [x, y, z] in the document frame (any non-zero length); layers are perpendicular to it.'),
    coupon: z
      .object({
        E_xy: quantitySchema.describe('Solid-coupon modulus in the build plane, e.g. { value: 2000, unit: "MPa" }.'),
        E_z: quantitySchema.describe('Solid-coupon modulus along the build direction.'),
        uts_xy: quantitySchema.describe('Solid-coupon ultimate strength in the build plane.'),
        uts_z: quantitySchema.describe('Solid-coupon ultimate strength along the build direction.'),
        source: sourceSchema.describe('Where the coupon values come from (required).'),
      })
      .optional()
      .describe('Measured values of SOLID printed coupons (required unless clear).'),
    infillExponent: z
      .object({
        value: z.number().positive().optional().describe('The exponent m (> 0) of E_core = E_solid density^m, with source.'),
        source: sourceSchema.optional().describe('Where m comes from (required with value).'),
        fitDirection: z
          .enum(['xy', 'z'])
          .optional()
          .describe('Instead of value: fit m from the recorded coupons of the infill pattern in this direction.'),
      })
      .optional()
      .describe('The infill exponent: { value, source } or { fitDirection }. No default.'),
  }),
  run: (doc, params): CommandResult => {
    const { analysisId, entityId } = params;
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseFll(doc, NAME, code, message, [analysisId, entityId], paths);
    const found = caseOf(doc, analysisId);
    if (found === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, ['analysisId']);
    if (!PRINT_CASE_TYPES.includes(found.type))
      return fail('FLL_PRINT_CASE_TYPE', `analysis '${analysisId}' is ${found.type}`, ['analysisId']);
    if (found.parts[entityId]?.kind !== 'solid')
      return fail('FEA_PART_NOT_IN_ANALYSIS', `'${entityId}' is not a solid part of '${analysisId}'`, ['entityId']);
    const rest = Object.fromEntries(Object.entries(found.printed ?? {}).filter(([id]) => id !== entityId));
    if (params.clear === true) {
      const { printed, ...without } = found;
      void printed;
      const next: AnalysisCase = Object.keys(rest).length === 0 ? without : { ...without, printed: rest };
      return changed(withCase(doc, next), `${NAME}: '${entityId}' of '${analysisId}' is analysed as a solid isotropic part again.`, [
        analysisId,
      ]);
    }
    const { walls, lineWidthMm, layerHeightMm, topBottomLayers, infill, layerAxis, coupon, infillExponent: given } = params;
    if (
      walls === undefined ||
      lineWidthMm === undefined ||
      layerHeightMm === undefined ||
      topBottomLayers === undefined ||
      infill === undefined ||
      layerAxis === undefined
    ) {
      const absent = Object.entries({ walls, lineWidthMm, layerHeightMm, topBottomLayers, infill, layerAxis })
        .filter(([, value]) => value === undefined)
        .map(([key]) => key);
      return fail('FLL_PRINT_PARAM', `missing ${absent.join(', ')}`, absent);
    }
    const length = Math.hypot(...layerAxis);
    if (!(length > 0) || !Number.isFinite(length)) return fail('FLL_PRINT_PARAM', 'layerAxis must be a non-zero vector', ['layerAxis']);
    if (coupon === undefined)
      return fail('FLL_PRINT_COUPON_MISSING', 'no coupon values: llull ships no typical printed-part moduli or strengths', ['coupon']);
    if (coupon.source.citation.trim() === '') return fail('FLL_PRINT_PARAM', 'coupon.source.citation is empty', ['coupon.source.citation']);
    const E_xy = toMpa(coupon.E_xy, 'coupon.E_xy');
    const E_z = toMpa(coupon.E_z, 'coupon.E_z');
    const uts_xy = toMpa(coupon.uts_xy, 'coupon.uts_xy');
    const uts_z = toMpa(coupon.uts_z, 'coupon.uts_z');
    if (typeof E_xy === 'string') return fail('FLL_PRINT_PARAM', E_xy, ['coupon.E_xy']);
    if (typeof E_z === 'string') return fail('FLL_PRINT_PARAM', E_z, ['coupon.E_z']);
    if (typeof uts_xy === 'string') return fail('FLL_PRINT_PARAM', uts_xy, ['coupon.uts_xy']);
    if (typeof uts_z === 'string') return fail('FLL_PRINT_PARAM', uts_z, ['coupon.uts_z']);
    const noExponent = (): CommandResult =>
      fail('FLL_PRINT_EXPONENT_MISSING', 'no infill exponent: llull assumes none', ['infillExponent']);
    if (given === undefined) return noExponent();
    if (given.value !== undefined && given.fitDirection !== undefined)
      return fail('FLL_PRINT_PARAM', 'give infillExponent value or fitDirection, not both', ['infillExponent']);
    const warnings: string[] = [];
    let exponent: PrintExponent;
    let fitData: Record<string, unknown> | null = null;
    if (given.value !== undefined) {
      if (given.source === undefined || given.source.citation.trim() === '')
        return fail('FLL_PRINT_PARAM', 'infillExponent.source is required with a given value', ['infillExponent.source']);
      exponent = { value: given.value, basis: 'given', source: cleanSource(given.source) };
    } else if (given.fitDirection !== undefined) {
      const direction = given.fitDirection;
      const solid = direction === 'xy' ? E_xy : E_z;
      const fitted = fitCoupons(analysisOf(doc), infill.pattern, direction, solid);
      if (typeof fitted === 'string') return fail('FLL_PRINT_FIT_POINTS', fitted, ['infillExponent.fitDirection']);
      if (!(fitted.fit.m > 0))
        return fail(
          'FLL_PRINT_PARAM',
          `the fitted exponent ${fitted.fit.m} is not > 0: the recorded moduli do not fall with infill density`,
          ['infillExponent'],
        );
      exponent = {
        value: fitted.fit.m,
        basis: 'fit',
        source: {
          citation: `fit_print_infill_exponent: least squares on ln E over coupons ${fitted.couponIds.join(', ')} (pattern ${infill.pattern}, direction ${direction}); rms ln residual ${fitted.fit.rmsLogResidual.toExponential(3)}`,
        },
      };
      const mismatch = Math.abs(fitted.fit.C / solid - 1);
      if (mismatch > SOLID_MISMATCH)
        warnings.push(
          `the fitted modulus at density 1 (${fitted.fit.C.toPrecision(5)} MPa) differs ${(mismatch * 100).toFixed(1)} % from the solid coupon ${direction} modulus (${solid} MPa)`,
        );
      fitData = { direction, couponIds: fitted.couponIds, ...fitted.fit };
    } else return noExponent();
    const print: PrintIdealization = {
      walls,
      lineWidthMm,
      layerHeightMm,
      topBottomLayers,
      infill,
      layerAxis: [layerAxis[0] / length, layerAxis[1] / length, layerAxis[2] / length] as Vec3,
      coupon: { E_xyMpa: E_xy, E_zMpa: E_z, uts_xyMpa: uts_xy, uts_zMpa: uts_z, source: cleanSource(coupon.source) },
      exponent,
    };
    const solved = printedProperties(doc, entityId, print);
    if (isPrintedRefusal(solved)) return fail(solved.code, solved.message);
    const { part, skin } = solved;
    if (skin.fraction >= 1)
      warnings.push('the skin fills the part (fraction 1): the infill has no effect, the part is solid at the coupon moduli');
    const effective = {
      E_xy: part.E1,
      E_z: part.E3,
      nu: part.nu12,
      G_xy: part.G12,
      G_z: part.G13,
      densityRatio: part.densityRatio,
      coreFactor: part.coreFactor,
    };
    const result = changed(
      withCase(doc, { ...found, printed: { ...rest, [entityId]: print } }),
      `${NAME}: '${entityId}' of '${analysisId}' is a printed part (${infill.pattern} ${infill.density}, ${walls} walls, build direction [${print.layerAxis.map((c) => +c.toFixed(6)).join(', ')}]): ` +
        `skin fraction ${skin.fraction.toPrecision(4)}, E_xy ${part.E1.toPrecision(5)} MPa, E_z ${part.E3.toPrecision(5)} MPa, density x ${part.densityRatio.toPrecision(4)}, exponent ${exponent.value.toPrecision(5)} (${exponent.basis}); UNVERIFIED (shear / Poisson not measured).`,
      [analysisId],
    );
    return {
      ...result,
      data: {
        analysisId,
        entityId,
        skinFraction: skin.fraction,
        volume: skin.volume,
        effective,
        ratioEzOverExy: part.E3 / part.E1,
        exponent,
        fit: fitData,
        strengths: { uts_xyMpa: uts_xy, uts_zMpa: uts_z, homogenised: false },
        unverified: true,
        unverifiedReasons: solved.unverifiedReasons,
        warnings,
      },
    };
  },
});
