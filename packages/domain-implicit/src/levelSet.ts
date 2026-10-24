/** Level-set form of an implicit body for export_3mf implicit: "levelset" (05 IMP 6.2, FR-IMP-52). */

import type { LevelSetAnswer } from '@core/geometry/field/levelSetExport';
import type { CadDocument } from '@core/model/types';
import { compileField } from './compile';
import { bodyOf } from './model';

/** Provider for the plugin hook `levelSet`: the compiled field of a body, or why it has no level-set form. */
export function levelSetOf(doc: CadDocument, entityId: string): LevelSetAnswer {
  const body = bodyOf(doc, entityId);
  if (body === undefined) return null;
  const compiled = compileField(doc, body.field);
  if (!compiled.ok) return compiled.message;
  if (compiled.program.strutSets.length > 0)
    return 'a strut or graph lattice is written as a beam lattice (export_3mf beamLattice) or a mesh: its level set would need a beam-lattice resource';
  return { program: compiled.program, minFeature: body.voxel, bounds: body.bounds };
}
