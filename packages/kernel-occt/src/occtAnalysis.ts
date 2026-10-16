/**
 * Validity, lumps and distance of OCC shapes (`GeometryKernel.analyze` / `distance`, PHY-21 TR-FPR-01).
 * Bindings used (checked against opencascade.js 1.1.1): BRepCheck_Analyzer.IsValid_2, ShapeAnalysis_ShapeContents (NbFreeFaces, NbFreeEdges),
 * BRepGProp.VolumeProperties_1 / SurfaceProperties_1, BRepBndLib.Add, BRepExtrema_DistShapeShape_1 (LoadS1, LoadS2, Perform, Value,
 * PointOnShape1/2, InnerSolution).
 * @failure an OCC exception or an unsolved distance -> null
 */

import type { ShapeAnalysis, ShapeDistance } from '@core/geometry/kernel';
import type { Vec3 } from '@core/model/types';
import { release } from '@core/geometry/nativeObject';
import { type OccApi, type OccHandle, type OccPoint, type OccShape } from './occtTypes';
import { uniqueSubShapes } from './occtTopology';

interface GProps extends OccHandle {
  Mass(): number;
}

interface Contents extends OccHandle {
  Perform(shape: OccShape): void;
  NbFreeFaces(): number;
  NbFreeEdges(): number;
}

interface BoundingBox extends OccHandle {
  CornerMin(): OccPoint;
  CornerMax(): OccPoint;
}

interface Extrema extends OccHandle {
  LoadS1(shape: OccShape): boolean;
  LoadS2(shape: OccShape): boolean;
  Perform(): boolean;
  IsDone(): boolean;
  Value(): number;
  InnerSolution(): boolean;
  PointOnShape1(index: number): OccPoint;
  PointOnShape2(index: number): OccPoint;
}

const xyz = (point: OccPoint): Vec3 => {
  const out: Vec3 = [point.X(), point.Y(), point.Z()];
  release(point);
  return out;
};

function massOf(api: OccApi, shape: OccShape): { volume: number; area: number } {
  const volume = new api.GProp_GProps_1() as GProps;
  const area = new api.GProp_GProps_1() as GProps;
  api.BRepGProp.VolumeProperties_1(shape, volume, false, false, false);
  api.BRepGProp.SurfaceProperties_1(shape, area, false, false);
  const out = { volume: Math.abs(volume.Mass()), area: area.Mass() };
  release(volume);
  release(area);
  return out;
}

function boundsOf(api: OccApi, shape: OccShape): { min: Vec3; max: Vec3 } {
  const box = new api.Bnd_Box_1() as BoundingBox;
  api.BRepBndLib.Add(shape, box, false);
  const bounds = { min: xyz(box.CornerMin()), max: xyz(box.CornerMax()) };
  release(box);
  return bounds;
}

/** BRepCheck validity, free faces / edges, and one lump per TopAbs_SOLID. */
export function analyzeShape(api: OccApi, shape: OccShape): ShapeAnalysis {
  const checker = new api.BRepCheck_Analyzer(shape, true) as OccHandle & { IsValid_2(): boolean };
  const valid = checker.IsValid_2();
  release(checker);
  const contents = new api.ShapeAnalysis_ShapeContents() as Contents;
  contents.Perform(shape);
  const freeFaces = contents.NbFreeFaces();
  const freeEdges = contents.NbFreeEdges();
  release(contents);
  const solids = uniqueSubShapes(api, shape, 'TopAbs_SOLID');
  const lumps = solids.map((solid) => ({ ...massOf(api, solid), bounds: boundsOf(api, solid) }));
  solids.forEach(release);
  const total = massOf(api, shape);
  return {
    valid,
    status: valid ? 'valid' : 'BRepCheck_Analyzer reports an invalid shape',
    closed: valid && solids.length > 0 && freeFaces === 0 && freeEdges === 0,
    volume: lumps.reduce((sum, lump) => sum + lump.volume, 0),
    area: total.area,
    lumps,
    freeFaces,
  };
}

/** Exact minimum distance (BRepExtrema_DistShapeShape); `inside` when a solid contains the other (inner solution). */
export function shapeDistance(api: OccApi, a: OccShape, b: OccShape): ShapeDistance | null {
  const extrema = new api.BRepExtrema_DistShapeShape_1() as Extrema;
  try {
    extrema.LoadS1(a);
    extrema.LoadS2(b);
    if (!extrema.Perform() || !extrema.IsDone()) return null;
    return {
      distance: extrema.Value(),
      pointA: xyz(extrema.PointOnShape1(1)),
      pointB: xyz(extrema.PointOnShape2(1)),
      inside: extrema.InnerSolution(),
    };
  } finally {
    release(extrema);
  }
}
