/** Release readiness (FR-PLM-34/35, AF-20): every reason a release would be refused, as coded findings; `release_item` refuses on the first failure. */

import type { CadDocument } from '@core/model/types';
import type { Approval, ChangeRecord, Effectivity, PlmModel, Revision } from '@plm/types';
import { closeForCutIn, effectivityProblem } from './effectivity';
import { type PlmCode, remediationOf } from './refusal';
import { currentRevisionOf, revisionText } from './state';
import { unreleasedChildren } from './structure';

export interface Finding {
  readonly code: PlmCode | 'PLM_UNVERIFIED_INPUT' | 'PLM_TITLEBLOCK_MISMATCH';
  readonly severity: 'fail' | 'warn';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

export interface ReleaseInputs {
  readonly changeOrder?: string;
  readonly effectivity?: readonly Effectivity[];
}

const finding = (code: Finding['code'], severity: Finding['severity'], message: string, ids: readonly string[] = []): Finding => ({
  code,
  severity,
  ids,
  message,
  remediation:
    code === 'PLM_UNVERIFIED_INPUT'
      ? 'Replace with verified data or accept the flag into the manifest.'
      : code === 'PLM_TITLEBLOCK_MISMATCH'
        ? 'Let the title block follow plm: clear the free text.'
        : remediationOf(code),
});

/** Users who authored the revision: whoever checkpointed it and every design-authority approver. */
const authorsOf = (revision: Revision, approvals: readonly Approval[]): Set<string> =>
  new Set([
    ...revision.iterations.flatMap((iteration) => (iteration.by !== undefined && iteration.by !== '' ? [iteration.by] : [])),
    ...approvals.filter((approval) => approval.role === 'design-authority').map((approval) => approval.userId),
  ]);

function changeOrderFindings(
  plm: PlmModel,
  revision: Revision,
  changeOrder: string | undefined,
): { findings: Finding[]; eco: ChangeRecord | undefined } {
  const pn = plm.item.partNumber;
  const everReleased = Object.values(plm.item.revisions).some((candidate) => candidate.contentHash !== undefined);
  if (changeOrder === undefined) {
    const required = plm.policy.requireChangeOrder && everReleased;
    return {
      findings: required ? [finding('PLM_ECO_REQUIRED', 'fail', `${pn} needs an open change order (policy.requireChangeOrder)`, [pn])] : [],
      eco: undefined,
    };
  }
  const eco = plm.changes[changeOrder];
  if (eco === undefined || eco.kind !== 'eco')
    return { findings: [finding('PLM_ECO_UNKNOWN', 'fail', `unknown change order '${changeOrder}'`, [changeOrder])], eco: undefined };
  if (eco.state !== 'open')
    return { findings: [finding('PLM_ECO_CLOSED', 'fail', `${changeOrder} is ${eco.state}, not open`, [changeOrder])], eco };
  if (!eco.affectedItems.includes(pn))
    return { findings: [finding('PLM_ECO_REQUIRED', 'fail', `${changeOrder} does not list ${pn}`, [changeOrder, pn])], eco };
  if (eco.purpose === 'change' && eco.classification === undefined && revision.basedOn !== undefined)
    return {
      findings: [finding('PLM_CLASSIFICATION_MISSING', 'fail', `${changeOrder} has no minor / major classification`, [changeOrder])],
      eco,
    };
  return { findings: [], eco };
}

/** Effectivity the release would set: explicit, else the ECO's plan. */
export const plannedEffectivity = (inputs: ReleaseInputs, eco: ChangeRecord | undefined): readonly Effectivity[] =>
  inputs.effectivity ?? eco?.effectivity ?? [];

/** Material records whose values are unresolved or graded C (reconstructed / unchecked) are `unverified` input (AF-33). */
export function unverifiedInScope(doc: CadDocument): { id: string; reason: string }[] {
  return Object.entries(doc.materials).flatMap(([id, material]) => {
    if (material.record?.unresolved !== undefined)
      return [{ id, reason: `material values unresolved (${material.record.unresolved.reason})` }];
    return material.grade === 'C' ? [{ id, reason: 'material source grade C (reconstructed or unchecked)' }] : [];
  });
}

/** Sheets whose free-text part number / revision disagree with the managed item. */
export function titleBlockMismatches(doc: CadDocument, plm: PlmModel): string[] {
  const label = plm.item.currentRevision;
  return (doc.drawings?.order ?? []).filter((id) => {
    const block = doc.drawings?.sheets[id]?.titleBlock;
    return (
      block !== undefined &&
      ((block.partNumber !== undefined && block.partNumber !== plm.item.partNumber) ||
        (block.revision !== undefined && block.revision !== label))
    );
  });
}

/** Every finding for releasing the current revision of `plm` with `inputs`, failures first in the order the release refuses them. */
export function releaseFindings(doc: CadDocument, plm: PlmModel, inputs: ReleaseInputs): Finding[] {
  const revision = currentRevisionOf(plm);
  const pn = plm.item.partNumber;
  if (revision === undefined) return [finding('PLM_REVISION_UNKNOWN', 'fail', `${pn} has no current revision`, [pn])];
  const found: Finding[] = [];
  if (revision.state !== 'in_review') {
    const hint = revision.state === 'in_work' ? 'submit_for_review first' : `only an in_review revision can be released`;
    found.push(finding('PLM_STATE_TRANSITION', 'fail', `${revisionText(plm)} is ${revision.state}; ${hint}`, [pn, revision.label]));
    if (revision.state !== 'in_work') return found;
  }
  const { findings: ecoFindings, eco } = changeOrderFindings(plm, revision, inputs.changeOrder);
  found.push(...ecoFindings);
  const approvals = revision.approvals;
  const missing = plm.policy.requiredApprovalRoles.filter((role) => !approvals.some((approval) => approval.role === role));
  if (missing.length > 0)
    found.push(finding('PLM_APPROVALS_MISSING', 'fail', `approvals missing for role(s): ${missing.join(', ')}`, missing));
  if (plm.policy.requireIndependentChecker) {
    const authors = authorsOf(revision, approvals);
    const same = approvals.filter((approval) => approval.role === 'checker' && authors.has(approval.userId));
    if (same.length > 0)
      found.push(
        finding(
          'PLM_CHECKER_IS_AUTHOR',
          'fail',
          'the checker must differ from the author',
          same.map((approval) => approval.userId),
        ),
      );
  }
  const ranges = plannedEffectivity(inputs, eco);
  const problem = effectivityProblem(ranges);
  if (problem !== null) found.push(finding('PLM_EFFECTIVITY_UNIT_TYPE', 'fail', problem));
  else {
    const priors = plm.item.revisionOrder.flatMap((label) => {
      const prior = plm.item.revisions[label];
      return prior !== undefined && label !== revision.label && (prior.state === 'released' || prior.state === 'superseded')
        ? [{ label, effectivity: prior.effectivity }]
        : [];
    });
    const cut = closeForCutIn(priors, ranges);
    if ('overlap' in cut) found.push(finding('PLM_EFFECTIVITY_OVERLAP', 'fail', cut.overlap));
  }
  const children = unreleasedChildren(plm);
  if (children.length > 0)
    found.push(
      finding(
        'PLM_CHILDREN_UNRELEASED',
        'fail',
        `${pn} places sub-items that are not released: ${children.map((child) => `${child} (${plm.subItems?.[child]?.state ?? '?'})`).join(', ')}`,
        children,
      ),
    );
  if (plm.policy.requireMarking && plm.item.marking.regime === 'undetermined')
    found.push(finding('PLM_MARKING_UNDECIDED', 'fail', `${pn} export marking is undetermined and policy.requireMarking is on`, [pn]));
  const iteration = `${revision.label}.${revision.iterations.length}`;
  const signed = revision.signatures.some(
    (signature) => signature.target.kind === 'iteration' && signature.target.ref === iteration && signature.meaning !== 'authorship',
  );
  if (plm.policy.humanSignatureRequired && !signed)
    found.push(
      finding(
        'PLM_SIGNATURE_REQUIRED',
        'fail',
        `${revisionText(plm)} needs a human approval signature on iteration ${iteration} (policy.humanSignatureRequired)`,
        [pn, revision.label],
      ),
    );
  const broken = Object.values(doc.parameters).filter((parameter) => parameter.error !== undefined);
  if (broken.length > 0)
    found.push(
      finding(
        'PLM_PARAMETER_ERRORS',
        'fail',
        `parameters with unresolved errors: ${broken.map((p) => p.name).join(', ')}`,
        broken.map((p) => p.name),
      ),
    );
  for (const flag of unverifiedInScope(doc)) found.push(finding('PLM_UNVERIFIED_INPUT', 'warn', `${flag.id}: ${flag.reason}`, [flag.id]));
  const sheets = titleBlockMismatches(doc, plm);
  if (sheets.length > 0)
    found.push(finding('PLM_TITLEBLOCK_MISMATCH', 'warn', `sheet title block differs from ${pn} rev ${revision.label}`, sheets));
  return found;
}
