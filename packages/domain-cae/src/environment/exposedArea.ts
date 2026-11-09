/** Exposed area from face ids (PHY-14 M3): the areas of the named faces from `inspect_faces` (exact kernel), summed once per face, in cm^2. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { convertValue, isUnitFailure } from '@lib/quantity';

export interface ExposedFaces {
  readonly entityId: string;
  readonly faces: readonly number[];
}

export interface ExposedArea {
  readonly areaCm2: number;
  /** One text line per entity: faces and their summed area. */
  readonly detail: string;
}

export interface ExposedAreaRefusal {
  readonly code: string;
  readonly message: string;
}

/**
 * Total area of the named faces of the named solids. A face listed twice counts once.
 * @failure no exact kernel / unknown entity / face index out of range -> the inspect_faces code (KRN_NO_EXACT_KERNEL, ENTITY_NOT_FOUND, KRN_FACE_INDEX); an empty face list or a face without an area -> ENV_PARAM_INVALID
 */
export function exposedAreaCm2(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  exposed: readonly ExposedFaces[],
): ExposedArea | ExposedAreaRefusal {
  const scale = convertValue(1, `${doc.units}^2`, 'cm^2');
  if (isUnitFailure(scale)) return { code: 'ENV_PARAM_INVALID', message: `document unit '${doc.units}' has no area conversion` };
  let total = 0;
  const lines: string[] = [];
  for (const { entityId, faces } of exposed) {
    const unique = [...new Set(faces)];
    if (unique.length === 0) return { code: 'ENV_PARAM_INVALID', message: `exposedFaces for '${entityId}' lists no face` };
    const result = execute(doc, 'inspect_faces', { entityId, faces: unique }, ctx);
    if (result.error !== undefined) return { code: result.error.code, message: result.summary };
    const data: unknown = result.data;
    const list = isRecord(data) && Array.isArray(data['faces']) ? data['faces'] : [];
    const areas = list.flatMap((face) =>
      isRecord(face) && typeof face['area'] === 'number' && Number.isFinite(face['area']) ? [face['area']] : [],
    );
    if (areas.length !== unique.length)
      return {
        code: 'ENV_PARAM_INVALID',
        message: `inspect_faces gave ${areas.length} area(s) for ${unique.length} face(s) of '${entityId}'`,
      };
    const sum = areas.reduce((a, b) => a + b, 0) * scale.value;
    total += sum;
    lines.push(`${entityId} faces ${unique.join(',')}: ${sum.toPrecision(9)} cm^2`);
  }
  return { areaCm2: total, detail: lines.join('; ') };
}
