/**
 * Assembly plan for `export_step_exact`: a component whose instances are unit-scale placements becomes ONE shared STEP part (any rotation
 * is a location, composed as a gp_Trsf product by the kernel), with an occurrence per instance. A component that itself holds unit-scale
 * instances becomes a sub-assembly: its nested occurrences name the nested component's part, so a component used at several depths is
 * written once. STEP locations cannot scale: every other entry (loose solid, scaled instance) is its own part with a single identity
 * occurrence, built from the same baked solids the flat export writes.
 */

import { type CadDocument, type Component, type Entity, type InstanceEntity, is3D } from '../../model/types';
import type { GeometryKernel, ShapeHandle, StepAssemblyPart, StepOccurrence } from '../../geometry/kernel';
import { operandRecipe } from './kernelShape';
import type { AssemblyStepLabels, NestedOccurrence } from './stepAssemblyLabels';
import { type StepEntry, stepLabels } from './stepTargets';

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

  const build = (solids: readonly Entity[]): ShapeHandle[] | { failed: string } => {
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      const shape = kernel.evaluate(operandRecipe(kernel, entity));
      if (shape === null) return { failed: `'${entity.id}' (kind '${entity.kind}')` };
      shapes.push(shape);
    }
    return shapes;
  };

  /** Whether every instance below `component` can be a pure location (so the component can be one shared part). */
  const isRigid = (component: Component, trail: readonly string[]): boolean => {
    const children = exportableChildren(component);
    const path = [...trail, component.id];
    if (children.length === 0 || path.length > MAX_NESTING) return false;
    return children.every((child) => {
      if (child.kind !== 'instance') return true;
      const inner = doc.components[child.componentId];
      return inner !== undefined && isUnitScale(child) && !path.includes(inner.id) && isRigid(inner, path);
    });
  };

  /** The shared part of a rigid component (built once, with its sub-assembly), or its failure. */
  const sharedPart = (component: Component): { part: StepAssemblyPart; index: number } | { failed: string } => {
    const known = sharedOf.get(component.id);
    if (known !== undefined) return known;
    const children = exportableChildren(component);
    const solids = children.filter((child) => child.kind !== 'instance');
    const shapes = build(solids);
    if ('failed' in shapes) return shapes;
    const nested: StepOccurrence[] = [];
    const nestedLabels: NestedOccurrence[] = [];
    const used = children.filter((child): child is InstanceEntity => child.kind === 'instance');
    for (const instance of used) {
      const inner = doc.components[instance.componentId];
      if (inner === undefined) continue;
      const shared = sharedPart(inner);
      if ('failed' in shared) return shared;
      const base = instance.name ?? inner.name;
      const twins = used.filter((other) => (other.name ?? doc.components[other.componentId]?.name) === base);
      nested.push({ part: shared.part, position: instance.position, rotation: instance.rotation });
      nestedLabels.push({ name: twins.length > 1 ? `${base} ${twins.indexOf(instance) + 1}` : base, part: shared.index });
    }
    const labels = solids.map((child, index) => ({
      name: child.name ?? (children.length === 1 ? component.name : `${component.name} part ${index + 1}`),
      color: child.color,
    }));
    parts.push({ name: component.name, solids: labels, ...(nestedLabels.length > 0 ? { occurrences: nestedLabels } : {}) });
    const made = { part: { shapes, ...(nested.length > 0 ? { children: nested } : {}) }, index: parts.length - 1 };
    sharedOf.set(component.id, made);
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
    if (component !== undefined && isUnitScale(entry.instance) && isRigid(component, [])) {
      const shared = sharedPart(component);
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
