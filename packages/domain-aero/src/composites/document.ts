/** `DocumentExtension` of `CadDocument.composites`: validation on load and re-derivation of the ply outlines (06 CMP §3). */

import type { DocumentExtension } from '@core/plugins/plugin';
import type { CompositesModel } from '@core/model/composites';
import { DEFAULT_LAYER_ID, type Entity } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { isVec2List } from '@lib/vec2';
import { isVec3 } from '@lib/vec3';
import { outlineEntities, outlineIdsOf } from './derive';

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): boolean => isNumber(value) && value > 0;

function tableErrors(
  slice: Record<string, unknown>,
  key: string,
  check: (id: string, value: Record<string, unknown>) => string[],
): string[] {
  const table = slice[key];
  if (!isRecord(table)) return [`composites.${key} must be an object`];
  return Object.entries(table).flatMap(([id, value]) =>
    isRecord(value) ? check(id, value) : [`composites.${key}.${id} must be an object`],
  );
}

function materialErrors(name: string, m: Record<string, unknown>): string[] {
  const at = `composites.materials.${name}`;
  const errors: string[] = [];
  if (m['name'] !== name) errors.push(`${at}.name must equal its key`);
  for (const field of ['E1', 'E2', 'G12', 'plyThickness']) if (!positive(m[field])) errors.push(`${at}.${field} must be > 0`);
  for (const field of ['G13', 'G23', 'Xt', 'Xc', 'Yt', 'Yc', 'S', 'density'])
    if (m[field] !== undefined && !positive(m[field])) errors.push(`${at}.${field} must be > 0 when given`);
  if (
    !isNumber(m['nu12']) ||
    !(positive(m['E1']) && positive(m['E2'])) ||
    !((m['nu12'] as number) ** 2 < (m['E1'] as number) / (m['E2'] as number))
  )
    errors.push(`${at}.nu12 must satisfy nu12^2 < E1/E2`);
  if (!['ud_tape', 'woven', 'core_honeycomb', 'core_foam'].includes(m['form'] as string)) errors.push(`${at}.form is unknown`);
  if (!['mean', 'b_basis', 'a_basis', 'unknown'].includes(m['basis'] as string)) errors.push(`${at}.basis is unknown`);
  if (typeof m['source'] !== 'string') errors.push(`${at}.source must be text`);
  return errors;
}

/** Value errors of the raw `composites` slice (an empty list = valid). */
export function compositesErrors(slice: unknown, entities: Record<string, unknown> | null): string[] {
  if (!isRecord(slice)) return ['composites must be an object'];
  const errors = [
    ...tableErrors(slice, 'materials', materialErrors),
    ...tableErrors(slice, 'rosettes', (id, r) =>
      [
        r['id'] !== id ? `composites.rosettes.${id}.id must equal its key` : '',
        isVec3(r['origin']) && isVec3(r['axis0']) && isVec3(r['normal']) ? '' : `composites.rosettes.${id} needs origin, axis0 and normal`,
      ].filter((e) => e !== ''),
    ),
    ...tableErrors(slice, 'parts', (id, p) => {
      const surface = p['surface'];
      const out: string[] = [];
      if (p['id'] !== id) out.push(`composites.parts.${id}.id must equal its key`);
      if (!isRecord(surface) || !['plane', 'cylinder', 'cone'].includes(surface['type'] as string))
        out.push(`composites.parts.${id}.surface.type must be plane, cylinder or cone`);
      if (!isVec2List(p['outline']) || p['outline'].length < 3)
        out.push(`composites.parts.${id}.outline must be at least 3 [x, y] vertices`);
      if (!isRecord(slice['rosettes']) || !isText(p['rosetteId']) || !Object.hasOwn(slice['rosettes'], p['rosetteId']))
        out.push(`composites.parts.${id} references a missing rosette`);
      const faces = p['toolFaces'];
      if (!Array.isArray(faces) || faces.length === 0) out.push(`composites.parts.${id}.toolFaces must list a face`);
      else if (entities !== null)
        for (const face of faces)
          if (!isRecord(face) || !isText(face['entityId']) || !Object.hasOwn(entities, face['entityId']))
            out.push(`composites.parts.${id} references a missing tool entity`);
      return out;
    }),
    ...tableErrors(slice, 'zones', (id, z) => {
      const out: string[] = [];
      if (!isRecord(slice['parts']) || !isText(z['partId']) || !Object.hasOwn(slice['parts'], z['partId']))
        out.push(`composites.zones.${id} references a missing part`);
      if (!isVec2List(z['boundary']) || z['boundary'].length < 3)
        out.push(`composites.zones.${id}.boundary must be at least 3 [x, y] vertices`);
      if (!Array.isArray(z['angles']) || z['angles'].length === 0 || !z['angles'].every(isNumber))
        out.push(`composites.zones.${id}.angles must be numbers`);
      return out;
    }),
    ...tableErrors(slice, 'plies', (id, p) => {
      const out: string[] = [];
      if (!isRecord(slice['parts']) || !isText(p['partId']) || !Object.hasOwn(slice['parts'], p['partId']))
        out.push(`composites.plies.${id} references a missing part`);
      if (!isRecord(slice['materials']) || !isText(p['materialName']) || !Object.hasOwn(slice['materials'], p['materialName']))
        out.push(`composites.plies.${id} references a missing material`);
      if (!isRecord(slice['rosettes']) || !isText(p['rosetteId']) || !Object.hasOwn(slice['rosettes'], p['rosetteId']))
        out.push(`composites.plies.${id} references a missing rosette`);
      if (!isNumber(p['orientation']) || !isNumber(p['order'])) out.push(`composites.plies.${id} needs orientation and order`);
      const boundary = p['boundary'];
      if (
        !isRecord(boundary) ||
        (boundary['kind'] !== 'whole_face' &&
          !(boundary['kind'] === 'polygons' && Array.isArray(boundary['polygons']) && boundary['polygons'].every(isVec2List)))
      )
        out.push(`composites.plies.${id}.boundary must be whole_face or polygons`);
      return out;
    }),
    ...tableErrors(slice, 'waivers', (id, w) =>
      isText(w['code']) && isText(w['reason']) && Array.isArray(w['ids']) ? [] : [`composites.waivers.${id} needs code, ids and reason`],
    ),
  ];
  const order = slice['plyOrder'];
  if (
    !Array.isArray(order) ||
    !order.every(isText) ||
    (isRecord(slice['plies']) && order.some((id) => !Object.hasOwn(slice['plies'] as object, id)))
  )
    errors.push('composites.plyOrder must list ply ids');
  return errors;
}

/** Ply outlines regenerate from the model: omitted from saved files and re-derived on load. */
export const compositesDocument: DocumentExtension = {
  validate: (raw) =>
    raw['composites'] === undefined ? [] : compositesErrors(raw['composites'], isRecord(raw['entities']) ? raw['entities'] : null),
  derivedEntityIds: (doc) =>
    new Set(Object.values(doc.composites?.plies ?? {}).flatMap((ply) => outlineIdsOf(ply, doc.composites?.parts[ply.partId]))),
  restore: (raw) => {
    const saved = raw['composites'];
    if (saved === undefined || compositesErrors(saved, null).length > 0 || !isRecord(raw['entities']) || !Array.isArray(raw['order']))
      return raw;
    const layers = isRecord(raw['layers']) ? raw['layers'] : {};
    const entities = raw['entities'];
    const layerOf = (part: { toolFaces: readonly { entityId: string }[] }): string => {
      const tool = entities[part.toolFaces[0]?.entityId ?? ''];
      const layer = isRecord(tool) && isText(tool['layerId']) ? tool['layerId'] : DEFAULT_LAYER_ID;
      return layers[layer] !== undefined ? layer : (Object.keys(layers)[0] ?? DEFAULT_LAYER_ID);
    };
    const fresh: Entity[] = outlineEntities(saved as CompositesModel, layerOf);
    return {
      ...raw,
      entities: { ...entities, ...Object.fromEntries(fresh.map((entity) => [entity.id, entity])) },
      order: [...(raw['order'] as string[]).filter((id) => !fresh.some((entity) => entity.id === id)), ...fresh.map((entity) => entity.id)],
    };
  },
};
