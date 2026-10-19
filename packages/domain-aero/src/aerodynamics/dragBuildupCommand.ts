/** drag_buildup: component parasite-drag build-up table with sourced formulas (10 AER M3). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { airStateParams, isAirState, resolveAirState } from '../shared/airState';
import { briefReport, sig } from '../shared/results';
import { toMetresPerSecond } from '../shared/speed';
import { refuseAero } from './codes';
import { bodyFormFactor, FORMULAS, liftingFormFactor, skinFrictionMixed, type FormFactorModel } from './dragBuildup';

const RAD = Math.PI / 180;

/**
 * @affects none (query); data = { flow { speedMS, mach, dynamicPressurePa, air }, referenceAreaM2, components [{ name, kind, reynolds, cf, formFactor, formFactorModel, interferenceFactor, interferenceDefaulted, wettedAreaM2, cd0, percent }], cd0, dragN, formulas, warnings, provenance }
 * @invariant CD0 = Σ Cf FF Q S_wet / S_ref; Q is never invented (default 1, flagged)
 * @failure missing / bad shape input for the model, non-positive areas / lengths / speed, laminar fraction outside [0, 1), raymer on a body -> AER_PARAM_INVALID; bad air state -> its AER_* code
 */
export const dragBuildupCommand = defineCommand({
  name: 'drag_buildup',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only parasite (zero-lift) drag build-up of an aircraft or vehicle by components, CD0 = Σ Cf·FF·Q·S_wet / S_ref (Raymer §12.5): ' +
    'per component the Reynolds number on its reference length, flat-plate skin friction Cf (Raymer 12.26 laminar / 12.27 turbulent with ' +
    'the Mach correction, optional laminar fraction), the form factor FF (lifting surfaces: raymer with (x/c)_m and sweep, torenbeek or ' +
    'hoerner from t/c; bodies: torenbeek or hoerner from the fineness ratio l/d) and the interference factor Q (an input: default 1, flagged). ' +
    'Returns the table, CD0, the drag in N at the speed and the formulas with their sources. Wetted areas: frontal_area returns them ' +
    'from the model. Not modelled: roughness cutoff Reynolds number, wave drag, excrescences (add them to the result by hand).',
  params: z.object({
    components: z
      .array(
        z.object({
          name: z.string().describe('Component name, e.g. "wing", "fuselage".'),
          kind: z.enum(['lifting', 'body']).describe('lifting (wing, tail, strut, pylon) or body (fuselage, nacelle, pod).'),
          wettedAreaM2: z.number().describe('Wetted area S_wet in m², > 0.'),
          referenceLengthM: z.number().describe('Length for the Reynolds number in m, > 0: mean chord (lifting) or body length.'),
          thicknessRatio: z.number().optional().describe('lifting: thickness-to-chord ratio t/c in (0, 0.5).'),
          maxThicknessX: z.number().optional().describe('lifting + raymer: chordwise position of maximum thickness (x/c)_m in (0, 1).'),
          sweepDeg: z
            .number()
            .optional()
            .describe('lifting + raymer: sweep of the maximum-thickness line in degrees, |Λ| < 80. Default 0.'),
          finenessRatio: z.number().optional().describe('body: fineness ratio l/d, > 1.'),
          formFactorModel: z
            .enum(['raymer', 'torenbeek', 'hoerner'])
            .optional()
            .describe('Form-factor correlation. Default raymer (lifting) / torenbeek (body); raymer is for lifting surfaces only.'),
          interferenceFactor: z
            .number()
            .optional()
            .describe('Interference factor Q >= 1 from a configuration source. Default 1 (flagged).'),
          laminarFraction: z.number().optional().describe('Laminar share of the reference length in [0, 1). Default 0 (fully turbulent).'),
        }),
      )
      .describe('Components (1..30).'),
    referenceAreaM2: z.number().describe('Reference area S_ref in m² (usually the wing planform area), > 0.'),
    speed: z.number().describe('Air speed in speedUnit, > 0.'),
    speedUnit: z.enum(['m/s', 'km/h', 'kn', 'mph']).optional().describe('Unit of speed: m/s (default), km/h, kn or mph.'),
    ...airStateParams,
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult => refuseAero(doc, 'drag_buildup', code, message, [], [path]);
    if (params.components.length === 0 || params.components.length > 30)
      return fail('AER_PARAM_INVALID', 'give 1..30 components', 'components');
    if (!(params.referenceAreaM2 > 0)) return fail('AER_PARAM_INVALID', 'referenceAreaM2 must be > 0', 'referenceAreaM2');
    const speed = toMetresPerSecond(params.speed, params.speedUnit ?? 'm/s');
    if (!(speed > 0)) return fail('AER_PARAM_INVALID', 'speed must be > 0', 'speed');
    const air = resolveAirState(params);
    if (!isAirState(air)) return fail(air.code, air.message, 'altitudeM');
    const mach = speed / air.speedOfSoundMS;
    const q = 0.5 * air.densityKgM3 * speed * speed;
    const rows = [];
    for (const [i, c] of params.components.entries()) {
      const path = `components.${i}`;
      if (!(c.wettedAreaM2 > 0) || !(c.referenceLengthM > 0))
        return fail('AER_PARAM_INVALID', `${c.name}: areas and lengths must be > 0`, path);
      const laminar = c.laminarFraction ?? 0;
      if (!(laminar >= 0 && laminar < 1))
        return fail('AER_PARAM_INVALID', `${c.name}: laminarFraction must be in [0, 1)`, `${path}.laminarFraction`);
      const interference = c.interferenceFactor ?? 1;
      if (!(interference >= 1))
        return fail('AER_PARAM_INVALID', `${c.name}: interferenceFactor must be >= 1`, `${path}.interferenceFactor`);
      const model: FormFactorModel = c.formFactorModel ?? (c.kind === 'lifting' ? 'raymer' : 'torenbeek');
      let formFactor: number;
      if (c.kind === 'lifting') {
        const t = c.thicknessRatio;
        if (t === undefined || !(t > 0 && t < 0.5))
          return fail('AER_PARAM_INVALID', `${c.name}: thicknessRatio in (0, 0.5) is required`, `${path}.thicknessRatio`);
        const xm = c.maxThicknessX;
        if (model === 'raymer' && (xm === undefined || !(xm > 0 && xm < 1)))
          return fail('AER_PARAM_INVALID', `${c.name}: raymer needs maxThicknessX in (0, 1)`, `${path}.maxThicknessX`);
        const sweep = (c.sweepDeg ?? 0) * RAD;
        if (!(Math.abs(sweep) < 80 * RAD)) return fail('AER_PARAM_INVALID', `${c.name}: |sweepDeg| must be < 80`, `${path}.sweepDeg`);
        formFactor = liftingFormFactor(model, { thicknessRatio: t, maxThicknessX: xm ?? 0.3, sweep }, mach);
      } else {
        if (model === 'raymer')
          return fail('AER_PARAM_INVALID', `${c.name}: the raymer form factor is for lifting surfaces`, `${path}.formFactorModel`);
        const f = c.finenessRatio;
        if (f === undefined || !(f > 1))
          return fail('AER_PARAM_INVALID', `${c.name}: finenessRatio > 1 is required`, `${path}.finenessRatio`);
        formFactor = bodyFormFactor(model, f);
      }
      const reynolds = (air.densityKgM3 * speed * c.referenceLengthM) / air.viscosityPaS;
      const cf = skinFrictionMixed(reynolds, mach, laminar);
      rows.push({
        c,
        model,
        formFactor,
        reynolds,
        cf,
        interference,
        cd0: (cf * formFactor * interference * c.wettedAreaM2) / params.referenceAreaM2,
      });
    }
    const cd0 = rows.reduce((sum, row) => sum + row.cd0, 0);
    const lowMachRaymer = rows.some((row) => row.model === 'raymer') && mach < 0.2;
    const data = {
      flow: {
        speedMS: sig(speed),
        mach: sig(mach),
        dynamicPressurePa: sig(q),
        air: { densityKgM3: sig(air.densityKgM3), viscosityPaS: sig(air.viscosityPaS), source: air.source },
      },
      referenceAreaM2: params.referenceAreaM2,
      components: rows.map((row) => ({
        name: row.c.name,
        kind: row.c.kind,
        reynolds: sig(row.reynolds),
        cf: sig(row.cf),
        laminarFraction: row.c.laminarFraction ?? 0,
        formFactor: sig(row.formFactor),
        formFactorModel: row.model,
        interferenceFactor: row.interference,
        interferenceDefaulted: row.c.interferenceFactor === undefined,
        wettedAreaM2: row.c.wettedAreaM2,
        cd0: sig(row.cd0),
        percent: sig((row.cd0 / cd0) * 100),
      })),
      cd0: sig(cd0),
      dragN: sig(q * params.referenceAreaM2 * cd0),
      formulas: FORMULAS,
      warnings: [
        ...(rows.some((row) => row.c.interferenceFactor === undefined)
          ? ['interferenceFactor defaulted to 1 (no interference) on some components: take Q from a configuration source.']
          : []),
        ...(lowMachRaymer
          ? [`Mach ${sig(mach)} < 0.2: Raymer's factor 1.34 M^0.18 falls below 1 there; prefer torenbeek or hoerner at low speed.`]
          : []),
        ...(mach > 0.8 ? [`Mach ${sig(mach)} > 0.8: wave drag is not included.`] : []),
        'Roughness cutoff Reynolds number, excrescences, leakage and wave drag are not included.',
      ],
      provenance: { method: 'component build-up (Raymer §12.5)', sources: 'docs/aerospace/10-aerodynamics/validation/sources.md S15, S16' },
    };
    return briefReport(
      doc,
      `drag_buildup at ${data.flow.speedMS} m/s (M ${data.flow.mach}): ` +
        data.components.map((row) => `${row.name} Cf ${row.cf} FF ${row.formFactor} Q ${row.interferenceFactor} -> ${row.cd0}`).join('; ') +
        `; CD0 ${data.cd0}, D ${data.dragN} N.`,
      data,
    );
  },
});
