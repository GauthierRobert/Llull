/**
 * `as: "instances"` for array_linear / array_polar (08 ASC M2, decision D1): the pattern becomes ONE component plus N instances placed
 * by a rigid transform each, instead of N entity copies. Ids come from `nextId` (step-scoped), so replay re-derives the same set.
 */

import { type CadDocument, type Component, type Entity, type InstanceEntity, type Vec3, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { changed, codedRejection, noop } from '../noop';
import { nextId } from '../../lib/id';
import { applyMat3, eulerFromMat, matFromEulerXYZ, mulMat3, type Mat3 } from '../../lib/axisRotation';
import { add3, ORIGIN } from '../../lib/vec3';
import { instanceEntity } from '../assembly/assemblies';
import { referenceLossSuffix } from '../entity/entityOps';
import { relocateEntities } from '../entity/relocateEntity';

/** Rigid placement x' = turn · x + shift (world frame). */
export interface PatternPlacement {
  readonly turn: Mat3;
  readonly shift: Vec3;
}

/**
 * Array `source` as instances of one component.
 * @affects entities, components: a solid source is moved into a new component and replaced by instance 0 (identity transform); an
 *   instance source keeps its component and stays instance 0; one new instance per placement
 * @invariant instance k is the source rigidly placed by placements[k-1]; new instances carry `patternSourceId` = instance 0
 * @failure ARRAY_SOURCE_NOT_SOLID: a 2D shape or other non-3D source -> rejected, document unchanged
 * @failure instance source whose component is missing -> no-op
 */
export function arrayAsInstances(
  doc: CadDocument,
  command: 'array_linear' | 'array_polar',
  source: Entity,
  placements: readonly PatternPlacement[],
  describe: string,
): CommandResult {
  if (!is3D(source))
    return codedRejection(
      doc,
      command,
      'ARRAY_SOURCE_NOT_SOLID',
      `entity '${source.id}' (${source.kind}) is not a 3D solid or component instance, so it cannot be arrayed as instances`,
      'Use as: "copies" for 2D shapes, or extrude / revolve the profile first.',
      [source.id],
    );
  let base: InstanceEntity;
  let working = doc;
  let componentId: string;
  const created: string[] = [];
  if (source.kind === 'instance') {
    if (!Object.hasOwn(doc.components, source.componentId))
      return noop(doc, `${command}: component "${source.componentId}" of instance '${source.id}' not found.`);
    base = source;
    componentId = source.componentId;
  } else {
    componentId = nextId('comp');
    const component: Component = {
      id: componentId,
      name: `${source.kind} ${source.id}`,
      entities: { [source.id]: source },
      order: [source.id],
    };
    base = {
      ...instanceEntity(nextId('instance'), componentId, ORIGIN, ORIGIN),
      layerId: source.layerId,
      color: source.color,
      ...(source.name === undefined ? {} : { name: source.name }),
    };
    working = { ...relocateEntities(doc, [source.id], base).document, components: { ...doc.components, [componentId]: component } };
    created.push(base.id);
  }
  const rotation = matFromEulerXYZ(base.rotation);
  const entities: CadDocument['entities'] = { ...working.entities };
  const order = [...working.order];
  for (const { turn, shift } of placements) {
    const id = nextId('instance');
    entities[id] = {
      ...base,
      id,
      patternSourceId: base.id,
      position: add3(applyMat3(turn, base.position), shift),
      rotation: eulerFromMat(mulMat3(turn, rotation)),
    };
    order.push(id);
    created.push(id);
  }
  const document: CadDocument = { ...working, entities, order };
  const origin =
    source.kind === 'instance'
      ? `source instance ${source.id} is instance 0`
      : `source ${source.id} moved into the component as instance 0 ${base.id}`;
  return changed(
    document,
    `${describe} as instances: ${created.length} instance(s) of component ${componentId} (${created.join(', ')}); ${origin}.` +
      referenceLossSuffix(doc, document),
    created,
  );
}
