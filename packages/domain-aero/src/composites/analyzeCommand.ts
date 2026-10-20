/** analyze_laminate: CLT stiffness, engineering constants and first-ply failure of a stack or of a part at a point (FR-CMP-30..32). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { analyzeStack } from './analysis';
import type { StackPly } from './clt';
import { refuseCmp } from './codes';
import { CRITERIA } from './failure';
import { parseNotation } from './notation';
import { locate, stackAt } from './sample';
import { compositesOf, findPart } from './state';

const load = (description: string): z.ZodOptional<z.ZodNumber> => z.number().describe(description).optional();

/**
 * @affects nothing (read-only)
 * @invariant bottom-to-top stacking, +z = laminate normal (a 0 ply at the bottom of [0/90] gives B11 < 0); membrane and free-bending constants are both reported; FPF is linear, no hygrothermal
 * @failure unknown part / material -> CMP_REF_MISSING; bad stack -> CMP_NOTATION_PARSE; singular ABD -> CMP_LAMINATE_SINGULAR; loads without strengths -> CMP_MATERIAL_ALLOWABLE_MISSING
 */
export const analyzeLaminate = defineCommand({
  name: 'analyze_laminate',
  annotations: { readOnly: true },
  description:
    'Classical Laminate Theory of a stack: reduced stiffness Q of the first ply material, A (N/mm), B (N), D (N*mm), the 6x6 ABD inverse, ' +
    'engineering constants Ex, Ey, Gxy (MPa) and nuxy reported as membrane constants (A inverse), in-plane constants with bending unrestrained ' +
    '("free bending", from the ABD inverse; equal to membrane when symmetric) and flexural constants (constantsFlexural, from D inverse: E = 12 / (h^3 d)). Stacking runs bottom (tool side) to top, +z along the laminate normal, engineering ' +
    'shear strain, N-mm-MPa (thickness converted from document units). Give EITHER `part` + `point` (the stack of the part at that world ' +
    'point, see core_sample) OR `angles` (degrees, bottom to top) / `laminate` (stacking string, e.g. "[0/+-45/90]s") + `material`. ' +
    'With `environment` (deltaT, deltaMoisture) it adds the hygrothermal resultants and free laminate strains, effective expansion per kelvin and residual ply stresses. With `loads` (Nx, Ny, Nxy in N/mm; Mx, My, Mxy in N*mm/mm) it adds mid-plane strains, ply stresses at the bottom and top of every ply ' +
    'in material axes and the first-ply failure strength ratio R (load multiplier to failure) for each criterion (max_stress, tsai_hill, ' +
    'tsai_wu; default all) with the critical ply: R below 1 means failure. Tsai-Wu uses F12* = -0.5 unless the material gives one ' +
    '(reported under defaults). Results from "mean" / "unknown" material data are flagged unverified; failure results are flagged ' +
    'reviewRequired (computed by llull, not approved). Refused: missing strengths when loads are given. Read-only.',
  params: z.object({
    part: z.string().describe('Part id or name (with `point`).').optional(),
    point: vec3('World point [x, y, z] on the part, document units (with `part`).').optional(),
    angles: z.array(z.number().describe('Ply angle, degrees.')).describe('Ply angles bottom to top, degrees (with `material`).').optional(),
    laminate: z.string().describe('Stacking string instead of `angles`, e.g. "[0/45/-45/90]s" (with `material`).').optional(),
    material: z.string().describe('Lamina material name for `angles` / `laminate`.').optional(),
    loads: z
      .object({
        Nx: load('Membrane force Nx, N/mm.'),
        Ny: load('Membrane force Ny, N/mm.'),
        Nxy: load('Membrane shear force Nxy, N/mm.'),
        Mx: load('Moment Mx, N*mm/mm.'),
        My: load('Moment My, N*mm/mm.'),
        Mxy: load('Twisting moment Mxy, N*mm/mm.'),
      })
      .describe('Resultant loads per unit width; omitted components are 0.')
      .optional(),
    environment: z
      .object({
        deltaT: z
          .number()
          .describe('Temperature change from the stress-free (cure) state, kelvin; needs alpha1 and alpha2 on the material.')
          .optional(),
        deltaMoisture: z
          .number()
          .describe('Moisture content change, mass fraction (0.01 = 1%); needs beta1 and beta2 on the material.')
          .optional(),
      })
      .describe(
        'Hygrothermal state: free thermal and moisture strains of every ply (alpha dT + beta dM). Adds laminate resultants, curvature and residual ply stresses; strength ratios then mean the multiplier of the mechanical loads on top of that state (0: the state alone fails).',
      )
      .optional(),
    criteria: z
      .array(z.enum(['max_stress', 'tsai_hill', 'tsai_wu', 'larc03']))
      .describe(
        'Failure criteria to evaluate; default max_stress, tsai_hill and tsai_wu. "larc03" is a LaRC04-style plane-stress criterion (Mohr-Coulomb matrix compression, fibre kinking; no in-situ strengths, unverified) and needs GIc and GIIc on the material.',
      )
      .optional(),
  }),
  run: (doc, { part: partRef, point, angles, laminate, material, loads, criteria, environment }): CommandResult => {
    const model = compositesOf(doc);
    let stack: StackPly[];
    let inputs: Record<string, unknown>;
    if (partRef !== undefined || point !== undefined) {
      const part = partRef === undefined ? null : findPart(model, partRef);
      if (part === null) return refuseCmp(doc, 'analyze_laminate', 'CMP_REF_MISSING', `no part '${partRef ?? ''}'`, [], ['params.part']);
      const uv = point === undefined ? null : locate(part, point);
      if (uv === null)
        return refuseCmp(
          doc,
          'analyze_laminate',
          'CMP_POINT_OFF_PART',
          'give a point on the part (it projects outside its outline)',
          [part.id],
          ['params.point'],
        );
      const entries = stackAt(model, part, uv);
      if (entries.length === 0)
        return refuseCmp(doc, 'analyze_laminate', 'CMP_NO_PLIES', `no plies at [${point?.join(', ')}]`, [part.id], ['params.point']);
      stack = entries.map((entry) => ({ material: entry.material, angle: entry.ply.orientation }));
      inputs = { part: part.id, point, plies: entries.map((entry) => entry.ply.id) };
    } else {
      const lamina = material === undefined ? undefined : model.materials[material];
      if (lamina === undefined)
        return refuseCmp(doc, 'analyze_laminate', 'CMP_REF_MISSING', `no lamina material '${material ?? ''}'`, [], ['params.material']);
      const parsed = laminate === undefined ? null : parseNotation(laminate);
      if (parsed !== null && !parsed.ok)
        return refuseCmp(
          doc,
          'analyze_laminate',
          'CMP_NOTATION_PARSE',
          `${parsed.message} (token ${parsed.index} "${parsed.token}")`,
          [],
          ['params.laminate'],
        );
      const list = parsed?.ok === true ? parsed.angles : angles;
      if (list === undefined || list.length === 0)
        return refuseCmp(
          doc,
          'analyze_laminate',
          'CMP_PARAM_INVALID',
          'give part + point, or angles / laminate with a material',
          [],
          ['params.angles'],
        );
      stack = list.map((angle) => ({ material: lamina, angle }));
      inputs = { material, angles: list };
    }
    const outcome = analyzeStack(
      stack,
      doc.units,
      loads,
      criteria ?? CRITERIA,
      inputs,
      environment === undefined ? undefined : { deltaT: environment.deltaT ?? 0, deltaMoisture: environment.deltaMoisture ?? 0 },
    );
    if (!outcome.ok) return refuseCmp(doc, 'analyze_laminate', outcome.code, outcome.message, [], ['params']);
    const { data } = outcome;
    const failure = data['firstPlyFailure'] as Record<string, { R: number | null; ply?: number }> | undefined;
    const governing =
      failure === undefined
        ? ''
        : ` First-ply failure R: ${Object.entries(failure)
            .map(([name, hit]) => `${name} ${hit.R === null ? 'none' : `${hit.R} (ply ${hit.ply})`}`)
            .join(', ')}; computed by llull, not approved: needs a qualified engineer.`;
    const constants = data['constantsMembrane'] as { Ex: number; Ey: number; Gxy: number; nuxy: number };
    return report(
      doc,
      `analyze_laminate: ${stack.length} plies, ${data['thicknessMm']} mm; membrane Ex ${constants.Ex} MPa, Ey ${constants.Ey} MPa, Gxy ${constants.Gxy} MPa, nuxy ${constants.nuxy}.${governing}${data['unverified'] === true ? ' UNVERIFIED material data.' : ''}`,
      data,
    );
  },
});
