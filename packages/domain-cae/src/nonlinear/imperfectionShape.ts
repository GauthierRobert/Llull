/** PHY-05 TR-NLS-30 geometric imperfections: limits, ordered read and the value rules of the persisted bag (no artifact access here). */

import type { NonlinearSettings } from '@core/model/analysis';
import type { Imperfection } from '@core/model/nonlinear';
import { isRecord } from '@lib/isRecord';

/** Most modes one imperfection combines, and most imperfections per case (bounded deck work, AF-12). */
export const MAX_IMPERFECTION_MODES = 20;
export const MAX_IMPERFECTIONS = 20;
/** Longest amplitudeSource text kept (a citation or rule id, not a document). */
export const MAX_SOURCE_TEXT = 500;

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const HASH = /^[0-9a-f]{64}$/;

/** The imperfections of a nonlinear set-up in order (an absent bag = none). */
export function imperfectionsOf(nonlinear: NonlinearSettings): Imperfection[] {
  const bag = nonlinear.imperfections ?? {};
  return (nonlinear.imperfectionOrder ?? []).flatMap((id) => (Object.hasOwn(bag, id) && bag[id] !== undefined ? [bag[id]] : []));
}

function modeProblems(modes: unknown, at: string): string[] {
  if (!Array.isArray(modes) || modes.length === 0 || modes.length > MAX_IMPERFECTION_MODES)
    return [`${at}: modes must be a list of 1 to ${MAX_IMPERFECTION_MODES} entries`];
  const problems: string[] = [];
  const seen = new Set<number>();
  modes.forEach((entry: unknown, index) => {
    const where = `${at}.modes[${index}]`;
    if (!isRecord(entry)) return void problems.push(`${where}: expected { mode, amplitude, factor }`);
    const { mode, amplitude, factor } = entry;
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 1 || mode > 1000)
      problems.push(`${where}: mode must be an integer 1..1000`);
    else if (seen.has(mode)) problems.push(`${where}: mode ${mode} is listed twice`);
    else seen.add(mode);
    if (typeof amplitude !== 'number' || !Number.isFinite(amplitude) || amplitude === 0)
      problems.push(`${where}: amplitude must be a finite non-zero length`);
    if (typeof factor !== 'number' || !Number.isFinite(factor)) problems.push(`${where}: factor must be finite`);
  });
  return problems;
}

/**
 * Problems of the raw `imperfections` / `imperfectionOrder` pair of a loaded `nonlinear` slice: both or neither, order and bag agree, ids are
 * their keys and not reserved names, hashes are sha256 hex, modes / amplitudes / source text in range.
 */
export function imperfectionProblems(nonlinear: Record<string, unknown>, where: string): string[] {
  const bag = nonlinear['imperfections'];
  const order = nonlinear['imperfectionOrder'];
  if (bag === undefined && order === undefined) return [];
  const at = `${where}.imperfections`;
  if (!isRecord(bag) || !Array.isArray(order) || !order.every((id): id is string => typeof id === 'string'))
    return [`${at}: expected a record and an id list (imperfectionOrder)`];
  const problems: string[] = [];
  if (order.length > MAX_IMPERFECTIONS) problems.push(`${at}: at most ${MAX_IMPERFECTIONS} imperfections`);
  if (new Set(order).size !== order.length) problems.push(`${at}: duplicate ids in imperfectionOrder`);
  const listed = new Set(order);
  for (const id of order) if (!Object.hasOwn(bag, id)) problems.push(`${at}: '${id.slice(0, 40)}' is listed but missing`);
  for (const [id, entry] of Object.entries(bag)) {
    const here = `${at} '${id.slice(0, 40)}'`;
    if (RESERVED.has(id)) problems.push(`${here}: reserved id`);
    if (!listed.has(id)) problems.push(`${here}: missing from imperfectionOrder`);
    if (!isRecord(entry) || entry['id'] !== id) {
      problems.push(`${here}: malformed (its id must equal its key)`);
      continue;
    }
    if (typeof entry['fromAnalysisId'] !== 'string' || entry['fromAnalysisId'] === '')
      problems.push(`${here}: fromAnalysisId must be text`);
    if (typeof entry['sourceResultsHash'] !== 'string' || !HASH.test(entry['sourceResultsHash']))
      problems.push(`${here}: sourceResultsHash must be a sha256 hex digest`);
    const source = entry['amplitudeSource'];
    if (typeof source !== 'string' || source.trim() === '' || source.length > MAX_SOURCE_TEXT)
      problems.push(`${here}: amplitudeSource must be non-empty text of at most ${MAX_SOURCE_TEXT} characters`);
    problems.push(...modeProblems(entry['modes'], here));
  }
  return problems;
}
