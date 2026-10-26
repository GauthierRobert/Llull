/**
 * What the builder of a profile blend reports (DES-6c step 2, TECHNICAL_SPEC §13.11): read from the kernel after the blend built, turned into the
 * sentences of the summary and the `data` of `fillet_edge`.
 * @invariant pure over a kernel's answer; lengths in document units; a kernel without `blendReport`, or a report without notes, gives nothing
 */

import type { BlendBuildNotes } from '../../geometry/kernelPorts';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { ShapeRecipe } from '../../model/types';

export interface ProfileData {
  readonly builder: BlendBuildNotes['builder'];
  readonly unit: string;
  readonly gap?: number;
  readonly gapLimit?: number;
  readonly junctionG1?: number;
  readonly mixed?: boolean;
  readonly fallback?: { readonly edges: readonly string[]; readonly reason: string };
  readonly cornerSetbackFactor?: number;
  readonly corners?: ReadonlyArray<{
    readonly vertex: readonly [number, number, number];
    readonly setbacks: ReadonlyArray<{ readonly edge: string; readonly distance: number }>;
  }>;
}

/** The notes of the built blend `recipe` (a fillet node with a profile), or null. */
export function readProfileNotes(kernel: GeometryKernel, recipe: ShapeRecipe): BlendBuildNotes | null {
  return kernel.blendReport?.(recipe)?.notes ?? null;
}

const nameOf = (topology: ShapeTopology | null, edge: number): string => topology?.edges[edge]?.name ?? `edge ${edge}`;

/** The summary sentences and the `data` for `notes`; edges are named from `topology` (the source solid). */
export function describeProfileNotes(
  notes: BlendBuildNotes,
  topology: ShapeTopology | null,
  unit: string,
): { readonly text: string; readonly data: ProfileData } {
  const fallback =
    notes.fallback === undefined
      ? undefined
      : { edges: notes.fallback.edges.map((edge) => nameOf(topology, edge)), reason: notes.fallback.reason };
  const corners = notes.corners?.map((corner) => ({
    vertex: corner.vertex,
    setbacks: corner.setbacks.map((entry) => ({ edge: nameOf(topology, entry.edge), distance: entry.distance })),
  }));
  const data: ProfileData = {
    builder: notes.builder,
    unit,
    ...(notes.gap === undefined ? {} : { gap: notes.gap }),
    ...(notes.gapLimit === undefined ? {} : { gapLimit: notes.gapLimit }),
    ...(notes.junctionG1 === undefined ? {} : { junctionG1: notes.junctionG1 }),
    ...(notes.mixed === undefined ? {} : { mixed: notes.mixed }),
    ...(fallback === undefined ? {} : { fallback }),
    ...(notes.factor === undefined ? {} : { cornerSetbackFactor: notes.factor }),
    ...(corners === undefined ? {} : { corners }),
  };
  const parts: string[] = [];
  if (fallback !== undefined)
    parts.push(
      `curvature profile on ${fallback.edges.join(', ')} fell back to the G1 quartic (support curvature jumps at a chain junction; G2 does not hold there)`,
    );
  if (notes.gap !== undefined && notes.gapLimit !== undefined)
    parts.push(`measured gap to the neighbouring faces ${notes.gap.toPrecision(3)} ${unit} (limit ${notes.gapLimit.toPrecision(3)})`);
  if (notes.junctionG1 !== undefined && notes.junctionG1 > 0)
    parts.push(`blends of a chain meet at up to ${notes.junctionG1.toPrecision(3)} rad (limit 0.0095)`);
  if (notes.factor !== undefined && notes.corners !== undefined)
    parts.push(`${notes.corners.length} corner patch(es), setback ${notes.factor} x the least distance`);
  return { text: parts.length === 0 ? '' : ` Profile: ${parts.join('; ')}.`, data };
}
