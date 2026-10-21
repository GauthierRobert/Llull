/** export_urdf: read-only export of the kinematic model (dynamics bodies + joints, or assembly instances + joints) as URDF + STL meshes. */

import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { currentContext } from '../context';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { exportRefusal, noop, report } from '../noop';
import { bodyMassProperties } from '../../geometry/bodyMassProperties';
import { entityToTriangles } from '../../geometry/entityTriangles';
import type { Triangle } from '../../geometry/triangles';
import { escapeXml } from '../../lib/escapeXml';
import { safeFileName } from '../../lib/safeFileName';
import { toMetres } from '../../model/units';
import { buildAsciiStl } from './exportStl';
import { buildUrdfTree, WORLD, type UrdfBody, type UrdfJoint } from './urdfModel';

const num = (value: number): string => String(Number(value.toPrecision(9)) + 0);
const vec = (v: Vec3): string => v.map(num).join(' ');
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

interface LinkFile {
  readonly name: string;
  readonly content: string;
}

function linkXml(
  doc: CadDocument,
  body: UrdfBody,
  origin: Vec3,
  meshPath: string | null,
  warnings: string[],
  kernel: ReturnType<typeof currentContext>['kernel'],
): string {
  const metres = toMetres(doc, 1);
  const lines = [`  <link name="${escapeXml(body.name)}">`];
  const mass = bodyMassProperties(doc, body.body, kernel);
  if ('error' in mass) warnings.push(`link '${body.name}': no inertial (${mass.error}).`);
  else {
    const [ixx, iyy, izz, ixy, ixz, iyz] = mass.inertia;
    const com = minus(mass.centerOfMass, [origin[0] * metres, origin[1] * metres, origin[2] * metres]);
    lines.push(
      '    <inertial>',
      `      <origin xyz="${vec(com)}" rpy="0 0 0"/>`,
      `      <mass value="${num(mass.mass)}"/>`,
      `      <inertia ixx="${num(ixx)}" ixy="${num(ixy)}" ixz="${num(ixz)}" iyy="${num(iyy)}" iyz="${num(iyz)}" izz="${num(izz)}"/>`,
      '    </inertial>',
    );
  }
  if (meshPath !== null)
    for (const tag of ['visual', 'collision'])
      lines.push(
        `    <${tag}>`,
        '      <origin xyz="0 0 0" rpy="0 0 0"/>',
        `      <geometry><mesh filename="${escapeXml(meshPath)}"/></geometry>`,
        `    </${tag}>`,
      );
  lines.push('  </link>');
  return lines.join('\n');
}

function jointXml(doc: CadDocument, joint: UrdfJoint, parentOrigin: Vec3, travel: number): string {
  const metres = toMetres(doc, 1);
  const delta = minus(joint.anchor, parentOrigin);
  const offset: Vec3 = [delta[0] * metres, delta[1] * metres, delta[2] * metres];
  const lines = [
    `  <joint name="${escapeXml(joint.id)}" type="${joint.type === 'revolute' ? 'continuous' : joint.type}">`,
    `    <parent link="${escapeXml(joint.parent)}"/>`,
    `    <child link="${escapeXml(joint.child)}"/>`,
    `    <origin xyz="${vec(offset)}" rpy="0 0 0"/>`,
  ];
  if (joint.type === 'revolute' || joint.type === 'prismatic') {
    lines.push(`    <axis xyz="${vec(joint.axis)}"/>`);
    if (joint.type === 'prismatic') lines.push(`    <limit lower="${num(-travel)}" upper="${num(travel)}" effort="0" velocity="0"/>`);
    lines.push(`    <dynamics damping="${num(joint.damping)}" friction="${num(joint.friction)}"/>`);
  }
  lines.push('  </joint>');
  return lines.join('\n');
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data = { format:'urdf', source, robot, files[{ name, content }] (the .urdf first, then meshes/<link>.stl), linkCount, jointCount,
 *   notes[] }; lengths in metres, link frames aligned with the world axes and located at their joint anchor
 * @failure no bodies / joints to export, or an unknown source -> no-op, no data
 */
export const exportUrdf = defineCommand({
  name: 'export_urdf',
  annotations: { readOnly: true },
  description:
    'Export the kinematic model as a URDF robot description (ROS, Gazebo, MuJoCo, PyBullet) with one STL mesh per link. ' +
    'source "dynamics" uses the rigid bodies and body joints (add_rigid_body, add_body_joint); "assembly" uses component instances connected ' +
    'by add_joint joints (revolute / prismatic; the child instance moves relative to the parent, axis through the parent origin); "auto" ' +
    '(default) uses dynamics when it has bodies, else the assembly. Each body is a link with visual and collision meshes (meshes/<link>.stl, ' +
    'metres, in the link frame) and an inertial block from mass_properties (mass, centre of mass, inertia about it). Link frames are aligned ' +
    'with the world axes and sit at their joint anchor; joint origins are the anchor offsets. Revolute joints are written "continuous" (the ' +
    'document stores no angle limits), prismatic joints get lower/upper = -/+ prismaticTravel, damping and friction come from dynamics joints. ' +
    'Bodies without a parent are attached to the "world" link (fixed when welded / assembly root, else floating). Spherical joints and ' +
    'loop-closing joints cannot be in a URDF tree and are listed in data.notes. Returns data: { format:"urdf", source, robot, files[] ' +
    '(first the .urdf, then meshes/*.stl; each { name, content }), linkCount, jointCount, notes[] }; the CLI writes them with --save DIR. ' +
    'Does NOT modify the document.',
  params: z.object({
    source: z
      .enum(['auto', 'dynamics', 'assembly'])
      .optional()
      .describe(
        'Where bodies and joints come from: "dynamics", "assembly" (instances + add_joint) or "auto" (default: dynamics if any body).',
      ),
    name: z
      .string()
      .optional()
      .describe('Robot name, also the .urdf file name (default "robot"); reduced to letters, digits, "." "_" "-".'),
    prismaticTravel: z
      .number()
      .positive()
      .optional()
      .describe('Half stroke in metres written as the limit of prismatic joints (lower = -value, upper = +value). Default 1.'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_urdf', 'urdf', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const tree = buildUrdfTree(doc, params.source ?? 'auto');
    if ('error' in tree) return noop(doc, `export_urdf: ${tree.error}.`);
    const kernel = (ctx ?? currentContext()).kernel;
    const metres = toMetres(doc, 1);
    const robot = safeFileName(params.name, 'robot');
    const warnings: string[] = [];
    const originOf = new Map<string, Vec3>(tree.joints.map((j) => [j.child, j.anchor]));
    const meshes: LinkFile[] = [];
    const links = [`  <link name="${WORLD}"/>`];
    const fileNames = new Set<string>();
    for (const body of tree.bodies) {
      const origin = originOf.get(body.name) ?? [0, 0, 0];
      const tris: Triangle[] = body.body.entityIds.flatMap((id) => {
        const entity = doc.entities[id];
        return entity === undefined ? [] : entityToTriangles(entity, doc);
      });
      let meshPath: string | null = null;
      if (tris.length > 0) {
        const base = safeFileName(body.name, 'link');
        let file = base;
        for (let n = 2; fileNames.has(file); n++) file = `${base}_${n}`;
        fileNames.add(file);
        meshPath = `meshes/${file}.stl`;
        const toLocal = (q: Vec3): Vec3 => [(q[0] - origin[0]) * metres, (q[1] - origin[1]) * metres, (q[2] - origin[2]) * metres];
        const local = tris.map(([x, y, z]): Triangle => [toLocal(x), toLocal(y), toLocal(z)]);
        meshes.push({ name: meshPath, content: buildAsciiStl(local, body.name.replace(/[^\w.-]+/g, '_')) });
      } else warnings.push(`link '${body.name}': no triangles to export as a mesh.`);
      links.push(linkXml(doc, body, origin, meshPath, warnings, kernel));
    }
    const travel = params.prismaticTravel ?? 1;
    const joints = tree.joints.map((joint) => jointXml(doc, joint, originOf.get(joint.parent) ?? [0, 0, 0], travel));
    const urdf = [`<?xml version="1.0"?>`, `<robot name="${escapeXml(robot)}">`, ...links, ...joints, '</robot>', ''].join('\n');
    const files = [{ name: `${robot}.urdf`, content: urdf }, ...meshes];
    const notes = [...tree.notes, ...warnings];
    return report(
      doc,
      `export_urdf: ${tree.bodies.length + 1} link(s) (incl. world), ${tree.joints.length} joint(s) from ${tree.source}, ${meshes.length} mesh file(s) ` +
        `→ ${robot}.urdf (metres).` +
        (notes.length > 0 ? ` ${notes.length} note(s): ${notes.join(' ')}` : ''),
      { format: 'urdf', source: tree.source, robot, files, linkCount: tree.bodies.length + 1, jointCount: tree.joints.length, notes },
    );
  },
});
