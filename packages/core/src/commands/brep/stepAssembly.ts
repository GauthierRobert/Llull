/**
 * Assembly plan for `export_step_exact`: a component becomes ONE shared STEP part per uniform scale (scale 1 = the component itself; any
 * rotation is a location composed by the kernel; a uniform scale is a kernel `scale` of the part's solids, so every instance with that
 * scale reuses the part). A component's nested instances become sub-assembly occurrences naming the nested part (scales multiply, nested
 * positions scale with the parent), so a component used at several depths is written once. STEP locations cannot express a non-uniform or
 * mirrored scale (or a reference cycle): exactly that instance is baked into world/parent-space solids - a loose part for a top-level
 * instance, extra solids of the parent part for a nested one - never the surrounding component.
 */

import { type CadDocument, type Component, type Entity, type InstanceEntity, type Vec3, is3D } from '../../model/types';
import type { GeometryKernel, ShapeHandle, StepAssemblyPart, StepOccurrence } from '../../geometry/kernel';
import { operandRecipe } from './kernelShape';
import type { AssemblyStepLabels, NestedOccurrence } from './stepAssemblyLabels';
import { type StepEntry, instanceSolids, stepLabels } from './stepTargets';

export interface StepAssemblyPlan {
  readonly occurrences: StepOccurrence[];
  readonly labels: AssemblyStepLabels;
  /** Distinct parts (STEP products) besides the root. */
  readonly partCount: number;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

/** Sub-assemblies nested deeper than this are baked (guards against reference cycles). */
const MAX_NESTING = 4;

type PartLabels = AssemblyStepLabels['parts'][number];

const isUnitScale = (instance: InstanceEntity): boolean => (instance.scale ?? [1, 1, 1]).every((factor) => factor === 1);

/** The single positive factor of an equal-per-axis scale (1 when unscaled), else null (non-uniform or mirrored: only baked geometry fits). */
function uniformScale(instance: InstanceEntity): number | null {
  const [sx, sy, sz] = instance.scale ?? [1, 1, 1];
  return sx === sy && sy === sz && sx > 0 ? sx : null;
}

const scalePosition = (position: Vec3, factor: number): Vec3 => [position[0] * factor, position[1] * factor, position[2] * factor];

const factorText = (factor: number): string => String(Number(factor.toFixed(4)));

/** `Name (scaled ×2)` / `Name (scaled ×2×1×0.5)`: what a baked scaled instance is called in the STEP. */
function scaledName(componentName: string, scale: readonly number[]): string {
  const same = scale.every((factor) => factor === scale[0]);
  return `${componentName} (scaled ×${(same ? scale.slice(0, 1) : scale).map(factorText).join('×')})`;
}

/** The component's exportable children (3D solids and instances; 2D shapes have no STEP form). */
function exportableChildren(component: Component): Entity[] {
  return component.order.map((id) => component.entities[id]).filter((child): child is Entity => child !== undefined && is3D(child));
}

/** Plan for `entries`, or the id of the entity the kernel could not build. */
export function planStepAssembly(
  doc: CadDocument,
  entries: readonly StepEntry[],
  kernel: GeometryKernel,
): StepAssemblyPlan | { readonly failed: string } {
  const occurrences: StepOccurrence[] = [];
  const parts: PartLabels[] = [];
  const labeled: NestedOccurrence[] = [];
  const sharedOf = new Map<string, { part: StepAssemblyPart; index: number }>();

  const scalable = kernel.supports('scale');

  /** Shapes of `solids` in component space, scaled about the component origin by `factor` (a uniform scale is a kernel op, not a location). */
  const build = (solids: readonly Entity[], factor = 1): ShapeHandle[] | { failed: string } => {
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      const recipe = operandRecipe(kernel, entity);
      const shape = kernel.evaluate(factor === 1 ? recipe : { op: 'scale', source: recipe, factor });
      if (shape === null) return { failed: `'${entity.id}' (kind '${entity.kind}')` };
      shapes.push(shape);
    }
    return shapes;
  };

  /** The uniform positive scale of an instance a part can carry (1 = none), or null when only baked geometry can express it. */
  const carriedScale = (instance: InstanceEntity): number | null => {
    const factor = uniformScale(instance);
    return factor !== null && (factor === 1 || scalable) ? factor : null;
  };

  /**
   * The shared part of `component` at uniform `factor` (built once per component and factor, with its sub-assembly), or its failure.
   * A nested instance that a location cannot carry (non-uniform / mirrored scale, cycle, depth) is baked into this part only.
   */
  const sharedPart = (
    component: Component,
    factor: number,
    trail: readonly string[],
  ): { part: StepAssemblyPart; index: number } | { failed: string } | null => {
    const key = `${component.id}@${factor}`;
    const known = sharedOf.get(key);
    if (known !== undefined) return known;
    const path = [...trail, component.id];
    const solids: Entity[] = [];
    const nested: StepOccurrence[] = [];
    const nestedLabels: NestedOccurrence[] = [];
    const children = exportableChildren(component);
    const used = children.filter((child): child is InstanceEntity => child.kind === 'instance');
    const baked: Entity[] = [];
    for (const child of children) {
      if (child.kind !== 'instance') {
        solids.push(child);
        continue;
      }
      const inner = doc.components[child.componentId];
      const base = child.name ?? inner?.name ?? 'instance';
      const innerFactor = carriedScale(child);
      const rigid = inner !== undefined && innerFactor !== null && !path.includes(inner.id) && path.length <= MAX_NESTING;
      const shared = rigid ? sharedPart(inner, factor * innerFactor, path) : null;
      if (shared === null) {
        baked.push(...instanceSolids(doc, child, base, 0));
        continue;
      }
      if ('failed' in shared) return shared;
      const twins = used.filter((other) => (other.name ?? doc.components[other.componentId]?.name) === base);
      nested.push({ part: shared.part, position: scalePosition(child.position, factor), rotation: child.rotation });
      nestedLabels.push({ name: twins.length > 1 ? `${base} ${twins.indexOf(child) + 1}` : base, part: shared.index });
    }
    if (solids.length + baked.length + nested.length === 0) return null;
    const shapes = build([...solids, ...baked], factor);
    if ('failed' in shapes) return shapes;
    const labels = [
      ...solids.map((child, index) => ({
        name: child.name ?? (children.length === 1 ? component.name : `${component.name} part ${index + 1}`),
        color: child.color,
      })),
      ...stepLabels(doc, baked),
    ];
    parts.push({
      name: factor === 1 ? component.name : scaledName(component.name, [factor]),
      solids: labels,
      ...(nestedLabels.length > 0 ? { occurrences: nestedLabels } : {}),
    });
    const made = { part: { shapes, ...(nested.length > 0 ? { children: nested } : {}) }, index: parts.length - 1 };
    sharedOf.set(key, made);
    return made;
  };

  for (const entry of entries) {
    if (entry.kind === 'solid') {
      const shapes = build([entry.entity]);
      if ('failed' in shapes) return shapes;
      const [label] = stepLabels(doc, [entry.entity]);
      parts.push({
        name: label?.name ?? entry.entity.id,
        ...(label?.description === undefined ? {} : { description: label.description }),
        solids: label ? [label] : [],
      });
      labeled.push({ name: label?.name ?? entry.entity.id, part: parts.length - 1 });
      occurrences.push({ part: { shapes }, position: ORIGIN, rotation: ORIGIN });
      continue;
    }
    const component = doc.components[entry.instance.componentId];
    const factor = carriedScale(entry.instance);
    const shared = component !== undefined && factor !== null ? sharedPart(component, factor, []) : null;
    if (shared !== null) {
      if ('failed' in shared) return shared;
      labeled.push({ name: entry.label, part: shared.index });
      occurrences.push({ part: shared.part, position: entry.instance.position, rotation: entry.instance.rotation });
      continue;
    }
    const shapes = build(entry.baked);
    if ('failed' in shapes) return shapes;
    const scale = entry.instance.scale ?? [1, 1, 1];
    const name = component !== undefined && !isUnitScale(entry.instance) ? scaledName(component.name, scale) : entry.label;
    parts.push({ name, solids: stepLabels(doc, entry.baked) });
    labeled.push({ name: entry.label, part: parts.length - 1 });
    occurrences.push({ part: { shapes }, position: ORIGIN, rotation: ORIGIN });
  }
  return { occurrences, labels: { rootName: 'Assembly', parts, occurrences: labeled }, partCount: parts.length };
}
