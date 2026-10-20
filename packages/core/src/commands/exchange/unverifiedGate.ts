/**
 * The human gate every STEP / IGES export shares (aerospace 04 TR-XCH-26): bodies imported with a validation property that disagrees with the geometry
 * (or none to compare), and ply solids written from triangles, leave llull only with a signed `acceptUnverified` from a human.
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { exportDocumentHash } from '../../model/exportGate';
import { humanGate } from '../../model/humanGate';
import { commandError, rejection } from '../noop';
import { importedBodyStatus } from '../inspect/massReport';

/** The `acceptUnverified` parameter text every exporting command shares. */
export const ACCEPT_UNVERIFIED =
  'Human confirmation to export imported bodies whose validation properties were red or not checkable, or ply solids written from triangles (faceted): a signature object with a nonce produced in the desktop app. An agent cannot give it (XCH_HUMAN_GATE).';

export interface UnverifiedGateInput {
  /** Ids the export writes (loose solids, instances, sheets). */
  readonly entityIds: readonly string[];
  /** Ply solids written from triangles because the kernel refused their exact slab. */
  readonly faceted: readonly string[];
}

export interface GateRefusal {
  readonly code: 'XCH_UNVERIFIED_BODIES' | 'XCH_HUMAN_GATE';
  readonly message: string;
  readonly remediation: string;
  readonly ids: readonly string[];
}

/** Ids among `ids` whose import left them unverified (themselves, their component, or any component below). */
export function unverifiedIds(doc: CadDocument, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && importedBodyStatus(doc, entity)?.value === true;
  });
}

/**
 * The refusal for the export of `input` unless a human cleared `confirmation`; null when nothing needs the gate or it is cleared.
 * @invariant the signature is verified AND spent through the signing port over { command, documentHash } and the sorted ids; a port without a
 *   single-use ledger never clears it
 */
export function unverifiedGate(
  doc: CadDocument,
  input: UnverifiedGateInput,
  confirmation: unknown,
  ctx: ExecutionContext | undefined,
  command: string,
): GateRefusal | null {
  const unverified = unverifiedIds(doc, input.entityIds);
  const faceted = input.faceted.filter((id) => !unverified.includes(id));
  const ids = [...unverified, ...faceted];
  if (ids.length === 0) return null;
  const why = [
    ...(unverified.length > 0
      ? [
          `${unverified.join(', ')} ${unverified.length === 1 ? 'was' : 'were'} imported with a validation property that disagrees with the geometry or could not be checked`,
        ]
      : []),
    ...(faceted.length > 0
      ? [
          `${faceted.join(', ')} ${faceted.length === 1 ? 'is a ply solid' : 'are ply solids'} written from triangles (faceted_body: the kernel refused the exact slab)`,
        ]
      : []),
  ].join('; ');
  const handOver = 'a qualified reviewer verifies the bodies, then passes acceptUnverified with a human signature';
  if (confirmation === undefined || confirmation === false)
    return { code: 'XCH_UNVERIFIED_BODIES', message: why, remediation: handOver, ids };
  const port = ctx?.humanSignature ?? null;
  if (port !== null && port.spend === undefined)
    return {
      code: 'XCH_HUMAN_GATE',
      message: 'the signing port has no single-use ledger (spend), so the confirmation cannot be consumed',
      remediation: 'install the 09 PLM signing port',
      ids,
    };
  const outcome = humanGate(port, 'export of unverified bodies', ids, confirmation, { command, documentHash: exportDocumentHash(doc) });
  return outcome.cleared
    ? null
    : {
        code: 'XCH_HUMAN_GATE',
        message: outcome.reason,
        remediation: 'hand the prepared request to a qualified reviewer in the desktop app',
        ids,
      };
}

/** The refusal as a command result: unchanged document, no data, `error.code` XCH_*. */
export const gateResult = (doc: CadDocument, refusal: GateRefusal, command: string): CommandResult =>
  rejection(
    doc,
    `${command}: ${refusal.code} — ${refusal.message}; nothing was exported; no-op.`,
    commandError(refusal.code, refusal.remediation, refusal.ids, ['acceptUnverified']),
  );

/** Review reasons of an export that went through the gate with a human signature. */
export function acceptedReasons(doc: CadDocument, input: UnverifiedGateInput): string[] {
  return [
    ...(unverifiedIds(doc, input.entityIds).length > 0 ? ['unverified_bodies_accepted'] : []),
    ...(input.faceted.length > 0 ? ['faceted_body'] : []),
  ];
}
