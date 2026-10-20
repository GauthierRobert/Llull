import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

interface UrdfData {
  format: string;
  source: string;
  robot: string;
  files: Array<{ name: string; content: string }>;
  linkCount: number;
  jointCount: number;
  notes: string[];
}

const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => execute(doc, name, params).document;

/** crank (revolute about z at the origin) -> rod (revolute at x=100) -> slider (prismatic along x at x=250); base welded to the ground. */
function mechanism(): CadDocument {
  let doc = createEmptyDocument();
  doc = run(doc, 'set_units', { units: 'mm' });
  const ids: string[] = [];
  for (const [size, position] of [
    [
      [200, 100, 20],
      [0, 0, -20],
    ],
    [
      [100, 10, 10],
      [50, 0, 0],
    ],
    [
      [150, 10, 10],
      [175, 0, 0],
    ],
    [
      [30, 30, 30],
      [250, 0, 0],
    ],
  ] as const) {
    const made = execute(doc, 'add_box', { size, position });
    doc = made.document;
    ids.push(made.affected[0] as string);
  }
  const bodies = ['base', 'crank', 'rod', 'slider'];
  bodies.forEach((id, index) => {
    doc = run(doc, 'add_rigid_body', {
      entityIds: [ids[index]],
      id,
      fixed: id === 'base' ? true : undefined,
      massKg: id === 'base' ? undefined : 2,
    });
  });
  doc = run(doc, 'add_body_joint', { id: 'j_crank', kind: 'revolute', parent: 'base', child: 'crank', anchor: [0, 0, 0], axis: [0, 0, 1] });
  doc = run(doc, 'add_body_joint', { id: 'j_rod', kind: 'revolute', parent: 'crank', child: 'rod', anchor: [100, 0, 0], axis: [0, 0, 1] });
  doc = run(doc, 'add_body_joint', {
    id: 'j_slide',
    kind: 'prismatic',
    child: 'slider',
    parent: 'rod',
    anchor: [250, 0, 0],
    axis: [1, 0, 0],
  });
  return doc;
}

const exportUrdf = (doc: CadDocument, params: Record<string, unknown> = {}): { data: UrdfData; urdf: string; summary: string } => {
  const result = execute(doc, 'export_urdf', params);
  const data = result.data as UrdfData;
  return { data, urdf: data?.files[0]?.content ?? '', summary: result.summary };
};

const links = (urdf: string): string[] => [...urdf.matchAll(/<link name="([^"]+)"/g)].map((m) => m[1] as string);
const joints = (urdf: string): Array<{ name: string; type: string; parent: string; child: string; xyz: string }> =>
  [
    ...urdf.matchAll(
      /<joint name="([^"]+)" type="([^"]+)">\s*<parent link="([^"]+)"\/>\s*<child link="([^"]+)"\/>\s*<origin xyz="([^"]+)"/g,
    ),
  ].map((m) => ({ name: m[1] as string, type: m[2] as string, parent: m[3] as string, child: m[4] as string, xyz: m[5] as string }));

describe('export_urdf from the dynamics model', () => {
  const doc = mechanism();
  const { data, urdf } = exportUrdf(doc, { name: 'slider crank', prismaticTravel: 0.5 });

  it('writes the .urdf first, then one STL per link', () => {
    expect(data.format).toBe('urdf');
    expect(data.source).toBe('dynamics');
    expect(data.files.map((f) => f.name)).toEqual([
      'slider_crank.urdf',
      'meshes/base.stl',
      'meshes/crank.stl',
      'meshes/rod.stl',
      'meshes/slider.stl',
    ]);
    expect(data.files[1]?.content.startsWith('solid ')).toBe(true);
    expect(urdf).toContain('<robot name="slider_crank">');
  });

  it('links form a tree rooted at world with the joint types, parents and metre offsets', () => {
    expect(links(urdf)).toEqual(['world', 'base', 'crank', 'rod', 'slider']);
    expect(data.linkCount).toBe(5);
    expect(data.jointCount).toBe(4);
    expect(joints(urdf)).toEqual([
      { name: 'base_to_world', type: 'fixed', parent: 'world', child: 'base', xyz: '0 0 0' },
      { name: 'j_crank', type: 'continuous', parent: 'base', child: 'crank', xyz: '0 0 0' },
      { name: 'j_rod', type: 'continuous', parent: 'crank', child: 'rod', xyz: '0.1 0 0' },
      { name: 'j_slide', type: 'prismatic', parent: 'rod', child: 'slider', xyz: '0.15 0 0' },
    ]);
  });

  it('gives joints their axis, prismatic limits and every link an inertial from mass_properties', () => {
    expect(urdf).toContain('<axis xyz="0 0 1"/>');
    expect(urdf).toContain('<axis xyz="1 0 0"/>');
    expect(urdf).toContain('<limit lower="-0.5" upper="0.5" effort="0" velocity="0"/>');
    expect(urdf.match(/<inertial>/g)).toHaveLength(4);
    expect(urdf).toContain('<mass value="2"/>');
    expect(urdf.match(/<mesh filename="meshes\/[a-z]+\.stl"\/>/g)).toHaveLength(8);
  });

  it('expresses the meshes in the link frame, in metres', () => {
    const rod = data.files.find((f) => f.name === 'meshes/rod.stl')?.content ?? '';
    const xs = [...rod.matchAll(/vertex (\S+) /g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(0.15, 6);
  });
});

describe('export_urdf from the assembly', () => {
  function assembly(): CadDocument {
    let doc = createEmptyDocument();
    const ids: string[] = [];
    for (const position of [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ]) {
      const box = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = execute(box.document, 'create_component', { name: `P${ids.length}`, entityIds: [box.affected[0]] }).document;
      const inserted = execute(doc, 'insert_instance', { componentId: Object.keys(doc.components).at(-1), position });
      doc = inserted.document;
      ids.push(inserted.affected[0] as string);
    }
    doc = run(doc, 'add_joint', { kind: 'revolute', a: { instanceId: ids[0] }, b: { instanceId: ids[1] }, axis: 'z' });
    doc = run(doc, 'add_joint', { kind: 'prismatic', a: { instanceId: ids[1] }, b: { instanceId: ids[2] }, axis: 'x' });
    return doc;
  }

  it('maps instances to links and add_joint joints to a tree under a fixed root', () => {
    const { data, urdf } = exportUrdf(assembly());
    expect(data.source).toBe('assembly');
    expect(links(urdf)).toHaveLength(4);
    expect(joints(urdf).map((j) => j.type)).toEqual(['fixed', 'continuous', 'prismatic']);
    expect(joints(urdf)[2]?.xyz).toBe('0.01 0 0');
  });

  it('writes a rigid joint as fixed and lists kinds URDF cannot express in notes', () => {
    let doc = assembly();
    const [first, second, third] = [...new Set(Object.values(doc.joints).flatMap((j) => [j.a.instanceId, j.b.instanceId]))];
    doc = execute(doc, 'delete_joint', { id: Object.keys(doc.joints)[1] }).document;
    doc = run(doc, 'add_joint', { kind: 'rigid', a: { instanceId: second }, b: { instanceId: third }, axis: 'x' });
    doc = run(doc, 'add_joint', { kind: 'ball', a: { instanceId: first }, b: { instanceId: third }, axis: 'z' });
    const { data, urdf } = exportUrdf(doc);
    expect(joints(urdf).map((j) => j.type)).toEqual(['fixed', 'continuous', 'fixed']);
    expect(data.notes.join(' ')).toMatch(/is ball: URDF has no single joint for it/);
  });
});

describe('export_urdf edge cases', () => {
  it('lists spherical and loop-closing joints in notes instead of writing them', () => {
    let doc = mechanism();
    doc = run(doc, 'add_body_joint', { id: 'j_ball', kind: 'spherical', parent: 'base', child: 'slider', anchor: [250, 0, 0] });
    doc = run(doc, 'add_body_joint', {
      id: 'j_loop',
      kind: 'revolute',
      parent: 'base',
      child: 'rod',
      anchor: [100, 0, 0],
      axis: [0, 0, 1],
    });
    const { data, urdf } = exportUrdf(doc);
    expect(data.jointCount).toBe(4);
    expect(urdf).not.toContain('j_ball');
    expect(urdf).not.toContain('j_loop');
    expect(data.notes.join(' ')).toContain("joint 'j_ball' is spherical");
    expect(data.notes.join(' ')).toContain("joint 'j_loop' closes a loop");
  });

  it('is a no-op without bodies or joints', () => {
    const result = execute(createEmptyDocument(), 'export_urdf', {});
    expect(result.data).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('neither dynamics bodies nor assembly joints');
    expect(execute(mechanism(), 'export_urdf', { source: 'assembly' }).summary).toContain('no assembly joints');
  });

  it('is pure', () => {
    const doc = mechanism();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'export_urdf', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
  });
});
