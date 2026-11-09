/** check_acoustic_handoff (PHY-20 AF-20): readiness of the acoustic exposures for export; missing data is unknown, never a pass. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { is3D } from '@core/model/types';
import type { VacItem } from './codes';
import { unverifiedItem } from './codes';
import { facesNearPoints } from './faceResolve';
import { spectrumOf, vibroacousticsOf } from './model';

const item = (code: string, severity: VacItem['severity'], message: string, remediation: string): VacItem => ({
  code,
  severity,
  message,
  remediation,
});

/**
 * @invariant kernel-optional: with the exact kernel every facesNear point is resolved to a face; without it the faces are not checked and the status is
 *   unknown, never pass
 * @invariant read-only; data { status: pass | warn | fail | unknown, exposures, items[{ code, severity, message, remediation }], reviewRequired: true }; fail = an error item,
 *   unknown = no exposure or faces not checked (and no error), warn = only warnings, pass = every exposure resolved on the exact kernel with a grade A spectrum
 * @failure none: problems are items
 */
export const checkAcousticHandoff = defineCommand({
  name: 'check_acoustic_handoff',
  annotations: { readOnly: true, kernelOptional: true },
  description:
    'Check the acoustic exposures of the document before export_acoustic_load and return data { status: pass | warn | fail | unknown, exposures, items [{ code, severity: error | warning | info, message, remediation }], reviewRequired: true }. ' +
    'Per exposure: its spectrum exists (VAC_SPECTRUM_UNKNOWN), the spectrum is grade A (VAC_SPECTRUM_UNVERIFIED warning), the target is a 3D solid of the document and, with the exact kernel, every facesNear point ' +
    'resolves to one face (VAC_EXPOSURE_UNRESOLVED error). Without the exact kernel the faces cannot be checked: VAC_EXPOSURE_UNCHECKED (info) and the status is unknown, never pass. No exposure at all is VAC_NO_EXPOSURE and unknown. ' +
    'It is not a qualification: reviewRequired is always true and a qualified person must review the environment. Does not modify the document.',
  params: z.object({}),
  run: (doc, _params, ctx): CommandResult => {
    const { exposures, exposureOrder } = vibroacousticsOf(doc);
    const kernel = ctx?.kernel ?? null;
    const exact = kernel !== null && kernel.faceQuery !== undefined;
    const items: VacItem[] = [];
    if (exposureOrder.length === 0)
      items.push(
        item('VAC_NO_EXPOSURE', 'info', 'the document has no acoustic exposure', 'define_acoustic_exposure binds a spectrum to faces'),
      );
    for (const name of exposureOrder) {
      const exposure = exposures[name];
      if (exposure === undefined) continue;
      const spectrum = spectrumOf(doc, exposure.spectrum);
      if (spectrum === undefined)
        items.push(
          item(
            'VAC_SPECTRUM_UNKNOWN',
            'error',
            `exposure '${name}' names no spectrum '${exposure.spectrum}'`,
            'define it with define_acoustic_spectrum',
          ),
        );
      else if (spectrum.unverified)
        items.push({ ...unverifiedItem(spectrum.name), message: `exposure '${name}': ${unverifiedItem(spectrum.name).message}` });
      const entityId = exposure.target.entityId;
      const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
      if (entity === undefined || !is3D(entity)) {
        items.push(
          item(
            'VAC_EXPOSURE_UNRESOLVED',
            'error',
            `exposure '${name}': target '${entityId}' is not a 3D solid of the document`,
            'retarget the exposure at an existing solid',
          ),
        );
      } else if (!exact) {
        items.push(
          item(
            'VAC_EXPOSURE_UNCHECKED',
            'info',
            `exposure '${name}': faces of '${entityId}' not checked, no exact kernel`,
            'run with the exact kernel (desktop app, or LLULL_KERNEL=occt-native)',
          ),
        );
      } else {
        const resolved = facesNearPoints(doc, kernel, entity, exposure.target.facesNear);
        if ('problem' in resolved)
          items.push(
            item(
              'VAC_EXPOSURE_UNRESOLVED',
              'error',
              `exposure '${name}': ${resolved.problem}`,
              'move the facesNear points onto face interiors of the solid',
            ),
          );
      }
    }
    const errors = items.filter((entry) => entry.severity === 'error').length;
    const warnings = items.filter((entry) => entry.severity === 'warning').length;
    const unchecked = items.some((entry) => entry.code === 'VAC_EXPOSURE_UNCHECKED' || entry.code === 'VAC_NO_EXPOSURE');
    const status = errors > 0 ? 'fail' : unchecked ? 'unknown' : warnings > 0 ? 'warn' : 'pass';
    return report(
      doc,
      `check_acoustic_handoff: ${status} — ${exposureOrder.length} exposure(s), ${errors} error(s), ${warnings} warning(s)${items.length > 0 ? `: ${[...new Set(items.map((entry) => entry.code))].join(', ')}` : ''}; reviewRequired.`,
      { status, exposures: exposureOrder.length, items, reviewRequired: true },
    );
  },
});
