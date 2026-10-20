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
import { exactOrMesh, exactRecipe } from './kernelShape';
import type { AssemblyStepLabels, NestedOccurrence } from './stepAssemblyLabels';
import { MAX_INSTANCE_DEPTH, type StepEntry, instanceSolids, stepLabels } from './stepTargets';

export interface StepAssemblyPlan {
  readonly occurrences: StepOccurrence[];
  readonly labels: AssemblyStepLabels;
  /** Distinct parts (STEP products) besides the root. */
  readonly partCount: number;
  /** Ply solids written from triangles because the kernel refused their exact slab. */
  readonly faceted: readonly string[];
}

const ORIGIN: [number, number, number] = [0, 0, 0];

type PartLabels = AssemblyStepLabels['parts'][number];

const isUnitScale = (instance: InstanceEntity): boolean => (instance.scale ?? [1, 1, 1]).every((factor) => factor === 1);

/** The single positive factor of an equal-per-axis scale (1 when unscaled), else null (non-uniform or mirrored: only baked geometry fits). */
function uniformScale(instance: InstanceEntity): number | null {
  const [sx, sy, sz] = instance.scale ?? [1, 1, 1];
  return sx === sy && sy === sz && sx > 0 ? sx : null;
}

/** One significant-digit rounding for every scale factor, so cache keys and scale recipes agree (3 x 0.1 = 0.3). */
const roundFactor = (factor: number): number => Number(factor.toPrecision(12));

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
  const faceted: string[] = [];

  const scalable = kernel.supports('scale');

  /**
   * Shapes of `solids` in component space, scaled about the component origin by `factor` (a uniform scale is a kernel op, not a location).
   * `unscalable` marks a failure that only the kernel's scale op caused (the unscaled shape builds), so the caller may bake instead.
   */
  const build = (solids: readonly Entity[], factor = 1): ShapeHandle[] | { failed: string; unscalable: boolean } => {
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      if (factor === 1) {
        const built = exactOrMesh(kernel, entity);
        if (built.faceted && !faceted.includes(entity.id)) faceted.push(entity.id);
        if (built.shape === null) return { failed: `'${entity.id}' (kind '${entity.kind}')`, unscalable: false };
        shapes.push(built.shape);
        continue;
      }
      const { recipe, faceted: usedTriangles } = exactRecipe(kernel, entity);
      if (usedTriangles && !faceted.includes(entity.id)) faceted.push(entity.id);
      const shape = kernel.evaluate({ op: 'scale', source: recipe, factor });
      if (shape === null) {
        const unscalable = kernel.evaluate(recipe) !== null;
        return { failed: `'${entity.id}' (kind '${entity.kind}')`, unscalable };
      }
      shapes.push(shape);
    }
    return shapes;
  };

  /** The uniform positive scale of an instance a part can carry (1 = none), or null when only baked geometry can express it. */
  const carriedScale = (instance: InstanceEntity): number | null => {
    const factor = uniformScale(instance);
    return factor !== null && (factor === 1 || scalable) ? roundFactor(factor) : null;
  };

  /**
   * The shared part of `component` at uniform `factor` (built once per component and factor, with its sub-assembly), a failure, or null
   * when the component cannot be one part (nothing exportable, or the kernel refuses to scale it): the caller bakes it instead.
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
    const mark = parts.length;
    const path = [...trail, component.id];
    const solids: Entity[] = [];
    const children = exportableChildren(component);
    const uses: { child: InstanceEntity; base: string; shared: { part: StepAssemblyPart; index: number } | null }[] = [];
    for (const child of children) {
      if (child.kind !== 'instance') {
        solids.push(child);
        continue;
      }
      const inner = doc.components[child.componentId];
      const innerFactor = carriedScale(child);
      const rigid = inner !== undefined && innerFactor !== null && !path.includes(inner.id) && path.length < MAX_INSTANCE_DEPTH;
      const shared = rigid ? sharedPart(inner, roundFactor(factor * innerFactor), path) : null;
      if (shared !== null && 'failed' in shared) return shared;
      uses.push({ child, base: child.name ?? inner?.name ?? 'instance', shared });
    }
    const nested: StepOccurrence[] = [];
    const nestedLabels: NestedOccurrence[] = [];
    const baked: Entity[] = [];
    for (const use of uses) {
      const twins = uses.filter((other) => other.base === use.base && (other.shared === null) === (use.shared === null));
      const label = twins.length > 1 ? `${use.base} ${twins.indexOf(use) + 1}` : use.base;
      if (use.shared === null) baked.push(...instanceSolids(doc, use.child, label, path.length));
      else {
        nested.push({ part: use.shared.part, position: scalePosition(use.child.position, factor), rotation: use.child.rotation });
        nestedLabels.push({ name: label, part: use.shared.index });
      }
    }
    if (solids.length + baked.length + nested.length === 0) return null;
    const shapes = build([...solids, ...baked], factor);
    if ('failed' in shapes) {
      if (!shapes.unscalable) return shapes;
      parts.length = mark;
      for (const [other, made] of sharedOf) if (made.index >= mark) sharedOf.delete(other);
      return null;
    }
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
        entityId: entry.entity.id,
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
  return { occurrences, labels: { rootName: 'Assembly', parts, occurrences: labeled }, partCount: parts.length, faceted };
}
