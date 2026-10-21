/**
 * Plan of an `export_step_ap242` write (aerospace 04 XCH M2): the document's solids, component instances and surface sheets become the
 * product tree the kernel's XDE writer takes (`ExchangeWriteRequest`), with the geometric validation properties of every product and of the
 * root assembly computed from the same shapes the writer receives.
 * Structured mode reuses the shared-part assembly plan of `export_step_ap242` (one product per component and uniform scale, nested uses);
 * flat mode writes every solid in world space as its own product.
 * @invariant a validation property is written only from `kernel.massProperties` of the shape the file holds; a product the kernel cannot
 *   integrate carries none and is listed in `unverified`
 */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeHandle, StepAssemblyPart } from '../../geometry/kernel';
import type { ExchangeOccurrence, ExchangeProduct, ExchangeSolid, ExchangeValidation } from '../../geometry/kernelExchange';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { exactOrMesh } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { planStepAssembly } from '../brep/stepAssembly';
import { type StepLabel } from '../brep/stepLabels';
import { type StepEntry, exportedIds, stepLabels, stepTargets } from '../brep/stepTargets';

export interface ExchangePlan {
  readonly products: readonly ExchangeProduct[];
  readonly occurrences: readonly ExchangeOccurrence[];
  readonly rootValidation?: ExchangeValidation;
  readonly hasRoot: boolean;
  /** Solids written (expanded), sheets written. */
  readonly solidCount: number;
  readonly sheetCount: number;
  /** Selected loose-solid / instance / sheet ids written, each once. */
  readonly entityIds: readonly string[];
  readonly skipped: readonly string[];
  /** Ply solids written from triangles because the kernel refused their exact slab. */
  readonly faceted: readonly string[];
  /** Product names whose validation properties the kernel could not compute. */
  readonly withoutValidation: readonly string[];
  /** Product key -> id of the single loose solid the product is (the only products PMI attaches to). */
  readonly productEntities: Readonly<Record<string, string>>;
}

export interface PlanOptions {
  readonly structured: boolean;
  readonly validation: boolean;
}

type Mass = { readonly volume: number; readonly area: number; readonly centroid: Vec3 };

const ORIGIN: Vec3 = [0, 0, 0];

function combine(parts: readonly Mass[]): ExchangeValidation | undefined {
  const volume = parts.reduce((sum, part) => sum + part.volume, 0);
  if (parts.length === 0 || !(volume > 0)) return undefined;
  const centroid: Vec3 = [0, 1, 2].map(
    (axis) => parts.reduce((sum, part) => sum + part.volume * (part.centroid[axis] ?? 0), 0) / volume,
  ) as unknown as Vec3;
  return { volume, area: parts.reduce((sum, part) => sum + part.area, 0), centroid };
}

const placedMass = (mass: Mass, position: Vec3, rotation: Vec3): Mass => {
  const turned = applyEulerXYZ(mass.centroid, ORIGIN, rotation);
  return { volume: mass.volume, area: mass.area, centroid: [turned[0] + position[0], turned[1] + position[1], turned[2] + position[2]] };
};

/** Validation properties of `shapes` (unit density); undefined when any shape cannot be integrated. */
function shapesMass(kernel: GeometryKernel, shapes: readonly ShapeHandle[]): Mass[] | undefined {
  const masses: Mass[] = [];
  for (const shape of shapes) {
    const exact = kernel.massProperties?.(shape) ?? null;
    if (exact === null || !(exact.volume > 0)) return undefined;
    masses.push({ volume: exact.volume, area: exact.area, centroid: exact.centroid });
  }
  return masses;
}

const uniform = <T>(values: readonly (T | undefined)[]): T | undefined => {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : undefined;
};

function solidsOf(shapes: readonly ShapeHandle[], labels: readonly StepLabel[]): ExchangeSolid[] {
  return shapes.map((shape, index) => {
    const label = labels[index];
    return {
      shape,
      ...(label?.name === undefined ? {} : { name: label.name }),
      ...(label?.color === undefined ? {} : { color: label.color }),
    };
  });
}

function productOf(
  key: string,
  name: string,
  shapes: readonly ShapeHandle[],
  labels: readonly StepLabel[],
  validation: ExchangeValidation | undefined,
): ExchangeProduct {
  const layer = uniform(labels.map((label) => label.layer));
  const description = uniform(labels.map((label) => label.description));
  const material = uniform(labels.map((label) => label.material?.name));
  const density = labels[0]?.material?.density;
  return {
    key,
    name,
    solids: solidsOf(shapes, labels),
    ...(description === undefined ? {} : { description }),
    ...(layer === undefined ? {} : { layer }),
    ...(material === undefined || density === undefined ? {} : { material: { name: material, density } }),
    ...(validation === undefined ? {} : { validation }),
  };
}

/** Flat plan: every solid in world space is its own product. */
function flatPlan(
  doc: CadDocument,
  kernel: GeometryKernel,
  solids: readonly Entity[],
  options: PlanOptions,
): ExchangePlan | { readonly failed: string } {
  const products: ExchangeProduct[] = [];
  const withoutValidation: string[] = [];
  const faceted: string[] = [];
  const productEntities: Record<string, string> = {};
  const labels = stepLabels(doc, solids);
  for (const [index, entity] of solids.entries()) {
    const built = exactOrMesh(kernel, entity);
    const shape = built.shape;
    if (built.faceted) faceted.push(entity.id);
    if (shape === null) return { failed: `'${entity.id}' (kind '${entity.kind}')` };
    const label = labels[index] ?? { name: entity.id };
    const masses = options.validation ? shapesMass(kernel, [shape]) : undefined;
    if (options.validation && masses === undefined) withoutValidation.push(label.name);
    products.push(productOf(`solid-${index}`, label.name, [shape], [label], masses === undefined ? undefined : combine(masses)));
    if (!built.faceted) productEntities[`solid-${index}`] = entity.id;
  }
  return {
    products,
    occurrences: [],
    hasRoot: false,
    solidCount: solids.length,
    sheetCount: 0,
    entityIds: [],
    skipped: [],
    faceted,
    withoutValidation,
    productEntities,
  };
}

/** Structured plan from the shared-part assembly plan; `failed` names the entity the kernel could not build. */
function structuredPlan(
  doc: CadDocument,
  kernel: GeometryKernel,
  entries: readonly StepEntry[],
  options: PlanOptions,
): ExchangePlan | { readonly failed: string } {
  const plan = planStepAssembly(doc, entries, kernel);
  if ('failed' in plan) return plan;
  const hasInstances = entries.some((entry) => entry.kind === 'instance');
  const products = new Map<number, ExchangeProduct>();
  const nested: ExchangeOccurrence[] = [];
  const masses = new Map<string, readonly Mass[] | undefined>();
  const withoutValidation: string[] = [];
  const productEntities: Record<string, string> = {};
  const faceted = plan.faceted;

  /** Placed masses of a part: its own solids plus every nested use. */
  const partMasses = (part: StepAssemblyPart, index: number): Mass[] | undefined => {
    const key = `part-${index}`;
    if (masses.has(key)) return masses.get(key) as Mass[] | undefined;
    const own = shapesMass(kernel, part.shapes);
    const label = plan.labels.parts[index];
    let all = own;
    for (const [at, child] of (part.children ?? []).entries()) {
      const childIndex = label?.occurrences?.[at]?.part;
      const inner = childIndex === undefined || all === undefined ? undefined : partMasses(child.part, childIndex);
      const total = inner === undefined ? undefined : combine(inner);
      all = total === undefined || all === undefined ? undefined : [...all, placedMass(total, child.position, child.rotation)];
    }
    masses.set(key, all);
    return all;
  };

  const addPart = (part: StepAssemblyPart, index: number): string => {
    const key = `part-${index}`;
    if (products.has(index)) return key;
    const label = plan.labels.parts[index];
    const measured = options.validation ? partMasses(part, index) : undefined;
    const name = label?.name ?? key;
    if (options.validation && measured === undefined) withoutValidation.push(name);
    products.set(index, productOf(key, name, part.shapes, label?.solids ?? [], measured === undefined ? undefined : combine(measured)));
    if (label?.entityId !== undefined && !faceted.includes(label.entityId)) productEntities[key] = label.entityId;
    for (const [at, child] of (part.children ?? []).entries()) {
      const used = label?.occurrences?.[at];
      if (used === undefined) continue;
      nested.push({
        parent: key,
        product: addPart(child.part, used.part),
        name: used.name,
        position: child.position,
        rotation: child.rotation,
      });
    }
    return key;
  };

  const top: ExchangeOccurrence[] = [];
  for (const [at, occurrence] of plan.occurrences.entries()) {
    const used = plan.labels.occurrences[at];
    if (used === undefined) continue;
    top.push({
      parent: null,
      product: addPart(occurrence.part, used.part),
      name: used.name,
      position: occurrence.position,
      rotation: occurrence.rotation,
    });
  }
  let rootValidation: ExchangeValidation | undefined;
  if (options.validation && hasInstances) {
    const placed = plan.occurrences.map((occurrence, at) => {
      const index = plan.labels.occurrences[at]?.part;
      const inner = index === undefined ? undefined : combine(partMasses(occurrence.part, index) ?? []);
      return inner === undefined ? undefined : placedMass(inner, occurrence.position, occurrence.rotation);
    });
    if (placed.every((mass): mass is Mass => mass !== undefined)) rootValidation = combine(placed);
  }
  return {
    products: [...products.entries()].sort(([a], [b]) => a - b).map(([, product]) => product),
    occurrences: hasInstances ? [...top, ...nested] : nested,
    ...(rootValidation === undefined ? {} : { rootValidation }),
    hasRoot: hasInstances,
    solidCount: 0,
    sheetCount: 0,
    entityIds: [],
    faceted: plan.faceted,
    skipped: [],
    withoutValidation,
    productEntities,
  };
}

/** The plan for `entityIds` (or the whole document), `{ empty }` when nothing is exportable, `{ failed }` when the kernel cannot build an entity. */
export function planExchange(
  doc: CadDocument,
  kernel: GeometryKernel,
  entityIds: readonly string[] | undefined,
  options: PlanOptions,
): ExchangePlan | { readonly empty: true; readonly skipped: readonly string[] } | { readonly failed: string } {
  const { solids, sheets, skipped, entries } = stepTargets(doc, entityIds);
  if (solids.length === 0 && sheets.length === 0) return { empty: true, skipped };
  const base = options.structured ? structuredPlan(doc, kernel, entries, options) : flatPlan(doc, kernel, solids, options);
  if ('failed' in base) return base;
  const faces: Entity[] = [];
  const sheetProducts: ExchangeProduct[] = [];
  const notBuilt: string[] = [];
  const labels = stepLabels(doc, sheets);
  for (const [index, sheet] of sheets.entries()) {
    const shape = kernel.evaluate(operandRecipe(kernel, sheet));
    if (shape === null) notBuilt.push(`${sheet.id} (surface sheet: this kernel cannot build B-spline faces)`);
    else {
      faces.push(sheet);
      sheetProducts.push(
        productOf(`sheet-${index}`, labels[index]?.name ?? sheet.id, [shape], [labels[index] ?? { name: sheet.id }], undefined),
      );
    }
  }
  if (base.products.length === 0 && sheetProducts.length === 0) return { empty: true, skipped: [...skipped, ...notBuilt] };
  return {
    ...base,
    products: [...base.products, ...sheetProducts],
    solidCount: solids.length,
    sheetCount: faces.length,
    entityIds: [...exportedIds(entries), ...faces.map((sheet) => sheet.id)],
    skipped: [...skipped, ...notBuilt],
  };
}
