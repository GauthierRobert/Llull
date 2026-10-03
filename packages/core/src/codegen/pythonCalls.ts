/**
 * Python call-expression fragments shared by the CadQuery/build123d and FreeCAD emitters, whose
 * runtimes expose the same helper signatures (`box(size, position=…, rotation=…)`, …).
 *
 * @layer core/codegen
 * @pure
 */

import type { ShapeSpec, Term, Term2, Term3 } from './program';
import { formatDegrees, formatNumber, formatTerm, isZero, numberRows, quote } from './format';

/** `(a, b, c)` */
export function pythonTuple(terms: readonly Term[]): string {
  return `(${terms.map(formatTerm).join(', ')})`;
}

function points(profile: readonly Term2[]): string {
  return `[${profile.map((p) => pythonTuple(p)).join(', ')}]`;
}

/** Degrees in Python source (expressions stay symbolic over `math.pi`). */
function pythonDegrees(term: Term): string {
  return formatDegrees(term, 'math.pi');
}

/** The OPEN helper call for a shape, e.g. `box((10, 20, 30)` — the caller appends kwargs and `)`. */
export function shapeCallOpen(shape: ShapeSpec): string {
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
    case 'mesh':
      return `mesh([\n    ${numberRows(shape.positions, 9).join(',\n    ')},\n]`;
  }
}

/** `, position=(…), rotation=(…)` kwargs; omitted when zero. Meshes are already world-space. */
export function placementKwargs(shape: ShapeSpec, position: Term3, rotation: Term3): string {
  if (shape.kind === 'mesh') return '';
  let text = '';
  if (!isZero(position)) text += `, position=${pythonTuple(position)}`;
  if (!isZero(rotation)) text += `, rotation=(${rotation.map(pythonDegrees).join(', ')})`;
  return text;
}
