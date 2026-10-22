/** Structural check of the v2 fields of a persisted subdivision entity (04 DIR §3.1): sharpness lists, symmetry, element ids. */

import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isRecord } from '../../lib/isRecord';

const isIndex = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
const isAxis = (value: unknown): boolean => value === 'x' || value === 'y' || value === 'z';
const isStringList = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every((s) => typeof s === 'string') && new Set(value).size === length;

/** Why the optional sharpness / symmetry fields or the element ids of a subdivision entity are malformed (null when fine). */
export function subdivisionFieldsProblem(entity: Record<string, unknown>): string | null {
  const { edgeSharpness, vertexSharpness, creaseMethod, symmetry, elementIds, vertices, faces } = entity;
  const vertexCount = Array.isArray(vertices) ? vertices.length : 0;
  if (edgeSharpness !== undefined) {
    const ok =
      Array.isArray(edgeSharpness) &&
      edgeSharpness.every((e) => isRecord(e) && isIndex(e['a']) && isIndex(e['b']) && isFiniteNumber(e['s']));
    if (!ok) return 'edgeSharpness must be { a, b, s } entries';
  }
  if (vertexSharpness !== undefined) {
    const ok = Array.isArray(vertexSharpness) && vertexSharpness.every((e) => isRecord(e) && isIndex(e['v']) && isFiniteNumber(e['s']));
    if (!ok) return 'vertexSharpness must be { v, s } entries';
  }
  if (creaseMethod !== undefined && creaseMethod !== 'uniform' && creaseMethod !== 'chaikin')
    return "creaseMethod must be 'uniform' or 'chaikin'";
  if (!isRecord(elementIds)) return 'elementIds { vertices, faces } is required';
  const faceCount = Array.isArray(faces) ? faces.length : 0;
  if (!isStringList(elementIds['vertices'], vertexCount) || !isStringList(elementIds['faces'], faceCount))
    return 'elementIds must hold one unique id per vertex and per face';
  if (symmetry !== undefined) {
    const ok =
      isRecord(symmetry) &&
      Array.isArray(symmetry['planes']) &&
      symmetry['planes'].length > 0 &&
      symmetry['planes'].every(isAxis) &&
      Array.isArray(symmetry['partners']) &&
      symmetry['partners'].length === symmetry['planes'].length &&
      symmetry['partners'].every(
        (row) => Array.isArray(row) && row.length === vertexCount && row.every((w) => isIndex(w) && (w as number) < vertexCount),
      ) &&
      isFiniteNumber(symmetry['tolerance']);
    if (!ok) return 'symmetry must be { planes, partners (one vertex map per plane), tolerance }';
  }
  return null;
}
