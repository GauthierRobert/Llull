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
  for (const field of ['G13', 'G23', 'Xt', 'Xc', 'Yt', 'Yc', 'S', 'density', 'GIc', 'GIIc'])
    if (m[field] !== undefined && !positive(m[field])) errors.push(`${at}.${field} must be > 0 when given`);
  if (
    !isNumber(m['nu12']) ||
    !(positive(m['E1']) && positive(m['E2'])) ||
    !((m['nu12'] as number) ** 2 < (m['E1'] as number) / (m['E2'] as number))
  )
    errors.push(`${at}.nu12 must satisfy nu12^2 < E1/E2`);
  for (const field of ['alpha1', 'alpha2', 'beta1', 'beta2'])
    if (m[field] !== undefined && !isNumber(m[field])) errors.push(`${at}.${field} must be a number when given`);
  if (!['ud_tape', 'woven', 'core_honeycomb', 'core_foam'].includes(m['form'] as string)) errors.push(`${at}.form is unknown`);
  if (!['mean', 'b_basis', 'a_basis', 'unknown'].includes(m['basis'] as string)) errors.push(`${at}.basis is unknown`);
  if (typeof m['source'] !== 'string') errors.push(`${at}.source must be text`);
  return errors;
}

/** Errors of the sphere / nurbs surface records of a part (the plane / cylinder / cone records are validated by their type only). */
function surfaceErrors(at: string, surface: Record<string, unknown>): string[] {
  if (surface['type'] === 'sphere') {
    const ok = isVec3(surface['center']) && isVec3(surface['axis']) && isVec3(surface['xDir']) && positive(surface['radius']);
    return ok ? [] : [`${at} (sphere) needs center, axis, xDir and radius > 0`];
  }
  if (surface['type'] === 'plane') {
    const ok = isVec3(surface['origin']) && isVec3(surface['xDir']) && isVec3(surface['yDir']) && isVec3(surface['normal']);
    return ok ? [] : [`${at} (plane) needs origin, xDir, yDir and normal`];
  }
  if (surface['type'] === 'cylinder') {
    const ok = isVec3(surface['origin']) && isVec3(surface['axis']) && isVec3(surface['xDir']) && positive(surface['radius']);
    return ok ? [] : [`${at} (cylinder) needs origin, axis, xDir and radius > 0`];
  }
  if (surface['type'] === 'cone') {
    const ok =
      isVec3(surface['apex']) &&
      isVec3(surface['axis']) &&
      isVec3(surface['xDir']) &&
      isNumber(surface['semiAngle']) &&
      surface['semiAngle'] > 0 &&
      surface['semiAngle'] < Math.PI / 2;
    return ok ? [] : [`${at} (cone) needs apex, axis, xDir and a semiAngle in (0, pi/2)`];
  }
  if (surface['type'] !== 'nurbs') return [];
  const domain = surface['domain'];
  const range = (value: unknown): boolean =>
    Array.isArray(value) && value.length === 2 && value.every(isNumber) && (value[0] as number) < (value[1] as number);
  const scale = surface['scale'];
  const errors: string[] = [];
  if (!isRecord(surface['surface'])) errors.push(`${at}.surface (nurbs) must be a surface record`);
  if (!Array.isArray(domain) || domain.length !== 2 || !domain.every(range))
    errors.push(`${at}.domain must be [[u0, u1], [v0, v1]] with u0 < u1 and v0 < v1`);
  if (!Array.isArray(scale) || scale.length !== 2 || !scale.every(positive)) errors.push(`${at}.scale must be two numbers > 0`);
  return errors;
}

/** Errors of the optional drape settings and cuts of a ply. */
function plyExtraErrors(at: string, ply: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const drape = ply['drape'];
  if (drape !== undefined) {
    if (!isRecord(drape) || !['developable', 'projection', 'kinematic'].includes(drape['method'] as string))
      errors.push(`${at}.drape.method must be developable, projection or kinematic`);
    else {
      if (drape['stepLength'] !== undefined && !positive(drape['stepLength'])) errors.push(`${at}.drape.stepLength must be > 0 when given`);
      if (drape['seed'] !== undefined && !(Array.isArray(drape['seed']) && drape['seed'].length === 2 && drape['seed'].every(isNumber)))
        errors.push(`${at}.drape.seed must be [x, y]`);
    }
  }
  const cuts = ply['cuts'];
  if (cuts !== undefined) {
    if (!Array.isArray(cuts)) return [...errors, `${at}.cuts must be a list`];
    cuts.forEach((cut, k) => {
      const valid =
        isRecord(cut) && (cut['kind'] === 'dart' || cut['kind'] === 'splice') && isVec2List(cut['path']) && cut['path'].length >= 2;
      if (!valid) errors.push(`${at}.cuts.${k} needs kind dart / splice and a path of at least 2 [x, y] points`);
      else if (cut['overlap'] !== undefined && !(isNumber(cut['overlap']) && cut['overlap'] >= 0))
        errors.push(`${at}.cuts.${k}.overlap must be >= 0`);
    });
  }
  return errors;
}

/** Value errors of the raw `composites` slice (an empty list = valid). */
export function compositesErrors(slice: unknown): string[] {
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
      if (!isRecord(surface) || !['plane', 'cylinder', 'cone', 'sphere', 'nurbs'].includes(surface['type'] as string))
        out.push(`composites.parts.${id}.surface.type must be plane, cylinder, cone, sphere or nurbs`);
      else out.push(...surfaceErrors(`composites.parts.${id}.surface`, surface));
      if (!isVec2List(p['outline']) || p['outline'].length < 3)
        out.push(`composites.parts.${id}.outline must be at least 3 [x, y] vertices`);
      if (!isRecord(slice['rosettes']) || !isText(p['rosetteId']) || !Object.hasOwn(slice['rosettes'], p['rosetteId']))
        out.push(`composites.parts.${id} references a missing rosette`);
      const faces = p['toolFaces'];
      if (!Array.isArray(faces) || faces.length === 0) out.push(`composites.parts.${id}.toolFaces must list a face`);
      else if (!faces.every((face) => isRecord(face) && isText(face['entityId'])))
        out.push(`composites.parts.${id}.toolFaces need an entityId`);
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
      out.push(...plyExtraErrors(`composites.plies.${id}`, p));
      return out;
    }),
    ...(slice['sections'] === undefined
      ? []
      : tableErrors(slice, 'sections', (id, s) => {
          const out: string[] = [];
          if (!isRecord(slice['parts']) || !isText(s['partId']) || !Object.hasOwn(slice['parts'], s['partId']))
            out.push(`composites.sections.${id} references a missing part`);
          const plies = s['plies'];
          const valid =
            Array.isArray(plies) &&
            plies.every((ply) => isRecord(ply) && isText(ply['material']) && positive(ply['thickness']) && isNumber(ply['angleDeg']));
          if (!valid) out.push(`composites.sections.${id}.plies need material, thickness > 0 and angleDeg`);
          else {
            const total = (plies as { thickness: number }[]).reduce((sum, ply) => sum + ply.thickness, 0);
            if (!isNumber(s['thickness']) || Math.abs((s['thickness'] as number) - total) > 1e-6 * Math.max(total, 1e-9))
              out.push(`composites.sections.${id}.thickness must equal the sum of its plies`);
            const materials = isRecord(slice['materials']) ? slice['materials'] : {};
            for (const ply of plies as { material: string }[])
              if (!Object.hasOwn(materials, ply.material))
                out.push(`composites.sections.${id} references missing material '${ply.material}'`);
          }
          if (!isText(s['name'])) out.push(`composites.sections.${id}.name must be text`);
          if (s['laminateSide'] !== 'positive_normal' && s['laminateSide'] !== 'negative_normal')
            out.push(`composites.sections.${id}.laminateSide is unknown`);
          if (
            s['zoneId'] !== undefined &&
            (!isRecord(slice['zones']) || !isText(s['zoneId']) || !Object.hasOwn(slice['zones'], s['zoneId']))
          )
            out.push(`composites.sections.${id} references a missing zone`);
          return out;
        })),
    ...(slice['cores'] === undefined
      ? []
      : tableErrors(slice, 'cores', (id, c) => {
          const out: string[] = [];
          if (!isRecord(slice['parts']) || !isText(c['partId']) || !Object.hasOwn(slice['parts'], c['partId']))
            out.push(`composites.cores.${id} references a missing part`);
          if (!isRecord(slice['materials']) || !isText(c['materialName']) || !Object.hasOwn(slice['materials'], c['materialName']))
            out.push(`composites.cores.${id} references a missing material`);
          if (!isVec2List(c['boundary']) || c['boundary'].length < 3)
            out.push(`composites.cores.${id}.boundary must be at least 3 [x, y] vertices`);
          if (!positive(c['thickness'])) out.push(`composites.cores.${id}.thickness must be > 0`);
          if (!positive(c['chamferAngle']) || (c['chamferAngle'] as number) > 90)
            out.push(`composites.cores.${id}.chamferAngle must be in (0, 90]`);
          if (!isNumber(c['afterOrder']) || (c['afterOrder'] as number) < 0) out.push(`composites.cores.${id}.afterOrder must be >= 0`);
          return out;
        })),
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
  validate: (raw) => (raw['composites'] === undefined ? [] : compositesErrors(raw['composites'])),
  derivedEntityIds: (doc) =>
    new Set(Object.values(doc.composites?.plies ?? {}).flatMap((ply) => outlineIdsOf(ply, doc.composites?.parts[ply.partId]))),
  restore: (raw) => {
    const saved = raw['composites'];
    if (saved === undefined || compositesErrors(saved).length > 0 || !isRecord(raw['entities']) || !Array.isArray(raw['order'])) return raw;
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
