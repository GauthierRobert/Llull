/**
 * Elevations and sections projected from the 3D model: hidden-line SVG drawing sheets
 * (painter's algorithm over front-facing triangles, feature + silhouette edges, cut outlines).
 * @layer core/commands/building
 */

import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import type { BimCategory } from '../../model/building';
import type { CommandDefinition, CommandResult } from '../types';
import { entityToTriangles, type Triangle } from '../export';
import { fileSlug, getBuilding, isFiniteNumber, noChange, toMetres } from './model';
import {
  BINDING_MARGIN,
  MARGIN,
  PAPER_MM,
  SHEET_STYLE,
  TITLE_HEIGHT,
  escapeXml,
  fitScale,
  scaleBar,
  titleBlock,
  type PaperSize,
  type Viewport,
} from './sheet';

export type ElevationDirection = 'north' | 'south' | 'east' | 'west';

export const ELEVATION_DIRECTIONS: ReadonlyArray<ElevationDirection> = [
  'north',
  'south',
  'east',
  'west',
];

/** Viewer side → screen axis u (left→right as seen by the viewer) and depth (grows toward viewer). */
interface Projection {
  /** World axis measured by depth (0 = x, 1 = y). */
  readonly axis: 0 | 1;
  /** depth = sign · p[axis]. */
  readonly sign: 1 | -1;
  readonly u: (point: Vec3) => number;
}

const PROJECTIONS: Readonly<Record<ElevationDirection, Projection>> = {
  north: { axis: 1, sign: 1, u: (p) => -p[0] },
  south: { axis: 1, sign: -1, u: (p) => p[0] },
  east: { axis: 0, sign: 1, u: (p) => p[1] },
  west: { axis: 0, sign: -1, u: (p) => -p[1] },
};

interface DrawItem {
  readonly depth: number;
  readonly polygon: Vec2[];
  readonly shade: number;
  readonly edges: Array<readonly [Vec2, Vec2]>;
}

/** Poché class of a cut region. */
export type CutMaterial = 'steel' | 'concrete' | 'other';

/** Filled cut face of one entity: closed loops (even-odd, so hollow sections stay hollow). */
export interface CutRegion {
  readonly material: CutMaterial;
  readonly loops: Vec2[][];
}

export interface ElevationDrawing {
  readonly items: DrawItem[];
  readonly cutLines: Array<readonly [Vec2, Vec2]>;
  readonly cutRegions: CutRegion[];
  /** [minU, minZ, maxU, maxZ] of the projected geometry. */
  readonly bounds: readonly [number, number, number, number];
  readonly projection: Projection;
}

const FEATURE_COS = Math.cos((25 * Math.PI) / 180);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function unitNormal(triangle: Triangle): Vec3 | null {
  const normal = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]));
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  return length > 1e-12 ? [normal[0] / length, normal[1] / length, normal[2] / length] : null;
}

/** Sutherland–Hodgman clip of a convex polygon to depth(p) <= limit. */
function clipPolygon(points: Vec3[], depth: (p: Vec3) => number, limit: number): Vec3[] {
  const result: Vec3[] = [];
  points.forEach((current, index) => {
    const next = points[(index + 1) % points.length] as Vec3;
    const [dc, dn] = [depth(current) - limit, depth(next) - limit];
    if (dc <= 0) result.push(current);
    if ((dc < 0 && dn > 0) || (dc > 0 && dn < 0)) result.push(lerp(current, next, dc / (dc - dn)));
  });
  return result;
}

function clipSegment(
  a: Vec3,
  b: Vec3,
  depth: (p: Vec3) => number,
  limit: number,
): readonly [Vec3, Vec3] | null {
  const [da, db] = [depth(a) - limit, depth(b) - limit];
  if (da > 0 && db > 0) return null;
  if (da <= 0 && db <= 0) return [a, b];
  const crossing = lerp(a, b, da / (da - db));
  return da <= 0 ? [a, crossing] : [crossing, b];
}

const pointKey = (p: Vec3): string => p.map((value) => Math.round(value * 1000)).join(',');

interface Face {
  readonly triangle: Triangle;
  readonly normal: Vec3;
  readonly front: boolean;
}

/** Feature (crease > 25°), boundary and silhouette edges, each assigned to one front face. */
function faceEdges(faces: ReadonlyArray<Face>): Map<number, Array<readonly [Vec3, Vec3]>> {
  const byEdge = new Map<string, { a: Vec3; b: Vec3; faces: number[] }>();
  faces.forEach((face, index) => {
    for (let corner = 0; corner < 3; corner++) {
      const a = face.triangle[corner] as Vec3;
      const b = face.triangle[(corner + 1) % 3] as Vec3;
      const [ka, kb] = [pointKey(a), pointKey(b)];
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const entry = byEdge.get(key);
      if (entry) entry.faces.push(index);
      else byEdge.set(key, { a, b, faces: [index] });
    }
  });
  const edges = new Map<number, Array<readonly [Vec3, Vec3]>>();
  for (const { a, b, faces: adjacent } of byEdge.values()) {
    const fronts = adjacent.filter((index) => (faces[index] as Face).front);
    const owner = fronts[0];
    if (owner === undefined) continue;
    const [first, second] = [faces[adjacent[0] as number], faces[adjacent[1] as number]];
    const feature =
      adjacent.length !== 2 ||
      fronts.length === 1 ||
      (first !== undefined &&
        second !== undefined &&
        dot(first.normal, second.normal) < FEATURE_COS);
    if (!feature) continue;
    edges.set(owner, [...(edges.get(owner) ?? []), [a, b]]);
  }
  return edges;
}

const CONCRETE_CATEGORIES: ReadonlySet<string> = new Set([
  'wall',
  'slab',
  'column',
  'beam',
  'stair',
  'footing',
]);

function cutMaterial(category: string | null): CutMaterial {
  if (category === 'member') return 'steel';
  return category !== null && CONCRETE_CATEGORIES.has(category) ? 'concrete' : 'other';
}

/** Chains cut segments into loops by shared endpoints (open chains are kept as polygons). */
export function chainLoops(segments: ReadonlyArray<readonly [Vec2, Vec2]>): Vec2[][] {
  const key = (p: Vec2): string => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const byPoint = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    for (const point of [a, b])
      byPoint.set(key(point), [...(byPoint.get(key(point)) ?? []), index]);
  });
  const used = new Set<number>();
  const loops: Vec2[][] = [];
  segments.forEach(([a, b], start) => {
    if (used.has(start)) return;
    used.add(start);
    const loop: Vec2[] = [a, b];
    let current = b;
    for (;;) {
      const next = (byPoint.get(key(current)) ?? []).find((index) => !used.has(index));
      if (next === undefined) break;
      used.add(next);
      const [p, q] = segments[next] as readonly [Vec2, Vec2];
      current = key(p) === key(current) ? q : p;
      if (key(current) === key(a)) break;
      loop.push(current);
    }
    if (loop.length >= 3) loops.push(loop);
  });
  return loops;
}

function categoryOf(tags: ReadonlyArray<string> | undefined): string | null {
  return tags?.includes('bim') === true ? (tags[1] ?? null) : null;
}

/**
 * @pure
 * @returns the projected hidden-line drawing, or null when no 3D geometry remains
 */
export function buildElevationDrawing(
  doc: CadDocument,
  options: {
    direction: ElevationDirection;
    cutAt?: number;
    exclude?: ReadonlyArray<string>;
  },
): ElevationDrawing | null {
  const projection = PROJECTIONS[options.direction];
  const toViewer: Vec3 = projection.axis === 0 ? [projection.sign, 0, 0] : [0, projection.sign, 0];
  const depth = (p: Vec3): number => projection.sign * p[projection.axis];
  const limit = options.cutAt !== undefined ? projection.sign * options.cutAt : Infinity;
  const project = (p: Vec3): Vec2 => [projection.u(p), p[2]];
  const excluded = new Set(options.exclude ?? []);
  const hiddenLayers = new Set(
    Object.values(doc.layers)
      .filter((layer) => !layer.visible)
      .map((layer) => layer.id),
  );
  const items: DrawItem[] = [];
  const cutLines: Array<readonly [Vec2, Vec2]> = [];
  const cutRegions: CutRegion[] = [];
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (point: Vec2): void => {
    bounds[0] = Math.min(bounds[0] as number, point[0]);
    bounds[1] = Math.min(bounds[1] as number, point[1]);
    bounds[2] = Math.max(bounds[2] as number, point[0]);
    bounds[3] = Math.max(bounds[3] as number, point[1]);
  };
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (!entity || hiddenLayers.has(entity.layerId)) continue;
    const category = categoryOf(entity.tags);
    if (category !== null && excluded.has(category)) continue;
    const faces: Face[] = [];
    for (const triangle of entityToTriangles(entity, doc)) {
      const normal = unitNormal(triangle);
      if (normal) faces.push({ triangle, normal, front: dot(normal, toViewer) > 1e-6 });
    }
    const edges = faceEdges(faces);
    const entityCuts: Array<readonly [Vec2, Vec2]> = [];
    faces.forEach((face, index) => {
      if (limit !== Infinity) {
        const crossing: Vec3[] = [];
        for (let corner = 0; corner < 3; corner++) {
          const a = face.triangle[corner] as Vec3;
          const b = face.triangle[(corner + 1) % 3] as Vec3;
          const [da, db] = [depth(a) - limit, depth(b) - limit];
          if ((da < 0 && db > 0) || (da > 0 && db < 0)) crossing.push(lerp(a, b, da / (da - db)));
        }
        const [a, b] = crossing;
        if (a && b && crossing.length === 2) {
          const segment = [project(a), project(b)] as const;
          segment.forEach(grow);
          cutLines.push(segment);
          entityCuts.push(segment);
        }
      }
      if (!face.front) return;
      const clipped = clipPolygon([...face.triangle], depth, limit);
      if (clipped.length < 3) return;
      const polygon = clipped.map(project);
      polygon.forEach(grow);
      const visibleEdges: Array<readonly [Vec2, Vec2]> = [];
      for (const [a, b] of edges.get(index) ?? []) {
        const segment = clipSegment(a, b, depth, limit);
        if (segment) visibleEdges.push([project(segment[0]), project(segment[1])]);
      }
      items.push({
        depth: clipped.reduce((sum, point) => sum + depth(point), 0) / clipped.length,
        polygon,
        shade: Math.round(225 + 30 * dot(face.normal, toViewer)),
        edges: visibleEdges,
      });
    });
    const loops = chainLoops(entityCuts);
    if (loops.length > 0) cutRegions.push({ material: cutMaterial(category), loops });
  }
  if (items.length === 0 && cutLines.length === 0) return null;
  items.sort((a, b) => a.depth - b.depth);
  return {
    items,
    cutLines,
    cutRegions,
    bounds: bounds as unknown as readonly [number, number, number, number],
    projection,
  };
}

export interface ElevationSheet {
  readonly filename: string;
  readonly svg: string;
  readonly paper: PaperSize;
  readonly scale: number;
  readonly faces: number;
}

const n = (value: number): string => String(Math.round(value * 100) / 100);

/** Space kept around the view for grid bubbles (top) and level marks (right), paper mm. */
const ANNOTATION_TOP = 14;
const ANNOTATION_RIGHT = 34;

/**
 * @pure
 * @failure no 3D geometry / invalid scale -> null
 */
export function buildElevationSheet(
  doc: CadDocument,
  options: {
    direction: ElevationDirection;
    cutAt?: number;
    exclude?: ReadonlyArray<string>;
    paper?: PaperSize;
    scale?: number;
    title?: string;
  },
): ElevationSheet | null {
  const drawing = buildElevationDrawing(doc, options);
  const paper = options.paper ?? 'A3';
  const size = PAPER_MM[paper];
  if (!drawing || !size) return null;
  if (options.scale !== undefined && !(Number.isFinite(options.scale) && options.scale > 0))
    return null;
  const [width, height] = size;
  const outer: Viewport = {
    x: BINDING_MARGIN + 4,
    y: MARGIN + 4,
    width: width - BINDING_MARGIN - MARGIN - 8,
    height: height - 2 * MARGIN - TITLE_HEIGHT - 8,
  };
  const viewport: Viewport = {
    x: outer.x,
    y: outer.y + ANNOTATION_TOP,
    width: outer.width - ANNOTATION_RIGHT,
    height: outer.height - ANNOTATION_TOP - 8,
  };
  const millimetresPerUnit = toMetres(doc, 1) * 1000;
  const [minU, minZ, maxU, maxZ] = drawing.bounds;
  const scale =
    options.scale ??
    fitScale((maxU - minU) * millimetresPerUnit, (maxZ - minZ) * millimetresPerUnit, viewport);
  const k = millimetresPerUnit / scale;
  const offsetX = viewport.x + (viewport.width - (maxU - minU) * k) / 2;
  const offsetY = viewport.y + viewport.height - (viewport.height - (maxZ - minZ) * k) / 2;
  const toPaper = ([u, z]: Vec2): Vec2 => [offsetX + (u - minU) * k, offsetY - (z - minZ) * k];
  const points = (polygon: ReadonlyArray<Vec2>): string =>
    polygon
      .map(toPaper)
      .map(([x, y]) => `${n(x)},${n(y)}`)
      .join(' ');
  const line = ([a, b]: readonly [Vec2, Vec2], cls: string): string => {
    const [pa, pb] = [toPaper(a), toPaper(b)];
    return `<line x1="${n(pa[0])}" y1="${n(pa[1])}" x2="${n(pb[0])}" y2="${n(pb[1])}" class="${cls}"/>`;
  };
  const view: string[] = [];
  for (const item of drawing.items) {
    const shade = item.shade.toString(16).padStart(2, '0');
    view.push(
      `<polygon points="${points(item.polygon)}" fill="#${shade}${shade}${shade}" stroke="#${shade}${shade}${shade}" stroke-width="0.02"/>`,
    );
    for (const edge of item.edges) view.push(line(edge, 'edge'));
  }
  for (const region of drawing.cutRegions) {
    const path = region.loops.map((loop) => `M${points(loop).replace(/ /g, 'L')}Z`).join('');
    view.push(`<path d="${path}" fill-rule="evenodd" class="poche-${region.material}"/>`);
  }
  for (const cut of drawing.cutLines) view.push(line(cut, 'section'));

  const building = getBuilding(doc);
  const annotations: string[] = [];
  const [left, right] = [toPaper([minU, 0])[0] - 6, toPaper([maxU, 0])[0] + 6];
  const ground = building.levelOrder
    .map((id) => building.levels[id]?.elevation)
    .filter((value): value is number => value !== undefined);
  const groundZ = ground.length > 0 ? Math.min(...ground) : minZ;
  const groundY = toPaper([0, groundZ])[1];
  const belowGrade = toPaper([0, minZ])[1] - groundY;
  if (options.cutAt === undefined && belowGrade > 0) {
    view.push(
      `<rect x="${n(left - 4)}" y="${n(groundY)}" width="${n(right - left + 8)}" height="${n(belowGrade + 0.5)}" fill="#fff" fill-opacity="0.7"/>`,
    );
  }
  annotations.push(
    `<line x1="${n(left - 4)}" y1="${n(groundY)}" x2="${n(right + 4)}" y2="${n(groundY)}" class="ground"/>`,
  );
  for (const levelId of building.levelOrder) {
    const level = building.levels[levelId];
    if (!level) continue;
    const y = toPaper([0, level.elevation])[1];
    const metres = toMetres(doc, level.elevation);
    annotations.push(
      `<line x1="${n(left)}" y1="${n(y)}" x2="${n(right)}" y2="${n(y)}" class="hidden"/>`,
      `<polygon points="${n(right + 2)},${n(y)} ${n(right)},${n(y - 2.5)} ${n(right + 4)},${n(y - 2.5)}" class="solid"/>`,
      `<text x="${n(right + 6)}" y="${n(y - 0.6)}" font-size="2.5" text-anchor="start">${escapeXml(level.name)} ${metres >= 0 ? '+' : ''}${metres.toFixed(3)}</text>`,
    );
  }
  const screenAxis = 1 - drawing.projection.axis;
  const top = toPaper([0, maxZ])[1] - 4;
  const bottom = toPaper([0, minZ])[1] + 2;
  for (const id of building.elementOrder) {
    const grid = building.elements[id];
    if (grid?.category !== 'grid') continue;
    const direction = [grid.end[0] - grid.start[0], grid.end[1] - grid.start[1]];
    const length = Math.hypot(direction[0] as number, direction[1] as number);
    if (length === 0 || Math.abs((direction[screenAxis] as number) / length) > 0.01) continue;
    const x = toPaper([drawing.projection.u([grid.start[0], grid.start[1], 0]), 0])[0];
    annotations.push(
      `<line x1="${n(x)}" y1="${n(top)}" x2="${n(x)}" y2="${n(bottom)}" class="grid"/>`,
      `<circle cx="${n(x)}" cy="${n(top - 4)}" r="4" class="frame-thin" fill="#fff"/>`,
      `<text x="${n(x)}" y="${n(top - 2.9)}" font-size="3" text-anchor="middle">${escapeXml(grid.mark)}</text>`,
    );
  }

  const title =
    options.title?.trim() ||
    (options.cutAt !== undefined
      ? `Section at ${drawing.projection.axis === 0 ? 'x' : 'y'} = ${options.cutAt}, viewed from ${options.direction}`
      : `${options.direction[0]?.toUpperCase() ?? ''}${options.direction.slice(1)} elevation`);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escapeXml(title)}</title>`,
    SHEET_STYLE,
    `<style>.edge{stroke:#000;stroke-width:0.18;stroke-linecap:round}.section{stroke:#000;stroke-width:0.5;stroke-linecap:round}.ground{stroke:#000;stroke-width:0.7}.grid{stroke:#000;stroke-width:0.13;stroke-dasharray:4 1 1 1}.poche-steel{fill:#1a1a1a}.poche-concrete{fill:url(#hatch-concrete)}.poche-other{fill:#9a9a9a}</style>`,
    `<defs><pattern id="hatch-concrete" width="1.5" height="1.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.5" height="1.5" fill="#d9d9d9"/><line x1="0" y1="0" x2="0" y2="1.5" stroke="#000" stroke-width="0.12"/></pattern></defs>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<rect x="${BINDING_MARGIN}" y="${MARGIN}" width="${width - BINDING_MARGIN - MARGIN}" height="${height - 2 * MARGIN}" class="frame"/>`,
    `<g id="view">${view.join('')}</g>`,
    `<g id="annotations">${annotations.join('')}</g>`,
    scaleBar(BINDING_MARGIN + 8, height - MARGIN - 12, scale),
    `<text x="${BINDING_MARGIN + 8}" y="${n(height - MARGIN - 16)}" font-size="2.6" text-anchor="start">${escapeXml(title)} · 1:${scale} · levels in m</text>`,
    titleBlock(doc, { width, height, title, scale, paper }),
    `</svg>`,
  ].join('\n');
  const project = fileSlug(building.project.name, 'project');
  return {
    filename: `${project}_${fileSlug(title, 'elevation')}_${paper}_1-${scale}.svg`,
    svg: `${svg}\n`,
    paper,
    scale,
    faces: drawing.items.length,
  };
}

interface ExportElevationSheetParams {
  direction?: ElevationDirection;
  cutAt?: number;
  exclude?: BimCategory[];
  paper?: PaperSize;
  scale?: number;
  title?: string;
}

/**
 * @command export_elevation_sheet
 * @pure read-only
 * @affects none; data = { filename, svg, paper, scale, faces }
 * @failure bad direction / paper / scale / cutAt, nothing to draw -> no data
 */
export const exportElevationSheet: CommandDefinition<ExportElevationSheetParams> = {
  name: 'export_elevation_sheet',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Produce a printable elevation or section drawing (SVG in real millimetres, print to PDF at 100%) ' +
    'projected from the 3D model with hidden lines removed: north / south / east / west elevation (+Y is ' +
    'north), or a section when cutAt is given (the model nearer to the viewer than the cut plane is removed ' +
    'and cut outlines are drawn heavy). Shows level datums, grid bubbles, scale bar and the title block. ' +
    'Use exclude: ["panel"] to show the steel frame behind the cladding. data.svg holds the file text.',
  paramsSchema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: [...ELEVATION_DIRECTIONS],
        description:
          'Side the viewer stands on (north elevation = north façade seen from the north). Default south.',
      },
      cutAt: {
        type: 'number',
        description:
          'Section plane position on the viewing axis (y for north / south, x for east / west).',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Building categories to leave out, e.g. ["panel", "slab"].',
      },
      paper: {
        type: 'string',
        enum: Object.keys(PAPER_MM),
        description: 'Paper size (landscape). Default A3.',
      },
      scale: {
        type: 'number',
        description: 'Scale denominator N for 1:N. Default: smallest standard scale that fits.',
      },
      title: { type: 'string', description: 'Drawing title. Default "<Direction> elevation".' },
    },
    required: [],
  },
  run: (doc, { direction = 'south', cutAt, exclude, paper, scale, title }): CommandResult => {
    if (!ELEVATION_DIRECTIONS.includes(direction)) {
      return noChange(
        doc,
        `export_elevation_sheet failed: direction must be one of ${ELEVATION_DIRECTIONS.join(', ')}.`,
      );
    }
    if (paper !== undefined && !(paper in PAPER_MM)) {
      return noChange(
        doc,
        `export_elevation_sheet failed: paper must be one of ${Object.keys(PAPER_MM).join(', ')}.`,
      );
    }
    if (cutAt !== undefined && !isFiniteNumber(cutAt)) {
      return noChange(doc, 'export_elevation_sheet failed: cutAt must be a finite number.');
    }
    if (exclude !== undefined && !Array.isArray(exclude)) {
      return noChange(doc, 'export_elevation_sheet failed: exclude must be an array.');
    }
    const sheet = buildElevationSheet(doc, {
      direction,
      ...(cutAt !== undefined ? { cutAt } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      ...(paper !== undefined ? { paper } : {}),
      ...(scale !== undefined ? { scale } : {}),
      ...(title !== undefined ? { title } : {}),
    });
    if (!sheet) {
      return noChange(
        doc,
        'export_elevation_sheet failed: no 3D geometry to draw (on that side of the cut) or invalid scale.',
      );
    }
    return {
      document: doc,
      summary: `Elevation sheet ${sheet.filename}: ${sheet.faces} visible face(s) at 1:${sheet.scale} on ${sheet.paper}.`,
      affected: [],
      data: sheet,
    };
  },
};
