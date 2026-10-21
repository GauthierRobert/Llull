/** Named defaults (AF-31, TECHNICAL_SPEC 5.6) and limits of the topology plugin. */

import type { NamedValue, TopologySettings } from '@core/model/topology';

/** Voxel count above which a study is refused (provisional: the per-device DOF cap is set from the VC-TOP-34 measurements). */
export const TOPOLOGY_VOXEL_CAP = 4_000_000;
/** History rows kept in a recorded summary. */
export const HISTORY_ROW_CAP = 1000;

const CALIBRATE = 'llull choice (to calibrate on the production scenario, spec section 11)';
export const IOU_TARGET: NamedValue = { value: 0.85, source: CALIBRATE, defaulted: true };
export const COMPLIANCE_RATIO_TARGET: NamedValue = { value: 1.15, source: CALIBRATE, defaulted: true };
/** Douglas-Peucker tolerance default is one voxel; the minimum loop area default is 4 voxel^2 (TR-TOP-09). */
export const MIN_LOOP_AREA_VOXELS = 4;

const named = (value: number, source: string): NamedValue => ({ value, source, defaulted: true });
const ANDREASSEN = 'Andreassen et al. 2011 (top88) default';

/** Default settings of a study of grid spacing `voxel` (the filter radius default is 1.5 voxel, in document units). */
export const defaultSettings = (voxel: number): TopologySettings => ({
  penal: named(3, ANDREASSEN),
  eminRatio: named(1e-9, ANDREASSEN),
  move: named(0.2, ANDREASSEN),
  changeTol: named(0.01, ANDREASSEN),
  maxIterations: named(300, 'llull choice'),
  filter: { kind: 'sensitivity', radius: named(1.5 * voxel, `${ANDREASSEN} rmin = 1.5 voxel`) },
  threshold: named(0.5, 'llull choice'),
  greyLimit: named(0.1, 'llull choice'),
  protectLoadSupport: { value: true, source: 'llull choice (false reproduces top88)', defaulted: true },
  optimizer: 'oc',
});
