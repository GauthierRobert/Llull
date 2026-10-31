/** add_voronoi_lattice: stochastic beam lattice from a seeded point process (05 IMP FR-IMP-19, M6). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { type VoronoiNode, fieldOf } from './model';
import { addNode } from './nodeResult';
import { voronoiGeometry } from './voronoi';

/**
 * @affects creates 1 voronoi node (a graph of beams along the edges of the Voronoi diagram of the seeds, cut to the bounding box of the region and clipped by the region)
 * @invariant deterministic for (region bounds, density, seed): the same integer seed gives the same lattice; the seed set is not stored, it is re-derived
 * @failure unknown region -> IMP_FIELD_NOT_FOUND; region without finite bounds -> IMP_FIELD_UNBOUNDED; density <= 0, non-integer or negative seed -> IMP_PARAM_RANGE; radius <= 0 -> IMP_STRUT_RADIUS_RANGE; no beam -> IMP_GRAPH_EMPTY; more than 100000 seeds (density x grown box volume), or more than 900000 beams (9 to 11 per seed) -> IMP_GRAPH_TOO_LARGE
 */
export const addVoronoiLattice = defineCommand({
  name: 'add_voronoi_lattice',
  annotations: { readsMeshTriangles: true },
  description:
    'Create a stochastic (Voronoi) strut lattice as an implicit FIELD: a seeded random point set with `density` seeds per document unit^3 fills the bounding box of `region`, and the beams run along the edges of its Voronoi diagram ' +
    '(about 9 beams per seed), cut to that box and clipped by the region field. The same seed gives the same lattice on every machine. Beams have a constant radius; cap "sphere" rounds the joints. ' +
    'At most 100000 seeds and 900000 beams (about 9 to 11 beams per seed: IMP_GRAPH_TOO_LARGE either way; the command takes 0.5 s for 10000 seeds and 1.5 s for 30000 on the TS side): lower the density or shrink the region otherwise. A body of a lattice that large needs a coarse voxel (a 90 mm cube of 1000000 beams realises natively in 15 s at voxel 2). Next: create_implicit_body (voxel well below radius), export_3mf beamLattice for printers that read beams.',
  params: z.object({
    region: z
      .string()
      .describe(
        'Id of a field with finite bounds (e.g. a box primitive or field_from_solid): its bounding box is filled and the lattice is clipped by it.',
      ),
    density: z.number().describe('Seeds per document unit^3 (> 0). The mean cell diameter is about density^(-1/3).'),
    seed: z.number().describe('Non-negative integer seed of the point process; the same seed gives the same lattice.'),
    radius: z.number().describe('Beam radius in document units (> 0).'),
    cap: z.enum(['sphere', 'butt']).optional().describe('End caps: sphere (default, rounded joints) or butt (flat).'),
    name: z.string().optional().describe('Optional label for the node.'),
  }),
  run: (doc, p): CommandResult => {
    const fail = (code: string, message: string, path: string, ids: readonly string[] = []): CommandResult =>
      refuseImplicit(doc, 'add_voronoi_lattice', code, message, ids, [`params.${path}`]);
    if (fieldOf(doc, p.region) === undefined) return fail('IMP_FIELD_NOT_FOUND', `no region field '${p.region}'`, 'region', [p.region]);
    if (!(Number.isFinite(p.density) && p.density > 0)) return fail('IMP_PARAM_RANGE', `density must be > 0 (got ${p.density})`, 'density');
    if (!(Number.isInteger(p.seed) && p.seed >= 0 && p.seed <= 0xffffffff))
      return fail('IMP_PARAM_RANGE', `seed must be an integer in 0..4294967295 (got ${p.seed})`, 'seed');
    if (!(Number.isFinite(p.radius) && p.radius > 0))
      return fail('IMP_STRUT_RADIUS_RANGE', `radius must be > 0 (got ${p.radius})`, 'radius');
    const region = compileField(doc, p.region);
    if (!region.ok) return fail(region.code, region.message, 'region', region.ids);
    const box = region.program.bounds;
    if (box === null) return fail('IMP_FIELD_UNBOUNDED', `region '${p.region}' has no finite bounds`, 'region', [p.region]);
    const node: VoronoiNode = {
      id: nextId('fld'),
      op: 'voronoi',
      min: box.min,
      max: box.max,
      density: p.density,
      seed: p.seed,
      radius: p.radius,
      cap: p.cap ?? 'sphere',
      region: p.region,
      ...(p.name === undefined ? {} : { name: p.name }),
    };
    const built = voronoiGeometry(node);
    if (!built.ok) return fail(built.code, built.message, 'density', [p.region]);
    const { set, dropped, totalLength } = built.graph;
    return addNode(doc, 'add_voronoi_lattice', node, `${set.beams.length} beams between ${set.nodes.length} nodes, seed ${p.seed}`, {
      beams: set.beams.length,
      nodes: set.nodes.length,
      dropped,
      totalLength,
      radius: p.radius,
      seed: p.seed,
    });
  },
});
