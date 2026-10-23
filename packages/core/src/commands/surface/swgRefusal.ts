/** Coded refusals of the SWG surface and loft commands (ruled, network, sweep surface, loft v2): stable `SWG_*` codes with their one-line fix. */

import { tableRejection } from '../noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  SWG_RULED_CURVES: 'give exactly two curve ids in curveIds, or one curveId and a point',
  SWG_NOT_DEVELOPABLE: 'use coupling arc_length or parameter; the message names where no developable ruling exists',
  SWG_FIT_TOLERANCE: 'loosen fitTolerance or simplify the curves / path',
  SWG_NETWORK_UNSORTABLE:
    'give two families of curves: every curve of one family must cross every curve of the other and no two of a family may cross',
  SWG_NETWORK_NOT_INTERSECTING: 'move the named curves so they meet within tolerance, or raise `tolerance`',
  SWG_SECTION_INVALID: 'give a non-degenerate section: a line of two distinct points, a points polyline, or a curve id',
  SWG_PATH_INVALID: 'give a spine curve (pathId) or two rails (guideIds) to derive it from',
  SWG_GUIDE_COUNT: 'give 1 or 2 rail curves in guideIds',
  SWG_GUIDE_PLANE_NO_INTERSECTION: 'extend the rail so every section plane along the path crosses it',
  SWG_GUIDE_ANCHOR_UNDEFINED:
    'give anchors: one [x, y] section-coordinate point per rail, or put the section outline through the rail at the start',
  SWG_RAIL_DEVIATION: 'raise railTolerance or simplify the rail',
  SWG_SURFACE_TOO_FAR: 'project the path onto the reference surface first, or raise the surface tolerance',
  SWG_FRAME_DEGENERATE: 'use orientation minimal, or another direction',
  SWG_LAW_INVALID: 'fix the law: finite numbers, tables with t strictly increasing from 0 to 1, expressions in t, s, L',
  SWG_LAW_NONPOSITIVE: 'keep scale, area and stretch strictly positive over the whole path',
  SWG_LAW_EXCLUSIVE: 'give one of scale / area, and one of twist / twistTurns',
  SWG_LOFT_END_CONDITION_INVALID: 'give a non-zero direction, a magnitude > 0 and a point only at the first or last section',
  SWG_LOFT_FACE_NOT_ADJACENT: 'pick the sheet the end section lies on (within the sew tolerance)',
  SWG_LOFT_COUPLING_MISMATCH: 'give one vertex list per section, the same length, each point on its section',
  SWG_LOFT_CENTERLINE_MISSES: 'move the section or extend the centreline so every section plane crosses it',
  SWG_LOFT_CLOSED_TOO_FEW: 'a closed loft needs at least 3 sections',
  SWG_PARAM_INVALID: 'give the parameters exactly as the command description states',
};

/** Coded refusal of an SWG surface / loft command: unchanged document, `SWG_*` code, ids, param paths, one-line fix. */
export const refuseSwg = tableRejection(REMEDIATION);
