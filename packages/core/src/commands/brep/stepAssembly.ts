/**
 * Assembly plan for `export_step_exact`: a component whose instances are rigid placements (unit scale, no nested instances, rotations that
 * compose exactly) becomes ONE shared STEP part with an occurrence per instance; every other entry (loose solid, scaled or nested instance)
 * is its own part with a single identity occurrence, built from the same baked solids the flat export writes.
 */

import { type CadDocument, type Component, type Entity, type InstanceEntity, is3D } from '../../model/types';
import type { GeometryKernel, ShapeHandle, StepAssemblyPart, StepOccurrence } from '../../geometry/kernel';
import { isZeroRotation } from '../../lib/eulerRotation';
import { operandRecipe } from './kernelShape';
import type { AssemblyStepLabels } from './stepAssemblyLabels';
import { type StepEntry, stepLabels } from './stepTargets';

export interface StepAssemblyPlan {
  readonly occurrences: StepOccurrence[];
  readonly labels: AssemblyStepLabels;
  /** Distinct parts (STEP products) besides the root. */
  readonly partCount: number;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

/** The component's solids when every instance of it can be a pure location of one shared part, else null. */
function rigidSolids(component: Component | undefined, instance: InstanceEntity): Entity[] | null {
  if (component === undefined || (instance.scale ?? [1, 1, 1]).some((factor) => factor !== 1)) return null;
  const children = component.order.map((id) => component.entities[id]).filter((child): child is Entity => child !== undefined);
  if (children.length === 0 || children.some((child) => !is3D(child) || child.kind === 'instance')) return null;
  // the parametric instance path adds Euler angles; a location composes them: equal only when one side is unrotated
  if (!isZeroRotation(instance.rotation) && children.some((child) => !isZeroRotation(child.rotation))) return null;
  return children;
}

/** Plan for `entries`, or the id of the entity the kernel could not build. */
export function planStepAssembly(
  doc: CadDocument,
  entries: readonly StepEntry[],
  kernel: GeometryKernel,
): StepAssemblyPlan | { readonly failed: string } {
  const occurrences: StepOccurrence[] = [];
  const parts: { name: string; description?: string; solids: AssemblyStepLabels['parts'][number]['solids'] }[] = [];
  const labeled: { name: string; part: number }[] = [];
  const partOfComponent = new Map<string, { part: StepAssemblyPart; index: number }>();

  const build = (solids: readonly Entity[]): StepAssemblyPart | { failed: string } => {
    const shapes: ShapeHandle[] = [];
    for (const entity of solids) {
      const shape = kernel.evaluate(operandRecipe(kernel, entity));
      if (shape === null) return { failed: `'${entity.id}' (kind '${entity.kind}')` };
      shapes.push(shape);
    }
    return { shapes };
  };

  for (const entry of entries) {
    if (entry.kind === 'solid') {
      const part = build([entry.entity]);
      if ('failed' in part) return part;
      const [label] = stepLabels(doc, [entry.entity]);
      parts.push({
        name: label?.name ?? entry.entity.id,
        ...(label?.description === undefined ? {} : { description: label.description }),
        solids: label ? [label] : [],
      });
      labeled.push({ name: label?.name ?? entry.entity.id, part: parts.length - 1 });
      occurrences.push({ part, position: ORIGIN, rotation: ORIGIN });
      continue;
    }
    const component = doc.components[entry.instance.componentId];
    const rigid = rigidSolids(component, entry.instance);
    if (component !== undefined && rigid !== null) {
      let shared = partOfComponent.get(component.id);
      if (shared === undefined) {
        const part = build(rigid);
        if ('failed' in part) return part;
        const solids = rigid.map((child, index) => ({
          name: child.name ?? (rigid.length === 1 ? component.name : `${component.name} part ${index + 1}`),
          color: child.color,
        }));
        parts.push({ name: component.name, solids });
        shared = { part, index: parts.length - 1 };
        partOfComponent.set(component.id, shared);
      }
      labeled.push({ name: entry.label, part: shared.index });
      occurrences.push({ part: shared.part, position: entry.instance.position, rotation: entry.instance.rotation });
      continue;
    }
    const part = build(entry.baked);
    if ('failed' in part) return part;
    parts.push({ name: entry.label, solids: stepLabels(doc, entry.baked) });
    labeled.push({ name: entry.label, part: parts.length - 1 });
    occurrences.push({ part, position: ORIGIN, rotation: ORIGIN });
  }
  return { occurrences, labels: { rootName: 'Assembly', parts, occurrences: labeled }, partCount: parts.length };
}
