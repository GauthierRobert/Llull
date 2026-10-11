/**
 * @layer kernel
 * Exact freeform solids: each bicubic Bézier patch of a subdivision solid (core
 * subdivisionPatches) becomes one B-spline face; neighbours share their boundary poles, so the
 * faces sew into a closed shell and a solid with true B_SPLINE_SURFACE geometry (STEP, booleans).
 * This opencascade.js build exposes no 2D pole array, so each surface starts as a Coons patch of
 * four placeholder cubic boundaries (already 4 × 4 poles) whose sixteen poles are then set.
 * @failure a patch OCC refuses or throws on, or a shell that does not close -> null (caller falls
 *   back to the subdivided triangles)
 */

import type { SubdivisionEntity } from '@core/model/types';
import { type BezierPatch, subdivisionPatches } from '@core/geometry/subdivisionPatches';
import {
  explorer,
  release,
  type OccApi,
  type OccHandle,
  type OccMakeFace,
  type OccMakeSolid,
  type OccSewing,
  type OccShape,
  type OccTopoDS,
} from './occtTypes';

interface OccBSplineSurface extends OccHandle {
  NbUPoles(): number;
  NbVPoles(): number;
  SetPole_1(i: number, j: number, pole: OccHandle): void;
}

/** Unit-square boundary as four straight cubic B-spline curves, end to start. */
function placeholderBoundaries(api: OccApi): OccHandle[] {
  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  return corners.map(([x0, y0], k) => {
    const [x1, y1] = corners[(k + 1) % 4] as [number, number];
    const poles = new api.TColgp_Array1OfPnt_2(1, 4);
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const pole = new api.gp_Pnt_3(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0) as OccHandle;
      poles.SetValue(i + 1, pole);
      pole.delete();
    }
    const knots = new api.TColStd_Array1OfReal_2(1, 2);
    knots.SetValue(1, 0);
    knots.SetValue(2, 1);
    const multiplicities = new api.TColStd_Array1OfInteger_2(1, 2);
    multiplicities.SetValue(1, 4);
    multiplicities.SetValue(2, 4);
    const curve = new api.Geom_BSplineCurve_1(poles, knots, multiplicities, 3, false);
    [poles, knots, multiplicities].forEach(release);
    return new api.Handle_Geom_BSplineCurve_2(curve) as OccHandle;
  });
}

/** B-spline face whose poles are `patch` (u along i, v along j); null when OCC refuses it. */
function patchFace(api: OccApi, patch: BezierPatch, boundaries: OccHandle[]): OccShape | null {
  const filling = new api.GeomFill_BSplineCurves_2(
    ...boundaries,
    api.GeomFill_FillingStyle.GeomFill_CoonsStyle,
  ) as OccHandle & { Surface(): OccHandle & { get(): OccBSplineSurface } };
  const surfaceHandle = filling.Surface();
  const surface = surfaceHandle.get();
  try {
    if (surface.NbUPoles() !== 4 || surface.NbVPoles() !== 4) return null;
    patch.forEach(([x, y, z], index) => {
      const pole = new api.gp_Pnt_3(x, y, z) as OccHandle;
      surface.SetPole_1(Math.floor(index / 4) + 1, (index % 4) + 1, pole);
      pole.delete();
    });
    const asSurface = new api.Handle_Geom_Surface_2(surface) as OccHandle;
    const maker = new api.BRepBuilderAPI_MakeFace_8(asSurface, 1e-7) as OccMakeFace;
    const face = maker.IsDone() ? maker.Face() : null;
    [maker, asSurface].forEach(release);
    return face;
  } finally {
    [surfaceHandle, filling].forEach(release);
  }
}

/** Sew `faces` (released here) into one solid; null unless they close into shells. */
function sewnSolid(api: OccApi, faces: OccShape[], tolerance: number): OccShape | null {
  const sewing: OccSewing = new api.BRepBuilderAPI_Sewing(tolerance, true, true, true, false);
  for (const face of faces) {
    sewing.Add(face);
    release(face);
  }
  const noProgress = new api.Handle_Message_ProgressIndicator_1();
  sewing.Perform(noProgress);
  noProgress.delete();
  const open = sewing.NbFreeEdges() > 0;
  const sewn = open ? null : (sewing.SewedShape() as OccShape | null);
  sewing.delete();
  if (sewn === null) return null;
  const makeSolid: OccMakeSolid = new api.BRepBuilderAPI_MakeSolid_1();
  const shells = explorer(api, sewn, 'TopAbs_SHELL');
  let count = 0;
  while (shells.More()) {
    const current = shells.Current();
    const shell = (api.TopoDS as OccTopoDS).Shell_1(current);
    makeSolid.Add(shell);
    [shell, current].forEach(release);
    count++;
    shells.Next();
  }
  shells.delete();
  release(sewn);
  if (count !== 1) {
    makeSolid.delete();
    return null;
  }
  makeSolid.Build();
  const solid = makeSolid.IsDone() ? makeSolid.Shape() : null;
  makeSolid.delete();
  return solid;
}

/** Exact B-spline solid of a smooth subdivision entity in its own frame; null on failure. */
export function subdivisionBSplineSolid(api: OccApi, entity: SubdivisionEntity): OccShape | null {
  const patches = subdivisionPatches(entity);
  const span = Math.max(...entity.vertices.flatMap((p) => p.map(Math.abs)), 1);
  const boundaries = placeholderBoundaries(api);
  const faces: OccShape[] = [];
  try {
    for (const patch of patches) {
      const face = patchFace(api, patch, boundaries);
      if (face === null) {
        faces.forEach(release);
        return null;
      }
      faces.push(face);
    }
  } catch {
    // An OCC exception here must not refuse the solid: the caller falls back to its triangles.
    faces.forEach(release);
    return null;
  } finally {
    boundaries.forEach(release);
  }
  try {
    return sewnSolid(api, faces, span * 1e-7);
  } catch {
    return null;
  }
}
