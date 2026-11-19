/** Lightning zone rows of check_bonding (PHY-15 V1, EOP_LIGHTNING_ZONE_NO_PATH): each labelled solid, the bond paths that name it, and whether it is composite. */

import type { CadDocument } from '@core/model/types';
import { COMPOSITE_TEXT } from './bondEval';
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

/** Composite when the solid's material record names a composite product form or designation (the same text heuristic as a CFRP strap). */
function isComposite(doc: CadDocument, entityId: string): boolean {
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  if (materialId === undefined || !Object.hasOwn(doc.materials, materialId)) return false;
  const record = doc.materials[materialId]?.record;
  return COMPOSITE_TEXT.test(`${record?.productForm ?? ''} ${record?.designation ?? ''}`);
}

/** One row per zone label, in label id order. */
export function zoneRows(doc: CadDocument): ZoneRow[] {
  const paths = Object.values(electroOpticalOf(doc).bondPaths);
  return Object.values(zonesOf(doc))
    .sort((a, b) => a.id.localeCompare(b.id))
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
