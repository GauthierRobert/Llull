/** Lightning zone rows of check_bonding (PHY-15 V1, EOP_LIGHTNING_ZONE_NO_PATH): each labelled solid, the bond paths that name it, and whether it is composite (a PHY-06 part's tool face, or its material record text). */

import type { CadDocument } from '@core/model/types';
import { isCompositeText } from './bondEval';
import { electroOpticalOf, zonesOf } from './model';
import type { BondPath } from './types';

export interface ZoneRow {
  readonly labelId: string;
  readonly entityId: string;
  readonly zone: string;
  readonly source: string;
  /** Bond paths whose endpoints or joint interfaces name the solid. */
  readonly bondPaths: readonly string[];
  readonly composite: boolean;
  readonly code: 'EOP_LIGHTNING_ZONE_NO_PATH' | null;
  readonly message: string | null;
}

const names = (path: BondPath, entityId: string): boolean =>
  path.from === entityId ||
  path.to === entityId ||
  path.elements.some((element) => element.kind === 'joint' && (element.interfaces?.includes(entityId) ?? false));

/** Composite when a PHY-06 composite part lays up on the solid (a tool face of a `composites.parts` entry), or when its material record names a composite product form or designation. */
function isComposite(doc: CadDocument, entityId: string): boolean {
  const laidUp = Object.values(doc.composites?.parts ?? {}).some((part) => part.toolFaces.some((face) => face.entityId === entityId));
  if (laidUp) return true;
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  if (materialId === undefined || !Object.hasOwn(doc.materials, materialId)) return false;
  const record = doc.materials[materialId]?.record;
  return isCompositeText(`${record?.productForm ?? ''} ${record?.designation ?? ''}`);
}

/** One row per zone label, in label id order (numeric: lz-9.1 before lz-10.1). */
export function zoneRows(doc: CadDocument): ZoneRow[] {
  const paths = Object.values(electroOpticalOf(doc).bondPaths);
  return Object.values(zonesOf(doc))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((label) => {
      const bondPaths = paths.filter((path) => names(path, label.entityId)).map((path) => path.id);
      const composite = isComposite(doc, label.entityId);
      const missing = composite && bondPaths.length === 0;
      return {
        labelId: label.id,
        entityId: label.entityId,
        zone: label.zone,
        source: label.source.citation,
        bondPaths,
        composite,
        code: missing ? 'EOP_LIGHTNING_ZONE_NO_PATH' : null,
        message: missing
          ? `composite solid ${label.entityId} is in lightning zone ${label.zone} but no bond path names it: add a metallic path / expanded foil and define_bond_path`
          : null,
      };
    });
}
