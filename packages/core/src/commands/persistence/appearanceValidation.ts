/** Load-time validation of appearance data (RV1 RV-M1): the `appearance` slice, material / entity appearances, mesh uvs / normals. */

import { TEXTURE_FORMATS, TEXTURE_MAX_DIMENSION, TEXTURE_MEMORY_BUDGET_BYTES, textureMemoryBytes } from '../../model/appearance';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isHexColor } from '../../lib/isHexColor';
import { isRecord } from '../../lib/isRecord';
import { isReservedKey } from '../../lib/reservedKey';

const KEY = /^[0-9a-f]{64}$/;
const SURFACE_TEXTURE_FIELDS = ['baseColor', 'metalness', 'roughness', 'emission', 'transmission', 'coat'] as const;

const inRange = (x: unknown, min: number, max: number): boolean => isFiniteNumber(x) && x >= min && x <= max;

function channelProblem(where: string, channel: unknown, color: boolean, max: number): string | null {
  if (!isRecord(channel)) return `${where} must be { value?, texture? }`;
  const { value, texture } = channel;
  if (value === undefined && texture === undefined) return `${where} needs a value or a texture`;
  if (value !== undefined && (color ? !isHexColor(value) : !inRange(value, 0, max)))
    return `${where}.value is not ${color ? 'a #rrggbb colour' : `a number in [0, ${max}]`}`;
  if (texture !== undefined && typeof texture !== 'string') return `${where}.texture must be a texture id`;
  return null;
}

/** First structural problem of an `Appearance` value (`where` names it in the message), or null. Texture existence is `appearanceProblems`. */
export function appearanceShapeProblem(where: string, value: unknown): string | null {
  if (!isRecord(value)) return `${where} must be an object`;
  for (const name of SURFACE_TEXTURE_FIELDS) {
    if (value[name] === undefined) continue;
    const isColor = name === 'baseColor' || name === 'emission';
    const problem = channelProblem(`${where}.${name}`, value[name], isColor, 1);
    if (problem !== null) return problem;
  }
  const normal = value['normal'];
  if (
    normal !== undefined &&
    (!isRecord(normal) ||
      typeof normal['texture'] !== 'string' ||
      (normal['normalScale'] !== undefined && !inRange(normal['normalScale'], 0, 4)))
  )
    return `${where}.normal must be { texture, normalScale? in [0, 4] }`;
  if (value['emissionStrength'] !== undefined && !(isFiniteNumber(value['emissionStrength']) && value['emissionStrength'] >= 0))
    return `${where}.emissionStrength must be finite and >= 0`;
  if (value['ior'] !== undefined && !inRange(value['ior'], 1, 3)) return `${where}.ior must be in [1, 3]`;
  if (value['coatRoughness'] !== undefined && !inRange(value['coatRoughness'], 0, 1)) return `${where}.coatRoughness must be in [0, 1]`;
  if (value['uvScale'] !== undefined && !(isFiniteNumber(value['uvScale']) && value['uvScale'] > 0))
    return `${where}.uvScale must be finite and > 0`;
  if (value['libraryId'] !== undefined && typeof value['libraryId'] !== 'string') return `${where}.libraryId must be a string`;
  return null;
}

function textureIdsOf(appearance: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const name of SURFACE_TEXTURE_FIELDS) {
    const channel = appearance[name];
    if (isRecord(channel) && typeof channel['texture'] === 'string') ids.push(channel['texture']);
  }
  const normal = appearance['normal'];
  if (isRecord(normal) && typeof normal['texture'] === 'string') ids.push(normal['texture']);
  return ids;
}

/** `uvs` (2 per vertex) and `normals` (3 per vertex) of a mesh must have the length the vertex count gives, or null. */
export function meshAttributeProblem(mesh: Record<string, unknown>, vertexCount: number): string | null {
  const { uvs, normals } = mesh;
  if (uvs !== undefined && !(Array.isArray(uvs) && uvs.length === vertexCount * 2 && uvs.every(isFiniteNumber)))
    return `mesh.uvs must be 2 finite numbers per vertex (${vertexCount * 2})`;
  if (normals !== undefined && !(Array.isArray(normals) && normals.length === vertexCount * 3 && normals.every(isFiniteNumber)))
    return `mesh.normals must be 3 finite numbers per vertex (${vertexCount * 3})`;
  return null;
}

function textureProblem(id: string, value: unknown): string | null {
  const where = `appearance.textures['${id}']`;
  if (isReservedKey(id)) return `appearance.textures: id '${id}' is a reserved JavaScript property name`;
  if (!isRecord(value) || value['id'] !== id) return `${where} must be an object whose id is '${id}'`;
  const { name, key, format, width, height, bytes, colorSpace } = value;
  if (typeof name !== 'string' || typeof key !== 'string' || !KEY.test(key))
    return `${where}: name must be a string and key 64 lowercase hex`;
  if (!(TEXTURE_FORMATS as readonly unknown[]).includes(format)) return `${where}: format must be one of ${TEXTURE_FORMATS.join(', ')}`;
  const sizeOk = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= TEXTURE_MAX_DIMENSION;
  if (!sizeOk(width) || !sizeOk(height)) return `${where}: width and height must be integers in [1, ${TEXTURE_MAX_DIMENSION}]`;
  if (!(Number.isInteger(bytes) && (bytes as number) >= 0)) return `${where}: bytes must be a non-negative integer`;
  if (colorSpace !== 'srgb' && colorSpace !== 'linear') return `${where}: colorSpace must be srgb or linear`;
  return null;
}

function environmentProblem(environment: unknown, textures: Record<string, unknown>): string | null {
  if (!isRecord(environment)) return 'appearance.environment must be an object';
  if (!(isFiniteNumber(environment['intensity']) && environment['intensity'] >= 0))
    return 'appearance.environment.intensity must be finite and >= 0';
  switch (environment['source']) {
    case 'sky':
      return inRange(environment['turbidity'], 1.7, 10) ? null : 'appearance.environment.turbidity must be in [1.7, 10]';
    case 'color':
      return isHexColor(environment['color']) ? null : 'appearance.environment.color must be #rrggbb';
    case 'hdr': {
      const texture =
        typeof environment['texture'] === 'string' && Object.hasOwn(textures, environment['texture'])
          ? textures[environment['texture']]
          : undefined;
      if (!isRecord(texture) || texture['format'] !== 'hdr') return 'appearance.environment.texture must name an hdr texture of the slice';
      return isFiniteNumber(environment['rotation']) ? null : 'appearance.environment.rotation must be finite';
    }
    default:
      return "appearance.environment.source must be 'sky', 'hdr' or 'color'";
  }
}

function sliceProblem(slice: Record<string, unknown>): string | null {
  const { textures, textureOrder, environment } = slice;
  if (!isRecord(textures) || !Array.isArray(textureOrder)) return 'appearance must be { textures, textureOrder, environment? }';
  let bytes = 0;
  for (const [id, texture] of Object.entries(textures)) {
    const problem = textureProblem(id, texture);
    if (problem !== null) return problem;
    bytes += textureMemoryBytes(texture as Parameters<typeof textureMemoryBytes>[0]);
  }
  if (bytes > TEXTURE_MEMORY_BUDGET_BYTES)
    return `appearance textures need ${bytes} decoded bytes, over the ${TEXTURE_MEMORY_BUDGET_BYTES} budget`;
  const listed = new Set(textureOrder);
  if (
    listed.size !== textureOrder.length ||
    textureOrder.length !== Object.keys(textures).length ||
    !Object.keys(textures).every((id) => listed.has(id))
  )
    return 'appearance.textureOrder must list every texture id exactly once';
  return environment === undefined ? null : environmentProblem(environment, textures);
}

/** Problems of the `appearance` slice plus the texture references of every material and entity appearance in `doc` (a raw saved document). */
export function appearanceProblems(doc: Record<string, unknown>): string[] {
  const slice = doc['appearance'];
  const errors: string[] = [];
  if (slice !== undefined) {
    if (!isRecord(slice)) return ['appearance must be an object'];
    const problem = sliceProblem(slice);
    if (problem !== null) return [problem];
  }
  const textures = isRecord(slice) && isRecord(slice['textures']) ? slice['textures'] : {};
  const check = (where: string, appearance: unknown): void => {
    if (!isRecord(appearance)) return;
    for (const id of textureIdsOf(appearance)) {
      const texture = Object.hasOwn(textures, id) ? textures[id] : undefined;
      if (!isRecord(texture)) errors.push(`${where} references unknown texture '${id}'`);
      else if (texture['format'] === 'hdr') errors.push(`${where} uses hdr texture '${id}' as a surface map`);
    }
  };
  for (const [name, material] of Object.entries(isRecord(doc['materials']) ? doc['materials'] : {}))
    if (isRecord(material)) check(`material '${name}'.appearance`, material['appearance']);
  for (const [id, entity] of Object.entries(isRecord(doc['entities']) ? doc['entities'] : {}))
    if (isRecord(entity)) check(`entity '${id}'.appearance`, entity['appearance']);
  return errors;
}
