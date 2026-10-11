/**
 * @layer core/geometry
 * @pure
 * Uniform scaling of an entity's kind-specific geometry about its local origin (scale_entity,
 * instance expansion).
 */

import type { Entity, SweepSection, Vec2, Vec3 } from '../model/types';
import type { CurveSegment } from '../model/curve';
import { mapSegment } from './curveSegments';
import { scale3 } from '../lib/vec3';
import { scale2 } from '../lib/vec2';

/** `{ curves }` scaled by `f` when the entity carries exact curves. */
function scaledCurves(
  e: { curves?: ReadonlyArray<CurveSegment<Vec2>> },
  f: number,
): { curves?: ReadonlyArray<CurveSegment<Vec2>> } {
  return e.curves === undefined
    ? {}
    : { curves: e.curves.map((segment) => mapSegment(segment, (p: Vec2) => scale2(p, f))) };
}

function scaledSection(section: SweepSection, f: number): SweepSection {
  if (section.shape === 'circle') {
    const { radius, innerRadius } = section;
    return {
      shape: 'circle',
      radius: radius * f,
      ...(innerRadius !== undefined ? { innerRadius: innerRadius * f } : {}),
    };
  }
  return {
    shape: 'profile',
    profile: section.profile.map((p) => scale2(p, f)),
    ...scaledCurves(section, f),
  };
}

/** Scaled copy of `e` about its local origin plus the summary fragment describing the result. */
export function scaleGeometry(e: Entity, f: number): { scaled: Entity; dims: string } {
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
      return {
        scaled: { ...e, profile: e.profile.map((p) => scale2(p, f)), depth, ...scaledCurves(e, f) },
        dims: `new depth ${depth}`,
      };
    }
    case 'line': {
      const start = scale2(e.start, f);
      const end = scale2(e.end, f);
      return {
        scaled: { ...e, start, end },
        dims: `new start [${start.join(', ')}] end [${end.join(', ')}]`,
      };
    }
    case 'polyline':
    case 'spline':
      return {
        scaled: { ...e, points: e.points.map((p) => scale2(p, f)) },
        dims: `scaled ${e.points.length} points`,
      };
    case 'arc':
    case 'circle': {
      const center = scale2(e.center, f);
      const radius = e.radius * f;
      return {
        scaled: { ...e, center, radius },
        dims: `new center [${center.join(', ')}] radius ${radius}`,
      };
    }
    case 'rectangle': {
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
      return { scaled: { ...e, height }, dims: `new height ${height}` };
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
      return {
        scaled: { ...e, mesh: { ...e.mesh, positions }, ...(brep ? { brep } : {}) },
        dims: `scaled ${positions.length / 3} vertices`,
      };
    }
    case 'torus': {
      const ringRadius = e.ringRadius * f;
      const tubeRadius = e.tubeRadius * f;
      return {
        scaled: { ...e, ringRadius, tubeRadius },
        dims: `new ringRadius ${ringRadius}, tubeRadius ${tubeRadius}`,
      };
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
        },
        dims: `scaled ${e.path.length}-segment path and section`,
      };
    case 'instance': {
      const scale = scale3(e.scale ?? [1, 1, 1], f);
      return { scaled: { ...e, scale }, dims: `new scale [${scale.join(', ')}]` };
    }
  }
}
