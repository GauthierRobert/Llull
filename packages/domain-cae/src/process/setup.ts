/** am_build_setup: the build direction, plate, supports and layer height of an `am_build_distortion` case (PHY-16 FR-PRC-07). */

import type { AmBuildSettings } from '@core/model/am';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { len3 } from '@lib/vec3';
import { withCase } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { amCase, isRefusal } from './access';
import { refusePrc } from './codes';
import { buildPartsOf } from './layers';

/** A direction counts as a unit vector within this absolute length error. */
const UNIT_TOLERANCE = 1e-6;
const sig = (value: number): string => significantNumber(value, 6);

/**
 * @affects doc.analysis.cases[analysisId].am (buildDirection, plateEntityId, supportEntityIds, layerHeight replaced; strain and release steps kept; affected: [analysisId])
 * @invariant buildDirection is a finite unit vector; layerHeight is finite and > 0; the plate and every support are distinct parts of the case and at
 *   least one part is left to build; a kept release step that removes supports needs supports; no default for any value
 * @failure unknown / other-type case -> FEA_ANALYSIS_NOT_FOUND / PRC_CASE_TYPE; other solver -> PRC_SOLVER_UNSUPPORTED; any invalid value above ->
 *   PRC_BUILD_SETUP_INVALID (refusals, unchanged doc)
 */
export const amBuildSetup = defineCommand({
  name: 'am_build_setup',
  description:
    'Set up the additive build of an am_build_distortion analysis (create_analysis analysisType=am_build_distortion, CalculiX): buildDirection is the unit vector ' +
    'along which layers are added, pointing away from the plate, in document axes; plateEntityId the base plate (a part of the case, present from the start and ' +
    'never strained); supportEntityIds further parts present from the start and never strained (removed by add_release_step remove [supports]); layerHeight the ' +
    'lumped layer thickness in document units. Every other part of the case is the part that is built: its elements are binned into layers by centroid height ' +
    'above the plate top, (k-1) layerHeight <= h < k layerHeight, and activated layer by layer, so the mesh must resolve the layer height ' +
    '(layers without an element are skipped and reported). No default for any value. Keeps an existing inherent strain and release steps. Add the parts with ' +
    'set_part_idealization first, the plate constraints with add_fea_constraint (loads are not applied), the readout points with add_result_probe (u_x, u_y, u_z, ' +
    'u_mag), then set_inherent_strain, add_release_step, set_mesh_controls, fea_mesh, fea_solve. Returns affected [analysisId].',
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of an am_build_distortion analysis.'),
    buildDirection: vec3(
      'Unit vector [x, y, z] in document axes along which layers are added, pointing away from the plate, e.g. [0, 0, 1].',
    ),
    plateEntityId: z
      .string()
      .describe('Id of the base plate: a part of the analysis (set_part_idealization), never strained, removed by a release step.'),
    supportEntityIds: z
      .array(z.string())
      .optional()
      .describe('Ids of support parts of the analysis present from the start and never strained. Omit for none.'),
    layerHeight: z
      .number()
      .describe(
        'Thickness of one lumped layer along the build direction, document units, > 0. No default: it is a modelling choice (the real layer is 20-100 um; lumping 5-20 of them keeps the run affordable).',
      ),
  }),
  run: (doc, params): CommandResult => {
    const command = 'am_build_setup';
    const found = amCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const invalid = (message: string, path: string): CommandResult =>
      refusePrc(doc, command, 'PRC_BUILD_SETUP_INVALID', message, [analysis.id], [path]);
    const direction = params.buildDirection;
    if (!direction.every(Number.isFinite) || Math.abs(len3(direction) - 1) > UNIT_TOLERANCE)
      return invalid(
        `buildDirection [${direction.join(', ')}] is not a finite unit vector (length ${sig(len3(direction))})`,
        'buildDirection',
      );
    if (!Number.isFinite(params.layerHeight) || !(params.layerHeight > 0))
      return invalid(`layerHeight ${params.layerHeight} must be a finite number > 0`, 'layerHeight');
    if (!Object.hasOwn(analysis.parts, params.plateEntityId))
      return invalid(`the plate '${params.plateEntityId}' is not a part of '${analysis.id}': set_part_idealization first`, 'plateEntityId');
    const supports = [...new Set(params.supportEntityIds ?? [])];
    const missing = supports.find((id) => !Object.hasOwn(analysis.parts, id));
    if (missing !== undefined)
      return invalid(`the support '${missing}' is not a part of '${analysis.id}': set_part_idealization first`, 'supportEntityIds');
    if (supports.includes(params.plateEntityId))
      return invalid(`'${params.plateEntityId}' is both the plate and a support`, 'supportEntityIds');
    const am: AmBuildSettings = {
      buildDirection: [direction[0], direction[1], direction[2]],
      plateEntityId: params.plateEntityId,
      supportEntityIds: supports,
      layerHeight: params.layerHeight,
      ...(analysis.am?.inherentStrain === undefined ? {} : { inherentStrain: analysis.am.inherentStrain }),
      releaseSteps: analysis.am?.releaseSteps ?? [],
    };
    const built = buildPartsOf(analysis, am);
    if (built.length === 0)
      return invalid(`no part of '${analysis.id}' is left to build besides the plate and the supports`, 'plateEntityId');
    if (supports.length === 0 && am.releaseSteps.some((step) => step.remove.includes('supports')))
      return invalid('release step(s) remove supports but supportEntityIds is empty', 'supportEntityIds');
    return changed(
      withCase(doc, { ...analysis, am }),
      `am_build_setup: '${analysis.id}' builds ${built.join(', ')} along [${direction.join(', ')}] in layers of ${sig(params.layerHeight)} ${doc.units} on plate '${params.plateEntityId}'${supports.length > 0 ? ` with supports ${supports.join(', ')}` : ''}; ${am.inherentStrain === undefined ? 'no inherent strain yet (set_inherent_strain)' : 'inherent strain kept'}; ${am.releaseSteps.length} release step(s).`,
      [analysis.id],
    );
  },
});
