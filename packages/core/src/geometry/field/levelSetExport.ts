/** What a plugin hands to the 3MF implicit writer for a body: its compiled field and the box that bounds it. */

import type { Vec3 } from '../../model/vectors';
import type { FieldProgram } from './program';

export interface LevelSetExport {
  /** The field in document units, negative inside. */
  readonly program: FieldProgram;
  /** Smallest feature to resolve, document units. */
  readonly minFeature: number;
  /** Box that contains the solid, document units. */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
}

/** A level set, the reason there is none (the body then exports as a mesh), or null when the entity is not a body of the plugin. */
export type LevelSetAnswer = LevelSetExport | string | null;
