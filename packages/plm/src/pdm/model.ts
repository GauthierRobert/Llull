/** What the PDM export says about one revision, as plain data: built from `doc.plm`, written to Part 21 (`write.ts`), read back from it (`read.ts`) and compared. */

import type { LifecycleState, PlmModel, Revision } from '@core/model/plm';
import type { CadDocument } from '@core/model/types';
import { liveStructure } from '../structure';
import { isoOf, parseInstant } from './part21';

export type ApprovalStatus = 'approved' | 'not yet approved' | 'disapproved' | 'withdrawn';

export interface PdmSignature {
  readonly keyId: string;
  readonly publicKey: string;
  readonly meaning: string;
  readonly signerId: string;
  readonly signedAt: string;
  readonly target: string;
  readonly signedSha256: string;
  readonly signature: string;
}

export interface PdmUnitEffectivity {
  readonly kind: string;
  readonly from: string;
  readonly to: string | null;
}

export interface PdmModel {
  readonly organization: { readonly id: string; readonly name: string };
  readonly partNumber: string;
  readonly name: string;
  readonly category: 'assembly' | 'detail';
  /** Revision labels in order up to and including the exported one (the version history). */
  readonly revisions: readonly string[];
  readonly revision: string;
  /** Why this version exists (the change order id), or null. */
  readonly reason: string | null;
  readonly state: LifecycleState;
  readonly approvalStatus: ApprovalStatus;
  readonly approvals: readonly { readonly role: string; readonly userId: string; readonly at: string | null }[];
  readonly release: { readonly by: string; readonly at: string | null } | null;
  readonly marking: { readonly regime: string; readonly statement: string | null };
  /** Date-range effectivity as ISO dates (general validity period); serial / msn / lot ranges travel as an llull property (the practice has no place for them here). */
  readonly dateEffectivity: readonly { readonly from: string; readonly to: string | null }[];
  readonly unitEffectivity: readonly PdmUnitEffectivity[];
  readonly structure: readonly {
    readonly partNumber: string;
    readonly name: string;
    readonly revision: string;
    readonly quantity: number;
  }[];
  readonly mbom: { readonly id: string; readonly name: string; readonly lines: PdmModel['structure'] } | null;
  readonly signatures: readonly PdmSignature[];
  readonly integrity: { readonly contentHash: string | null; readonly packageSha256: string | null };
}

const STATUS: Readonly<Record<LifecycleState, ApprovalStatus>> = {
  in_work: 'not yet approved',
  in_review: 'not yet approved',
  released: 'approved',
  superseded: 'approved',
  obsolete: 'withdrawn',
  cancelled: 'disapproved',
};

/** An instant as the file stores it: seconds precision, UTC; null when `at` is absent or not ISO. */
const instantText = (at: string | undefined): string | null => {
  const parsed = at === undefined ? null : parseInstant(at);
  return parsed === null ? null : isoOf(parsed, false);
};

const dateText = (value: number | string): string | null => {
  const parsed = typeof value === 'string' ? parseInstant(value) : null;
  return parsed === null ? null : isoOf(parsed, true);
};

export interface PdmOptions {
  readonly organization: { readonly id: string; readonly name: string };
  readonly mbom?: string;
}

/** The PDM view of revision `label` of the managed item (a frozen revision reads its frozen structure, effectivity and marking); a reason string when `label` or the mbom is unknown. */
export function pdmModelOf(doc: CadDocument, plm: PlmModel, label: string, options: PdmOptions): PdmModel | string {
  const revision: Revision | undefined = plm.item.revisions[label];
  if (revision === undefined) return `${plm.item.partNumber} has no revision '${label}'`;
  const nameOf = (partNumber: string): string => plm.subItems?.[partNumber]?.name ?? partNumber;
  const rows = revision.releasedStructure ?? (label === plm.item.currentRevision ? liveStructure(doc, plm) : []);
  const structure = rows
    .filter((row) => row.quantity > 0)
    .map((row) => ({ partNumber: row.partNumber, name: nameOf(row.partNumber), revision: row.revision, quantity: row.quantity }));
  const mbomRecord = options.mbom === undefined ? undefined : plm.mbom?.[options.mbom];
  if (options.mbom !== undefined && mbomRecord === undefined) return `no manufacturing BOM '${options.mbom}'`;
  const marking = revision.releasedMarking ?? plm.item.marking;
  const ranges = revision.releasedEffectivity ?? revision.effectivity;
  const dates = ranges.filter(
    (range) => range.kind === 'date' && dateText(range.from) !== null && (range.to === undefined || dateText(range.to) !== null),
  );
  const upTo = plm.item.revisionOrder.slice(0, plm.item.revisionOrder.indexOf(label) + 1);
  return {
    organization: options.organization,
    partNumber: plm.item.partNumber,
    name: plm.item.name,
    category: plm.item.itemType === 'assembly' ? 'assembly' : 'detail',
    revisions: upTo,
    revision: label,
    reason: revision.changeOrder ?? null,
    state: revision.state,
    approvalStatus: STATUS[revision.state],
    approvals: revision.approvals.map((approval) => ({ role: approval.role, userId: approval.userId, at: instantText(approval.at) })),
    release: revision.releasedBy === undefined ? null : { by: revision.releasedBy, at: instantText(revision.releasedAt) },
    marking: { regime: marking.regime, statement: marking.statement ?? null },
    dateEffectivity: dates.map((range) => ({ from: dateText(range.from) ?? '', to: range.to === undefined ? null : dateText(range.to) })),
    unitEffectivity: ranges
      .filter((range) => !dates.includes(range))
      .map((range) => ({ kind: range.kind, from: String(range.from), to: range.to === undefined ? null : String(range.to) })),
    structure,
    mbom:
      mbomRecord === undefined
        ? null
        : {
            id: mbomRecord.id,
            name: mbomRecord.name,
            lines: mbomRecord.lines.map((line) => ({
              partNumber: line.partNumber,
              name: line.name ?? nameOf(line.partNumber),
              revision: line.revision,
              quantity: line.quantity,
            })),
          },
    signatures: revision.signatures.map((signature) => ({
      keyId: signature.keyId,
      publicKey: signature.publicKey,
      meaning: signature.meaning,
      signerId: signature.signer.userId,
      signedAt: instantText(signature.signedAt) ?? signature.signedAt,
      target: `${signature.target.kind}:${signature.target.ref}`,
      signedSha256: signature.signedSha256,
      signature: signature.signature,
    })),
    integrity: { contentHash: revision.contentHash ?? null, packageSha256: revision.packageSha256 ?? null },
  };
}
