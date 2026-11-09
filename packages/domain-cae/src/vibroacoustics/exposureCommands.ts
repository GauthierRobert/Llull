/** define_acoustic_exposure / delete_acoustic_exposure (PHY-20 FR-VAC-08, 09): bind a stored spectrum to faces of a solid. */

import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { entityTargetProblem, targetDistanceWarning } from '../shared/target';
import { refuseVac, unverifiedItem } from './codes';
import { exposureOf, MAX_FACES, NAME_PATTERN, spectrumOf, withExposure, withoutExposure } from './model';
import { spectrumName } from './spectrumCommands';
import type { AcousticExposure } from './types';

const exposureName = z
  .string()
  .describe(
    'Exposure name: same rule as a spectrum name (a letter first, then letters, digits, "_", "." or "-", max 64 characters). It is the exposure key.',
  );

/**
 * @affects doc.vibroacoustics.exposures (adds 1 exposure; affected: [name])
 * @invariant field is stated (no default); incidenceDeg only for a progressive field; the target is a solid that exists and carries at least one facesNear point
 *   (faces resolve at export, with the exact kernel); an unverified spectrum makes the exposure carry VAC_SPECTRUM_UNVERIFIED
 * @failure name exists -> VAC_NAME_TAKEN; unknown spectrum -> VAC_SPECTRUM_UNKNOWN; field missing / other -> VAC_FIELD_UNSET; incidenceDeg with a diffuse
 *   field or bad name -> VAC_PARAMS_INVALID; missing / 2D entity -> FEA_TARGET_UNRESOLVED (all refusals leave the document unchanged)
 */
export const defineAcousticExposure = defineCommand({
  name: 'define_acoustic_exposure',
  description:
    'Bind a stored acoustic spectrum (define_acoustic_spectrum; dB re 20 micropascal per band) to faces of a 3D solid as an acoustic exposure: the environment of a launch or test that the ' +
    'structure sees. Faces are identified by points on them (target.facesNear, document units; each resolves to the nearest face at export). The field type is REQUIRED, there is no ' +
    'default: "diffuse" (random incidence, uniform rms pressure) or "progressive" (a plane wave; incidenceDeg, 0 to 90, is the angle from the face normal and only valid here). ' +
    'This is a hand-off input: llull does not compute the structural or acoustic response (no SEA, no acoustic FE). Next: export_acoustic_load (needs the exact kernel: face areas) ' +
    'and check_acoustic_handoff. An unverified spectrum (not grade A) makes the exposure unverified (VAC_SPECTRUM_UNVERIFIED). Returns the exposure name in affected[0].',
  params: z.object({
    name: exposureName,
    spectrum: spectrumName.describe('Name of a stored spectrum (define_acoustic_spectrum).'),
    target: z
      .object({
        entityId: z.string().describe('Id of the 3D solid whose faces are exposed.'),
        facesNear: z
          .array(vec3('A point [x, y, z] in document units on (or very near) the exposed face.'))
          .min(1)
          .max(MAX_FACES)
          .describe('At least one point; each identifies the nearest face of the solid. Use inspect_faces for face centroids.'),
      })
      .describe('The exposed faces.'),
    field: z
      .string()
      .optional()
      .describe('Required: "diffuse" or "progressive". Missing or any other value is refused (VAC_FIELD_UNSET); there is no default.'),
    incidenceDeg: z
      .number()
      .min(0)
      .max(90)
      .optional()
      .describe('Progressive field only: angle of incidence from the face normal, degrees (0 to 90). Refused with a diffuse field.'),
    notes: z.string().optional().describe('Free text (load case, source of the exposure).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseVac(doc, 'define_acoustic_exposure', code, message, [params.name], paths);
    if (!NAME_PATTERN.test(params.name)) return fail('VAC_PARAMS_INVALID', `name '${params.name}' is not a valid exposure name`, ['name']);
    if (exposureOf(doc, params.name) !== undefined) return fail('VAC_NAME_TAKEN', `exposure '${params.name}' exists`, ['name']);
    const spectrum = spectrumOf(doc, params.spectrum);
    if (spectrum === undefined) return fail('VAC_SPECTRUM_UNKNOWN', `no spectrum '${params.spectrum}'`, ['spectrum']);
    const { field } = params;
    if (field !== 'diffuse' && field !== 'progressive')
      return fail('VAC_FIELD_UNSET', `field must be 'diffuse' or 'progressive', got ${field === undefined ? 'nothing' : `'${field}'`}`, [
        'field',
      ]);
    if (field === 'diffuse' && params.incidenceDeg !== undefined)
      return fail('VAC_PARAMS_INVALID', 'incidenceDeg belongs to a progressive field, not a diffuse one', ['incidenceDeg']);
    const problem = entityTargetProblem(doc, params.target);
    if (problem !== null) return fail(problem.code, problem.message, ['target']);
    const exposure: AcousticExposure = {
      name: params.name,
      spectrum: spectrum.name,
      target: { entityId: params.target.entityId, facesNear: params.target.facesNear.map(([x, y, z]) => [x, y, z] as const) },
      field,
      ...(params.incidenceDeg === undefined ? {} : { incidenceDeg: params.incidenceDeg }),
      ...(params.notes === undefined ? {} : { notes: params.notes }),
    };
    const items = spectrum.unverified ? [unverifiedItem(spectrum.name)] : [];
    return {
      ...changed(
        withExposure(doc, exposure),
        `Defined acoustic exposure '${exposure.name}': spectrum '${spectrum.name}' (${spectrum.bandwidth}, ${spectrum.bands.length} bands) as a ${field} field on ${exposure.target.facesNear.length} face point(s) of '${exposure.target.entityId}'${spectrum.unverified ? '; VAC_SPECTRUM_UNVERIFIED: not grade A' : ''}.${targetDistanceWarning(doc, exposure.target)}`,
        [exposure.name],
      ),
      data: { name: exposure.name, spectrum: spectrum.name, field, unverified: spectrum.unverified, items },
    };
  },
});

/**
 * @affects doc.vibroacoustics.exposures (removes 1 exposure; affected: [name]); the spectrum is kept
 * @failure unknown name -> VAC_EXPOSURE_UNKNOWN (unchanged doc)
 */
export const deleteAcousticExposure = defineCommand({
  name: 'delete_acoustic_exposure',
  description:
    'Delete a stored acoustic exposure (define_acoustic_exposure). Its spectrum is kept, and can then be deleted when no other exposure uses it.',
  annotations: { destructive: true },
  params: z.object({ name: exposureName.describe('Name of the exposure to delete.') }),
  run: (doc, params): CommandResult => {
    if (exposureOf(doc, params.name) === undefined)
      return refuseVac(doc, 'delete_acoustic_exposure', 'VAC_EXPOSURE_UNKNOWN', `no exposure '${params.name}'`, [params.name], ['name']);
    return changed(withoutExposure(doc, params.name), `Deleted acoustic exposure '${params.name}'.`, [params.name]);
  },
});
