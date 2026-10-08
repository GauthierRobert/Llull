/**
 * @layer kernel
 * STEP AP214 writer over exact OCC shapes (STEPControl_Writer into the Emscripten in-memory FS).
 * @invariant the scratch path is short and fixed: this opencascade.js build corrupts `Write` paths
 *   longer than ~12 characters, and the kernel is synchronous, so one path is never shared
 * @failure transfer or write not done -> null
 */

import { release, type OccApi, type OccHandle, type OccShape } from './occtTypes';

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
