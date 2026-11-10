/** PHY-16 PRC §7.1 stable codes of the additive-build lane and their remediation texts. */

import { tableRejection } from '@core/commands/noop';
import { codeRemediation } from '../shared/codes';

const REMEDIATION: Readonly<Record<string, string>> = {
  PRC_CASE_TYPE: 'create_analysis analysisType=am_build_distortion, then am_build_setup on that case',
  PRC_SOLVER_UNSUPPORTED: 'use solver calculix (the only solver with *MODEL CHANGE layer activation)',
  PRC_BUILD_SETUP_INVALID:
    'buildDirection a unit vector, layerHeight > 0, the plate and supports parts of the case (set_part_idealization), at least one part left to build',
  PRC_BUILD_SETUP_MISSING: 'am_build_setup on the case first (build direction, plate, layer height have no default)',
  PRC_INHERENT_STRAIN_SOURCE_MISSING: 'cite where the inherent strain comes from (a calibration run, a paper, owner data) in `source`',
  PRC_INHERENT_STRAIN_INVALID: 'exx, eyy, ezz must be finite dimensionless strains with |value| < 0.1',
  PRC_INHERENT_STRAIN_MISSING:
    'set_inherent_strain on the case first (there is no default: it depends on machine, material and scan strategy)',
  PRC_INHERENT_STRAIN_UNCALIBRATED:
    'calibrate the strain against a measured coupon of the same machine / material / strategy, then set_inherent_strain with calibrated true',
  PRC_RELEASE_UNSUPPORTED:
    'give three non-collinear points of the remaining part: a statically determinate 3-2-1 support (six independent rigid-body constraints) so the released part is not singular',
  PRC_RELEASE_INVALID:
    'name the release step uniquely and list plate and / or supports to remove; supports needs supportEntityIds in am_build_setup',
  PRC_LAYER_MESH_MISMATCH: 'refine the mesh along the build direction or raise layerHeight so every layer holds an element',
  PRC_LAYERS_TOO_MANY: 'raise layerHeight: a deck holds at most 500 lumped layers (two CalculiX steps and one material per layer)',
  PRC_LOADS_UNSUPPORTED: 'delete the loads of the case: the build is driven by the inherent strain and the constraints only',
  PRC_PROBE_ON_BUILT_NODE:
    'move the probe to a node that exists from the start (the plate surface, the plate-part interface) or clamp the plate: a node added with a layer reads its displacement since its activation',
  PRC_LARGE_DEFLECTION:
    'reduce the inherent strain / part size or accept a drift: the layer activation is validated for displacements below 1 % of the part size',
  PRC_PART_NOT_BUILT: 'the case has no part besides the plate and the supports: add the part that is built layer by layer',
  PRC_RESULTS_MISSING: 'run fea_mesh then fea_solve on this case first',
};

/** Remediation of an AM code (falls back to the 05 table). */
export const prcRemediation = (code: string): string => REMEDIATION[code] ?? codeRemediation(code);

/** Coded rejection with the remediation registered for `code`. */
export const refusePrc = tableRejection(REMEDIATION, codeRemediation);
