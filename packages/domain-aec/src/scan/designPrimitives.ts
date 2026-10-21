/**
 * Design entities as distance primitives for `llull-compute cloud op deviation | clash` (TECHNICAL_SPEC §5.9, §2 decision 7): pipe runs
 * (building elements), cylinders, boxes and spheres analytically, or tessellated with `segments` facets (the model error is then the
 * sagitta r(1 − cos(π/n)), VC-SCN-42); any other solid through its display triangles. Document frame, metres.
 */

import type { CadDocument, Entity } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { is3D } from '@core/model/types';
import { toM, vecToM } from './model';
import { sub3 } from '@lib/vec3';

export type Primitive =
  | { readonly kind: 'cylinder'; readonly start: Vec3; readonly end: Vec3; readonly radius: number }
  | { readonly kind: 'box'; readonly centre: Vec3; readonly axes: readonly [Vec3, Vec3, Vec3]; readonly half: Vec3 }
  | { readonly kind: 'sphere'; readonly centre: Vec3; readonly radius: number }
  | { readonly kind: 'mesh'; readonly triangles: readonly number[] };

export interface DesignEntity {
  readonly id: string;
  readonly primitives: readonly Primitive[];
  /** A straight pipe: the deviation report refits its axis. */
  readonly pipe?: { readonly start: Vec3; readonly end: Vec3; readonly radius: number };
  /** Tessellation error bound in metres (0 analytic, null when not derived for this geometry). */
  readonly modelErrorBound: number | null;
  /** The extraction an as-built pipe run came from. */
  readonly asBuilt?: { readonly extractionId: string };
}

export type Resolved =
  | { readonly ok: true; readonly entity: DesignEntity }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Unit vectors u, w completing axis `a` (unit). */
function frame(a: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c: Vec3 = [a[1] * helper[2] - a[2] * helper[1], a[2] * helper[0] - a[0] * helper[2], a[0] * helper[1] - a[1] * helper[0]];
  const n = Math.hypot(...c);
  const u: Vec3 = [c[0] / n, c[1] / n, c[2] / n];
  return [u, [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]];
}

/** Triangles of a tube of `segments` facets (vertices on the circle), counter-clockwise from outside, with end caps when `capped`. */
export function tubeTriangles(start: Vec3, end: Vec3, radius: number, segments: number, capped: boolean): number[] {
  const d = sub3(end, start);
  const length = Math.hypot(...d);
  const a: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
  const [u, w] = frame(a);
  const ring = (base: Vec3, k: number): Vec3 => {
    const t = (2 * Math.PI * k) / segments;
    const [c, s] = [Math.cos(t) * radius, Math.sin(t) * radius];
    return [base[0] + c * u[0] + s * w[0], base[1] + c * u[1] + s * w[1], base[2] + c * u[2] + s * w[2]];
  };
  const out: number[] = [];
  for (let k = 0; k < segments; k++) {
    const [p, q, r, s] = [ring(start, k), ring(start, k + 1), ring(end, k + 1), ring(end, k)];
    out.push(...p, ...q, ...r, ...p, ...r, ...s);
    if (capped) out.push(...start, ...q, ...p, ...end, ...s, ...r);
  }
  return out;
}

const sagitta = (radius: number, segments: number): number => radius * (1 - Math.cos(Math.PI / segments));

function pipeElement(doc: CadDocument, id: string, tessellated: boolean, segments: number): Resolved | null {
  const element = doc.building?.elements[id];
  if (element === undefined || element.category !== 'pipe') return null;
  const elevation = doc.building?.levels[element.levelId]?.elevation ?? 0;
  const points = element.points.map((p) => vecToM(doc, [p[0], p[1], (p[2] ?? 0) + elevation]));
  const radius = toM(doc, element.diameter / 2);
  const primitives: Primitive[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [start, end] = [points[i] as Vec3, points[i + 1] as Vec3];
    primitives.push(
      tessellated
        ? { kind: 'mesh', triangles: tubeTriangles(start, end, radius, segments, false) }
        : { kind: 'cylinder', start, end, radius },
    );
  }
  const first = points[0];
  const last = points[points.length - 1];
  return {
    ok: true,
    entity: {
      id,
      primitives,
      ...(points.length === 2 && first !== undefined && last !== undefined ? { pipe: { start: first, end: last, radius } } : {}),
      modelErrorBound: tessellated ? sagitta(radius, segments) : 0,
      ...(element.asBuilt !== undefined ? { asBuilt: { extractionId: element.asBuilt.extractionId } } : {}),
    },
  };
}

function solidEntity(doc: CadDocument, entity: Entity, tessellated: boolean, segments: number): Resolved {
  const world = (local: Vec3): Vec3 => vecToM(doc, entityLocalToWorld(entity, local));
  const direction = (local: Vec3): Vec3 => sub3(entityLocalToWorld(entity, local), entityLocalToWorld(entity, [0, 0, 0]));
  const id = entity.id;
  if (entity.kind === 'cylinder') {
    const [start, end] = [world([0, 0, -entity.height / 2]), world([0, 0, entity.height / 2])];
    const radius = toM(doc, entity.radius);
    return tessellated
      ? {
          ok: true,
          entity: {
            id,
            primitives: [{ kind: 'mesh', triangles: tubeTriangles(start, end, radius, segments, true) }],
            modelErrorBound: sagitta(radius, segments),
          },
        }
      : { ok: true, entity: { id, primitives: [{ kind: 'cylinder', start, end, radius }], modelErrorBound: 0 } };
  }
  if (entity.kind === 'box' && !tessellated) {
    const axes = [direction([1, 0, 0]), direction([0, 1, 0]), direction([0, 0, 1])] as [Vec3, Vec3, Vec3];
    const half: Vec3 = [toM(doc, entity.size[0] / 2), toM(doc, entity.size[1] / 2), toM(doc, entity.size[2] / 2)];
    return { ok: true, entity: { id, primitives: [{ kind: 'box', centre: world([0, 0, 0]), axes, half }], modelErrorBound: 0 } };
  }
  if (entity.kind === 'sphere' && !tessellated)
    return {
      ok: true,
      entity: { id, primitives: [{ kind: 'sphere', centre: world([0, 0, 0]), radius: toM(doc, entity.radius) }], modelErrorBound: 0 },
    };
  const triangles = entityToTriangles(entity, doc).flatMap((t) => t.flatMap((v) => vecToM(doc, v)));
  if (triangles.length === 0)
    return { ok: false, code: 'SCN_ENTITY_UNSUPPORTED', message: `entity '${id}' (${entity.kind}) has no triangles` };
  return { ok: true, entity: { id, primitives: [{ kind: 'mesh', triangles }], modelErrorBound: entity.kind === 'box' ? 0 : null } };
}

/** The design entity `id`: a pipe run (building element) or a 3D entity. */
export function resolveDesign(doc: CadDocument, id: string, tessellated: boolean, segments: number): Resolved {
  const pipe = pipeElement(doc, id, tessellated, segments);
  if (pipe !== null) return pipe;
  const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
  if (entity === undefined) return { ok: false, code: 'SCN_ENTITY_NOT_FOUND', message: `no entity or pipe run '${id}'` };
  if (!is3D(entity)) return { ok: false, code: 'SCN_ENTITY_UNSUPPORTED', message: `'${id}' is a 2D ${entity.kind}` };
  return solidEntity(doc, entity, tessellated, segments);
}
