/** add_cavity_radiation (PHY-03 V1): cavity radiation groups, recorded as data. */

import type { CavityRadiation } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { cavityNameProblem } from '../shared/names';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem } from './access';
import { refuseThermal } from './codes';
import { quantityProblem } from './quantities';

/**
 * @affects doc.analysis.cases[analysisId].thermal.cavities (adds 1 cavity, id `cv-<step>.<k>`; affected: [cavityId])
 * @invariant name 1-3 characters and unique; >= 2 faces, each with emissivity in [0, 1] on a part; environment open (temperature) or closed
 * @failure name too long / duplicate / < 2 faces -> THM_CAVITY_INVALID; emissivity outside [0, 1] -> THM_EMISSIVITY_INVALID; bad target;
 *   bad temperature -> THM_UNITS_MISMATCH (refusals, unchanged doc)
 */
export const addCavityRadiation = defineCommand({
  name: 'add_cavity_radiation',
  description:
    'Group faces into a radiation cavity of a heat_* analysis (CalculiX *RADIATE, CAVITY with view factors computed by the solver); ' +
    'returns the cavity id in affected[0]. name: 1-3 letters, digits or underscores, unique. faces: at least 2 { target (facesNear), emissivity 0-1 }. ' +
    'environmentTemperature { value, unit } makes the cavity OPEN (the remainder radiates to that temperature); omit it for a CLOSED ' +
    'cavity (view factors scaled to 1). Check the geometry first with compute_view_factors. Radiation is evaluated on absolute temperature.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z
      .string()
      .min(1)
      .describe('Cavity name, 1-3 letters, digits or underscores (CalculiX limit), unique in the analysis, e.g. "C1".'),
    environmentTemperature: quantitySchema
      .optional()
      .describe('Open cavity: temperature { value, unit } the unclosed part of the view radiates to. Omit for a closed cavity.'),
    faces: z
      .array(
        z.object({
          target: feaTargetSchema.describe('Radiating faces of a part (facesNear points).'),
          emissivity: z.number().describe('Hemispherical emissivity of these faces, 0 to 1.'),
        }),
      )
      .describe('At least 2 radiating face groups.'),
  }),
  run: (doc, params): CommandResult => {
    const { analysisId, name, environmentTemperature, faces } = params;
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'add_cavity_radiation', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    const cavityError = (message: string, path = 'name'): CommandResult =>
      fail(problem('THM_CAVITY_INVALID', message, [analysisId], [path]));
    const nameProblem = cavityNameProblem(name);
    if (nameProblem !== null) return cavityError(nameProblem);
    if (Object.values(found.thermal.cavities).some((cavity) => cavity.name.toUpperCase() === name.toUpperCase()))
      return cavityError(`a cavity named '${name}' exists`);
    if (faces.length < 2) return cavityError('a cavity needs at least 2 faces', 'faces');
    for (const [index, face] of faces.entries()) {
      if (!Number.isFinite(face.emissivity) || face.emissivity < 0 || face.emissivity > 1)
        return fail(
          problem(
            'THM_EMISSIVITY_INVALID',
            `faces[${index}].emissivity ${face.emissivity} is outside [0, 1]`,
            [analysisId],
            [`faces[${index}].emissivity`],
          ),
        );
      const target = toTarget(face.target);
      const bad = targetProblem(doc, found.analysisCase, target);
      if (bad !== null) return fail(problem(bad.code, bad.message, [target.entityId], [`faces[${index}].target`]));
      if ((target.facesNear ?? []).length === 0)
        return fail(problem('FEA_TARGET_UNRESOLVED', `faces[${index}] needs facesNear`, [target.entityId], [`faces[${index}].target`]));
    }
    const environment = environmentTemperature === undefined ? null : quantityProblem('temperature', environmentTemperature);
    if (environment !== null) return fail(problem('THM_UNITS_MISMATCH', environment, [analysisId], ['environmentTemperature']));
    const cavity: CavityRadiation = {
      id: nextId('cv'),
      name,
      environment: environmentTemperature === undefined ? { kind: 'closed' } : { kind: 'open', temperature: environmentTemperature },
      faces: faces.map((face) => ({ target: toTarget(face.target), emissivity: face.emissivity })),
    };
    const thermal = { ...found.thermal, cavities: { ...found.thermal.cavities, [cavity.id]: cavity } };
    return changed(
      withThermal(doc, found, thermal),
      `add_cavity_radiation: '${cavity.id}' (${name}) ${cavity.environment.kind} cavity of ${faces.length} faces in '${analysisId}'.`,
      [cavity.id],
    );
  },
});
