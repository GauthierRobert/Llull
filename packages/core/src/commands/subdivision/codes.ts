/** Stable refusal codes of the direct-editing cage commands (04 DIR TECHNICAL §7.1) and their one-line fixes. */

import { tableRejection } from '../noop';

export const DIR_REMEDIATION: Readonly<Record<string, string>> = {
  DIR_ENTITY_NOT_FOUND: 'Pass the id of a subdivision solid (add_subdivision_solid); `llull describe_scene` lists entity ids.',
  DIR_REF_LOST: 'Re-select with select_cage_elements (nearest / loopFrom) and edit the step params with the current ids.',
  DIR_ELEMENT_KIND: 'Pass the element kind the parameter names: vertex ids/indices, edge ids "e:<idA>|<idB>" or [a, b], face ids/indices.',
  DIR_SELECTION_EMPTY: 'Widen the region or pass element ids.',
  DIR_SELECTION_CONFLICT: 'Give one selection style: vertexIndices, vertices, edges, faces or region.',
  DIR_NOTHING_TO_DO: 'Give at least one of translate, rotate, scale, crease or levels.',
  DIR_SCALE_NONPOSITIVE: 'Use scale factors > 0; mirror with symmetry instead.',
  DIR_FALLOFF_INVALID: 'falloff is a radius >= 0 in document units, or { radius, shape, metric }.',
  DIR_LEVELS_RANGE: 'levels is an integer 0..4.',
  DIR_CAGE_TOO_LARGE: 'Reduce segments or edit a smaller cage: at most 2000 cage vertices.',
  DIR_SHARPNESS_RANGE: 'Sharpness is 0 (smooth) .. 10 (infinitely sharp).',
  DIR_CAGE_OPEN:
    'The cage must be closed (every edge shared by two faces), or pass `boundary` ("edge_and_corner" / "edge_only") to accept an open cage, or fill_cage_hole.',
  DIR_CAGE_EMPTY: 'The deletion would remove every face: delete the entity instead.',
  DIR_NOT_BOUNDARY: 'Pick an edge on a boundary loop (check_subdivision lists data.boundaryLoops).',
  DIR_FILL_ODD: 'mode "quads" needs a loop with an even number of edges: use mode "ngon", or loop-cut one side first.',
  DIR_WELD_NONMANIFOLD:
    'Weld fewer vertices (or only vertices of one edge / one boundary): the merge would make a non-manifold or inside-out cage.',
  DIR_SLIDE_RANGE: 'factor is within -1..1 (a fraction of the rung edge length; 0 does nothing).',
  DIR_SLIDE_LOOP_INVALID: 'Pick an edge whose loop has a face on the sliding side of every vertex (not on an open boundary).',
  DIR_BEVEL_TOO_WIDE: 'width is a fraction of the adjacent edges, at most just below 0.5: reduce width.',
  DIR_BEVEL_WIDTH_RANGE: 'width is a fraction 0 < width < 0.5 of the adjacent edge length.',
  DIR_BEVEL_ADJACENT: 'Bevel edges that share no vertex in one call; bevel the others in a further call.',
  DIR_BEVEL_BOUNDARY: 'Bevel interior edges (two faces); boundary edges cannot be bevelled.',
  DIR_BRIDGE_COUNT_MISMATCH: 'Select regions whose boundaries have the same number of vertices, or loop-cut one side.',
  DIR_BRIDGE_REGION:
    'Each side must be one edge-connected face region with a single boundary loop (no holes), or a boundary edge of a hole.',
  DIR_BRIDGE_SAME: 'The two sides must be different regions that share no vertex.',
  DIR_DISTANCE_ZERO: 'Give a non-zero, finite distance.',
  DIR_DIRECTION_ZERO: 'Give a non-zero direction vector or omit it to follow the face normal.',
  DIR_REGION_DEGENERATE: 'The selected faces have no usable normal (zero area or opposing faces): pass `direction`, or select fewer faces.',
  DIR_INSET_TOO_THICK: 'Reduce thickness below the reported limit.',
  DIR_LOOP_NOT_QUAD: 'Cut from another edge, or split the n-gon first (loop_cut_cage follows quads only).',
  DIR_LOOP_SELF_CROSS: 'Cut from an edge whose quad strip does not cross the same face twice.',
  DIR_REGION_PINCH:
    'The region boundary passes through one vertex twice: select faces that do not touch only at a vertex, or use `individual`.',
  DIR_LOOP_CUTS_RANGE: 'cuts is an integer 1..32 and factor is within 0..1 (single cut only).',
  DIR_SYMMETRY_UNPAIRED: 'Pass snap: true to move near-mirror vertices onto exact mirrors, or raise tolerance.',
  DIR_SYMMETRY_TOPOLOGY: 'Make the topology symmetric first (every face needs its mirror face).',
  DIR_SYMMETRY_BROKEN:
    'The result would not be mirror-symmetric: pick a symmetric selection / direction, or clear the symmetry with set_cage_symmetry planes [].',
  DIR_EVAL_DEGENERATE: 'Read limit / normal only, or sample off the extraordinary vertex; samples need quad faces and u, v in [0, 1].',
  DIR_EVAL_BUDGET: 'Evaluate at most 10000 points per call.',
  DIR_CONVERT_DEGENERATE: 'Fix the zero-area cage face (check_subdivision lists it), then retry.',
  DIR_CONVERT_KERNEL: 'Use output "sheets", or run on the native kernel (llull --app or LLULL_KERNEL unset).',
  DIR_CONVERT_FAILED: 'The kernel could not sew the patches: convert to sheets and sew_surfaces, or simplify the cage.',
  DIR_SELECTOR_INVALID: 'Give exactly one selector: nearest, loopFrom, ringFrom, region, within or faces.',
};

export const dirRejection = tableRejection(DIR_REMEDIATION);
