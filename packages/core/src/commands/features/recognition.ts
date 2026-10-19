/** Kernel inputs of exact recognition: the face graph, topology and face orientation of a shape, and the default length tolerance. */

import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { FaceGraph, FaceQueryPort } from '../../geometry/kernelPorts';
import type { Orientation } from '../../geometry/recognition/model';
import { type CadDocument, type ShapeRecipe, is3D } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { currentContext } from '../context';
import { operandRecipe } from '../brep/kernelShape';
import { refuse } from './ftr';
import { meshCorners } from '../../geometry/meshExtent';
import { distance3 } from '../../lib/vec3';

export interface RecognitionInput {
  readonly graph: FaceGraph;
  readonly topology: ShapeTopology;
  readonly orientation: Orientation;
}

/** 1e-6 of the model's bounding-box diagonal (07 §5.8), at least 1e-7 of a millimetre-sized model. */
export function lengthToleranceOf(topology: ShapeTopology): number {
  const [min, max] = meshCorners({ positions: topology.edges.flatMap((edge) => [...edge.start, ...edge.mid, ...edge.end]) });
  return Math.max(1e-7, 1e-6 * distance3(min, max));
}

/**
 * The kernel's own answer to "which side is the material": the outward normal of planes (face details) and the sign of the mean curvature of
 * curved faces at their middle (negative = a bore or concave fillet). Raw face orientation flags are relative to the surface parametrisation,
 * which a swept face may mirror.
 */
function orientationOf(port: FaceQueryPort, shape: ShapeHandle, graph: FaceGraph): Orientation {
  const details = port.faceDetails(shape, { samples: 0 });
  const cavities = new Map<number, boolean | null>();
  return {
    outward: (face) => details?.[face]?.normal ?? null,
    cavity: (face) => {
      const known = cavities.get(face);
      if (known !== undefined) return known;
      const bounds = graph.faces[face]?.uvBounds;
      const sample =
        bounds === undefined ? undefined : port.faceSamples(shape, face, [[(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2]])?.[0];
      const cavity = sample === undefined || sample.degenerate ? null : sample.mean < 0;
      cavities.set(face, cavity);
      return cavity;
    },
  };
}

/**
 * @failure no face-query port -> 'no_port'; the kernel cannot build the shape or answer -> 'no_shape'
 */
export function recognitionOf(kernel: GeometryKernel, recipe: ShapeRecipe): RecognitionInput | 'no_port' | 'no_shape' {
  const port = kernel.faceQuery;
  if (port === undefined) return 'no_port';
  const shape = kernel.evaluate(recipe);
  const topology = shape === null ? null : kernel.topology(shape);
  const graph = shape === null ? null : port.faceGraph(shape);
  if (shape === null || topology === null || graph === null) return 'no_shape';
  return { graph, topology, orientation: orientationOf(port, shape, graph) };
}

/**
 * Recognition input of the solid `id` for `command`.
 * @failure not a 3D solid -> FTR_PART_NOT_FOUND (fix `partFix`); no exact B-rep / face graph -> FTR_NEEDS_EXACT_KERNEL
 */
export function solidRecognition(
  doc: CadDocument,
  command: string,
  id: string,
  ctx: ExecutionContext | undefined,
  partFix: string,
): { readonly input: RecognitionInput } | { readonly refusal: CommandResult } {
  const entity = doc.entities[id];
  if (!entity || !is3D(entity) || entity.kind === 'instance')
    return { refusal: refuse(doc, command, 'FTR_PART_NOT_FOUND', `no 3D solid '${id}'`, partFix, [id], ['id']) };
  const kernel = (ctx ?? currentContext()).kernel;
  const input = kernel === null ? 'no_port' : recognitionOf(kernel, operandRecipe(kernel, entity));
  if (typeof input === 'string')
    return {
      refusal: refuse(
        doc,
        command,
        'FTR_NEEDS_EXACT_KERNEL',
        input === 'no_port'
          ? 'this kernel has no face-query port (no exact B-rep)'
          : 'the kernel could not build the face graph of this solid',
        'rerun with --kernel occt-native; for imported parts use import_step_exact',
        [id],
      ),
    };
  return { input };
}
