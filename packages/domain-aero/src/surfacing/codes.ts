/** Stable refusal codes of the surfacing plugin (02 SRF §7.1, AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  AERO_PARAM_INVALID: 'give finite values in the documented units and ranges (see the command description)',
  AERO_NACA_DESIGNATION_UNKNOWN:
    'use a 4-digit ("0012", "2412") or 230-series 5-digit ("23012") designation; import other series as .dat with import_airfoil',
  AERO_AIRFOIL_PARSE: 'check the text is a Selig or Lednicer airfoil file (name line, then "x y" pairs); pass format explicitly',
  AERO_AIRFOIL_TE_GAP: 'use trailingEdge "keep" to accept the open trailing edge, or fix the file',
  AERO_AIRFOIL_SELF_INTERSECT:
    'fix the file (upper and lower surfaces must not cross) or pass normalize "chord" if it is a rotation artefact',
  AERO_AIRFOIL_HASH_MISMATCH:
    'the text does not match expectedSha256: re-fetch the pinned file or drop expectedSha256 (the airfoil stays unverified)',
  AERO_AIRFOIL_NOT_FOUND: 'create it first with airfoil_from_naca or import_airfoil; the id is affected[0] of that command',
  AERO_WING_NOT_FOUND: 'create it first with create_wing; the id is affected[0] of that command',
  AERO_SPAN_NOT_INCREASING: 'sort the sections by span, strictly increasing from 0 at the root',
  AERO_PLANFORM_UNDERDETERMINED: 'give exactly 3 independent planform values among semiSpan, area, aspectRatio, taper, rootChord, tipChord',
  AERO_PLANFORM_OVERDETERMINED:
    'drop the surplus value: exactly 3 independent planform values are needed, and they must not contradict each other',
  AERO_SECTIONS_INCOMPATIBLE: 'use the same trailing-edge type and the same `points` for every airfoil of one wing',
  SRF_LOFT_SECTIONS_TOO_FEW: 'give at least 2 sections',
  AERO_FS_NOT_INCREASING: 'sort the stations by fs, strictly increasing',
  SRF_CONIC_RHO_RANGE: 'use 0 < rho < 1 (0.4142 = circle, 0.5 = parabola)',
  SRF_NOT_NURBS: 'pass the id of a nurbs_curve (interpolate_curve, create_conic, create_nurbs_curve)',
  SRF_LOFT_GUIDE_MISSES_SECTION: 'snap the control curve to the section curves, list the stations along it, or raise controlTolerance',
  SRF_LOFT_GUIDE_NOT_CONTAINED: 'use fewer or better aligned control curves, or add stations where they bend',
  SRF_NURBS_INVALID: 'check the station sections: every fs and dimension must be finite',
  SRF_POINTS_INSUFFICIENT: 'give at least 2 stations',
  AERO_FRAME_NOT_ORTHONORMAL: 'use unit, mutually perpendicular, right-handed axes (default +X aft, +Y right, +Z up; wlAxis = fsAxis x blAxis)',
  AERO_BODY_NOT_FOUND: 'create it first with loft_fuselage; the id is affected[0] of that command',
  AERO_VSP_PARSE: 'pass the whole text of the .vsp3 file (OpenVSP XML), not a path',
  AERO_VSP_NO_WING: 'the file needs a wing geometry (XSec_n groups with Span, Root_Chord, Tip_Chord); list wings with the geomName error message',
  AERO_VSP_UNSUPPORTED: 'give fallbackNaca to substitute a NACA section, or import the airfoil with import_airfoil and use create_wing',
  AERO_MASTER_INCONSISTENT: 'at every station the crown WL must be above the max-breadth WL, above the keel WL, with a half breadth > 0 (or all three coincide at the apex)',
  AERO_FS_OUT_OF_RANGE: 'give an fs between the first and the last station of the body (see fuselage_section_at data.fsRange)',
};

export const refuseAero = tableRejection(REMEDIATION);
