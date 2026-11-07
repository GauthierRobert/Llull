/**
 * The storeys of the IFC export and the products of the elements on them: spatial containment, assembly aggregation, materials. With a hierarchy scope only
 * the elements in scope are written, a storey with none is not written, and an element whose assembly is not exported is contained like a free element
 * (so no product is left without a container).
 * @invariant pure over the document; unscoped, the entities and their order are those of the whole export
 */

import type { CadDocument } from '@core/model/types';
import { elementsOf, getBuilding, orderedElements } from '../model';
import { type Context, ifcReal, ifcString, placement } from './ifcStep';
import { type LevelElement, type PlantContext, appendTo, exportElement } from './ifcElements';
import { type IfcScope, emptyOmitted } from './ifcScope';

export interface LevelsResult {
  readonly storeys: string[];
  readonly productCount: number;
  readonly elementCount: number;
  readonly byMaterial: Map<string, string[]>;
  readonly plantContained: Map<string, string[]>;
  /** Elements left out by the scope, by reason (zeros without a scope). */
  readonly omittedElements: ReturnType<typeof emptyOmitted>['elements'];
}

export function exportLevels(
  context: Context,
  doc: CadDocument,
  buildingPlacement: string,
  plant: PlantContext,
  scope: IfcScope | null,
): LevelsResult {
  const building = getBuilding(doc);
  const { writer } = context;
  const plantContained = new Map<string, string[]>();
  const storeys: string[] = [];
  const byMaterial = new Map<string, string[]>();
  const omittedElements = emptyOmitted().elements;
  const assemblies = new Map(elementsOf(building, 'assembly').map((assembly) => [assembly.id, assembly]));
  let productCount = 0;
  let elementCount = 0;
  for (const levelId of building.levelOrder) {
    const level = building.levels[levelId];
    if (!level) continue;
    const onLevel = orderedElements(building).filter(
      (element): element is LevelElement => 'levelId' in element && element.levelId === level.id,
    );
    const wanted = scope === null ? onLevel : onLevel.filter((element) => scope.elementMembership(element.id) === 'inScope');
    for (const element of onLevel) {
      const membership = scope?.elementMembership(element.id) ?? 'inScope';
      if (membership !== 'inScope') omittedElements[membership] += 1;
    }
    if (scope !== null && wanted.length === 0) continue;
    const storeyPlacement = placement(context, buildingPlacement, 0, 0, context.mm(level.elevation));
    const storey = writer.add(
      `IFCBUILDINGSTOREY('${context.guid(level.id)}',$,${ifcString(level.name)},$,$,${storeyPlacement},$,$,.ELEMENT.,${ifcReal(context.mm(level.elevation))})`,
    );
    storeys.push(storey);
    const contained: string[] = [];
    const spaces: string[] = [];
    const productOf = new Map<string, string>();
    const parts: Array<{ readonly ref: string; readonly elementId: string; readonly assemblyId: string }> = [];
    for (const element of wanted) {
      const exportedProducts = exportElement(context, doc, element, level, storeyPlacement, plant);
      if (exportedProducts.length > 0) elementCount += 1;
      const first = exportedProducts[0];
      if (first !== undefined) productOf.set(element.id, first.ref);
      const assemblyId = 'assemblyId' in element ? element.assemblyId : undefined;
      for (const exported of exportedProducts) {
        if (exported.container !== undefined) appendTo(plantContained, exported.container, [exported.ref]);
        else if (assemblyId !== undefined && scope !== null) parts.push({ ref: exported.ref, elementId: element.id, assemblyId });
        else if (assemblyId === undefined) (element.category === 'room' ? spaces : contained).push(exported.ref);
        productCount += 1;
        if (exported.material === null) continue;
        appendTo(byMaterial, exported.material, [exported.ref, ...(exported.parts ?? [])]);
      }
    }
    for (const part of parts) {
      const owner = assemblies.get(part.assemblyId);
      const aggregated =
        owner !== undefined &&
        owner.levelId === level.id &&
        productOf.has(owner.id) &&
        owner.partIds.includes(part.elementId) &&
        part.ref === productOf.get(part.elementId);
      if (!aggregated) contained.push(part.ref);
    }
    for (const assembly of elementsOf(building, 'assembly')) {
      const refs = assembly.partIds.flatMap((id) => productOf.get(id) ?? []);
      const assemblyRef = productOf.get(assembly.id);
      if (assembly.levelId === level.id && assemblyRef !== undefined && refs.length > 0)
        writer.add(`IFCRELAGGREGATES('${context.guid(`rel:assembly-parts:${assembly.id}`)}',$,$,$,${assemblyRef},(${refs.join(',')}))`);
    }
    if (contained.length > 0) {
      writer.add(
        `IFCRELCONTAINEDINSPATIALSTRUCTURE('${context.guid(`rel:contains:${level.id}`)}',$,$,$,(${contained.join(',')}),${storey})`,
      );
    }
    if (spaces.length > 0) {
      writer.add(`IFCRELAGGREGATES('${context.guid(`rel:spaces:${level.id}`)}',$,$,$,${storey},(${spaces.join(',')}))`);
    }
  }
  return { storeys, productCount, elementCount, byMaterial, plantContained, omittedElements };
}
