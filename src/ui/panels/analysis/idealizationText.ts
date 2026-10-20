// One-line description of how a part is idealized for the analysis, and of the mesh controls (presentation only).

import type { Idealization, MeshControls } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { formatSignificant } from './quantityFormat';

const thicknessText = (value: number | 'auto', lengthUnit: string): string =>
  value === 'auto' ? 'auto' : `${formatSignificant(value)} ${lengthUnit}`;

/** The shell variant gains optional fields concurrently (`laminate`), so they are read defensively. */
export function idealizationText(idealization: Idealization | undefined, lengthUnit: string): string {
  if (idealization === undefined) return 'solid';
  if (idealization.kind === 'plane_stress') return `plane stress · thickness ${thicknessText(idealization.thickness, lengthUnit)}`;
  if (idealization.kind === 'shell') {
    const laminate: unknown = (idealization as { readonly laminate?: unknown }).laminate;
    const composite = isRecord(laminate) && typeof laminate['compositePartId'] === 'string' ? laminate['compositePartId'] : null;
    const base = `shell · thickness ${thicknessText(idealization.thickness, lengthUnit)} · offset ${idealization.offset}`;
    return composite === null ? base : `${base} · laminate ${composite}`;
  }
  if (idealization.kind === 'beam') return `beam · section ${idealization.section}`;
  return 'solid';
}

export function meshControlsText(mesh: MeshControls): string {
  const bonding = mesh.bonding === undefined ? '' : ` · bonding ${mesh.bonding}`;
  const refinements = mesh.refinements.length > 0 ? ` · ${mesh.refinements.length} refinements` : '';
  return `${mesh.mesher} · ${mesh.elementFamily} · order ${mesh.order} · size ${mesh.globalSize}${bonding}${refinements}`;
}
