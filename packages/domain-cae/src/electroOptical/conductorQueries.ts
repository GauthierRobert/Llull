/** electrical_resistance / shield_absorption (PHY-15 FR-EOP-02..05): closed-form conductor queries, no document change. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { refuseEop } from './codes';
import { MU_0, absorptionLossDb, bulkResistance, skinDepth } from './physics';
import { resistivityOf } from './resistivity';

const quantity = (what: string, example: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  z
    .object({ value: z.number().describe(`${what}: positive, finite.`), unit: z.string().describe(`Unit, e.g. '${example}'.`) })
    .describe(`${what} as { value, unit }.`);

interface Rho {
  readonly rho: number;
  readonly source: string;
  readonly temperatureModel: string;
  readonly unverified: readonly string[];
}

/** The resistivity of a query: a caller value (ohm m) or a material's electricalResistivity model; a refusal otherwise. */
function resistivityInput(
  doc: CadDocument,
  params: {
    material?: string | undefined;
    resistivity?: { value: number; unit: string } | undefined;
    temperature?: { value: number; unit: string } | undefined;
  },
  ctx: ExecutionContext | undefined,
): Rho | { readonly code: string; readonly message: string; readonly path: string } {
  if ((params.material === undefined) === (params.resistivity === undefined))
    return { code: 'EOP_PARAMS_INVALID', message: 'give exactly one of material and resistivity', path: 'material' };
  if (params.resistivity !== undefined) {
    const rho = convertValue(params.resistivity.value, params.resistivity.unit, 'ohm*m');
    if (isUnitFailure(rho) || !(rho.value > 0) || !Number.isFinite(rho.value))
      return {
        code: 'EOP_UNITS_MISMATCH',
        message: "resistivity must be a positive value in a resistivity unit ('ohm*m', 'uohm*cm')",
        path: 'resistivity',
      };
    return {
      rho: rho.value,
      source: 'caller-supplied resistivity (no record)',
      temperatureModel: 'none (caller value, taken as given at the temperature of use)',
      unverified: ['EOP_VALUE_UNSOURCED: the resistivity was supplied by the caller without a record'],
    };
  }
  const found = resistivityOf(doc, params.material ?? '', params.temperature, ctx);
  if ('code' in found) return { code: found.code, message: found.message, path: 'material' };
  return {
    rho: found.rho,
    source: found.provenance,
    temperatureModel:
      params.temperature === undefined
        ? 'none (constant model or no temperature given)'
        : 'PHY-01 model evaluated at the given temperature',
    unverified: found.unverified ? found.reasons.map((reason) => `${params.material}: ${reason}`) : [],
  };
}

const positive = (q: { value: number; unit: string }, reference: string): number | null => {
  const converted = convertValue(q.value, q.unit, reference);
  return isUnitFailure(converted) || !(converted.value > 0) || !Number.isFinite(converted.value) ? null : converted.value;
};

const RHO_PARAMS = {
  material: z
    .string()
    .optional()
    .describe('Material id with an electricalResistivity PHY-01 model (define_property_model, unit ohm*m). Give this OR resistivity.'),
  resistivity: quantity('Resistivity', 'ohm*m')
    .optional()
    .describe('Resistivity as { value, unit } (ohm*m, uohm*cm). Give this OR material.'),
  temperature: quantity('Evaluation temperature', 'degC')
    .optional()
    .describe('Temperature the material model is evaluated at (required when the model has a T variable).'),
  mur: z
    .number()
    .optional()
    .describe(
      'Relative permeability (> 0; >= 1 except diamagnetic). REQUIRED for the skin-depth path (frequency given) and for shield_absorption: state 1 for a non-magnetic conductor. There is no default.',
    ),
};

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant R_dc = rho L / A; delta = sqrt(rho / (pi f mu0 mur)) with mu0 = 4 pi 1e-7 N/A^2 named; round wire R_ac/R_dc ~ r / (2 delta) valid when r/delta >= 5 (approximate: true otherwise; for r/delta < 1 the ratio is 1, DC regime); the linear temperature-coefficient model is not built
 * @failure neither / both of material and resistivity, a non-positive input or unit of the wrong dimension -> EOP_PARAMS_INVALID / EOP_UNITS_MISMATCH; no resistivity model -> EOP_RESISTIVITY_UNAVAILABLE; radius without frequency -> EOP_PARAMS_INVALID (all refusals, unchanged doc)
 */
export const electricalResistance = defineCommand({
  name: 'electrical_resistance',
  annotations: { readOnly: true, idempotent: true },
  description:
    'DC resistance of a straight conductor R = rho L / A, with rho from a material electricalResistivity model (evaluated at `temperature`) or given directly. With frequency it adds the skin depth (mur REQUIRED then: state 1 for a non-magnetic conductor) ' +
    'delta = sqrt(rho / (pi f mu0 mur)) (mu0 = 4 pi 1e-7 N/A^2); with frequency and radius (round wire) the AC/DC ratio r / (2 delta), flagged approximate unless r/delta >= 5 and reported as 1 (DC regime) when r/delta < 1. ' +
    'Returns data { dcOhm, rho, temperatureModel, skinDepthM?, rOverDelta?, acOverDc?, validity?, mur? (with frequency), mu0?, formula, provenance, unverified, unverifiedReasons }. llull ships no resistivity values.',
  params: z.object({
    ...RHO_PARAMS,
    length: quantity('Conductor length', 'mm'),
    crossSection: quantity('Cross-section area', 'mm^2'),
    frequency: quantity('Frequency', 'MHz').optional().describe('Frequency for the skin depth (Hz, kHz, MHz, GHz).'),
    radius: quantity('Wire radius', 'mm').optional().describe('Radius of a round wire, for the AC/DC ratio (needs frequency).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseEop(doc, 'electrical_resistance', code, message, [], [path]);
    const rho = resistivityInput(doc, params, ctx);
    if ('code' in rho) return fail(rho.code, rho.message, rho.path);
    const length = positive(params.length, 'm');
    const area = positive(params.crossSection, 'm^2');
    if (length === null) return fail('EOP_PARAMS_INVALID', 'length must be a positive length', 'length');
    if (area === null) return fail('EOP_PARAMS_INVALID', 'crossSection must be a positive area', 'crossSection');
    if (params.radius !== undefined && params.frequency === undefined)
      return fail('EOP_PARAMS_INVALID', 'radius needs a frequency', 'frequency');
    const dc = bulkResistance(rho.rho, length, area);
    const data: Record<string, unknown> = {
      dcOhm: dc,
      rho: rho.rho,
      temperatureModel: rho.temperatureModel,
      formula: 'R = rho L / A',
      provenance: [rho.source],
      unverified: rho.unverified.length > 0,
      unverifiedReasons: rho.unverified,
    };
    let text = `electrical_resistance: R_dc = ${dc.toPrecision(8)} ohm (rho ${rho.rho.toPrecision(8)} ohm m)`;
    if (params.frequency !== undefined) {
      const hertz = positive(params.frequency, 'Hz');
      if (hertz === null) return fail('EOP_PARAMS_INVALID', 'frequency must be a positive frequency', 'frequency');
      const mur = params.mur;
      if (mur === undefined || !(mur > 0) || !Number.isFinite(mur))
        return fail(
          'EOP_PARAMS_INVALID',
          'the skin depth needs mur, a positive relative permeability (state 1 for a non-magnetic conductor): there is no default',
          'mur',
        );
      const depth = skinDepth(rho.rho, hertz, mur);
      data['mur'] = mur;
      data['mu0'] = { value: MU_0, unit: 'N/A^2', source: 'classical 4 pi 1e-7' };
      data['skinDepthM'] = depth;
      text += `, skin depth ${depth.toPrecision(6)} m at ${hertz} Hz`;
      if (params.radius !== undefined) {
        const radius = positive(params.radius, 'm');
        if (radius === null) return fail('EOP_PARAMS_INVALID', 'radius must be a positive length', 'radius');
        const rOverDelta = radius / depth;
        const ratio = rOverDelta < 1 ? 1 : radius / (2 * depth);
        data['rOverDelta'] = rOverDelta;
        data['acOverDc'] = ratio;
        data['acOhm'] = dc * ratio;
        data['validity'] = {
          rOverDelta,
          approximate: rOverDelta < 5,
          note:
            rOverDelta < 1
              ? 'r/delta < 1: DC regime, ratio reported as 1'
              : rOverDelta < 5
                ? 'r/delta < 5: the r/(2 delta) ratio is an approximation'
                : 'r/delta >= 5: thin skin approximation valid',
        };
        text += `, R_ac/R_dc ${ratio.toPrecision(6)} (r/delta ${rOverDelta.toPrecision(5)}${rOverDelta < 5 ? ', approximate' : ''})`;
      }
    }
    return report(doc, `${text}.`, data);
  },
});

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant A = 20 log10(e) t / delta dB (absorption term only: no reflection loss, no apertures), delta from the same skin depth as electrical_resistance
 * @failure as electrical_resistance for the resistivity; non-positive thickness or frequency -> EOP_PARAMS_INVALID (all refusals, unchanged doc)
 */
export const shieldAbsorption = defineCommand({
  name: 'shield_absorption',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Absorption loss of a conducting sheet: A = 8.686 t / delta dB with the skin depth delta = sqrt(rho / (pi f mu0 mur)). ABSORPTION TERM ONLY: reflection loss and apertures are not included, so this is not a shielding effectiveness. ' +
    'Resistivity from a material electricalResistivity model or given directly. Returns data { dB, skinDepthM, thicknessOverDelta, formula, note, rho, mur, provenance, unverified, unverifiedReasons }.',
  params: z.object({ ...RHO_PARAMS, thickness: quantity('Sheet thickness', 'mm'), frequency: quantity('Frequency', 'MHz') }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseEop(doc, 'shield_absorption', code, message, [], [path]);
    const rho = resistivityInput(doc, params, ctx);
    if ('code' in rho) return fail(rho.code, rho.message, rho.path);
    const thickness = positive(params.thickness, 'm');
    const hertz = positive(params.frequency, 'Hz');
    if (thickness === null) return fail('EOP_PARAMS_INVALID', 'thickness must be a positive length', 'thickness');
    if (hertz === null) return fail('EOP_PARAMS_INVALID', 'frequency must be a positive frequency', 'frequency');
    const mur = params.mur;
    if (mur === undefined || !(mur > 0) || !Number.isFinite(mur))
      return fail(
        'EOP_PARAMS_INVALID',
        'mur is required: a positive relative permeability (state 1 for a non-magnetic sheet), there is no default',
        'mur',
      );
    const depth = skinDepth(rho.rho, hertz, mur);
    const dB = absorptionLossDb(thickness, depth);
    return report(
      doc,
      `shield_absorption: ${dB.toPrecision(7)} dB absorption (t/delta ${(thickness / depth).toPrecision(6)}, delta ${depth.toPrecision(6)} m); absorption term only.`,
      {
        dB,
        skinDepthM: depth,
        thicknessOverDelta: thickness / depth,
        formula: 'A = 20 log10(e) t / delta',
        note: 'absorption term only: reflection loss and apertures are not included',
        rho: rho.rho,
        mur,
        provenance: [rho.source],
        unverified: rho.unverified.length > 0,
        unverifiedReasons: rho.unverified,
      },
    );
  },
});
