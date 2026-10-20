/** Stable `SCN_*` codes of the scan plugin with their one-line remediation (plant 10 TECHNICAL_SPEC §7.2, FR-SCN-21). */

import { tableRejection } from '@core/commands/noop';

export const SCAN_REMEDIATION: Readonly<Record<string, string>> = {
  SCN_ASSET_MISSING: 'Run `llull scan import <file>` on this machine (the asset key must be in the local store).',
  SCN_ASSET_UNAVAILABLE: 'Run on the desktop app or the llull CLI / server, which install the point-cloud port.',
  SCN_CLOUD_NOT_FOUND: 'List the attached clouds with describe_point_cloud or describe_scene; attach one with attach_point_cloud.',
  SCN_CLOUD_DUPLICATE: 'Use the existing cloud id; one asset is attached once.',
  SCN_CRS_NO_CALIBRATION: 'Call set_site_calibration first, or attach with placement "local".',
  SCN_CROP_INVALID: 'Give min < max on every axis (document units).',
  SCN_CROP_NOT_FOUND: 'List crops with describe_point_cloud; create one with set_scan_crop.',
  SCN_QUERY_LIMIT: 'Narrow the region or lower maxPoints and page.',
  SCN_FIT_TOO_FEW_POINTS: 'Enlarge the region (it must hold at least 30 points for a cylinder, 10 for a plane / sphere / circle).',
  SCN_FIT_NO_MODEL: 'Tighten the region around one object.',
  SCN_REG_TARGETS_INSUFFICIENT: 'Add targets (at least 3 non-collinear pairs) or use ICP with an initial transform.',
  SCN_REG_DEGENERATE: 'Use targets that span a plane (not collinear, not coincident).',
  SCN_REG_TARGET_NOT_FOUND: 'Move the seed onto the target (a sphere within 2 radii of the seed).',
  SCN_REG_NOT_CONVERGED: 'Give an initial transform (from targets) or a region with a larger overlap.',
  SCN_REG_NOT_RIGID: 'Pass the record from compute_registration unchanged.',
  SCN_REG_NOT_FOUND: 'List registrations with check_point_clouds or describe_point_cloud.',
  SCN_REG_SAME_CLOUD: 'Register two different clouds.',
  SCN_EXTRACTION_TAMPERED: 'Commit the extraction exactly as returned by the query (fit_primitive / extract_pipes).',
  SCN_EXTRACTION_NOT_FOUND: 'List extractions with check_point_clouds.',
  SCN_EXTRACTION_DUPLICATE: 'This extraction is already committed; use the existing pipe run.',
  SCN_HUMAN_GATE: 'A qualified reviewer must sign in the desktop app; an agent cannot accept.',
  SCN_ENTITY_UNSUPPORTED: 'Pass pipe runs, boxes, cylinders, spheres or meshed solids.',
  SCN_ENTITY_NOT_FOUND: 'Pass entity ids from describe_scene or pipe-run ids (affected[0] of add_pipe_run).',
  SCN_REGISTRATION_UNVERIFIED: 'Ask a reviewer to accept_registration, or register with targets / ICP.',
  SCN_CLOUD_UNREGISTERED: 'Register the stations with compute_registration + apply_registration, or mark_registration_supplied.',
  SCN_EXTRACTION_STALE: 'Re-run the fit on the moved cloud and commit again.',
  SCN_EXTRACTION_UNVERIFIED: 'Field-verify the run, add a scan from another side, or accept the registration.',
  SCN_REVIEW_REQUIRED: 'A qualified reviewer must accept the extraction before fabrication (accept_asbuilt_extraction).',
  SCN_CLASH_FOUND: 'Re-route the line or field-verify the clash.',
  SCN_CLEARANCE_VIOLATION: 'Re-route or have a reviewer accept the reduced clearance.',
  SCN_PARAM_INVALID: 'Check the parameter against `llull describe <command>`.',
  NATIVE_TOOL_MISSING: 'Install the desktop app (it bundles llull-compute) or build solver/ (cargo build --release).',
};

/** "<command>: <code> — <message>; no-op." with the code's remediation. */
export const refuseScan = tableRejection(SCAN_REMEDIATION);
