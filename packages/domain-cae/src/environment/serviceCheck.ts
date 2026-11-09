/** Consistency of the mission humidity exposure with the corrosion pack's service environment (decision docs/decisions/PHY14-environment-vs-corrosion.md). */

import type { CadDocument } from '@core/model/types';
import type { HumidityExposure } from './types';

/** Relative humidity (%) above which a `controlled` service environment (dry, conditioned) is inconsistent with the exposure. llull heuristic, not a standard. */
const CONTROLLED_RH_MAX = 60;
/** Relative humidity (%) below which a `harsh` or `artificial_seawater` service environment (condensing, marine) is inconsistent with the exposure. llull heuristic, not a standard. */
const HARSH_RH_MIN = 60;

/** The warning text when the corrosion service environment and the humidity exposure disagree, else null (no corrosion environment, no exposure, or `normal`: nothing to compare). */
export function serviceMismatch(doc: CadDocument, exposure: HumidityExposure | undefined): string | null {
  const service = doc.corrosion?.environment;
  if (service === undefined || exposure === undefined) return null;
  const rh = exposure.relativeHumidity;
  if (service.value === 'controlled' && rh > CONTROLLED_RH_MAX)
    return `the corrosion service environment is 'controlled' but the humidity exposure is ${rh} % RH (above ${CONTROLLED_RH_MAX} %): one of the two is wrong (llull consistency heuristic, ${CONTROLLED_RH_MAX} % RH, not a standard)`;
  if ((service.value === 'harsh' || service.value === 'artificial_seawater') && rh < HARSH_RH_MIN)
    return `the corrosion service environment is '${service.value}' but the humidity exposure is ${rh} % RH (below ${HARSH_RH_MIN} %): one of the two is wrong (llull consistency heuristic, ${HARSH_RH_MIN} % RH, not a standard)`;
  return null;
}
