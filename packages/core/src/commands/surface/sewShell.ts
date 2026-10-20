/** The shell branch of sew_surfaces: several sheets sewn into one closed solid (a triangle mesh) with a free-edge report. */

import type { CadDocument, Entity, NurbsSurfaceEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { changed } from '../noop';
import { newEntity } from '../entity/newEntity';
import { replaceEntities } from '../entity/entityOps';
import { nextId } from '../../lib/id';
import { sewParts, sheetShellMesh } from '../../lib/nurbs/shellMesh';
import { placedSurface, surfacePoleExtent } from '../../geometry/nurbsSurface';
import { refuseSrf } from './shared';
import { isRefusal, sig, sigVec, surfaceEntityOf } from './surfaceShared';

/**
 * Sews the sheets `ids` into one closed solid mesh, or refuses with the free edges that remain.
 * @invariant every sheet edge is sampled identically on both sides of a shared edge (equal arc length), so closed shells weld without cracks
 */
export function sewIntoSolid(
  doc: CadDocument,
  ids: ReadonlyArray<string>,
  tolerance: number | undefined,
  resolution: number,
): CommandResult {
  const sheets: NurbsSurfaceEntity[] = [];
  for (const id of ids) {
    const sheet = surfaceEntityOf(doc, 'sew_surfaces', id);
    if (isRefusal(sheet)) return sheet;
    if ((sheet.trims?.length ?? 0) > 0)
      return refuseSrf(doc, 'sew_surfaces', 'SRF_TRIM_UNSUPPORTED', 'sheets trimmed by curves cannot be sewn', [id], ['params.ids']);
    sheets.push(sheet);
  }
  const surfaces = sheets.map(placedSurface);
  const size = Math.max(
    ...surfaces.map(surfacePoleExtent).flatMap(({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
    1e-9,
  );
  const tol = tolerance ?? 1e-6 * size;
  if (!(tol > 0)) return refuseSrf(doc, 'sew_surfaces', 'SRF_PARAM_INVALID', 'tolerance must be > 0', [...ids], ['params.tolerance']);
  const parts = surfaces.map((surface) => sheetShellMesh(surface, size / resolution, tol, Math.max(7, resolution + 1)));
  const shell = sewParts(parts, tol);
  if (shell.freeEdges.length > 0) {
    const near = shell.freeEdges
      .slice(0, 4)
      .map(([a, b]) => `[${sigVec([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]).join(', ')}]`)
      .join(' ');
    return refuseSrf(
      doc,
      'sew_surfaces',
      'SRF_SEW_FREE_EDGES',
      `${shell.freeEdges.length} free edge(s) remain after sewing within ${sig(tol)} ${doc.units}, e.g. near ${near}: the sheets do not close a shell`,
      [...ids],
      ['params.ids', 'params.tolerance'],
    );
  }
  if (shell.nonManifoldEdges > 0)
    return refuseSrf(
      doc,
      'sew_surfaces',
      'SRF_SEW_NONMANIFOLD',
      `${shell.nonManifoldEdges} edge(s) are shared by more than two sheets (e.g. near ${shell.nonManifoldAt.map((p) => `[${sigVec(p).join(', ')}]`).join(' ')}): the shell is not a manifold solid`,
      [...ids],
      ['params.ids'],
    );
  const first = sheets[0] as NurbsSurfaceEntity;
  const solid: Entity = newEntity(
    'mesh',
    nextId('mesh'),
    { mesh: { positions: shell.positions, indices: shell.indices } },
    [0, 0, 0],
    first.color,
    { layerId: first.layerId },
  );
  return {
    ...changed(
      replaceEntities(doc, [...ids], solid),
      `sew_surfaces: sewed ${ids.length} sheet(s) into closed mesh solid "${solid.id}" (${shell.indices.length / 3} triangles, 0 free edges, volume ${sig(shell.volume)} ${doc.units}^3 from the tessellation).`,
      [solid.id],
    ),
    data: {
      id: solid.id,
      sheets: ids.length,
      triangles: shell.indices.length / 3,
      freeEdges: 0,
      weldedVertices: shell.weldedVertices,
      volume: sig(shell.volume),
      volumeUnit: `${doc.units}^3`,
      tolerance: sig(tol),
      unit: doc.units,
      unverified: false,
      provenance: {
        method:
          'sheets meshed with equal arc-length boundary samples, welded within the tolerance; free edges counted, orientation propagated, volume by the divergence theorem',
        reference: 'closed triangle mesh; exact B-rep sewing needs the native kernel (BRepBuilderAPI_Sewing)',
        inputs: { ids },
      },
    },
  };
}
