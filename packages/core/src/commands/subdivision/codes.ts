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
    'The cage must be closed (every edge shared by two faces); open cages arrive with the boundary option in a later milestone.',
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
  DIR_SELECTOR_INVALID: 'Give exactly one selector: nearest, loopFrom, ringFrom, region, within or faces.',
};

export const dirRejection = tableRejection(DIR_REMEDIATION);
