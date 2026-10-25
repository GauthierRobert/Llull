/**
 * Python source for swept solids (02 SWG): the open helper call of a `swept` shape (`sweep_profile(build, <command params>`), and the DATA section
 * holding the fitted faces, keyed by feature, so the MODEL lines stay readable.
 * @invariant the helper takes the build tuple first, then the traced command's params as keywords (Terms: `=expr` bindings survive), then
 *   position / rotation / color / name like every other helper
 */

import type { NurbsSurfaceData } from '../lib/nurbs/surfaceTypes';
import type { Feature, FeatureProgram, LoftSection, ParamTree, PipeSection, ShapeSpec, SweptBuild } from './program';
import { formatNumber, formatTerm, quote, sectionBanner } from './format';

type Swept = Extract<ShapeSpec, { kind: 'swept' }>;
type SweptFeature = Extract<Feature, { op: 'solid' }> & { readonly shape: Swept };

const list = (values: readonly number[]): string => `[${values.map(formatNumber).join(', ')}]`;
const point = (p: readonly number[]): string => `(${p.map(formatNumber).join(', ')})`;
const points = (ps: ReadonlyArray<readonly number[]>): string => `[${ps.map(point).join(', ')}]`;
const flag = (value: boolean): string => (value ? 'True' : 'False');

/** One B-spline face as `(degree_u, degree_v, poles[u][v], weights | None, knots_u, mults_u, knots_v, mults_v)`, a pole row per line. */
function faceTuple(face: NurbsSurfaceData): string {
  const weights = face.weights === undefined ? 'None' : `[${face.weights.map(list).join(', ')}]`;
  const rows = face.poles.map(points).join(',\n    ');
  return (
    `(${face.degreeU}, ${face.degreeV}, [\n    ${rows},\n  ], ${weights}, ${list(face.knotsU)}, ${list(face.multiplicitiesU)}, ` +
    `${list(face.knotsV)}, ${list(face.multiplicitiesV)})`
  );
}

/** One loft section as `("chain", [segment…])` or `("bspline", degree, poles, weights | None, knots, mults, closing)`. */
function sectionTuple(section: LoftSection): string {
  if (section.kind === 'chain') return `("chain", [${section.segments.map(points).join(', ')}])`;
  const { curve } = section;
  const weights = curve.weights === undefined ? 'None' : list(curve.weights);
  return (
    `("bspline", ${curve.degree}, ${points(curve.poles)}, ${weights}, ${list(curve.knots)}, ${list(curve.multiplicities)}, ` +
    `${flag(section.closing)})`
  );
}

const pipeSection = (section: PipeSection): string =>
  section.kind === 'circle'
    ? `("circle", ${point(section.center)}, ${point(section.normal)}, ${formatNumber(section.radius)})`
    : `("polygon", ${points(section.points)})`;

const optionalNumber = (value: number | undefined): string => (value === undefined ? 'None' : formatNumber(value));

/** The feature that owns each fitted-faces build, in program order, with its DATA key (the variable; `variable#n` when it is reused). */
export function sweptFaceKeys(program: FeatureProgram): Map<Feature, string> {
  const keys = new Map<Feature, string>();
  const seen = new Map<string, number>();
  for (const feature of program.features) {
    if (feature.op !== 'solid' || feature.shape.kind !== 'swept' || feature.shape.build.kind !== 'faces') continue;
    const count = (seen.get(feature.variable) ?? 0) + 1;
    seen.set(feature.variable, count);
    keys.set(feature, count === 1 ? feature.variable : `${feature.variable}#${count}`);
  }
  return keys;
}

function buildTuple(shape: Swept, build: SweptBuild, key: string): string {
  const subject = quote(shape.subject);
  switch (build.kind) {
    case 'faces':
      return `("faces", ${subject}, ${quote(key)}, ${flag(build.cap)}, ${formatNumber(build.tolerance)})`;
    case 'pipe':
      return (
        `("pipe", ${subject}, [${build.spine.map(points).join(', ')}], ${pipeSection(build.section)}, ${flag(build.mitre)}, ` +
        `${optionalNumber(build.bore)}, ${optionalNumber(build.limit)})`
      );
    case 'helix':
      return (
        `("helix", ${subject}, ${point(build.origin)}, ${point(build.axis)}, ${point(build.xAxis)}, ${formatNumber(build.radius)}, ` +
        `${formatNumber(build.pitch)}, ${formatNumber(build.turns)}, ${flag(build.left)}, ${formatNumber(build.startAngle)}, ` +
        `${pipeSection(build.section)}, ${optionalNumber(build.bore)})`
      );
    case 'loft':
      return `("loft", ${subject}, [\n  ${build.sections.map(sectionTuple).join(',\n  ')},\n], ${flag(build.ruled)})`;
  }
}

function tree(value: ParamTree): string {
  switch (value.kind) {
    case 'term':
      return formatTerm(value.term);
    case 'text':
      return quote(value.value);
    case 'flag':
      return value.value === null ? 'None' : flag(value.value);
    case 'list':
      return `[${value.items.map(tree).join(', ')}]`;
    case 'map':
      return `{${value.entries.map(([name, item]) => `${quote(name)}: ${tree(item)}`).join(', ')}}`;
  }
}

/** The keywords the script really reads: a pipe circle's `radius` and its bore's `innerRadius` (the helper overrides the exported numbers with them). */
function liveKeys(shape: Swept): readonly string[] {
  const { build } = shape;
  if (build.kind !== 'pipe' || build.section.kind !== 'circle') return [];
  // the bends of a points path default to 3 x the radius: the spine is then built from the exported radius, so the radius cannot be live
  const bends = !build.mitre && build.spine.some((segment) => segment.length === 3);
  const explicitBends = shape.trace?.params.some(([name]) => name === 'bendRadius') === true;
  const radius = bends && !explicitBends ? [] : ['radius'];
  return build.bore === undefined ? radius : [...radius, 'innerRadius'];
}

/** The numbers and text of a param tree in order (what the helper compares against the passed keyword to detect an edit that only import_code applies). */
function flatten(value: ParamTree): string[] {
  switch (value.kind) {
    case 'term':
      return [formatNumber(value.term.value)];
    case 'text':
      return [quote(value.value)];
    case 'flag':
      return [value.value === null ? 'None' : flag(value.value)];
    case 'list':
      return value.items.flatMap(flatten);
    case 'map':
      return value.entries.flatMap(([, item]) => flatten(item));
  }
}

/** `{"path": [0, 0, 0, ...], "radius": None}`: the export-time values of every keyword, None for the live ones (they must stay present). */
function exportedValues(shape: Swept): string {
  const live = liveKeys(shape);
  const entries = shape.trace?.params ?? [];
  return `{${entries.map(([name, value]) => `${quote(name)}: ${live.includes(name) ? 'None' : `[${flatten(value).join(', ')}]`}`).join(', ')}}`;
}

/** The open helper call of a swept shape: `sweep_profile(build, exported, path=…` / `loft_sections(build, exported, …` / `swept(build`; the caller appends placement, colour and `)`. */
export function sweptCallOpen(shape: Swept, key: string): string {
  if (shape.trace === undefined) return `swept(${buildTuple(shape, shape.build, key)}`;
  const params = shape.trace.params.map(([paramName, value]) => `, ${paramName}=${tree(value)}`).join('');
  return `${shape.trace.command}(${buildTuple(shape, shape.build, key)}, ${exportedValues(shape)}${params}`;
}

/** The comment above a swept call: which keywords the script reads and that the others only take effect through import_code (SWG_CODEGEN_STALE warns). */
export function sweptComment(shape: Swept): string {
  if (shape.trace === undefined)
    return `${shape.subject}: built from the exported construction; it references other entities, so import_code brings it back as a mesh.`;
  const live = liveKeys(shape);
  const reads = live.length === 0 ? 'no keyword is read here' : `${live.join(' / ')} (live) ${live.length === 1 ? 'is' : 'are'} read here`;
  return `${shape.subject}: ${reads}; every other keyword is only recorded for import_code, the solid is the exported one (SWG_CODEGEN_STALE warns when one was edited, added or removed).`;
}

/** The DATA section: `_SWG_FACES = {key: (faces, bore)}`; empty when no solid is built from fitted faces. */
export function sweptDataLines(program: FeatureProgram, keys: ReadonlyMap<Feature, string>): string[] {
  const entries: string[] = [];
  for (const feature of program.features) {
    const key = keys.get(feature);
    if (key === undefined) continue;
    const { build } = (feature as SweptFeature).shape;
    if (build.kind !== 'faces') continue;
    const bore = build.bore === undefined ? 'None' : `[\n  ${build.bore.map(faceTuple).join(',\n  ')},\n]`;
    entries.push(`${quote(key)}: (\n[\n  ${build.faces.map(faceTuple).join(',\n  ')},\n], ${bore}),`);
  }
  if (entries.length === 0) return [];
  return [
    sectionBanner('SWEEP / LOFT FACES (data: fitted geometry of the sweeps and lofts below; regenerated by export_code)'),
    `_SWG_FACES = {\n${entries.join('\n')}\n}`,
    '',
  ];
}
