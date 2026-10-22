/** Named defaults (AF-31, TECHNICAL_SPEC 5.6 / 15) and limits of the topology plugin. */

import type { UnitSystem } from '@core/model/analysis';
import type { NamedValue, TopologyProjection, TopologySettings } from '@core/model/topology';

/** Force x length unit of a compliance in each analysis unit system. */
export const COMPLIANCE_UNIT: Readonly<Record<UnitSystem, string>> = { 'N-mm-t-s': 'N*mm', 'N-m-kg-s': 'N*m', 'lbf-in-slinch-s': 'lbf*in' };

/** Voxel count above which a study is refused (provisional: the per-device DOF cap is set from the VC-TOP-34 measurements). */
export const TOPOLOGY_VOXEL_CAP = 4_000_000;
/** History rows kept in a recorded summary. */
export const HISTORY_ROW_CAP = 1000;
/** A minimum member size below this many voxels cannot be resolved by the grid (the filter radius would fall below one voxel). */
export const MIN_MEMBER_VOXELS = 2;

const CALIBRATE = 'llull choice (to calibrate on the production scenario, spec section 11)';
export const IOU_TARGET: NamedValue = { value: 0.85, source: CALIBRATE, defaulted: true };
export const COMPLIANCE_RATIO_TARGET: NamedValue = { value: 1.15, source: CALIBRATE, defaulted: true };
/** Douglas-Peucker tolerance default is one voxel; the minimum loop area default is 4 voxel^2 (TR-TOP-09). */
export const MIN_LOOP_AREA_VOXELS = 4;

const named = (value: number, source: string): NamedValue => ({ value, source, defaulted: true });
const ANDREASSEN = 'Andreassen et al. 2011 (top88) default';
const PROJECTION_SOURCE = 'llull choice (Wang, Lazarov & Sigmund 2011 practice: beta doubled every 50 iterations or on convergence)';

/** Default Heaviside projection: β 1 → 16 doubling every 50 iterations, threshold η = 0.5. */
export const defaultProjection = (): TopologyProjection => ({
  beta: named(16, PROJECTION_SOURCE),
  eta: named(0.5, 'Guest et al. 2004 (volume-preserving threshold)'),
  betaStart: named(1, PROJECTION_SOURCE),
  betaEvery: named(50, PROJECTION_SOURCE),
});

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
