/** The hidden `_meta` sheet of an `export_plant_data` workbook: the hash of the plant objects the sheet was exported from (staleness check of the import, §5.11). */

import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import type { PlantDataModel } from '../model';

export const META_SHEET = '_meta';

/** Hash of the plant objects (ids, tags, classes, places, values and provenance in order): any edit of a value changes it, an edit of the model geometry does not. */
export const plantDataHash = (data: PlantDataModel): string =>
  sha256Hex(canonicalJson({ objects: data.objectOrder.map((id) => data.objects[id] ?? null) }));
