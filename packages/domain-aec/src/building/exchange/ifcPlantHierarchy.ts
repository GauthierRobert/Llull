/**
 * Plant hierarchy as the IFC 4.3 spatial structure (plant 08 DAT §5.7, TR-DAT-23): hierarchy site -> IfcSite, plant -> IfcFacility (ObjectType
 * 'PROCESSPLANT'), area / unit -> IfcFacilityPartCommon (USERDEFINED, ObjectType 'AREA' / 'UNIT'), aggregated in tree order. A system node is not spatial:
 * its objects are contained in the nearest spatial ancestor. A node whose parent chain skips the facility is aggregated to the nearest node above it.
 * @invariant pure; nodes are written in hierarchy definition order, parents before children
 */

import type { HierarchyNode } from '../../plant/data/model';
import { spatialNode, type PlantIfcView } from '../../plant/data/view';
import { type Context, ifcString } from './ifcStep';

export interface PlantSpatial {
  /** Hierarchy node id -> IFC reference of its spatial element. */
  readonly byNode: ReadonlyMap<string, string>;
  /** First site node, when the hierarchy has one (the building is aggregated to it). */
  readonly firstSite: string | null;
}

function nodeEntity(context: Context, node: HierarchyNode): string {
  const guid = context.guid(`plant:node:${node.id}`);
  const name = ifcString(node.code);
  const description = node.name === '' ? '$' : ifcString(node.name);
  switch (node.kind) {
    case 'site':
      return `IFCSITE('${guid}',$,${name},${description},$,$,$,$,.ELEMENT.,$,$,$,$,$)`;
    case 'plant':
      return `IFCFACILITY('${guid}',$,${name},${description},'PROCESSPLANT',$,$,$,$)`;
    default:
      return `IFCFACILITYPARTCOMMON('${guid}',$,${name},${description},${node.kind === 'area' ? "'AREA'" : "'UNIT'"},$,$,$,$,.NOTDEFINED.,.USERDEFINED.)`;
  }
}

/**
 * Writes the spatial nodes and their aggregation. Roots of kind site hang on the project; other roots on `defaultSite` (the project when it is null).
 * @param defaultSite reference of the default IfcSite, null when the hierarchy brings its own site
 */
export function writePlantNodes(context: Context, view: PlantIfcView, projectRef: string, defaultSite: string | null): PlantSpatial {
  const { writer } = context;
  const spatial = view.nodes.filter((node) => node.kind !== 'system');
  const byNode = new Map<string, string>();
  for (const node of spatial) byNode.set(node.id, writer.add(nodeEntity(context, node)));
  const children = new Map<string, string[]>();
  const add = (parent: string, child: string): void => {
    children.set(parent, [...(children.get(parent) ?? []), child]);
  };
  for (const node of spatial) {
    const ref = byNode.get(node.id) as string;
    const parent = node.parentId === null ? undefined : spatialNode(view.data, node.parentId);
    const parentRef = parent === undefined ? undefined : byNode.get(parent.id);
    if (parentRef !== undefined) add(parentRef, ref);
    else add(node.kind === 'site' || defaultSite === null ? projectRef : defaultSite, ref);
  }
  for (const [parent, refs] of children) {
    writer.add(`IFCRELAGGREGATES('${context.guid(`plant:agg:${parent}`)}',$,$,$,${parent},(${refs.join(',')}))`);
  }
  const firstSite = spatial.find((node) => node.kind === 'site');
  return { byNode, firstSite: firstSite === undefined ? null : (byNode.get(firstSite.id) ?? null) };
}

/** Spatial element that contains the products of a plant object in hierarchy node `hierarchyId`, or null. */
export function containerOf(spatial: PlantSpatial | null, view: PlantIfcView, hierarchyId: string): string | null {
  if (spatial === null) return null;
  const node = spatialNode(view.data, hierarchyId);
  return node === undefined ? null : (spatial.byNode.get(node.id) ?? null);
}
