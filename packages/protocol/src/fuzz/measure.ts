/**
 * Read-only measurement of the fuzz bodies through registry query commands: `check_assembly` (kernel validity + kernel volume per part)
 * and `mass_properties` (finite, positive volume). The kernel volume is the one compared across steps: it is the same faceting on a
 * mesh kernel before and after a step, where a closed-form primitive volume would not be.
 */

import { is3D, type CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { runCommandOutcome } from '../commandOutcome';

/** check_assembly codes that mean the part is not a closed, oriented, non-empty solid (a split into lumps is allowed). */
const NOT_SOLID_CODES = new Set(['FPR_PART_INVALID', 'FPR_PART_EMPTY', 'FPR_PART_SHEET']);

export interface BodyMeasure {
  readonly id: string;
  /** Kernel volume (check_assembly part volume), else the mass_properties volume. */
  readonly volume: number;
  readonly massVolume: number | undefined;
  /** First reason it is not a valid solid, if any. */
  readonly invalid?: string;
  /** Non-fatal observations (disconnected lumps, validity not verifiable by this kernel). */
  readonly notes: readonly string[];
}

const solidIds = (doc: CadDocument): string[] =>
  Object.values(doc.entities)
    .filter((entity) => is3D(entity) && entity.kind !== 'instance')
    .map((entity) => entity.id);

function massVolume(doc: CadDocument, id: string): number | undefined {
  const { outcome } = runCommandOutcome(doc, 'mass_properties', { entityId: id });
  const volume = isRecord(outcome.data) ? outcome.data['volume'] : undefined;
  return typeof volume === 'number' ? volume : undefined;
}

interface AssemblyView {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly partVolumes: ReadonlyMap<string, number>;
}

function assemblyView(doc: CadDocument, ids: readonly string[]): AssemblyView {
  const { outcome } = runCommandOutcome(doc, 'check_assembly', { ids: [...ids], thickness: 'off', includeJoints: false });
  const data = isRecord(outcome.data) ? outcome.data : {};
  const items = Array.isArray(data['items']) ? data['items'].filter(isRecord) : [];
  const partVolumes = new Map<string, number>();
  for (const part of Array.isArray(data['parts']) ? data['parts'].filter(isRecord) : [])
    if (typeof part['id'] === 'string' && typeof part['volumeMm3'] === 'number') partVolumes.set(part['id'], part['volumeMm3']);
  return { items, partVolumes };
}

const itemIds = (item: Readonly<Record<string, unknown>>): readonly unknown[] => (Array.isArray(item['ids']) ? item['ids'] : []);

/** Measure every 3D solid of `doc` (the document unit is mm in every fuzz plan). */
export function measureBodies(doc: CadDocument): BodyMeasure[] {
  const ids = solidIds(doc);
  if (ids.length === 0) return [];
  const view = assemblyView(doc, ids);
  return ids.map((id) => {
    const mine = view.items.filter((item) => itemIds(item).includes(id));
    const bad = mine.find((item) => typeof item['code'] === 'string' && NOT_SOLID_CODES.has(item['code']));
    const notes = mine
      .map((item) => item['code'])
      .filter((code): code is string => code === 'FPR_PART_DISCONNECTED' || code === 'FPR_KERNEL_UNSUPPORTED');
    const mass = massVolume(doc, id);
    const volume = view.partVolumes.get(id) ?? mass ?? Number.NaN;
    const note = typeof bad?.['note'] === 'string' ? ` (${bad['note']})` : '';
    return { id, volume, massVolume: mass, ...(bad !== undefined ? { invalid: `${String(bad['code'])}${note}` } : {}), notes };
  });
}
