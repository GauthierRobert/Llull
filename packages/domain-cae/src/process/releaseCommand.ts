/** add_release_step: cut the part from the plate and / or remove supports, held by a statically determinate 3-2-1 support (PHY-16 FR-PRC-09, TR-PRC-22). */

import type { AmBuildSettings } from '@core/model/am';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { withCase } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { amCase, amSettings, isRefusal } from './access';
import { refusePrc } from './codes';
import { support321 } from './support321';

/**
 * @affects doc.analysis.cases[analysisId].am.releaseSteps (appended; affected: [analysisId])
 * @invariant names are unique within the case; plate and supports are each removed at most once over all steps; the three points are non-collinear (so
 *   support321 fixes P1 in x y z, P2 in two axes, P3 in one: six independent rigid-body constraints)
 * @failure unknown / other-type case -> FEA_ANALYSIS_NOT_FOUND / PRC_CASE_TYPE; no build set-up -> PRC_BUILD_SETUP_MISSING; blank or duplicate name,
 *   a repeated removal, supports without supportEntityIds -> PRC_RELEASE_INVALID; collinear / coincident / non-finite points ->
 *   PRC_RELEASE_UNSUPPORTED (refusals, unchanged doc)
 */
export const addReleaseStep = defineCommand({
  name: 'add_release_step',
  description:
    'Append a release step to an am_build_distortion analysis: after the build (and after the earlier release steps) the listed parts are removed - remove [plate] ' +
    'cuts the part from the base plate, [supports] strips the supports (parts named by supportEntityIds in am_build_setup); each part can be removed once. The ' +
    'constraints of the case are replaced by a minimal statically determinate 3-2-1 support: support321.points are three non-collinear points (document units) ' +
    'on the part that remains; the nearest mesh nodes of the remaining parts are fixed (point 1 in x, y, z; point 2 in the two axes orthogonal to the line 1-2; ' +
    'point 3 in the axis the rotation about that line moves it most), so the released part deforms freely with no reaction and is not singular. The result ' +
    'is the residual distortion relative to this support: probes then read the distortion after the release. Results (displacement, stress) are stored for the ' +
    'end of the build and for each release step. Refused when the points leave the support singular. Returns affected [analysisId].',
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of an am_build_distortion analysis with a build set-up (am_build_setup).'),
    name: z.string().describe('Name of the step, unique in the analysis (e.g. "cut_plate"); labels its results.'),
    remove: z
      .array(z.enum(['plate', 'supports']))
      .min(1)
      .describe('Parts removed in this step: plate (plateEntityId) and / or supports (supportEntityIds). Each can be removed once.'),
    support321: z
      .object({
        points: z
          .array(vec3('A point [x, y, z] in document units on the part that remains.'))
          .length(3)
          .describe(
            'Three non-collinear points on the remaining part (document units): P1 fixed in x, y, z; P2 and P3 as described above.',
          ),
      })
      .describe('Statically determinate support of the released part: three points of the part that remains (document units).'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'add_release_step';
    const found = amCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const settings = amSettings(doc, command, analysis);
    if (isRefusal(settings)) return settings;
    const { am } = settings;
    const invalid = (message: string, path: string): CommandResult =>
      refusePrc(doc, command, 'PRC_RELEASE_INVALID', message, [analysis.id], [path]);
    const name = params.name.trim();
    if (name === '') return invalid('name is blank', 'name');
    if (am.releaseSteps.some((step) => step.name === name)) return invalid(`a release step '${name}' already exists`, 'name');
    const remove = [...new Set(params.remove)];
    if (remove.length !== params.remove.length) return invalid('remove lists a part twice', 'remove');
    if (remove.includes('supports') && am.supportEntityIds.length === 0)
      return invalid('remove supports, but am_build_setup gave no supportEntityIds', 'remove');
    const already = remove.find((part) => am.releaseSteps.some((step) => step.remove.includes(part)));
    if (already !== undefined) return invalid(`the ${already} was removed by an earlier release step`, 'remove');
    const [p1, p2, p3] = params.support321.points;
    if (p1 === undefined || p2 === undefined || p3 === undefined)
      return refusePrc(
        doc,
        command,
        'PRC_RELEASE_UNSUPPORTED',
        'support321.points needs exactly three points',
        [analysis.id],
        ['support321'],
      );
    const dofs = support321([p1, p2, p3]);
    if (typeof dofs === 'string') return refusePrc(doc, command, 'PRC_RELEASE_UNSUPPORTED', dofs, [analysis.id], ['support321']);
    const next: AmBuildSettings = { ...am, releaseSteps: [...am.releaseSteps, { name, remove, support321: [p1, p2, p3] }] };
    return changed(
      withCase(doc, { ...analysis, am: next }),
      `add_release_step: '${analysis.id}' step ${next.releaseSteps.length} '${name}' removes ${remove.join(' + ')}; 3-2-1 support fixes ${dofs.map((d, i) => `P${i + 1} dof ${d.join(',')}`).join(', ')}.`,
      [analysis.id],
    );
  },
});
