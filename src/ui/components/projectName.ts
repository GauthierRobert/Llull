/**
 * @layer ui/components
 * Project-name helpers: the display name and the file-name stem derived from it.
 */

import type { CadDocument } from '@core/model/types';
import { fileSlug } from '@aec/model';

const DEFAULT_PROJECT_NAME = 'Untitled project';

/** The user-set project name, or null while it is unset / still the default. */
export function projectNameOf(doc: Pick<CadDocument, 'building'>): string | null {
  const name = doc.building?.project.name.trim() ?? '';
  return name === '' || name === DEFAULT_PROJECT_NAME ? null : name;
}

/** File-name stem for Save: sanitised project name, else `fallback`. */
export function projectFileStem(doc: Pick<CadDocument, 'building'>, fallback: string): string {
  const name = projectNameOf(doc);
  return name === null ? fallback : fileSlug(name, fallback);
}
