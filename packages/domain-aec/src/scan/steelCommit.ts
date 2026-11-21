/**
 * The steel branch of commit_asbuilt_extraction (TECHNICAL_SPEC §13.12): a fit_steel_member extraction becomes an as-built member through
 * add_steel_member (L10: composed with execute). The profile designation of the extraction is matched to the catalogue by `normaliseDesignation`
 * (case, whitespace, hyphens and underscores ignored: "IPE 300" = "IPE300"); an unknown designation is refused by name.
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import { nextId } from '@lib/id';
import { getBuilding, resolveLevel } from '../building/model';
import type { MemberRole } from '../building/types';
import { findProfile } from '../steel/profiles';
import { refuseScan } from './codes';
import { scanOf, fromM, withScan } from './model';
import type { ExtractionRecord } from './types';

type Vec = readonly [number, number, number];
const vec = (value: unknown): Vec | null =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number') ? (value as [number, number, number]) : null;

/** A member whose axis is within this angle of the vertical is a column by default (named, TECHNICAL_SPEC §13.12). */
const VERTICAL_COS = Math.cos((15 * Math.PI) / 180);

export interface SteelCommitInput {
  readonly command: string;
  readonly pending: Omit<ExtractionRecord, 'id' | 'createdElementIds' | 'status' | 'acceptedBy'>;
  readonly reasons: readonly string[];
  readonly role: MemberRole | undefined;
  readonly levelId: string | undefined;
}

/**
 * @failure a profile that is not in the catalogue -> SCN_STEEL_PROFILE_UNKNOWN naming it; a fit without start / end / roll / profile -> SCN_PARAM_INVALID;
 *   add_steel_member refusals are passed on
 */
export function commitSteelMember(doc: CadDocument, ctx: ExecutionContext | undefined, input: SteelCommitInput): CommandResult {
  const { command, pending, reasons, role, levelId } = input;
  const fit = pending.fit;
  const [start, end] = [vec(fit['start']), vec(fit['end'])];
  const roll = fit['roll'];
  const designation = fit['profile'];
  if (start === null || end === null || typeof roll !== 'number' || typeof designation !== 'string')
    return refuseScan(
      doc,
      command,
      'SCN_PARAM_INVALID',
      'the fit has no profile / start / end / roll (commit a fit_steel_member extraction)',
      [pending.cloudId],
      ['extraction.fit'],
    );
  const profile = findProfile(designation);
  if (profile === undefined)
    return refuseScan(
      doc,
      command,
      'SCN_STEEL_PROFILE_UNKNOWN',
      `profile '${designation}' is not in the llull steel catalogue (matched ignoring case, spaces, hyphens and underscores)`,
      [pending.cloudId],
      ['extraction.fit.profile'],
    );
  const level = resolveLevel(doc, getBuilding(doc), levelId);
  const elevation = level.ok ? level.level.elevation : 0;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const vertical = length > 0 && Math.abs(end[2] - start[2]) / length >= VERTICAL_COS;
  const id = nextId('ext');
  const at = (p: readonly [number, number, number]): number[] => [fromM(doc, p[0]), fromM(doc, p[1]), fromM(doc, p[2]) - elevation];
  const added = execute(
    doc,
    'add_steel_member',
    {
      profile: profile.name,
      start: at(start),
      end: at(end),
      roll,
      role: role ?? (vertical ? 'column' : 'beam'),
      ...(levelId !== undefined ? { levelId } : {}),
      asBuilt: { extractionId: id, unverified: reasons.length > 0 },
    },
    ctx,
  );
  if (added.affected.length === 0) return { ...added, document: doc, summary: `${command}: ${added.summary}` };
  const elements = added.document.building?.elements ?? {};
  const record: ExtractionRecord = {
    ...pending,
    unverified: reasons.length > 0,
    unverifiedReasons: [...reasons],
    id,
    createdElementIds: added.affected.filter((created) => Object.hasOwn(elements, created)),
    status: 'computed',
  };
  const after = scanOf(added.document);
  return changed(
    withScan(added.document, { ...after, extractions: { ...after.extractions, [id]: record } }),
    `Committed extraction ${id}: as-built steel member ${added.affected.join(', ')} (${profile.name}, from '${designation}')${reasons.length > 0 ? ` (unverified: ${reasons.join('; ')})` : ''}. Review before fabrication (accept_asbuilt_extraction).`,
    [id, ...added.affected],
  );
}
