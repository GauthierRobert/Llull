/** set_inherent_strain: the layer eigenstrain of an `am_build_distortion` case, with its mandatory source (PHY-16 FR-PRC-08, AF-31). */

import type { AmBuildSettings } from '@core/model/am';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { withCase } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { amCase, amSettings, isRefusal } from './access';
import { refusePrc } from './codes';

/** An inherent strain beyond this magnitude is a unit mistake (real values are 1e-4 .. 1e-2). */
const STRAIN_LIMIT = 0.1;
const sig = (value: number): string => significantNumber(value, 6);

const strainSchema = (axis: string): z.ZodNumber =>
  z
    .number()
    .describe(
      `Inherent strain along the build-frame ${axis} axis, dimensionless, |value| < ${STRAIN_LIMIT}; negative = shrinkage of the cooling layer.`,
    );

/**
 * @affects doc.analysis.cases[analysisId].am.inherentStrain (replaced; recorded results go stale through the input hash; affected: [analysisId])
 * @invariant source is non-blank and stored trimmed; calibrated is stored as given (never inferred); |exx|, |eyy|, |ezz| < 0.1 and finite
 * @failure unknown / other-type case -> FEA_ANALYSIS_NOT_FOUND / PRC_CASE_TYPE; no build set-up -> PRC_BUILD_SETUP_MISSING; blank source ->
 *   PRC_INHERENT_STRAIN_SOURCE_MISSING; non-finite or |value| >= 0.1 -> PRC_INHERENT_STRAIN_INVALID (refusals, unchanged doc)
 */
export const setInherentStrain = defineCommand({
  name: 'set_inherent_strain',
  description:
    'Set the inherent (eigen) strain every lumped layer of an am_build_distortion analysis receives when it is deposited, in the build frame: exx and eyy in the ' +
    'layer plane (x = the document X axis made orthogonal to the build direction, document Y when the build is within 0.9 of X; y = build x x), ezz along the build ' +
    'direction. Dimensionless, negative = shrinkage. The values depend on machine, material, scan strategy and layer lumping: there is no default and no table in ' +
    'llull; `source` (a calibration run, a paper, owner data) is mandatory and `calibrated` says whether the numbers were fitted to a measurement of this ' +
    'machine / material / strategy (false is reported as the warning PRC_INHERENT_STRAIN_UNCALIBRATED: the distortion is then only as good as the guess). Each layer ' +
    'is added stress free on the deformed stack and then strained uniformly (CalculiX *MODEL CHANGE, ADD=STRAIN FREE + per-layer expansion). Needs am_build_setup first. ' +
    'Returns affected [analysisId].',
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of an am_build_distortion analysis with a build set-up (am_build_setup).'),
    exx: strainSchema('x'),
    eyy: strainSchema('y'),
    ezz: strainSchema('z (build direction)'),
    source: z
      .string()
      .describe(
        'Where the strain values come from: a calibration (machine, material, coupon), a publication, owner data. Mandatory, never a default.',
      ),
    calibrated: z
      .boolean()
      .describe(
        'true: fitted to a measured distortion of this machine / material / scan strategy; false: a literature value or an estimate (warning in the summary and check_analysis).',
      ),
  }),
  run: (doc, params): CommandResult => {
    const command = 'set_inherent_strain';
    const found = amCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const settings = amSettings(doc, command, analysis);
    if (isRefusal(settings)) return settings;
    const source = params.source.trim();
    if (source === '')
      return refusePrc(
        doc,
        command,
        'PRC_INHERENT_STRAIN_SOURCE_MISSING',
        'source is blank: say where the strain comes from',
        [analysis.id],
        ['source'],
      );
    const values = { exx: params.exx, eyy: params.eyy, ezz: params.ezz };
    const bad = Object.entries(values).find(([, value]) => !Number.isFinite(value) || Math.abs(value) >= STRAIN_LIMIT);
    if (bad !== undefined)
      return refusePrc(
        doc,
        command,
        'PRC_INHERENT_STRAIN_INVALID',
        `${bad[0]} ${bad[1]} is not a finite strain below ${STRAIN_LIMIT} in magnitude`,
        [analysis.id],
        [bad[0]],
      );
    const am: AmBuildSettings = { ...settings.am, inherentStrain: { ...values, source, calibrated: params.calibrated } };
    return changed(
      withCase(doc, { ...analysis, am }),
      `set_inherent_strain: '${analysis.id}' exx ${sig(values.exx)}, eyy ${sig(values.eyy)}, ezz ${sig(values.ezz)} per layer (${params.calibrated ? 'calibrated' : 'NOT calibrated: PRC_INHERENT_STRAIN_UNCALIBRATED warning'}); source: ${source}.`,
      [analysis.id],
    );
  },
});
