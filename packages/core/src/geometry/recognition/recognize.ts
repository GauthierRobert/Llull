/**
 * Exact feature recognition over a kernel's face graph (07 FTR §5.6): holes, pockets, bends, fillets and chamfers, all deterministic.
 * @invariant pure; never throws — topology no feature explains goes to `unclassified`
 */

import type { ShapeTopology } from '../kernel';
import type { FaceGraph } from '../kernelPorts';
import { buildModel } from './model';
import type { Group, Orientation } from './model';
import { recognizeBends, recognizeChamfers, recognizeFillets } from './blends';
import { recognizeHoles } from './holes';
import { recognizePockets } from './pockets';
import type { RecognizeOptions, Recognition } from './types';

/** Recognise the features of the shape described by `graph` and `topology`; only the requested `kinds` are reported. */
export function recognizeFeatures(
  graph: FaceGraph,
  topology: ShapeTopology,
  options: RecognizeOptions,
  orientation?: Orientation,
): Recognition {
  const model = buildModel(
    graph,
    topology,
    options.mergeSplitFaces,
    { length: options.lengthTolerance, angle: options.angularTolerance },
    orientation,
  );
  const taken = new Set<Group>();
  const holes = recognizeHoles(model, taken);
  const pockets = recognizePockets(model, taken);
  const bends = recognizeBends(model, taken);
  const fillets = recognizeFillets(model, taken);
  const chamfers = recognizeChamfers(model, taken);
  const wanted = (kind: RecognizeOptions['kinds'][number]): boolean => options.kinds.includes(kind);
  const unclassified = model.groups
    .filter((group) => !taken.has(group) && group.surface.type !== 'plane')
    .flatMap((group) => group.faces)
    .sort((a, b) => a - b);
  return {
    holes: wanted('hole') ? holes : [],
    pockets: wanted('pocket') ? pockets : [],
    bends: wanted('bend') ? bends : [],
    fillets: wanted('fillet') ? fillets : [],
    chamfers: wanted('chamfer') ? chamfers : [],
    unclassified,
  };
}
