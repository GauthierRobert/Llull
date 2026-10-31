/**
 * Python call-expression fragments shared by the CadQuery/build123d and FreeCAD emitters, whose runtimes expose the same helper signatures
 * (`box(size, position=…, rotation=…)`, …).
 */

import type { Feature, FeatureProgram, FilletLaw, ShapeSpec, Term, Term2, Term3 } from './program';
import { sweptCallOpen, sweptDataLines, sweptFaceKeys } from './sweptCalls';
import {
  featureLinesWithHeadings,
  formatDegrees,
  formatNumber,
  formatTerm,
  isZero,
  numberRows,
  parameterLines,
  quote,
  sectionBanner,
} from './format';

/** `(a, b, c)` */
export function pythonTuple(terms: readonly Term[]): string {
  return `(${terms.map(formatTerm).join(', ')})`;
}

function points(profile: readonly Term2[]): string {
  return `[${profile.map(pythonTuple).join(', ')}]`;
}

/** Degrees in Python source (expressions stay symbolic over `math.pi`). */
function pythonDegrees(term: Term): string {
  return formatDegrees(term, 'math.pi');
}

/** The OPEN helper call for a shape, e.g. `box((10, 20, 30)` — the caller appends kwargs and `)`. */
export function shapeCallOpen(shape: ShapeSpec, key = ''): string {
  switch (shape.kind) {
    case 'box':
      return `box(${pythonTuple(shape.size)}`;
    case 'cylinder':
      return `cylinder(${formatTerm(shape.radius)}, ${formatTerm(shape.height)}`;
    case 'sphere':
      return `sphere(${formatTerm(shape.radius)}`;
    case 'cone':
      return `cone(${formatTerm(shape.radius)}, ${formatTerm(shape.height)}`;
    case 'torus':
      return `torus(${formatTerm(shape.ringRadius)}, ${formatTerm(shape.tubeRadius)}`;
    case 'wedge':
      return `wedge(${pythonTuple(shape.size)}`;
    case 'pyramid':
      return `pyramid(${formatTerm(shape.baseWidth)}, ${formatTerm(shape.baseDepth)}, ${formatTerm(shape.height)}`;
    case 'extrusion':
      return `extrude(${points(shape.profile)}, ${formatTerm(shape.depth)}`;
    case 'revolution':
      return (
        `revolve(${points(shape.profile)}, axis=${quote(shape.axis)}, ` +
        `angle=${pythonDegrees(shape.angle)}, segments=${formatNumber(Math.trunc(shape.segments))}`
      );
    case 'subdivision':
      return (
        `subdivision([\n    ${shape.vertices.map((p) => `(${p.map(formatNumber).join(', ')})`).join(',\n    ')},\n], ` +
        `[${shape.faces.map((face) => `(${face.join(', ')})`).join(', ')}], ` +
        `creases=[${shape.creases.map(([a, b]) => `(${a}, ${b})`).join(', ')}], ` +
        `levels=${formatNumber(Math.trunc(shape.levels))}`
      );
    case 'swept':
      return sweptCallOpen(shape, key);
    case 'mesh':
      return `mesh([\n    ${numberRows(shape.positions, 9).join(',\n    ')},\n]`;
  }
}

const pairList = (pairs: ReadonlyArray<readonly [number, number]>): string =>
  `[${pairs.map(([a, b]) => `(${formatNumber(a)}, ${formatNumber(b)})`).join(', ')}]`;

/** One radius law as `(size, size_end | None, [(t, size)…], linear | 'monotone', [(t, radius) nodes…] | None)`. */
function lawTuple(law: FilletLaw): string {
  const end = law.sizeEnd === undefined ? 'None' : formatNumber(law.sizeEnd);
  const points = pairList((law.sizes ?? []).map((point): [number, number] => [point.t, point.size]));
  return `(${formatNumber(law.size)}, ${end}, ${points}, ${law.monotone === true ? "'monotone'" : law.linear ? 'True' : 'False'}, ${law.nodes === null ? 'None' : pairList(law.nodes)})`;
}

/** `v = fillet|chamfer(v, [edges], size[, near=[…]])`, `v = fillet_laws(v, [edges], [law, …][, near=[…]])` or `v = shell(v, thickness)`. */
export function modifierLine(feature: Extract<Feature, { op: 'fillet' | 'chamfer' | 'shell' }>): string {
  const v = feature.variable;
  if (feature.op === 'shell') return `${v} = shell(${v}, ${formatTerm(feature.thickness)})`;
  const near =
    feature.near === undefined ? '' : `, near=[${feature.near.map((point) => `(${point.map(formatNumber).join(', ')})`).join(', ')}]`;
  if (feature.laws !== undefined)
    return `${v} = fillet_laws(${v}, [${feature.edges.map(formatNumber).join(', ')}], [${feature.laws.map(lawTuple).join(', ')}]${near})`;
  const edgeList = `[${feature.edges.map(formatNumber).join(', ')}]`;
  if (feature.legs !== undefined) {
    const { end, second, secondEnd, lead } = feature.legs;
    const leadArgument = lead === undefined ? '' : `, lead=[(${lead.map(formatNumber).join(', ')})]`;
    return `${v} = chamfer_legs(${v}, ${edgeList}, ${formatTerm(feature.size)}, ${formatNumber(end)}, ${formatNumber(second)}, ${formatNumber(secondEnd)}${leadArgument}${near})`;
  }
  const size = formatTerm(feature.size);
  return `${v} = ${feature.op}(${v}, ${edgeList}, ${size}${near})`;
}

/** `, position=(…), rotation=(…)` kwargs; omitted when zero. Meshes are already world-space. */
export function placementKwargs(shape: ShapeSpec, position: Term3, rotation: Term3): string {
  if (shape.kind === 'mesh') return '';
  let text = '';
  if (!isZero(position)) text += `, position=${pythonTuple(position)}`;
  if (!isZero(rotation)) text += `, rotation=(${rotation.map(pythonDegrees).join(', ')})`;
  return text;
}

/** The PARAMETERS and MODEL sections of a Python script (`#` comments, step headings). */
export function parametersAndModel(
  program: FeatureProgram,
  assignment: (parameter: FeatureProgram['parameters'][number]) => string,
  featureLine: (feature: Feature, faceKey: string) => string,
): string[] {
  const keys = sweptFaceKeys(program);
  return [
    sectionBanner('PARAMETERS'),
    ...parameterLines(program, '#', assignment),
    '',
    ...sweptDataLines(program, keys),
    sectionBanner('MODEL'),
    ...featureLinesWithHeadings(program, '#', (feature) => featureLine(feature, keys.get(feature) ?? '')),
  ];
}
