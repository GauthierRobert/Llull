/** Human deviations on check_space_environment findings (PHY-14 FR-ENV-13, TR-ENV-10): the signed act, the finding fingerprint and the annotation of items. */

import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { type DeviationState, deviationState } from './gate';
import type { OutgassingItem } from './outgassing';
import type { Deviation } from './types';

/** The item key an agent passes to approve_environment_deviation. */
const itemKeyOf = (item: Pick<OutgassingItem, 'material' | 'quantity'>): string => `outgassing:${item.material}|${item.quantity}`;

/** Hash of the finding (key, profile, status, code, value, limit): a deviation applies only while it matches. */
const fingerprintOf = (item: OutgassingItem, profileId: string): string =>
  sha256Hex(
    jcsJson({
      key: itemKeyOf(item),
      profile: profileId,
      status: item.status,
      code: item.code ?? '',
      value: item.value,
      op: item.op,
      limit: item.limit,
    }),
  );

/** An outgassing item with its identity, fingerprint and the state of any stored deviation. */
export interface ReviewedItem extends OutgassingItem {
  readonly key: string;
  readonly fingerprint: string;
  /** A confirmed (re-verified) human deviation covering this finding. */
  readonly deviation?: { readonly decision: Deviation['decision']; readonly signer: string; readonly signatureId: string };
  /** A stored deviation of an earlier finding (the value or limit changed): it no longer applies. */
  readonly staleDeviation?: true;
  /** A stored deviation that does not count: its signature does not verify for this document, or no port can confirm it. */
  readonly unconfirmedDeviation?: Exclude<DeviationState, 'ok'>;
}

/** Adds key, fingerprint and the deviation state to each item; a deviation counts only when its signature re-verifies for this document. */
export function reviewItems(
  doc: CadDocument,
  port: HumanSignaturePort | null,
  items: readonly OutgassingItem[],
  profileId: string,
  deviations: Readonly<Record<string, Deviation>>,
): ReviewedItem[] {
  return items.map((item): ReviewedItem => {
    const key = itemKeyOf(item);
    const fingerprint = fingerprintOf(item, profileId);
    const stored = Object.hasOwn(deviations, key) ? deviations[key] : undefined;
    const current = stored !== undefined && stored.fingerprint === fingerprint;
    const state = stored !== undefined && current ? deviationState(doc, port, key, stored) : undefined;
    return {
      ...item,
      key,
      fingerprint,
      ...(stored !== undefined && state === 'ok'
        ? { deviation: { decision: stored.decision, signer: stored.signer, signatureId: stored.signatureId } }
        : {}),
      ...(stored !== undefined && !current ? { staleDeviation: true as const } : {}),
      ...(state !== undefined && state !== 'ok' ? { unconfirmedDeviation: state } : {}),
    };
  });
}

/** Whether a confirmed human decision "accepted" covers the item: it then leaves the status (the item itself is unchanged). */
export const covered = (item: ReviewedItem): boolean => item.deviation?.decision === 'accepted';
