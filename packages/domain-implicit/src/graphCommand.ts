/** add_graph_lattice: beams along sketched curves as a field (05 IMP 4.2, FR-IMP-18). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { refuseImplicit } from './codes';
import { graphGeometry } from './graph';
import { type GraphNode, fieldOf } from './model';
import { addNode } from './nodeResult';

/**
 * @affects creates 1 graph node that references the source curves (they are not copied, hidden or changed)
 * @invariant straight pieces are single beams, curved pieces are sampled to chords of at most `chord`; nodes closer than mergeTolerance are one node; beams are 3MF-style frusta (radius varies linearly along each source curve) with the chosen end caps
 * @failure unknown source -> IMP_ENTITY_NOT_FOUND; no beam -> IMP_GRAPH_EMPTY; more than 100000 beams -> IMP_GRAPH_TOO_LARGE; radius <= 0, chord <= 0 -> IMP_PARAM_RANGE or IMP_STRUT_RADIUS_RANGE; unknown region -> IMP_FIELD_NOT_FOUND
 */
export const addGraphLattice = defineCommand({
  name: 'add_graph_lattice',
  description:
    'Create a graph (beam) lattice as an implicit FIELD from sketched curves: lines, polylines, arcs, circles, ellipses, rectangles, splines (2D sketch entities) and nurbs_curve entities in the document. ' +
    'Straight pieces become one beam each; curved pieces are sampled into chords of at most `chord` document units. Nodes closer than mergeTolerance are merged; zero-length and duplicate beams are dropped and counted in data.dropped. ' +
    'The beam radius varies linearly along each source curve from radiusStart to radiusEnd (document units); cap "sphere" puts a ball of the end radius on every beam end (a rounded joint), "butt" leaves flat ends. ' +
    'The sources must stay as they are while a body depends on this node (IMP_SOURCE_IN_USE). region (a field id) clips the graph. Next: create_implicit_body (the field is bounded by the beams), lattice_properties, export_3mf beamLattice.',
  params: z.object({
    sourceIds: z
      .array(z.string())
      .min(1)
      .max(500)
      .describe(
        'Ids of the curve entities (lines, polylines, arcs, circles, ellipses, rectangles, splines, nurbs_curve) that carry the beams.',
      ),
    radiusStart: z
      .number()
      .describe('Beam radius at the start of each source curve in document units (> 0; 2 * radius is the strut diameter).'),
    radiusEnd: z
      .number()
      .optional()
      .describe('Beam radius at the end of each source curve in document units (> 0). Default: radiusStart (constant).'),
    cap: z.enum(['sphere', 'butt']).optional().describe('End caps: sphere (default, rounded joints) or butt (flat).'),
    chord: z.number().optional().describe('Largest chord of the beams that approximate curved pieces, document units (> 0). Default 1.'),
    mergeTolerance: z.number().optional().describe('Nodes closer than this are one node, document units (>= 0). Default 1e-6.'),
    region: z.string().optional().describe('Id of a field that clips the graph (kept where that field is negative).'),
    name: z.string().optional().describe('Optional label for the node.'),
  }),
  run: (doc, p): CommandResult => {
    const fail = (code: string, message: string, path: string, ids: readonly string[] = []): CommandResult =>
      refuseImplicit(doc, 'add_graph_lattice', code, message, ids, [`params.${path}`]);
    const radiusEnd = p.radiusEnd ?? p.radiusStart;
    if (![p.radiusStart, radiusEnd].every((r) => Number.isFinite(r) && r > 0))
      return fail('IMP_STRUT_RADIUS_RANGE', `radii must be > 0 (got ${p.radiusStart}, ${radiusEnd})`, 'radiusStart');
    const chord = p.chord ?? 1;
    if (!(Number.isFinite(chord) && chord > 0)) return fail('IMP_PARAM_RANGE', `chord must be > 0 (got ${chord})`, 'chord');
    const mergeTolerance = p.mergeTolerance ?? 1e-6;
    if (!(Number.isFinite(mergeTolerance) && mergeTolerance >= 0))
      return fail('IMP_PARAM_RANGE', `mergeTolerance must be >= 0 (got ${mergeTolerance})`, 'mergeTolerance');
    if (p.region !== undefined && fieldOf(doc, p.region) === undefined)
      return fail('IMP_FIELD_NOT_FOUND', `no region field '${p.region}'`, 'region', [p.region]);
    const node: GraphNode = {
      id: nextId('fld'),
      op: 'graph',
      sourceIds: p.sourceIds,
      radiusStart: p.radiusStart,
      radiusEnd,
      cap: p.cap ?? 'sphere',
      chord,
      mergeTolerance,
      ...(p.region === undefined ? {} : { region: p.region }),
      ...(p.name === undefined ? {} : { name: p.name }),
    };
    const built = graphGeometry(doc, node);
    if (!built.ok) return fail(built.code, built.message, 'sourceIds', built.ids);
    const { set, dropped, totalLength, radiusMax } = built.graph;
    return addNode(
      doc,
      'add_graph_lattice',
      node,
      `${set.beams.length} beams between ${set.nodes.length} nodes from ${p.sourceIds.length} source(s)`,
      { beams: set.beams.length, nodes: set.nodes.length, dropped, totalLength, radiusMax, sources: p.sourceIds },
    );
  },
});
