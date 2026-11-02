/** `guided_cantilever`: force, moment and stress of a leg absorbing a lateral displacement (07 PST M1, TR-PST-10; Kellogg guided-cantilever method). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { sectionProperties, STEEL_DENSITY_KG_M3 } from '../../catalog/sectionProperties';
import { refuse } from '../codes';

/**
 * @affects none; data = { forceN, momentNmm, stressMPa, minLegMm?, ratio?, withinAllowable?, section, formulas, reviewRequired, provenance }
 * @invariant read-only beam theory (stress multiplied by sif, default 1 listed in defaulted; warning PST_BEAM_SLENDERNESS when leg / OD < 10) F = 12 E I d / L^3, M = 6 E I d / L^2, S = M / Z = 3 E D d / L^2; neglects leg rotation so it over-predicts (screening)
 * @failure wall >= OD / 2 (non-physical section) -> PST_PARAM_INVALID
 */
export const guidedCantilever = defineCommand({
  name: 'guided_cantilever',
  description:
    'Guided-cantilever screening of a pipe leg that absorbs a lateral displacement (thermal growth of the perpendicular run): both ends keep their direction, so ' +
    'force F = 12 E I d / L^3, bending moment M = 6 E I d / L^2, stress S = i M / Z = i 3 E D d / L^2 (i = the stress intensification factor of the bends at the leg ends, from pipe_sif; default 1 = straight pipe, which UNDER-states the stress at an elbow, ii is about 2), and with an allowable S_A the minimum leg Lmin = sqrt(3 i E D d / S_A). ' +
    'Example: NPS 6 Sch 40 (OD 168.3, wall 7.11), E 200000 MPa, leg 6000 mm, d 50 mm: F 6509 N, M 1.953e7 N.mm, S 140.25 MPa, Lmin 4940.5 mm for S_A 206.85 MPa. ' +
    'Lengths mm, E and stresses MPa, force N, moment N.mm. Section I and Z come from the pipe catalogue section properties. The method ignores the rotation of the leg ends, which makes it high on a two-anchor L-bend (about 40 percent with i = 1), ' +
    'but with i left at 1 an elbow stress is not covered: give sif. Beam theory needs a slender leg: leg / OD below 10 raises the PST_BEAM_SLENDERNESS warning. A screening check, not an analysis. Read-only; reviewRequired is always true. Next: pipe_stress_allowables for S_A.',
  params: z.object({
    legMm: z.number().positive().describe('Length L of the leg that bends, in mm.'),
    displacementMm: z
      .number()
      .positive()
      .describe('Lateral displacement d to absorb, in mm (for instance thermal growth of the perpendicular run).'),
    odMm: z.number().positive().describe('Pipe outside diameter in mm.'),
    wallMm: z.number().positive().describe('Pipe wall thickness in mm (nominal, or corroded for a sustained view).'),
    EMPa: z.number().positive().describe('Elastic modulus in MPa (steel about 200000; use the value at the check temperature).'),
    sif: z
      .number()
      .min(1)
      .describe(
        'Stress intensification factor i (>= 1) of the bend or fitting at the leg end (pipe_sif ii / io). Default 1 (listed in defaulted).',
      )
      .optional(),
    SAMPa: z
      .number()
      .positive()
      .describe('Allowable displacement stress range S_A in MPa (pipe_stress_allowables). Enables Lmin and the ratio.')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const section = sectionProperties({
      odMm: params.odMm,
      wallMm: params.wallMm,
      steelDensityKgM3: STEEL_DENSITY_KG_M3,
      contentDensityKgM3: 0,
    });
    if (section === null)
      return refuse(
        doc,
        'guided_cantilever',
        'PST_PARAM_INVALID',
        `OD ${params.odMm} mm and wall ${params.wallMm} mm are not a physical pipe (need 0 < wall < OD / 2)`,
        [],
        ['wallMm'],
      );
    const { legMm: length, displacementMm: delta, EMPa: modulus, SAMPa: allowable } = params;
    const stiffness = modulus * section.secondMomentMm4;
    const forceN = (12 * stiffness * delta) / length ** 3;
    const momentNmm = (6 * stiffness * delta) / length ** 2;
    const intensification = params.sif ?? 1;
    const rawStressMPa = momentNmm / section.sectionModulusMm3;
    const stressMPa = intensification * rawStressMPa;
    const defaulted = params.sif === undefined ? ['sif=1 (straight pipe)'] : [];
    const warnings =
      length / params.odMm < 10
        ? [
            {
              code: 'PST_BEAM_SLENDERNESS',
              message: `leg / OD = ${(length / params.odMm).toFixed(1)} is below 10: beam theory is not reliable for a stocky leg`,
            },
          ]
        : [];
    const minLegMm = allowable === undefined ? undefined : Math.sqrt((3 * intensification * modulus * params.odMm * delta) / allowable);
    const limitText =
      allowable === undefined || minLegMm === undefined
        ? ''
        : `, Lmin ${minLegMm.toFixed(1)} mm for S_A ${allowable} MPa (${stressMPa <= allowable ? 'within' : 'over'} the allowable)`;
    return report(
      doc,
      `guided_cantilever: leg ${length} mm, d ${delta} mm, ${params.odMm} x ${params.wallMm} mm: F ${forceN.toFixed(1)} N, M ${momentNmm.toExponential(4)} N.mm, S ${stressMPa.toFixed(2)} MPa${limitText}${defaulted.length > 0 ? `; defaulted: ${defaulted.join(', ')}` : ''}${warnings.length > 0 ? `; PST_BEAM_SLENDERNESS` : ''}; screening.`,
      {
        forceN,
        momentNmm,
        stressMPa,
        rawStressMPa,
        sif: intensification,
        warnings,
        ...(allowable === undefined ? {} : { minLegMm, ratio: stressMPa / allowable, withinAllowable: stressMPa <= allowable }),
        section: { secondMomentMm4: section.secondMomentMm4, sectionModulusMm3: section.sectionModulusMm3 },
        formulas: {
          force: '12 E I d / L^3',
          moment: '6 E I d / L^2',
          stress: 'i M / Z = i 3 E D d / L^2',
          minLeg: 'sqrt(3 i E D d / S_A)',
        },
        grade: 'A',
        reviewRequired: true,
        provenance: { method: 'guided cantilever (M. W. Kellogg), beam theory', inputs: params, defaulted },
      },
    );
  },
});
