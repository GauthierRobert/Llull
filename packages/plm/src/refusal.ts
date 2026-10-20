/** Stable PLM refusal codes (AF-11, TECHNICAL_SPEC §7.2) with their one-line remediation, and the refusal builder every command shares. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { commandError, rejection } from '@core/commands/noop';

const REMEDIATION = {
  PLM_NOT_MANAGED: 'set_item_identity first: it makes this document a managed item.',
  PLM_PARAM_INVALID: 'Fix the parameter named in the summary.',
  PLM_LOCKED: 'Open an ECO and revise_item (in_review: reject_review first).',
  PLM_HISTORY_IMMUTABLE: 'Released history cannot change; revise the item instead.',
  PLM_RECORD_REMOVED: 'PLM data can only be replaced by load_document.',
  PLM_HUMAN_GATE: 'Ask the owner to have the responsible role do this in the desktop app.',
  PLM_SIGNATURE_REQUIRED: 'A human signs with the host keystore (Approve & sign), then record_signature.',
  PLM_SIGNATURE_INVALID: 'Re-sign the exact bytes returned by release_manifest.',
  PLM_SIGNATURE_PORT_MISSING: 'Run on the desktop or the server, which hold a signature verifier.',
  PLM_KEY_UNTRUSTED: "Register the signer's public key in the vault trust store.",
  PLM_PN_INVALID: 'Use A-Z, 0-9, . _ - / and at most 64 characters, starting with a letter or digit.',
  PLM_IDENTITY_FROZEN: 'Identity is immutable after release.',
  PLM_SCHEME_INVALID: 'Use asme-alpha, numeric-2 or custom:<name> with a list of unique labels (customLabels).',
  PLM_STATE_TRANSITION: 'Follow the lifecycle: in_work, submit_for_review, release_item; see plm_status.',
  PLM_APPROVALS_MISSING: 'record_approval (or approvals on release_item) by each missing role, as a human.',
  PLM_CHECKER_IS_AUTHOR: 'A different user must approve as checker.',
  PLM_ECO_REQUIRED: 'create_change_order listing the item, then pass it as changeOrder.',
  PLM_ECO_UNKNOWN: 'List changes with plm_status.',
  PLM_ECO_CLOSED: 'Use an open change order; list changes with plm_status.',
  PLM_CLASSIFICATION_MISSING: 'A human records minor or major with a justification on the change order.',
  PLM_EFFECTIVITY_OVERLAP: 'Start the new range after the previous one.',
  PLM_EFFECTIVITY_UNIT_TYPE: 'serial / msn: positive integer; date: YYYY-MM-DD; lot: a non-empty id.',
  PLM_MARKING_UNDECIDED: 'The export-control officer records a decision (set_item_marking, human).',
  PLM_PARAMETER_ERRORS: 'Fix the expressions (set_parameter).',
  PLM_REVISION_UNKNOWN: 'plm_status lists the revisions.',
  PLM_NOT_RELEASED: 'plm_status lists the revisions and their states.',
  PLM_NO_SNAPSHOT: 'Only released, superseded and obsolete revisions keep a snapshot; the current revision can be compared as itself.',
  PLM_INTEGRITY_MISMATCH: 'restore_revision_snapshot or open an ECO.',
  PLM_VAULT_OBJECT_MISSING:
    'Point LLULL_VAULT at the vault that holds the object (llull vault verify), or restore it from a release package.',
  PLM_CHILDREN_UNRELEASED: 'Release the children first, then bind their released revision (bind_component_item, human).',
  PLM_BASELINE_MEMBER_UNRELEASED: 'Release it or leave it out.',
  PLM_BASELINE_UNKNOWN: 'plm_status lists the baselines.',
  PLM_ID_EXISTS: 'Use another id or omit it to have one assigned.',
} as const satisfies Readonly<Record<string, string>>;

export type PlmCode = keyof typeof REMEDIATION;

/** Refuse `command` with a stable code: summary "<command> rejected: <message>", `error` carries code, ids, paths and remediation. */
export function refusePlm(
  doc: CadDocument,
  command: string,
  code: PlmCode,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  return rejection(doc, `${command} rejected: ${message}`, commandError(code, REMEDIATION[code], ids, paths));
}

export const remediationOf = (code: PlmCode): string => REMEDIATION[code];
