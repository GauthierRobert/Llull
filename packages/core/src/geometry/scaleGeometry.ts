/** Uniform scaling of an entity's kind-specific geometry about its local origin (scale_entity, instance expansion). */

import { withCurve } from '../model/curveEntity';
import type { Entity, MeshSolidEntity, Vec2, Vec3 } from '../model/types';
import type { SweepSection } from '../model/sweepOrientation';
import type { CurveSegment } from '../model/curve';
import { mapSegment } from './curveSegments';
import { scaleCurve } from './nurbsCurve';
import { scaleSurface } from './nurbsSurface';
import { scaledSweepDesign } from './sweepEval/scaleDesign';
import { scaledDecals } from './decal';
import { scale3 } from '../lib/vec3';
import { scale2 } from '../lib/vec2';

/** `{ curves }` scaled by `f` when the entity carries exact curves. */
function scaledCurves(e: { curves?: ReadonlyArray<CurveSegment<Vec2>> }, f: number): { curves?: ReadonlyArray<CurveSegment<Vec2>> } {
  return e.curves === undefined ? {} : { curves: e.curves.map((segment) => mapSegment(segment, (p: Vec2) => scale2(p, f))) };
}

function scaledSection(section: SweepSection, f: number): SweepSection {
  if (section.shape === 'circle') {
    const { radius, innerRadius } = section;
    return { shape: 'circle', radius: radius * f, ...(innerRadius !== undefined ? { innerRadius: innerRadius * f } : {}) };
  }
  return { shape: 'profile', profile: section.profile.map((p) => scale2(p, f)), ...scaledCurves(section, f) };
}

/** Scaled copy of `e` about its local origin plus the summary fragment describing the result. */
export function scaleGeometry(e: Entity, f: number): { scaled: Entity; dims: string } {
  const result = scaleKindGeometry(e, f);
  if (e.decals === undefined) return result;
  return { scaled: { ...result.scaled, decals: scaledDecals(e.decals, f) } as Entity, dims: result.dims };
}

function scaleKindGeometry(e: Entity, f: number): { scaled: Entity; dims: string } {
  switch (e.kind) {
    case 'box':
    case 'wedge': {
      const size = scale3(e.size, f);
      return { scaled: { ...e, size }, dims: `new size [${size.join(', ')}]` };
    }
    case 'cylinder':
    case 'cone': {
      const radius = e.radius * f;
      const height = e.height * f;
      return { scaled: { ...e, radius, height }, dims: `new radius ${radius}, height ${height}` };
    }
    case 'sphere': {
      const radius = e.radius * f;
      return { scaled: { ...e, radius }, dims: `new radius ${radius}` };
    }
    case 'extrusion': {
      const depth = e.depth * f;
      return { scaled: { ...e, profile: e.profile.map((p) => scale2(p, f)), depth, ...scaledCurves(e, f) }, dims: `new depth ${depth}` };
    }
    case 'line': {
      const start = scale2(e.start, f);
      const end = scale2(e.end, f);
      return { scaled: { ...e, start, end }, dims: `new start [${start.join(', ')}] end [${end.join(', ')}]` };
    }
    case 'nurbs_surface':
      return {
        scaled: { ...e, surface: scaleSurface(e.surface, f) },
        dims: `scaled ${e.surface.poles.length} x ${e.surface.poles[0]?.length ?? 0} poles`,
      };
    case 'nurbs_curve':
      return { scaled: withCurve(e, scaleCurve(e.curve, f)), dims: `scaled ${e.curve.poles.length} poles` };
    case 'polyline':
    case 'spline':
      return { scaled: { ...e, points: e.points.map((p) => scale2(p, f)) }, dims: `scaled ${e.points.length} points` };
    case 'arc':
    case 'circle': {
      const center = scale2(e.center, f);
      const radius = e.radius * f;
      return { scaled: { ...e, center, radius }, dims: `new center [${center.join(', ')}] radius ${radius}` };
    }
    case 'rectangle':
    case 'image': {
      const width = e.width * f;
      const height = e.height * f;
      return { scaled: { ...e, width, height }, dims: `new size ${width}×${height}` };
    }
    case 'ellipse': {
      const center = scale2(e.center, f);
      const radiusX = e.radiusX * f;
      const radiusY = e.radiusY * f;
      return {
        scaled: { ...e, center, radiusX, radiusY },
        dims: `new center [${center.join(', ')}] radiusX ${radiusX} radiusY ${radiusY}`,
      };
    }
    case 'text': {
      const height = e.height * f;
      const letterSpacing = e.letterSpacing === undefined ? {} : { letterSpacing: e.letterSpacing * f };
      return { scaled: { ...e, height, ...letterSpacing }, dims: `new height ${height}` };
    }
    case 'point':
      return { scaled: { ...e }, dims: 'point unchanged' };
    case 'dimension':
      // References stay attached; only the witness-line offset is scaled.
      return e.offset === undefined
        ? { scaled: { ...e }, dims: 'offset unchanged (no offset set)' }
        : { scaled: { ...e, offset: e.offset * f }, dims: `new offset ${e.offset * f}` };
    case 'mesh': {
      const positions = e.mesh.positions.map((v) => v * f);
      const brep = e.brep && ({ op: 'scale', source: e.brep, factor: f } as const);
      // The stored asset describes the unscaled mesh: a scaled mesh keeps none (scale_entity writes a new asset for it).
      const plain: MeshSolidEntity = { ...e };
      delete plain.asset;
      return {
        scaled: {
          ...plain,
          mesh: { ...e.mesh, positions },
          ...(brep ? { brep } : {}),
          ...(e.faceColors ? { faceColors: e.faceColors.map((face) => ({ ...face, near: scale3(face.near, f) })) } : {}),
        },
        dims: `scaled ${positions.length / 3} vertices`,
      };
    }
    case 'torus': {
      const ringRadius = e.ringRadius * f;
      const tubeRadius = e.tubeRadius * f;
      return { scaled: { ...e, ringRadius, tubeRadius }, dims: `new ringRadius ${ringRadius}, tubeRadius ${tubeRadius}` };
    }
    case 'pyramid': {
      const baseWidth = e.baseWidth * f;
      const baseDepth = e.baseDepth * f;
      const height = e.height * f;
      return {
        scaled: { ...e, baseWidth, baseDepth, height },
        dims: `new baseWidth ${baseWidth}, baseDepth ${baseDepth}, height ${height}`,
      };
    }
    case 'revolution':
      // Radial and axial profile offsets scale; axis direction is unchanged.
      return {
        scaled: { ...e, profile: e.profile.map((p) => scale2(p, f)), ...scaledCurves(e, f) },
        dims: `scaled ${e.profile.length}-point profile`,
      };
    case 'sweep':
      return {
        scaled: {
          ...e,
          path: e.path.map((segment) => mapSegment(segment, (p: Vec3) => scale3(p, f))),
          section: scaledSection(e.section, f),
          ...scaledSweepDesign(e, f),
          ...(e.stations !== undefined
            ? { stations: e.stations.map((station) => ({ at: station.at, ring: station.ring.map((p) => scale2(p, f)) })) }
            : {}),
        },
        dims: `scaled ${e.path.length}-segment path and section`,
      };
    case 'loft':
      return {
        scaled: {
          ...e,
          rings: e.rings.map((ring) => ring.map((p) => scale3(p, f))),
          ...(e.sections === undefined ? {} : { sections: e.sections.map((section) => scaleCurve(section, f)) }),
          ...(e.faces === undefined ? {} : { faces: e.faces.map((face) => scaleSurface(face, f)) }),
        },
        dims: `scaled ${e.rings.length} section rings`,
      };
    case 'subdivision':
      return { scaled: { ...e, vertices: e.vertices.map((p) => scale3(p, f)) }, dims: `scaled ${e.vertices.length}-vertex cage` };
    case 'instance': {
      const scale = scale3(e.scale ?? [1, 1, 1], f);
      return { scaled: { ...e, scale }, dims: `new scale [${scale.join(', ')}]` };
    }
  }
}
