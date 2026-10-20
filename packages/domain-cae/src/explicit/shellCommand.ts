/** set_explicit_shell: mesh a thin box part of an explicit case as Belytschko–Tsay shells (RS1 RS-8c, PHY-19 TECHNICAL_SPEC §13.8). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { refuseExplicit } from './codes';
import { explicitCase, withSpec } from './model';

/** Largest thickness / smallest in-plane size a box may have to be meshed as a shell. */
const MAX_SLENDERNESS = 0.25;

/**
 * @affects doc.analysis.cases[analysisId].explicit.shells (sets or removes the shell meshing of one part)
 * @invariant the part is an unrotated box whose smallest dimension is at most 0.25 x its smaller in-plane one; meshed by structured_hex only
 * @failure unknown / non-explicit case / no controls -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE / EXP_CONTROLS_MISSING; part not in the case ->
 *   EXP_TARGET_NOT_IN_CASE; not an unrotated thin box, points outside 1..5 -> EXP_SHELL_INVALID
 */
export const setExplicitShell = defineCommand({
  name: 'set_explicit_shell',
  description:
    'Mesh a thin box part of an explicit_dynamics case as Belytschko-Tsay shells (llull_explicit, CPU path): the mid-surface across the two ' +
    'largest dimensions, shell thickness = the smallest dimension, one-point in-plane integration with `points` Gauss points through the ' +
    'thickness (default 2), elastic or Johnson-Cook plane-stress plasticity. Needs the structured_hex mesh source. shell: false meshes the part ' +
    'as hex8 again. Shells take part in rigid walls, not in contacts.',
  params: z.object({
    analysisId: analysisIdSchema,
    entityId: z.string().describe('A box part of the case whose smallest dimension is at most a quarter of the other two.'),
    shell: z.boolean().describe('true: shells; false: back to hex8.'),
    points: z.number().int().optional().describe('Gauss points through the thickness, 1 to 5. Default 2 (LS-DYNA NIP default).'),
  }),
  run: (doc, { analysisId, entityId, shell, points = 2 }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseExplicit(doc, 'set_explicit_shell', code, message, [analysisId], paths);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { analysisCase, spec } = found;
    if (spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
    if (!Object.hasOwn(analysisCase.parts, entityId))
      return fail('EXP_TARGET_NOT_IN_CASE', `'${entityId}' is not a part of '${analysisId}'`, ['entityId']);
    const rest = Object.fromEntries(Object.entries(spec.shells ?? {}).filter(([id]) => id !== entityId));
    if (!shell) {
      const { shells, ...without } = spec;
      void shells;
      return changed(
        withSpec(doc, analysisCase, Object.keys(rest).length === 0 ? without : { ...without, shells: rest }),
        `set_explicit_shell: ${entityId} is meshed as hex8 in ${analysisId}.`,
        [analysisId],
      );
    }
    const entity = doc.entities[entityId];
    if (entity?.kind !== 'box' || entity.rotation.some((angle) => angle !== 0))
      return fail('EXP_SHELL_INVALID', `'${entityId}' is not an unrotated box`, ['entityId']);
    const sorted = [...entity.size].sort((a, b) => a - b);
    const [thickness = 0, smaller = 0] = sorted;
    if (thickness > MAX_SLENDERNESS * smaller)
      return fail(
        'EXP_SHELL_INVALID',
        `'${entityId}' is ${thickness} thick for ${smaller} wide: not thin enough for a shell (at most 1/4)`,
        ['entityId'],
      );
    if (!(points >= 1 && points <= 5)) return fail('EXP_SHELL_INVALID', 'points must be 1 to 5', ['points']);
    return changed(
      withSpec(doc, analysisCase, { ...spec, shells: { ...rest, [entityId]: { points } } }),
      `set_explicit_shell: ${entityId} meshed as Belytschko-Tsay shells, thickness ${thickness} ${doc.units}, ${points} point(s) through the thickness, in ${analysisId}.`,
      [analysisId],
    );
  },
});
