/**
 * STEP AP214 writer over exact OCC shapes (STEPControl_Writer into the Emscripten in-memory FS).
 * @invariant the scratch path is short and fixed: this opencascade.js build corrupts `Write` paths
 *   longer than ~12 characters, and the kernel is synchronous, so one path is never shared
 * @failure transfer or write not done -> null
 */

import { release } from '@core/geometry/nativeObject';
import type { StepAssemblyPart, StepOccurrence } from '@core/geometry/kernel';
import { placementTransform } from './occtShapes';
import { type OccApi, type OccHandle, type OccShape } from './occtTypes';

interface StepWriter extends OccHandle {
  Transfer(shape: OccShape, mode: unknown, compgraph: boolean): unknown;
  Write(path: string): unknown;
}

const SCRATCH_PATH = '/out.step';

/** STEP text of `shapes` (one product per solid), or null when OCC refuses them. */
export function writeStep(api: OccApi, shapes: readonly OccShape[]): string | null {
  const done = api.IFSelect_ReturnStatus.IFSelect_RetDone;
  const writer = new api.STEPControl_Writer_1() as StepWriter;
  try {
    for (const shape of shapes) {
      const mode = api.STEPControl_StepModelType.STEPControl_AsIs;
      if (writer.Transfer(shape, mode, true) !== done) return null;
    }
    if (writer.Write(SCRATCH_PATH) !== done) return null;
    return api.FS.readFile(SCRATCH_PATH, { encoding: 'utf8' }) as string;
  } finally {
    try {
      api.FS.unlink(SCRATCH_PATH);
    } catch {
      /* never written */
    }
    release(writer);
  }
}

interface Compound extends OccShape {
  Moved(location: OccHandle): OccShape;
}

interface CompoundBuilder extends OccHandle {
  MakeCompound(compound: OccShape): void;
  Add(compound: OccShape, child: OccShape): void;
}

/**
 * STEP text of a root assembly: each distinct part is one compound written once (one product), each occurrence a `Moved` reference to it
 * (one NEXT_ASSEMBLY_USAGE_OCCURRENCE with an ITEM_DEFINED_TRANSFORMATION). The OCC STEP translator writes a compound of located
 * compounds as an assembly; XCAF (XCAFDoc_ShapeTool.AddComponent) is not exposed by this opencascade.js build.
 * @failure transfer or write not done -> null
 */
export function writeStepAssembly(api: OccApi, occurrences: readonly StepOccurrence<OccShape>[]): string | null {
  const builder = new api.BRep_Builder() as CompoundBuilder;
  const owned: OccHandle[] = [builder];
  const writer = new api.STEPControl_Writer_1() as StepWriter;
  try {
    const compoundOf = new Map<StepAssemblyPart<OccShape>, Compound | null>();
    // a location composes with the ones inside the part (TopLoc_Location product), so a nested part is written once
    const place = (reference: Compound, { position, rotation }: StepOccurrence<OccShape>): Compound => {
      const transform = placementTransform(api, rotation, position);
      const location = new api.TopLoc_Location_2(transform) as OccHandle;
      const moved = reference.Moved(location);
      owned.push(moved, location, transform);
      return moved as Compound;
    };
    const compound = (part: StepAssemblyPart<OccShape>): Compound | null => {
      const known = compoundOf.get(part);
      if (known !== undefined) return known;
      compoundOf.set(part, null);
      const made = new api.TopoDS_Compound() as Compound;
      owned.push(made);
      builder.MakeCompound(made);
      for (const shape of part.shapes) builder.Add(made, shape);
      for (const child of part.children ?? []) {
        const inner = compound(child.part);
        if (inner === null) return null;
        builder.Add(made, place(inner, child));
      }
      compoundOf.set(part, made);
      return made;
    };
    const root = new api.TopoDS_Compound() as Compound;
    owned.push(root);
    builder.MakeCompound(root);
    for (const occurrence of occurrences) {
      const prototype = compound(occurrence.part);
      if (prototype === null) return null;
      builder.Add(root, place(prototype, occurrence));
    }
    if (writer.Transfer(root, api.STEPControl_StepModelType.STEPControl_AsIs, true) !== api.IFSelect_ReturnStatus.IFSelect_RetDone)
      return null;
    if (writer.Write(SCRATCH_PATH) !== api.IFSelect_ReturnStatus.IFSelect_RetDone) return null;
    return api.FS.readFile(SCRATCH_PATH, { encoding: 'utf8' }) as string;
  } finally {
    try {
      api.FS.unlink(SCRATCH_PATH);
    } catch {
      /* never written */
    }
    release(writer);
    owned.forEach(release);
  }
}
