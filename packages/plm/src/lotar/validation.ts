/**
 * LOTAR validation properties (M6, EN 9300 archive package): the figures stored with an archived definition so that, decades later, a re-derivation from the archived content
 * can be compared with what was true at archive time (the principle of the CAx-IF geometric validation properties: volume, area, centroid per solid, plus counts of what
 * the definition holds).
 */

import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { type CadDocument, createEmptyDocument, is3D } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

interface SolidValidation {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** How `mass_properties` computed it: exact, closed-form or mesh. */
  readonly method: string;
  readonly volume: number | null;
  readonly area: number | null;
  readonly centroid: readonly [number, number, number] | null;
}

export interface ValidationProperties {
  readonly schema: 'llull-validation-1';
  readonly unit: string;
  readonly counts: {
    readonly entities: number;
    readonly solids: number;
    readonly components: number;
    readonly sheets: number;
    readonly pmiItems: number;
  };
  readonly solids: readonly SolidValidation[];
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function centroidOf(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = [finite(value[0]), finite(value[1]), finite(value[2])];
  return x === null || y === null || z === null ? null : [x, y, z];
}

/** Volume, area and centroid of every 3D entity of `doc` (those `mass_properties` cannot measure keep null figures), with counts of what the definition holds. */
export function validationPropertiesOf(doc: CadDocument): ValidationProperties {
  const solids = doc.order.flatMap((id): SolidValidation[] => {
    const entity = doc.entities[id];
    if (entity === undefined || !is3D(entity)) return [];
    const data: unknown = execute(doc, 'mass_properties', { entityId: id }).data;
    // A figure computed from a display mesh (data.lodOnly) is not archived: it would be compared with later as if it were measured.
    const record = isRecord(data) && !(Array.isArray(data['lodOnly']) && data['lodOnly'].length > 0) ? data : {};
    return [
      {
        id,
        name: entity.name ?? id,
        kind: entity.kind,
        method: typeof record['method'] === 'string' ? record['method'] : 'unmeasured',
        volume: finite(record['volume']),
        area: finite(record['area']),
        centroid: centroidOf(record['centroid']),
      },
    ];
  });
  return {
    schema: 'llull-validation-1',
    unit: doc.units,
    counts: {
      entities: doc.order.length,
      solids: solids.length,
      components: Object.keys(doc.components).length,
      sheets: doc.drawings?.order.length ?? 0,
      pmiItems: Object.keys(doc.pmi?.items ?? {}).length,
    },
    solids,
  };
}

const close = (a: number | null, b: number | null, relative: number): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= relative * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * The differences between archived validation properties and a re-derivation, as human-readable findings (empty = they agree). Figures agree within `relative`
 * (default 1e-6) when computed by the same method, within 1e-3 when the method changed (exact vs closed-form vs mesh differ by their own error); counts must be equal.
 */
export function compareValidation(archived: ValidationProperties, rederived: ValidationProperties, relative = 1e-6): string[] {
  const findings: string[] = [];
  if (archived.unit !== rederived.unit) findings.push(`unit: archived ${archived.unit}, re-derived ${rederived.unit}`);
  for (const key of Object.keys(archived.counts) as (keyof ValidationProperties['counts'])[])
    if (archived.counts[key] !== rederived.counts[key])
      findings.push(`count ${key}: archived ${archived.counts[key]}, re-derived ${rederived.counts[key]}`);
  for (const was of archived.solids) {
    const now = rederived.solids.find((solid) => solid.id === was.id);
    if (now === undefined) {
      findings.push(`solid ${was.id} is not in the re-derivation`);
      continue;
    }
    const tolerance = was.method === now.method ? relative : Math.max(relative, 1e-3);
    if (!close(was.volume, now.volume, tolerance))
      findings.push(`solid ${was.id} volume: archived ${was.volume}, re-derived ${now.volume}`);
    if (!close(was.area, now.area, tolerance)) findings.push(`solid ${was.id} area: archived ${was.area}, re-derived ${now.area}`);
    for (let axis = 0; axis < 3; axis += 1)
      if (!close(was.centroid?.[axis] ?? null, now.centroid?.[axis] ?? null, tolerance))
        findings.push(`solid ${was.id} centroid[${axis}]: archived ${was.centroid?.[axis]}, re-derived ${now.centroid?.[axis]}`);
  }
  for (const now of rederived.solids)
    if (!archived.solids.some((solid) => solid.id === now.id)) findings.push(`solid ${now.id} is not in the archive`);
  return findings;
}

/** The document of a canonical snapshot text (a release snapshot is the release scope; view state is filled with defaults), or null when it does not load. */
export function documentOfSnapshot(snapshotJson: string): CadDocument | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(snapshotJson);
  } catch {
    return null;
  }
  if (!isRecord(envelope) || !isRecord(envelope['document'])) return null;
  const json = JSON.stringify({ ...envelope, document: { ...envelope['document'], selection: [], camera: createEmptyDocument().camera } });
  const loaded: CommandResult = execute(createEmptyDocument(), 'load_document', { json });
  return loaded.rejected === true ? null : loaded.document;
}
