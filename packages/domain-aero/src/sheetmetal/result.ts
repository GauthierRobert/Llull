/** Agent-first result plumbing shared by the sheet-metal commands: refusals (AF-11) and the review/provenance meta of queries (AF-32/33/35). */

import type { CadDocument, DocumentUnit } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { commandError, rejection } from '@core/commands/noop';
import { FTR_REVIEW_REASON, type FtrCode, type FtrResultMeta, type FtrUnverifiedInput } from '@core/model/manufacturing';

/** Plain-words review note appended to the summary of every query that could support a release decision (FR-FTR-37). */
export const REVIEW_NOTE =
  'Computed by llull, not approved — a qualified person must review it before it is used for an aircraft part or repair.';

/** Refusal with a stable FTR code, the offending ids/param paths and a one-line fix; the document is returned unchanged. */
export function refuse(
  doc: CadDocument,
  command: string,
  code: FtrCode,
  why: string,
  remediation: string,
  where: { readonly ids?: readonly string[]; readonly paths?: readonly string[] } = {},
): CommandResult {
  return rejection(
    doc,
    `${command} rejected [${code}]: ${why}. ${remediation} Document unchanged.`,
    commandError(code, remediation, where.ids ?? [], where.paths ?? []),
  );
}

export interface MetaInput {
  readonly lengthUnit: DocumentUnit;
  readonly unverifiedInputs: readonly FtrUnverifiedInput[];
  readonly formulas: Readonly<Record<string, string>>;
  readonly inputs: FtrResultMeta['provenance']['inputs'];
  readonly sources: readonly string[];
}

/** `FtrResultMeta` of a query; `unverified` is the OR over its unverified inputs (TR-FTR-06). */
export function resultMeta(input: MetaInput): FtrResultMeta {
  const seen = new Set<string>();
  const unverifiedInputs = input.unverifiedInputs.filter((entry) => {
    const key = `${entry.kind}:${entry.id}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return {
    lengthUnit: input.lengthUnit,
    angleUnit: 'deg',
    unverified: unverifiedInputs.length > 0,
    unverifiedInputs,
    reviewRequired: true,
    reviewReason: FTR_REVIEW_REASON,
    provenance: { formulas: input.formulas, inputs: input.inputs, sources: [...new Set(input.sources)] },
  };
}

/** `, N unverified input(s): …` summary fragment (empty when nothing is unverified). */
export function unverifiedNote(meta: Pick<FtrResultMeta, 'unverifiedInputs'>): string {
  return meta.unverifiedInputs.length === 0
    ? ''
    : ` UNVERIFIED inputs (${meta.unverifiedInputs.length}): ${meta.unverifiedInputs.map((entry) => `${entry.kind} ${entry.id}`).join('; ')}.`;
}

/** Rounds a length for a summary (6 significant decimals, never "-0"). */
export const fixed = (value: number): string => String(Math.round(value * 1e6) / 1e6 + 0);
