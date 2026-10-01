/**
 * FreeCAD macro emitter: FeatureProgram → a .FCMacro (Python, Part workbench) that rebuilds the model
 * in a new FreeCAD document with named, coloured Part::Feature objects.
 *
 * @layer core/codegen
 * @pure
 */

import type { Feature, FeatureProgram, ShapeSpec, Term, Term2, Term3 } from './featureProgram';
import {
  formatDegrees,
  formatNumber,
  formatTerm,
  isZero,
  numberRows,
  provenance,
  quote,
  stepHeading,
} from './format';

const HELPERS = String.raw`
import math

import FreeCAD as App
import Part


def _vec(x, y, z):
    return App.Vector(float(x), float(y), float(z))


def _polygon_face(points):
    return Part.Face(Part.makePolygon([_vec(*p) for p in points] + [_vec(*points[0])]))


def _polyhedron(points, faces):
    shell = Part.makeShell([_polygon_face([points[i] for i in face]) for face in faces])
    solid = Part.makeSolid(shell)
    if solid.Volume < 0:
        solid.reverse()
    return solid


def _place(shape, position=(0, 0, 0), rotation=(0, 0, 0)):
    rx, ry, rz = rotation
    origin = App.Vector(0, 0, 0)
    shape.rotate(origin, App.Vector(0, 0, 1), rz)
    shape.rotate(origin, App.Vector(0, 1, 0), ry)
    shape.rotate(origin, App.Vector(1, 0, 0), rx)
    shape.translate(_vec(*position))
    return shape


def box(size, **placement):
    w, h, d = size
    return _place(Part.makeBox(w, h, d, _vec(-w / 2, -h / 2, -d / 2)), **placement)


def cylinder(radius, height, **placement):
    return _place(Part.makeCylinder(radius, height, _vec(0, 0, -height / 2)), **placement)


def sphere(radius, **placement):
    return _place(Part.makeSphere(radius), **placement)


def cone(radius, height, **placement):
    return _place(Part.makeCone(radius, 0, height), **placement)


def torus(ring_radius, tube_radius, **placement):
    return _place(Part.makeTorus(ring_radius, tube_radius), **placement)


def wedge(size, **placement):
    w, h, d = size
    return _place(_polygon_face([(0, 0, 0), (0, h, 0), (0, 0, d)]).extrude(_vec(w, 0, 0)), **placement)


def pyramid(base_width, base_depth, height, **placement):
    w, d = base_width / 2, base_depth / 2
    points = [(-w, -d, 0), (w, -d, 0), (w, d, 0), (-w, d, 0), (0, 0, height)]
    faces = [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    return _place(_polyhedron(points, faces), **placement)


def extrude(profile, depth, **placement):
    face = _polygon_face([(x, y, 0) for x, y in profile])
    return _place(face.extrude(_vec(0, 0, depth)), **placement)


def revolve(profile, axis="z", angle=360, **placement):
    if axis == "x":
        points, direction = [(a, r, 0) for r, a in profile], (1, 0, 0)
    elif axis == "y":
        points, direction = [(r, a, 0) for r, a in profile], (0, -1, 0)
    else:
        points, direction = [(r, 0, a) for r, a in profile], (0, 0, 1)
    solid = _polygon_face(points).revolve(_vec(0, 0, 0), _vec(*direction), angle)
    return _place(solid, **placement)


def mesh(positions):
    points = [tuple(positions[i:i + 3]) for i in range(0, len(positions), 3)]
    return _polyhedron(points, [(i, i + 1, i + 2) for i in range(0, len(points), 3)])


def _color(hex_color):
    value = hex_color.lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def show(shape, name, color):
    feature = doc.addObject("Part::Feature", name)
    feature.Label = name
    feature.Shape = shape
    if App.GuiUp:
        feature.ViewObject.ShapeColor = _color(color)
    return feature
`;

function tuple(terms: readonly Term[]): string {
  return `(${terms.map(formatTerm).join(', ')})`;
}

function points(profile: readonly Term2[]): string {
  return `[${profile.map((p) => tuple(p)).join(', ')}]`;
}

function shapeCall(shape: ShapeSpec): string {
  switch (shape.kind) {
    case 'box':
      return `box(${tuple(shape.size)}`;
    case 'cylinder':
      return `cylinder(${formatTerm(shape.radius)}, ${formatTerm(shape.height)}`;
    case 'sphere':
      return `sphere(${formatTerm(shape.radius)}`;
    case 'cone':
      return `cone(${formatTerm(shape.radius)}, ${formatTerm(shape.height)}`;
    case 'torus':
      return `torus(${formatTerm(shape.ringRadius)}, ${formatTerm(shape.tubeRadius)}`;
    case 'wedge':
      return `wedge(${tuple(shape.size)}`;
    case 'pyramid':
      return `pyramid(${formatTerm(shape.baseWidth)}, ${formatTerm(shape.baseDepth)}, ${formatTerm(shape.height)}`;
    case 'extrusion':
      return `extrude(${points(shape.profile)}, ${formatTerm(shape.depth)}`;
    case 'revolution':
      return `revolve(${points(shape.profile)}, axis=${quote(shape.axis)}, angle=${formatDegrees(shape.angle, 'math.pi')}`;
    case 'mesh':
      return `mesh([\n    ${numberRows(shape.positions, 9).join(',\n    ')},\n]`;
  }
}

function placement(position: Term3, rotation: Term3): string {
  let text = '';
  if (!isZero(position)) text += `, position=${tuple(position)}`;
  if (!isZero(rotation)) {
    text += `, rotation=(${rotation.map((r) => formatDegrees(r, 'math.pi')).join(', ')})`;
  }
  return text;
}

const OPERATIONS: Readonly<Record<'union' | 'cut' | 'intersect', string>> = {
  union: 'fuse',
  cut: 'cut',
  intersect: 'common',
};

function featureLine(feature: Feature): string {
  const v = feature.variable;
  switch (feature.op) {
    case 'solid': {
      const place =
        feature.shape.kind === 'mesh' ? '' : placement(feature.position, feature.rotation);
      return `${v} = ${shapeCall(feature.shape)}${place})`;
    }
    case 'boolean':
      return `${v} = ${feature.left}.${OPERATIONS[feature.kind]}(${feature.right}).removeSplitter()`;
    case 'translate':
      return `${v} = ${v}.translated(${'_vec' + tuple(feature.delta)})`;
    case 'remove':
      return `${v} = None`;
    case 'label':
      return `# ${v} labelled ${quote(feature.name)}`;
  }
}

/** Emit a FreeCAD macro (.FCMacro). */
export function emitFreeCad(program: FeatureProgram): string {
  const lines: string[] = [
    '# llull model — generated by llull export_code (FreeCAD macro, Part workbench).',
    ...provenance(program).map((line) => `# ${line}`),
    '# Rotations are XYZ Euler angles in degrees (applied about Z, then Y, then X).',
    '# Run from Macro ▸ Macros… or `freecadcmd <file>`; edit PARAMETERS to regenerate.',
    HELPERS,
    '',
    `doc = App.newDocument("llull")`,
    '',
    `# ── PARAMETERS ${'─'.repeat(50)}`,
  ];
  if (program.parameters.length === 0) lines.push('# (none)');
  for (const p of program.parameters) {
    lines.push(`${p.identifier} = ${p.expression ?? formatNumber(p.value)}  # ${p.name}`);
  }
  lines.push('', `# ── MODEL ${'─'.repeat(55)}`);
  program.features.forEach((feature, i) => {
    const heading = stepHeading(feature, program.features[i - 1]);
    if (heading !== null) lines.push(`# ${heading}`);
    lines.push(featureLine(feature));
  });
  lines.push('', `# ── RESULT ${'─'.repeat(54)}`);
  program.outputs.forEach((output, i) => {
    const name = output.name ?? `solid_${i + 1}`;
    lines.push(`show(${output.variable}, ${quote(name)}, ${quote(output.color)})`);
  });
  lines.push(
    'doc.recompute()',
    'if App.GuiUp:',
    '    import FreeCADGui',
    '    FreeCADGui.SendMsgToActiveView("ViewFit")',
    '',
  );
  return lines.join('\n');
}
